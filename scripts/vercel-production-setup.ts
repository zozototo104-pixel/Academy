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

if (!enabled(process.env.AACT_RUN_DB_SETUP)) {
  console.log('One-time DB setup skipped. Set AACT_RUN_DB_SETUP=YES to run it during this deployment.')
  process.exit(0)
}

console.log('AACT_RUN_DB_SETUP=YES detected. Running one-time production database setup...')

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for DB setup.')
  process.exit(1)
}

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
