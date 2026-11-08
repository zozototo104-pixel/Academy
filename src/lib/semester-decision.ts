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
// asked for early finalization AND the server-derived maturity held:
// semester exam taken and graded, submitted work final), or the END
// of the semester's own period (the existing window computation,
// extensions included). An unsubmitted item is computationally zero
// in the average long before either source exists; it becomes FINAL
// for approval only once a closure right exists. Submitted work still
// being graded or appealed blocks approval under every source.
//
// CONCURRENCY LAW: every state transition is a status-conditioned
// update (updateMany on the expected prior status, count-checked) —
// a withdrawn request can never be resurrected by a late grading
// event, and a decided record can never be overwritten. On the real
// database the public transitions additionally run inside one
// transaction holding a per-(enrollment, semester) advisory lock,
// the same lock the approval guard takes, so a withdrawal and an
// approval can never interleave. Maturity is NEVER taken from a
// caller: routes go through src/lib/semester-raise.ts, which derives
// it from the actual exam/grading state on the server.
//
// ACTIVATION: stages 1–2 shipped the record, the guard and the
// student UI behind this valve; stage 3 (contextual finality inside
// the approval guard + admin/student surfaces reading the same
// brief) activates the system. The constant stays as the single
// kill-switch for the whole decision mechanism.

export const SEMESTER_DECISION_ACTIVE = true

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

/** Serializes every decision transition for one (enrollment, semester)
 * on the real database: an advisory transaction lock keyed by the
 * pair. The approval guard takes the same lock inside its own
 * transaction, so approve/withdraw/record can never interleave.
 * A client without $queryRaw (test doubles) simply skips the lock —
 * the status-conditioned updates still guard those paths. A lock
 * FAILURE on a capable client throws: a silently unlocked transition
 * is worse than a failed one. */
export async function lockSemesterDecision(
  client: AnyClient,
  enrollmentId: string,
  semester: number,
): Promise<void> {
  if (!client?.$queryRaw) return
  const key = `semester-decision:${enrollmentId}:${semester}`
  await client.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`
}

/** Runs a decision transition under the pair lock when the client is
 * the real database (exposes $transaction); test doubles run directly
 * and rely on the status-conditioned updates alone. */
async function withDecisionLock<T>(
  client: AnyClient,
  enrollmentId: string,
  semester: number,
  fn: (tx: AnyClient) => Promise<T>,
): Promise<T> {
  if (typeof client?.$transaction === 'function') {
    return client.$transaction(async (tx: AnyClient) => {
      await lockSemesterDecision(tx, enrollmentId, semester)
      return fn(tx)
    })
  }
  return fn(client)
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

function semesterInRange(enrollment: EnrollmentContext, semester: number): boolean {
  if (!Number.isInteger(semester) || semester < 1) return false
  const count = enrollment.program?.semestersCount
  if (count != null && semester > count) return false
  return true
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

/** Status-conditioned transition: applies `data` only while the stored
 * status is one of `expected`. Returns the affected row count — 0 means
 * a concurrent transition won the race and the caller must re-read and
 * classify instead of overwriting. */
async function transition(
  client: AnyClient,
  enrollmentId: string,
  semester: number,
  expected: string[],
  data: Record<string, unknown>,
): Promise<number> {
  const store = (client as AnyClient)?.semesterDecision
  if (!store?.updateMany) return 0
  const res = await store.updateMany({
    where: { enrollmentId, semester, status: { in: expected } },
    data,
  })
  return Number(res?.count ?? 0)
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'P2002'
}

export type RecordIntentResult =
  | { ok: true; decision: SemesterDecisionRecord }
  | { ok: false; code: 'ENROLLMENT_NOT_FOUND' | 'SEMESTER_ALREADY_DECIDED' | 'SEMESTER_PERIOD_ENDED' | 'SEMESTER_ALREADY_RAISED' | 'INVALID_SEMESTER' }

/** The maturity seam is INTERNAL: `maturity` is derived on the server by
 * src/lib/semester-raise.ts from the actual exam/grading state. No HTTP
 * handler may pass it — routes call the semester-raise orchestrators. */
export type RaiseMaturity = { mature: boolean; score: number | null }

async function recordSemesterIntentTx(
  tx: AnyClient,
  input: {
    enrollmentId: string
    userId: string
    semester: number
    intent: SemesterIntent
    scoreSnapshot?: number | null
    maturity?: RaiseMaturity
    now?: Date
  },
): Promise<RecordIntentResult> {
  const maturity: RaiseMaturity = input.maturity ?? { mature: false, score: null }
  const enrollment = await loadEnrollmentContext(tx, input.enrollmentId)
  if (!enrollment || enrollment.userId !== input.userId) return { ok: false, code: 'ENROLLMENT_NOT_FOUND' }
  if (!semesterInRange(enrollment, input.semester)) return { ok: false, code: 'INVALID_SEMESTER' }
  if (await semesterAlreadyDecided(tx, input.enrollmentId, input.semester)) {
    return { ok: false, code: 'SEMESTER_ALREADY_DECIDED' }
  }
  const period = await loadSemesterPeriod(tx, {
    programId: enrollment.programId,
    enrollmentCreatedAt: enrollment.createdAt,
    extensionDays: enrollment.extensionDays,
    program: enrollment.program || {},
    semester: input.semester,
    now: input.now,
  })
  if (period.ended) return { ok: false, code: 'SEMESTER_PERIOD_ENDED' }

  const store = (tx as AnyClient)?.semesterDecision
  if (!store?.updateMany || !store?.create) return { ok: false, code: 'ENROLLMENT_NOT_FOUND' }
  const existing = await getSemesterDecision(tx, input.enrollmentId, input.semester)
  if (existing?.status === 'DECIDED') return { ok: false, code: 'SEMESTER_ALREADY_DECIDED' }
  const now = input.now ?? new Date()

  if (input.intent === 'CONTINUE') {
    if (existing?.status === 'RAISED') return { ok: false, code: 'SEMESTER_ALREADY_RAISED' }
    if (!existing) {
      const row = await store.create({
        data: {
          enrollmentId: input.enrollmentId,
          semester: input.semester,
          intent: 'CONTINUE',
          status: 'NONE',
          intentAt: now,
        },
      })
      return { ok: true, decision: row as SemesterDecisionRecord }
    }
    if (existing.intent === 'CONTINUE' && existing.status !== 'INTENT') {
      return { ok: true, decision: existing }
    }
    const count = await transition(tx, input.enrollmentId, input.semester, ['INTENT', 'NONE', 'WITHDRAWN'], {
      intent: 'CONTINUE',
      status: 'NONE',
      intentAt: now,
      withdrawnAt: null,
    })
    const current = await getSemesterDecision(tx, input.enrollmentId, input.semester)
    if (count === 0) {
      if (current?.status === 'RAISED') return { ok: false, code: 'SEMESTER_ALREADY_RAISED' }
      if (current?.status === 'DECIDED') return { ok: false, code: 'SEMESTER_ALREADY_DECIDED' }
    }
    return { ok: true, decision: current }
  }

  // EARLY_FINISH
  if (existing?.status === 'RAISED' && existing?.intent === 'EARLY_FINISH') {
    return { ok: true, decision: existing }
  }
  const matures = maturity.mature === true
  const data = {
    intent: 'EARLY_FINISH',
    status: matures ? 'RAISED' : 'INTENT',
    raiseSource: matures ? 'STUDENT' : null,
    intentAt: now,
    raisedAt: matures ? now : null,
    withdrawnAt: null,
    scoreAtIntent: input.scoreSnapshot ?? existing?.scoreAtIntent ?? null,
    scoreAtRaise: matures ? maturity.score ?? input.scoreSnapshot ?? null : null,
  }
  if (!existing) {
    try {
      const row = await store.create({
        data: { enrollmentId: input.enrollmentId, semester: input.semester, ...data },
      })
      await audit(
        { id: input.userId, name: 'طالب' },
        matures ? 'SEMESTER_RAISED' : 'SEMESTER_INTENT_EARLY_FINISH',
        'Enrollment',
        input.enrollmentId,
        `semester ${input.semester}`,
      ).catch(() => {})
      return { ok: true, decision: row as SemesterDecisionRecord }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const current = await getSemesterDecision(tx, input.enrollmentId, input.semester)
      if (current?.status === 'RAISED' && current?.intent === 'EARLY_FINISH') {
        return { ok: true, decision: current }
      }
      if (current?.status === 'DECIDED') return { ok: false, code: 'SEMESTER_ALREADY_DECIDED' }
      return { ok: true, decision: current }
    }
  }
  const count = await transition(tx, input.enrollmentId, input.semester, ['NONE', 'INTENT', 'WITHDRAWN'], data)
  const current = await getSemesterDecision(tx, input.enrollmentId, input.semester)
  if (count === 0) {
    if (current?.status === 'DECIDED') return { ok: false, code: 'SEMESTER_ALREADY_DECIDED' }
    if (current?.status === 'RAISED' && current?.intent === 'EARLY_FINISH') {
      return { ok: true, decision: current }
    }
  }
  await audit(
    { id: input.userId, name: 'طالب' },
    matures ? 'SEMESTER_RAISED' : 'SEMESTER_INTENT_EARLY_FINISH',
    'Enrollment',
    input.enrollmentId,
    `semester ${input.semester}`,
  ).catch(() => {})
  return { ok: true, decision: current }
}

/**
 * Records the student's explicit choice for one semester, under the
 * pair lock. An EARLY_FINISH choice matures to RAISED only when the
 * server-derived maturity holds; otherwise the intent is stored and
 * matures later. Repeating the same choice is idempotent. A CONTINUE
 * choice cancels an unmatured early-finish intent; a matured raise is
 * left to the withdraw path.
 */
export async function recordSemesterIntent(
  client: AnyClient,
  input: {
    enrollmentId: string
    userId: string
    semester: number
    intent: SemesterIntent
    scoreSnapshot?: number | null
    maturity?: RaiseMaturity
    now?: Date
  },
): Promise<RecordIntentResult> {
  return withDecisionLock(client, input.enrollmentId, input.semester, (tx) =>
    recordSemesterIntentTx(tx, input),
  )
}

/**
 * Matures a stored EARLY_FINISH intent into a raise once the
 * server-derived maturity holds. The transition is conditioned on the
 * stored status still being INTENT — a request the student withdrew
 * in the meantime is NEVER resurrected by a late grading event, and a
 * decided semester is never touched.
 */
export async function tryMatureSemesterRaise(
  client: AnyClient,
  input: { enrollmentId: string; semester: number; maturity: RaiseMaturity; now?: Date },
): Promise<SemesterDecisionRecord> {
  return withDecisionLock(client, input.enrollmentId, input.semester, async (tx) => {
    const existing = await getSemesterDecision(tx, input.enrollmentId, input.semester)
    if (!existing || existing.status !== 'INTENT' || existing.intent !== 'EARLY_FINISH' || !input.maturity.mature) {
      return existing
    }
    const now = input.now ?? new Date()
    const count = await transition(tx, input.enrollmentId, input.semester, ['INTENT'], {
      status: 'RAISED',
      raiseSource: 'STUDENT',
      raisedAt: now,
      scoreAtRaise: input.maturity.score ?? existing.scoreAtIntent ?? null,
    })
    const current = await getSemesterDecision(tx, input.enrollmentId, input.semester)
    if (count > 0) {
      await audit(
        null,
        'SEMESTER_RAISED',
        'Enrollment',
        input.enrollmentId,
        `semester ${input.semester} (matured)`,
      ).catch(() => {})
    }
    return current
  })
}

export type WithdrawResult =
  | { ok: true; decision: SemesterDecisionRecord }
  | { ok: false; code: 'ENROLLMENT_NOT_FOUND' | 'SEMESTER_ALREADY_DECIDED' | 'SEMESTER_PERIOD_ENDED' | 'NO_ACTIVE_RAISE' | 'INVALID_SEMESTER' }

/**
 * Withdraws an intent or a matured raise, under the pair lock. Allowed
 * only while the administration has not decided AND the semester
 * period is still open — after the period ends, withdrawal cannot
 * resurrect time and the deadline path (or an extension) governs
 * instead. A changed grade after the raise never cancels this right
 * by itself. The transition is conditioned on INTENT/RAISED, so a
 * decision stamped in the meantime wins and the withdrawal refuses.
 */
export async function withdrawSemesterRaise(
  client: AnyClient,
  input: { enrollmentId: string; userId: string; semester: number; now?: Date },
): Promise<WithdrawResult> {
  return withDecisionLock(client, input.enrollmentId, input.semester, async (tx) => {
    const enrollment = await loadEnrollmentContext(tx, input.enrollmentId)
    if (!enrollment || enrollment.userId !== input.userId) return { ok: false, code: 'ENROLLMENT_NOT_FOUND' }
    if (!semesterInRange(enrollment, input.semester)) return { ok: false, code: 'INVALID_SEMESTER' }
    if (await semesterAlreadyDecided(tx, input.enrollmentId, input.semester)) {
      return { ok: false, code: 'SEMESTER_ALREADY_DECIDED' }
    }
    const period = await loadSemesterPeriod(tx, {
      programId: enrollment.programId,
      enrollmentCreatedAt: enrollment.createdAt,
      extensionDays: enrollment.extensionDays,
      program: enrollment.program || {},
      semester: input.semester,
      now: input.now,
    })
    if (period.ended) return { ok: false, code: 'SEMESTER_PERIOD_ENDED' }
    const existing = await getSemesterDecision(tx, input.enrollmentId, input.semester)
    if (!existing || (existing.status !== 'INTENT' && existing.status !== 'RAISED')) {
      return { ok: false, code: 'NO_ACTIVE_RAISE' }
    }
    const now = input.now ?? new Date()
    const count = await transition(tx, input.enrollmentId, input.semester, ['INTENT', 'RAISED'], {
      status: 'WITHDRAWN',
      withdrawnAt: now,
    })
    if (count === 0) {
      if (await semesterAlreadyDecided(tx, input.enrollmentId, input.semester)) {
        return { ok: false, code: 'SEMESTER_ALREADY_DECIDED' }
      }
      return { ok: false, code: 'NO_ACTIVE_RAISE' }
    }
    const current = await getSemesterDecision(tx, input.enrollmentId, input.semester)
    await audit(
      { id: input.userId, name: 'طالب' },
      'SEMESTER_RAISE_WITHDRAWN',
      'Enrollment',
      input.enrollmentId,
      `semester ${input.semester}`,
    ).catch(() => {})
    return { ok: true, decision: current }
  })
}

/**
 * Stamps the decision DECIDED inside the approval transaction once
 * the administration records the semester result. When the closure
 * came from the period end without any student record, a minimal
 * DEADLINE record is created so the file shows why approval was
 * lawful. Write failures PROPAGATE: an approval must never be stored
 * while its decision stamp failed — the approval transaction rolls
 * back instead. (A client that lacks the delegate entirely — test
 * doubles — skips the stamp as a capability matter, not an error.)
 */
export async function markSemesterDecided(
  client: AnyClient,
  input: { enrollmentId: string; semester: number; periodEnded: boolean; periodEndAt?: Date | null; now?: Date },
): Promise<void> {
  const store = (client as AnyClient)?.semesterDecision
  if (!store?.update || !store?.create) return
  const now = input.now ?? new Date()
  const existing = await getSemesterDecision(client, input.enrollmentId, input.semester)
  if (existing) {
    await store.update({
      where: { enrollmentId_semester: { enrollmentId: input.enrollmentId, semester: input.semester } },
      data: { status: 'DECIDED', decidedAt: now },
    })
    return
  }
  await store.create({
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
