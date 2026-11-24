/// <reference types="bun-types" />
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 5 — smart failover: distinct failure buckets (quota vs dead-key
// vs provider-down vs timeout vs quality), distinct cooldown scopes,
// no retry inside a cooldown, timeout = pausable, post-cooldown probe
// before re-admission, sticky-as-hint at the router level.
const autoMode = await import('../../src/lib/ai-auto-mode')
const { classifyBookReadFailure } = await import('../../src/lib/book-read-job-control')

// Router-level tests need the DB + native-Gemini mocks BEFORE text-ai is
// imported (module top level, like auto-mode-router-seam.test.ts).
const routerDb: any = {
  aiUsageLog: { create: async () => ({}) },
  user: { findUnique: async () => null },
  keyRateWindow: { upsert: async () => ({}), findUnique: async () => ({ count: 1 }) },
  setting: { findMany: async () => [], findUnique: async () => null, upsert: async () => ({}) },
}
mock.module('@/lib/db', () => ({ db: routerDb }))
mock.module('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent: async () => ({ text: '{}' }) } },
}))
const textAi = await import('../../src/lib/text-ai')
const questionBankJob = await import('../../src/lib/question-bank-job')

describe('classifyAutoFailure — distinct buckets, distinct scopes', () => {
  test('429 quota → QUOTA_EXHAUSTED, model scope (key scope only on key/account wording)', () => {
    const model = autoMode.classifyAutoFailure(new Error('rate limit exceeded for model llama-x'), 429)
    expect(model.failureKind).toBe('QUOTA_EXHAUSTED')
    expect(model.cooldownScope).toBe('MODEL')
    const key = autoMode.classifyAutoFailure(new Error('account rate limit exceeded'), 429)
    expect(key.failureKind).toBe('QUOTA_EXHAUSTED')
    expect(key.cooldownScope).toBe('KEY')
  })
  test('402 key-balance exhaustion → NO_BALANCE, key scope; model subscription gap → model scope', () => {
    const key = autoMode.classifyAutoFailure(new Error('insufficient balance, please recharge your account'), 402)
    expect(key.failureKind).toBe('NO_BALANCE')
    expect(key.cooldownScope).toBe('KEY')
    const model = autoMode.classifyAutoFailure(new Error('model only with a subscription'), 402)
    expect(model.failureKind).toBe('NO_BALANCE')
    expect(model.cooldownScope).toBe('MODEL')
  })
  test('401 auth → AUTH, key scope', () => {
    const c = autoMode.classifyAutoFailure(new Error('unauthorized: invalid api key'), 401)
    expect(c.failureKind).toBe('AUTH')
    expect(c.cooldownScope).toBe('KEY')
  })
  test('5xx / network / DNS → PROVIDER_DOWN, provider scope; 503 stays high-demand, not down', () => {
    expect(autoMode.classifyAutoFailure(new Error('boom'), 500).failureKind).toBe('PROVIDER_DOWN')
    expect(autoMode.classifyAutoFailure(new Error('boom'), 502).failureKind).toBe('PROVIDER_DOWN')
    expect(autoMode.classifyAutoFailure(new Error('fetch failed'), undefined).failureKind).toBe('PROVIDER_DOWN')
    expect(autoMode.classifyAutoFailure(new Error('getaddrinfo ENOTFOUND api.x'), undefined).failureKind).toBe('PROVIDER_DOWN')
    expect(autoMode.classifyAutoFailure(new Error('server busy'), 503).failureKind).not.toBe('PROVIDER_DOWN')
    expect(autoMode.classifyAutoFailure(new Error('timeout'), 504).failureKind).toBe('TIMEOUT')
  })
  test('VALIDATION_REJECTED / OCR gate / empty output → OUTPUT_QUALITY, skip-model-only, no key cool', () => {
    const err: any = new Error('bad output')
    err.code = 'VALIDATION_REJECTED'
    const c = autoMode.classifyAutoFailure(err)
    expect(c.failureKind).toBe('OUTPUT_QUALITY')
    expect(c.cooldownScope).toBe('MODEL')
    expect(c.skipModelOnly).toBe(true)
    expect(autoMode.classifyAutoFailure(new Error('OCR_TEXT_FAILED_VERIFICATION')).failureKind).toBe('OUTPUT_QUALITY')
    expect(autoMode.classifyAutoFailure(new Error('OCR_ALL_PAGES_EMPTY')).failureKind).toBe('OUTPUT_QUALITY')
  })
  test('run deadline → TIMEOUT with the distinct TEXT_AI_RUN_TIMEOUT code, no cooldown', () => {
    const err: any = new Error('AI_DEADLINE_EXCEEDED')
    err.code = 'TEXT_AI_RUN_TIMEOUT'
    const c = autoMode.classifyAutoFailure(err)
    expect(c.failureKind).toBe('TIMEOUT')
    expect(c.errorCode).toBe('TEXT_AI_RUN_TIMEOUT')
    expect(c.cooldownScope).toBe('NONE')
    const providerTimeout = autoMode.classifyAutoFailure(new Error('GROQ_PROVIDER_TIMEOUT_20000ms'), 504)
    expect(providerTimeout.errorCode).toBe('AI_PROVIDER_TIMEOUT')
    expect(providerTimeout.errorCode).not.toBe('TEXT_AI_RUN_TIMEOUT')
  })
  test('dead model 404 → UNSUPPORTED_CAPABILITY, model scope', () => {
    expect(autoMode.classifyAutoFailure(new Error('model does not exist'), 404).failureKind).toBe('UNSUPPORTED_CAPABILITY')
  })
})

describe('provider-down tracking + post-cooldown probe gate', () => {
  test('one 5xx is not provider-down; 3 hits across >= 2 models in 60s is', () => {
    let state = autoMode.emptyProviderDownState()
    let r = autoMode.recordProviderDownHit(state, 'GROQ', 'model-a', 1000)
    expect(r.providerDown).toBe(false)
    state = r.state
    r = autoMode.recordProviderDownHit(state, 'GROQ', 'model-a', 2000)
    expect(r.providerDown).toBe(false)
    state = r.state
    r = autoMode.recordProviderDownHit(state, 'GROQ', 'model-b', 3000)
    expect(r.providerDown).toBe(true)
    expect(r.hitsInWindow).toBe(3)
    expect(r.distinctModels).toBe(2)
  })
  test('hits outside the 60s window do not accumulate', () => {
    let state = autoMode.emptyProviderDownState()
    let r = autoMode.recordProviderDownHit(state, 'GROQ', 'model-a', 1000)
    state = r.state
    r = autoMode.recordProviderDownHit(state, 'GROQ', 'model-b', 2000)
    state = r.state
    r = autoMode.recordProviderDownHit(state, 'GROQ', 'model-a', 1000 + 62_000)
    expect(r.providerDown).toBe(false)
    expect(r.hitsInWindow).toBe(1)
  })
  test('quota provider excluded until cooldown expires AND one successful probe', () => {
    const now = Date.now()
    // Still cooling: excluded, no probe can admit it yet.
    expect(autoMode.failoverProviderGate({ cooldownUntilMs: now + 600_000, nowMs: now }).excluded).toBe(true)
    // Cooldown expired, no probe yet: still excluded, probe required.
    const gate = autoMode.failoverProviderGate({ cooldownUntilMs: now - 1000, nowMs: now })
    expect(gate.excluded).toBe(true)
    expect(gate.needsProbe).toBe(true)
    // Probe ran before the cooldown ended: does not count.
    expect(autoMode.failoverProviderGate({ cooldownUntilMs: now - 1000, lastProbeOkAtMs: now - 2000, nowMs: now }).excluded).toBe(true)
    // Successful probe after the cooldown ended: re-admitted.
    expect(autoMode.failoverProviderGate({ cooldownUntilMs: now - 1000, lastProbeOkAtMs: now - 500, nowMs: now }).excluded).toBe(false)
    // Never cooled: not excluded at all.
    expect(autoMode.failoverProviderGate({ nowMs: now }).excluded).toBe(false)
  })
})

describe('run timeout is pausable, never exhaustion', () => {
  test('TEXT_AI_RUN_TIMEOUT classifies TRANSIENT for book reads', () => {
    expect(classifyBookReadFailure('provider failed: TEXT_AI_RUN_TIMEOUT')).toBe('TRANSIENT')
    expect(classifyBookReadFailure('BOOK_READ_TIME_BUDGET_EXHAUSTED')).toBe('TRANSIENT')
    expect(autoMode.isRunTimeoutError('AI_DEADLINE_EXCEEDED')).toBe(true)
    expect(autoMode.isRunTimeoutError('TEXT_AI_ROUTER_FAILED')).toBe(false)
  })
})

describe('router level — quota, provider-down, quality, timeout', () => {
  const values = new Map<string, string>()
  const originalFetch = globalThis.fetch
  const originalEnv: Record<string, string | undefined> = {
    GROQ_API_KEY: process.env.GROQ_API_KEY,
  }
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
  const GROQ_MODELS = ['groq-model-a', 'groq-model-b', 'groq-model-c']
  function installFetch(behaviour: { chat?: (model: string) => number } = {}) {
    const chatCalls: Array<{ url: string; model: string }> = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      if (urlText.endsWith('/models')) {
        return jsonResponse({ data: GROQ_MODELS.map((id) => ({ id, context_length: 131072 })) })
      }
      if (urlText.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body || '{}'))
        chatCalls.push({ url: urlText, model: body.model })
        const status = behaviour.chat?.(body.model) ?? 200
        if (status !== 200) return jsonResponse({ error: { message: 'boom' } }, status)
        return jsonResponse({ choices: [{ message: { content: `{"ok":"${body.model}"}` } }] })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any
    return chatCalls
  }

  beforeEach(() => {
    values.clear()
    globalThis.fetch = originalFetch
    delete process.env.GROQ_API_KEY
    textAi.__resetTextAiStateForTests()
    textAi.__setTextAiSettingStoreForTests(store)
  })
  afterEach(() => { globalThis.fetch = originalFetch })
  afterAll(() => {
    textAi.__setTextAiSettingStoreForTests(null)
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  function groqOnly() {
    process.env.GROQ_API_KEY=<redacted>
    values.set('GROQ_TEXT_MODEL', 'groq-model-a')
  }

  test('quota: 429 cools the model/key and the provider is not retried within the cooldown', async () => {
    groqOnly()
    const calls = installFetch({ chat: () => 429 })
    await expect(textAi.textAiCompleteJson({ system: 't', history: [{ role: 'user', text: 'hi' }] }))
      .rejects.toThrow(/groq-model-a/)
    expect(calls.length).toBeGreaterThan(0)
    const firstCallCount = calls.length
    // Second call inside the cooldown: no new provider attempt at all.
    await expect(textAi.textAiCompleteJson({ system: 't', history: [{ role: 'user', text: 'hi' }] }))
      .rejects.toThrow(/COOLDOWN/)
    expect(calls.length).toBe(firstCallCount)
  })

  test('provider-down: 500s across 3 models cool the whole provider; the next call makes no attempt', async () => {
    groqOnly()
    const calls = installFetch({ chat: () => 500 })
    await expect(textAi.textAiCompleteJson({ system: 't', history: [{ role: 'user', text: 'hi' }] }))
      .rejects.toThrow(/groq-model-a/)
    const attemptedModels = [...new Set(calls.map((c) => c.model))]
    expect(attemptedModels.length).toBeGreaterThanOrEqual(2)
    const firstCallCount = calls.length
    await expect(textAi.textAiCompleteJson({ system: 't', history: [{ role: 'user', text: 'hi' }] }))
      .rejects.toThrow(/COOLDOWN|PROVIDER_DOWN/)
    expect(calls.length).toBe(firstCallCount)
  })

  test('quality: VALIDATION_REJECTED skips the model but does NOT cool the key — the next model is tried in the same call', async () => {
    groqOnly()
    const calls = installFetch()
    const reply = await textAi.textAiCompleteJson({
      system: 't', history: [{ role: 'user', text: 'hi' }],
      preferredModels: [
        { provider: 'GROQ', model: 'groq-model-a' },
        { provider: 'GROQ', model: 'groq-model-b' },
      ],
      validate: (_text, ctx) => {
        if (ctx?.model === 'groq-model-a') {
          // The message deliberately mentions a timeout: the OUTPUT_QUALITY
          // bucket must win over the timeout classifier, so this rejection
          // skips the model WITHOUT cooling it (or its key).
          const err: any = new Error('garbage output after timeout')
          err.code = 'VALIDATION_REJECTED'
          throw err
        }
      },
    })
    expect(reply).toContain('groq-model-b')
    expect(calls.map((c) => c.model)).toEqual(['groq-model-a', 'groq-model-b'])
    // And the rejected model is NOT cooled: a fresh call can attempt it again.
    const calls2 = installFetch()
    const reply2 = await textAi.textAiCompleteJson({
      system: 't', history: [{ role: 'user', text: 'hi' }],
      preferredModels: [{ provider: 'GROQ', model: 'groq-model-a' }],
    })
    expect(reply2).toContain('groq-model-a')
    expect(calls2.map((c) => c.model)).toEqual(['groq-model-a'])
  })

  test('timeout: a past run deadline throws TEXT_AI_RUN_TIMEOUT, distinct from router failure', async () => {
    groqOnly()
    installFetch()
    let code: unknown
    try {
      await textAi.textAiCompleteJson({
        system: 't', history: [{ role: 'user', text: 'hi' }], deadlineMs: Date.now() - 1,
      })
    } catch (e: any) {
      code = e?.code
    }
    expect(code).toBe('TEXT_AI_RUN_TIMEOUT')
  })

  test('timeout is pausable for question-bank jobs (job keeps progress, never FAILED as exhausted)', () => {
    expect(questionBankJob.isPausableQuestionBankError('TEXT_AI_RUN_TIMEOUT')).toBe(true)
    expect(questionBankJob.isPausableQuestionBankError('AI_DEADLINE_EXCEEDED')).toBe(true)
    expect(questionBankJob.isPausableQuestionBankError('BOOK_READ_TIME_BUDGET_EXHAUSTED')).toBe(true)
    expect(questionBankJob.isPausableQuestionBankError('some content error')).toBe(false)
  })

  test('sticky-as-hint at the router: auto ON, sticky model is NOT first when the ranking puts another model on top', async () => {
    groqOnly()
    values.set('AI_STICKY_ON_SUCCESS', 'true')
    const calls = installFetch()
    // NOTE: sticky only engages for non-GENERAL task levels
    // (stickyScopeForRequest returns null for GENERAL non-verifier
    // calls), so both calls use ACADEMIC_DRAFT — without it this test
    // would be vacuous (no sticky ever set).
    const taskLevel = 'ACADEMIC_DRAFT' as const
    // Call 1 (auto OFF): succeeds on groq-model-a → sticky pins it.
    const first = await textAi.textAiCompleteJson({
      system: 't', history: [{ role: 'user', text: 'hi' }], taskLevel,
      preferredModels: [{ provider: 'GROQ', model: 'groq-model-a' }],
    })
    expect(first).toContain('groq-model-a')
    // Call 2 (auto ON): ranking puts groq-model-b on top. Sticky is a
    // hint, not a pin — the ranking order wins and B is attempted first.
    values.set('AI_AUTO_MODE_ENABLED', '1')
    values.set('AI_AUTO_RANKING:CHAT', JSON.stringify({ candidates: [
      { provider: 'GROQ', model: 'groq-model-b' },
      { provider: 'GROQ', model: 'groq-model-a' },
    ] }))
    const before = calls.length
    const second = await textAi.textAiCompleteJson({ system: 't', history: [{ role: 'user', text: 'hi' }], taskLevel })
    expect(second).toContain('groq-model-b')
    expect(calls[before].model).toBe('groq-model-b')
  })
})
