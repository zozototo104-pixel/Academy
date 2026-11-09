/**
 * اختبار تنافس حقيقي على PostgreSQL لإصدار المنح المنظمة.
 *
 * ماذا يثبت على قاعدة حقيقية:
 *  A) سباق مقعد أخير: معاملتا حجز متزامنتان على تعريف منحة بسقف مقعد واحد
 *     — واحدة فقط تلتزم بعملية، والأخرى تُرفض «المقاعد اكتملت» بعد انتظار
 *     قفل التعريف. لا مقعد مزدوج أبداً.
 *  B) سباق الطالب نفسه: معاملتان متزامنتان للطالب نفسه — قفل صف المستخدم
 *     يُسلسلهما، والثانية ترى العملية الحاجزة وتُرفض. لا منحتان أبداً.
 *  C) تحرير الانتهاء بكود حقيقي: releaseStaleGrantOperations من مكتبة طبقة
 *     التنظيم نفسها تُقفل عملية أكوادها كلها منتهية على المخطط الحقيقي.
 *
 * حدود الإثبات بصراحة: دالة الحجز داخل مسار الإدارة (reserveGrantOperation)
 * ليست قابلة للاستيراد من سكربت، فالمعاملة هنا تُعيد تنفيذ نمطها حرفياً
 * (قفل صف المستخدم ثم قفل صف التعريف بترتيب المسار نفسه، ثم عدّ العمليات
 * الحاجزة، ثم الإدراج) — ومنطق المسار نفسه مثبت في مجموعة الاختبارات
 * الوهمية (tests/payments/payment-settlement.test.ts). ما يثبته هذا
 * السكربت هو أن النمط يُسلسل فعلاً على PostgreSQL حقيقية، وأن جداول
 * التنظيم الجديدة وقيودها تعمل كما صُممت.
 *
 * Environment:
 *   GRANTS_PG_TEST_DATABASE_URL — optional. Otherwise a disposable docker
 *     postgres:16 container is started on port 55434 and removed at exit.
 *   Safety: refuses to run unless the host is localhost OR the database
 *     name contains "test"/"ci" — it can never touch production.
 *
 * Exit codes: 0 = every assertion passed · 1 = an assertion failed ·
 * 2 = environment could not be prepared.
 */
import { spawn } from 'node:child_process'

const ENV_URL = process.env.GRANTS_PG_TEST_DATABASE_URL || ''
const DOCKER_CONTAINER = `aact-grants-pg-${process.pid}`
const DOCKER_URL = 'postgresql://grants_test:grants_test_only@localhost:55434/academy_grants_test'
const PG_READY_DEADLINE_MS = 90_000

const failures: string[] = []
let dbRef: any = null
let startedContainer = false

class StageError extends Error { exitCode = 2 }

function sleep(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function check(label: string, ok: boolean, evidence: string) {
  if (ok) console.log(`[PASS] ${label} — ${evidence}`)
  else {
    console.error(`[FAIL] ${label} — ${evidence}`)
    console.log(`::error title=GRANTS_PG_FAIL::${label} — ${evidence}`.replace(/[%]/g, '%25').replace(/[\r\n]/g, ' '))
    failures.push(label)
  }
}

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
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
  try { parsed = new URL(rawUrl) } catch {
    throw new StageError('[ENV] GRANTS_PG stage 0: database URL is not parseable — refusing to continue')
  }
  const host = parsed.hostname.toLowerCase()
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase()
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  // All three conditions must hold: a local host, a name carrying "test"
  // as a whole token, and no production marker anywhere in the name. A
  // substring rule alone is not a guard — "official_production" contains
  // "ci" and must never pass.
  const testToken = /(^|[^a-z0-9])test([^a-z0-9]|$)/.test(dbName)
  const productionName = dbName.includes('prod')
  if (!localHost || !testToken || productionName) {
    throw new StageError(`[ENV] GRANTS_PG stage 0: SAFETY REFUSAL — host "${host}", database "${dbName}": this script only runs against a localhost database whose name marks it as a test database and never against a production-named one.`)
  }
  return rawUrl
}

async function resolveDatabaseUrl(): Promise<string> {
  if (ENV_URL) {
    console.log('[STAGE 0] Using GRANTS_PG_TEST_DATABASE_URL from the environment')
    return assertSafeDatabaseUrl(ENV_URL)
  }
  console.log(`[STAGE 0] Starting disposable docker postgres:16 as ${DOCKER_CONTAINER} on port 55434`)
  await runCommand('docker', ['rm', '-f', DOCKER_CONTAINER])
  const run = await runCommand('docker', [
    'run', '-d', '--name', DOCKER_CONTAINER,
    '-e', 'POSTGRES_USER=grants_test',
    '-e', 'POSTGRES_PASSWORD=grants_test_only',
    '-e', 'POSTGRES_DB=academy_grants_test',
    '-p', '55434:5432',
    'postgres:16',
  ])
  if (run.code !== 0) {
    throw new StageError(`[ENV] GRANTS_PG stage 0: docker could not start the test PostgreSQL (exit ${run.code}).\n${outputTail(run.stderr || run.stdout)}`)
  }
  startedContainer = true
  const deadline = Date.now() + PG_READY_DEADLINE_MS
  for (;;) {
    const probe = await runCommand('docker', ['exec', DOCKER_CONTAINER, 'pg_isready', '-U', 'grants_test', '-d', 'academy_grants_test'])
    if (probe.code === 0) break
    if (Date.now() > deadline) throw new StageError('[ENV] GRANTS_PG stage 0: PostgreSQL did not become ready in time')
    await sleep(1000)
  }
  return DOCKER_URL
}

// The reservation transaction, mirroring reserveGrantOperation in
// src/app/api/admin/payments/waivers/route.ts statement for statement:
// lock the student row, lock the definition row, re-check the
// one-scholarship hold, count occupied seats, insert the operation.
async function reservePattern(db: any, args: { userId: string; definitionId: string; programId: string; seats: number; holdMs?: number }) {
  return db.$transaction(async (tx: any) => {
    const userRows = await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${args.userId} FOR UPDATE`
    if (userRows.length !== 1) throw new Error('USER_LOCK_MISS')
    const policyRows = await tx.$queryRaw`SELECT id FROM "ScholarshipDefinition" WHERE id = ${args.definitionId} FOR UPDATE`
    if (policyRows.length !== 1) throw new Error('DEFINITION_LOCK_MISS')
    const existing = await tx.scholarshipGrantOperation.findFirst({
      where: { userId: args.userId, status: { in: ['ISSUING', 'ISSUED', 'APPROVED', 'INCOMPLETE'] } },
      select: { id: true },
    })
    if (existing) throw new Error('ALREADY_RESERVED')
    const occupied = await tx.scholarshipGrantOperation.count({
      where: { definitionId: args.definitionId, programId: args.programId, status: { in: ['ISSUING', 'ISSUED', 'APPROVED', 'INCOMPLETE'] } },
    })
    if (occupied >= args.seats) throw new Error('GRANT_FULL')
    if (args.holdMs) await sleep(args.holdMs)
    return tx.scholarshipGrantOperation.create({
      data: {
        definitionId: args.definitionId, userId: args.userId,
        admissionId: 'adm-' + args.userId, programId: args.programId,
        status: 'ISSUED', expectedCodes: 1, expectedCents: 5000,
      },
    })
  })
}

async function main() {
  const databaseUrl = await resolveDatabaseUrl()
  console.log('[STAGE 1] prisma db push --skip-generate against the throwaway database')
  const env = { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }
  const push = await runCommand('bunx', ['prisma', 'db', 'push', '--skip-generate'], env)
  if (push.code !== 0) {
    throw new StageError(`[ENV] GRANTS_PG stage 1: prisma db push failed (exit ${push.code}).\n${outputTail(push.stdout + '\n' + push.stderr, 40)}`)
  }
  process.env.DATABASE_URL = databaseUrl
  const { db } = await import('@/lib/db')
  dbRef = db
  const { releaseStaleGrantOperations } = await import('@/lib/scholarship-waitlist')

  await db.user.createMany({
    data: [
      { id: 'pg-g-user-a', email: 'a@grants.test', name: 'A', password: '<redacted>', role: 'STUDENT', status: 'ACTIVE' },
      { id: 'pg-g-user-b', email: 'b@grants.test', name: 'B', password: '<redacted>', role: 'STUDENT', status: 'ACTIVE' },
    ],
  })
  const definition = await db.scholarshipDefinition.create({
    data: {
      title: 'حملة سباق المقعد', scope: 'PROGRAM', coverage: 'TUITION',
      valueMode: 'PERCENT', value: 2500, reason: 'اختبار تنافس', active: true,
      programs: { create: [{ programId: 'pg-g-program', seats: 1 }] },
    },
  })

  // Scenario A: two different students race for the single seat.
  const raceA = await Promise.allSettled([
    reservePattern(db, { userId: 'pg-g-user-a', definitionId: definition.id, programId: 'pg-g-program', seats: 1, holdMs: 400 }),
    reservePattern(db, { userId: 'pg-g-user-b', definitionId: definition.id, programId: 'pg-g-program', seats: 1 }),
  ])
  const wonA = raceA.filter((r) => r.status === 'fulfilled')
  const lostA = raceA.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
  check('A: exactly one racer reserves the last seat', wonA.length === 1, `fulfilled=${wonA.length}`)
  check('A: the loser is refused with GRANT_FULL after waiting on the lock',
    lostA.length === 1 && String(lostA[0]?.reason?.message || '').includes('GRANT_FULL'),
    `rejected=${lostA.length} reason=${String(lostA[0]?.reason?.message || '')}`)
  const afterA = await db.scholarshipGrantOperation.count({ where: { definitionId: definition.id } })
  check('A: exactly one operation exists after the race', afterA === 1, `operations=${afterA}`)

  // Scenario B: a FRESH student with no reservation races himself — the
  // user lock serializes both attempts, exactly one wins and the second
  // sees the occupying operation it just created.
  await db.user.create({ data: { id: 'pg-g-user-d', email: 'd@grants.test', name: 'D', password: '<redacted>', role: 'STUDENT', status: 'ACTIVE' } })
  const raceB = await Promise.allSettled([
    reservePattern(db, { userId: 'pg-g-user-d', definitionId: definition.id, programId: 'pg-g-program', seats: 99, holdMs: 300 }),
    reservePattern(db, { userId: 'pg-g-user-d', definitionId: definition.id, programId: 'pg-g-program', seats: 99 }),
  ])
  const wonB = raceB.filter((r) => r.status === 'fulfilled')
  const rejectedB = raceB.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]
  check('B: a fresh student racing himself wins exactly once',
    wonB.length === 1 && rejectedB.length === 1 && String(rejectedB[0].reason?.message || '').includes('ALREADY_RESERVED'),
    `outcomes=${raceB.map((r) => r.status).join(',')}`)
  const afterB = await db.scholarshipGrantOperation.count({ where: { definitionId: definition.id, userId: 'pg-g-user-d' } })
  check('B: exactly one operation exists for the fresh student', afterB === 1, `operations=${afterB}`)

  // Scenario C: the shipped waitlist library closes a fully expired
  // reservation against the real schema and constraints.
  const staleUser = await db.user.create({ data: { email: 'c@grants.test', name: 'C', password: '<redacted>', role: 'STUDENT', status: 'ACTIVE' } })
  const staleOp = await db.scholarshipGrantOperation.create({
    data: {
      definitionId: definition.id, userId: staleUser.id, admissionId: 'adm-c',
      programId: 'pg-g-program-2', status: 'ISSUED', expectedCodes: 1, expectedCents: 5000,
    },
  })
  const payment = await db.payment.create({
    data: {
      userId: staleUser.id, purpose: 'TUITION', status: 'UNPAID', description: 'رسوم دراسية — اختبار تنافس',
      amount: 199.99, amountCents: 19999, invoiceNo: 'PG-GRANTS-INV-1',
    },
  })
  const code = await db.paymentWaiverCode.create({
    data: {
      paymentId: payment.id, codeHash: 'pg-grants-hash', codePreview: 'PG-GRANTS',
      waiverType: 'PARTIAL_TUITION', reason: 'اختبار تنافس', status: 'EXPIRED', expiresAt: new Date(Date.now() - 60_000),
    },
  })
  await db.scholarshipGrantLink.create({
    data: {
      definitionId: definition.id, operationId: staleOp.id, waiverCodeId: code.id,
      paymentId: payment.id, userId: staleUser.id, admissionId: 'adm-c',
      programId: 'pg-g-program-2', baseCents: 19999, grantCents: 5000,
    },
  })
  const released = await releaseStaleGrantOperations(db, {})
  const staleAfter = await db.scholarshipGrantOperation.findUnique({ where: { id: staleOp.id } })
  check('C: expiry release closes the stale operation on the real schema',
    released.some((op: any) => op.id === staleOp.id) && staleAfter?.status === 'CANCELLED',
    `released=${released.length} status=${staleAfter?.status}`)

  if (failures.length) {
    console.error(`\nGRANTS_PG: ${failures.length} assertion(s) failed`)
    process.exitCode = 1
  } else {
    console.log('\nGRANTS_PG: all assertions passed')
  }
}

main()
  .catch((error) => {
    if (error instanceof StageError) {
      console.error(error.message)
      process.exitCode = error.exitCode
    } else {
      console.error('GRANTS_PG unexpected failure:', error)
      process.exitCode = 1
    }
  })
  .finally(async () => {
    try { await dbRef?.$disconnect() } catch (e) { void e }
    if (startedContainer) await runCommand('docker', ['rm', '-f', DOCKER_CONTAINER])
  })
