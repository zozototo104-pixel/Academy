import { db } from '@/lib/db'

// ===== اعتماد نتيجة الفصل — سجل قرار مستقل وحارس خادمي =====
// Phase 2 of the academic-lifecycle plan. Grade REVIEW (the attempts'
// reviewedById/reviewedAt, written by the supervisor/admin grading flows)
// is a different operation and is never reused as a semester approval:
// the semester RESULT approval is its own stored decision
// (SemesterResultApproval), taken only when every grade in the semester
// is final — no attempt awaiting review and no grade appeal pending.
//
// Ordering guard (the owner's Phase-2 condition): the record and the
// integrity guard are live now, but the approval itself stays INERT
// until the per-semester average engine (Phase 3) and the semester
// lifecycle (Phase 4) exist. SEMESTER_APPROVAL_ACTIVE flips to true in
// Phase 4; until then every decide call is refused server-side with
// SEMESTER_APPROVAL_NOT_ACTIVE, after the integrity check has had its
// say, and no approval feeds any later decision (closure, transition).

export const SEMESTER_APPROVAL_ACTIVE = false

export type SemesterBlocker = { code: string; count: number }

type AnyClient = { [key: string]: any }

async function rowIds(client: AnyClient, model: string, where: Record<string, unknown>): Promise<string[]> {
  const rows = await client[model].findMany({ where, select: { id: true } })
  return (rows as Array<{ id: string }>).map((r) => r.id)
}

/**
 * Every grade-affecting procedure still open in one semester of one
 * student's program: attempts awaiting review confirmation and grade
 * appeals still pending, split by unit exams vs the semester exam.
 * Scoped strictly to (programId, semester) — another semester's open
 * items never block this one.
 */
export async function collectSemesterApprovalBlockers(
  client: AnyClient,
  args: { userId: string; programId: string; semester: number },
): Promise<SemesterBlocker[]> {
  const blockers: SemesterBlocker[] = []
  const unitIds = await rowIds(client, 'unit', { programId: args.programId, semester: args.semester })
  const examIds = unitIds.length ? await rowIds(client, 'exam', { unitId: { in: unitIds } }) : []
  if (examIds.length) {
    const submitted = await client.examAttempt.count({
      where: { userId: args.userId, examId: { in: examIds }, status: 'SUBMITTED' },
    })
    if (submitted) blockers.push({ code: 'UNIT_GRADING_PENDING', count: submitted })
    const missingScore = await client.examAttempt.count({
      where: { userId: args.userId, examId: { in: examIds }, status: 'GRADED', score: null },
    })
    if (missingScore) blockers.push({ code: 'UNIT_GRADED_SCORE_MISSING', count: missingScore })
    const unscoredAnswers = await client.examAttempt.count({
      where: { userId: args.userId, examId: { in: examIds }, status: 'GRADED', answers: { some: { points: null } } },
    })
    if (unscoredAnswers) blockers.push({ code: 'UNIT_ANSWER_POINTS_MISSING', count: unscoredAnswers })
    const review = await client.examAttempt.count({
      where: { userId: args.userId, examId: { in: examIds }, status: 'NEEDS_REVIEW' },
    })
    if (review) blockers.push({ code: 'UNIT_REVIEW_PENDING', count: review })
    const appeals = await client.examAttempt.count({
      where: { userId: args.userId, examId: { in: examIds }, appealStatus: 'PENDING' },
    })
    if (appeals) blockers.push({ code: 'UNIT_APPEAL_PENDING', count: appeals })
  }
  const programExamIds = await rowIds(client, 'programExam', { programId: args.programId, semester: args.semester })
  if (programExamIds.length) {
    const submitted = await client.programExamAttempt.count({
      where: { userId: args.userId, examId: { in: programExamIds }, status: 'SUBMITTED' },
    })
    if (submitted) blockers.push({ code: 'PROGRAM_EXAM_GRADING_PENDING', count: submitted })
    const missingScore = await client.programExamAttempt.count({
      where: { userId: args.userId, examId: { in: programExamIds }, status: 'GRADED', score: null },
    })
    if (missingScore) blockers.push({ code: 'PROGRAM_EXAM_GRADED_SCORE_MISSING', count: missingScore })
    const unscoredAnswers = await client.programExamAttempt.count({
      where: { userId: args.userId, examId: { in: programExamIds }, status: 'GRADED', answers: { some: { points: null } } },
    })
    if (unscoredAnswers) blockers.push({ code: 'PROGRAM_EXAM_ANSWER_POINTS_MISSING', count: unscoredAnswers })
    const review = await client.programExamAttempt.count({
      where: { userId: args.userId, examId: { in: programExamIds }, status: 'NEEDS_REVIEW' },
    })
    if (review) blockers.push({ code: 'PROGRAM_EXAM_REVIEW_PENDING', count: review })
    const appeals = await client.programExamAttempt.count({
      where: { userId: args.userId, examId: { in: programExamIds }, appealStatus: 'PENDING' },
    })
    if (appeals) blockers.push({ code: 'PROGRAM_EXAM_APPEAL_PENDING', count: appeals })
  }
  // Published coursework with a submitted but ungraded answer is not an approved grade.
  // A missing submission is handled by the semester deadline/lifecycle engine,
  // rather than silently treating an unexpired obligation as final zero here.
  const assignmentIds = await rowIds(client, 'programAssignment', {
    programId: args.programId, semester: args.semester, status: 'PUBLISHED',
  })
  if (assignmentIds.length) {
    const pending = await client.assignmentSubmission.count({
      where: {
        userId: args.userId,
        assignmentId: { in: assignmentIds },
        OR: [
          { status: { in: ['SUBMITTED', 'NEEDS_REVISION'] } },
          { status: 'GRADED', score: null },
        ],
      },
    })
    if (pending) blockers.push({ code: 'ASSIGNMENT_GRADING_PENDING', count: pending })
  }
  return blockers
}

/** Defensive read: a missing table (unmigrated environment) means NO approval. */
export async function storedSemesterApproval(client: AnyClient, enrollmentId: string, semester: number) {
  try {
    return await client.semesterResultApproval.findUnique({
      where: { enrollmentId_semester: { enrollmentId, semester } },
    })
  } catch {
    return null
  }
}

export type SemesterApprovalDecision =
  | { ok: true; approval: unknown }
  | { ok: false; code: 'INVALID_SEMESTER_APPROVAL_INPUT' | 'ENROLLMENT_NOT_FOUND' | 'SEMESTER_GRADES_INCOMPLETE' | 'SEMESTER_APPROVAL_NOT_ACTIVE' | 'SEMESTER_APPROVAL_FORBIDDEN' | 'SEMESTER_SCORE_NOT_VERIFIED'; blockers?: SemesterBlocker[] }

/**
 * The single server-side gate for approving a semester result. Refuses,
 * in order: unknown enrollment → any open grade/review in the semester
 * (SEMESTER_GRADES_INCOMPLETE with the exact blockers) → the Phase-2
 * ordering guard (SEMESTER_APPROVAL_NOT_ACTIVE). Only with all three
 * passed does it store the decision and audit it.
 */
export async function approveSemesterResult(input: {
  enrollmentId: string
  semester: number
  actor: { id: string }
  score?: number | null
  note?: string | null
}): Promise<SemesterApprovalDecision> {
  if (!Number.isInteger(input.semester) || input.semester < 1 || input.semester > 2 || !input.actor?.id) {
    return { ok: false, code: 'INVALID_SEMESTER_APPROVAL_INPUT' }
  }
  const outcome = (await db.$transaction(async (tx: AnyClient) => {
    const enrollment = await tx.enrollment.findUnique({
      where: { id: input.enrollmentId },
      select: { id: true, userId: true, programId: true },
    })
    if (!enrollment) return { ok: false, code: 'ENROLLMENT_NOT_FOUND' } as const
    const blockers = await collectSemesterApprovalBlockers(tx, {
      userId: enrollment.userId,
      programId: enrollment.programId,
      semester: input.semester,
    })
    if (blockers.length) return { ok: false, code: 'SEMESTER_GRADES_INCOMPLETE', blockers } as const
    if (!SEMESTER_APPROVAL_ACTIVE) return { ok: false, code: 'SEMESTER_APPROVAL_NOT_ACTIVE' } as const
    // Recheck the actor from the database inside the decision transaction.
    // The actor id passed by an API caller is not proof of administrator rights.
    const actor = await tx.user.findUnique({ where: { id: input.actor.id }, select: { role: true } })
    if (actor?.role !== 'ADMIN') return { ok: false, code: 'SEMESTER_APPROVAL_FORBIDDEN' } as const
    // A client-supplied score is not an official computed semester result.
    // Keep the decision closed until the verified semester grade engine is wired.
    // Never trust a caller-supplied score, even if it is within 0..100.
    // Phase 3 must supply a server-computed and version-verified result
    // before any semester decision can be persisted.
    return { ok: false, code: 'SEMESTER_SCORE_NOT_VERIFIED' } as const
    // The official decision writer will be introduced with the verified
    // semester grade snapshot and its atomic approval history.
  })) as SemesterApprovalDecision
  return outcome
}
