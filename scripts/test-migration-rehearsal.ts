/**
 * بروفة نشر الهجرات وخطة الرجوع (بند المرحلة الثالثة 11 — المرجع 2.1).
 *
 * ماذا يثبت، على PostgreSQL حقيقية فارغة:
 * 1) انقطاع منتصف الترحيل: SQL هجرة E01 داخل معاملة ثم ROLLBACK ⇒
 *    الجدول غائب (DDL في PostgreSQL معاملي؛ انقطاع كهذا لا يترك
 *    نصف جدول ولا صفًّا في _prisma_migrations).
 * 2) `prisma migrate deploy` من الصفر: كل الهجرات تُعاد بالترتيب
 *    وتنجح، وجدولا المرحلة الثانية وعموداها الأربعة موجودون بعدها.
 * 3) التكافؤ مع db push: مجموعة جداول قاعدة الـdeploy تطابق مجموعة
 *    جداول قاعدة دُفعت بـ`prisma db push` من نفس السكيمة.
 * 4) الرجوع منفّذ لا مكتوب فقط: على قاعدة الـdeploy نفسها ننفّذ
 *    SQL الرجوع لهجرتي المرحلة الثانية (حذف الجدولين والأعمدة
 *    الأربعة) فتختفي الأغراض، ثم نعيد تطبيق ملفي الهجرة فيعود كل
 *    شيء — forward-fix والrollback كلاهما مجرّب.
 *
 * خطة الرجوع الموثقة لهجرتي المرحلة الثانية (تُستخدم فقط بقرار
 * المالك؛ الهجرتان إضافيتان صرفتان فالرجوع لا يمس بيانات قائمة):
 *   DROP TABLE IF EXISTS "NotificationOutboxRecipient";
 *   DROP TABLE IF EXISTS "AiLiveCreditAllocation";
 *   ALTER TABLE "NotificationOutbox" DROP COLUMN IF EXISTS "emailClaimId";
 *   ALTER TABLE "NotificationOutbox" DROP COLUMN IF EXISTS "emailClaimLeaseUntil";
 *   ALTER TABLE "SupervisorChannelMessage" DROP COLUMN IF EXISTS "emailClaimId";
 *   ALTER TABLE "SupervisorChannelMessage" DROP COLUMN IF EXISTS "emailClaimLeaseUntil";
 * ومعها حذف صفّي الهجرتين من "_prisma_migrations" إن طُبّق الرجوع
 * يدويًا خارج أدوات Prisma.
 *
 * Migration deploy rehearsal + executed rollback for the stage-2
 * migrations (E01/E02): full replay from empty, push-equivalence,
 * transactional-interruption semantics, rollback + reapply.
 *
 * Environment:
 *   MIGRATION_REHEARSAL_DATABASE_URL — optional base URL whose
 *     database name is REPLACED with the two rehearsal databases
 *     (the server must allow CREATE DATABASE). Otherwise a disposable
 *     docker postgres:16 is started on port 55435 and removed at exit.
 *   Safety: REFUSES unless the host is localhost OR the database name
 *     contains "test"/"ci"/"rehearsal".
 *
 * Exit codes: 0 = every assertion passed · 1 = an assertion failed ·
 * 2 = environment could not be prepared.
 */
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'

const ENV_URL = process.env.MIGRATION_REHEARSAL_DATABASE_URL || ''
const DOCKER_CONTAINER = `aact-mig-rehearsal-${process.pid}`
const PG_READY_DEADLINE_MS = 90_000
const DEPLOY_DB = 'academy_rehearsal_deploy'
const PUSH_DB = 'academy_rehearsal_push'
const DOCKER_URL_BASE = 'postgresql://mig_test:mig_test_only@localhost:55435'

const E01_SQL_PATH = 'prisma/migrations/20261107120000_live_credit_allocations/migration.sql'
const E02_SQL_PATH = 'prisma/migrations/20261107130000_outbox_email_claim_ledger/migration.sql'
const ROLLBACK_SQL = [
  'DROP TABLE IF EXISTS "NotificationOutboxRecipient";',
  'DROP TABLE IF EXISTS "AiLiveCreditAllocation";',
  'ALTER TABLE "NotificationOutbox" DROP COLUMN IF EXISTS "emailClaimId";',
  'ALTER TABLE "NotificationOutbox" DROP COLUMN IF EXISTS "emailClaimLeaseUntil";',
  'ALTER TABLE "SupervisorChannelMessage" DROP COLUMN IF EXISTS "emailClaimId";',
  'ALTER TABLE "SupervisorChannelMessage" DROP COLUMN IF EXISTS "emailClaimLeaseUntil";',
].join('\n')

const failures: string[] = []
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
    // سطر أوامر GitHub Actions: يظهر كتعليق (annotation) قابل للقراءة
    // عبر API حتى حين لا تُقرأ سجلات الوظيفة نفسها.
    console.log(`::error title=MIGRATION_REHEARSAL_FAIL::${label} — ${evidence}`.replace(/[%]/g, '%25').replace(/[\r\n]/g, ' '))
    failures.push(label)
  }
}

function describeError(error: any): string {
  const message = String(error?.message || error || '').replace(/\s+/g, ' ').slice(0, 400)
  return `${error?.name || 'Error'}: ${message}`
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

function assertSafeBaseUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new StageError('[ENV] MIGRATION_REHEARSAL stage 0: database URL is not parseable — refusing to continue')
  }
  const host = parsed.hostname.toLowerCase()
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase()
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  const markedDb = dbName.includes('test') || dbName.includes('ci') || dbName.includes('rehearsal')
  if (!localHost && !markedDb) {
    throw new StageError(
      `[ENV] MIGRATION_REHEARSAL stage 0: SAFETY REFUSAL — host "${host}" is not localhost and database "${dbName}" is not marked test/ci/rehearsal.`,
    )
  }
  return parsed
}

function urlForDb(base: URL, dbName: string): string {
  const u = new URL(base.toString())
  u.pathname = `/${dbName}`
  return u.toString()
}

async function resolveBase(): Promise<{ base: URL; psql: (db: string, sql: string) => Promise<{ code: number | null; stdout: string; stderr: string }> }> {
  if (ENV_URL) {
    console.log('[STAGE 0] Using MIGRATION_REHEARSAL_DATABASE_URL from the environment')
    const base = assertSafeBaseUrl(ENV_URL)
    const user = decodeURIComponent(base.username)
    const pass = decodeURIComponent(base.password)
    const psql = async (db: string, sql: string) => {
      const target = new URL(base.toString())
      target.pathname = `/${db}`
      return runCommand('psql', [target.toString(), '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], {
        ...process.env, PGPASSWORD: pass || process.env.PGPASSWORD || '',
      })
    }
    void user
    return { base, psql }
  }
  console.log(`[STAGE 0] Starting disposable docker postgres:16 as ${DOCKER_CONTAINER} on port 55435`)
  await runCommand('docker', ['rm', '-f', DOCKER_CONTAINER])
  const run = await runCommand('docker', [
    'run', '-d', '--name', DOCKER_CONTAINER,
    '-e', 'POSTGRES_USER=mig_test',
    '-e', 'POSTGRES_PASSWORD=mig_test_only',
    '-e', `POSTGRES_DB=${DEPLOY_DB}`,
    '-p', '55435:5432',
    'postgres:16',
  ])
  if (run.code !== 0) {
    throw new StageError(
      `[ENV] MIGRATION_REHEARSAL stage 0: docker could not start the test PostgreSQL (exit ${run.code}).\n${outputTail(run.stderr || run.stdout)}`,
    )
  }
  startedContainer = true
  const deadline = Date.now() + PG_READY_DEADLINE_MS
  let ready = false
  while (Date.now() < deadline) {
    const probe = await runCommand('docker', ['exec', DOCKER_CONTAINER, 'pg_isready', '-U', 'mig_test', '-d', DEPLOY_DB])
    if (probe.code === 0) { ready = true; break }
    await sleep(1500)
  }
  if (!ready) {
    throw new StageError(`[ENV] MIGRATION_REHEARSAL stage 0: PostgreSQL never became ready within ${PG_READY_DEADLINE_MS / 1000}s`)
  }
  const created = await runCommand('docker', ['exec', DOCKER_CONTAINER, 'createdb', '-U', 'mig_test', PUSH_DB])
  if (created.code !== 0) {
    throw new StageError(`[ENV] MIGRATION_REHEARSAL stage 0: could not create ${PUSH_DB}.\n${outputTail(created.stderr || created.stdout)}`)
  }
  console.log('[STAGE 0] PostgreSQL is ready with both rehearsal databases')
  const base = assertSafeBaseUrl(`${DOCKER_URL_BASE}/${DEPLOY_DB}`)
  const psql = (db: string, sql: string) =>
    runCommand('docker', ['exec', DOCKER_CONTAINER, 'psql', '-U', 'mig_test', '-d', db, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql])
  return { base, psql }
}

async function tableExists(psql: (db: string, sql: string) => Promise<any>, db: string, table: string): Promise<boolean> {
  const r = await psql(db, `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='${table}'`)
  return r.code === 0 && r.stdout.trim() === '1'
}

async function columnExists(psql: (db: string, sql: string) => Promise<any>, db: string, table: string, column: string): Promise<boolean> {
  const r = await psql(db, `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND column_name='${column}'`)
  return r.code === 0 && r.stdout.trim() === '1'
}

async function stage2ObjectsPresent(psql: (db: string, sql: string) => Promise<any>, db: string): Promise<{ ok: boolean; evidence: string }> {
  const parts: string[] = []
  let ok = true
  for (const t of ['AiLiveCreditAllocation', 'NotificationOutboxRecipient']) {
    const has = await tableExists(psql, db, t)
    parts.push(`${t}=${has}`)
    ok = ok && has
  }
  for (const [t, c] of [
    ['NotificationOutbox', 'emailClaimId'], ['NotificationOutbox', 'emailClaimLeaseUntil'],
    ['SupervisorChannelMessage', 'emailClaimId'], ['SupervisorChannelMessage', 'emailClaimLeaseUntil'],
  ] as const) {
    const has = await columnExists(psql, db, t, c)
    parts.push(`${t}.${c}=${has}`)
    ok = ok && has
  }
  return { ok, evidence: parts.join(' ') }
}

async function main(): Promise<number> {
  const { base, psql } = await resolveBase()
  const deployUrl = urlForDb(base, DEPLOY_DB)
  const pushUrl = urlForDb(base, PUSH_DB)
  const e01Sql = readFileSync(E01_SQL_PATH, 'utf8')
  const e02Sql = readFileSync(E02_SQL_PATH, 'utf8')
  const migrationCount = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((d) => d.isDirectory()).length

  // 1) انقطاع منتصف الترحيل: تطبيق داخل معاملة ثم تراجع ⇒ لا أثر.
  console.log('[STAGE 1] Interruption semantics: E01 migration inside a rolled-back transaction')
  const rolled = await psql(DEPLOY_DB, `BEGIN;\n${e01Sql}\nROLLBACK;`)
  check('interrupted (rolled-back) E01 migration applies inside its transaction', rolled.code === 0,
    rolled.code === 0 ? 'transaction executed' : outputTail(rolled.stderr || rolled.stdout, 5))
  check('after rollback the allocation table does not exist', !(await tableExists(psql, DEPLOY_DB, 'AiLiveCreditAllocation')),
    'table absent — no half-applied DDL survives an interruption')

  // 2) نشر كامل من الصفر بكل الهجرات بالترتيب.
  console.log('[STAGE 2] prisma migrate deploy from empty')
  const deployEnv = { ...process.env, DATABASE_URL: deployUrl, DIRECT_URL: deployUrl }
  const deploy = await runCommand('bunx', ['prisma', 'migrate', 'deploy'], deployEnv)
  check(`migrate deploy succeeds from empty (${migrationCount} migrations)`, deploy.code === 0,
    deploy.code === 0 ? 'exit 0' : outputTail(deploy.stdout + '\n' + deploy.stderr, 30))
  if (deploy.code !== 0) return 1
  const applied = await psql(DEPLOY_DB, 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')
  check('every migration recorded as finished', applied.stdout.trim() === String(migrationCount),
    `recorded=${applied.stdout.trim()} folders=${migrationCount}`)
  const afterDeploy = await stage2ObjectsPresent(psql, DEPLOY_DB)
  check('stage-2 tables and claim columns exist after deploy', afterDeploy.ok, afterDeploy.evidence)

  // 3) التكافؤ مع db push من نفس السكيمة.
  console.log('[STAGE 3] prisma db push comparison database')
  const pushEnv = { ...process.env, DATABASE_URL: pushUrl, DIRECT_URL: pushUrl }
  const push = await runCommand('bunx', ['prisma', 'db', 'push', '--skip-generate'], pushEnv)
  check('db push succeeds on the comparison database', push.code === 0,
    push.code === 0 ? 'exit 0' : outputTail(push.stdout + '\n' + push.stderr, 20))
  if (push.code === 0) {
    const listSql = `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name <> '_prisma_migrations' ORDER BY table_name`
    const deployTables = (await psql(DEPLOY_DB, listSql)).stdout.trim().split('\n').filter(Boolean)
    const pushTables = (await psql(PUSH_DB, listSql)).stdout.trim().split('\n').filter(Boolean)
    const onlyDeploy = deployTables.filter((t) => !pushTables.includes(t))
    const onlyPush = pushTables.filter((t) => !deployTables.includes(t))
    check('deploy and push table sets are identical', onlyDeploy.length === 0 && onlyPush.length === 0,
      `deploy=${deployTables.length} push=${pushTables.length} onlyDeploy=[${onlyDeploy.join(',')}] onlyPush=[${onlyPush.join(',')}]`)
  }

  // 4) الرجوع منفّذًا ثم إعادة التطبيق — على قاعدة الـdeploy نفسها.
  console.log('[STAGE 4] Executed rollback of the two stage-2 migrations, then reapply')
  const rb = await psql(DEPLOY_DB, ROLLBACK_SQL)
  check('rollback SQL executes', rb.code === 0, rb.code === 0 ? 'exit 0' : outputTail(rb.stderr || rb.stdout, 10))
  const afterRollback = await stage2ObjectsPresent(psql, DEPLOY_DB)
  check('after rollback every stage-2 object is gone', !afterRollback.ok
    && !(await tableExists(psql, DEPLOY_DB, 'AiLiveCreditAllocation'))
    && !(await tableExists(psql, DEPLOY_DB, 'NotificationOutboxRecipient')),
    afterRollback.evidence)
  const reapply = await psql(DEPLOY_DB, `${e01Sql}\n${e02Sql}`)
  check('reapplying the two migration files executes', reapply.code === 0,
    reapply.code === 0 ? 'exit 0' : outputTail(reapply.stderr || reapply.stdout, 10))
  const afterReapply = await stage2ObjectsPresent(psql, DEPLOY_DB)
  check('after reapply every stage-2 object is back', afterReapply.ok, afterReapply.evidence)

  if (failures.length) {
    console.error(`\nMIGRATION_REHEARSAL: FAILED — ${failures.length} assertion(s) failed`)
    return 1
  }
  console.log('\nMIGRATION_REHEARSAL: ALL ASSERTIONS PASSED')
  return 0
}

async function cleanup() {
  if (startedContainer) {
    const rm = await runCommand('docker', ['rm', '-f', DOCKER_CONTAINER])
    if (rm.code !== 0) console.error(`[WARN] could not remove docker container ${DOCKER_CONTAINER}: ${outputTail(rm.stderr, 3)}`)
    startedContainer = false
  }
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
    console.error(`[FAIL] MIGRATION_REHEARSAL unexpected error — ${describeError(error)}`)
    await cleanup()
    process.exit(1)
  })
