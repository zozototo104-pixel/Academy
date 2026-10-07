import assert from 'node:assert/strict'
import { __resetTextAiStateForTests, modelFamily } from '../src/lib/text-ai'
import { verifyQuestionsWithCrossProvider, type VerifiableQuestion } from '../src/lib/question-verifier'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

type FetchCall = { url: string; init?: RequestInit }

const sourceOne = 'هذا نص المصدر الأول ولا يجب أن يظهر في مطالبة التحقق عندما يطلب السؤال المصدر الثاني فقط. يحتوي على أفكار مختلفة تماماً عن الدليل المطلوب.'
const sourceTwo = 'هذا نص المصدر الثاني الأصلي الذي يثبت أن القرار المهني الجيد يعتمد على الدليل المباشر والسياق المؤسسي قبل التنفيذ والتحقق.'
const sourceTwoEvidence = 'يثبت أن القرار المهني الجيد يعتمد على الدليل المباشر والسياق المؤسسي قبل التنفيذ والتحقق'

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
}

function baseQuestion(overrides: Partial<VerifiableQuestion> = {}): VerifiableQuestion {
  return {
    type: 'MCQ',
    text: 'ما الأساس الذي يثبته المصدر لاتخاذ القرار المهني الجيد؟',
    options: ['الدليل المباشر والسياق المؤسسي', 'الانطباع الأول فقط', 'تجاهل المصدر', 'تأجيل التحقق'],
    correct: '0',
    sourceIndex: 2,
    sourceEvidence: sourceTwoEvidence,
    qualityFlags: ['SOURCE_LINKED', 'NEEDS_HUMAN_REVIEW'],
    ...overrides,
  }
}

function response(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function validResult(indices: number[] = [0]) {
  return JSON.stringify({ results: indices.map((index) => ({ index, valid: true, answerSupported: true, evidenceSupportsQuestion: true, reason: 'مدعوم من نص المصدر المحدد.' })) })
}

function rejectedResult(index = 0) {
  return JSON.stringify({ results: [{ index, valid: false, answerSupported: false, evidenceSupportsQuestion: true, reason: 'الإجابة لا يدعمها النص مباشرة.' }] })
}

async function withMockFetch(handler: (call: FetchCall) => Response | Promise<Response>, run: (calls: FetchCall[]) => Promise<void>) {
  __resetTextAiStateForTests()
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = originalFetch
    resetEnv()
  }
}

function configureProviders() {
  process.env.GEMINI_API_KEY = 'mock-gemini-key'
  process.env.UNOROUTER_API_KEY = 'mock-uno-key'
  process.env.OPENROUTER_API_KEY = 'mock-openrouter-key'
  process.env.AI_ACADEMIC_ALLOWLIST = 'GEMINI:gemini-3.8-flash,UNOROUTER:gpt-oss-120b:free,OPENROUTER:meta-llama/llama-3.1-70b-instruct:free'
}

function modelFamilyClassifiesRealNames() {
  assert.equal(modelFamily('google/gemini-3.8-flash'), 'gemini')
  assert.equal(modelFamily('gemini-2.5-flash'), 'gemini')
  assert.equal(modelFamily('openai/gpt-4o-mini'), 'gpt')
  assert.equal(modelFamily('anthropic/claude-sonnet-4-5-20250929'), 'claude')
  assert.equal(modelFamily('meta-llama/llama-3.1-70b-instruct'), 'llama')
  assert.equal(modelFamily('qwen/qwen3-72b'), 'qwen')
  assert.equal(modelFamily('deepseek/deepseek-v3.2'), 'deepseek')
  assert.equal(modelFamily('mistralai/mistral-large'), 'mistral')
}

async function generatorProviderUnknownFailsClosed() {
  configureProviders()
  await withMockFetch(
    () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
    async (calls) => {
      const result = await verifyQuestionsWithCrossProvider({ questions: [baseQuestion()], sources: [{ text: sourceOne }, { text: sourceTwo }] })
      assert.equal(calls.length, 0, 'unknown generator provider must not call verifier')
      assert.equal(result[0].verificationPending, true)
      assert.equal(result[0].verificationReason, 'GENERATOR_PROVIDER_UNKNOWN')
      assert.ok(result[0].qualityFlags?.includes('NEEDS_HUMAN_REVIEW'))
      assert.ok(!result[0].qualityFlags?.includes('SOURCE_GROUNDED'))
    }
  )
}

async function generatorGeminiIsExcludedAndPromptUsesSelectedSourceOnly() {
  configureProviders()
  await withMockFetch(
    (call) => {
      if (call.url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({ error: { message: 'Gemini must be excluded' } }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
      if (call.url.includes('/api/pricing/catalog') || /\/models(?:\?|$)/.test(call.url)) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (call.url.includes('api.unorouter.com') && call.url.includes('/chat/completions')) return response(validResult([0, 1]))
      return new Response(JSON.stringify({ error: { message: 'unexpected provider call' } }), { status: 500, headers: { 'content-type': 'application/json' } })
    },
    async (calls) => {
      const result = await verifyQuestionsWithCrossProvider({
        questions: [baseQuestion(), baseQuestion()],
        sources: [{ text: sourceOne }, { text: sourceTwo }],
        generatorProvider: 'GEMINI',
        generatorModel: 'gemini-3.8-flash',
      })
      assert.ok(result[0].qualityFlags?.includes('SOURCE_GROUNDED'))
      assert.ok(result[1].qualityFlags?.includes('SOURCE_GROUNDED'))
      assert.equal(calls.some((call) => call.url.includes('generativelanguage.googleapis.com')), false, 'verifier must never call excluded Gemini')
      const completion = calls.find((call) => call.url.includes('/chat/completions'))
      const body = String(completion?.init?.body || '')
      assert.ok(body.includes(sourceTwo), 'verifier prompt must include the selected source text')
      assert.equal(body.includes(sourceOne), false, 'verifier prompt must not include other source chunks')
      assert.equal((body.match(new RegExp(sourceTwo, 'g')) || []).length, 1, 'shared source text should appear once per verifier batch')
    }
  )
}

async function verifierRejectionKeepsHumanReview() {
  configureProviders()
  await withMockFetch(
    (call) => {
      if (call.url.includes('/api/pricing/catalog') || /\/models(?:\?|$)/.test(call.url)) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (call.url.includes('api.unorouter.com') && call.url.includes('/chat/completions')) return response(rejectedResult())
      return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
    },
    async () => {
      const result = await verifyQuestionsWithCrossProvider({ questions: [baseQuestion()], sources: [{ text: sourceOne }, { text: sourceTwo }], generatorProvider: 'GEMINI', generatorModel: 'gemini-3.8-flash' })
      assert.ok(!result[0].qualityFlags?.includes('SOURCE_GROUNDED'))
      assert.ok(result[0].qualityFlags?.includes('NEEDS_HUMAN_REVIEW'))
      assert.equal(result[0].verifierReason, 'الإجابة لا يدعمها النص مباشرة.')
    }
  )
}

async function verifierAcceptsButLiteralFailDoesNotGround() {
  configureProviders()
  await withMockFetch(
    (call) => {
      if (call.url.includes('/api/pricing/catalog') || /\/models(?:\?|$)/.test(call.url)) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (call.url.includes('api.unorouter.com') && call.url.includes('/chat/completions')) return response(validResult())
      return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
    },
    async () => {
      const result = await verifyQuestionsWithCrossProvider({
        questions: [baseQuestion({ sourceEvidence: 'هذا دليل غير موجود حرفياً في نص المصدر المحدد رغم أنه طويل بما يكفي لاختبار الفشل الحرفي' })],
        sources: [{ text: sourceOne }, { text: sourceTwo }],
        generatorProvider: 'GEMINI',
        generatorModel: 'gemini-3.8-flash',
      })
      assert.ok(!result[0].qualityFlags?.includes('SOURCE_GROUNDED'))
      assert.ok(result[0].qualityFlags?.includes('NEEDS_HUMAN_REVIEW'))
      assert.equal(result[0].verifierReason, 'LITERAL_EVIDENCE_FAILED')
    }
  )
}

async function unavailableVerifierKeepsGenerationPending() {
  process.env.GEMINI_API_KEY = 'mock-gemini-key'
  process.env.AI_ACADEMIC_ALLOWLIST = 'GEMINI:gemini-3.8-flash'
  await withMockFetch(
    () => new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } }),
    async (calls) => {
      const result = await verifyQuestionsWithCrossProvider({ questions: [baseQuestion()], sources: [{ text: sourceOne }, { text: sourceTwo }], generatorProvider: 'GEMINI', generatorModel: 'gemini-3.8-flash' })
      assert.equal(calls.length, 0, 'no provider should be called when only the excluded generator exists')
      assert.equal(result[0].verificationPending, true)
      assert.equal(result[0].verificationReason, 'AI_VERIFIER_UNAVAILABLE')
      assert.ok(result[0].qualityFlags?.includes('NEEDS_HUMAN_REVIEW'))
    }
  )
}

async function excludedModelFamilyCanExhaustVerifierModels() {
  process.env.OPENROUTER_API_KEY = 'mock-openrouter-key'
  process.env.AI_TEXT_PROVIDER = 'OPENROUTER'
  process.env.AI_ROUTER_POLICY = 'fallback_only'
  process.env.AI_ACADEMIC_ALLOWLIST = 'OPENROUTER:google/gemini-3.8-flash'
  await withMockFetch(
    (call) => {
      if (call.url.includes('openrouter.ai') && /\/models(?:\?|$)/.test(call.url)) {
        return new Response(JSON.stringify({ data: [{ id: 'google/gemini-3.8-flash', is_free: true, online: true, type: 'text' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
    },
    async (calls) => {
      const result = await verifyQuestionsWithCrossProvider({ questions: [baseQuestion()], sources: [{ text: sourceOne }, { text: sourceTwo }], generatorProvider: 'GEMINI', generatorModel: 'google/gemini-3.8-flash' })
      assert.equal(calls.some((call) => call.url.includes('/chat/completions')), false, 'OpenRouter should not be called when it only has excluded Gemini-family models')
      assert.equal(result[0].verificationPending, true)
      assert.equal(result[0].verificationReason, 'AI_VERIFIER_UNAVAILABLE')
    }
  )
}

async function missingIndexFallsThroughToNextProvider() {
  configureProviders()
  await withMockFetch(
    (call) => {
      if (call.url.includes('openrouter.ai') && /\/models(?:\?|$)/.test(call.url)) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-oss-120b:free', is_free: true, online: true, type: 'text' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (call.url.includes('/api/pricing/catalog') || /\/models(?:\?|$)/.test(call.url)) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      if (call.url.includes('api.unorouter.com') && call.url.includes('/chat/completions')) return response(JSON.stringify({ results: [{ valid: true, answerSupported: true, evidenceSupportsQuestion: true, reason: 'missing index' }] }))
      if (call.url.includes('openrouter.ai') && call.url.includes('/chat/completions')) return response(validResult())
      return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
    },
    async (calls) => {
      const result = await verifyQuestionsWithCrossProvider({ questions: [baseQuestion()], sources: [{ text: sourceOne }, { text: sourceTwo }], generatorProvider: 'GEMINI', generatorModel: 'gemini-3.8-flash' })
      assert.ok(result[0].qualityFlags?.includes('SOURCE_GROUNDED'))
      assert.ok(calls.some((call) => call.url.includes('api.unorouter.com') && call.url.includes('/chat/completions')), 'first verifier provider should be attempted')
      assert.ok(calls.some((call) => call.url.includes('openrouter.ai') && call.url.includes('/chat/completions')), 'VALIDATION_REJECTED should fall through to the next provider')
    }
  )
}

async function timeBudgetMarksRemainingPending() {
  configureProviders()
  await withMockFetch(
    () => response(validResult()),
    async (calls) => {
      const result = await verifyQuestionsWithCrossProvider({
        questions: [baseQuestion()],
        sources: [{ text: sourceOne }, { text: sourceTwo }],
        generatorProvider: 'GEMINI',
        generatorModel: 'gemini-3.8-flash',
        timeBudgetMs: 0,
      })
      assert.equal(calls.length, 0)
      assert.equal(result[0].verificationPending, true)
      assert.equal(result[0].verificationReason, 'VERIFIER_TIME_BUDGET_EXCEEDED')
    }
  )
}

async function runCase(name: string, test: () => Promise<void> | void) {
  console.log(`▶ ${name}`)
  await test()
}

async function main() {
  await runCase('modelFamilyClassifiesRealNames', modelFamilyClassifiesRealNames)
  await runCase('generatorProviderUnknownFailsClosed', generatorProviderUnknownFailsClosed)
  await runCase('generatorGeminiIsExcludedAndPromptUsesSelectedSourceOnly', generatorGeminiIsExcludedAndPromptUsesSelectedSourceOnly)
  await runCase('verifierRejectionKeepsHumanReview', verifierRejectionKeepsHumanReview)
  await runCase('verifierAcceptsButLiteralFailDoesNotGround', verifierAcceptsButLiteralFailDoesNotGround)
  await runCase('unavailableVerifierKeepsGenerationPending', unavailableVerifierKeepsGenerationPending)
  await runCase('excludedModelFamilyCanExhaustVerifierModels', excludedModelFamilyCanExhaustVerifierModels)
  await runCase('missingIndexFallsThroughToNextProvider', missingIndexFallsThroughToNextProvider)
  await runCase('timeBudgetMarksRemainingPending', timeBudgetMarksRemainingPending)
  console.log('question verifier guardrails: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  globalThis.fetch = originalFetch
  resetEnv()
})
