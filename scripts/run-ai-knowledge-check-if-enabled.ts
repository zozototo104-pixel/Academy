import { spawnSync } from 'node:child_process'

function enabled(value?: string | null) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

const isEnabled = enabled(process.env.RUN_AI_KNOWLEDGE_CHECK) || enabled(process.env.AI_KNOWLEDGE_CHECK)

const databaseUrlCandidates = [
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
  'QA_DATABASE_URL',
]

function resolveDatabaseUrl() {
  for (const key of databaseUrlCandidates) {
    const value = process.env[key]
    if (value && /^postgres(ql)?:\/\//i.test(value.trim())) {
      if (key !== 'DATABASE_URL') console.log(`[ai-knowledge-check] Using ${key} as DATABASE_URL for build-time knowledge check.`)
      return value.trim()
    }
  }
  return null
}

if (!isEnabled) {
  console.log('[ai-knowledge-check] SKIPPED: set RUN_AI_KNOWLEDGE_CHECK=true to run this check during build.')
  process.exit(0)
}

console.log('[ai-knowledge-check] ENABLED: running central AI knowledge grounding check during build...')
console.log('[ai-knowledge-check] This check reads program/book data only; it does not send email, call AI providers, or modify the database.')

const result = spawnSync('bun', ['run', 'ai:knowledge-check'], {
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32',
})

if (result.error) {
  console.error('[ai-knowledge-check] FAILED to start:', result.error)
  process.exit(1)
}

if (result.status !== 0) {
  console.error(`[ai-knowledge-check] FAILED: command exited with code ${result.status ?? 'unknown'}`)
  process.exit(result.status || 1)
}

console.log('[ai-knowledge-check] PASSED: build may continue.')
