import { audit } from '@/lib/notify'
import { getSemesterWindows } from '@/lib/semester-lifecycle'
import { enqueueOutbox } from '@/lib/outbox'

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

// ===== بوابة الرفع لمعاملات التخرج (الخطوة 5) =====
// أين يقف ملف الطالب بالنسبة لرفعه هو: الحالة الواحدة التي تقرأها
// قائمة معاملات التخرج وإشعار الطالب المستوفي — من سجل القرار ونهاية
// فترة الفصل الأخير، بلا أي كتابة.

export type RaiseGate = 'DECIDED' | 'RAISED' | 'PERIOD_ENDED' | 'INTENT_PENDING' | 'AWAITING_STUDENT'

export function raiseGateOf(
  decision: { status?: string | null; raiseSource?: string | null } | null | undefined,
  periodEnded: boolean,
): RaiseGate {
  const status = decision?.status ?? null
  if (status === 'DECIDED') return 'DECIDED'
  // A deadline-generated raise is NOT an explicit student request.
  // An extension after the old deadline reopens the legal window;
  // old DEADLINE status must not authorize an early admin decision.
  if (status === 'RAISED' && decision?.raiseSource !== 'DEADLINE') return 'RAISED'
  if (periodEnded) return 'PERIOD_ENDED'
  if (status === 'INTENT') return 'INTENT_PENDING'
  return 'AWAITING_STUDENT'
}

/** A graduation transaction is actionable only after the student's
 * last semester has actually been raised, decided, or has reached its
 * scheduled end. A draft INTENT is not a submission. */
export function isGraduationRaiseEligible(gate: RaiseGate | null | undefined): boolean {
  return gate === 'RAISED' || gate === 'DECIDED' || gate === 'PERIOD_ENDED'
}

/**
 * A graduation readiness event may be registered well before the student
 * submits the final semester. Only enqueue the administrator notification
 * once BOTH independently persisted conditions hold: academic readiness
 * and a lawful final-semester raise (or expiry). The outbox key prevents
 * duplicate notifications on grading, request refresh and cron retries.
 */
export async function enqueueReadyGraduationAdminNotice(
  client: AnyClient,
  input: { enrollmentId: string; expectedSemester?: number; now?: Date },
): Promise<boolean> {
  if (!SEMESTER_DECISION_ACTIVE || !client?.graduationRequest?.findUnique) return false
  const enrollment = await client.enrollment.findUnique({
    where: { id: input.enrollmentId },
    select: {
      id: true, userId: true, programId: true, createdAt: true, extensionDays: true,
      program: { select: { category: true, maxStudyDays: true, semestersCount: true } },
    },
  })
  if (!enrollment?.program) return false
  const units = await client.unit.findMany({
    where: { programId: enrollment.programId },
    select: { id: true, semester: true, order: true },
  })
  const windows = getSemesterWindows(
    new Date(enrollment.createdAt), enrollment.program, units, enrollment.extensionDays ?? 0,
  )
  const last = windows[windows.length - 1]
  if (!last || (input.expectedSemester != null && input.expectedSemester !== last.semester)) return false

  return withDecisionLock(client, input.enrollmentId, last.semester, async (tx) => {
    const fresh = await tx.enrollment.findUnique({
      where: { id: input.enrollmentId },
      select: {
        createdAt: true, programId: true, extensionDays: true,
        program: { select: { category: true, maxStudyDays: true, semestersCount: true } },
      },
    })
    if (!fresh?.program) return false
    const period = await loadSemesterPeriod(tx, {
      programId: fresh.programId,
      enrollmentCreatedAt: fresh.createdAt,
      extensionDays: fresh.extensionDays,
      program: fresh.program,
      semester: last.semester,
      now: input.now,
    })
    const decision = await getSemesterDecision(tx, input.enrollmentId, last.semester)
    if (!isGraduationRaiseEligible(raiseGateOf(decision, period.ended))) return false
    const request = await tx.graduationRequest.findUnique({
      where: { enrollmentId: input.enrollmentId },
      select: { id: true, status: true, ready: true, score: true },
    })
    if (!request?.ready || request.status !== 'PENDING') return false
    await enqueueOutbox(tx, {
      key: `graduation-ready-to-approve:${input.enrollmentId}:${request.id}:${request.score ?? 'none'}`,
      kind: 'GRADUATION_READY_FOR_REVIEW',
      recipientRole: 'ADMINS',
      title: 'معاملة تخرج جاهزة لقرار الإدارة',
      body: 'استوفى الطالب شروط التخرج ورُفع فصله الأخير، أو انتهت مدته النظامية. راجع الدرجة والرسوم والملف قبل المصادقة.',
      link: '/?view=admin&tab=certs',
    })
    return true
  })
}

/** Periodic catch-up: a prior grading event or outbox write may have
 * failed; retry the eligibility/raise check without creating fake
 * approval records or repeating previously enqueued notifications. */
export async function reconcileReadyGraduationNotices(
  client: AnyClient,
  input: { limit?: number } = {},
): Promise<number> {
  if (!SEMESTER_DECISION_ACTIVE) return 0
  const rows = await client.graduationRequest.findMany({
    where: { status: 'PENDING', ready: true },
    orderBy: { updatedAt: 'desc' },
    take: input.limit ?? 100,
    select: { enrollmentId: true },
  })
  let checked = 0
  for (const row of rows) {
    if (await enqueueReadyGraduationAdminNotice(client, { enrollmentId: row.enrollmentId })) checked++
  }
  return checked
}

/**
 * Referral when ONE semester's own window expires. Every active enrollment
 * is eligible for a deadline referral, including students who selected
 * CONTINUE, withdrew an early request or never pressed a decision button.
 *
 * No automatic approval, passing mark, fake exam attempt or certificate:
 * the regular administrator grading/approval blockers still apply.
 * Rows are created only after the actual period end, under the SAME
 * enrollment+semester lock used by student withdrawal/admin approval.
 * Repeated cron ticks are idempotent. Do not touch old certified records.
 */
export async function materializeDeadlineRaises(
  client: AnyClient,
  input: { now?: Date; limit?: number } = {},
): Promise<number> {
  if (!SEMESTER_DECISION_ACTIVE) return 0
  if (!client?.enrollment?.findMany || !client?.semesterDecision?.findUnique) {
    throw new Error('SEMESTER_DEADLINE_SCAN_UNAVAILABLE')
  }
  const now = input.now ?? new Date()
  const maxRaises = Math.min(500, Math.max(1, input.limit ?? 100))
  const batchSize = 100
  let raised = 0
  let cursor: string | undefined

  while (raised < maxRaises) {
    const enrollments: any[] = await client.enrollment.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        userId: true,
        programId: true,
        createdAt: true,
        status: true,
        extensionDays: true,
        program: { select: { category: true, maxStudyDays: true, semestersCount: true } },
      },
    })
    if (!enrollments.length) break
    cursor = enrollments[enrollments.length - 1].id

    for (const enrollment of enrollments) {
      if (raised >= maxRaises) break
      if (!enrollment.program) continue
      const units: Array<{ id: string; semester: number; order: number }> = await client.unit.findMany({
        where: { programId: enrollment.programId },
        select: { id: true, semester: true, order: true },
      })
      const windows = getSemesterWindows(
        new Date(enrollment.createdAt), enrollment.program, units,
        enrollment.extensionDays ?? 0,
      )
      for (const window of windows) {
        if (raised >= maxRaises) break
        if (now.getTime() <= window.endAt.getTime()) continue
        const changed = await withDecisionLock(client, enrollment.id, window.semester, async (tx) => {
          // Re-read the deadline and extension under the decision lock.
          const fresh = await tx.enrollment.findUnique({
            where: { id: enrollment.id },
            select: {
              status: true,
              createdAt: true,
              programId: true,
              extensionDays: true,
              program: { select: { category: true, maxStudyDays: true, semestersCount: true } },
            },
          })
          if (fresh?.status !== 'ACTIVE' || !fresh.program) return false
          const period = await loadSemesterPeriod(tx, {
            programId: fresh.programId,
            enrollmentCreatedAt: fresh.createdAt,
            extensionDays: fresh.extensionDays,
            program: fresh.program,
            semester: window.semester,
            now,
          })
          if (!period.ended || !period.endAt) return false

          // The result may already have been approved/closed by an
          // administrator. Never resurrect a decided semester.
          const [approval, state, existing] = await Promise.all([
            tx.semesterResultApproval.findUnique({
              where: { enrollmentId_semester: { enrollmentId: enrollment.id, semester: window.semester } },
              select: { id: true },
            }),
            tx.enrollmentSemesterState.findUnique({
              where: { enrollmentId_semester: { enrollmentId: enrollment.id, semester: window.semester } },
              select: { status: true },
            }),
            getSemesterDecision(tx, enrollment.id, window.semester),
          ])
          if (approval || state?.status === 'CLOSED' ||
              existing?.status === 'DECIDED' || existing?.status === 'RAISED') return false

          let count = 0
          if (existing) {
            const updated = await tx.semesterDecision.updateMany({
              where: {
                enrollmentId: enrollment.id,
                semester: window.semester,
                status: { in: ['NONE', 'INTENT', 'WITHDRAWN'] },
              },
              data: {
                status: 'RAISED', raiseSource: 'DEADLINE',
                raisedAt: period.endAt, scoreAtRaise: null,
              },
            })
            count = updated.count
          } else {
            try {
              await tx.semesterDecision.create({
                data: {
                  enrollmentId: enrollment.id, semester: window.semester,
                  intent: null, status: 'RAISED', raiseSource: 'DEADLINE',
                  raisedAt: period.endAt, scoreAtRaise: null,
                },
              })
              count = 1
            } catch (error) {
              if (!isUniqueViolation(error)) throw error
            }
          }
          if (count !== 1) return false
          await enqueueOutbox(tx, {
            key: `semester-deadline-raised:${enrollment.id}:${window.semester}`,
            kind: 'SEMESTER_DEADLINE_RAISED',
            recipientRole: 'ADMINS',
            title: `انتهت فترة الفصل ${window.semester} — للمراجعة`,
            body: `انتهت مدة الفصل ${window.semester} لطالب، وارتفعت نتيجته للمراجعة. تُحتسب الأعمال غير المقدمة صفرًا، ولا يجوز الاعتماد قبل إنهاء تصحيح الأعمال المقدمة والمصادقات المطلوبة.`,
            link: '/?view=admin&tab=certs',
          })
          // When this was the LAST semester and the student's graduation
          // record is already ready, notify administrators now too.
          await enqueueReadyGraduationAdminNotice(tx, {
            enrollmentId: enrollment.id, expectedSemester: window.semester, now,
          })
          return true
        })
        if (changed) raised++
      }
    }
    if (enrollments.length < batchSize) break
  }
  return raised
}

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
  // A real database failure must not masquerade as "the student never
  // requested anything". Let the caller fail closed with a clear error.
  const row = await store.findUnique({
    where: { enrollmentId_semester: { enrollmentId, semester } },
  })
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
  // Missing units can affect semester count and therefore its deadline.
  // A DB outage must not be mistaken for an empty programme.
  const units = await client.unit.findMany({
    where: { programId: input.programId },
    select: { id: true, semester: true, order: true },
  })
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
  const row = await client.enrollment.findUnique({
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
    const approval = await approvalStore.findUnique({
      where: { enrollmentId_semester: { enrollmentId, semester } },
    })
    if (approval) return true
  }
  const stateStore = (client as AnyClient)?.enrollmentSemesterState
  if (stateStore?.findUnique) {
    const state = await stateStore.findUnique({
      where: { enrollmentId_semester: { enrollmentId, semester } },
    })
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
    }),
  ])
  return {
    decision,
    periodEndAt: period.endAt ? period.endAt.toISOString() : null,
    periodEnded: period.ended,
    closure: evaluateClosureRight({ decision, periodEnded: period.ended }),
  }
}
