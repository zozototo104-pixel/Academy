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
    __setTextAiSettingStoreForTests(null)
    __resetTextAiStateForTests()
  })

  test('testProviderOrderUnchanged keeps the legacy primary provider order snapshot', () => {
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
    expect(calls[0]).toBe('claude-sonnet-5')
    expect(calls).toContain('claude-opus-4-6')

    calls.length = 0
    globalThis.fetch = (async (_url: any, init: any) => {
      const model = JSON.parse(String(init?.body || '{}')).model
      calls.push(model)
      return new Response(JSON.stringify({ output_text: 'ok-again' }), { status: 200 })
    }) as any

    await textAiComplete({ system: 's', history: [{ role: 'user', text: 'batch 3' }], taskLevel: 'ACADEMIC_CRITICAL', purpose: 'GENERATION', taskType: 'question-bank' })
    expect(calls[0]).toBe('claude-opus-4-6')
  })

  test('strict academic allowlist 503 failures throw the pausable academic unavailable code', async () => {
    __setTextAiSettingStoreForTests(fakeSettingStore({
      AI_TEXT_PROVIDER: 'ALBORIHI',
      AI_ACADEMIC_ALLOWLIST_STRICT: 'true',
      AI_ACADEMIC_ALLOWLIST: 'ALBORIHI:gpt-5.6-luna',
      ALBORIHI_API_KEYS: 'key-a',
      ALBORIHI_TEXT_MODEL: 'gpt-5.6-luna',
      ALBORIHI_BASE_URL: 'https://alborihi.test/v1',
    }))
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'upstream 503' } }), { status: 503 })) as any

    let code = ''
    try {
      await textAiComplete({ system: 's', history: [{ role: 'user', text: 'strict batch' }], taskLevel: 'ACADEMIC_CRITICAL', purpose: 'GENERATION', taskType: 'question-bank' })
    } catch (error: any) {
      code = String(error?.code || error?.message || '')
    }
    expect(code).toContain('AI_ACADEMIC_PROVIDER_UNAVAILABLE')
    expect(isPausableQuestionBankError('AI_ACADEMIC_PROVIDER_UNAVAILABLE')).toBe(true)
  })
})
