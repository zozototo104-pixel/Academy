/**
 * اختبار تنافس حقيقي على PostgreSQL لاعتماد الإعفاءات المالية (PR #188).
 *
 * ماذا يثبت: اعتمادا إعفاء متزامنان لا يفسدان حالة المال أبداً — لا فاتورة
 * دراسية مكررة، لا رقما فاتورة متطابقان، لا أثر مالي مضاعف. السباق الحقيقي
 * هنا على قيد تفرد invoiceNo: كلا الاعتمادين يحسب الرقم المرشح نفسه من
 * خارج المعاملة، فيصطدم إدخال الخاسر بـ P2002 داخل معاملته.
 *
 * لماذا لا تكفي الاختبارات الوهمية (tests/payments): القاعدة الوهمية لا
 * تحاكي سلوك PostgreSQL الحقيقي — فبمجرد فشل أي عبارة داخل معاملة حقيقية
 * تصبح المعاملة ملغاة وترمي العبارات التالية 25P02. الإصلاح المعتمد يعيد
 * تنفيذ معاملة الاعتماد كاملة من الصفر عند P2002 ولا يعيد الإدخال داخل
 * المعاملة نفسها أبداً؛ وهذا الشكل وحده هو ما يثبته هذا السكربت فعلياً.
 *
 * ملاحظة عدم العبث (anti-vacuity): ضد الشكل السابق للإصلاح (إعادة محاولة
 * الإدخال داخل المعاملة نفسها) يفشل السيناريو A هنا: معاملة الخاسر الملغاة
 * ترمي 25P02 فيهرب الاعتماد كرفض ظاهر بدل أن ينجح بإعادة تنفيذ كاملة.
 *
 * السيناريو C (أضافه فحص مستقل لاحقاً): إعفاءان مختلفان على طلب القبول
 * نفسه — فاتورتا تقديم مفتوحتان، على كل واحدة كود محقق، واعتمادان
 * متزامنان. الاعتماد يقفل صف فاتورته هو فقط، فلا قفل مشترك بينهما،
 * وكلاهما يستدعي إنشاء فاتورة الدراسة عند غيابها داخل معاملته: الخطر
 * فاتورتا دراسة لطالب واحد. الإثبات من حالة القاعدة: فاتورة دراسة
 * واحدة فقط، معفاة بالكامل مرة واحدة، والتحاق واحد.
 *
 * Real-PostgreSQL concurrency proof for payment-waiver approval (PR #188):
 * two simultaneous approvals racing the invoiceNo unique index must both
 * land exactly once. The mocked suites cannot model a real PG transaction
 * aborting (25P02), so this script runs the real approvePaymentWaiver
 * against a throwaway PostgreSQL it prepares itself.
 *
 * Environment:
 *   WAIVER_PG_TEST_DATABASE_URL — optional. When set, that database is used
 *     (after the safety check below). Otherwise a disposable docker
 *     postgres:16 container is started on port 55433 and removed at exit.
 *   Safety: the script REFUSES to run unless the host is localhost OR the
 *     database name contains "test"/"ci" — it can never touch production.
 *
 * Schema prep mirrors the deployed truth: `prisma db push` (same precedent
 * as the backup-restore CI job) plus the payment_receipt_no_seq sequence,
 * which lives only in migration 20261003121500_receipt_sequence and is not
 * part of the Prisma schema — finalize's receipt step needs it.
 *
 * Exit codes: 0 = every assertion passed · 1 = an assertion failed ·
 * 2 = environment could not be prepared (docker/db push/import/sequence).
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

const ENV_URL = process.env.WAIVER_PG_TEST_DATABASE_URL || ''
const DOCKER_CONTAINER = `aact-waiver-pg-${process.pid}`
const DOCKER_URL = 'postgresql://waiver_test:waiver_test_only@localhost:55433/academy_waiver_test'
const PG_READY_DEADLINE_MS = 90_000

const ADMIN_ID = 'pgw-admin'
const ADMIN_NAME = 'PG Test Admin'
const PROGRAM_ID = 'pgw-program'
// Fixture values mirrored from tests/payments/payment-settlement.test.ts
// (fee-branch test): fee 30$ UNPAID + VERIFIED PARTIAL_TUITION waiver of
// 380$ over it. Tuition total is 350$ — mocked suite reaches 35000 cents
// via the FEE_DIPLOMAS_MAX settings fallback; here the real Program row
// carries price=350 so resolveAdmissionTuitionCents returns the same
// 35000 from the program itself. Expected: fee WAIVED (3000 waived),
// tuition invoice created WAIVED with waivedAmountCents 35000, due 0.
const FEE_AMOUNT_CENTS = 3_000
const WAIVER_REQUESTED_CENTS = 38_000
const TUITION_TOTAL_CENTS = 35_000

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

// A rejection carrying any of these means the collision escaped the
// whole-transaction retry — the exact failure this script exists to catch.
function isCollisionShaped(error: any): boolean {
  const text = `${error?.code || ''} ${error?.message || ''}`
  return /P2002|25P02|WAIVER_SETTLEMENT_RETRY_EXHAUSTED|current transaction is aborted/i.test(text)
}

function isAlreadyApprovedShaped(error: any): boolean {
  return /تم اعتماد هذا الكود مسبقاً|تغيرت حالته أثناء المعالجة/.test(String(error?.message || ''))
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

// The script must be incapable of running against production: whatever the
// URL source, refuse unless the host is local OR the database name itself
// is marked test/ci.
function assertSafeDatabaseUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new StageError(`[ENV] WAIVER_PG stage 0: database URL is not parseable — refusing to continue`)
  }
  const host = parsed.hostname.toLowerCase()
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase()
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  const markedDb = dbName.includes('test') || dbName.includes('ci')
  if (!localHost && !markedDb) {
    throw new StageError(
      `[ENV] WAIVER_PG stage 0: SAFETY REFUSAL — host "${host}" is not localhost and database "${dbName}" contains neither "test" nor "ci". This script never runs against a production-shaped target.`,
    )
  }
  return rawUrl
}

async function resolveDatabaseUrl(): Promise<string> {
  if (ENV_URL) {
    console.log('[STAGE 0] Using WAIVER_PG_TEST_DATABASE_URL from the environment')
    return assertSafeDatabaseUrl(ENV_URL)
  }
  console.log(`[STAGE 0] Starting disposable docker postgres:16 as ${DOCKER_CONTAINER} on port 55433`)
  await runCommand('docker', ['rm', '-f', DOCKER_CONTAINER]) // stale same-pid leftover, if any
  const run = await runCommand('docker', [
    'run', '-d', '--name', DOCKER_CONTAINER,
    '-e', 'POSTGRES_USER=waiver_test',
    '-e', 'POSTGRES_PASSWORD=waiver_test_only',
    '-e', 'POSTGRES_DB=academy_waiver_test',
    '-p', '55433:5432',
    'postgres:16',
  ])
  if (run.code !== 0) {
    throw new StageError(
      `[ENV] WAIVER_PG stage 0: docker could not start the test PostgreSQL (exit ${run.code}). ` +
      `Docker is required when WAIVER_PG_TEST_DATABASE_URL is unset.\n${outputTail(run.stderr || run.stdout)}`,
    )
  }
  startedContainer = true
  const deadline = Date.now() + PG_READY_DEADLINE_MS
  let ready = false
  while (Date.now() < deadline) {
    const probe = await runCommand('docker', ['exec', DOCKER_CONTAINER, 'pg_isready', '-U', 'waiver_test', '-d', 'academy_waiver_test'])
    if (probe.code === 0) { ready = true; break }
    await sleep(1500)
  }
  if (!ready) {
    throw new StageError(`[ENV] WAIVER_PG stage 0: PostgreSQL never became ready within ${PG_READY_DEADLINE_MS / 1000}s`)
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
      `[ENV] WAIVER_PG stage 1: prisma db push failed (exit ${push.code}).\n${outputTail(push.stdout + '\n' + push.stderr, 40)}`,
    )
  }
  console.log('[STAGE 1] Schema pushed')
}

async function importAppModules(databaseUrl: string) {
  // src/lib/db reads the connection env at import time — set it BEFORE the
  // first app import, and import dynamically for exactly that reason.
  process.env.DATABASE_URL = databaseUrl
  process.env.DIRECT_URL = databaseUrl
  console.log('[STAGE 2] Importing app modules against the test database')
  let db: any
  let approvePaymentWaiver: any
  try {
    ;({ db } = await import('@/lib/db'))
    ;({ approvePaymentWaiver } = await import('@/lib/payment-waivers'))
  } catch (error) {
    throw new StageError(`[ENV] WAIVER_PG stage 2: app module import failed — ${describeError(error)}`)
  }
  dbRef = db
  // The receipt sequence exists only in migration
  // 20261003121500_receipt_sequence; db push does not create it, and the
  // finalize tail calls nextReceiptNo() unguarded. Recreate it here so the
  // prepared environment matches the deployed schema.
  try {
    await db.$executeRawUnsafe('CREATE SEQUENCE IF NOT EXISTS payment_receipt_no_seq')
  } catch (error) {
    throw new StageError(`[ENV] WAIVER_PG stage 2: could not create payment_receipt_no_seq — ${describeError(error)}`)
  }
  console.log('[STAGE 2] Modules imported; receipt sequence present')
  return { db, approvePaymentWaiver }
}

async function seedShared(db: any) {
  await db.user.create({
    data: { id: ADMIN_ID, email: 'pgw-admin@example.test', password: 'pg-test-only', name: ADMIN_NAME, role: 'ADMIN' },
  })
  await db.program.create({
    data: {
      id: PROGRAM_ID,
      slug: 'pgw-program',
      titleAr: 'دبلوم تجريبي',
      titleEn: 'PG Test Diploma',
      description: 'برنامج اختبار تنافس PostgreSQL',
      category: 'DIPLOMA',
      price: 350,
      semestersCount: 2,
      maxStudyDays: 90,
    },
  })
}

// One student + admission (AWAITING_TUITION, approved) + UNPAID
// APPLICATION_FEE payment + VERIFIED PARTIAL_TUITION waiver — the exact
// fixture shape of the mocked fee-branch approval test, with the extra
// schema-required fields the real database demands (User.password,
// AdmissionApplication.phone/education/reference uniqueness, codeHash).
async function seedFeeWaiverStudent(db: any, tag: string) {
  const studentId = `pgw-${tag}-student`
  const admissionId = `pgw-${tag}-admission`
  const feeId = `pgw-${tag}-fee`
  const waiverId = `pgw-${tag}-waiver`
  const email = `pgw-${tag}@example.test`
  await db.user.create({
    data: { id: studentId, email, password: 'pg-test-only', name: `Student ${tag}`, role: 'STUDENT' },
  })
  await db.admissionApplication.create({
    data: {
      id: admissionId,
      reference: `PGW-${tag.toUpperCase()}`,
      fullName: `Student ${tag}`,
      email,
      phone: '+970000000000',
      country: 'PS',
      education: 'BACHELOR',
      program: 'دبلوم تجريبي',
      programId: PROGRAM_ID,
      status: 'AWAITING_TUITION',
      userId: studentId,
      supervisorId: null,
      approvedAt: new Date(),
      scholarshipFull: false,
    },
  })
  await db.payment.create({
    data: {
      id: feeId,
      invoiceNo: `PGW-FEE-${tag.toUpperCase()}`,
      admissionId,
      userId: studentId,
      status: 'UNPAID',
      purpose: 'APPLICATION_FEE',
      description: 'رسوم تقديم',
      amount: 30,
      amountCents: FEE_AMOUNT_CENTS,
      payerName: `Student ${tag}`,
      payerEmail: email,
      payerCountry: 'PS',
    },
  })
  await db.paymentWaiverCode.create({
    data: {
      id: waiverId,
      paymentId: feeId,
      codeHash: createHash('sha256').update(`PGW-CODE-${tag}`).digest('hex'),
      codePreview: '••••-PG01',
      waiverType: 'PARTIAL_TUITION',
      requestedAmount: WAIVER_REQUESTED_CENTS / 100,
      requestedAmountCents: WAIVER_REQUESTED_CENTS,
      reason: 'إعفاء يغطي التقديم والدراسة',
      status: 'VERIFIED',
      verifiedById: studentId,
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  return { studentId, admissionId, feeId, waiverId, email }
}

// Scenario C fixture: ONE admission carrying TWO open APPLICATION_FEE
// payments, each with its own VERIFIED waiver code — a partial-tuition
// waiver on the first fee (the Scenario A shape) and a plain fee waiver
// on the second. Both approvals enter the fee branch and both call the
// tuition-invoice ensure for the same admission, while each approval
// locks only its OWN payment row.
async function seedDualWaiverStudent(db: any, tag: string) {
  const studentId = `pgw-${tag}-student`
  const admissionId = `pgw-${tag}-admission`
  const email = `pgw-${tag}@example.test`
  await db.user.create({
    data: { id: studentId, email, password: 'pg-test-only', name: `Student ${tag}`, role: 'STUDENT' },
  })
  await db.admissionApplication.create({
    data: {
      id: admissionId,
      reference: `PGW-${tag.toUpperCase()}`,
      fullName: `Student ${tag}`,
      email,
      phone: '+970000000000',
      country: 'PS',
      education: 'BACHELOR',
      program: 'دبلوم تجريبي',
      programId: PROGRAM_ID,
      status: 'AWAITING_TUITION',
      userId: studentId,
      supervisorId: null,
      approvedAt: new Date(),
      scholarshipFull: false,
    },
  })
  const mkFee = async (suffix: string) => {
    const feeId = `pgw-${tag}-fee${suffix}`
    await db.payment.create({
      data: {
        id: feeId,
        invoiceNo: `PGW-FEE${suffix}-${tag.toUpperCase()}`,
        admissionId,
        userId: studentId,
        status: 'UNPAID',
        purpose: 'APPLICATION_FEE',
        description: 'رسوم تقديم',
        amount: 30,
        amountCents: FEE_AMOUNT_CENTS,
        payerName: `Student ${tag}`,
        payerEmail: email,
        payerCountry: 'PS',
      },
    })
    return feeId
  }
  const fee1Id = await mkFee('1')
  const fee2Id = await mkFee('2')
  await db.paymentWaiverCode.create({
    data: {
      id: `pgw-${tag}-waiver1`,
      paymentId: fee1Id,
      codeHash: createHash('sha256').update(`PGW-CODE-${tag}-1`).digest('hex'),
      codePreview: '••••-PG01',
      waiverType: 'PARTIAL_TUITION',
      requestedAmount: WAIVER_REQUESTED_CENTS / 100,
      requestedAmountCents: WAIVER_REQUESTED_CENTS,
      reason: 'إعفاء يغطي التقديم والدراسة',
      status: 'VERIFIED',
      verifiedById: studentId,
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  await db.paymentWaiverCode.create({
    data: {
      id: `pgw-${tag}-waiver2`,
      paymentId: fee2Id,
      codeHash: createHash('sha256').update(`PGW-CODE-${tag}-2`).digest('hex'),
      codePreview: '••••-PG02',
      waiverType: 'APPLICATION_FEE',
      requestedAmount: null,
      requestedAmountCents: null,
      reason: 'إعفاء رسوم تقديم',
      status: 'VERIFIED',
      verifiedById: studentId,
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  })
  return { studentId, admissionId, fee1Id, fee2Id, waiver1Id: `pgw-${tag}-waiver1`, waiver2Id: `pgw-${tag}-waiver2` }
}

function reportRejection(scope: string, error: any) {
  const kind = isCollisionShaped(error)
    ? 'COLLISION ESCAPED the whole-transaction retry'
    : 'non-collision rejection (post-commit finalize tail or other — money state is judged by the DB assertions below)'
  check(`${scope}: approval fulfilled`, false, `${kind} — ${describeError(error)}`)
}

async function scenarioA(db: any, approvePaymentWaiver: any, round: number) {
  const scope = `Scenario A round ${round} (invoice-number race)`
  const s1 = await seedFeeWaiverStudent(db, `r${round}a`)
  const s2 = await seedFeeWaiverStudent(db, `r${round}b`)
  const actor = { id: ADMIN_ID, name: ADMIN_NAME }
  const results = await Promise.allSettled([
    approvePaymentWaiver({ waiverId: s1.waiverId, actor }),
    approvePaymentWaiver({ waiverId: s2.waiverId, actor }),
  ])
  results.forEach((result, i) => {
    if (result.status === 'rejected') reportRejection(`${scope} approval #${i + 1}`, result.reason)
  })
  check(`${scope}: both approvals fulfilled`, results.every((r) => r.status === 'fulfilled'),
    `outcomes=[${results.map((r) => r.status).join(', ')}]`)

  const tuitionInvoiceNos: string[] = []
  for (const [label, s] of [['student 1', s1], ['student 2', s2]] as const) {
    const code = await db.paymentWaiverCode.findUnique({ where: { id: s.waiverId } })
    check(`${scope}: ${label} waiver code APPROVED`, code?.status === 'APPROVED', `status=${code?.status}`)
    const fee = await db.payment.findUnique({ where: { id: s.feeId } })
    check(`${scope}: ${label} fee payment WAIVED`, fee?.status === 'WAIVED',
      `status=${fee?.status} waivedAmountCents=${fee?.waivedAmountCents} waiverStatus=${fee?.waiverStatus}`)
    check(`${scope}: ${label} fee waived exactly the fee amount`, fee?.waivedAmountCents === FEE_AMOUNT_CENTS,
      `waivedAmountCents=${fee?.waivedAmountCents} expected=${FEE_AMOUNT_CENTS}`)
    const tuitions = await db.payment.findMany({ where: { admissionId: s.admissionId, purpose: 'TUITION' } })
    check(`${scope}: ${label} exactly ONE tuition invoice`, tuitions.length === 1, `count=${tuitions.length}`)
    const tuition = tuitions[0]
    if (tuition) {
      tuitionInvoiceNos.push(tuition.invoiceNo)
      check(`${scope}: ${label} tuition WAIVED with full credit`, tuition.status === 'WAIVED' && tuition.amountCents === 0,
        `invoiceNo=${tuition.invoiceNo} status=${tuition.status} amountCents=${tuition.amountCents}`)
      check(`${scope}: ${label} tuition waivedAmountCents = full tuition`, tuition.waivedAmountCents === TUITION_TOTAL_CENTS,
        `waivedAmountCents=${tuition.waivedAmountCents} expected=${TUITION_TOTAL_CENTS} originalAmountCents=${tuition.originalAmountCents}`)
    }
    const admission = await db.admissionApplication.findUnique({ where: { id: s.admissionId } })
    check(`${scope}: ${label} admission finalized`, admission?.status === 'SUPERVISOR_ASSIGNED', `status=${admission?.status}`)
    const enrollmentCount = await db.enrollment.count({ where: { userId: s.studentId, programId: PROGRAM_ID } })
    check(`${scope}: ${label} exactly one enrollment`, enrollmentCount === 1, `count=${enrollmentCount}`)
  }
  if (tuitionInvoiceNos.length === 2) {
    check(`${scope}: tuition invoice numbers DISTINCT`, tuitionInvoiceNos[0] !== tuitionInvoiceNos[1],
      `invoiceNos=[${tuitionInvoiceNos.join(', ')}]`)
  }
  console.log(`[EVIDENCE] ${scope}: tuitionInvoiceNos=[${tuitionInvoiceNos.join(', ')}]`)
}

async function scenarioB(db: any, approvePaymentWaiver: any) {
  const scope = 'Scenario B (same-waiver double approval)'
  const s = await seedFeeWaiverStudent(db, 'sb')
  const actor = { id: ADMIN_ID, name: ADMIN_NAME }
  const results = await Promise.allSettled([
    approvePaymentWaiver({ waiverId: s.waiverId, actor }),
    approvePaymentWaiver({ waiverId: s.waiverId, actor }),
  ])
  const outcomeSummary = results.map((r) => (r.status === 'fulfilled' ? 'fulfilled' : `rejected: ${describeError(r.reason)}`))
  console.log(`[EVIDENCE] ${scope}: outcomes=[${outcomeSummary.join(' | ')}]`)
  for (const result of results) {
    if (result.status !== 'rejected') continue
    check(`${scope}: no raw P2002/25P02 crash from the loser`, !isCollisionShaped(result.reason),
      describeError(result.reason))
    check(`${scope}: loser rejection is the already-approved refusal (or the call fulfilled idempotently)`,
      isAlreadyApprovedShaped(result.reason), describeError(result.reason))
  }
  const code = await db.paymentWaiverCode.findUnique({ where: { id: s.waiverId } })
  check(`${scope}: waiver code APPROVED exactly once`, code?.status === 'APPROVED' && !!code?.approvedAt,
    `status=${code?.status} approvedAt=${code?.approvedAt?.toISOString?.() || code?.approvedAt}`)
  const tuitions = await db.payment.findMany({ where: { admissionId: s.admissionId, purpose: 'TUITION' } })
  check(`${scope}: exactly ONE tuition invoice`, tuitions.length === 1,
    `count=${tuitions.length} invoiceNos=[${tuitions.map((t: any) => t.invoiceNo).join(', ')}]`)
  if (tuitions[0]) {
    check(`${scope}: tuition waived exactly once`, tuitions[0].waivedAmountCents === TUITION_TOTAL_CENTS && tuitions[0].status === 'WAIVED',
      `waivedAmountCents=${tuitions[0].waivedAmountCents} expected=${TUITION_TOTAL_CENTS} status=${tuitions[0].status}`)
  }
  const fee = await db.payment.findUnique({ where: { id: s.feeId } })
  check(`${scope}: fee waivedAmountCents is the single-approval value, not doubled`,
    fee?.waivedAmountCents === FEE_AMOUNT_CENTS,
    `waivedAmountCents=${fee?.waivedAmountCents} expected=${FEE_AMOUNT_CENTS} (doubled would be ${FEE_AMOUNT_CENTS * 2})`)
  const enrollmentCount = await db.enrollment.count({ where: { userId: s.studentId, programId: PROGRAM_ID } })
  check(`${scope}: exactly ONE enrollment for (userId, programId)`, enrollmentCount === 1, `count=${enrollmentCount}`)
  const admission = await db.admissionApplication.findUnique({ where: { id: s.admissionId } })
  check(`${scope}: admission finalized once`, admission?.status === 'SUPERVISOR_ASSIGNED', `status=${admission?.status}`)
}

async function scenarioC(db: any, approvePaymentWaiver: any) {
  const scope = 'Scenario C (two different waivers, same admission)'
  const s = await seedDualWaiverStudent(db, 'sc')
  const actor = { id: ADMIN_ID, name: ADMIN_NAME }
  const results = await Promise.allSettled([
    approvePaymentWaiver({ waiverId: s.waiver1Id, actor }),
    approvePaymentWaiver({ waiverId: s.waiver2Id, actor }),
  ])
  const outcomeSummary = results.map((r) => (r.status === 'fulfilled' ? 'fulfilled' : `rejected: ${describeError(r.reason)}`))
  console.log(`[EVIDENCE] ${scope}: outcomes=[${outcomeSummary.join(' | ')}]`)
  check(`${scope}: at least one approval fulfilled`, results.some((r) => r.status === 'fulfilled'),
    `outcomes=[${results.map((r) => r.status).join(', ')}]`)
  for (const [label, waiverId] of [['waiver 1 (partial tuition)', s.waiver1Id], ['waiver 2 (fee)', s.waiver2Id]] as const) {
    const code = await db.paymentWaiverCode.findUnique({ where: { id: waiverId } })
    check(`${scope}: ${label} code APPROVED`, code?.status === 'APPROVED', `status=${code?.status}`)
  }
  for (const [label, feeId] of [['fee 1', s.fee1Id], ['fee 2', s.fee2Id]] as const) {
    const fee = await db.payment.findUnique({ where: { id: feeId } })
    check(`${scope}: ${label} WAIVED exactly its own amount`, fee?.status === 'WAIVED' && fee?.waivedAmountCents === FEE_AMOUNT_CENTS,
      `status=${fee?.status} waivedAmountCents=${fee?.waivedAmountCents} expected=${FEE_AMOUNT_CENTS}`)
  }
  // The assertion this scenario exists for: two approvals that each lock
  // only their own payment row must NOT both create the admission's
  // tuition invoice.
  const tuitions = await db.payment.findMany({ where: { admissionId: s.admissionId, purpose: 'TUITION' } })
  check(`${scope}: exactly ONE tuition invoice for the admission`, tuitions.length === 1,
    `count=${tuitions.length} invoiceNos=[${tuitions.map((t: any) => t.invoiceNo).join(', ')}]`)
  if (tuitions[0]) {
    check(`${scope}: the single tuition invoice is fully waived exactly once`,
      tuitions[0].status === 'WAIVED' && tuitions[0].amountCents === 0 && tuitions[0].waivedAmountCents === TUITION_TOTAL_CENTS,
      `status=${tuitions[0].status} amountCents=${tuitions[0].amountCents} waivedAmountCents=${tuitions[0].waivedAmountCents} expected waived=${TUITION_TOTAL_CENTS}`)
  }
  const enrollmentCount = await db.enrollment.count({ where: { userId: s.studentId, programId: PROGRAM_ID } })
  check(`${scope}: exactly ONE enrollment`, enrollmentCount === 1, `count=${enrollmentCount}`)
  const admission = await db.admissionApplication.findUnique({ where: { id: s.admissionId } })
  check(`${scope}: admission finalized`, admission?.status === 'SUPERVISOR_ASSIGNED', `status=${admission?.status}`)
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
  const { db, approvePaymentWaiver } = await importAppModules(databaseUrl)
  console.log('[STAGE 3] Seeding fixtures and running concurrency scenarios')
  await seedShared(db)
  await scenarioA(db, approvePaymentWaiver, 1)
  await scenarioA(db, approvePaymentWaiver, 2)
  await scenarioB(db, approvePaymentWaiver)
  await scenarioC(db, approvePaymentWaiver)
  if (failures.length) {
    console.error(`\nWAIVER_PG_CONCURRENCY: FAILED — ${failures.length} assertion(s) failed`)
    return 1
  }
  console.log('\nWAIVER_PG_CONCURRENCY: ALL ASSERTIONS PASSED')
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
    // Anything thrown from seeding/scenarios onward is a failed run, never a
    // pass: report it as an assertion-level failure with full detail.
    console.error(`[FAIL] WAIVER_PG unexpected error during scenarios — ${describeError(error)}`)
    await cleanup()
    process.exit(1)
  })
