/**
 * اختبار تنفيذ حقيقي على PostgreSQL لدليل دراسة فحص الجاهزية.
 *
 * لماذا وُجد: بوابة #703 سقطت لأن upsert استخدم مفتاح programId_semester
 * غير الموجود كقيد فريد، وبوابة #704 سقطت لأن قفل pg_advisory_xact_lock
 * مُرّر رقمه كمعامل مربوط فصار bigint ورفضه PostgreSQL (42883: لا يوجد
 * توقيع (bigint, integer)). الاختبارات الوهمية لا ترى أيّاً من هذا —
 * هذا السكربت يستدعي الدالة الحقيقية ensureLaunchQualityStudyGuide من
 * مكتبة المنتج نفسها على قاعدة حقيقية، فيثبت:
 *  A) أول استدعاء ينشئ دليلاً عاماً واحداً (unitId: null) بالحقول الصحيحة.
 *  B) إعادة التشغيل تحدّث الدليل نفسه — العدد لا يزيد والمعرف لا يتغير.
 *  C) استدعاءان متزامنان على برنامج جديد: دليل عام واحد فقط — القفل
 *     الاستشاري يُسلسلهما فعلياً على PostgreSQL (وهنا يُنفَّذ SQL القفل
 *     نفسه، فأي خطأ توقيع يظهر فوراً).
 *  D) دليل وحدة (unitId مضبوط) لنفس البرنامج والفصل لا يُلمس أبداً.
 *
 * Environment:
 *   LAUNCH_QUALITY_PG_TEST_DATABASE_URL — optional. Otherwise a disposable
 *     docker postgres:16 container is started on port 55437 and removed.
 *   Safety: refuses to run unless the host is localhost AND the database
 *     name carries "test" as a whole token AND no "prod" marker.
 *
 * Exit codes: 0 = every assertion passed · 1 = an assertion failed ·
 * 2 = environment could not be prepared.
 */
import { spawn } from 'node:child_process'

const ENV_URL = process.env.LAUNCH_QUALITY_PG_TEST_DATABASE_URL || ''
const DOCKER_CONTAINER = `aact-lq-guide-pg-${process.pid}`
const DOCKER_URL = 'postgresql://guide_test:guide_test_only@localhost:55437/academy_launch_quality_test'
const PG_READY_DEADLINE_MS = 90_000

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
  if (ok) console.log(`[PASS] ${label} — ${evidence}`)
  else {
    console.error(`[FAIL] ${label} — ${evidence}`)
    console.log(`::error title=LQ_GUIDE_PG_FAIL::${label} — ${evidence}`.replace(/[%]/g, '%25').replace(/[\r\n]/g, ' '))
    failures.push(label)
  }
}

function runCommand(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
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
    throw new StageError('[ENV] LQ_GUIDE stage 0: database URL is not parseable — refusing to continue')
  }
  const host = parsed.hostname.toLowerCase()
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase()
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  const testToken = /(^|[^a-z0-9])test([^a-z0-9]|$)/.test(dbName)
  const productionName = dbName.includes('prod')
  if (!localHost || !testToken || productionName) {
    throw new StageError(`[ENV] LQ_GUIDE stage 0: SAFETY REFUSAL — host "${host}", database "${dbName}": this script only runs against a localhost database whose name marks it as a test database and never against a production-named one.`)
  }
  return rawUrl
}

async function resolveDatabaseUrl(): Promise<string> {
  if (ENV_URL) {
    console.log('[STAGE 0] Using LAUNCH_QUALITY_PG_TEST_DATABASE_URL from the environment')
    return assertSafeDatabaseUrl(ENV_URL)
  }
  console.log(`[STAGE 0] Starting disposable docker postgres:16 as ${DOCKER_CONTAINER} on port 55437`)
  await runCommand('docker', ['rm', '-f', DOCKER_CONTAINER])
  const run = await runCommand('docker', [
    'run', '-d', '--name', DOCKER_CONTAINER,
    '-e', 'POSTGRES_USER=guide_test',
    '-e', 'POSTGRES_PASSWORD=guide_test_only',
    '-e', 'POSTGRES_DB=academy_launch_quality_test',
    '-p', '55437:5432',
    'postgres:16',
  ])
  if (run.code !== 0) {
    throw new StageError(`[ENV] LQ_GUIDE stage 0: docker could not start the test PostgreSQL (exit ${run.code}).\n${outputTail(run.stderr || run.stdout)}`)
  }
  startedContainer = true
  const deadline = Date.now() + PG_READY_DEADLINE_MS
  for (;;) {
    const probe = await runCommand('docker', ['exec', DOCKER_CONTAINER, 'pg_isready', '-U', 'guide_test', '-d', 'academy_launch_quality_test'])
    if (probe.code === 0) break
    if (Date.now() > deadline) throw new StageError('[ENV] LQ_GUIDE stage 0: PostgreSQL did not become ready in time')
    await sleep(1000)
  }
  return DOCKER_URL
}

async function main() {
  const databaseUrl = await resolveDatabaseUrl()
  console.log('[STAGE 1] prisma db push --skip-generate against the throwaway database')
  const env = { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }
  const push = await runCommand('bunx', ['prisma', 'db', 'push', '--skip-generate'], env)
  if (push.code !== 0) {
    throw new StageError(`[ENV] LQ_GUIDE stage 1: prisma db push failed (exit ${push.code}).\n${outputTail(push.stdout + '\n' + push.stderr, 40)}`)
  }
  process.env.DATABASE_URL = databaseUrl
  process.env.DIRECT_URL = databaseUrl
  const { db } = await import('@/lib/db')
  dbRef = db
  const { ensureLaunchQualityStudyGuide } = await import('@/lib/launch-quality-study-guide')

  const programA = await db.program.create({
    data: { slug: 'lq-guide-pg-a', titleAr: 'برنامج اختبار الدليل أ', description: 'اختبار حقيقي', category: 'DIPLOMA' },
  })
  const programB = await db.program.create({
    data: { slug: 'lq-guide-pg-b', titleAr: 'برنامج اختبار الدليل ب', description: 'اختبار حقيقي', category: 'DIPLOMA' },
  })
  const generalOf = (programId: string) =>
    db.programStudyGuide.findMany({ where: { programId, semester: 1, unitId: null }, orderBy: { createdAt: 'asc' } })

  console.log('[STAGE 2] A: first call creates exactly one general guide')
  const first = await ensureLaunchQualityStudyGuide(programA.id)
  let rows = await generalOf(programA.id)
  check('A1: exactly one general guide after first call', rows.length === 1, `count=${rows.length}`)
  check(
    'A2: guide carries the diagnostic fields',
    first.status === 'PUBLISHED' && String(first.title).includes('دليل دراسة الفصل الأول') && first.generatedBy === 'ADMIN' && first.unitId === null,
    `status=${first.status} generatedBy=${first.generatedBy} unitId=${first.unitId}`,
  )

  console.log('[STAGE 3] B: re-runs update the same guide, never duplicate')
  const second = await ensureLaunchQualityStudyGuide(programA.id)
  const third = await ensureLaunchQualityStudyGuide(programA.id)
  rows = await generalOf(programA.id)
  check('B1: count still 1 after two re-runs', rows.length === 1, `count=${rows.length}`)
  check('B2: same guide id across runs', second.id === first.id && third.id === first.id, `ids ${first.id}/${second.id}/${third.id}`)

  console.log('[STAGE 4] C: two concurrent calls on a fresh program — the advisory lock serializes them')
  const [c1, c2] = await Promise.all([ensureLaunchQualityStudyGuide(programB.id), ensureLaunchQualityStudyGuide(programB.id)])
  const rowsB = await generalOf(programB.id)
  check('C1: exactly one general guide after concurrent calls', rowsB.length === 1, `count=${rowsB.length}`)
  check('C2: both calls returned the same guide', c1.id === c2.id, `ids ${c1.id}/${c2.id}`)

  console.log('[STAGE 5] D: a unit guide for the same program+semester is never touched')
  const unit = await db.unit.create({
    data: { programId: programA.id, title: 'وحدة اختبار', order: 99, semester: 1, status: 'APPROVED', content: '[]' },
  })
  const unitGuide = await db.programStudyGuide.create({
    data: { programId: programA.id, semester: 1, unitId: unit.id, title: 'دليل وحدة أصلي', overview: 'لا يُلمس', status: 'PUBLISHED' },
  })
  await ensureLaunchQualityStudyGuide(programA.id)
  const unitGuideAfter = await db.programStudyGuide.findUnique({ where: { id: unitGuide.id } })
  rows = await generalOf(programA.id)
  check('D1: unit guide unchanged', unitGuideAfter?.title === 'دليل وحدة أصلي', `title=${unitGuideAfter?.title}`)
  check('D2: general guide count still 1', rows.length === 1, `count=${rows.length}`)

  await db.program.deleteMany({ where: { id: { in: [programA.id, programB.id] } } })
}

main()
  .then(async () => {
    if (dbRef) await dbRef.$disconnect().catch(() => {})
    if (startedContainer) await runCommand('docker', ['rm', '-f', DOCKER_CONTAINER])
    if (failures.length) {
      console.error(`LQ_GUIDE_PG: ${failures.length} assertion(s) failed`)
      process.exit(1)
    }
    console.log('LQ_GUIDE_PG: all assertions passed')
    process.exit(0)
  })
  .catch(async (error) => {
    if (dbRef) await dbRef.$disconnect().catch(() => {})
    if (startedContainer) await runCommand('docker', ['rm', '-f', DOCKER_CONTAINER])
    console.error(error instanceof StageError ? error.message : error)
    process.exit(error instanceof StageError ? error.exitCode : 1)
  })
