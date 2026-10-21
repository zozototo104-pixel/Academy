import { afterEach, describe, expect, test } from 'bun:test'
import { aiProgressLabel, aiProgressPercent, arabicAiStatusMessage } from '../../src/lib/ai-error-messages'
import { buildQuestionBankJobSuccessTrace, isPausableQuestionBankError } from '../../src/lib/question-bank-job'
import {
  __resetTextAiStateForTests,
  __setTextAiSettingStoreForTests,
  __testApplyTransientModelFailureCooldownForTests,
  __testB2ProviderOrderForTests,
  __testStickyScopeForTests,
  geminiKeysForLive,
} from '../../src/lib/text-ai'

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

const originalGeminiApiKey = process.env.GEMINI_API_KEY
const originalGeminiApiKeys = process.env.GEMINI_API_KEYS

describe('admin AI progress C', () => {
  afterEach(() => {
    if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalGeminiApiKey
    if (originalGeminiApiKeys === undefined) delete process.env.GEMINI_API_KEYS
    else process.env.GEMINI_API_KEYS = originalGeminiApiKeys
    __setTextAiSettingStoreForTests(null)
    __resetTextAiStateForTests()
  })

  test('arabicAiStatusMessage covers known AI codes and unknown fallback', () => {
    expect(arabicAiStatusMessage('AI_ACADEMIC_PROVIDER_UNAVAILABLE')).toContain('توقف مؤقتاً')
    expect(arabicAiStatusMessage('NO_PROVIDER')).toContain('النماذج المسموحة')
    expect(arabicAiStatusMessage('NO_BALANCE')).toContain('انتهى رصيد')
    expect(arabicAiStatusMessage('402')).toContain('حصة')
    expect(arabicAiStatusMessage('429 daily cap')).toContain('حد الاستخدام اليومي')
    expect(arabicAiStatusMessage('COOLDOWN')).toContain('تبريد')
    expect(arabicAiStatusMessage('TIMEOUT')).toContain('وقتاً أطول')
    expect(arabicAiStatusMessage('DEADLINE')).toContain('وقتاً أطول')
    expect(arabicAiStatusMessage('MODEL_DEAD')).toContain('متوقف')
    expect(arabicAiStatusMessage('404')).toContain('متوقف')
    expect(arabicAiStatusMessage('401 auth')).toContain('مفتاح')
    expect(arabicAiStatusMessage('403 auth')).toContain('مفتاح')
    expect(arabicAiStatusMessage('verificationPending')).toContain('بانتظار المراجعة')
    expect(arabicAiStatusMessage('SOMETHING_ELSE')).toContain('تعذّر إكمال')
  })

  test('progress percent uses real counts and caps at 100 percent', () => {
    expect(aiProgressPercent(0, 0)).toBeNull()
    expect(aiProgressLabel(0, 0)).toBe('جارٍ التحضير…')
    expect(aiProgressPercent(15, 10)).toBe(100)
    expect(aiProgressPercent(3, 10)).toBe(30)
  })

  test('question bank trace stores actual generator and verifier model metadata after success', () => {
    const trace = buildQuestionBankJobSuccessTrace({
      generated: 4,
      saved: 3,
      verifierRejected: 1,
      rejected: 2,
      rejectionReasons: [{ reason: 'SOURCE_EVIDENCE_REQUIRED', count: 2 }],
      generatorProvider: 'ALBORIHI',
      generatorModel: 'claude-sonnet-5',
      verifierProvider: 'ALBORIHI',
      verifierModel: 'gpt-5.6-luna',
      at: '2026-10-21T10:00:00.000Z',
    })
    expect(trace.lastSuccess?.generation).toEqual({ stage: 'generation', provider: 'ALBORIHI', model: 'claude-sonnet-5', at: '2026-10-21T10:00:00.000Z' })
    expect(trace.lastSuccess?.verification).toEqual({ stage: 'verification', provider: 'ALBORIHI', model: 'gpt-5.6-luna', at: '2026-10-21T10:00:00.000Z' })
    expect(trace.aiTrace?.generatorProvider).toBe('ALBORIHI')
    expect(trace.aiTrace?.verifierModel).toBe('gpt-5.6-luna')
  })

  test('question bank pause regex still recognizes the same pausable AI codes', () => {
    for (const code of ['AI_ACADEMIC_PROVIDER_UNAVAILABLE', 'TEXT_AI_ROUTER_NOT_CONFIGURED', 'DEADLINE', 'TIMEOUT', 'NO_PROVIDER', 'OPENAI_API_KEYS']) {
      expect(isPausableQuestionBankError(code)).toBe(true)
    }
  })

  test('general chat routing ignores sticky and B1/B2 family ranking options', () => {
    expect(__testStickyScopeForTests({ stickyOnSuccess: true, purpose: 'CHAT', taskLevel: 'GENERAL' })).toBeNull()
    const baseline = __testB2ProviderOrderForTests({ policy: 'quality_first', rankBy: 'provider', taskLevel: 'GENERAL', providerTiers: 'ALBORIHI:PAID,GROQ:FREE', paidFirst: false })
    const guarded = __testB2ProviderOrderForTests({ policy: 'quality_first', rankBy: 'family', taskLevel: 'GENERAL', providerTiers: 'ALBORIHI:PAID,GROQ:FREE', paidFirst: true })
    expect(guarded).toEqual(baseline)
  })

  test('Gemini Live key order survives text-model cooldowns', async () => {
    process.env.GEMINI_API_KEY = 'env-main'
    process.env.GEMINI_API_KEYS = 'env-extra-1,env-extra-2'
    __setTextAiSettingStoreForTests(fakeSettingStore({ GEMINI_API_KEY: 'db-main', GEMINI_API_KEYS: 'db-extra' }))
    const before = await geminiKeysForLive()
    await __testApplyTransientModelFailureCooldownForTests('GEMINI', 'env-main', 1, 'gemini-3.8-flash', 'gemini-3.1-flash-live-preview', 'upstream 503', 503)
    const after = await geminiKeysForLive()
    expect(after).toEqual(before)
    expect(after.map((item) => item.key)).toEqual(['env-main', 'env-extra-1', 'env-extra-2', 'db-main', 'db-extra'])
  })
})
