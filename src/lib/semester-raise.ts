import { collectSemesterApprovalBlockers, type SemesterBlocker } from '@/lib/semester-approval'
import { calculateSemesterAverages } from '@/lib/semester-grade'
import { getSemesterStanding } from '@/lib/student-standing'
import {
  lockSemesterDecision,
  recordSemesterIntent,
  summarizeSemesterDecision,
  tryMatureSemesterRaise,
  type ClosureRight,
  type RaiseMaturity,
  type RecordIntentResult,
  type SemesterDecisionRecord,
  type SemesterIntent,
} from '@/lib/semester-decision'

// ===== اشتقاق نضج الرفع على الخادم =====
// Maturity is derived HERE, on the server, from the actual exam and
// grading state — never accepted from a request. A student's early-
// finish raise matures only when ALL of these hold:
//   (a) a PUBLISHED semester exam exists for this semester;
//   (b) the student actually SAT it (a real attempt, any settled or
//       in-review state — never an assumed zero while the window is
//       open);
//   (c) no submitted work in the semester is still open: the approval
//       blocker scan (ungraded attempts, unscored answers, pending
//       reviews/appeals, ungraded assignments, unapproved grades)
//       comes back empty — which also proves the sat exam is graded.
// Unsubmitted units/assignments do not block maturity: the student's
// explicit choice is exactly what accepts their computational zero.
// The score snapshot is the server-computed provisional semester
// average at this moment.
//
// Routes and grading/appeal flows call THIS module's orchestrators;
// the lower-level transitions in semester-decision.ts take the
// derived maturity as an internal seam only.

type AnyClient = any

export type SemesterRaiseMaturity = RaiseMaturity & {
  examTaken: boolean
  examPublished: boolean
  blockers: SemesterBlocker[]
}

type StandingContext = {
  enrollment: { createdAt: Date | string; status: string; extensionDays?: number | null }
  program: { category?: string | null; maxStudyDays?: number | null; semestersCount?: number | null }
}

async function loadMaturityFacts(
  client: AnyClient,
  input: { userId: string; programId: string; semester: number } & StandingContext,
) {
  const [blockers, standing, averages] = await Promise.all([
    collectSemesterApprovalBlockers(client, {
      userId: input.userId,
      programId: input.programId,
      semester: input.semester,
    }).catch(() => [{ code: 'BLOCKER_SCAN_FAILED', count: 1 }] as SemesterBlocker[]),
    getSemesterStanding(client, {
      userId: input.userId,
      programId: input.programId,
      enrollment: input.enrollment,
      program: input.program,
      semester: input.semester,
    }).catch(() => null),
    calculateSemesterAverages({ userId: input.userId, programId: input.programId, client }).catch(() => null),
  ])
  return { blockers, standing, averages }
}

export async function computeSemesterRaiseMaturity(
  client: AnyClient,
  input: { userId: string; programId: string; semester: number } & StandingContext,
): Promise<SemesterRaiseMaturity> {
  const { blockers, standing, averages } = await loadMaturityFacts(client, input)
  const entry = averages?.semesters?.find((s: { semester: number }) => s.semester === input.semester)
  // A submission or EXPIRED attempt counts as "sat" for the student's
  // progress display, but NEVER proves a finalized semester exam.
  // Only an actually GRADED attempt with a usable score and fully
  // scored answers can mature an early-close request.
  const readyExamIds: string[] = (standing?.programExams?.rows ?? [])
    .filter((row: { status: string }) => row.status === 'READY')
    .map((row: { examId: string }) => row.examId)
  const gradedAttempts: Array<{
    score: number | null
    finalScore: number | null
    appealStatus: string | null
    answers: Array<{ points: number | null }>
  }> = readyExamIds.length
    ? await client.programExamAttempt.findMany({
        where: {
          userId: input.userId,
          examId: { in: readyExamIds },
          status: 'GRADED',
        },
        select: {
          score: true,
          finalScore: true,
          appealStatus: true,
          answers: { select: { points: true } },
        },
      }).catch(() => [])
    : []
  const finalExamGraded = gradedAttempts.some((attempt) => {
    const score = attempt.finalScore ?? attempt.score
    return typeof score === 'number'
      && Number.isFinite(score)
      && score >= 0
      && score <= 100
      && attempt.appealStatus !== 'PENDING'
      && Array.isArray(attempt.answers)
      && attempt.answers.length > 0
      && attempt.answers.every((answer) => typeof answer.points === 'number' && Number.isFinite(answer.points))
  })
  const examTaken = (standing?.programExams?.satCount ?? 0) > 0
  const examPublished = readyExamIds.length > 0
  const score = typeof entry?.average === 'number' && Number.isFinite(entry.average)
    && entry.average >= 0 && entry.average <= 100 ? entry.average : null
  return {
    mature: examPublished && finalExamGraded && score !== null && blockers.length === 0,
    score,
    examTaken,
    examPublished,
    blockers,
  }
}

export type SemesterDecisionBrief = {
  decision: SemesterDecisionRecord
  periodEndAt: string | null
  periodEnded: boolean
  closure: ClosureRight
  examTaken: boolean
  examPublished: boolean
  pendingCount: number
  provisionalAverage: number | null
  scoreAtRaise: number | null
  changedSinceRaise: boolean
  units: { graded: number; total: number; missingTitles: string[] }
  assignments: { submitted: number; total: number; missingTitles: string[] }
}

/** The one brief every decision display reads — the student's choice
 * dialog and status panel, and any later admin surface: the stored
 * decision, the period facts, the closure right, the maturity facts,
 * and whether the live result has materially moved since the raise
 * the student consented to (the administration must re-see the file,
 * never silently approve a stale number). */
export async function getSemesterDecisionBrief(
  client: AnyClient,
  input: { enrollmentId: string; userId: string; programId: string; semester: number } & StandingContext,
): Promise<SemesterDecisionBrief> {
  const [summary, facts] = await Promise.all([
    summarizeSemesterDecision(client, {
      enrollmentId: input.enrollmentId,
      programId: input.programId,
      enrollmentCreatedAt: input.enrollment.createdAt,
      extensionDays: input.enrollment.extensionDays,
      program: input.program,
      semester: input.semester,
    }),
    loadMaturityFacts(client, input),
  ])
  const entry = facts.averages?.semesters?.find((s: { semester: number }) => s.semester === input.semester)
  const provisionalAverage = entry?.average ?? null
  const scoreAtRaise = summary.decision?.scoreAtRaise ?? null
  return {
    decision: summary.decision,
    periodEndAt: summary.periodEndAt,
    periodEnded: summary.periodEnded,
    closure: summary.closure,
    examTaken: (facts.standing?.programExams?.satCount ?? 0) > 0,
    examPublished: (facts.standing?.programExams?.ready ?? 0) > 0,
    pendingCount: facts.blockers.reduce((sum, b) => sum + (b.count || 0), 0),
    provisionalAverage,
    scoreAtRaise,
    changedSinceRaise:
      scoreAtRaise != null && provisionalAverage != null && Math.abs(provisionalAverage - scoreAtRaise) > 0.05,
    units: {
      graded: facts.standing?.units?.graded ?? 0,
      total: facts.standing?.units?.total ?? 0,
      missingTitles: facts.standing?.units?.missingTitles ?? [],
    },
    assignments: {
      submitted: facts.standing?.assignments?.submitted ?? 0,
      total: facts.standing?.assignments?.total ?? 0,
      missingTitles: facts.standing?.assignments?.missingTitles ?? [],
    },
  }
}

/** The student-facing entry point for recording a choice: derives
 * maturity on the server, then records the intent through the locked,
 * status-conditioned transition. */
export async function requestSemesterDecision(
  client: AnyClient,
  input: {
    enrollmentId: string
    userId: string
    programId: string
    semester: number
    intent: SemesterIntent
  } & StandingContext,
): Promise<RecordIntentResult & { maturity: SemesterRaiseMaturity }> {
  const maturity = await computeSemesterRaiseMaturity(client, input)
  const result = await recordSemesterIntent(client, {
    enrollmentId: input.enrollmentId,
    userId: input.userId,
    semester: input.semester,
    intent: input.intent,
    scoreSnapshot: maturity.score,
    maturity,
  })
  return { ...result, maturity }
}

/** Grading / review / appeal flows call this after settling work: a
 * stored early-finish intent matures exactly when the server-derived
 * facts now allow it — and never resurrects a withdrawn request,
 * because the transition itself is conditioned on INTENT. */
export async function matureSemesterRaiseIfReady(
  client: AnyClient,
  input: {
    enrollmentId: string
    userId: string
    programId: string
    semester: number
  } & StandingContext,
): Promise<{ decision: SemesterDecisionRecord; maturity: SemesterRaiseMaturity }> {
  const maturity = await computeSemesterRaiseMaturity(client, input)
  const decision = await tryMatureSemesterRaise(client, {
    enrollmentId: input.enrollmentId,
    semester: input.semester,
    maturity,
  })
  return { decision, maturity }
}
