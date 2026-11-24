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
  test('production refresh claim uses a quota-safe hourly interval', () => {
    expect(autoRefresh.__testAiAutoRefreshClaimConstants.AI_AUTO_REFRESH_INTERVAL_MS).toBe(60 * 60 * 1000)
  })

  test('pickNextRefreshProvider advances one step and wraps', () => {
    expect(autoRefresh.pickNextRefreshProvider(['A', 'B', 'C'], {})).toBe('A')
    expect(autoRefresh.pickNextRefreshProvider(['A', 'B', 'C'], { lastProvider: 'A' })).toBe('B')
    expect(autoRefresh.pickNextRefreshProvider(['A', 'B', 'C'], { lastProvider: 'C' })).toBe('A')
    expect(autoRefresh.pickNextRefreshProvider(['A', 'B', 'C'], { lastProvider: 'UNKNOWN' })).toBe('A')
  })

  test('persists per-purpose rankings, rotates probes and preserves other providers', async () => {
    const backing = new Map<string, string>()
    const memStore = {
      async read(keys: string[]) { return Object.fromEntries(keys.map((key) => [key, backing.get(key) || ''])) },
      async write(key: string, value: string) { backing.set(key, value) },
    }
    const manualKey = 'AI_PROVIDER_FALLBACK_ORDER'
    backing.set(manualKey, 'GEMINI,GROQ')
    backing.set('AI_MODEL_STATS:CHAT:GEMINI:gemini-good', JSON.stringify({ success: 30, fail: {}, avgMs: 150 }))
    const probeCalls: Array<{ provider: string; model: string; kind: string }> = []
    const callModel = async (input: { provider: string; model: string; kind: string; planted?: string }) => {
      probeCalls.push({ provider: input.provider, model: input.model, kind: input.kind })
      return { ok: true, text: input.kind === 'json' ? '{"probe":true,"value":42}' : String(input.planted || '') }
    }
    const models = ['gemini-good', 'gemini-new', 'gemini-extra']
    const common = {
      store: memStore,
      providers: ['GEMINI'],
      discover: async () => ({ provider: 'GEMINI', models, discoveryOk: true }),
      callModel,
      probeProviders: ['GEMINI'],
      probeKinds: ['json' as const, 'ocr' as const],
      probeModelsPerRun: 1,
      capabilitiesForProvider: async () => Object.fromEntries(models.map((model) => [model, { vision: true, costTier: 'free' as const }])),
      rankAfterRefresh: true,
    }
    const first = await autoRefresh.runAutoRefresh({ ...common, nowMs: 1000 })
    expect(first.probedModels).toEqual(['gemini-good'])
    expect(first.rankedPurposes).toEqual([...autoMode.AUTO_PURPOSES])
    for (const purpose of autoMode.AUTO_PURPOSES) {
      const list = autoMode.parseAutoRanking(backing.get(`AI_AUTO_RANKING:${purpose}`))
      expect(list.length).toBe(3)
      expect(list.every((item) => item.provider === 'GEMINI')).toBe(true)
    }
    const previous = autoMode.parseAutoRanking(backing.get('AI_AUTO_RANKING:CHAT'))
    backing.set('AI_AUTO_RANKING:CHAT', JSON.stringify({ candidates: [
      ...previous, { provider: 'GROQ', model: 'llama-3.3-70b-versatile', score: 0.99 },
    ] }))
    const second = await autoRefresh.runAutoRefresh({ ...common, nowMs: 2000 })
    expect(second.probedModels).toEqual(['gemini-new'])
    expect(autoMode.parseAutoRanking(backing.get('AI_AUTO_RANKING:CHAT'))[0]).toMatchObject({ provider: 'GROQ', model: 'llama-3.3-70b-versatile' })
    expect(probeCalls.map((call) => `${call.model}:${call.kind}`)).toEqual(['gemini-good:json', 'gemini-good:ocr', 'gemini-new:json', 'gemini-new:ocr'])
    expect(backing.get(manualKey)).toBe('GEMINI,GROQ')
    expect(backing.get('AI_AUTO_PROBE_CURSOR:GEMINI')).toBe('2')
  })

  test('a later catalog refresh adds newly released models and removes retired ones without paid probes', async () => {
    const backing = new Map<string, string>()
    const memStore = makeStore(backing)
    let catalog = ['gemini-old']
    const input = {
      store: memStore,
      providers: ['GEMINI'],
      discover: async () => ({ provider: 'GEMINI', models: [...catalog], discoveryOk: true }),
      capabilitiesForProvider: async () => Object.fromEntries(catalog.map((model) => [model, { text: true, vision: true, costTier: 'free' as const }])),
      rankAfterRefresh: true,
    }
    await autoRefresh.runAutoRefresh({ ...input, nowMs: 1000 })
    expect(autoMode.parseAutoRanking(backing.get('AI_AUTO_RANKING:CHAT')).map((item) => item.model)).toContain('gemini-old')

    catalog = ['gemini-old', 'gemini-just-released']
    const changed = await autoRefresh.runAutoRefresh({ ...input, nowMs: 2000 })
    expect(changed.probes).toEqual([])
    for (const purpose of autoMode.AUTO_PURPOSES) {
      const models = autoMode.parseAutoRanking(backing.get(`AI_AUTO_RANKING:${purpose}`)).map((item) => item.model)
      expect(models).toContain('gemini-just-released')
    }

    catalog = ['gemini-just-released']
    await autoRefresh.runAutoRefresh({ ...input, nowMs: 3000 })
    const models = autoMode.parseAutoRanking(backing.get('AI_AUTO_RANKING:CHAT')).map((item) => item.model)
    expect(models).toContain('gemini-just-released')
    expect(models).not.toContain('gemini-old')
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

describe('first-task auto bootstrap (no synthetic model spend)', () => {
  test('discovers configured providers once, merges seven rankings, and reuses them on the next task', async () => {
    const backing = new Map<string, string>()
    const memStore = makeStore(backing)
    let claims = 0
    let discoveries = 0
    const common = {
      store: memStore,
      providers: ['GEMINI', 'GROQ', 'GEMINI'],
      claim: async () => ++claims === 1,
      discover: async (provider: string) => {
        discoveries++
        return { provider, models: [`${provider.toLowerCase()}-model`], discoveryOk: true }
      },
      capabilitiesForProvider: async () => ({ 'gemini-model': { vision: true, costTier: 'free' as const }, 'groq-model': { vision: false, costTier: 'free' as const } }),
    }
    const first = await autoRefresh.bootstrapAutoRankingsForTask(common)
    expect(first.claimed).toBe(true)
    expect(first.scanned).toEqual(['GEMINI', 'GROQ'])
    expect(first.ranked.sort()).toEqual(['GEMINI', 'GROQ'])
    expect(discoveries).toBe(2)
    expect(autoMode.parseAutoRanking(backing.get('AI_AUTO_RANKING:CHAT')).map((item) => item.provider).sort()).toEqual(['GEMINI', 'GROQ'])
    expect(autoMode.parseAutoRanking(backing.get('AI_AUTO_RANKING:VISION')).some((item) => item.provider === 'GEMINI' && !item.excludedReason)).toBe(true)
    const saved = backing.get('AI_AUTO_RANKING:CHAT')
    const second = await autoRefresh.bootstrapAutoRankingsForTask(common)
    expect(second.claimed).toBe(false)
    expect(discoveries).toBe(2)
    expect(backing.get('AI_AUTO_RANKING:CHAT')).toBe(saved)
  })

  test('one failed catalog cannot prevent an available provider from being ranked', async () => {
    const backing = new Map<string, string>()
    const result = await autoRefresh.bootstrapAutoRankingsForTask({
      store: makeStore(backing), providers: ['BROKEN', 'GOOD'], claim: async () => true,
      discover: async (provider) => provider === 'BROKEN'
        ? { provider, models: [], discoveryOk: false }
        : { provider, models: ['good-model'], discoveryOk: true },
    })
    expect(result.failed).toContain('BROKEN')
    expect(result.ranked).toEqual(['GOOD'])
    expect(autoMode.parseAutoRanking(backing.get('AI_AUTO_RANKING:CHAT')).map((item) => item.model)).toEqual(['good-model'])
  })

  test('the cold task itself waits for ranking before routing; its next call reuses the saved choice', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    values.set('AI_TEXT_PROVIDER', 'ZAI')
    const oldQuery = db.$queryRawUnsafe
    let claims = 0
    db.$queryRawUnsafe = async () => { claims++; return claims === 1 ? [{ key: 'AI_AUTO_TASK_BOOTSTRAP_LAST_RUN' }] : [] }
    zaiRows = [freeRow('glm-4.5')]
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlText = String(url)
      fetchCalls.push(urlText)
      if (urlText.startsWith('https://zai.test/v1/models')) return jsonResponse({ data: zaiRows })
      if (urlText.startsWith('https://zai.test/v1/chat/completions')) return jsonResponse({ choices: [{ message: { content: 'ready' } }] })
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any
    try {
      const request = { system: 'test', history: [{ role: 'user' as const, text: 'hello' }], purpose: 'CHAT' as const }
      expect(await textAi.textAiComplete(request)).toBe('ready')
      expect(claims).toBe(1)
      expect(autoMode.parseAutoRanking(values.get('AI_AUTO_RANKING:CHAT')).some((item) => item.provider === 'ZAI' && item.model === 'glm-4.5')).toBe(true)
      expect(await textAi.textAiComplete(request)).toBe('ready')
      expect(claims).toBe(1)
    } finally {
      db.$queryRawUnsafe = oldQuery
    }
  })
})
