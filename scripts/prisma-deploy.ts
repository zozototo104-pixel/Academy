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
  if (isProductionDeployment()) return true
  if (isPreviewDeployment()) {
    if (isPreviewDatabaseIsolated()) return args.has('--migrate')
    if (args.has('--migrate')) {
      console.warn('Skipping Prisma migrate deploy in Vercel Preview because AACT_PREVIEW_DB_ISOLATED is not true.')
      console.warn('Set AACT_PREVIEW_DB_ISOLATED=true only when Preview DATABASE_URL/DIRECT_URL point to an isolated preview database.')
    }
    return false
  }
  return args.has('--migrate')
}

const args = new Set(process.argv.slice(2))

assertProductionMigrationsAvailable()
run('npx', ['prisma', 'generate'])

const shouldRunMigrateDeploy = args.has('--migrate') || isProductionDeployment()
if (shouldRunMigrateDeploy) {
  if (!existsSync('prisma/migrations')) {
    console.log('No prisma/migrations directory found. Skipping prisma migrate deploy.')
    process.exit(0)
  }
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
