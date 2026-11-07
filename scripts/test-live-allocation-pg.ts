/**
 * اختبار PostgreSQL حقيقية لدفتر تخصيص دقائق الصوت الحي (E01).
 *
 * ماذا يثبت: كل دقيقة مدفوعة محجوزة لجلسة صوت تُنسب في جدول
 * AiLiveCreditAllocation إلى الرصيد الذي سُحبت منه بعينه، وعند التسوية
 * يعود غير المستعمل إلى نفس الرصيد وبنفس انتهائه — لا إلى رصيد REFUND
 * مولّد يرث انتهاءً من تخمين «أقرب انتهاء في المجموعة».
 *
 * السيناريو 1 (حالة القبول المسماة من فحص الاستكمال): رصيد قديم
 * مستهلَك بالكامل ينتهي بعد يوم واحد + رصيد نشط ينتهي بعد 30 يومًا
 * موّل حجز دقيقتين؛ جلسة من 20 ثانية ⇒ دقيقة مستعملة ودقيقة مستردة.
 * على المسار السابق (poolAnchor) كانت المستردة تولد رصيد REFUND وارثًا
 * انتهاء اليوم الواحد فتفشل تأكيدات «لا REFUND» و«المتبقي 9 في رصيد
 * الثلاثين يومًا» هنا — هذا هو عدم عبث هذا السكربت.
 *
 * السيناريو 2: تمويل مشترك من رصيدين بآجال مختلفة + تسويتان متزامنتان
 * على PostgreSQL حقيقية: استرداد واحد فقط، لكل مصدر حصته، ومتطابقة
 * المحجوز = المستخدم + المسترد على مستوى كل صف تخصيص.
 *
 * السيناريو 3: جلسة قديمة بلا صفوف تخصيص (محجوزة قبل الهجرة) تُسوّى
 * بالمسار التقديري LEGACY_APPROXIMATE كما هو — رصيد REFUND واحد يرث
 * انتهاء مصدر المجموعة — حتى لا يكسر الترحيل أي جلسة حيّة.
 *
 * Real-PostgreSQL proof for the per-credit live-minute allocation
 * ledger (E01): refunds return to the exact funding credit with its
 * own expiry; a fully-consumed credit expiring tomorrow can no longer
 * shorten a refund funded by a 30-day credit.
 *
 * Environment:
 *   LIVE_PG_TEST_DATABASE_URL — optional. When set, that database is
 *     used (after the safety check below). Otherwise a disposable
 *     docker postgres:16 container is started on port 55434 and
 *     removed at exit.
 *   Safety: the script REFUSES to run unless the host is localhost OR
 *     the database name contains "test"/"ci" — never production.
 *   Free minutes are pinned to 0 via env so every draw is paid and the
 *     funding source is unambiguous.
 *
 * Exit codes: 0 = every assertion passed · 1 = an assertion failed ·
 * 2 = environment could not be prepared (docker/db push/import).
 */
import { spawn } from 'node:child_process'

// الدقائق المجانية تُقرأ من البيئة وقت النداء؛ تثبيتها على صفر قبل أي
// استيراد لتطبيق يجعل كل سحب مدفوعًا حتمًا.
process.env.AACT_LIVE_FREE_MONTHLY_MINUTES_STUDENT = '0'
process.env.AACT_LIVE_FREE_MONTHLY_MINUTES_ACTIVE_STUDENT = '0'

const ENV_URL = process.env.LIVE_PG_TEST_DATABASE_URL || ''
const DOCKER_CONTAINER = `aact-live-pg-${process.pid}`
const DOCKER_URL = 'postgresql://live_test:live_test_only@localhost:55434/academy_live_test'
const PG_READY_DEADLINE_MS = 90_000
const DAY_MS = 24 * 60 * 60 * 1000

const failures: string[] = []
let dbRef: any = null
let startedContainer = false

class StageError extends Error {
  exitCode = 2
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function check(label: string, ok: boolean, evidence: string) {
  if (ok) {
    console.log(`[PASS] ${label} — ${evidence}`)
  } else {
    console.error(`[FAIL] ${label} — ${evidence}`)
    failures.push(label)
  }
}

function describeError(error: any): string {
  const code = error?.code ? ` code=${error.code}` : ''
  const message = String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 400)
  return `${error?.name || 'Error'}${code}: ${message}`
}

function runCommand(
  command: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d.toString() })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: stderr + String(error) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function outputTail(text: string, lines = 25): string {
  return text.split('\n').slice(-lines).join('\n').trim()
}

function assertSafeDatabaseUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new StageError(`[ENV] LIVE_PG stage 0: database URL is not parseable — refusing to continue`)
  }
  const host = parsed.hostname.toLowerCase()
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase()
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  const markedDb = dbName.includes('test') || dbName.includes('ci')
  if (!localHost && !markedDb) {
    throw new StageError(
      `[ENV] LIVE_PG stage 0: SAFETY REFUSAL — host "${host}" is not localhost and database "${dbName}" contains neither "test" nor "ci". This script never runs against a production-shaped target.`,
    )
  }
  return rawUrl
}

async function resolveDatabaseUrl(): Promise<string> {
  if (ENV_URL) {
    console.log('[STAGE 0] Using LIVE_PG_TEST_DATABASE_URL from the environment')
    return assertSafeDatabaseUrl(ENV_URL)
  }
  console.log(`[STAGE 0] Starting disposable docker postgres:16 as ${DOCKER_CONTAINER} on port 55434`)
  await runCommand('docker', ['rm', '-f', DOCKER_CONTAINER])
  const run = await runCommand('docker', [
    'run', '-d', '--name', DOCKER_CONTAINER,
    '-e', 'POSTGRES_USER=live_test',
    '-e', 'POSTGRES_PASSWORD=live_test_only',
    '-e', 'POSTGRES_DB=academy_live_test',
    '-p', '55434:5432',
    'postgres:16',
  ])
  if (run.code !== 0) {
    throw new StageError(
      `[ENV] LIVE_PG stage 0: docker could not start the test PostgreSQL (exit ${run.code}). ` +
      `Docker is required when LIVE_PG_TEST_DATABASE_URL is unset.\n${outputTail(run.stderr || run.stdout)}`,
    )
  }
  startedContainer = true
  const deadline = Date.now() + PG_READY_DEADLINE_MS
  let ready = false
  while (Date.now() < deadline) {
    const probe = await runCommand('docker', ['exec', DOCKER_CONTAINER, 'pg_isready', '-U', 'live_test', '-d', 'academy_live_test'])
    if (probe.code === 0) { ready = true; break }
    await sleep(1500)
  }
  if (!ready) {
    throw new StageError(`[ENV] LIVE_PG stage 0: PostgreSQL never became ready within ${PG_READY_DEADLINE_MS / 1000}s`)
  }
  console.log('[STAGE 0] PostgreSQL is ready')
  return assertSafeDatabaseUrl(DOCKER_URL)
}

async function pushSchema(databaseUrl: string) {
  console.log('[STAGE 1] prisma db push --skip-generate against the throwaway database')
  const env = { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }
  const push = await runCommand('bunx', ['prisma', 'db', 'push', '--skip-generate'], env)
  if (push.code !== 0) {
    throw new StageError(
      `[ENV] LIVE_PG stage 1: prisma db push failed (exit ${push.code}).\n${outputTail(push.stdout + '\n' + push.stderr, 40)}`,
    )
  }
  console.log('[STAGE 1] Schema pushed')
}

async function importAppModules(databaseUrl: string) {
  process.env.DATABASE_URL = databaseUrl
  process.env.DIRECT_URL = databaseUrl
  console.log('[STAGE 2] Importing app modules against the test database')
  let db: any
  let guard: any
  try {
    ;({ db } = await import('@/lib/db'))
    guard = await import('@/lib/live-usage-guard')
  } catch (error) {
    throw new StageError(`[ENV] LIVE_PG stage 2: app module import failed — ${describeError(error)}`)
  }
  dbRef = db
  console.log('[STAGE 2] Modules imported')
  return { db, reserveGeminiLiveUsage: guard.reserveGeminiLiveUsage, settleGeminiLiveUsage: guard.settleGeminiLiveUsage }
}

const month = () => new Date().toISOString().slice(0, 7)

async function seedUser(db: any, id: string) {
  await db.user.create({
    data: { id, email: `${id}@example.test`, password: 'pg-test-only', name: `PG Live ${id}`, role: 'STUDENT' },
  })
}

async function ageSession(db: any, sessionId: string, msAgo: number) {
  await db.aiLiveSession.update({
    where: { sessionId },
    data: { startedAt: new Date(Date.now() - msAgo) },
  })
}

async function scenarioNamedCase(db: any, reserve: any, settle: any) {
  const scope = 'S1 named-case'
  const userId = 'pgl-u1'
  await seedUser(db, userId)
  const now = Date.now()
  await db.aiLiveCredit.create({
    data: { userId, minutes: 5, remainingMinutes: 0, status: 'CONSUMED', source: 'PURCHASE', expiresAt: new Date(now + DAY_MS), createdAt: new Date(now - 10 * DAY_MS) },
  })
  const c30 = await db.aiLiveCredit.create({
    data: { userId, minutes: 10, remainingMinutes: 10, status: 'ACTIVE', source: 'PURCHASE', expiresAt: new Date(now + 30 * DAY_MS), createdAt: new Date(now - DAY_MS) },
  })
  const reserved = await reserve({ userId, role: 'STUDENT', requestedMinutes: 2 })
  check(`${scope}: reserve ok`, reserved?.ok === true, `status=${reserved?.status}`)
  const afterReserve = await db.aiLiveCredit.findUnique({ where: { id: c30.id } })
  check(`${scope}: reserve drew 2 from the 30-day credit`, afterReserve?.remainingMinutes === 8, `remaining=${afterReserve?.remainingMinutes}`)
  await ageSession(db, reserved.sessionId, 20_000)
  const settled = await settle({ userId, sessionId: reserved.sessionId, actualMinutes: 0 })
  check(`${scope}: settle refunded exactly 1`, settled?.ok === true && settled?.refundMinutes === 1, `refund=${settled?.refundMinutes}`)
  const c30After = await db.aiLiveCredit.findUnique({ where: { id: c30.id } })
  check(`${scope}: refund returned to the SAME 30-day credit`, c30After?.remainingMinutes === 9 && c30After?.status === 'ACTIVE',
    `remaining=${c30After?.remainingMinutes} status=${c30After?.status}`)
  const refunds = await db.aiLiveCredit.findMany({ where: { userId, source: 'REFUND' } })
  check(`${scope}: no REFUND credit minted`, refunds.length === 0, `count=${refunds.length}`)
  const sessionRow = await db.aiLiveSession.findUnique({ where: { sessionId: reserved.sessionId } })
  const allocs = await db.aiLiveCreditAllocation.findMany({ where: { sessionId: sessionRow.id } })
  check(`${scope}: one allocation row, reserved=used+refunded`,
    allocs.length === 1 && allocs[0].creditId === c30.id && allocs[0].minutesReserved === 2 && allocs[0].minutesUsed === 1 && allocs[0].minutesRefunded === 1,
    `rows=${allocs.length} reserved=${allocs[0]?.minutesReserved} used=${allocs[0]?.minutesUsed} refunded=${allocs[0]?.minutesRefunded}`)
  const usage = await db.aiLiveUsage.findUnique({ where: { userId_month_purpose: { userId, month: month(), purpose: 'SUPERVISOR' } } })
  check(`${scope}: monthly paid counter settled at 1`, usage?.paidMinutesUsed === 1, `paidMinutesUsed=${usage?.paidMinutesUsed}`)
}

async function scenarioJointConcurrentSettle(db: any, reserve: any, settle: any) {
  const scope = 'S2 joint+concurrent-settle'
  const userId = 'pgl-u2'
  await seedUser(db, userId)
  const now = Date.now()
  const cA = await db.aiLiveCredit.create({
    data: { userId, minutes: 1, remainingMinutes: 1, status: 'ACTIVE', source: 'PURCHASE', expiresAt: new Date(now + 5 * DAY_MS), createdAt: new Date(now - 2 * DAY_MS) },
  })
  const cB = await db.aiLiveCredit.create({
    data: { userId, minutes: 5, remainingMinutes: 5, status: 'ACTIVE', source: 'PURCHASE', expiresAt: new Date(now + 30 * DAY_MS), createdAt: new Date(now - DAY_MS) },
  })
  const reserved = await reserve({ userId, role: 'STUDENT', requestedMinutes: 2 })
  check(`${scope}: reserve ok`, reserved?.ok === true, `status=${reserved?.status}`)
  await ageSession(db, reserved.sessionId, 20_000)
  const results = await Promise.all([
    settle({ userId, sessionId: reserved.sessionId, actualMinutes: 0 }).catch((e: any) => ({ ok: false, error: describeError(e) })),
    settle({ userId, sessionId: reserved.sessionId, actualMinutes: 0 }).catch((e: any) => ({ ok: false, error: describeError(e) })),
  ])
  check(`${scope}: both settle calls ok (one idempotent)`, results.every((r: any) => r?.ok === true), JSON.stringify(results.map((r: any) => ({ ok: r?.ok, idem: r?.idempotent, err: r?.error }))))
  const aAfter = await db.aiLiveCredit.findUnique({ where: { id: cA.id } })
  const bAfter = await db.aiLiveCredit.findUnique({ where: { id: cB.id } })
  check(`${scope}: refund landed once, in the last-drawn source only`,
    aAfter?.remainingMinutes === 0 && bAfter?.remainingMinutes === 5,
    `A=${aAfter?.remainingMinutes} B=${bAfter?.remainingMinutes}`)
  const sessionRow = await db.aiLiveSession.findUnique({ where: { sessionId: reserved.sessionId } })
  const allocs = await db.aiLiveCreditAllocation.findMany({ where: { sessionId: sessionRow.id } })
  const sumReserved = allocs.reduce((s: number, r: any) => s + r.minutesReserved, 0)
  const sumUsed = allocs.reduce((s: number, r: any) => s + r.minutesUsed, 0)
  const sumRefunded = allocs.reduce((s: number, r: any) => s + r.minutesRefunded, 0)
  check(`${scope}: ledger invariant reserved=used+refunded across rows`,
    allocs.length === 2 && sumReserved === 2 && sumUsed === 1 && sumRefunded === 1 && allocs.every((r: any) => r.minutesReserved === r.minutesUsed + r.minutesRefunded),
    `rows=${allocs.length} reserved=${sumReserved} used=${sumUsed} refunded=${sumRefunded}`)
  check(`${scope}: session settled once at 1 minute`, sessionRow?.status === 'SETTLED' && sessionRow?.actualMinutes === 1,
    `status=${sessionRow?.status} actual=${sessionRow?.actualMinutes}`)
}

async function scenarioLegacySession(db: any, settle: any) {
  const scope = 'S3 legacy-session'
  const userId = 'pgl-u3'
  await seedUser(db, userId)
  const now = Date.now()
  const poolExpiry = new Date(now + 30 * DAY_MS)
  const pool = await db.aiLiveCredit.create({
    data: { userId, minutes: 3, remainingMinutes: 3, status: 'ACTIVE', source: 'PURCHASE', expiresAt: poolExpiry, createdAt: new Date(now - DAY_MS) },
  })
  await db.aiLiveUsage.create({
    data: { userId, month: month(), purpose: 'SUPERVISOR', freeMinutesUsed: 0, paidMinutesUsed: 2, sessionsCount: 1 },
  })
  await db.aiLiveSession.create({
    data: {
      sessionId: 'pgl-legacy-1', userId, month: month(), purpose: 'SUPERVISOR', status: 'RESERVED',
      reservedMinutes: 2, freeReserved: 0, paidReserved: 2,
      startedAt: new Date(now - 20_000), expiresAt: new Date(now + 10 * 60 * 1000),
    },
  })
  const settled = await settle({ userId, sessionId: 'pgl-legacy-1', actualMinutes: 0 })
  check(`${scope}: legacy settle ok with refund 1`, settled?.ok === true && settled?.refundMinutes === 1, `refund=${settled?.refundMinutes}`)
  const refunds = await db.aiLiveCredit.findMany({ where: { userId, source: 'REFUND' } })
  check(`${scope}: legacy path minted one REFUND inheriting the pool expiry`,
    refunds.length === 1 && refunds[0].remainingMinutes === 1 && refunds[0].expiresAt?.getTime() === poolExpiry.getTime(),
    `count=${refunds.length} remaining=${refunds[0]?.remainingMinutes} expiresAt=${refunds[0]?.expiresAt?.toISOString()}`)
  const poolAfter = await db.aiLiveCredit.findUnique({ where: { id: pool.id } })
  check(`${scope}: legacy path did not touch source credits`, poolAfter?.remainingMinutes === 3, `remaining=${poolAfter?.remainingMinutes}`)
  const allocs = await db.aiLiveCreditAllocation.findMany({ where: { sessionId: (await db.aiLiveSession.findUnique({ where: { sessionId: 'pgl-legacy-1' } })).id } })
  check(`${scope}: legacy session gained no allocation rows`, allocs.length === 0, `rows=${allocs.length}`)
}

async function cleanup() {
  if (dbRef) {
    await dbRef.$disconnect().catch(() => {})
    dbRef = null
  }
  if (startedContainer) {
    const rm = await runCommand('docker', ['rm', '-f', DOCKER_CONTAINER])
    if (rm.code !== 0) console.error(`[WARN] could not remove docker container ${DOCKER_CONTAINER}: ${outputTail(rm.stderr, 3)}`)
    startedContainer = false
  }
}

async function main(): Promise<number> {
  const databaseUrl = await resolveDatabaseUrl()
  await pushSchema(databaseUrl)
  const { db, reserveGeminiLiveUsage, settleGeminiLiveUsage } = await importAppModules(databaseUrl)
  console.log('[STAGE 3] Seeding fixtures and running allocation scenarios')
  await scenarioNamedCase(db, reserveGeminiLiveUsage, settleGeminiLiveUsage)
  await scenarioJointConcurrentSettle(db, reserveGeminiLiveUsage, settleGeminiLiveUsage)
  await scenarioLegacySession(db, settleGeminiLiveUsage)
  if (failures.length) {
    console.error(`\nLIVE_ALLOCATION_PG: FAILED — ${failures.length} assertion(s) failed`)
    return 1
  }
  console.log('\nLIVE_ALLOCATION_PG: ALL ASSERTIONS PASSED')
  return 0
}

main()
  .then(async (code) => {
    await cleanup()
    process.exit(code)
  })
  .catch(async (error) => {
    if (error instanceof StageError) {
      console.error(error.message)
      await cleanup()
      process.exit(2)
    }
    console.error(`[FAIL] LIVE_PG unexpected error during scenarios — ${describeError(error)}`)
    await cleanup()
    process.exit(1)
  })
