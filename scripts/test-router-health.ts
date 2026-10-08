import assert from 'node:assert/strict'
import { __resetTextAiStateForTests, __setTextAiSettingStoreForTests, parseAcademicAllowlist, textAiComplete, textAiCompleteJson } from '../src/lib/text-ai'

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

function makeStore(): Store {
  const values = new Map<string, string>()
  return {
    values,
    async read(keys) { return Object.fromEntries(keys.map((key) => [key, values.get(key) || ''])) },
    async write(key, value) { values.set(key, value) },
    async delete(key) { values.delete(key) },
    async increment(key, amount) {
      const next = Number(values.get(key) || 0) + amount
      values.set(key, String(next))
      return next
    },
    async scan(prefix) { return Object.fromEntries([...values.entries()].filter(([key]) => key.startsWith(prefix))) },
  }
}

function configureUnoRouter() {
  process.env.UNOROUTER_API_KEY = 'key-a,key-b'
  process.env.AI_TEXT_PROVIDER = 'UNOROUTER'
  process.env.AI_ROUTER_POLICY = 'fallback_only'
  process.env.UNOROUTER_TEXT_MODEL = 'dead-model:free'
  process.env.AI_ACADEMIC_ALLOWLIST = 'UNOROUTER:dead-model:free'
}

function okChat(text = 'ok') {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function academicAllowlistParserKeepsColonAndSlashModelNames() {
  const parsed = parseAcademicAllowlist('OPENROUTER:nvidia/nemotron-3-super-120b-a12b:free,UNOROUTER:unorouter-ok:free,BAD_ITEM')
  assert.deepEqual(parsed.slice(0, 2), [
    { provider: 'OPENROUTER', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
    { provider: 'UNOROUTER', model: 'unorouter-ok:free' },
  ])
  assert.equal(parsed.length, 2)
}

async function withHarness(store: Store, handler: (url: string, init?: RequestInit) => Response | Promise<Response>, run: (calls: Array<{ url: string; body: any }>) => Promise<void>) {
  __setTextAiSettingStoreForTests(store)
  __resetTextAiStateForTests()
  const calls: Array<{ url: string; body: any }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ url: String(input), body })
    return handler(String(input), init)
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

async function deadModelIsNotRetriedOnSecondKey() {
  configureUnoRouter()
  const store = makeStore()
  await withHarness(
    store,
    (url) => {
      if (url.includes('/api/pricing/catalog')) {
        return new Response(JSON.stringify({ data: [{ id: 'dead-model:free', is_free: true, online: true, type: 'text', context_length: 128000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: { message: 'model no longer available' } }), { status: 404, headers: { 'content-type': 'application/json' } })
    },
    async (calls) => {
      await assert.rejects(() => textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }] }))
      const chatCalls = calls.filter((call) => call.url.includes('/chat/completions'))
      assert.equal(chatCalls.length, 1, 'dead model must not be retried on the second key')
      assert.ok([...store.values.keys()].some((key) => key.startsWith('AI_MODEL_DEAD:UNOROUTER:dead-model:free')))

      __resetTextAiStateForTests()
      calls.length = 0
      await assert.rejects(() => textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }] }))
      assert.equal(calls.filter((call) => call.url.includes('/chat/completions')).length, 0, 'persisted dead model must be skipped in a new instance')
    }
  )
}

async function noBalanceSkipsProviderKey() {
  configureUnoRouter()
  process.env.UNOROUTER_TEXT_MODEL = 'healthy-model:free'
  const store = makeStore()
  await withHarness(
    store,
    (url, init) => {
      if (url.includes('/api/pricing/catalog')) {
        return new Response(JSON.stringify({ data: [{ id: 'healthy-model:free', is_free: true, online: true, type: 'text', context_length: 128000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const auth = String((init?.headers as Record<string, string>)?.Authorization || '')
      if (auth.includes('key-a')) return new Response(JSON.stringify({ error: { message: 'please recharge your balance' } }), { status: 402, headers: { 'content-type': 'application/json' } })
      return okChat('healthy')
    },
    async (calls) => {
      const out = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }] })
      assert.equal(out, 'healthy')
      assert.ok([...store.values.keys()].some((key) => key.startsWith('AI_NO_BALANCE:UNOROUTER:1')))
      assert.equal(calls.filter((call) => call.url.includes('/chat/completions')).length, 2)

      __resetTextAiStateForTests()
      calls.length = 0
      const out2 = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }] })
      assert.equal(out2, 'healthy')
      assert.equal(calls.filter((call) => call.url.includes('/chat/completions')).length, 1, 'no-balance key must be skipped after reset')
    }
  )
}

async function highDemandSkipsSameModelForRemainingKeys() {
  configureUnoRouter()
  process.env.UNOROUTER_TEXT_MODEL = 'busy-model:free'
  const store = makeStore()
  await withHarness(
    store,
    (url) => {
      if (url.includes('/api/pricing/catalog')) {
        return new Response(JSON.stringify({ data: [{ id: 'busy-model:free', is_free: true, online: true, type: 'text', context_length: 128000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ error: { message: 'high demand, try again later' } }), { status: 503, headers: { 'content-type': 'application/json' } })
    },
    async (calls) => {
      await assert.rejects(() => textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }] }))
      assert.equal(calls.filter((call) => call.url.includes('/chat/completions')).length, 1, '503 high demand must skip same model on remaining keys in this request')
    }
  )
}

async function schemaFailureSkipsSameModelForRemainingKeys() {
  configureUnoRouter()
  process.env.UNOROUTER_TEXT_MODEL = 'schema-bad-model:free'
  const store = makeStore()
  await withHarness(
    store,
    (url, init) => {
      if (url.includes('/api/pricing/catalog')) {
        return new Response(JSON.stringify({ data: [
          { id: 'schema-bad-model:free', is_free: true, online: true, type: 'text', context_length: 128000 },
          { id: 'schema-good-model:free', is_free: true, online: true, type: 'text', context_length: 128000 },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/chat/completions')) {
        const model = JSON.parse(String(init?.body || '{}')).model
        if (model === 'schema-bad-model:free') return okChat('{"questions":[{"text":"bad"}]}')
        return okChat('{"ok":true}')
      }
      return okChat('ignored')
    },
    async (calls) => {
      const out = await textAiCompleteJson({
        system: 'test',
        history: [{ role: 'user', text: 'schema' }],
        validate: (text) => {
          if (text.includes('questions')) {
            const error = new Error('EMPTY_BATCH_AFTER_STRUCTURAL_VALIDATION invalid_type correctAnswer') as Error & { code?: string }
            error.code = 'VALIDATION_REJECTED'
            throw error
          }
        },
      })
      assert.equal(out, '{"ok":true}')
      const badCalls = calls.filter((call) => call.url.includes('/chat/completions') && call.body?.model === 'schema-bad-model:free')
      assert.equal(badCalls.length, 1, 'schema-failing model must not be retried on the second key')
      const stats = JSON.parse(store.values.get('AI_MODEL_STATS:UNOROUTER:schema-bad-model:free') || '{}')
      assert.equal(stats.fail?.schemaFail, 1)
    }
  )
}

async function embeddingModelsAreExcludedFromDiscovery() {
  configureUnoRouter()
  process.env.UNOROUTER_TEXT_MODEL = 'auto'
  const store = makeStore()
  await withHarness(
    store,
    (url, init) => {
      if (url.includes('/api/pricing/catalog')) {
        return new Response(JSON.stringify({ data: [
          { id: 'embedding-model:free', is_free: true, online: true, type: 'embedding', context_length: 128000 },
          { id: 'healthy-chat-model:free', is_free: true, online: true, type: 'text', context_length: 128000 },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/chat/completions')) {
        const model = JSON.parse(String(init?.body || '{}')).model
        assert.equal(model, 'healthy-chat-model:free')
        return okChat('healthy')
      }
      return okChat('ignored')
    },
    async () => {
      const out = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }] })
      assert.equal(out, 'healthy')
    }
  )
}

async function healthScoreOrdersModelsInsideProvider() {
  configureUnoRouter()
  process.env.UNOROUTER_TEXT_MODEL = 'auto'
  const store = makeStore()
  store.values.set('AI_MODEL_STATS:UNOROUTER:slow-model:free', JSON.stringify({ success: 1, fail: { timeout: 9 }, avgMs: 60000, jsonOk: 0, jsonTotal: 4, evidenceOk: 0, evidenceTotal: 4 }))
  store.values.set('AI_MODEL_STATS:UNOROUTER:healthy-model:free', JSON.stringify({ success: 20, fail: { other: 1 }, avgMs: 800, jsonOk: 10, jsonTotal: 10, evidenceOk: 10, evidenceTotal: 10 }))
  await withHarness(
    store,
    (url, init) => {
      if (url.includes('/api/pricing/catalog')) {
        return new Response(JSON.stringify({ data: [
          { id: 'slow-model:free', is_free: true, online: true, type: 'text', context_length: 128000 },
          { id: 'healthy-model:free', is_free: true, online: true, type: 'text', context_length: 128000 },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/chat/completions')) {
        const model = JSON.parse(String(init?.body || '{}')).model
        assert.equal(model, 'healthy-model:free')
        return okChat('healthy')
      }
      return okChat('ignored')
    },
    async () => {
      const out = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }] })
      assert.equal(out, 'healthy')
    }
  )
}

async function providerOrderBeatsHealthScoreAcrossProviders() {
  process.env.AI_TEXT_PROVIDER = 'AUTO'
  process.env.AI_ROUTER_POLICY = 'primary_first'
  process.env.GEMINI_API_KEYS = 'gemini-key'
  process.env.UNOROUTER_API_KEY = 'uno-key'
  process.env.UNOROUTER_TEXT_MODEL = 'healthy-uno:free'
  const store = makeStore()
  store.values.set('AI_MODEL_STATS:UNOROUTER:healthy-uno:free', JSON.stringify({ success: 100, fail: {}, avgMs: 100, jsonOk: 20, jsonTotal: 20, evidenceOk: 20, evidenceTotal: 20 }))
  await withHarness(
    store,
    (url) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini-first' }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/api/pricing/catalog')) {
        return new Response(JSON.stringify({ data: [{ id: 'healthy-uno:free', is_free: true, online: true, type: 'text', context_length: 128000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return okChat('uno')
    },
    async (calls) => {
      const out = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }] })
      assert.equal(out, 'gemini-first')
      assert.ok(calls[0]?.url.includes('generativelanguage.googleapis.com'), 'provider order must be respected before cross-provider health score')
    }
  )
}

async function jsonRepairExtractsObjectFromText() {
  configureUnoRouter()
  process.env.UNOROUTER_TEXT_MODEL = 'json-repair-model:free'
  const store = makeStore()
  await withHarness(
    store,
    (url) => {
      if (url.includes('/api/pricing/catalog')) {
        return new Response(JSON.stringify({ data: [{ id: 'json-repair-model:free', is_free: true, online: true, type: 'text', context_length: 128000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return okChat('I will now answer. {"ok":true,}')
    },
    async () => {
      const out = await textAiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'json' }] })
      assert.equal(out, '{"ok":true}')
    }
  )
}

async function invalidJsonRetriesOnceStrictly() {
  configureUnoRouter()
  process.env.UNOROUTER_TEXT_MODEL = 'json-retry-model:free'
  const store = makeStore()
  let chatCount = 0
  await withHarness(
    store,
    (url, init) => {
      if (url.includes('/api/pricing/catalog')) {
        return new Response(JSON.stringify({ data: [{ id: 'json-retry-model:free', is_free: true, online: true, type: 'text', context_length: 128000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/chat/completions')) {
        chatCount++
        const body = JSON.parse(String(init?.body || '{}'))
        if (chatCount === 1) return okChat('I will now prepare the answer.')
        assert.ok(JSON.stringify(body).includes('JSON فقط'), 'strict retry prompt must ask for JSON only')
        return okChat('{"ok":true}')
      }
      return okChat('ignored')
    },
    async () => {
      const out = await textAiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'json' }] })
      assert.equal(out, '{"ok":true}')
      assert.equal(chatCount, 2)
    }
  )
}

async function stickyModelIsPreferredForSameScope() {
  configureUnoRouter()
  process.env.UNOROUTER_TEXT_MODEL = 'auto'
  const store = makeStore()
  store.values.set('AI_MODEL_STATS:UNOROUTER:first-model:free', JSON.stringify({ success: 10, fail: {}, avgMs: 100, jsonOk: 5, jsonTotal: 5, evidenceOk: 5, evidenceTotal: 5 }))
  store.values.set('AI_MODEL_STATS:UNOROUTER:second-model:free', JSON.stringify({ success: 1, fail: { other: 4 }, avgMs: 1000, jsonOk: 1, jsonTotal: 2, evidenceOk: 1, evidenceTotal: 2 }))
  const seenModels: string[] = []
  await withHarness(
    store,
    (url, init) => {
      if (url.includes('/api/pricing/catalog')) {
        return new Response(JSON.stringify({ data: [
          { id: 'first-model:free', is_free: true, online: true, type: 'text', context_length: 128000 },
          { id: 'second-model:free', is_free: true, online: true, type: 'text', context_length: 128000 },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.includes('/chat/completions')) {
        const model = JSON.parse(String(init?.body || '{}')).model
        seenModels.push(model)
        return okChat(model === 'first-model:free' ? 'first' : 'second')
      }
      return okChat('ignored')
    },
    async () => {
      const first = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }], stickyScope: 'batch-1' })
      assert.equal(first, 'first')
      const second = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }], stickyScope: 'batch-1' })
      assert.equal(second, 'first')
      assert.deepEqual(seenModels, ['first-model:free', 'first-model:free'])
    }
  )
}

async function hangingOpenRouterTimesOutAndFallsThrough() {
  process.env.AI_TEXT_PROVIDER = 'AUTO'
  process.env.AI_ROUTER_POLICY = 'primary_first'
  process.env.OPENROUTER_API_KEY = 'openrouter-key'
  process.env.UNOROUTER_API_KEY = 'uno-key'
  process.env.OPENROUTER_TEXT_MODEL = 'openrouter-timeout:free'
  process.env.UNOROUTER_TEXT_MODEL = 'unorouter-ok:free'
  process.env.AI_ACADEMIC_ALLOWLIST = 'OPENROUTER:openrouter-timeout:free,UNOROUTER:unorouter-ok:free'
  const store = makeStore()
  const originalTimeout = (AbortSignal as any).timeout
  ;(AbortSignal as any).timeout = () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 5)
    return controller.signal
  }
  try {
    await withHarness(
      store,
      (url, init) => {
        if (url.includes('openrouter.ai') && /\/models(?:\?|$)/.test(url)) {
          return new Response(JSON.stringify({ data: [{ id: 'openrouter-timeout:free', is_free: true, online: true, type: 'text', context_length: 128000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (url.includes('/api/pricing/catalog')) {
          return new Response(JSON.stringify({ data: [{ id: 'unorouter-ok:free', is_free: true, online: true, type: 'text', context_length: 128000 }] }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        if (url.includes('openrouter.ai') && url.includes('/chat/completions')) {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
          })
        }
        if (url.includes('api.unorouter.com') && url.includes('/chat/completions')) return okChat('uno-after-timeout')
        return okChat('ignored')
      },
      async (calls) => {
        const out = await textAiComplete({ system: 'test', history: [{ role: 'user', text: 'timeout' }], taskLevel: 'ACADEMIC_CRITICAL' })
        assert.equal(out, 'uno-after-timeout')
        assert.ok(calls.some((call) => call.url.includes('openrouter.ai') && call.url.includes('/chat/completions')), 'OpenRouter should be attempted first')
        assert.ok(calls.some((call) => call.url.includes('api.unorouter.com') && call.url.includes('/chat/completions')), 'router must fall through after OpenRouter timeout')
      }
    )
  } finally {
    ;(AbortSignal as any).timeout = originalTimeout
  }
}

async function jsonObjectResponseFormatIsSent() {
  configureUnoRouter()
  process.env.UNOROUTER_TEXT_MODEL = 'json-model:free'
  const store = makeStore()
  await withHarness(
    store,
    () => okChat('{"ok":true}'),
    async (calls) => {
      const out = await textAiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'json' }] })
      assert.equal(out, '{"ok":true}')
      const body = calls.find((call) => call.url.includes('/chat/completions'))?.body
      assert.deepEqual(body.response_format, { type: 'json_object' })
    }
  )
}

async function main() {
  console.log('▶ router health: academic allowlist parser')
  academicAllowlistParserKeepsColonAndSlashModelNames()
  console.log('▶ router health: dead model')
  await deadModelIsNotRetriedOnSecondKey()
  console.log('▶ router health: no balance')
  await noBalanceSkipsProviderKey()
  console.log('▶ router health: high demand')
  await highDemandSkipsSameModelForRemainingKeys()
  console.log('▶ router health: schema failure model skip')
  await schemaFailureSkipsSameModelForRemainingKeys()
  console.log('▶ router health: capability filter')
  await embeddingModelsAreExcludedFromDiscovery()
  console.log('▶ router health: health score ordering')
  await healthScoreOrdersModelsInsideProvider()
  console.log('▶ router health: provider order before health score')
  await providerOrderBeatsHealthScoreAcrossProviders()
  console.log('▶ router health: json repair')
  await jsonRepairExtractsObjectFromText()
  console.log('▶ router health: strict json retry')
  await invalidJsonRetriesOnceStrictly()
  console.log('▶ router health: sticky model')
  await stickyModelIsPreferredForSameScope()
  console.log('▶ router health: OpenRouter timeout fallthrough')
  await hangingOpenRouterTimesOutAndFallsThrough()
  console.log('▶ router health: json response format')
  await jsonObjectResponseFormatIsSent()
  console.log('router health tests: ok')
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
