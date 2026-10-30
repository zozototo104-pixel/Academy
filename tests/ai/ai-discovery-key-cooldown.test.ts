/// <reference types="bun-types" />
import { afterEach, describe, expect, mock, test } from 'bun:test'

// Model discovery is background traffic (2026-10-30 methodology fix): it must
// never spend a request on a key the router itself is avoiding. Before this
// fix liveFreeModels always used providerKeys[0], so a persisted cooldown on
// the first key was ignored by discovery — CI's persistent-state guard caught
// it ("new instance should skip persisted cooldown key"). These tests pin the
// product behaviour: discovery picks the first key with no active cooldown
// (persisted key-level, or memory model-level), and still uses the first key
// when nothing is cooling.

const db: any = {
  aiUsageLog: { create: async () => ({}) },
  user: { findUnique: async () => null },
  keyRateWindow: {
    upsert: async () => ({}),
    findUnique: async () => ({ count: 1 }),
  },
  setting: {
    findMany: async () => [],
    findUnique: async () => null,
    upsert: async () => ({}),
  },
}

mock.module('@/lib/db', () => ({ db }))

const textAi = await import('../../src/lib/text-ai') as any
const originalFetch = globalThis.fetch

function makeStore(seed: Record<string, string> = {}) {
  const values = new Map(Object.entries(seed))
  return {
    values,
    async read(keys: string[]) {
      return Object.fromEntries(keys.map((key) => [key, values.get(key) || '']))
    },
    async write(key: string, value: string) { values.set(key, value) },
    async delete(key: string) { values.delete(key) },
    async increment(key: string, amount: number) {
      const next = Number(values.get(key) || 0) + amount
      values.set(key, String(next))
      return next
    },
    async scan(prefix: string) {
      return Object.fromEntries([...values.entries()].filter(([key]) => key.startsWith(prefix)))
    },
  }
}

const BASE_SEED: Record<string, string> = {
  GEMINI_API_KEYS: 'cooled-key,ok-key',
  AI_TEXT_PROVIDER: 'GEMINI',
  AI_ROUTER_POLICY: 'fallback_only',
}

let requests: string[] = []

function installFetch() {
  requests = []
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url)
    const headers = JSON.stringify(init?.headers || {})
    requests.push(`${urlText} ${headers}`)
    if (urlText.includes('/v1beta/models?')) {
      return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (urlText.includes('cooled-key')) {
      return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429, headers: { 'Content-Type': 'application/json' } })
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'served-by-ok-key' }] } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as any
}

function discoveryRequest(): string {
  return requests.find((entry) => entry.includes('/v1beta/models?')) || ''
}

afterEach(() => {
  globalThis.fetch = originalFetch
  textAi.__setTextAiSettingStoreForTests(null)
  textAi.__resetTextAiStateForTests()
})

describe('discovery key selection respects cooldowns', () => {
  test('a persisted KEY-level cooldown on the first key moves discovery AND completions to the next key', async () => {
    const store = makeStore({
      ...BASE_SEED,
      'AI_COOLDOWN:GEMINI:1': JSON.stringify({ until: new Date(Date.now() + 15 * 60 * 1000).toISOString(), reason: 'quota exceeded', status: 429 }),
    })
    textAi.__setTextAiSettingStoreForTests(store)
    installFetch()

    const out = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hello' }] })

    expect(out).toBe('served-by-ok-key')
    expect(discoveryRequest()).toContain('key=ok-key')
    expect(requests.some((entry) => entry.includes('cooled-key'))).toBe(false)
  })

  test('a persisted MODEL-level cooldown on the first key still moves discovery off it', async () => {
    const store = makeStore({
      ...BASE_SEED,
      'AI_COOLDOWN:GEMINI:1:gemini-3.8-flash': JSON.stringify({ until: new Date(Date.now() + 15 * 60 * 1000).toISOString(), reason: 'quota exceeded', status: 429 }),
    })
    textAi.__setTextAiSettingStoreForTests(store)
    installFetch()

    await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hello' }] }).catch(() => {})

    expect(discoveryRequest()).toContain('key=ok-key')
  })

  test('a memory model cooldown on the first key moves discovery off it', async () => {
    const store = makeStore({ ...BASE_SEED })
    textAi.__setTextAiSettingStoreForTests(store)
    textAi.__testMarkModelCooldownForTests('GEMINI', 'cooled-key', 'gemini-3.8-flash')
    installFetch()

    await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hello' }] }).catch(() => {})

    expect(discoveryRequest()).toContain('key=ok-key')
  })

  test('with no cooldowns, discovery still uses the first key', async () => {
    const store = makeStore({ ...BASE_SEED })
    textAi.__setTextAiSettingStoreForTests(store)
    installFetch()

    const out = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hello' }] }).catch(() => '')

    expect(discoveryRequest()).toContain('key=cooled-key')
    expect(out).toBe('served-by-ok-key')
  })
})
