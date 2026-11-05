import { db as prisma } from '@/lib/db'
import { audit } from '@/lib/notify'

// Phase 2 of the academic-lifecycle plan: GRADE approvals, stored as their
// own decision records — distinct from grading review (an attempt's
// reviewedById/reviewedAt), which only records that a score was checked or
// adjusted. An approval states: this exact score is officially accepted,
// by this person, at this time.
//
// Validity rule (the invalidation chain, Phase 2 item 6): an approval is
// valid only while the attempt's CURRENT score still equals the score that
// was approved. Any later change to the grade — review outcome, appeal
// decision, official correction — therefore invalidates the approval
// automatically, without any write path having to know about this table.
// The stored record itself is never deleted or rewritten silently; a
// re-approval stores the new score and decider as a fresh decision.

type AnyClient = any  

export type GradeTargetType = 'UNIT_EXAM' | 'PROGRAM_EXAM'

export type GradeApprovalDecision =
  | { ok: true; approval: unknown }
  | {
      ok: false
      code:
        | 'INVALID_GRADE_APPROVAL_INPUT'
        | 'ATTEMPT_NOT_FOUND'
        | 'GRADE_NOT_FINAL'
        | 'GRADE_APPROVAL_FORBIDDEN'
    }

async function resolveAttempt(
  client: AnyClient,
  targetType: GradeTargetType,
  attemptId: string,
): Promise<{
  userId: string
  status: string
  score: number | null
  appealStatus: string | null
  unscoredAnswers: number
  programId: string
  semester: number
} | null> {
  if (targetType === 'UNIT_EXAM') {
    const a = await client.examAttempt.findUnique({
      where: { id: attemptId },
      select: {
        userId: true,
        status: true,
        score: true,
        appealStatus: true,
        answers: { where: { points: null }, select: { id: true } },
        exam: { select: { unit: { select: { programId: true, semester: true } } } },
      },
    })
    if (!a?.exam?.unit) return null
    return {
      userId: a.userId,
      status: a.status,
      score: a.score,
      programId: a.exam.unit.programId,
      semester: a.exam.unit.semester,
    }
  }
  const a = await client.programExamAttempt.findUnique({
    where: { id: attemptId },
    select: {
      userId: true,
      status: true,
      score: true,
      exam: { select: { programId: true, semester: true } },
    },
  })
  if (!a?.exam) return null
  return {
    userId: a.userId,
    status: a.status,
    score: a.score,
    programId: a.exam.programId,
    semester: a.exam.semester,
  }
}

/**
 * The single server-side gate for approving one grade (a unit-exam attempt
 * or a program-exam attempt). Refuses, in order: malformed input → a
 * decider who is not (re-read from the DB) an ADMIN or the student's
 * assigned SUPERVISOR → an unknown attempt → a grade that is not final yet
 * (not GRADED, or GRADED without a real score). ADMIN approval is a
 * standing parallel power over every student, with or without an assigned
 * supervisor; SUPERVISOR approval is scoped to his own students (the same
 * assignment source the supervisor scope helpers use).
 */
export async function approveGrade(input: {
  targetType: GradeTargetType
  attemptId: string
  actor: { id: string; name?: string }
  note?: string
}): Promise<GradeApprovalDecision> {
  if (
    !input?.actor?.id ||
    !input?.attemptId ||
    (input.targetType !== 'UNIT_EXAM' && input.targetType !== 'PROGRAM_EXAM')
  ) {
    return { ok: false, code: 'INVALID_GRADE_APPROVAL_INPUT' }
  }
  return prisma.$transaction(async (tx: AnyClient) => {
    const actor = await tx.user.findUnique({
      where: { id: input.actor.id },
      select: { role: true },
    })
    if (!actor || (actor.role !== 'ADMIN' && actor.role !== 'SUPERVISOR')) {
      return { ok: false, code: 'GRADE_APPROVAL_FORBIDDEN' } as const
    }
    const resolved = await resolveAttempt(tx, input.targetType, input.attemptId)
    if (!resolved) return { ok: false, code: 'ATTEMPT_NOT_FOUND' } as const
    if (actor.role === 'SUPERVISOR') {
      const assigned = await tx.admissionApplication.findFirst({
        where: { supervisorId: input.actor.id, userId: resolved.userId },
        select: { id: true },
      })
      if (!assigned) return { ok: false, code: 'GRADE_APPROVAL_FORBIDDEN' } as const
    }
    if (
      resolved.status !== 'GRADED' ||
      resolved.score == null ||
      !Number.isFinite(resolved.score)
    ) {
      return { ok: false, code: 'GRADE_NOT_FINAL' } as const
    }
    const approval = await tx.gradeApproval.upsert({
      where: {
        targetType_attemptId: { targetType: input.targetType, attemptId: input.attemptId },
      },
      create: {
        targetType: input.targetType,
        attemptId: input.attemptId,
        userId: resolved.userId,
        programId: resolved.programId,
        semester: resolved.semester,
        score: resolved.score,
        approvedById: input.actor.id,
        approvedAt: new Date(),
        note: input.note ?? null,
      },
      update: {
        userId: resolved.userId,
        programId: resolved.programId,
        semester: resolved.semester,
        score: resolved.score,
        approvedById: input.actor.id,
        approvedAt: new Date(),
        note: input.note ?? null,
      },
    })
    await audit(
      { id: input.actor.id, name: input.actor.name ?? '' },
      'GRADE_APPROVED',
      input.targetType,
      input.attemptId,
      `اعتماد درجة الطالب ${resolved.userId} — الدرجة المعتمدة ${resolved.score}`,
    )
    return { ok: true, approval } as const
  })
}

export type GradeApprovalState = 'APPROVED' | 'STALE' | 'NONE'

/**
 * Whether a stored approval currently counts for this attempt: APPROVED
 * only when a record exists AND its score still equals the attempt's
 * current score; STALE when a record exists but the grade moved since
 * (the approval is invalidated, the record stays for audit); NONE when no
 * approval was ever stored. Defensive: a missing table reads as NONE,
 * never as approved.
 */
export async function gradeApprovalState(
  client: AnyClient,
  targetType: GradeTargetType,
  attemptId: string,
  currentScore: number | null,
): Promise<GradeApprovalState> {
  try {
    if (!client?.gradeApproval?.findUnique) return 'NONE'
    const rec = await client.gradeApproval.findUnique({
      where: { targetType_attemptId: { targetType, attemptId } },
    })
    if (!rec) return 'NONE'
    return currentScore != null && rec.score === currentScore ? 'APPROVED' : 'STALE'
  } catch {
    return 'NONE'
  }
}
