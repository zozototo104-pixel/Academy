import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// عزل كامل عن قاعدة البيانات والراوتر: الوحدة تُستورد بعد تثبيت البدائل،
// فتعمل الباقة في أي بيئة (حتى بلا عميل Prisma مولّد).
mock.module('@/lib/db', () => ({ db: { aiPipelineOperationLog: { create: async () => ({}) } } }))
mock.module('@/lib/text-ai', () => ({
  pipelineConfigSnapshot: async () => ({ policy: 'balanced', allowedModels: ['GEMINI:gemini-3.8-flash'], verifierPreferred: ['GEMINI:gemini-3.8-flash'] }),
}))

const {
  __setPipelineLogDepsForTests,
  classifyPipelineFailure,
  hashPipelineData,
  recordPipelineOperation,
  withPipelineRun,
} = await import('@/lib/ai-pipeline-log')

const SNAPSHOT = { policy: 'balanced', allowedModels: ['GEMINI:gemini-3.8-flash'], verifierPreferred: ['GEMINI:gemini-3.8-flash'] }

function capture() {
  const rows: Record<string, unknown>[] = []
  __setPipelineLogDepsForTests({
    writer: async (row) => { rows.push(row as unknown as Record<string, unknown>) },
    snapshot: async () => SNAPSHOT,
  })
  return rows
}

describe('D0 pipeline telemetry: row shape and profile stamp', () => {
  test('a run is recorded with every D0 field and the config version stamp', async () => {
    const rows = capture()
    await recordPipelineOperation({
      stage: 'GENERATION',
      bookId: 'book-1',
      batchId: 'job-1',
      unitId: 'unit-1',
      inputText: 'knowledge text',
      promptText: 'system prompt',
      latencyMs: 1234,
      success: true,
      outcome: { provider: 'GEMINI', model: 'gemini-3.8-flash', outputCount: 4 },
    })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.stage).toBe('GENERATION')
    expect(row.profileId).toBe('global')
    expect(row.profileVersion).toBe(hashPipelineData(JSON.stringify({ policy: 'balanced', allowedModels: SNAPSHOT.allowedModels, verifierPreferred: SNAPSHOT.verifierPreferred })))
    expect(row.provider).toBe('GEMINI')
    expect(row.model).toBe('gemini-3.8-flash')
    expect(row.policy).toBe('balanced')
    expect(row.allowedModelsSnapshot).toEqual({ allowedModels: SNAPSHOT.allowedModels, verifierPreferred: SNAPSHOT.verifierPreferred })
    expect(row.bookId).toBe('book-1')
    expect(row.batchId).toBe('job-1')
    expect(row.unitId).toBe('unit-1')
    expect(row.inputHash).toBe(hashPipelineData('knowledge text'))
    expect(row.promptHash).toBe(hashPipelineData('system prompt'))
    expect(row.outputCount).toBe(4)
    expect(row.latencyMs).toBe(1234)
    expect(row.success).toBe(true)
    expect(row.failureCategory).toBeNull()
    expect(row.fallbackUsed).toBe(false)
  })

  test('the profile version changes when the effective config changes', async () => {
    const rows = capture()
    await recordPipelineOperation({ stage: 'REVIEW', inputText: 'x', latencyMs: 1, success: true })
    __setPipelineLogDepsForTests({
      writer: async (row) => { rows.push(row as unknown as Record<string, unknown>) },
      snapshot: async () => ({ ...SNAPSHOT, allowedModels: ['GEMINI:other-model'] }),
    })
    await recordPipelineOperation({ stage: 'REVIEW', inputText: 'x', latencyMs: 1, success: true })
    expect(rows).toHaveLength(2)
    expect(rows[0].profileVersion).not.toBe(rows[1].profileVersion)
  })

  test('a snapshot failure still records the run, stamped unknown', async () => {
    const rows: Record<string, unknown>[] = []
    __setPipelineLogDepsForTests({
      writer: async (row) => { rows.push(row as unknown as Record<string, unknown>) },
      snapshot: async () => { throw new Error('settings down') },
    })
    await recordPipelineOperation({ stage: 'READING', inputText: 'x', latencyMs: 5, success: true })
    expect(rows).toHaveLength(1)
    expect(rows[0].profileVersion).toBe('unknown')
  })

  test('a writer failure is swallowed — logging never breaks the pipeline', async () => {
    __setPipelineLogDepsForTests({
      writer: async () => { throw new Error('db down') },
      snapshot: async () => SNAPSHOT,
    })
    await expect(recordPipelineOperation({ stage: 'ANALYSIS', inputText: 'x', latencyMs: 1, success: true })).resolves.toBeUndefined()
  })
})

describe('D0 pipeline telemetry: run wrapper', () => {
  test('success returns the value untouched and records the mapped outcome', async () => {
    const rows = capture()
    const value = await withPipelineRun(
      { stage: 'REVIEW', batchId: 'job-9', inputText: 'q texts' },
      async () => [{ verifierProvider: 'OPENAI', verifierModel: 'gpt-x' }],
      (v) => ({ provider: v[0].verifierProvider, model: v[0].verifierModel, outputCount: v.length, detail: { generatorProvider: 'GEMINI', generatorModel: 'gemini-3.8-flash' } }),
    )
    expect(value).toHaveLength(1)
    expect(rows).toHaveLength(1)
    expect(rows[0].success).toBe(true)
    expect(rows[0].provider).toBe('OPENAI')
    expect((rows[0].detail as Record<string, unknown>).generatorProvider).toBe('GEMINI')
  })

  test('failure records the category and rethrows the original error', async () => {
    const rows = capture()
    const boom = new Error('BOOK_EXTRACT_DEADLINE exceeded')
    await expect(withPipelineRun({ stage: 'READING', inputText: 'x' }, async () => { throw boom })).rejects.toBe(boom)
    expect(rows).toHaveLength(1)
    expect(rows[0].success).toBe(false)
    expect(rows[0].failureCategory).toBe('TIMEOUT')
  })

  test('failure categories classify the pipeline typical errors', () => {
    expect(classifyPipelineFailure(new Error('429 rate limit exceeded'))).toBe('RATE_LIMIT')
    expect(classifyPipelineFailure(new Error('VERIFIER_TIME_BUDGET_EXCEEDED'))).toBe('TIMEOUT')
    expect(classifyPipelineFailure(new Error('QUESTION_BANK_GENERATION_NO_FRESH_CANDIDATES'))).toBe('EMPTY_OUTPUT')
    expect(classifyPipelineFailure(new Error('Invalid JSON parse'))).toBe('VALIDATION')
    expect(classifyPipelineFailure(new Error('TEXT_AI_ROUTER_FAILED'))).toBe('PROVIDER_ERROR')
    expect(classifyPipelineFailure(new Error('something else'))).toBe('UNKNOWN')
  })
})

describe('D0 pipeline telemetry: schema and wiring guards', () => {
  const schema = readFileSync('prisma/schema.prisma', 'utf8')
  const migration = readFileSync('prisma/migrations/20261022160000_ai_pipeline_operation_log/migration.sql', 'utf8')

  test('the log model carries the full D0 field set', () => {
    expect(schema).toContain('model AiPipelineOperationLog')
    for (const field of ['stage', 'profileId', 'profileVersion', 'provider', 'model', 'policy', 'allowedModelsSnapshot', 'bookId', 'batchId', 'unitId', 'promptVersion', 'promptHash', 'inputHash', 'outputId', 'outputCount', 'latencyMs', 'inputTokens', 'outputTokens', 'costCents', 'success', 'failureCategory', 'fallbackUsed', 'detail']) {
      expect(schema).toContain(field)
    }
    for (const stage of ['READING', 'ANALYSIS', 'GENERATION', 'REVIEW']) {
      expect(schema).toContain(stage)
    }
    expect(migration).toContain('CREATE TABLE "AiPipelineOperationLog"')
  })

  test('all four stage boundaries are wired, and only in pipeline files', () => {
    expect(readFileSync('src/lib/book-reader.ts', 'utf8')).toContain("stage: 'READING'")
    expect(readFileSync('src/lib/book-chunk-analyzer.ts', 'utf8')).toContain("stage: 'ANALYSIS'")
    const job = readFileSync('src/lib/question-bank-job.ts', 'utf8')
    expect(job).toContain("stage: 'GENERATION'")
    expect(job).toContain("stage: 'REVIEW'")
    expect(job).toContain('generatorProvider: raw.provider')
  })

  test('the recorder itself never rethrows and stamps the global profile', () => {
    const source = readFileSync('src/lib/ai-pipeline-log.ts', 'utf8')
    expect(source).toContain("profileId: 'global'")
    expect(source).toContain('لا يكسر التشغيل أبدًا')
  })
})

describe('D2.1c: liveState marks a fallback attempt even when the fallback itself fails', () => {
  test('a failed run whose liveState decided a global fallback records fallbackUsed + reason', async () => {
    const rows: Record<string, unknown>[] = []
    __setPipelineLogDepsForTests({
      writer: async (row) => { rows.push(row as unknown as Record<string, unknown>) },
      snapshot: async () => ({ policy: 'balanced', allowedModels: [], verifierPreferred: [] }),
    })
    const liveState: { fallbackUsed?: boolean; fallbackReason?: string } = {}
    // لحظة اتخاذ قرار الرجوع — قبل معرفة نتيجة محاولة الرجوع
    liveState.fallbackUsed = true
    liveState.fallbackReason = 'all-stage-models-failed'
    await recordPipelineOperation({
      stage: 'READING',
      bookId: 'book-1',
      inputText: 'pdf',
      latencyMs: 5,
      success: false,
      failureCategory: 'PROVIDER_ERROR',
      fallbackUsed: false,
      liveState,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].success).toBe(false)
    expect(rows[0].fallbackUsed).toBe(true)
    expect((rows[0].detail as Record<string, unknown>).fallbackReason).toBe('all-stage-models-failed')
  })
})
