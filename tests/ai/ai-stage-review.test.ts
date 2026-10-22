import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

mock.module('@/lib/db', () => ({ db: { aiPipelineOperationLog: { create: async () => ({}) } } }))

const routerCalls: Record<string, unknown>[] = []
let restrictedBehavior: 'throw' | 'respond' = 'throw'
let responseContext: { provider: string; model: string; family?: string } = { provider: 'ANTHROPIC', model: 'claude-v' }
let generatorFamilyOverride = 'gemini'
mock.module('@/lib/text-ai', () => ({
  pipelineConfigSnapshot: async () => ({ policy: 'balanced', allowedModels: [], verifierPreferred: [] }),
  modelFamily: (model: string) => {
    const m = String(model).toLowerCase()
    if (m.includes('gemini') || m.includes('gemma')) return 'gemini'
    if (m.includes('claude')) return 'claude'
    if (m.includes('gpt')) return 'gpt'
    if (m.includes('qwen')) return 'qwen'
    if (m.includes('deepseek')) return 'deepseek'
    return 'unknown'
  },
  resolvedTextAiModelFamily: async () => generatorFamilyOverride,
  textAiCompleteJson: async (opts: Record<string, unknown>) => {
    routerCalls.push(opts)
    if (opts.restrictToModels && restrictedBehavior === 'throw') {
      const err: Error & { code?: string } = new Error('AI_VERIFIER_UNAVAILABLE')
      err.code = 'AI_VERIFIER_UNAVAILABLE'
      throw err
    }
    const text = JSON.stringify({ results: [{ index: 0, valid: true, answerSupported: true, evidenceSupportsQuestion: true, reason: 'مدعوم بالمصدر' }] })
    ;(opts.validate as ((t: string, c: { provider: string; model: string; family?: string }) => void) | undefined)?.(text, responseContext)
    return text
  },
}))

import type { StageRouting } from '@/lib/ai-stage-runner'
import type { VerifiableQuestion } from '@/lib/question-verifier'

const profiles = await import('@/lib/ai-stage-profiles')
const { prepareStageRun } = await import('@/lib/ai-stage-runner')
const { verifyQuestionsWithCrossProvider, __testFilterDistinctVerifierModelsForTests } = await import('@/lib/question-verifier')

const memory = new Map<string, { profileId: string; version: number; snapshot: never }>()
profiles.__setStageProfileStoreForTests({
  async loadCurrent(stage) {
    const row = memory.get(stage)
    return row ? { profileId: row.profileId, version: row.version, snapshot: row.snapshot } : null
  },
  async saveVersion(stage, snapshot) {
    const prev = memory.get(stage)
    const version = (prev?.version ?? 0) + 1
    memory.set(stage, { profileId: prev?.profileId ?? `profile-${stage}`, version, snapshot: snapshot as never })
    return { profileId: memory.get(stage)!.profileId, version }
  },
  async loadVersions() { return [] },
})

const SOURCE_TEXT = 'The mitochondria is the powerhouse of the cell and it produces energy in the form of ATP molecules for all cellular activities.'
const QUESTION: VerifiableQuestion = {
  type: 'MCQ',
  text: 'What is the function of the mitochondria?',
  options: ['Produces energy', 'Stores DNA', 'Builds proteins', 'Controls division'],
  correctAnswer: 'Produces energy',
  sourceEvidence: 'The mitochondria is the powerhouse of the cell and it produces energy',
  sourceIndex: 1,
}

const STRICT_ROUTING: StageRouting = {
  preferredModels: [{ provider: 'OPENAI', model: 'ver-v' }],
  preferredProviders: [],
  policy: null,
  allowGlobalFallback: true,
}

describe('D2.4 behavioral: REVIEW profile precedence — the verifier list comes first', () => {
  test('verifier.preferred wins over the regular models list and stamps the row', async () => {
    memory.clear()
    await profiles.saveStageProfile('REVIEW', {
      models: [{ provider: 'GEMINI', model: 'rev-m' }],
      verifier: { preferred: [{ provider: 'OPENAI', model: 'ver-v' }], strict: false },
    }, 'test-admin')
    const plan = await prepareStageRun('REVIEW')
    expect(plan.isStage).toBe(true)
    expect(plan.routing?.preferredModels).toEqual([{ provider: 'OPENAI', model: 'ver-v' }])
    expect(plan.detail.modelSource).toBe('verifier')
    expect(plan.profileStamp?.allowedModels).toEqual(['OPENAI:ver-v'])
  })

  test('without a verifier list, the regular REVIEW models are used', async () => {
    memory.clear()
    await profiles.saveStageProfile('REVIEW', { models: [{ provider: 'GEMINI', model: 'rev-m' }] }, 'test-admin')
    const plan = await prepareStageRun('REVIEW')
    expect(plan.routing?.preferredModels).toEqual([{ provider: 'GEMINI', model: 'rev-m' }])
    expect(plan.detail.modelSource).toBe('models')
  })

  test('a verifier-only profile (empty models) is still a stage profile', async () => {
    memory.clear()
    await profiles.saveStageProfile('REVIEW', {
      models: [],
      verifier: { preferred: [{ provider: 'OPENAI', model: 'ver-v' }], strict: true },
    }, 'test-admin')
    const plan = await prepareStageRun('REVIEW')
    expect(plan.isStage).toBe(true)
    expect(plan.routing?.preferredModels).toEqual([{ provider: 'OPENAI', model: 'ver-v' }])
  })
})

describe('D2.4 behavioral: the verifier runs restricted, then falls back once if allowed', () => {
  test('restricted pass fails → marked at decision time → global pass verifies', async () => {
    routerCalls.length = 0
    let fallbackMarks = 0
    const out = await verifyQuestionsWithCrossProvider({
      questions: [QUESTION],
      sources: [{ text: SOURCE_TEXT }],
      generatorProvider: 'GEMINI',
      generatorModel: 'gemini-2.5-pro',
      routing: STRICT_ROUTING,
      onFallbackAttempt: () => { fallbackMarks++ },
    })
    expect(routerCalls).toHaveLength(2)
    expect(routerCalls[0].restrictToModels).toEqual([{ provider: 'OPENAI', model: 'ver-v' }])
    expect(routerCalls[1].restrictToModels).toBeUndefined()
    expect(fallbackMarks).toBe(1)
    expect(out[0].verificationPending).toBeFalsy()
    expect(out[0].verifierProvider).toBe('ANTHROPIC')
    expect(out[0].qualityFlags).toContain('SOURCE_GROUNDED')
  })

  test('with fallback forbidden, the restricted failure leaves questions pending and unmarked', async () => {
    routerCalls.length = 0
    let fallbackMarks = 0
    const out = await verifyQuestionsWithCrossProvider({
      questions: [QUESTION],
      sources: [{ text: SOURCE_TEXT }],
      generatorProvider: 'GEMINI',
      generatorModel: 'gemini-2.5-pro',
      routing: { ...STRICT_ROUTING, allowGlobalFallback: false },
      onFallbackAttempt: () => { fallbackMarks++ },
    })
    expect(routerCalls).toHaveLength(1)
    expect(fallbackMarks).toBe(0)
    expect(out[0].verificationPending).toBe(true)
    expect(out[0].verificationReason).toBe('AI_VERIFIER_UNAVAILABLE')
  })

  test('without routing, the verifier behaves exactly as before (single unrestricted call)', async () => {
    routerCalls.length = 0
    const out = await verifyQuestionsWithCrossProvider({
      questions: [QUESTION],
      sources: [{ text: SOURCE_TEXT }],
      generatorProvider: 'GEMINI',
      generatorModel: 'gemini-2.5-pro',
    })
    expect(routerCalls).toHaveLength(1)
    expect(routerCalls[0].restrictToModels).toBeUndefined()
    expect(out[0].verifierProvider).toBe('ANTHROPIC')
  })
})

describe('D2.4 scope guards', () => {
  test('the job wires REVIEW with stamp + liveState and keeps generator identity in the row detail', () => {
    const job = readFileSync('src/lib/question-bank-job.ts', 'utf8')
    expect(job).toContain("prepareStageRun('REVIEW')")
    expect(job).toContain('profileStamp: reviewPlan.profileStamp')
    expect(job).toContain('liveState: reviewUsage')
    expect(job).toContain('generatorProvider: raw.provider')
  })

  test('the comprehensive-exam internal verification stays global in D2.4 (no REVIEW routing passed)', () => {
    const booksAi = readFileSync('src/lib/books-ai.ts', 'utf8')
    expect(booksAi).not.toContain("prepareStageRun('REVIEW')")
    expect(booksAi).not.toContain('onFallbackAttempt')
  })

  test('no auto-approval was introduced: accepted questions still carry human-review lineage flags', () => {
    const verifier = readFileSync('src/lib/question-verifier.ts', 'utf8')
    expect(verifier).toContain('NEEDS_HUMAN_REVIEW')
    expect(verifier).not.toContain('APPROVED')
  })
})

describe('D3.1: the runtime verifier != generator rule (exact pair)', () => {
  test('the pair filter removes only the exact generator pair', () => {
    const models = [
      { provider: 'GEMINI', model: 'gemini-2.5-pro' },
      { provider: 'OPENAI', model: 'gemini-2.5-pro' },
      { provider: 'GEMINI', model: 'gemini-other' },
    ]
    expect(__testFilterDistinctVerifierModelsForTests(models, 'GEMINI', 'gemini-2.5-pro'))
      .toEqual([models[1], models[2]])
    expect(__testFilterDistinctVerifierModelsForTests(models, 'gemini', 'GEMINI-2.5-PRO')).toHaveLength(2)
    expect(__testFilterDistinctVerifierModelsForTests(models, null, null)).toHaveLength(3)
  })

  test('a profile whose only verifier is the generator pair never calls the router; questions pend with a clear reason', async () => {
    routerCalls.length = 0
    let fallbackMarks = 0
    const out = await verifyQuestionsWithCrossProvider({
      questions: [QUESTION],
      sources: [{ text: SOURCE_TEXT }],
      generatorProvider: 'GEMINI',
      generatorModel: 'gemini-2.5-pro',
      routing: { preferredModels: [{ provider: 'GEMINI', model: 'gemini-2.5-pro' }], preferredProviders: [], policy: null, allowGlobalFallback: false },
      onFallbackAttempt: () => { fallbackMarks++ },
    })
    expect(routerCalls).toHaveLength(0)
    expect(fallbackMarks).toBe(0)
    expect(out[0].verificationPending).toBe(true)
    expect(out[0].verificationReason).toBe('VERIFIER_EQUALS_GENERATOR')
  })

  test('the same profile with fallback allowed goes global once and verifies there', async () => {
    routerCalls.length = 0
    let fallbackMarks = 0
    const out = await verifyQuestionsWithCrossProvider({
      questions: [QUESTION],
      sources: [{ text: SOURCE_TEXT }],
      generatorProvider: 'GEMINI',
      generatorModel: 'gemini-2.5-pro',
      routing: { preferredModels: [{ provider: 'GEMINI', model: 'gemini-2.5-pro' }], preferredProviders: [], policy: null, allowGlobalFallback: true },
      onFallbackAttempt: () => { fallbackMarks++ },
    })
    expect(routerCalls).toHaveLength(1)
    expect(routerCalls[0].restrictToModels).toBeUndefined()
    expect(fallbackMarks).toBe(1)
    expect(out[0].verifierProvider).toBe('ANTHROPIC')
  })

  test('a partially overlapping profile runs restricted with only the distinct models', async () => {
    routerCalls.length = 0
    restrictedBehavior = 'respond'
    let fallbackMarks = 0
    try {
      const out = await verifyQuestionsWithCrossProvider({
        questions: [QUESTION],
        sources: [{ text: SOURCE_TEXT }],
        generatorProvider: 'GEMINI',
        generatorModel: 'gemini-2.5-pro',
        routing: { preferredModels: [{ provider: 'GEMINI', model: 'gemini-2.5-pro' }, { provider: 'OPENAI', model: 'ver-v' }], preferredProviders: [], policy: null, allowGlobalFallback: false },
        onFallbackAttempt: () => { fallbackMarks++ },
      })
      expect(routerCalls).toHaveLength(1)
      expect(routerCalls[0].restrictToModels).toEqual([{ provider: 'OPENAI', model: 'ver-v' }])
      expect(fallbackMarks).toBe(0)
      expect(out[0].verifierProvider).toBe('ANTHROPIC')
    } finally {
      restrictedBehavior = 'throw'
    }
  })

  test('a response from the generator pair itself never stands, even when declared family games would pass it', async () => {
    routerCalls.length = 0
    generatorFamilyOverride = 'deepseek'
    responseContext = { provider: 'ALBORIHI', model: 'acme-pro', family: 'qwen' }
    try {
      const out = await verifyQuestionsWithCrossProvider({
        questions: [QUESTION],
        sources: [{ text: SOURCE_TEXT }],
        generatorProvider: 'ALBORIHI',
        generatorModel: 'acme-pro',
      })
      expect(routerCalls).toHaveLength(1)
      expect(out[0].verificationPending).toBe(true)
      expect(out[0].verificationReason).toBe('VERIFIER_EQUALS_GENERATOR')
      expect(out[0].qualityFlags).not.toContain('SOURCE_GROUNDED')
    } finally {
      generatorFamilyOverride = 'gemini'
      responseContext = { provider: 'ANTHROPIC', model: 'claude-v' }
    }
  })
})
