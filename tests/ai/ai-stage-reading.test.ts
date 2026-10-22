import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

mock.module('@/lib/db', () => ({ db: { aiPipelineOperationLog: { create: async () => ({}) } } }))
mock.module('@/lib/text-ai', () => ({
  pipelineConfigSnapshot: async () => ({ policy: 'balanced', allowedModels: ['GEMINI:g'], verifierPreferred: [] }),
}))

const { buildStageRoutingOverrides, validateStageProfileSnapshot } = await import('@/lib/ai-stage-profiles')
const { __setPipelineLogDepsForTests, recordPipelineOperation } = await import('@/lib/ai-pipeline-log')

function stageResolution(snapshotRaw: Record<string, unknown>, stage: 'READING' | 'REVIEW' = 'READING') {
  return {
    kind: 'stage' as const,
    profileId: 'profile-1',
    version: 3,
    snapshot: validateStageProfileSnapshot(stage, snapshotRaw),
  }
}

describe('D2.1 reading wiring: routing overrides with strict validation', () => {
  test('a valid profile becomes ordered overrides', () => {
    const out = buildStageRoutingOverrides(stageResolution({
      provider: 'GEMINI',
      policy: 'balanced',
      models: [{ provider: 'GEMINI', model: 'm1' }, { provider: 'OPENAI', model: 'm2' }],
    }))
    expect(out.kind).toBe('stage')
    if (out.kind === 'stage') {
      expect(out.version).toBe(3)
      expect(out.preferredProviders).toEqual(['GEMINI'])
      expect(out.preferredModels.map((m) => m.model)).toEqual(['m1', 'm2'])
      expect(out.policy).toBe('balanced')
    }
  })

  test('an unknown policy makes the profile invalid (falls back to global at the call site)', () => {
    const out = buildStageRoutingOverrides(stageResolution({ policy: 'fastest_ever', models: [{ provider: 'GEMINI', model: 'm1' }] }))
    expect(out.kind).toBe('invalid')
    if (out.kind === 'invalid') expect(out.reason).toContain('policy')
  })

  test('an unknown provider anywhere makes the profile invalid', () => {
    expect(buildStageRoutingOverrides(stageResolution({ models: [{ provider: 'FOO', model: 'm' }] })).kind).toBe('invalid')
    expect(buildStageRoutingOverrides(stageResolution({ provider: 'AUTO', models: [{ provider: 'GEMINI', model: 'm' }] })).kind).toBe('invalid')
    expect(buildStageRoutingOverrides(stageResolution({ models: [], verifier: { preferred: [{ provider: 'BAR', model: 'm' }], strict: false } }, 'REVIEW')).kind).toBe('invalid')
  })

  test('global resolutions pass through with their reason untouched', () => {
    for (const reason of ['missing', 'disabled', 'empty-models'] as const) {
      expect(buildStageRoutingOverrides({ kind: 'global', reason })).toEqual({ kind: 'global', reason })
    }
  })
})

describe('D2.1 reading wiring: the D0 row carries the actual profile stamp', () => {
  test('a stamped run records profile id/version instead of the global stamp', async () => {
    const rows: Record<string, unknown>[] = []
    __setPipelineLogDepsForTests({
      writer: async (row) => { rows.push(row as unknown as Record<string, unknown>) },
      snapshot: async () => ({ policy: 'balanced', allowedModels: ['GEMINI:g'], verifierPreferred: [] }),
    })
    await recordPipelineOperation({
      stage: 'READING',
      bookId: 'book-1',
      batchId: 'job-1',
      inputText: 'pdf bytes',
      latencyMs: 10,
      success: true,
      profileStamp: { profileId: 'profile-1', profileVersion: '3', policy: 'balanced', allowedModels: ['GEMINI:m1'] },
      outcome: { provider: 'GEMINI', model: 'm1' },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].profileId).toBe('profile-1')
    expect(rows[0].profileVersion).toBe('3')
    expect(rows[0].provider).toBe('GEMINI')
    expect((rows[0].allowedModelsSnapshot as { allowedModels: string[] }).allowedModels).toEqual(['GEMINI:m1'])
  })
})

describe('D2.1 reading wiring: scope guards', () => {
  test('only the reading boundary resolves profiles in this step', () => {
    expect(readFileSync('src/lib/book-reader.ts', 'utf8')).toContain("resolveEffectiveStageProfile('READING')")
    for (const file of ['src/lib/book-chunk-analyzer.ts', 'src/lib/question-bank-job.ts', 'src/lib/question-verifier.ts', 'src/lib/books-ai.ts']) {
      expect(readFileSync(file, 'utf8')).not.toContain('resolveEffectiveStageProfile')
    }
  })

  test('the OCR call applies overrides but keeps the historical default policy', () => {
    const reader = readFileSync('src/lib/book-reader.ts', 'utf8')
    expect(reader).toContain('textAiCompleteJsonWithMetadata')
    expect(reader).toContain("overrides?.policy ?? 'primary_first'")
    expect(reader).toContain('preferredModels')
    expect(reader).toContain('fallbackUsed: !isStage')
  })
})
