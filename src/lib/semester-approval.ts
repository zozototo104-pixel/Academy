import { db } from '@/lib/db'
import { audit } from '@/lib/notify'
import { calculateSemesterAverages } from '@/lib/semester-grade'
import { closeSemesterState, ensureSemesterStates } from '@/lib/semester-lifecycle'
import { enqueueOutbox } from '@/lib/outbox'
import {
  SEMESTER_DECISION_ACTIVE,
  evaluateClosureRight,
  getSemesterDecision,
  loadSemesterPeriod,
  lockSemesterDecision,
  markSemesterDecided,
} from '@/lib/semester-decision'

// ===== اعتماد نتيجة الفصل — سجل قرار مستقل وحارس خادمي =====
// Grade REVIEW (the attempts' reviewedById/reviewedAt, written by the
// supervisor/admin grading flows) is a different operation and is never
// reused as a semester approval: the semester RESULT approval is its
// own stored decision (SemesterResultApproval), taken only when every
// grade in the semester is final — no attempt awaiting review and no
// grade appeal pending.
//
// ACTIVATED in Phase 4 (the Phase-2 ordering guard's condition is met:
// the Phase-3 averages engine and the Phase-4 lifecycle both exist).
// The stored score is ALWAYS the server-computed semester average from
// the student's frozen rules — a caller-supplied score is only accepted
// when it equals the computed one. Approval and semester closure are
// one transaction: the decision record, the lifecycle CLOSED stamp and
// the outbox events land together or not at all.

export const SEMESTER_APPROVAL_ACTIVE = true

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
  if (!args.userId?.trim() || !args.programId?.trim() || !Number.isInteger(args.semester) || args.semester < 1) {
    return [{ code: 'INVALID_SEMESTER', count: 1 }]
  }
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
  // Phase 2 item 3: a fully graded grade that nobody has officially
  // approved yet blocks the semester decision just like an ungraded one.
  // Attempts already blocked above for incomplete grading (unscored
  // answers) or a pending appeal are not double-counted here — this code
  // means exactly "grading is final, official approval is missing". An
  // approval counts only while its stored score still equals the
  // attempt's current score; a later grade change invalidates it (see
  // grade-approval.ts). Defensive: an unreadable approvals table counts
  // every graded grade as unapproved (fail closed), never the reverse.
  let approvalRows: Array<{ targetType: string; attemptId: string; score: number }> = []
  try {
    approvalRows = await client.gradeApproval.findMany({
      where: { userId: args.userId, programId: args.programId, semester: args.semester },
      select: { targetType: true, attemptId: true, score: true },
    })
  } catch {
    approvalRows = []
  }
  const approvedScoreByKey = new Map(
    approvalRows.map((r) => [`${r.targetType}:${r.attemptId}`, r.score] as const),
  )
  const countUnapproved = (graded: Array<{ id: string; score: number }>, targetType: string) =>
    graded.filter((a) => approvedScoreByKey.get(`${targetType}:${a.id}`) !== a.score).length
  if (examIds.length) {
    const graded = await client.examAttempt.findMany({
      where: {
        userId: args.userId,
        examId: { in: examIds },
        status: 'GRADED',
        score: { not: null },
        appealStatus: { not: 'PENDING' },
        NOT: { answers: { some: { points: null } } },
      },
      select: { id: true, score: true },
    })
    const unapproved = countUnapproved(graded, 'UNIT_EXAM')
    if (unapproved) blockers.push({ code: 'UNIT_GRADES_UNAPPROVED', count: unapproved })
  }
  if (programExamIds.length) {
    const graded = await client.programExamAttempt.findMany({
      where: {
        userId: args.userId,
        examId: { in: programExamIds },
        status: 'GRADED',
        score: { not: null },
        appealStatus: { not: 'PENDING' },
        NOT: { answers: { some: { points: null } } },
      },
      select: { id: true, score: true },
    })
    const unapproved = countUnapproved(graded, 'PROGRAM_EXAM')
    if (unapproved) blockers.push({ code: 'PROGRAM_EXAM_GRADES_UNAPPROVED', count: unapproved })
  }
  // Phase 4: an undecided reopen appeal is grade-affecting by nature —
  // it can still produce new grades in this semester — so it blocks the
  // closure decision until the administration decides it. An existing
  // but unreadable appeals table fails closed, like grade approvals.
  const appealStore = (client as AnyClient)?.reopenAppeal
  if (appealStore?.count) {
    try {
      const enrollment = await client.enrollment.findUnique({
        where: { userId_programId: { userId: args.userId, programId: args.programId } },
        select: { id: true },
      })
      if (enrollment) {
        const pending = await appealStore.count({
          where: { enrollmentId: enrollment.id, semester: args.semester, status: 'PENDING' },
        })
        if (pending) blockers.push({ code: 'REOPEN_APPEALS_PENDING', count: pending })
      }
    } catch {
      blockers.push({ code: 'REOPEN_APPEALS_PENDING', count: 1 })
    }
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
  | {
      ok: false
      code:
        | 'INVALID_SEMESTER_APPROVAL_INPUT'
        | 'ENROLLMENT_NOT_FOUND'
        | 'SEMESTER_GRADES_INCOMPLETE'
        | 'SEMESTER_APPROVAL_NOT_ACTIVE'
        | 'SEMESTER_APPROVAL_FORBIDDEN'
        | 'SEMESTER_SCORE_NOT_VERIFIED'
        | 'SEMESTER_NOT_RAISED'
      blockers?: SemesterBlocker[]
      decision?: { status: string | null; periodEnded: boolean; reason: string }
    }

/**
 * The single server-side gate for approving a semester result. Refuses,
 * in order: unknown enrollment → any open grade/review in the semester
 * (SEMESTER_GRADES_INCOMPLETE with the exact blockers) → a non-admin
 * actor (SEMESTER_APPROVAL_FORBIDDEN) → the activation valve
 * (SEMESTER_APPROVAL_NOT_ACTIVE) → a missing or mismatched
 * server-computed average (SEMESTER_SCORE_NOT_VERIFIED). On success it
 * stores the decision, closes the semester and enqueues the cycle
 * notifications — atomically, in this one transaction.
 */
export async function approveSemesterResult(input: {
  enrollmentId: string
  semester: number
  actor: { id: string }
  score?: number | null
  note?: string | null
}): Promise<SemesterApprovalDecision> {
  if (!input.enrollmentId?.trim() || !Number.isInteger(input.semester) || input.semester < 1 || !input.actor?.id?.trim()) {
    return { ok: false, code: 'INVALID_SEMESTER_APPROVAL_INPUT' }
  }
  const outcome = (await db.$transaction(async (tx: AnyClient) => {
    const enrollment = await tx.enrollment.findUnique({
      where: { id: input.enrollmentId },
      select: {
        id: true, userId: true, programId: true, createdAt: true, extensionDays: true,
        program: { select: { semestersCount: true, category: true, maxStudyDays: true } },
      },
    })
    if (!enrollment) return { ok: false, code: 'ENROLLMENT_NOT_FOUND' } as const
    if (enrollment.program?.semestersCount != null && input.semester > enrollment.program.semestersCount) {
      return { ok: false, code: 'INVALID_SEMESTER_APPROVAL_INPUT' } as const
    }
    const blockers = await collectSemesterApprovalBlockers(tx, {
      userId: enrollment.userId,
      programId: enrollment.programId,
      semester: input.semester,
    })
    if (blockers.length) return { ok: false, code: 'SEMESTER_GRADES_INCOMPLETE', blockers } as const
    // Recheck the actor from the database inside the decision transaction.
    // The actor id passed by an API caller is not proof of administrator rights.
    const actor = await tx.user.findUnique({ where: { id: input.actor.id }, select: { role: true, name: true } })
    if (actor?.role !== 'ADMIN') return { ok: false, code: 'SEMESTER_APPROVAL_FORBIDDEN' } as const
    if (!SEMESTER_APPROVAL_ACTIVE) return { ok: false, code: 'SEMESTER_APPROVAL_NOT_ACTIVE' } as const
    // STUDENT CLOSURE RIGHT (decision record): while the semester's own
    // period is still open, approval is lawful only on the student's
    // matured raise; the period end grants the right on its own. This
    // guard sits on the server even if a client shows the button
    // enabled in error — an open semester is never closed silently.
    // Inert while SEMESTER_DECISION_ACTIVE is off (stage 1); stage 3
    // activates it together with the contextual-finality fix.
    let decisionCtx: { periodEnded: boolean; periodEndAt: Date | null } | null = null
    if (SEMESTER_DECISION_ACTIVE) {
      // Serialize against the student's own transitions (record /
      // withdraw take the same pair lock): the decision read below
      // and the DECIDED stamp at the end are one atomic segment.
      await lockSemesterDecision(tx, input.enrollmentId, input.semester)
      const period = await loadSemesterPeriod(tx, {
        programId: enrollment.programId,
        enrollmentCreatedAt: enrollment.createdAt,
        extensionDays: enrollment.extensionDays,
        program: enrollment.program || {},
        semester: input.semester,
      })
      const decision = await getSemesterDecision(tx, input.enrollmentId, input.semester)
      const closure = evaluateClosureRight({ decision, periodEnded: period.ended })
      if (!closure.allowed) {
        return {
          ok: false,
          code: 'SEMESTER_NOT_RAISED',
          blockers,
          decision: { status: decision?.status ?? null, periodEnded: period.ended, reason: closure.reason },
        } as const
      }
      decisionCtx = { periodEnded: period.ended, periodEndAt: period.endAt }
    }
    // The official score is computed HERE from the student's frozen
    // rules — never taken from the caller. A caller-supplied score is
    // tolerated only as a freshness echo of the computed value.
    const averages = await calculateSemesterAverages({
      userId: enrollment.userId,
      programId: enrollment.programId,
      client: tx,
    })
    const entry = averages.semesters.find((s) => s.semester === input.semester)
    // The decision's completeness notion is GRADING FINALITY
    // (entry.gradesComplete): every required assessment has a final
    // graded result — failing scores included — and the blockers above
    // have already refused every open procedure. Component PASSING is
    // not a condition: the outcome (entry.passed) is decided by the
    // semester average against the strict threshold alone, so a
    // semester with failed components is approved as PASSED when its
    // average passes and as FAILED when it does not.
    if (!entry || entry.average === null || !entry.gradesComplete) {
      return { ok: false, code: 'SEMESTER_SCORE_NOT_VERIFIED' } as const
    }
    if (input.score != null && Math.abs(Number(input.score) - entry.average) > 0.009) {
      return { ok: false, code: 'SEMESTER_SCORE_NOT_VERIFIED' } as const
    }
    const passed = entry.passed === true
    const approval = await tx.semesterResultApproval.upsert({
      where: { enrollmentId_semester: { enrollmentId: input.enrollmentId, semester: input.semester } },
      create: {
        enrollmentId: input.enrollmentId,
        semester: input.semester,
        status: 'APPROVED',
        score: entry.average,
        decidedById: input.actor.id,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
      },
      update: {
        status: 'APPROVED',
        score: entry.average,
        decidedById: input.actor.id,
        decidedAt: new Date(),
        decisionNote: input.note ?? null,
      },
    })
    // Approval ⟹ closure, atomically: lifecycle stamp + outbox events.
    await ensureSemesterStates(tx, enrollment, enrollment.program || {})
    await closeSemesterState(tx, {
      enrollmentId: input.enrollmentId,
      semester: input.semester,
      score: entry.average,
      passed,
    })
    // إعادة مصادقة بعد استرحام مصحَّح تُتمّ دورة الطلب: النشاط صار
    // جزءًا من النتيجة الرسمية الجديدة، والرسوب الأصلي باقٍ في السجل.
    const mercyStore = (tx as AnyClient)?.mercyRequest
    if (mercyStore?.updateMany) {
      await mercyStore.updateMany({
        where: { enrollmentId: input.enrollmentId, semester: input.semester, status: 'GRADED' },
        data: { status: 'COMPLETED', newAverage: entry.average },
      }).catch(() => {})
    }
    if (SEMESTER_DECISION_ACTIVE && decisionCtx) {
      await markSemesterDecided(tx, {
        enrollmentId: input.enrollmentId,
        semester: input.semester,
        periodEnded: decisionCtx.periodEnded,
        periodEndAt: decisionCtx.periodEndAt,
      })
    }
    await enqueueOutbox(tx, {
      key: `semester-closed:${input.enrollmentId}:${input.semester}:${entry.average}`,
      kind: 'SEMESTER_CLOSED',
      recipientUserId: enrollment.userId,
      title: passed ? `نتيجة الفصل ${input.semester}: ناجح` : `نتيجة الفصل ${input.semester}: راسب`,
      body: `اعتُمدت نتيجة الفصل ${input.semester} بمعدل ${entry.average} وأُغلق الفصل.`,
    })
    if (!passed) {
      await enqueueOutbox(tx, {
        key: `semester-failed:${input.enrollmentId}:${input.semester}:${entry.average}`,
        kind: 'SEMESTER_FAILED',
        recipientRole: 'ADMINS',
        title: 'توثيق رسوب فصل',
        body: `أُغلق فصل طالب بنتيجة راسب (معدل ${entry.average}) — الفصل ${input.semester}. يمكن للطالب طلب استرحام لرفع المعدل.`,
      })
    }
    await audit(
      { id: input.actor.id, name: actor.name || 'مسؤول' },
      'APPROVE_SEMESTER_RESULT',
      'Enrollment',
      input.enrollmentId,
      `semester=${input.semester} score=${entry.average} passed=${passed}`,
    )
    return { ok: true, approval } as const
  })) as SemesterApprovalDecision
  return outcome
}

/**
 * Validity of a stored semester approval against CURRENT computed
 * values: APPROVED while the computed average still equals the stored
 * score; STALE after any grade-affecting change (the stored decision
 * stays on record; progression and graduation read only APPROVED).
 */
export async function semesterApprovalState(
  client: AnyClient,
  enrollment: { id: string; userId: string; programId: string },
  semester: number,
): Promise<'APPROVED' | 'STALE' | 'NONE'> {
  const stored = await storedSemesterApproval(client, enrollment.id, semester)
  if (!stored || stored.score == null) return 'NONE'
  try {
    const averages = await calculateSemesterAverages({
      userId: enrollment.userId,
      programId: enrollment.programId,
      client,
    })
    const entry = averages.semesters.find((s) => s.semester === semester)
    if (!entry || entry.average === null) return 'STALE'
    return Math.abs(entry.average - Number(stored.score)) <= 0.009 ? 'APPROVED' : 'STALE'
  } catch {
    return 'STALE'
  }
}
