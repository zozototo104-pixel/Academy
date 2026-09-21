import { spawnSync } from 'node:child_process'

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env,
  })
  if (result.status !== 0) process.exit(result.status || 1)
}

function enabled(value?: string) {
  return ['1', 'yes', 'YES', 'true', 'TRUE'].includes(String(value || '').trim())
}

if (!process.env.DATABASE_URL) {
  if (enabled(process.env.AACT_RUN_DB_SETUP) || enabled(process.env.AACT_RUN_DB_PUSH)) {
    console.error('DATABASE_URL is required for DB setup/schema push.')
    process.exit(1)
  }
  console.log('One-time DB setup skipped. DATABASE_URL is not available.')
  process.exit(0)
}

if (enabled(process.env.AACT_RUN_DB_PUSH)) {
  console.log('AACT_RUN_DB_PUSH=YES detected. Pushing Prisma schema only...')
  run('tsx', ['scripts/prisma-deploy.ts', '--push'])
  console.log('Schema-only database update completed successfully.')
  process.exit(0)
}

if (!enabled(process.env.AACT_RUN_DB_SETUP)) {
  console.log('One-time DB setup skipped. Set AACT_RUN_DB_SETUP=YES to run full setup, or AACT_RUN_DB_PUSH=YES for schema-only updates.')
  process.exit(0)
}

console.log('AACT_RUN_DB_SETUP=YES detected. Running one-time production database setup...')

if (!process.env.AACT_ADMIN_EMAIL || !process.env.AACT_ADMIN_PASSWORD || !process.env.AACT_ADMIN_NAME) {
  console.error('AACT_ADMIN_EMAIL, AACT_ADMIN_PASSWORD, and AACT_ADMIN_NAME are required for DB setup.')
  process.exit(1)
}

if (!enabled(process.env.AACT_CREATE_ADMIN)) {
  console.error('AACT_CREATE_ADMIN must be YES while running one-time DB setup.')
  process.exit(1)
}

run('tsx', ['scripts/prisma-deploy.ts', '--push'])
run('tsx', ['scripts/seed-core.ts'])
run('tsx', ['scripts/create-admin.ts'])

console.log('One-time production database setup completed successfully.')
