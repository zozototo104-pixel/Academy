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
  __testTransientModelFailureEscalationForTests,
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

  test('503 and timeout cool known models before cooling the key', async () => {
    __setTextAiSettingStoreForTests(fakeSettingStore())
    expect(__testHighDemandCooldownDecisionForTests('gpt-5.6-luna', 'upstream unavailable', 503)).toBe('model')

    const singleFailure = await __testApplyTransientModelFailureCooldownForTests('ALBORIHI', 'fake-key', 1, 'gpt-5.6-luna', 'claude-sonnet-5', 'upstream 503', 503)
    expect(singleFailure).toEqual({ keyCooling: false, modelCooling: true, checkModelCooling: false })

    expect(__testTransientModelFailureEscalationForTests('ALBORIHI', 'other-key', [
      'gpt-5.6-luna',
      'claude-sonnet-5',
      'claude-opus-4-6',
    ])).toEqual([false, false, true])

    await __testApplyTransientModelFailureCooldownForTests('ALBORIHI', 'third-key', 1, 'gpt-5.6-luna', 'claude-sonnet-5', 'timeout', 504)
    await __testApplyTransientModelFailureCooldownForTests('ALBORIHI', 'third-key', 1, 'claude-sonnet-5', 'gpt-5.6-luna', 'timeout', 504)
    const thirdFailure = await __testApplyTransientModelFailureCooldownForTests('ALBORIHI', 'third-key', 1, 'claude-opus-4-6', 'gpt-5.6-luna', 'timeout', 504)
    expect(thirdFailure.keyCooling).toBe(true)
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
    globalThis.fetch = (async (_url: any, init: any) => {
      const model = JSON.parse(String(init?.body || '{}')).model
      calls.push(model)
      return new Response(JSON.stringify({ output_text: 'ok' }), { status: 200 })
    }) as any

    await textAiComplete({ system: 's', history: [{ role: 'user', text: 'batch 1' }], taskLevel: 'ACADEMIC_CRITICAL', purpose: 'GENERATION', taskType: 'question-bank' })
    expect(calls[0]).toBe('gpt-5.1')

    calls.length = 0
    globalThis.fetch = (async (_url: any, init: any) => {
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
    globalThis.fetch = (async () => {
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
