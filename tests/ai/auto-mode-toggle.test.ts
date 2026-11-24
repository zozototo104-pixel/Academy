/// <reference types="bun-types" />
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 1 — Part 1 toggle + override contract. The router is driven for
// real with stubbed HTTP (same pattern as tests/ai/ai-apinex-provider.test.ts
// and tests/books/book-ocr-router-failover.test.ts); strict-provider keys
// (GROQ, OPENAI_COMPAT) come via process.env because plaintext Setting
// rows for those providers are dropped by decryptSettingValue
// (text-ai.ts:1156/1176 — step-0 spike finding).
const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const originalEnv: Record<string, string | undefined> = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  OPENAI_COMPAT_API_KEY: process.env.OPENAI_COMPAT_API_KEY,
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
const stageRunner = await import('../../src/lib/ai-stage-runner')
const stageProfiles = await import('../../src/lib/ai-stage-profiles')

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

// Records every provider attempt (discovery /models calls excluded).
function installFetch() {
  const calls: Array<{ url: string; model: string }> = []
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url)
    if (urlText.includes('generativelanguage.googleapis.com/v1beta/models?')) {
      return jsonResponse({ models: [
        { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      ] })
    }
    if (urlText.includes(':generateContent')) {
      const model = decodeURIComponent(urlText.split('/models/')[1].split(':')[0])
      calls.push({ url: urlText, model })
      return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"ok":"gemini"}' }] } }] })
    }
    if (urlText.endsWith('/models')) {
      return jsonResponse({ data: [{ id: 'llama-3.3-70b-versatile', context_length: 131072 }] })
    }
    if (urlText.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body || '{}'))
      calls.push({ url: urlText, model: body.model })
      return jsonResponse({ choices: [{ message: { content: '{"ok":"groq"}' } }] })
    }
    throw new Error(`unexpected fetch: ${urlText}`)
  }) as any
  return calls
}

function configureTwoProviders() {
  values.set('AI_TEXT_PROVIDER', 'GEMINI')
  values.set('AI_PROVIDER_FALLBACK_ORDER', 'GEMINI,GROQ')
  values.set('GEMINI_API_KEY', 'test-gemini-key')
  values.set('GEMINI_TEXT_MODEL', 'gemini-3.5-flash-lite')
  values.set('GROQ_TEXT_MODEL', 'llama-3.3-70b-versatile')
  process.env.GROQ_API_KEY = 'gsk-test-key'
}

const MANUAL_KEYS = [
  'AI_TEXT_PROVIDER', 'AI_ROUTER_POLICY', 'AI_PROVIDER_FALLBACK_ORDER',
  'AI_PROVIDER_FALLBACK_ORDER_ENABLED', 'GEMINI_TEXT_MODEL', 'GROQ_TEXT_MODEL',
  'AI_PAID_USAGE_MODE', 'AI_PAID_MODELS',
]

beforeEach(() => {
  values.clear()
  globalThis.fetch = originalFetch
  delete process.env.GROQ_API_KEY
  delete process.env.OPENAI_COMPAT_API_KEY
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  stageProfiles.__setStageProfileStoreForTests(null)
})

afterAll(() => {
  textAi.__setTextAiSettingStoreForTests(null)
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('auto-mode toggle (pure helpers)', () => {
  test('toggle is OFF by default: empty, 0, false and garbage all read OFF', () => {
    expect(autoMode.isAutoModeEnabled(undefined)).toBe(false)
    expect(autoMode.isAutoModeEnabled({})).toBe(false)
    expect(autoMode.isAutoModeEnabled({ AI_AUTO_MODE_ENABLED: '' })).toBe(false)
    expect(autoMode.isAutoModeEnabled({ AI_AUTO_MODE_ENABLED: '0' })).toBe(false)
    expect(autoMode.isAutoModeEnabled({ AI_AUTO_MODE_ENABLED: 'false' })).toBe(false)
    expect(autoMode.isAutoModeEnabled({ AI_AUTO_MODE_ENABLED: 'nope' })).toBe(false)
    expect(autoMode.isAutoModeEnabled({ autoMode: false })).toBe(false)
  })

  test('toggle reads ON from 1 / true / the settings() shape', () => {
    expect(autoMode.isAutoModeEnabled({ AI_AUTO_MODE_ENABLED: '1' })).toBe(true)
    expect(autoMode.isAutoModeEnabled({ AI_AUTO_MODE_ENABLED: 'true' })).toBe(true)
    expect(autoMode.isAutoModeEnabled({ autoMode: true })).toBe(true)
    expect(autoMode.isAutoModeEnabled('1')).toBe(true)
  })

  test('config parse falls back to defaults per field on bad JSON', () => {
    expect(autoMode.parseAutoModeConfig('')).toEqual(autoMode.DEFAULT_AUTO_MODE_CONFIG)
    expect(autoMode.parseAutoModeConfig('not-json')).toEqual(autoMode.DEFAULT_AUTO_MODE_CONFIG)
    expect(autoMode.parseAutoModeConfig('{"explorationRate":2}')).toEqual({
      ...autoMode.DEFAULT_AUTO_MODE_CONFIG, explorationRate: 1,
    })
    expect(autoMode.parseAutoModeConfig('{"refreshIntervalMinutes":30}')).toEqual({
      ...autoMode.DEFAULT_AUTO_MODE_CONFIG, refreshIntervalMinutes: 30,
    })
  })

  test('ranking parse drops invalid rows and dedupes, never invents models', () => {
    const parsed = autoMode.parseAutoRanking(JSON.stringify({
      candidates: [
        { provider: 'GROQ', model: 'llama-3.3-70b-versatile', score: 0.9 },
        { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
        { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' },
        { provider: '', model: 'x' },
        { provider: 'GROQ', model: '' },
      ],
    }))
    expect(parsed).toEqual([
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile', score: 0.9 },
      { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' },
    ])
    expect(autoMode.parseAutoRanking('garbage')).toEqual([])
    expect(autoMode.parseAutoRanking('')).toEqual([])
  })

  test('modelCapabilitiesFor returns null on a cold discovery cache', async () => {
    textAi.__resetTextAiStateForTests()
    expect(await textAi.__testModelCapabilitiesForTests('GROQ', 'llama-3.3-70b-versatile')).toBeNull()
  })

  test('auto ranking bypasses manual strict allowlists but normal routing keeps them', () => {
    const args = { provider: 'GROQ' as const, models: ['llama-3.3-70b-versatile'], taskLevel: 'ACADEMIC_CRITICAL' as const, academicAllowlist: 'GEMINI:gemini-2.5-pro', academicStrict: true }
    expect(textAi.__testStrictCandidateModelsForTests(args)).toEqual([])
    expect(textAi.__testStrictCandidateModelsForTests({ ...args, autoOverride: true })).toEqual(['llama-3.3-70b-versatile'])
    const verifierArgs = { ...args, verifierCall: true, verifierStrict: true, verifierPreferred: 'GEMINI:gemini-2.5-pro' }
    expect(textAi.__testStrictCandidateModelsForTests(verifierArgs)).toEqual([])
    expect(textAi.__testStrictCandidateModelsForTests({ ...verifierArgs, autoOverride: true })).toEqual(['llama-3.3-70b-versatile'])
  })
})

describe('resolveAutoCandidates (pure choke point)', () => {
  const ranking = [
    { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
    { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' },
  ]
  test('OFF is a no-op passthrough', () => {
    const out = autoMode.resolveAutoCandidates({
      autoMode: false, ranking,
      preferredProviders: ['GEMINI'], preferredModels: [{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }],
      restrictToModels: [{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }],
    })
    expect(out.autoOverride).toBe(false)
    expect(out.preferredProviders).toEqual(['GEMINI'])
    expect(out.restrictToModels).toEqual([{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }])
  })

  test('ON replaces inputs with the ranking and ignores restrictToModels', () => {
    const out = autoMode.resolveAutoCandidates({
      autoMode: true, ranking,
      preferredProviders: ['GEMINI'], preferredModels: [{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }],
      restrictToModels: [{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }],
    })
    expect(out.autoOverride).toBe(true)
    expect(out.preferredProviders).toEqual(['GROQ', 'GEMINI'])
    expect(out.preferredModels).toEqual([
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
      { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' },
    ])
    expect(out.restrictToModels).toBeUndefined()
    expect(out.overriddenRestrictToModels).toEqual([{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }])
  })

  test('ON with an empty ranking falls back to the manual inputs', () => {
    const out = autoMode.resolveAutoCandidates({
      autoMode: true, ranking: [],
      preferredProviders: ['GEMINI'], preferredModels: [{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }],
    })
    expect(out.autoOverride).toBe(false)
    expect(out.preferredProviders).toEqual(['GEMINI'])
  })

  test('exclusions are never overridden by the ranking', () => {
    const out = autoMode.resolveAutoCandidates({
      autoMode: true, ranking,
      excludeProviders: ['GROQ'],
      excludeModelFamilies: ['gemini'],
      modelFamily: (_p, m) => (m.includes('gemini') ? 'gemini' : 'llama'),
    })
    expect(out.autoCandidates).toEqual([])
    expect(out.autoOverride).toBe(false)
    expect(out.excludedReasons).toContain('GROQ:llama-3.3-70b-versatile EXCLUDED_PROVIDER')
    expect(out.excludedReasons).toContain('GEMINI:gemini-3.5-flash-lite EXCLUDED_FAMILY')
  })

  test('paid-blocked models are dropped from the ranking', () => {
    const out = autoMode.resolveAutoCandidates({
      autoMode: true,
      ranking: [{ provider: 'OPENAI_COMPAT', model: 'gpt-5-pro' }, { provider: 'GROQ', model: 'llama-3.3-70b-versatile' }],
      paidBlockedModels: ['gpt-5-pro'],
    })
    expect(out.autoCandidates).toEqual([{ provider: 'GROQ', model: 'llama-3.3-70b-versatile' }])
    expect(out.excludedReasons).toContain('OPENAI_COMPAT:gpt-5-pro PAID_BLOCKED')
  })
})

describe('toggle OFF parity at the router', () => {
  test('OFF: manual order wins — Gemini first, Groq never attempted', async () => {
    configureTwoProviders()
    const calls = installFetch()
    const reply = await textAi.textAiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'hi' }] })
    expect(reply).toBe('{"ok":"gemini"}')
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe('gemini-3.5-flash-lite')
    expect(calls[0].url).toContain('generativelanguage.googleapis.com')
  })

  test('OFF: a stage-profile restrictToModels still pins the provider', async () => {
    configureTwoProviders()
    const calls = installFetch()
    const reply = await textAi.textAiCompleteJson({
      system: 'test', history: [{ role: 'user', text: 'hi' }],
      restrictToModels: [{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }],
    })
    expect(reply).toBe('{"ok":"gemini"}')
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe('gemini-3.5-flash-lite')
  })
})

describe('toggle ON override at the router', () => {
  test('ON: the auto ranking beats the manual order (Groq first)', async () => {
    configureTwoProviders()
    values.set('AI_AUTO_MODE_ENABLED', '1')
    values.set('AI_AUTO_RANKING:CHAT', JSON.stringify({ candidates: [
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
      { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' },
    ] }))
    const calls = installFetch()
    const reply = await textAi.textAiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'hi' }] })
    expect(reply).toBe('{"ok":"groq"}')
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe('llama-3.3-70b-versatile')
    expect(calls[0].url).toContain('api.groq.com')
  })

  test('ON: restrictToModels is ignored for ranking (Groq attempted, not Gemini)', async () => {
    configureTwoProviders()
    values.set('AI_AUTO_MODE_ENABLED', '1')
    values.set('AI_AUTO_RANKING:CHAT', JSON.stringify({ candidates: [
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
    ] }))
    const calls = installFetch()
    const reply = await textAi.textAiCompleteJson({
      system: 'test', history: [{ role: 'user', text: 'hi' }],
      restrictToModels: [{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }],
    })
    expect(reply).toBe('{"ok":"groq"}')
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe('llama-3.3-70b-versatile')
  })

  test('ON with an empty ranking falls back to the manual order', async () => {
    configureTwoProviders()
    values.set('AI_AUTO_MODE_ENABLED', '1')
    values.set('AI_AUTO_RANKING:CHAT', JSON.stringify({ candidates: [] }))
    const calls = installFetch()
    const reply = await textAi.textAiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'hi' }] })
    expect(reply).toBe('{"ok":"gemini"}')
    expect(calls[0].model).toBe('gemini-3.5-flash-lite')
  })

  test('ON: a paid-listed model is never attempted while paid usage is off', async () => {
    configureTwoProviders()
    values.set('AI_AUTO_MODE_ENABLED', '1')
    values.set('AI_PAID_USAGE_MODE', 'off')
    values.set('AI_PAID_MODELS', 'gpt-5-pro')
    values.set('OPENAI_COMPAT_BASE_URL', 'https://compat.test/v1')
    process.env.OPENAI_COMPAT_API_KEY = 'compat-test-key'
    values.set('AI_AUTO_RANKING:CHAT', JSON.stringify({ candidates: [
      { provider: 'OPENAI_COMPAT', model: 'gpt-5-pro' },
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
    ] }))
    const calls = installFetch()
    const reply = await textAi.textAiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'hi' }] })
    expect(reply).toBe('{"ok":"groq"}')
    expect(calls.some((c) => c.model === 'gpt-5-pro')).toBe(false)
    expect(calls[0].model).toBe('llama-3.3-70b-versatile')
  })

  test('a background probe targets a provider missing from the manual order and never skews live stats', async () => {
    configureTwoProviders()
    values.set('AI_AUTO_MODE_ENABLED', '1')
    values.set('AI_PROVIDER_FALLBACK_ORDER', 'GEMINI')
    values.set('AI_AUTO_RANKING:CHAT', JSON.stringify({ candidates: [{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }] }))
    const calls = installFetch()
    const result = await textAi.textAiCompleteWithMetadata({
      system: 'probe', history: [{ role: 'user', text: 'probe' }], purpose: 'CHAT',
      skipAutoSelection: true,
      restrictToModels: [{ provider: 'GROQ', model: 'llama-3.3-70b-versatile' }],
    })
    expect(result.provider).toBe('GROQ')
    expect(result.model).toBe('llama-3.3-70b-versatile')
    expect(calls.map((call) => call.model)).toEqual(['llama-3.3-70b-versatile'])
    expect(values.has('AI_MODEL_STATS:CHAT:GROQ:llama-3.3-70b-versatile')).toBe(false)
    expect([...values.keys()].some((key) => key.startsWith('AI_AUTO_STICKY:'))).toBe(false)
  })
})

describe('toggle round-trip preserves manual keys', () => {
  test('ON then OFF writes nothing to manual keys', async () => {
    configureTwoProviders()
    values.set('AI_ROUTER_POLICY', 'primary_first')
    const before = new Map(values)
    // The admin save writes exactly one key: the toggle itself.
    values.set('AI_AUTO_MODE_ENABLED', '1')
    values.set('AI_AUTO_RANKING:CHAT', JSON.stringify({ candidates: [
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
    ] }))
    const onCalls = installFetch()
    await textAi.textAiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'hi' }] })
    expect(onCalls[0].model).toBe('llama-3.3-70b-versatile')
    values.set('AI_AUTO_MODE_ENABLED', '0')
    textAi.__resetTextAiStateForTests()
    const offCalls = installFetch()
    await textAi.textAiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'hi' }] })
    expect(offCalls[0].model).toBe('gemini-3.5-flash-lite')
    for (const key of MANUAL_KEYS) expect(values.get(key)).toBe(before.get(key))
    const changed = [...values.keys()].filter((key) => values.get(key) !== before.get(key))
    // Only the toggle/config keys may change, plus the router's own
    // pre-existing runtime writes (per-model stats + the persistent
    // discovery cache) — never a manual config key.
    expect(changed.every((key) => key.startsWith('AI_AUTO_') || key.startsWith('AI_MODEL_STATS:') || key.startsWith('AI_MODELS_AVAILABLE:'))).toBe(true)
    expect(changed).toContain('AI_AUTO_MODE_ENABLED')
  })
})

describe('stage-profile override telemetry', () => {
  const snapshot = {
    enabled: true, provider: 'GEMINI', policy: null,
    models: [{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }],
    allowGlobalFallback: true, verifier: null,
  }
  function installProfileStore() {
    stageProfiles.__setStageProfileStoreForTests({
      async loadCurrent() { return { profileId: 'profile-1', version: 2, snapshot } },
      async saveVersion() { return { profileId: 'profile-1', version: 3 } },
      async loadVersions() { return [] },
    })
  }

  test('OFF: no autoOverride is recorded', async () => {
    installProfileStore()
    const plan = await stageRunner.prepareStageRun('GENERATION')
    expect(plan.isStage).toBe(true)
    expect(plan.detail.autoOverride).toBeUndefined()
  })

  test('ON: the overridden stage list is recorded in detail.autoOverride', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    installProfileStore()
    const plan = await stageRunner.prepareStageRun('GENERATION')
    expect(plan.isStage).toBe(true)
    const override = plan.detail.autoOverride as Record<string, unknown>
    expect(override.autoOverride).toBe(true)
    expect(override.overriddenRestrictToModels).toEqual(['GEMINI:gemini-3.5-flash-lite'])
    expect(override.stageProfile).toEqual({ profileId: 'profile-1', version: 2 })
    // The profile itself is untouched: routing + stamp still carry it.
    expect(plan.profileStamp?.profileId).toBe('profile-1')
    expect(plan.profileStamp?.profileVersion).toBe('2')
  })
})
