/// <reference types="bun-types" />
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 3 — discovery + refresh + retirement detection. The router is
// driven for real with stubbed HTTP (same pattern as
// tests/ai/auto-mode-toggle.test.ts); ZAI is the generic-path provider
// under test (its key comes via env — ZAI accepts plaintext rows, but env
// matches the step-0 spike finding for strict providers).
const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const originalEnv: Record<string, string | undefined> = {
  ZAI_API_KEY: process.env.ZAI_API_KEY,
}

const db: any = {
  aiUsageLog: { create: async () => ({}) },
  user: { findUnique: async () => null },
  keyRateWindow: { upsert: async () => ({}), findUnique: async () => ({ count: 1 }) },
  setting: { findMany: async () => [], findUnique: async () => null, upsert: async () => ({}) },
}
mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/settings', () => ({ getSetting: async (key: string) => values.get(key) || '' }))

const textAi = await import('../../src/lib/text-ai')
const autoMode = await import('../../src/lib/ai-auto-mode')
const autoRefresh = await import('../../src/lib/ai-auto-refresh')

function makeStore(backing: Map<string, string>) {
  return {
    async read(keys: string[]) { return Object.fromEntries(keys.map((key) => [key, backing.get(key) || ''])) },
    async write(key: string, value: string) { backing.set(key, value) },
    async delete(key: string) { backing.delete(key) },
    async scan(prefix: string) { return Object.fromEntries([...backing.entries()].filter(([key]) => key.startsWith(prefix))) },
    async increment(key: string, amount: number) {
      const next = (Number(backing.get(key) || 0) || 0) + amount
      backing.set(key, String(next))
      return next
    },
  }
}
const store = makeStore(values)

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function freeRow(id: string, extra: Record<string, unknown> = {}) {
  return { id, pricing: { prompt: 0, completion: 0 }, context_length: 131072, family: 'glm', ...extra }
}

// Mutable stub state: the ZAI /models payload and HTTP status per test.
let zaiRows: unknown[] = []
let zaiStatus = 200
let zaiThrow = false
let fetchCalls: string[] = []

function installFetch() {
  fetchCalls = []
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const urlText = String(url)
    fetchCalls.push(urlText)
    if (urlText.startsWith('https://zai.test/v1/models')) {
      if (zaiThrow) throw new Error('fetch failed: connection reset')
      return jsonResponse({ data: zaiRows }, zaiStatus)
    }
    throw new Error(`unexpected fetch: ${urlText}`)
  }) as any
}

beforeEach(() => {
  values.clear()
  process.env.ZAI_API_KEY = 'test-zai-key'
  values.set('ZAI_API_BASE', 'https://zai.test/v1')
  values.set('ZAI_TEXT_MODEL', 'glm-4.5')
  zaiRows = []
  zaiStatus = 200
  zaiThrow = false
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
  installFetch()
})

afterEach(() => {
  globalThis.fetch = originalFetch
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(null)
})

afterAll(() => {
  process.env.ZAI_API_KEY = originalEnv.ZAI_API_KEY
})

describe('discovery adapter table (one row per provider)', () => {
  test('the ten named generic providers are all in the table', () => {
    const providers = textAi.__testGenericDiscoveryProvidersForTests()
    for (const provider of ['ZAI', 'CLOUDFLARE', 'OXION', 'TOPTOOLS', 'DEEPINFRA', 'TOGETHER', 'RELAYROUTER', 'OPENROUTER', 'ALBORIHI', 'OPENAI_COMPAT']) {
      expect(providers).toContain(provider)
    }
  })

  test('CLOUDFLARE is static (no /models endpoint) and the rest are openai-compat', () => {
    expect(textAi.__testDiscoveryAdapterForTests('CLOUDFLARE')?.kind).toBe('static')
    expect(textAi.__testDiscoveryAdapterForTests('ZAI')?.kind).toBe('openai-compat')
    expect(textAi.__testDiscoveryAdapterForTests('ALBORIHI')?.freeFilter).toBe('alborihi')
    expect(textAi.__testDiscoveryAdapterForTests('GEMINI')).toBeNull()
  })

  test('CLOUDFLARE refresh returns the curated static list without any fetch', async () => {
    const result = await textAi.refreshDiscoveryForProvider('CLOUDFLARE')
    expect(result.discoveryOk).toBe(true)
    expect(result.models).toEqual(textAi.__testStaticTextModelsForTests('CLOUDFLARE'))
    expect(fetchCalls).toEqual([])
  })
})

describe('discovery refresh + reconciliation', () => {
  test('new provider models appear and the discovered list equals the stubbed list exactly', async () => {
    zaiRows = [freeRow('glm-4.5'), freeRow('glm-4.6-new'), freeRow('zai-weird-model-9')]
    const result = await textAi.refreshDiscoveryForProvider('ZAI')
    expect(result.discoveryOk).toBe(true)
    expect(result.models).toEqual(['glm-4.5', 'glm-4.6-new', 'zai-weird-model-9'])
    // No invented names: nothing from the hardcoded list that the stub
    // did not return (e.g. glm-4.5-air) may appear.
    expect(result.models).not.toContain('glm-4.5-air')
    const entry = textAi.__testDiscoveryEntryForTests('ZAI')
    expect(entry?.discoveredAt).toBeGreaterThan(0)
    expect(entry?.lastError).toBeUndefined()
  })

  test('renamed model detected: same family + same context + stripped name match', async () => {
    zaiRows = [freeRow('glm-4.5'), freeRow('glm-4.5-air')]
    await textAi.refreshDiscoveryForProvider('ZAI')
    zaiRows = [freeRow('glm-4.5'), freeRow('glm-4.5-air-20261101')]
    const result = await textAi.refreshDiscoveryForProvider('ZAI')
    expect(result.discoveryOk).toBe(true)
    expect(result.renamed).toEqual({ 'glm-4.5-air': 'glm-4.5-air-20261101' })
    expect(result.retired || []).not.toContain('glm-4.5-air')
    expect(result.models).toContain('glm-4.5-air-20261101')
  })

  test('a different-family model with the same stripped name is NOT a rename', async () => {
    zaiRows = [freeRow('glm-4.5'), freeRow('glm-4.5-air')]
    await textAi.refreshDiscoveryForProvider('ZAI')
    // Same stripped name, but a different family and different context:
    // this is a new model, not a rename of glm-4.5-air.
    zaiRows = [freeRow('glm-4.5'), { id: 'glm-4.5-air-20261101', pricing: { prompt: 0, completion: 0 }, context_length: 32768, family: 'qwen' }]
    const result = await textAi.refreshDiscoveryForProvider('ZAI')
    expect(result.renamed || {}).toEqual({})
    expect(result.models).toContain('glm-4.5-air-20261101')
  })

  test('retired only after 2 consecutive successful refreshes', async () => {
    zaiRows = [freeRow('glm-4.5'), freeRow('glm-old')]
    await textAi.refreshDiscoveryForProvider('ZAI')
    zaiRows = [freeRow('glm-4.5')]
    const firstMiss = await textAi.refreshDiscoveryForProvider('ZAI')
    expect(firstMiss.models).toEqual(['glm-4.5'])
    expect(firstMiss.retired || []).not.toContain('glm-old')
    expect(textAi.__testDiscoveryEntryForTests('ZAI')?.missedCounts).toEqual({ 'glm-old': 1 })
    const secondMiss = await textAi.refreshDiscoveryForProvider('ZAI')
    expect(secondMiss.retired || []).toContain('glm-old')
    expect(secondMiss.models).toEqual(['glm-4.5'])
  })

  test('transient 500 keeps the old catalog + discoveryOk:false and never retires', async () => {
    zaiRows = [freeRow('glm-4.5'), freeRow('glm-4.6-new')]
    await textAi.refreshDiscoveryForProvider('ZAI')
    zaiStatus = 500
    const failed = await textAi.refreshDiscoveryForProvider('ZAI')
    expect(failed.discoveryOk).toBe(false)
    expect(failed.models).toEqual(['glm-4.5', 'glm-4.6-new'])
    expect(failed.lastError).toMatch(/DISCOVERY_HTTP_500/)
    expect(failed.retired || []).toEqual([])
    const entry = textAi.__testDiscoveryEntryForTests('ZAI')
    expect(entry?.discoveryOk).toBe(false)
    expect(entry?.lastError).toMatch(/DISCOVERY_HTTP_500/)
    // A later good refresh with the same catalog clears the error and
    // still retires nothing (the failed refresh never counted as a miss).
    zaiStatus = 200
    const recovered = await textAi.refreshDiscoveryForProvider('ZAI')
    expect(recovered.discoveryOk).toBe(true)
    expect(recovered.retired || []).toEqual([])
    expect(textAi.__testDiscoveryEntryForTests('ZAI')?.lastError).toBeUndefined()
  })

  test('transient network throw keeps the old catalog + discoveryOk:false', async () => {
    zaiRows = [freeRow('glm-4.5')]
    await textAi.refreshDiscoveryForProvider('ZAI')
    zaiThrow = true
    const failed = await textAi.refreshDiscoveryForProvider('ZAI')
    expect(failed.discoveryOk).toBe(false)
    expect(failed.models).toEqual(['glm-4.5'])
    expect(failed.retired || []).toEqual([])
  })
})

describe('reconciliation against hardcoded lists, admin choice and stage refs', () => {
  test('admin-chosen model missing from discovery warns but is never rewritten', () => {
    const warnings = autoMode.reconcileReferences({
      provider: 'ZAI',
      discovered: ['glm-4.5'],
      hardcoded: ['glm-4.5', 'glm-4.5-air'],
      adminChosen: 'glm-4.5-air',
      stageProfileModels: [],
    })
    expect(warnings.map((w) => w.kind)).toContain('ADMIN_MODEL_NOT_DISCOVERED')
    expect(warnings.map((w) => w.kind)).toContain('HARDCODED_MODEL_NOT_DISCOVERED')
  })

  test('stage-profile model that retired warns as retired, not silently dropped', () => {
    const warnings = autoMode.reconcileReferences({
      provider: 'ZAI',
      discovered: ['glm-4.5'],
      hardcoded: ['glm-4.5', 'glm-old'],
      retired: ['glm-old'],
      stageProfileModels: ['glm-old'],
    })
    expect(warnings.map((w) => w.kind)).toContain('STAGE_MODEL_RETIRED')
  })

  test('no warnings when everything discovered agrees', () => {
    expect(autoMode.reconcileReferences({
      provider: 'ZAI',
      discovered: ['glm-4.5', 'glm-4.5-air'],
      hardcoded: ['glm-4.5', 'glm-4.5-air'],
      adminChosen: 'glm-4.5',
      stageProfileModels: ['glm-4.5-air'],
    })).toEqual([])
  })
})

describe('round-robin background refresh (one provider per run)', () => {
  test('pickNextRefreshProvider advances one step and wraps', () => {
    expect(autoRefresh.pickNextRefreshProvider(['A', 'B', 'C'], {})).toBe('A')
    expect(autoRefresh.pickNextRefreshProvider(['A', 'B', 'C'], { lastProvider: 'A' })).toBe('B')
    expect(autoRefresh.pickNextRefreshProvider(['A', 'B', 'C'], { lastProvider: 'C' })).toBe('A')
    expect(autoRefresh.pickNextRefreshProvider(['A', 'B', 'C'], { lastProvider: 'UNKNOWN' })).toBe('A')
  })

  test('runAutoRefresh discovers exactly one provider per run and advances the cursor', async () => {
    const seen: string[] = []
    const backing = new Map<string, string>()
    const memStore = {
      async read(keys: string[]) { return Object.fromEntries(keys.map((key) => [key, backing.get(key) || ''])) },
      async write(key: string, value: string) { backing.set(key, value) },
    }
    const discover = async (provider: string) => {
      seen.push(provider)
      return { provider, models: [`${provider.toLowerCase()}-model-1`], discoveryOk: true, sourceCount: 1 }
    }
    const first = await autoRefresh.runAutoRefresh({ store: memStore, discover, providers: ['ZAI', 'GROQ', 'OPENAI'] })
    expect(seen).toEqual(['ZAI'])
    expect(first.provider).toBe('ZAI')
    expect(first.models).toEqual(['zai-model-1'])
    const second = await autoRefresh.runAutoRefresh({ store: memStore, discover, providers: ['ZAI', 'GROQ', 'OPENAI'] })
    expect(seen).toEqual(['ZAI', 'GROQ'])
    expect(second.provider).toBe('GROQ')
    const state = JSON.parse(backing.get('AI_AUTO_LAST_REFRESH') || '{}')
    expect(state.lastProvider).toBe('GROQ')
    expect(state.results.GROQ.discoveryOk).toBe(true)
  })

  test('runAutoRefresh with a failed discovery still records the outcome and keeps going', async () => {
    const backing = new Map<string, string>()
    const memStore = {
      async read(keys: string[]) { return Object.fromEntries(keys.map((key) => [key, backing.get(key) || ''])) },
      async write(key: string, value: string) { backing.set(key, value) },
    }
    const result = await autoRefresh.runAutoRefresh({
      store: memStore,
      providers: ['ZAI'],
      discover: async (provider: string) => ({ provider, models: [], discoveryOk: false, lastError: 'DISCOVERY_HTTP_500' }),
    })
    expect(result.discoveryOk).toBe(false)
    expect(result.lastError).toBe('DISCOVERY_HTTP_500')
    const state = JSON.parse(backing.get('AI_AUTO_LAST_REFRESH') || '{}')
    expect(state.results.ZAI.discoveryOk).toBe(false)
  })
})
