import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const deployCandidates = [
  // Prefer direct/unpooled URLs for Prisma schema operations.
  'DIRECT_URL',
  'DATABASE_URL_UNPOOLED',
  'DATABASE_POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL_NON_POOLING',
  'DATABASE_POSTGRES_URL',
  'POSTGRES_URL',
  'DATABASE_POSTGRES_PRISMA_URL',
  'POSTGRES_PRISMA_URL',
  'DATABASE_URL',
  'DATABASE_SUPABASE_URL',
  'SUPABASE_URL',
]

const args = new Set(process.argv.slice(2))
const mutatesDatabase = args.size === 0 || args.has('--migrate') || args.has('--push') || args.has('--force-push')

// بوابة الأمان العليا: الترحيل التلقائي (بلا أعلام) لا يعمل إلا في إنتاج Vercel.
// لكن التشغيل الصريح بعلم (--migrate/--push/--force-push) مسموح في حالتين
// مقصودتين أصلاً في منطق السكربت بالأسفل: قاعدة Preview معزولة مُعلنة، أو
// تشغيل محلي بيد المشغّل خارج Vercel وCI. سابقاً كانت البوابة تقتل حتى هذه
// الحالات بصمت ('skipped') فبدت خطوات التشغيل الموثقة معطّلة.
const hasExplicitMutationFlag = args.has('--migrate') || args.has('--push') || args.has('--force-push')
const isCiRun = String(process.env.CI || '').toLowerCase() === 'true' || String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true'
const isIsolatedPreview = process.env.VERCEL_ENV === 'preview' && String(process.env.AACT_PREVIEW_DB_ISOLATED || '').toLowerCase() === 'true'
const isLocalOperatorRun = !process.env.VERCEL && !process.env.VERCEL_ENV && !isCiRun
const explicitMutationAllowed = hasExplicitMutationFlag && (isIsolatedPreview || isLocalOperatorRun)

if (process.env.VERCEL_ENV !== 'production' && mutatesDatabase && !explicitMutationAllowed) {
  console.log('skipped')
  console.log('prisma-deploy: no database change was made. Automatic migration runs only on Vercel production; for an isolated preview database set AACT_PREVIEW_DB_ISOLATED=true, and for a local database pass --migrate/--push explicitly outside Vercel/CI (a shell carrying VERCEL_ENV counts as a Vercel context, not a local one).')
  process.exit(0)
}

if (explicitMutationAllowed && process.env.VERCEL_ENV !== 'production') {
  console.warn('prisma-deploy: explicit database change requested outside Vercel production — target is the configured DATABASE_URL/DIRECT_URL. Make sure it is NOT the production database.')
}

function resolveDatabaseUrl() {
  for (const key of deployCandidates) {
    const value = process.env[key]
    if (value && /^postgres(ql)?:\/\//i.test(value.trim())) {
      if (key !== 'DATABASE_URL') console.log(`Using ${key} as DATABASE_URL for Prisma operations.`)
      return value.trim()
    }
  }
  throw new Error(
    `Missing PostgreSQL connection string. Set DATABASE_URL or one of: ${deployCandidates.filter((k) => k !== 'DATABASE_URL').join(', ')}`
  )
}

const env = {
  ...process.env,
  DATABASE_URL: resolveDatabaseUrl(),
}

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env,
  })
  if (result.status !== 0) process.exit(result.status || 1)
}

function isProductionDeployment() {
  return process.env.VERCEL_ENV === 'production'
}

function isPreviewDeployment() {
  return process.env.VERCEL_ENV === 'preview'
}

function isPreviewDatabaseIsolated() {
  return String(process.env.AACT_PREVIEW_DB_ISOLATED || '').toLowerCase() === 'true'
}

function isNonVercelCiBuild() {
  const isCi = String(process.env.CI || '').toLowerCase() === 'true' || String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true'
  return isCi && !process.env.VERCEL
}

function committedMigrationDirectories() {
  const migrationsPath = 'prisma/migrations'
  if (!existsSync(migrationsPath)) return []
  return readdirSync(migrationsPath)
    .map((name) => join(migrationsPath, name))
    .filter((path) => statSync(path).isDirectory())
    .filter((path) => existsSync(join(path, 'migration.sql')))
}

function assertMigrationsAvailableForDeploy() {
  const migrations = committedMigrationDirectories()
  if (migrations.length > 0) return

  console.error('Refusing Prisma migrate deploy: prisma/migrations is missing or has no migration.sql files.')
  console.error('Create and commit a safe Prisma migration before deploying database changes.')
  process.exit(1)
}

function shouldRunMigrateDeploy(args: Set<string>) {
  if (isNonVercelCiBuild()) {
    if (args.has('--migrate')) console.warn('CI build: skipping migrate deploy')
    return false
  }

  if (isProductionDeployment()) return true

  if (isPreviewDeployment()) {
    if (isPreviewDatabaseIsolated()) return true
    if (args.has('--migrate')) {
      console.warn('Skipping Prisma migrate deploy in Vercel Preview because AACT_PREVIEW_DB_ISOLATED is not true.')
      console.warn('Set AACT_PREVIEW_DB_ISOLATED=true only when Preview DATABASE_URL/DIRECT_URL point to an isolated preview database.')
    }
    return false
  }

  return args.has('--migrate')
}

run('npx', ['prisma', 'generate'])

const runMigrateDeploy = shouldRunMigrateDeploy(args)
if (runMigrateDeploy) {
  assertMigrationsAvailableForDeploy()
  run('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'])
  process.exit(0)
}

if (args.has('--push')) {
  run('npx', ['prisma', 'db', 'push'])
  process.exit(0)
}

if (args.has('--force-push')) {
  if (process.env.AACT_CONFIRM_DATA_LOSS !== 'YES') {
    console.error('Refusing destructive db push. Set AACT_CONFIRM_DATA_LOSS=YES to allow --accept-data-loss.')
    process.exit(1)
  }
  run('npx', ['prisma', 'db', 'push', '--accept-data-loss'])
  process.exit(0)
}

console.log('Prisma client generated. No schema mutation was run. Use --migrate, --push, or --force-push explicitly when needed.')
