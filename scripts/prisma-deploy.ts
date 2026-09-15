import { spawnSync } from 'node:child_process'

const candidates = [
  'DATABASE_URL',
  'DATABASE_POSTGRES_PRISMA_URL',
  'POSTGRES_PRISMA_URL',
  'DATABASE_POSTGRES_URL',
  'POSTGRES_URL',
  'DATABASE_POSTGRES_URL_NON_POOLING',
  'POSTGRES_URL_NON_POOLING',
  'DATABASE_SUPABASE_URL',
  'SUPABASE_URL',
]

function resolveDatabaseUrl() {
  for (const key of candidates) {
    const value = process.env[key]
    if (value && /^postgres(ql)?:\/\//i.test(value.trim())) {
      if (key !== 'DATABASE_URL') {
        console.log(`Using ${key} as DATABASE_URL for Prisma deployment.`)
      }
      return value.trim()
    }
  }
  throw new Error(
    `Missing PostgreSQL connection string. Set DATABASE_URL or one of: ${candidates.filter((k) => k !== 'DATABASE_URL').join(', ')}`
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
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

run('npx', ['prisma', 'generate'])
run('npx', ['prisma', 'db', 'push', '--accept-data-loss'])
