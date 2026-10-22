import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

mock.module('@/lib/db', () => ({ db: { aiPipelineOperationLog: { create: async () => ({}) } } }))
mock.module('@/lib/text-ai', () => ({
  pipelineConfigSnapshot: async () => ({ policy: 'balanced', allowedModels: ['GEMINI:g'], verifierPreferred: [] }),
}))

const { buildStageRoutingOverrides, validateStageProfileSnapshot } = await import('@/lib/ai-stage-profiles')
const { __setPipelineLogDepsForTests, recordPipelineOperation } = await import('@/lib/ai-pipeline-log')

describe('D2.2 analysis wiring: profile semantics for the ANALYSIS stage', () => {
  test('an ANALYSIS profile builds the same strict overrides as reading', () => {
    const out = buildStageRoutingOverrides({
      kind: 'stage',
      profileId: 'analysis-1',
      version: 2,
      snapshot: validateStageProfileSnapshot('ANALYSIS', {
        provider: 'GEMINI',
        models: [{ provider: 'GEMINI', model: 'gemini-a' }],
        allowGlobalFallback: false,
      }),
    })
    expect(out.kind).toBe('stage')
    if (out.kind === 'stage') {
      expect(out.allowGlobalFallback).toBe(false)
      expect(out.preferredModels).toEqual([{ provider: 'GEMINI', model: 'gemini-a' }])
    }
  })

  test('verifier settings stay impossible outside REVIEW', () => {
    expect(() => validateStageProfileSnapshot('ANALYSIS', { models: [], verifier: { preferred: [], strict: false } })).toThrow()
  })
})

describe('D2.2 analysis wiring: the D0 row carries the analysis stamp and live fallback state', () => {
  test('a stamped ANALYSIS run records profile, provider/model and decision-time fallback', async () => {
    const rows: Record<string, unknown>[] = []
    __setPipelineLogDepsForTests({
      writer: async (row) => { rows.push(row as unknown as Record<string, unknown>) },
      snapshot: async () => ({ policy: 'balanced', allowedModels: [], verifierPreferred: [] }),
    })
    const liveState = { fallbackUsed: true, fallbackReason: 'all-stage-models-failed' }
    await recordPipelineOperation({
      stage: 'ANALYSIS',
      bookId: 'book-1',
      inputText: 'chunk',
      latencyMs: 7,
      success: true,
      profileStamp: { profileId: 'analysis-1', profileVersion: '2', policy: null, allowedModels: ['GEMINI:gemini-a'] },
      liveState,
      outcome: { provider: 'GEMINI', model: 'gemini-a', outputCount: 4 },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].stage).toBe('ANALYSIS')
    expect(rows[0].profileId).toBe('analysis-1')
    expect(rows[0].provider).toBe('GEMINI')
    expect(rows[0].fallbackUsed).toBe(true)
    expect((rows[0].detail as Record<string, unknown>).fallbackReason).toBe('all-stage-models-failed')
  })
})

describe('D2.2 analysis wiring: scope and strictness guards', () => {
  test('the analyzer resolves ANALYSIS and applies the strict pattern', () => {
    const analyzer = readFileSync('src/lib/book-chunk-analyzer.ts', 'utf8')
    expect(analyzer).toContain("resolveEffectiveStageProfile('ANALYSIS')")
    expect(analyzer).toContain('restrictToModels: models')
    expect(analyzer).toContain('liveState: usage')
    // الوسم يُضبط قبل إعادة المحاولة العالمية داخل callAnalysisAi
    const mark = analyzer.indexOf('usage.fallbackUsed = true')
    const retry = analyzer.indexOf('return geminiCompleteJson(withUsageCapture(baseOpts, usage))', mark)
    expect(mark).toBeGreaterThan(-1)
    expect(retry).toBeGreaterThan(mark)
  })

  test('gemini forwards the routing fields and filters its native chain', () => {
    const gemini = readFileSync('src/lib/gemini.ts', 'utf8')
    expect(gemini).toContain('restrictToModels?: TextAiPreferredModel[]')
    expect(gemini).toContain('opts.restrictToModels!.some((m) => m.provider === \'GEMINI\'')
    expect(gemini).toContain('GEMINI_NO_ALLOWED_MODELS')
  })

  test('the review path still does not resolve profiles directly', () => {
    // D2.3 update: generation now wires through the shared stage runner
    // (prepareStageRun), not by resolving profiles itself; the verifier
    // stays completely unwired until D2.4.
    expect(readFileSync('src/lib/question-verifier.ts', 'utf8')).not.toContain('resolveEffectiveStageProfile')
    expect(readFileSync('src/lib/question-verifier.ts', 'utf8')).not.toContain('prepareStageRun')
  })
})
