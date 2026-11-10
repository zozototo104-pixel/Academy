import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetTextAiStateForTests,
  __setTextAiSettingStoreForTests,
  __testAcademicProviderUnavailableCodeForTests,
  __testApplyTransientModelFailureCooldownForTests,
  __testHighDemandCooldownDecisionForTests,
  __testPrimaryProviderOrder,
  __testResolveRouterPolicyForTests,
  __testStickyCandidateOrderForTests,
  __testStickyScopeForTests,
  __testStrictCandidateModelsForTests,
  textAiComplete,
} from '../../src/lib/text-ai'
import { verifyQuestionsWithCrossProvider } from '../../src/lib/question-verifier'
import { isPausableQuestionBankError } from '../../src/lib/question-bank-job'

const originalFetch = globalThis.fetch
const originalOpenAiCompatApiKeys = process.env.OPENAI_COMPAT_API_KEYS

function fakeSettingStore(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial))
  return {
    async read(keys: string[]) {
      return Object.fromEntries(keys.map((key) => [key, values.get(key) || '']))
    },
    async write(key: string, value: string) {
      values.set(key, value)
    },
    async delete(key: string) {
      values.delete(key)
    },
    async increment(key: string, amount: number) {
      const next = (Number(values.get(key) || 0) || 0) + amount
      values.set(key, String(next))
      return next
    },
    async scan(prefix: string) {
      return Object.fromEntries(Array.from(values.entries()).filter(([key]) => key.startsWith(prefix)))
    },
  }
}

describe('router admin policy B1', () => {
  test('APINEX subscription-only model 402 keeps the same key available for the next model', async () => {
    const store = fakeSettingStore({
      AI_TEXT_PROVIDER: 'APINEX',
      AI_ROUTER_POLICY_SOURCE: 'admin',
      AI_ROUTER_POLICY: 'fallback_only',
      APINEX_API_KEY: 'test-key-not-a-secret',
      APINEX_TEXT_MODEL: 'free/glm-5.3-flashx,free/deepseek-v4.1-flash',
    })
    __setTextAiSettingStoreForTests(store)
    const attempted: string[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      const model = JSON.parse(String(init?.body || '{}')).model
      attempted.push(model)
      if (model === 'free/glm-5.3-flashx') {
        return new Response(JSON.stringify({ error: { message: 'This model is currently available only with a subscription. Buy a subscription at https://apinex.bond/subscriptions to use it.' } }), { status: 402 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Working model response' } }] }), { status: 200 })
    }) as any
    const answer = await textAiComplete({
      system: 'Answer the user', history: [{ role: 'user', text: 'Hello' }],
      preferredModels: [{ provider: 'APINEX', model: 'free/glm-5.3-flashx' }],
      restrictToModels: [
        { provider: 'APINEX', model: 'free/glm-5.3-flashx' },
        { provider: 'APINEX', model: 'free/deepseek-v4.1-flash' },
      ],
    })
    expect(answer).toContain('Working model response')
    expect(attempted).toContain('free/glm-5.3-flashx')
    expect(attempted).toContain('free/deepseek-v4.1-flash')
    expect(await store.scan('AI_NO_BALANCE:APINEX:')).toEqual({})
  })

  test('explicit APINEX account credit exhaustion persists a key-wide block', async () => {
    const store = fakeSettingStore({
      AI_TEXT_PROVIDER: 'APINEX', AI_ROUTER_POLICY_SOURCE: 'admin', AI_ROUTER_POLICY: 'fallback_only',
      APINEX_API_KEY: 'test-key-not-a-secret', APINEX_TEXT_MODEL: 'free/glm-5.3-flashx',
    })
    __setTextAiSettingStoreForTests(store)
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      return new Response(JSON.stringify({ error: { message: 'You have no credits remaining. Add credits to continue using the API.' } }), { status: 402 })
    }) as any
    try {
      await textAiComplete({ system: 'Answer', history: [{ role: 'user', text: 'Hello' }],
        restrictToModels: [{ provider: 'APINEX', model: 'free/glm-5.3-flashx' }] })
    } catch { /* No other provider is permitted in this test. */ }
    const blocks = await store.scan('AI_NO_BALANCE:APINEX:')
    expect(Object.keys(blocks)).toHaveLength(1)
    expect(Object.values(blocks)[0]).toContain('no credits remaining')
  })

  test('APINEX per-minute 429 escalates to a SHORT key cooldown from the provider retry hint, not the 15-minute default', async () => {
    const store = fakeSettingStore({
      AI_TEXT_PROVIDER: 'APINEX',
      AI_ROUTER_POLICY_SOURCE: 'admin',
      AI_ROUTER_POLICY: 'fallback_only',
      APINEX_API_KEY: 'test-key-not-a-secret',
      APINEX_TEXT_MODEL: 'free/glm-5.3-flashx,free/deepseek-v4.1-flash,free/minimax-m3.1-flash',
    })
    __setTextAiSettingStoreForTests(store)
    const attempted: string[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      const model = JSON.parse(String(init?.body || '{}')).model
      attempted.push(model)
      if (model === 'free/minimax-m3.1-flash') {
        return new Response(JSON.stringify({ choices: [{ message: { content: 'Third model response' } }] }), { status: 200 })
      }
      // APINEX's account-wide cap from gate #718: 15 requests per minute for
      // the whole account, with the provider's own short retry hint. The cap
      // is account-level evidence, so a key cooldown is correct — but its
      // length must come from the hint (~1 minute), never from the
      // 15-minute general fallback the pre-fix call sites dropped to.
      return new Response(
        JSON.stringify({ error: { message: 'Rate limit exceeded: this account is limited to 15 requests per minute. Please retry in 14 seconds.' } }),
        { status: 429, headers: { 'retry-after': '14' } },
      )
    }) as any
    const startedAt = Date.now()
    try {
      await textAiComplete({
        system: 'Answer the user', history: [{ role: 'user', text: 'Hello' }],
        restrictToModels: [
          { provider: 'APINEX', model: 'free/glm-5.3-flashx' },
          { provider: 'APINEX', model: 'free/deepseek-v4.1-flash' },
          { provider: 'APINEX', model: 'free/minimax-m3.1-flash' },
        ],
      })
    } catch { /* The key ban may legitimately block the third model mid-request. */ }
    expect(attempted).toContain('free/glm-5.3-flashx')
    expect(attempted).toContain('free/deepseek-v4.1-flash')
    const rows = await store.scan('AI_COOLDOWN:APINEX:')
    const keyRow = rows['AI_COOLDOWN:APINEX:1']
    expect(keyRow).toBeTruthy()
    const payload = JSON.parse(keyRow)
    expect(payload.status).toBe(429)
    const untilMs = Date.parse(payload.until)
    expect(untilMs).toBeGreaterThan(startedAt)
    // ~1 minute from the provider's 14-second hint (rounded up), with slack
    // for execution time — and decisively NOT the 15 minutes recorded in the
    // QA database during gate #718 (ban written until +15:00 pre-fix).
    expect(untilMs).toBeLessThan(startedAt + 4 * 60_000)
    expect(rows['AI_COOLDOWN:APINEX:1:free/glm-5.3-flashx']).toBeTruthy()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalOpenAiCompatApiKeys === undefined) delete process.env.OPENAI_COMPAT_API_KEYS
    else process.env.OPENAI_COMPAT_API_KEYS = originalOpenAiCompatApiKeys
    __setTextAiSettingStoreForTests(null)
    __resetTextAiStateForTests()
  })

  test('testProviderOrderUnchanged keeps the legacy primary provider order snapshot', () => {
    // APINEX appended as a rear reserve (PR #153), then OXION appended after
    // it as the newest gateway reserve (2026-10-30); the rest untouched.
    expect(__testPrimaryProviderOrder()).toEqual([
      'GEMINI',
      'UNOROUTER',
      'OPENROUTER',
      'TOPTOOLS',
      'OPENAI',
      'ANTHROPIC',
      'ZAI',
      'GROQ',
      'RELAYROUTER',
      'DEEPINFRA',
      'TOGETHER',
      'OPENAI_COMPAT',
      'ALBORIHI',
      'MISTRAL',
      'CLOUDFLARE',
      'APINEX',
      'OXION',
    ])
  })

  test('strict=false preserves the current academic candidate order', () => {
    const models = ['claude-sonnet-5', 'gpt-5.6-luna', 'claude-opus-4-6']
    expect(__testStrictCandidateModelsForTests({
      provider: 'ALBORIHI',
      models,
      taskLevel: 'ACADEMIC_CRITICAL',
      academicAllowlist: 'ALBORIHI:claude-sonnet-5',
      academicStrict: false,
    })).toEqual(models)
  })

  test('strict=true keeps only academic allowlist models and uses the existing academic unavailable code', () => {
    expect(__testStrictCandidateModelsForTests({
      provider: 'ALBORIHI',
      models: ['claude-sonnet-5', 'gpt-5.6-luna', 'claude-opus-4-6'],
      taskLevel: 'ACADEMIC_CRITICAL',
      academicAllowlist: 'ALBORIHI:claude-sonnet-5',
      academicStrict: true,
    })).toEqual(['claude-sonnet-5'])

    expect(__testStrictCandidateModelsForTests({
      provider: 'ALBORIHI',
      models: ['gpt-5.6-luna', 'claude-opus-4-6'],
      taskLevel: 'ACADEMIC_CRITICAL',
      academicAllowlist: 'ALBORIHI:claude-sonnet-5',
      academicStrict: true,
    })).toEqual([])

    expect(__testAcademicProviderUnavailableCodeForTests()).toBe('AI_ACADEMIC_PROVIDER_UNAVAILABLE')
  })

  test('verifier strict uses only preferred verifier models and pending review remains the no-AI fallback contract', async () => {
    expect(__testStrictCandidateModelsForTests({
      provider: 'OPENAI',
      models: ['gpt-5.1', 'gpt-4o'],
      verifierCall: true,
      verifierStrict: true,
      verifierPreferred: 'OPENAI:gpt-5.1',
    })).toEqual(['gpt-5.1'])

    expect(__testStrictCandidateModelsForTests({
      provider: 'OPENAI',
      models: ['gpt-5.1'],
      verifierCall: true,
      verifierStrict: true,
      verifierPreferred: '',
    })).toEqual([])

    const [pending] = await verifyQuestionsWithCrossProvider({
      questions: [{
        type: 'MCQ',
        text: 'ما الكلمة الموجودة في المصدر؟',
        options: ['أكاديمية', 'مكتبة'],
        correctAnswer: 'أكاديمية',
        sourceIndex: 1,
        sourceEvidence: 'أكاديمية',
      } as any],
      sources: [{ text: 'أكاديمية' }],
      generatorProvider: 'OPENAI',
      generatorModel: 'gpt-5.1',
      timeBudgetMs: 0,
    })

    expect(pending.verificationPending).toBe(true)
  })

  test('policy source legacy preserves hardcoded routes while admin uses AI_ROUTER_POLICY', () => {
    expect(__testResolveRouterPolicyForTests('legacy', 'cost_saver', 'balanced')).toBe('balanced')
    expect(__testResolveRouterPolicyForTests('legacy', 'cost_saver', 'primary_first')).toBe('primary_first')
    expect(__testResolveRouterPolicyForTests('admin', 'cost_saver', 'balanced')).toBe('cost_saver')
  })

  test('503 and timeout cool the model only and never escalate to the key', async () => {
    __setTextAiSettingStoreForTests(fakeSettingStore())
    expect(__testHighDemandCooldownDecisionForTests('gpt-5.6-luna', 'upstream unavailable', 503)).toBe('model')

    const singleFailure = await __testApplyTransientModelFailureCooldownForTests('ALBORIHI', 'fake-key', 1, 'gpt-5.6-luna', 'claude-sonnet-5', 'upstream 503', 503)
    expect(singleFailure).toEqual({ keyCooling: false, modelCooling: true, checkModelCooling: false })

    // Three distinct models timing out on one key must NOT ban the key:
    // each failure cools only its own model, and an untouched sibling
    // model stays available so the router can still fail over to it.
    await __testApplyTransientModelFailureCooldownForTests('ALBORIHI', 'third-key', 1, 'gpt-5.6-luna', 'claude-sonnet-5', 'timeout', 504)
    await __testApplyTransientModelFailureCooldownForTests('ALBORIHI', 'third-key', 1, 'claude-sonnet-5', 'gpt-5.6-luna', 'timeout', 504)
    const thirdFailure = await __testApplyTransientModelFailureCooldownForTests('ALBORIHI', 'third-key', 1, 'claude-opus-4-6', 'gpt-5.6', 'timeout', 504)
    expect(thirdFailure).toEqual({ keyCooling: false, modelCooling: true, checkModelCooling: false })
  })

  test('APINEX models keep failing over after three transient failures on one key', async () => {
    __setTextAiSettingStoreForTests(fakeSettingStore())

    // Mirrors the launch-quality incident: APINEX is first in the manual
    // order and several of its free models stumble (504, timeout, 503)
    // inside one short window. None of that is key/account evidence, so
    // the key must stay usable and the next APINEX model must be tried.
    await __testApplyTransientModelFailureCooldownForTests('APINEX', 'apinex-key', 1, 'free/glm-5.3-flashx', 'free/kimi-k3', 'provider timeout', 504)
    await __testApplyTransientModelFailureCooldownForTests('APINEX', 'apinex-key', 1, 'free/deepseek-v4.1-flash', 'free/kimi-k3', 'request timed out', undefined)
    const thirdFailure = await __testApplyTransientModelFailureCooldownForTests('APINEX', 'apinex-key', 1, 'free/gpt-6-luna', 'free/kimi-k3', 'upstream 503', 503)
    expect(thirdFailure).toEqual({ keyCooling: false, modelCooling: true, checkModelCooling: false })
  })

  test('sticky on success derives separate scopes and stays disabled by default', () => {
    expect(__testStickyScopeForTests({ stickyOnSuccess: false, purpose: 'GENERATION' })).toBeNull()
    expect(__testStickyScopeForTests({ stickyOnSuccess: false, stickyScope: 'manual-scope', purpose: 'GENERATION' })).toBe('manual-scope')
    expect(__testStickyScopeForTests({ stickyOnSuccess: true, taskType: 'question-bank', verifierCall: false })).toBe('question-bank:gen')
    expect(__testStickyScopeForTests({ stickyOnSuccess: true, taskType: 'question-bank', verifierCall: true })).toBe('question-bank:verify')
  })

  test('sticky candidate ordering respects success, cooldown, strict, no-balance, and verifier family isolation', () => {
    expect(__testStickyCandidateOrderForTests({
      stickyOnSuccess: true,
      model: 'claude-sonnet-5',
      key: 'key-a',
      candidates: ['gpt-5.6-luna', 'claude-sonnet-5'],
    })).toEqual(['claude-sonnet-5', 'gpt-5.6-luna'])

    expect(__testStickyCandidateOrderForTests({
      stickyOnSuccess: true,
      model: 'claude-sonnet-5',
      key: 'key-a',
      candidates: ['gpt-5.6-luna', 'claude-sonnet-5'],
      cooldown: true,
    })).toEqual(['gpt-5.6-luna', 'claude-sonnet-5'])

    expect(__testStickyCandidateOrderForTests({
      stickyOnSuccess: true,
      model: 'claude-sonnet-5',
      key: 'key-a',
      candidates: ['gpt-5.6-luna', 'claude-sonnet-5'],
      noBalance: true,
    })).toEqual(['gpt-5.6-luna', 'claude-sonnet-5'])

    expect(__testStickyCandidateOrderForTests({
      stickyOnSuccess: true,
      model: 'claude-sonnet-5',
      key: 'key-a',
      candidates: ['gpt-5.6-luna', 'claude-sonnet-5'],
      strictCandidates: ['gpt-5.6-luna'],
    })).toEqual(['gpt-5.6-luna', 'claude-sonnet-5'])

    expect(__testStickyCandidateOrderForTests({
      stickyOnSuccess: true,
      model: 'claude-sonnet-5',
      key: 'key-a',
      candidates: ['gpt-5.6-luna', 'claude-sonnet-5'],
      verifierCall: true,
      generatorModel: 'claude-opus-4-6',
    })).toEqual(['gpt-5.6-luna', 'claude-sonnet-5'])

    expect(__testStickyCandidateOrderForTests({
      stickyOnSuccess: false,
      model: 'claude-sonnet-5',
      key: 'key-a',
      candidates: ['gpt-5.6-luna', 'claude-sonnet-5'],
    })).toEqual(['gpt-5.6-luna', 'claude-sonnet-5'])
  })

  test('sticky success is reused, failure moves to a new sticky model, and balanced does not override it', async () => {
    __setTextAiSettingStoreForTests(fakeSettingStore({
      AI_TEXT_PROVIDER: 'OPENAI',
      AI_ROUTER_POLICY: 'balanced',
      AI_STICKY_ON_SUCCESS: 'true',
      AI_ACADEMIC_ALLOWLIST: 'OPENAI:gpt-5.1,OPENAI:gpt-5',
      OPENAI_API_KEYS: 'key-a',
      OPENAI_TEXT_MODEL: 'gpt-5.1',
      OPENAI_BASE_URL: 'https://openai.test/v1',
    }))

    const calls: string[] = []
    // OPENAI model discovery (2026-10-30) issues GET /models while building
    // candidates; it is background traffic, not a completion attempt, so the
    // stubs answer it with an empty catalog and never record it in `calls`.
    globalThis.fetch = (async (_url: any, init: any) => {
      if (String(_url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      const model = JSON.parse(String(init?.body || '{}')).model
      calls.push(model)
      return new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 })
    }) as any

    await textAiComplete({ system: 's', history: [{ role: 'user', text: 'batch 1' }], taskLevel: 'ACADEMIC_CRITICAL', purpose: 'GENERATION', taskType: 'question-bank' })
    expect(calls[0]).toBe('gpt-5.1')

    calls.length = 0
    globalThis.fetch = (async (_url: any, init: any) => {
      if (String(_url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      const model = JSON.parse(String(init?.body || '{}')).model
      calls.push(model)
      if (model === 'gpt-5.1') return new Response(JSON.stringify({ error: { message: 'upstream 503' } }), { status: 503 })
      return new Response(JSON.stringify({ output_text: 'ok-new' }), { status: 200 })
    }) as any

    await textAiComplete({ system: 's', history: [{ role: 'user', text: 'batch 2' }], taskLevel: 'ACADEMIC_CRITICAL', purpose: 'GENERATION', taskType: 'question-bank' })
    expect(calls[0]).toBe('gpt-5.1')
    expect(calls).toContain('gpt-5')

    calls.length = 0
    globalThis.fetch = (async (_url: any, init: any) => {
      if (String(_url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      const model = JSON.parse(String(init?.body || '{}')).model
      calls.push(model)
      return new Response(JSON.stringify({ output_text: 'ok-again' }), { status: 200 })
    }) as any

    await textAiComplete({ system: 's', history: [{ role: 'user', text: 'batch 3' }], taskLevel: 'ACADEMIC_CRITICAL', purpose: 'GENERATION', taskType: 'question-bank' })
    expect(calls[0]).toBe('gpt-5')
  })

  test('sticky model survives provider model rotation and maxProviderModels limits', async () => {
    const geminiModels = [
      'gemini-3.8-flash',
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-flash-latest',
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
    ]
    const stickyModel = geminiModels[4]
    const stickyScope = 'gemini-max-provider-models-sticky'
    __setTextAiSettingStoreForTests(fakeSettingStore({
      AI_TEXT_PROVIDER: 'GEMINI',
      AI_ROUTER_POLICY: 'balanced',
      AI_STICKY_ON_SUCCESS: 'true',
      GEMINI_API_KEYS: 'key-a',
      GEMINI_TEXT_MODEL: geminiModels[0],
    }))
    __testStickyCandidateOrderForTests({
      stickyOnSuccess: true,
      scope: stickyScope,
      provider: 'GEMINI',
      model: stickyModel,
      key: 'key-a',
      candidates: geminiModels,
    })

    const attemptedByRequest: string[][] = []
    let currentAttempts: string[] = []
    globalThis.fetch = (async (url: any) => {
      // GEMINI model discovery (2026-10-30) GETs /v1beta/models while building
      // candidates; only :generateContent calls are completion attempts.
      if (!String(url).includes(':generateContent')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      const model = decodeURIComponent(String(url).match(/\/models\/([^:]+):/)?.[1] || '')
      currentAttempts.push(model)
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 })
    }) as any

    for (let i = 0; i < 5; i += 1) {
      currentAttempts = []
      await textAiComplete({
        system: 's',
        history: [{ role: 'user', text: `sticky request ${i}` }],
        purpose: 'GENERATION',
        stickyScope,
        maxProviderModels: { GEMINI: 2 },
      })
      attemptedByRequest.push([...currentAttempts])
    }

    expect(attemptedByRequest).toHaveLength(5)
    for (const attempts of attemptedByRequest) {
      expect(attempts[0]).toBe(stickyModel)
      expect(attempts.length).toBeLessThanOrEqual(2)
    }
  })

  test('sticky disabled preserves candidate key order across repeated requests', async () => {
    __setTextAiSettingStoreForTests(fakeSettingStore({
      AI_TEXT_PROVIDER: 'GEMINI',
      AI_ROUTER_POLICY: 'balanced',
      AI_STICKY_ON_SUCCESS: 'false',
      GEMINI_API_KEYS: 'key-a,key-b,key-c',
      GEMINI_TEXT_MODEL: 'gemini-3.8-flash',
    }))

    const keyOrderByRequest: string[][] = []
    let currentKeys: string[] = []
    globalThis.fetch = (async (url: any) => {
      // Discovery GETs carry the same ?key= but are not completion attempts.
      if (!String(url).includes(':generateContent')) {
        return new Response(JSON.stringify({ models: [] }), { status: 200 })
      }
      const key = new URL(String(url)).searchParams.get('key') || ''
      currentKeys.push(key)
      if (key !== 'key-c') return new Response(JSON.stringify({ error: { message: 'plain failure' } }), { status: 500 })
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), { status: 200 })
    }) as any

    for (let i = 0; i < 3; i += 1) {
      currentKeys = []
      await textAiComplete({
        system: 's',
        history: [{ role: 'user', text: `key order ${i}` }],
        purpose: 'GENERATION',
      })
      keyOrderByRequest.push([...currentKeys])
    }

    expect(keyOrderByRequest).toEqual([
      ['key-a', 'key-b', 'key-c'],
      ['key-a', 'key-b', 'key-c'],
      ['key-a', 'key-b', 'key-c'],
    ])
  })

  test('sticky OPENAI_COMPAT model survives provider model rotation and maxProviderModels limits', async () => {
    const compatModels = [
      'deepseek-ai/deepseek-v3.2',
      'qwen/qwen3-235b-a22b',
      'moonshotai/kimi-k2-instruct-0905',
      'openai/gpt-oss-120b',
      'nvidia/nemotron-3-super-120b-a12b',
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    ]
    const stickyModel = compatModels[4]
    const stickyScope = 'openai-compat-max-provider-models-sticky'
    process.env.OPENAI_COMPAT_API_KEYS = 'compat-key'
    __setTextAiSettingStoreForTests(fakeSettingStore({
      AI_TEXT_PROVIDER: 'OPENAI_COMPAT',
      AI_ROUTER_POLICY: 'balanced',
      AI_STICKY_ON_SUCCESS: 'true',
      OPENAI_COMPAT_BASE_URL: 'https://integrate.api.nvidia.com/v1',
      OPENAI_COMPAT_TEXT_MODEL: compatModels[0],
    }))
    __testStickyCandidateOrderForTests({
      stickyOnSuccess: true,
      scope: stickyScope,
      provider: 'OPENAI_COMPAT',
      model: stickyModel,
      key: 'compat-key',
      candidates: compatModels,
    })

    const attemptedByRequest: string[][] = []
    let currentAttempts: string[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: compatModels.map((id) => ({ id, online: true, type: 'text' })) }), { status: 200 })
      }
      const model = JSON.parse(String(init?.body || '{}')).model
      currentAttempts.push(model)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }) as any

    for (let i = 0; i < 5; i += 1) {
      currentAttempts = []
      await textAiComplete({
        system: 's',
        history: [{ role: 'user', text: `compat sticky request ${i}` }],
        purpose: 'GENERATION',
        stickyScope,
        maxProviderModels: { OPENAI_COMPAT: 2 },
      })
      attemptedByRequest.push([...currentAttempts])
    }

    expect(attemptedByRequest).toHaveLength(5)
    for (const attempts of attemptedByRequest) {
      expect(attempts[0]).toBe(stickyModel)
      expect(attempts.length).toBeLessThanOrEqual(2)
    }
  })

  test('sticky disabled preserves OPENAI_COMPAT candidate key order across repeated requests', async () => {
    process.env.OPENAI_COMPAT_API_KEYS = 'key-a,key-b,key-c'
    __setTextAiSettingStoreForTests(fakeSettingStore({
      AI_TEXT_PROVIDER: 'OPENAI_COMPAT',
      AI_ROUTER_POLICY: 'balanced',
      AI_STICKY_ON_SUCCESS: 'false',
      OPENAI_COMPAT_BASE_URL: 'https://compat.test/v1',
      OPENAI_COMPAT_TEXT_MODEL: 'compat-model',
    }))

    const keyOrderByRequest: string[][] = []
    let currentKeys: string[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      const auth = String(init?.headers?.Authorization || '')
      const key = auth.replace(/^Bearer\s+/i, '')
      currentKeys.push(key)
      if (key !== 'key-c') return new Response(JSON.stringify({ error: { message: 'plain failure' } }), { status: 500 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }) as any

    for (let i = 0; i < 3; i += 1) {
      currentKeys = []
      await textAiComplete({
        system: 's',
        history: [{ role: 'user', text: `compat key order ${i}` }],
        purpose: 'GENERATION',
      })
      keyOrderByRequest.push([...currentKeys])
    }

    expect(keyOrderByRequest).toEqual([
      ['key-a', 'key-b', 'key-c'],
      ['key-a', 'key-b', 'key-c'],
      ['key-a', 'key-b', 'key-c'],
    ])
  })

  test('strict academic allowlist 503 failures throw the pausable academic unavailable code', async () => {
    __setTextAiSettingStoreForTests(fakeSettingStore({
      AI_TEXT_PROVIDER: 'OPENAI',
      AI_ACADEMIC_ALLOWLIST_STRICT: 'true',
      AI_ACADEMIC_ALLOWLIST: 'OPENAI:gpt-5.1',
      OPENAI_API_KEYS: 'key-a',
      OPENAI_TEXT_MODEL: 'gpt-5.1',
      OPENAI_BASE_URL: 'https://openai.test/v1',
    }))
    let strictCalls = 0
    globalThis.fetch = (async (url: any) => {
      // Model discovery is background traffic; strictCalls counts completions.
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
      strictCalls += 1
      return new Response(JSON.stringify({ error: { message: 'upstream 503' } }), { status: 503 })
    }) as any

    let code = ''
    try {
      await textAiComplete({ system: 's', history: [{ role: 'user', text: 'strict batch' }], taskLevel: 'ACADEMIC_CRITICAL', purpose: 'GENERATION', taskType: 'question-bank' })
    } catch (error: any) {
      code = String(error?.code || error?.message || '')
    }
    expect(strictCalls).toBe(1)
    expect(code).toContain('AI_ACADEMIC_PROVIDER_UNAVAILABLE')
    expect(isPausableQuestionBankError('AI_ACADEMIC_PROVIDER_UNAVAILABLE')).toBe(true)
  })
})
