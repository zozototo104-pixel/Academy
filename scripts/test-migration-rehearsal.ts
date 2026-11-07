/**
 * بروفة نشر الهجرات وخطة الرجوع (بند المرحلة الثالثة 11 — المرجع 2.1).
 *
 * ماذا يثبت، على PostgreSQL حقيقية فارغة:
 * 1) `prisma migrate deploy` من الصفر: كل الهجرات تُعاد بالترتيب
 *    وتنجح، وجدولا المرحلة الثانية وعموداها الأربعة موجودون بعدها.
 * 2) التكافؤ مع db push: مجموعة جداول قاعدة الـdeploy تطابق مجموعة
 *    جداول قاعدة دُفعت بـ`prisma db push` من نفس السكيمة.
 * 3) الرجوع منفّذ لا مكتوب فقط: على قاعدة الـdeploy نفسها ننفّذ
 *    SQL الرجوع لهجرتي المرحلة الثانية (حذف الجدولين والأعمدة
 *    الأربعة) فتختفي الأغراض.
 * 4) انقطاع منتصف الترحيل على قاعدة ممثلة (فيها السكيمة الأساسية):
 *    SQL الهجرتين داخل معاملة ثم ROLLBACK ⇒ لا أثر (DDL في
 *    PostgreSQL معاملي؛ انقطاع كهذا لا يترك نصف جدول ولا صفًّا في
 *    _prisma_migrations)، ثم إعادة تطبيق حقيقية تعيد كل شيء —
 *    forward-fix والrollback كلاهما مجرّب.
 * 5) ترقية فوق بيانات قديمة بمسار النشر الفعلي: قاعدة عند حالة ما
 *    قبل المرحلة الثانية مزروعة بجلسة صوت بلا تخصيصات وصف بريد
 *    بختم الترميز القديم ورسالة ملخص بختم «+100 سنة»، ثم نشر كامل
 *    يثبت أن الترقية تعدّي والصفوف القديمة تبقى سليمة لتتبناها
 *    الآليات الجديدة.
 * 6) استكمال الهجرات بين ملفات ناجحة (ليس فشلاً داخل هجرة).
 * 7) فشل داخل نسخة اختبارية من هجرة البريد عبر migrate deploy:
 *    سجل فاشل، رفض إعادة النشر، معالجة الأثر، resolve ثم نشر ناجح.
 *
 * خطة التعافي: احتفظ بالجداول والبيانات الجديدة عند رجوع التطبيق؛
 * افحص توافق جلسات الصوت والبريد الجارية قبل تشغيل إصدار سابق.
 * أي إزالة لاحقة تتطلب هجرة أمامية وخطة احتفاظ بالبيانات.
 * لا تحذف صفوف _prisma_migrations، ولا تستخدم resolve --rolled-back
 * لهجرة ناجحة حتى لو حُذفت أغراضها يدويًا؛ أصلح الانحراف للأمام.
 * --rolled-back مخصص لسجل هجرة فاشلة فقط وبعد معالجة آثارها وفحص
 * migrate status. المرحلة 8 تختبر هذا المسار على قاعدة مؤقتة فقط.
 * SQL الحذف في المرحلة 3 تجربة إزالة على قاعدة فارغة، وليس خطة إنتاج.
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
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'

const ENV_URL = process.env.MIGRATION_REHEARSAL_DATABASE_URL || ''
const DOCKER_CONTAINER = `aact-mig-rehearsal-${process.pid}`
const PG_READY_DEADLINE_MS = 90_000
const DEPLOY_DB = 'academy_rehearsal_deploy'
const PUSH_DB = 'academy_rehearsal_push'
const LEGACY_DB = 'academy_rehearsal_legacy'
const RESUME_DB = 'academy_rehearsal_resume'
const FAILURE_DB = 'academy_rehearsal_failure'
const STAGE2_MIGRATIONS = ['20261107120000_live_credit_allocations', '20261107130000_outbox_email_claim_ledger']
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
  for (const extraDb of [LEGACY_DB, RESUME_DB, FAILURE_DB]) {
    const extra = await runCommand('docker', ['exec', DOCKER_CONTAINER, 'createdb', '-U', 'mig_test', extraDb])
    if (extra.code !== 0) {
      throw new StageError(`[ENV] MIGRATION_REHEARSAL stage 0: could not create ${extraDb}.\n${outputTail(extra.stderr || extra.stdout)}`)
    }
  }
  console.log('[STAGE 0] PostgreSQL is ready with both rehearsal databases')
  const base = assertSafeBaseUrl(`${DOCKER_URL_BASE}/${DEPLOY_DB}`)
  const psql = (db: string, sql: string) =>
    runCommand('docker', ['exec', DOCKER_CONTAINER, 'psql', '-U', 'mig_test', '-d', db, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql])
  return { base, psql }
}

// نشر بـ`prisma migrate deploy` الحقيقي لكن بمجلد هجرات مُصفّى:
// يبني نسخة مؤقتة من السكيمة + مجلد هجرات جزئي، فيحاكي قاعدة عند
// حالة ترحيل سابقة (قبل المرحلة الثانية، أو منتصف الطريق) دون لمس
// مجلد الهجرات الحقيقي.
async function deployWithFilteredMigrations(
  databaseUrl: string,
  keep: (folderName: string) => boolean,
  injectFailure = false,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tmpDir = `/tmp/mig-rehearsal-${process.pid}-${Math.floor(Math.random() * 1e9)}`
  mkdirSync(`${tmpDir}/migrations`, { recursive: true })
  try {
    cpSync('prisma/schema.prisma', `${tmpDir}/schema.prisma`)
    cpSync('prisma/migrations/migration_lock.toml', `${tmpDir}/migrations/migration_lock.toml`)
    for (const entry of readdirSync('prisma/migrations', { withFileTypes: true })) {
      if (entry.isDirectory() && keep(entry.name)) {
        cpSync(`prisma/migrations/${entry.name}`, `${tmpDir}/migrations/${entry.name}`, { recursive: true })
      }
    }
    if (injectFailure) {
      // Only the disposable copy is modified; committed SQL stays byte-identical.
      const path = `${tmpDir}/migrations/${STAGE2_MIGRATIONS[1]}/migration.sql`
      const sql = readFileSync(path, 'utf8')
      const firstStatement = sql.indexOf(';') + 1
      if (!firstStatement) throw new Error('No statement available for failure injection')
      writeFileSync(path, sql.slice(0, firstStatement) + '\nSELECT 1 / 0; -- rehearsal failure\n' + sql.slice(firstStatement))
    }
    const env = { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }
    return await runCommand('bunx', ['prisma', 'migrate', 'deploy', '--schema', `${tmpDir}/schema.prisma`], env)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
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

  // 1) نشر كامل من الصفر بكل الهجرات بالترتيب. (بروفة الانقطاع تأتي
  // بعد النشر والرجوع: SQL الهجرة يبني مفاتيح أجنبية على جداول لا
  // توجد في قاعدة فارغة، فمسرحها الصحيح قاعدة ممثلة فيها السكيمة.)
  console.log('[STAGE 1] prisma migrate deploy from empty')
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

  // 2) التكافؤ مع db push من نفس السكيمة.
  console.log('[STAGE 2] prisma db push comparison database')
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

  // 3) الرجوع منفّذًا — على قاعدة الـdeploy نفسها.
  console.log('[STAGE 3] Executed rollback of the two stage-2 migrations')
  const rb = await psql(DEPLOY_DB, ROLLBACK_SQL)
  check('rollback SQL executes', rb.code === 0, rb.code === 0 ? 'exit 0' : outputTail(rb.stderr || rb.stdout, 10))
  const afterRollback = await stage2ObjectsPresent(psql, DEPLOY_DB)
  check('after rollback every stage-2 object is gone', !afterRollback.ok
    && !(await tableExists(psql, DEPLOY_DB, 'AiLiveCreditAllocation'))
    && !(await tableExists(psql, DEPLOY_DB, 'NotificationOutboxRecipient')),
    afterRollback.evidence)

  // 4) انقطاع منتصف الترحيل على قاعدة ممثلة: تطبيق الهجرتين داخل
  // معاملة ثم ROLLBACK ⇒ لا أثر لهما (DDL معاملي في PostgreSQL).
  console.log('[STAGE 4] Interruption semantics: both migrations inside a rolled-back transaction')
  const rolled = await psql(DEPLOY_DB, `BEGIN;\n${e01Sql}\n${e02Sql}\nROLLBACK;`)
  check('interrupted (rolled-back) migrations apply inside their transaction', rolled.code === 0,
    rolled.code === 0 ? 'transaction executed' : outputTail(rolled.stderr || rolled.stdout, 5))
  check('after the rollback interruption no stage-2 object exists', !(await tableExists(psql, DEPLOY_DB, 'AiLiveCreditAllocation'))
    && !(await tableExists(psql, DEPLOY_DB, 'NotificationOutboxRecipient')),
    'no half-applied DDL survives an interruption')

  // 5) إعادة التطبيق الحقيقية بعد الرجوع والانقطاع.
  console.log('[STAGE 5] Reapply after rollback')
  const reapply = await psql(DEPLOY_DB, `${e01Sql}\n${e02Sql}`)
  check('reapplying the two migration files executes', reapply.code === 0,
    reapply.code === 0 ? 'exit 0' : outputTail(reapply.stderr || reapply.stdout, 10))
  const afterReapply = await stage2ObjectsPresent(psql, DEPLOY_DB)
  check('after reapply every stage-2 object is back', afterReapply.ok, afterReapply.evidence)

  // 6) ترقية فوق بيانات قديمة عبر مسار النشر الفعلي: قاعدة عند حالة
  // ما قبل المرحلة الثانية (كل الهجرات إلا هجرتيها) مزروعة بصفوف
  // بالترميزات القديمة، ثم `prisma migrate deploy` الكامل عليها.
  console.log('[STAGE 6] Upgrade over legacy data through the real deploy path')
  const legacyUrl = urlForDb(base, LEGACY_DB)
  const preStage2 = await deployWithFilteredMigrations(legacyUrl, (name) => !STAGE2_MIGRATIONS.includes(name))
  check('deploy of all pre-stage-2 migrations succeeds on the legacy database', preStage2.code === 0,
    preStage2.code === 0 ? 'exit 0' : outputTail(preStage2.stdout + '\n' + preStage2.stderr, 20))
  if (preStage2.code === 0) {
    const seed = await psql(LEGACY_DB, `
      INSERT INTO "User" (id, email, password, name, role, "createdAt", "updatedAt")
      VALUES ('legacy-user-1', 'legacy@example.test', 'x', 'Legacy', 'STUDENT', NOW(), NOW());
      INSERT INTO "AiLiveSession" (id, "sessionId", "userId", month, purpose, status, "reservedMinutes", "freeReserved", "paidReserved", "startedAt", "expiresAt", "createdAt", "updatedAt")
      VALUES ('legacy-session-1', 'legacy-live-1', 'legacy-user-1', '2026-11', 'SUPERVISOR', 'SETTLED', 2, 2, 0, NOW(), NOW() + INTERVAL '1 hour', NOW(), NOW());
      INSERT INTO "NotificationOutbox" (id, "idempotencyKey", kind, "recipientRole", title, body, status, "emailStatus", "emailAttempts", "lastError", "createdAt")
      VALUES ('legacy-outbox-1', 'legacy-key-1', 'SEMESTER_FAILED', 'ADMINS', 't', 'b', 'SENT', 'SENDING', 1,
        'EMAIL_CLAIM:2026-11-01T00:00:00.000Z' || chr(10) || 'EMAIL_SENT_IDS:["legacy-admin-1"]', NOW());
      INSERT INTO "SupervisorChannelMessage" (id, "studentId", "senderRole", scope, audience, mode, content, "emailSentAt", "createdAt")
      VALUES ('legacy-msg-1', 'legacy-user-1', 'STUDENT', 'ADMIN', 'ALL', 'TEXT', 'رسالة قديمة', NOW() + INTERVAL '100 years', NOW());`)
    check('legacy-shaped rows seed cleanly', seed.code === 0,
      seed.code === 0 ? 'exit 0' : outputTail(seed.stderr || seed.stdout, 8))
    const upgradeEnv = { ...process.env, DATABASE_URL: legacyUrl, DIRECT_URL: legacyUrl }
    const upgrade = await runCommand('bunx', ['prisma', 'migrate', 'deploy'], upgradeEnv)
    check('full migrate deploy upgrades the legacy database', upgrade.code === 0,
      upgrade.code === 0 ? 'exit 0' : outputTail(upgrade.stdout + '\n' + upgrade.stderr, 20))
    if (upgrade.code === 0) {
      const appliedLegacy = await psql(LEGACY_DB, 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')
      check('legacy database ends fully migrated', appliedLegacy.stdout.trim() === String(migrationCount),
        `recorded=${appliedLegacy.stdout.trim()} folders=${migrationCount}`)
      const legacyObjects = await stage2ObjectsPresent(psql, LEGACY_DB)
      check('stage-2 objects exist after the upgrade', legacyObjects.ok, legacyObjects.evidence)
      const marker = await psql(LEGACY_DB, `SELECT "emailStatus" FROM "NotificationOutbox" WHERE id = 'legacy-outbox-1'`)
      const markerBody = await psql(LEGACY_DB, `SELECT COUNT(*) FROM "NotificationOutbox" WHERE id = 'legacy-outbox-1' AND "lastError" LIKE 'EMAIL_CLAIM:%' AND "lastError" LIKE '%EMAIL_SENT_IDS:%'`)
      check('legacy outbox row survives untouched (old marker encoding intact for the adopting dispatcher)',
        marker.stdout.trim() === 'SENDING' && markerBody.stdout.trim() === '1',
        `emailStatus=${marker.stdout.trim()} markerIntact=${markerBody.stdout.trim()}`)
      const voiceRow = await psql(LEGACY_DB, `SELECT COUNT(*) FROM "AiLiveSession" WHERE id = 'legacy-session-1'`)
      const digestRow = await psql(LEGACY_DB, `SELECT COUNT(*) FROM "SupervisorChannelMessage" WHERE id = 'legacy-msg-1' AND "emailSentAt" > NOW() + INTERVAL '99 years'`)
      check('legacy voice session and legacy digest claim (+100y encoding) survive the upgrade',
        voiceRow.stdout.trim() === '1' && digestRow.stdout.trim() === '1',
        `session=${voiceRow.stdout.trim()} digestClaim=${digestRow.stdout.trim()}`)
    }
  }

  // 7) Resume between successfully completed migration files.
  console.log('[STAGE 7] Deploy resume from a half-applied state')
  const resumeUrl = urlForDb(base, RESUME_DB)
  const allFolders = readdirSync('prisma/migrations', { withFileTypes: true })
    .filter((d) => d.isDirectory()).map((d) => d.name).sort()
  const prefix = allFolders.slice(0, Math.floor(allFolders.length / 2))
  const half = await deployWithFilteredMigrations(resumeUrl, (name) => prefix.includes(name))
  check(`prefix deploy applies the first half (${prefix.length}/${allFolders.length})`, half.code === 0,
    half.code === 0 ? 'exit 0' : outputTail(half.stdout + '\n' + half.stderr, 20))
  if (half.code === 0) {
    const resumeEnv = { ...process.env, DATABASE_URL: resumeUrl, DIRECT_URL: resumeUrl }
    const resumed = await runCommand('bunx', ['prisma', 'migrate', 'deploy'], resumeEnv)
    check('full deploy resumes and completes from the half-applied state', resumed.code === 0,
      resumed.code === 0 ? 'exit 0' : outputTail(resumed.stdout + '\n' + resumed.stderr, 20))
    const appliedResume = await psql(RESUME_DB, 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')
    check('resumed database ends fully migrated', appliedResume.stdout.trim() === String(migrationCount),
      `recorded=${appliedResume.stdout.trim()} folders=${migrationCount}`)
    const again = await runCommand('bunx', ['prisma', 'migrate', 'deploy'], resumeEnv)
    const appliedAgain = await psql(RESUME_DB, 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')
    check('a second deploy is a clean no-op', again.code === 0 && appliedAgain.stdout.trim() === String(migrationCount),
      `exit=${again.code} recorded=${appliedAgain.stdout.trim()}`)
  }

  // 8) Actual Prisma failure record and recovery, not a successful prefix.
  console.log('[STAGE 8] Failure inside the outbox migration and Prisma recovery')
  const failureUrl = urlForDb(base, FAILURE_DB)
  const failureEnv = { ...process.env, DATABASE_URL: failureUrl, DIRECT_URL: failureUrl }
  const baseline = await deployWithFilteredMigrations(failureUrl, (name) => !STAGE2_MIGRATIONS.includes(name))
  check('failure database baseline deploys', baseline.code === 0, outputTail(baseline.stdout + baseline.stderr, 3))
  if (baseline.code !== 0) return 1
  const seedFailure = await psql(FAILURE_DB, `INSERT INTO "User" (id, email, password, name, role, "createdAt", "updatedAt") VALUES ('recovery-user', 'recovery@example.test', 'x', 'Recovery', 'STUDENT', NOW(), NOW())`)
  check('recovery sentinel is seeded', seedFailure.code === 0, 'pre-existing user')
  const failed = await deployWithFilteredMigrations(failureUrl, () => true, true)
  check('injected SQL failure is reported by migrate deploy (P3018)', failed.code !== 0 && /P3018/.test(failed.stdout + failed.stderr), outputTail(failed.stdout + failed.stderr, 8))
  const failedRowsSql = `SELECT COUNT(*) FROM "_prisma_migrations" WHERE migration_name = '${STAGE2_MIGRATIONS[1]}' AND finished_at IS NULL AND rolled_back_at IS NULL AND logs IS NOT NULL`
  const failedRows = await psql(FAILURE_DB, failedRowsSql)
  check('Prisma records exactly one unresolved failed migration', failedRows.code === 0 && failedRows.stdout.trim() === '1', failedRows.stdout.trim())
  const blocked = await runCommand('bunx', ['prisma', 'migrate', 'deploy'], failureEnv)
  check('unresolved failure blocks redeployment (P3009)', blocked.code !== 0 && /P3009/.test(blocked.stdout + blocked.stderr), outputTail(blocked.stdout + blocked.stderr, 6))
  // Prove the rejected instruction from the old runbook is invalid.
  const invalidResolve = await runCommand('bunx', ['prisma', 'migrate', 'resolve', '--rolled-back', STAGE2_MIGRATIONS[0]], failureEnv)
  check('a successful migration cannot be marked rolled back (P3012)', invalidResolve.code !== 0 && /P3012/.test(invalidResolve.stdout + invalidResolve.stderr), outputTail(invalidResolve.stdout + invalidResolve.stderr, 4))
  // Revert only E02 effects, if any survived, on this never-used test DB.
  // E01 and all legacy tables/data remain intact. Never run this on production.
  const cleanupFailed = await psql(FAILURE_DB, ROLLBACK_SQL.replace('DROP TABLE IF EXISTS "AiLiveCreditAllocation";', ''))
  check('failed E02 effects are cleaned without removing E01', cleanupFailed.code === 0 && await tableExists(psql, FAILURE_DB, 'AiLiveCreditAllocation'), 'E01 retained')
  const resolved = await runCommand('bunx', ['prisma', 'migrate', 'resolve', '--rolled-back', STAGE2_MIGRATIONS[1]], failureEnv)
  check('resolve accepts the failed migration', resolved.code === 0, outputTail(resolved.stdout + resolved.stderr, 4))
  const unresolved = await psql(FAILURE_DB, failedRowsSql)
  check('no unresolved failed migration remains', unresolved.code === 0 && unresolved.stdout.trim() === '0', unresolved.stdout.trim())
  const recovered = await runCommand('bunx', ['prisma', 'migrate', 'deploy'], failureEnv)
  check('original unmodified migrations deploy after recovery', recovered.code === 0, outputTail(recovered.stdout + recovered.stderr, 5))
  const recoveredObjects = await stage2ObjectsPresent(psql, FAILURE_DB)
  check('recovery restores all stage-2 objects', recoveredObjects.ok, recoveredObjects.evidence)
  const history = await psql(FAILURE_DB, 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
  check('every migration has a successful record after recovery', history.code === 0 && history.stdout.trim() === String(migrationCount), history.stdout.trim())
  const sentinel = await psql(FAILURE_DB, `SELECT COUNT(*) FROM "User" WHERE id = 'recovery-user' AND email = 'recovery@example.test'`)
  check('pre-existing data survives failed deployment and recovery', sentinel.code === 0 && sentinel.stdout.trim() === '1', sentinel.stdout.trim())
  const recoveredAgain = await runCommand('bunx', ['prisma', 'migrate', 'deploy'], failureEnv)
  check('deploy after recovery is idempotent', recoveredAgain.code === 0 && /No pending migrations/.test(recoveredAgain.stdout + recoveredAgain.stderr), outputTail(recoveredAgain.stdout + recoveredAgain.stderr, 4))
  const status = await runCommand('bunx', ['prisma', 'migrate', 'status'], failureEnv)
  check('Prisma migration status is healthy after recovery', status.code === 0, outputTail(status.stdout + status.stderr, 4))

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

