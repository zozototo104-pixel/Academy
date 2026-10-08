import assert from 'node:assert/strict'
import { __resetTextAiStateForTests, __setTextAiSettingStoreForTests, textAiComplete, textAiCompleteJson } from '../src/lib/text-ai'

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
    () => new Response(JSON.stringify({ error: { message: 'model no longer available' } }), { status: 404, headers: { 'content-type': 'application/json' } }),
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
    (_url, init) => {
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
    () => new Response(JSON.stringify({ error: { message: 'high demand, try again later' } }), { status: 503, headers: { 'content-type': 'application/json' } }),
    async (calls) => {
      await assert.rejects(() => textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }] }))
      assert.equal(calls.filter((call) => call.url.includes('/chat/completions')).length, 1, '503 high demand must skip same model on remaining keys in this request')
    }
  )
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
  console.log('▶ router health: dead model')
  await deadModelIsNotRetriedOnSecondKey()
  console.log('▶ router health: no balance')
  await noBalanceSkipsProviderKey()
  console.log('▶ router health: high demand')
  await highDemandSkipsSameModelForRemainingKeys()
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
