import { audit } from '@/lib/notify'
import { getSemesterWindows } from '@/lib/semester-lifecycle'

// ===== قرار الطالب بشأن إنهاء الفصل — سجل القرار الوحيد وحق الإغلاق =====
// The student's semester-finalization decision lives HERE and nowhere
// else: one stored record per (enrollment, semester) holding the
// explicit choice, the raise, its withdrawal, and the result snapshot
// the student consented to. The frozen readiness engine
// (semester-readiness.ts) is never touched and its «جاهز للامتحان»
// mark (Enrollment.examReadiness) is NEVER read as consent — a legacy
// ready-mark predates this consent and implies nothing.
//
// Closure right (the administration may approve a semester result) is
// granted by exactly two sources: a MATURED student raise (the student
// asked for early finalization AND the conditions matured: semester
// exam taken and graded, submitted work final), or the END of the
// semester's own period (the existing window computation, extensions
// included). An unsubmitted item is computationally zero in the
// average long before either source exists; it becomes FINAL for
// approval only once a closure right exists. Submitted work still
// being graded or appealed blocks approval under every source.
//
// ACTIVATION VALVE: stage 1 ships the record, the evaluator and the
// server guard with the valve OFF, so no user-visible behavior changes
// until the student-facing choice UI exists (stage 2) and the
// contextual-finality fix lands (stage 3 flips this to true).

export const SEMESTER_DECISION_ACTIVE = false

type AnyClient = any

export type SemesterDecisionStatus = 'NONE' | 'INTENT' | 'RAISED' | 'WITHDRAWN' | 'DECIDED'
export type SemesterIntent = 'EARLY_FINISH' | 'CONTINUE'

export type SemesterDecisionRecord = {
  id: string
  enrollmentId: string
  semester: number
  intent: string | null
  status: string
  raiseSource: string | null
  intentAt: Date | null
  raisedAt: Date | null
  withdrawnAt: Date | null
  decidedAt: Date | null
  scoreAtIntent: number | null
  scoreAtRaise: number | null
} | null

export async function getSemesterDecision(
  client: AnyClient,
  enrollmentId: string,
  semester: number,
): Promise<SemesterDecisionRecord> {
  const store = (client as AnyClient)?.semesterDecision
  if (!store?.findUnique) return null
  const row = await store
    .findUnique({ where: { enrollmentId_semester: { enrollmentId, semester } } })
    .catch(() => null)
  return (row as SemesterDecisionRecord) ?? null
}

/** The semester's own period end from the ONE window computation the
 * whole platform uses (program-duration division + approved extension
 * days), via the lifecycle semester windows. null when the program has
 * no computable duration — an unknown end never counts as ended. */
export async function loadSemesterPeriod(
  client: AnyClient,
  input: {
    programId: string
    enrollmentCreatedAt: Date | string
    extensionDays?: number | null
    program: { category?: string | null; maxStudyDays?: number | null; semestersCount?: number | null }
    semester: number
    now?: Date
  },
): Promise<{ endAt: Date | null; ended: boolean }> {
  const units = await client.unit
    .findMany({ where: { programId: input.programId }, select: { id: true, semester: true, order: true } })
    .catch(() => [])
  const windows = getSemesterWindows(
    new Date(input.enrollmentCreatedAt),
    input.program || {},
    units,
    input.extensionDays || 0,
  )
  const win = windows.find((w) => w.semester === input.semester)
  if (!win) return { endAt: null, ended: false }
  const now = input.now ?? new Date()
  return { endAt: win.endAt, ended: now.getTime() > win.endAt.getTime() }
}

export type ClosureRight = {
  allowed: boolean
  source: 'STUDENT' | 'DEADLINE' | null
  reason: 'RAISED' | 'PERIOD_ENDED' | 'INTENT_NOT_MATURE' | 'WITHDRAWN' | 'AWAITING_STUDENT'
}

/** Pure closure-right evaluation — the single rule the approval guard
 * and every display share. A stored RAISED decision grants the right
 * immediately (its maturity was proven when it matured); the period
 * end grants it independently of any record. */
export function evaluateClosureRight(input: {
  decision: { status?: string | null; raiseSource?: string | null } | null
  periodEnded: boolean
}): ClosureRight {
  if (input.decision?.status === 'RAISED') {
    return { allowed: true, source: 'STUDENT', reason: 'RAISED' }
  }
  if (input.periodEnded) {
    return { allowed: true, source: 'DEADLINE', reason: 'PERIOD_ENDED' }
  }
  if (input.decision?.status === 'INTENT') {
    return { allowed: false, source: null, reason: 'INTENT_NOT_MATURE' }
  }
  if (input.decision?.status === 'WITHDRAWN') {
    return { allowed: false, source: null, reason: 'WITHDRAWN' }
  }
  return { allowed: false, source: null, reason: 'AWAITING_STUDENT' }
}

type EnrollmentContext = {
  id: string
  userId: string
  programId: string
  createdAt: Date | string
  extensionDays?: number | null
  program: { category?: string | null; maxStudyDays?: number | null; semestersCount?: number | null } | null
}

async function loadEnrollmentContext(client: AnyClient, enrollmentId: string): Promise<EnrollmentContext | null> {
  const row = await client.enrollment
    .findUnique({
      where: { id: enrollmentId },
      select: {
        id: true,
        userId: true,
        programId: true,
        createdAt: true,
        extensionDays: true,
        program: { select: { category: true, maxStudyDays: true, semestersCount: true } },
      },
    })
    .catch(() => null)
  return (row as EnrollmentContext) ?? null
}

async function semesterAlreadyDecided(client: AnyClient, enrollmentId: string, semester: number): Promise<boolean> {
  const approvalStore = (client as AnyClient)?.semesterResultApproval
  if (approvalStore?.findUnique) {
    const approval = await approvalStore
      .findUnique({ where: { enrollmentId_semester: { enrollmentId, semester } } })
      .catch(() => null)
    if (approval) return true
  }
  const stateStore = (client as AnyClient)?.enrollmentSemesterState
  if (stateStore?.findUnique) {
    const state = await stateStore
      .findUnique({ where: { enrollmentId_semester: { enrollmentId, semester } } })
      .catch(() => null)
    if (state?.status === 'CLOSED') return true
  }
  return false
}

export type RecordIntentResult =
  | { ok: true; decision: SemesterDecisionRecord }
  | { ok: false; code: 'ENROLLMENT_NOT_FOUND' | 'SEMESTER_ALREADY_DECIDED' | 'SEMESTER_PERIOD_ENDED' | 'SEMESTER_ALREADY_RAISED' | 'INVALID_SEMESTER' }

/**
 * Records the student's explicit choice for one semester. The caller
 * (student route) computes maturity from the grading facts: an
 * EARLY_FINISH choice matures to RAISED only when the semester exam
 * has been taken and graded and no submitted work is still open;
 * otherwise the intent is stored and matures later. Repeating the
 * same choice is idempotent. A CONTINUE choice cancels an unmatured
 * early-finish intent; a matured raise is left to the withdraw path.
 */
export async function recordSemesterIntent(
  client: AnyClient,
  input: {
    enrollmentId: string
    userId: string
    semester: number
    intent: SemesterIntent
    scoreSnapshot?: number | null
    mature?: boolean
    matureScore?: number | null
    now?: Date
  },
): Promise<RecordIntentResult> {
  const enrollment = await loadEnrollmentContext(client, input.enrollmentId)
  if (!enrollment || enrollment.userId !== input.userId) return { ok: false, code: 'ENROLLMENT_NOT_FOUND' }
  if (!Number.isInteger(input.semester) || input.semester < 1) return { ok: false, code: 'INVALID_SEMESTER' }
  if (await semesterAlreadyDecided(client, input.enrollmentId, input.semester)) {
    return { ok: false, code: 'SEMESTER_ALREADY_DECIDED' }
  }
  const period = await loadSemesterPeriod(client, {
    programId: enrollment.programId,
    enrollmentCreatedAt: enrollment.createdAt,
    extensionDays: enrollment.extensionDays,
    program: enrollment.program || {},
    semester: input.semester,
    now: input.now,
  })
  if (period.ended) return { ok: false, code: 'SEMESTER_PERIOD_ENDED' }

  const store = (client as AnyClient)?.semesterDecision
  if (!store?.upsert) return { ok: false, code: 'ENROLLMENT_NOT_FOUND' }
  const existing = await getSemesterDecision(client, input.enrollmentId, input.semester)
  const now = input.now ?? new Date()

  if (input.intent === 'CONTINUE') {
    if (existing?.status === 'RAISED') return { ok: false, code: 'SEMESTER_ALREADY_RAISED' }
    if (existing?.intent === 'CONTINUE' && existing?.status !== 'INTENT') {
      return { ok: true, decision: existing }
    }
    const row = await store.upsert({
      where: { enrollmentId_semester: { enrollmentId: input.enrollmentId, semester: input.semester } },
      create: {
        enrollmentId: input.enrollmentId,
        semester: input.semester,
        intent: 'CONTINUE',
        status: 'NONE',
        intentAt: now,
      },
      update: { intent: 'CONTINUE', status: 'NONE', intentAt: now, withdrawnAt: null },
    })
    await audit(
      { id: input.userId, name: 'طالب' },
      'SEMESTER_INTENT_CONTINUE',
      'Enrollment',
      input.enrollmentId,
      `semester ${input.semester}`,
    ).catch(() => {})
    return { ok: true, decision: row as SemesterDecisionRecord }
  }

  // EARLY_FINISH
  if (existing?.status === 'RAISED' && existing?.intent === 'EARLY_FINISH') {
    return { ok: true, decision: existing }
  }
  const matures = input.mature === true
  const row = await store.upsert({
    where: { enrollmentId_semester: { enrollmentId: input.enrollmentId, semester: input.semester } },
    create: {
      enrollmentId: input.enrollmentId,
      semester: input.semester,
      intent: 'EARLY_FINISH',
      status: matures ? 'RAISED' : 'INTENT',
      raiseSource: matures ? 'STUDENT' : null,
      intentAt: now,
      raisedAt: matures ? now : null,
      scoreAtIntent: input.scoreSnapshot ?? null,
      scoreAtRaise: matures ? input.matureScore ?? input.scoreSnapshot ?? null : null,
    },
    update: {
      intent: 'EARLY_FINISH',
      status: matures ? 'RAISED' : 'INTENT',
      raiseSource: matures ? 'STUDENT' : null,
      intentAt: now,
      raisedAt: matures ? now : existing?.raisedAt ?? null,
      withdrawnAt: null,
      scoreAtIntent: input.scoreSnapshot ?? existing?.scoreAtIntent ?? null,
      scoreAtRaise: matures ? input.matureScore ?? input.scoreSnapshot ?? null : existing?.scoreAtRaise ?? null,
    },
  })
  await audit(
    { id: input.userId, name: 'طالب' },
    matures ? 'SEMESTER_RAISED' : 'SEMESTER_INTENT_EARLY_FINISH',
    'Enrollment',
    input.enrollmentId,
    `semester ${input.semester}`,
  ).catch(() => {})
  return { ok: true, decision: row as SemesterDecisionRecord }
}

/**
 * Matures a stored EARLY_FINISH intent into a raise once the grading
 * facts allow it. The caller computes maturity (semester exam taken
 * and graded + no open submitted work); this function owns the state
 * transition and its idempotency, so grading flows, appeals and reads
 * can all safely attempt maturation.
 */
export async function tryMatureSemesterRaise(
  client: AnyClient,
  input: { enrollmentId: string; semester: number; mature: boolean; matureScore?: number | null; now?: Date },
): Promise<SemesterDecisionRecord> {
  const existing = await getSemesterDecision(client, input.enrollmentId, input.semester)
  if (!existing || existing.status !== 'INTENT' || existing.intent !== 'EARLY_FINISH' || !input.mature) {
    return existing
  }
  const store = (client as AnyClient)?.semesterDecision
  if (!store?.update) return existing
  const now = input.now ?? new Date()
  const row = await store
    .update({
      where: { enrollmentId_semester: { enrollmentId: input.enrollmentId, semester: input.semester } },
      data: {
        status: 'RAISED',
        raiseSource: 'STUDENT',
        raisedAt: now,
        scoreAtRaise: input.matureScore ?? existing.scoreAtIntent ?? null,
      },
    })
    .catch(() => null)
  if (row) {
    await audit(
      null,
      'SEMESTER_RAISED',
      'Enrollment',
      input.enrollmentId,
      `semester ${input.semester} (matured)`,
    ).catch(() => {})
  }
  return (row as SemesterDecisionRecord) ?? existing
}

export type WithdrawResult =
  | { ok: true; decision: SemesterDecisionRecord }
  | { ok: false; code: 'ENROLLMENT_NOT_FOUND' | 'SEMESTER_ALREADY_DECIDED' | 'SEMESTER_PERIOD_ENDED' | 'NO_ACTIVE_RAISE' }

/**
 * Withdraws an intent or a matured raise. Allowed only while the
 * administration has not decided AND the semester period is still
 * open — after the period ends, withdrawal cannot resurrect time and
 * the deadline path (or an extension) governs instead. A changed
 * grade after the raise never cancels this right by itself.
 */
export async function withdrawSemesterRaise(
  client: AnyClient,
  input: { enrollmentId: string; userId: string; semester: number; now?: Date },
): Promise<WithdrawResult> {
  const enrollment = await loadEnrollmentContext(client, input.enrollmentId)
  if (!enrollment || enrollment.userId !== input.userId) return { ok: false, code: 'ENROLLMENT_NOT_FOUND' }
  if (await semesterAlreadyDecided(client, input.enrollmentId, input.semester)) {
    return { ok: false, code: 'SEMESTER_ALREADY_DECIDED' }
  }
  const period = await loadSemesterPeriod(client, {
    programId: enrollment.programId,
    enrollmentCreatedAt: enrollment.createdAt,
    extensionDays: enrollment.extensionDays,
    program: enrollment.program || {},
    semester: input.semester,
    now: input.now,
  })
  if (period.ended) return { ok: false, code: 'SEMESTER_PERIOD_ENDED' }
  const existing = await getSemesterDecision(client, input.enrollmentId, input.semester)
  if (!existing || (existing.status !== 'INTENT' && existing.status !== 'RAISED')) {
    return { ok: false, code: 'NO_ACTIVE_RAISE' }
  }
  const store = (client as AnyClient)?.semesterDecision
  if (!store?.update) return { ok: false, code: 'NO_ACTIVE_RAISE' }
  const now = input.now ?? new Date()
  const row = await store.update({
    where: { enrollmentId_semester: { enrollmentId: input.enrollmentId, semester: input.semester } },
    data: { status: 'WITHDRAWN', withdrawnAt: now },
  })
  await audit(
    { id: input.userId, name: 'طالب' },
    'SEMESTER_RAISE_WITHDRAWN',
    'Enrollment',
    input.enrollmentId,
    `semester ${input.semester}`,
  ).catch(() => {})
  return { ok: true, decision: row as SemesterDecisionRecord }
}

/**
 * Stamps the decision DECIDED inside the approval transaction once
 * the administration records the semester result. When the closure
 * came from the period end without any student record, a minimal
 * DEADLINE record is created so the file shows why approval was
 * lawful. Runs only when the decision system is active.
 */
export async function markSemesterDecided(
  client: AnyClient,
  input: { enrollmentId: string; semester: number; periodEnded: boolean; periodEndAt?: Date | null; now?: Date },
): Promise<void> {
  const store = (client as AnyClient)?.semesterDecision
  if (!store?.upsert) return
  const now = input.now ?? new Date()
  const existing = await getSemesterDecision(client, input.enrollmentId, input.semester)
  if (existing) {
    await store
      .update({
        where: { enrollmentId_semester: { enrollmentId: input.enrollmentId, semester: input.semester } },
        data: { status: 'DECIDED', decidedAt: now },
      })
      .catch(() => {})
    return
  }
  await store
    .create({
      data: {
        enrollmentId: input.enrollmentId,
        semester: input.semester,
        intent: null,
        status: 'DECIDED',
        raiseSource: input.periodEnded ? 'DEADLINE' : 'STUDENT',
        raisedAt: input.periodEnded ? input.periodEndAt ?? now : now,
        decidedAt: now,
      },
    })
    .catch(() => {})
}

/** Read model shared by the admin approvals surface and (stage 2) the
 * student portal: the stored decision, the period facts, and the
 * closure right they jointly produce — one source for every display. */
export async function summarizeSemesterDecision(
  client: AnyClient,
  input: {
    enrollmentId: string
    programId: string
    enrollmentCreatedAt: Date | string
    extensionDays?: number | null
    program: { category?: string | null; maxStudyDays?: number | null; semestersCount?: number | null }
    semester: number
    now?: Date
  },
): Promise<{
  decision: SemesterDecisionRecord
  periodEndAt: string | null
  periodEnded: boolean
  closure: ClosureRight
}> {
  const [decision, period] = await Promise.all([
    getSemesterDecision(client, input.enrollmentId, input.semester),
    loadSemesterPeriod(client, {
      programId: input.programId,
      enrollmentCreatedAt: input.enrollmentCreatedAt,
      extensionDays: input.extensionDays,
      program: input.program,
      semester: input.semester,
      now: input.now,
    }).catch(() => ({ endAt: null, ended: false })),
  ])
  return {
    decision,
    periodEndAt: period.endAt ? period.endAt.toISOString() : null,
    periodEnded: period.ended,
    closure: evaluateClosureRight({ decision, periodEnded: period.ended }),
  }
}
