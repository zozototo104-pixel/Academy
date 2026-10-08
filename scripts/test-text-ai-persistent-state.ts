import assert from 'node:assert/strict'
import { __resetTextAiStateForTests, __setTextAiSettingStoreForTests, textAiComplete } from '../src/lib/text-ai'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

type Store = {
  values: Map<string, string>
  read: (keys: string[]) => Promise<Record<string, string>>
  write: (key: string, value: string) => Promise<void>
  delete: (key: string) => Promise<void>
  increment: (key: string, amount: number) => Promise<number>
  scan: (prefix: string) => Promise<Record<string, string>>
}

function resetEnv() {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
}

function makeStore(seed: Record<string, string> = {}): Store {
  const values = new Map(Object.entries(seed))
  return {
    values,
    async read(keys) {
      return Object.fromEntries(keys.map((key) => [key, values.get(key) || '']))
    },
    async write(key, value) {
      values.set(key, value)
    },
    async delete(key) {
      values.delete(key)
    },
    async increment(key, amount) {
      const next = Number(values.get(key) || 0) + amount
      values.set(key, String(next))
      return next
    },
    async scan(prefix) {
      return Object.fromEntries([...values.entries()].filter(([key]) => key.startsWith(prefix)))
    },
  }
}

function geminiResponse(text = 'ok') {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function configureGemini(keys = 'limited-key,ok-key') {
  process.env.GEMINI_API_KEYS = keys
  process.env.AI_TEXT_PROVIDER = 'GEMINI'
  process.env.AI_ROUTER_POLICY = 'fallback_only'
}

async function withHarness(store: Store, run: (calls: string[]) => Promise<void>) {
  __setTextAiSettingStoreForTests(store)
  __resetTextAiStateForTests()
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('limited-key')) return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429, headers: { 'content-type': 'application/json' } })
    return geminiResponse('verified')
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = originalFetch
    __setTextAiSettingStoreForTests(null)
    __resetTextAiStateForTests()
    resetEnv()
  }
}

async function persistentCooldownSkipsAfterReset() {
  configureGemini()
  const store = makeStore()
  await withHarness(store, async (calls) => {
    const first = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hello' }] })
    assert.equal(first, 'verified')
    assert.ok(calls.some((url) => url.includes('limited-key')))
    assert.ok([...store.values.keys()].some((key) => key.startsWith('AI_COOLDOWN:GEMINI:1:')))

    __resetTextAiStateForTests()
    calls.length = 0
    const second = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hello again' }] })
    assert.equal(second, 'verified')
    assert.equal(calls.some((url) => url.includes('limited-key')), false, 'new instance should skip persisted cooldown key')
    assert.ok(calls.some((url) => url.includes('ok-key')))
  })
}

async function validationRejectedDoesNotWriteCooldown() {
  configureGemini('only-key')
  const store = makeStore()
  __setTextAiSettingStoreForTests(store)
  __resetTextAiStateForTests()
  globalThis.fetch = (async () => geminiResponse('bad output')) as typeof fetch
  try {
    await assert.rejects(
      () => textAiComplete({
        history: [{ role: 'user', text: 'validate' }],
        validate: () => {
          const error = new Error('bad validation') as Error & { code?: string }
          error.code = 'VALIDATION_REJECTED'
          throw error
        },
      }),
      /bad validation/
    )
    assert.equal([...store.values.keys()].some((key) => key.startsWith('AI_COOLDOWN:')), false)
  } finally {
    globalThis.fetch = originalFetch
    __setTextAiSettingStoreForTests(null)
    __resetTextAiStateForTests()
    resetEnv()
  }
}

async function paidBudgetExceededSkipsPaidProvider() {
  process.env.AI_TEXT_PROVIDER = 'OPENAI_COMPAT'
  process.env.AI_ROUTER_POLICY = 'fallback_only'
  process.env.AI_PROVIDER_TIER_OPENAI_COMPAT = 'PAID'
  process.env.AI_PAID_USAGE_MODE = 'critical_first'
  process.env.AI_PAID_DAILY_LIMIT_USD = '1'
  process.env.AI_PAID_MONTHLY_LIMIT_USD = '10'
  process.env.OPENAI_COMPAT_API_KEY = 'paid-key'
  process.env.OPENAI_COMPAT_BASE_URL = 'https://paid.example/v1'
  process.env.OPENAI_COMPAT_TEXT_MODEL = 'gpt-5-paid'
  const today = new Date().toISOString().slice(0, 10)
  const store = makeStore({ [`AI_PAID_SPEND:DAY:${today}`]: '1' })
  __setTextAiSettingStoreForTests(store)
  __resetTextAiStateForTests()
  let fetchCount = 0
  globalThis.fetch = (async () => {
    fetchCount++
    return geminiResponse('paid')
  }) as typeof fetch
  try {
    await assert.rejects(() => textAiComplete({ history: [{ role: 'user', text: 'paid' }], taskLevel: 'ACADEMIC_CRITICAL' }))
    assert.equal(fetchCount, 0, 'paid provider must not be called after budget is exceeded')
  } finally {
    globalThis.fetch = originalFetch
    __setTextAiSettingStoreForTests(null)
    __resetTextAiStateForTests()
    resetEnv()
  }
}

async function failingStoreFallsBackWithoutThrowing() {
  configureGemini('ok-key')
  const failing = {
    async read() { throw new Error('db down') },
    async write() { throw new Error('db down') },
    async scan() { throw new Error('db down') },
    async increment() { throw new Error('db down') },
  }
  __setTextAiSettingStoreForTests(failing)
  __resetTextAiStateForTests()
  globalThis.fetch = (async () => geminiResponse('fallback-ok')) as typeof fetch
  try {
    const result = await textAiComplete({ history: [{ role: 'user', text: 'fallback' }] })
    assert.equal(result, 'fallback-ok')
  } finally {
    globalThis.fetch = originalFetch
    __setTextAiSettingStoreForTests(null)
    __resetTextAiStateForTests()
    resetEnv()
  }
}

async function main() {
  console.log('▶ persistent cooldown skips after reset')
  await persistentCooldownSkipsAfterReset()
  console.log('▶ validation rejection does not write cooldown')
  await validationRejectedDoesNotWriteCooldown()
  console.log('▶ paid budget exceeded skips paid provider')
  await paidBudgetExceededSkipsPaidProvider()
  console.log('▶ failing store falls back without throwing')
  await failingStoreFallsBackWithoutThrowing()
  console.log('text AI persistent state: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  globalThis.fetch = originalFetch
  __setTextAiSettingStoreForTests(null)
  __resetTextAiStateForTests()
  resetEnv()
})
