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
})
