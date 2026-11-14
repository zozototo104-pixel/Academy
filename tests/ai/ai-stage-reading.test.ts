import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PDFDocument } from 'pdf-lib'

let visionRouterCall: (opts: any) => Promise<{ text: string; provider: string; model: string }> =
  async () => { throw new Error('VISION_MOCK_NOT_CONFIGURED') }
mock.module('@/lib/db', () => ({ db: { aiPipelineOperationLog: { create: async () => ({}) } } }))
mock.module('@/lib/text-ai', () => ({
  pipelineConfigSnapshot: async () => ({ policy: 'balanced', allowedModels: ['GEMINI:g'], verifierPreferred: [] }),
  CUSTOM_AI_PROVIDERS_SETTING: 'AI_CUSTOM_PROVIDERS',
  parseCustomTextAiProviders: () => [],
  textAiCompleteJsonWithMetadata: async (opts: any) => visionRouterCall(opts),
}))

const { buildStageRoutingOverrides, validateStageProfileSnapshot, __setStageProfileStoreForTests } = await import('@/lib/ai-stage-profiles')
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
  test('books and knowledge use the router rather than the unavailable Z-AI SDK', () => {
    const books = readFileSync('src/lib/books-ai.ts', 'utf8')
    const knowledge = readFileSync('src/lib/knowledge-bank.ts', 'utf8')
    for (const source of [books, knowledge]) {
      expect(source).not.toContain('getZAI()')
      expect(source).not.toContain('chatWithRetry(')
    }
    expect(books).toContain("taskType: 'BOOK_GENERATION_FALLBACK'")
    expect(books).toContain("taskLevel: 'ACADEMIC_CRITICAL'")
    expect(books).toContain('validate: args.validate')
    expect(knowledge).toContain("taskType: 'BOOK_KNOWLEDGE_FALLBACK'")
    expect(knowledge).toContain("taskType: 'BOOK_METADATA_BLUEPRINT'")
    expect(knowledge).toContain('hasBalancedKnowledgeShape(normalized)')
    expect(knowledge).toContain("sourceNote: 'خطة معرفة مبنية على توصيف الكتاب لا على قراءة نصه الكامل'")
    expect(knowledge).toContain("buildMode = 'TEXT_DETERMINISTIC'")
    expect(knowledge).toContain("buildMode = 'METADATA'")
  })

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

  test('a legacy lowercase APINEX REVIEW profile routes correctly without rewriting history', () => {
    const resolution = stageResolution({
      models: [{ provider: 'apinex', model: 'free/kimi-k3' }],
      verifier: { preferred: [{ provider: 'apinex', model: 'free/deepseek-v4-pro-0813' }], strict: false },
    }, 'REVIEW')
    const out = buildStageRoutingOverrides(resolution)
    expect(out.kind).toBe('stage')
    if (out.kind === 'stage') {
      expect(out.preferredModels).toEqual([{ provider: 'APINEX', model: 'free/kimi-k3' }])
      expect(out.snapshot.verifier?.preferred).toEqual([{ provider: 'APINEX', model: 'free/deepseek-v4-pro-0813' }])
    }
    // Historical versioned snapshots remain immutable, only the runtime view is canonical.
    expect(resolution.snapshot.models[0].provider).toBe('apinex')
    expect(resolution.snapshot.verifier?.preferred[0].provider).toBe('apinex')
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
    // D2.2 update: the analyzer now resolves ANALYSIS itself; generation
    // and review paths must still stay clean until their own D2 steps.
    for (const file of ['src/lib/question-bank-job.ts', 'src/lib/question-verifier.ts', 'src/lib/books-ai.ts']) {
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

  test('D2.1b: a stage profile is a hard allowlist, not a hint', () => {
    const reader = readFileSync('src/lib/book-reader.ts', 'utf8')
    // the strict attempt restricts the router to the profile's models
    expect(reader).toContain('restrictToModels')
    // all-stage-models failure: one global retry only when the profile
    // allows it, marked with the agreed reason; otherwise the run fails
    expect(reader).toContain('all-stage-models-failed')
    expect(reader).toContain('if (!overrides.allowGlobalFallback) throw error')
    expect(reader).toContain('fellBack: true')
  })

  test('D2.1c: the fallback mark is set at decision time and reaches failure rows', () => {
    const reader = readFileSync('src/lib/book-reader.ts', 'utf8')
    expect(reader).toContain('onFallbackAttempt?.()')
    expect(reader).toContain('liveState: aiUsage')
    const log = readFileSync('src/lib/ai-pipeline-log.ts', 'utf8')
    expect(log).toContain('ctx.liveState?.fallbackUsed')
  })

  test('D2.1b: the router enforces restrictToModels on providers and candidates', () => {
    const router = readFileSync('src/lib/text-ai.ts', 'utf8')
    expect(router).toContain('restrictToModels?: TextAiPreferredModel[]')
    expect(router).toContain('applyModelRestriction(')
    expect(router).toContain('restrictSet.has(provider)')
  })
})

describe('legacy book readers: profile rescue only after failure', () => {
  function configureReadingProfile(enabled: boolean) {
    __setStageProfileStoreForTests({
      loadCurrent: async () => ({
        profileId: 'reader-rescue',
        version: 6,
        snapshot: validateStageProfileSnapshot('READING', {
          enabled,
          provider: 'OPENAI',
          policy: 'primary_first',
          models: [{ provider: 'OPENAI', model: 'gpt-4o' }],
          allowGlobalFallback: true,
        }),
      }),
      saveVersion: async () => { throw new Error('NOT_USED') },
      loadVersions: async () => [],
    })
  }

  test('outline OCR keeps a successful original router call, without consulting stage models', async () => {
    const { transcribeScannedDocumentWithVision } = await import('@/lib/book-reader')
    configureReadingProfile(true)
    const pdf = await PDFDocument.create()
    pdf.addPage([300, 400])
    const calls: any[] = []
    visionRouterCall = async (opts) => {
      calls.push(opts)
      return { provider: 'GEMINI', model: 'original', text: JSON.stringify({ pages: [{ page: 1, text: 'النص الأصلي المقروء' }] }) }
    }
    try {
      const pages = await transcribeScannedDocumentWithVision(Buffer.from(await pdf.save()), [1])
      expect(pages[0].text).toBe('النص الأصلي المقروء')
      expect(calls).toHaveLength(1)
      expect(calls[0].restrictToModels).toBeUndefined()
    } finally {
      __setStageProfileStoreForTests(null)
    }
  })

  test('failed outline OCR retries identical source pages strictly inside READING profile', async () => {
    const { transcribeScannedDocumentWithVision } = await import('@/lib/book-reader')
    configureReadingProfile(true)
    const pdf = await PDFDocument.create()
    pdf.addPage([300, 400])
    const calls: any[] = []
    visionRouterCall = async (opts) => {
      calls.push(opts)
      if (calls.length === 1) throw new Error('primary quota exhausted')
      return { provider: 'OPENAI', model: 'gpt-4o', text: JSON.stringify({ pages: [{ page: 1, text: 'النص المستعاد من نفس الصفحة' }] }) }
    }
    try {
      const pages = await transcribeScannedDocumentWithVision(Buffer.from(await pdf.save()), [1])
      expect(pages[0].text).toBe('النص المستعاد من نفس الصفحة')
      expect(calls).toHaveLength(2)
      expect(calls[0].restrictToModels).toBeUndefined()
      expect(calls[1].restrictToModels).toEqual([{ provider: 'OPENAI', model: 'gpt-4o' }])
      expect(calls[1].attachments.map((attachment: any) => attachment.mimeType)).toEqual(['application/pdf'])
    } finally {
      __setStageProfileStoreForTests(null)
    }
  })

  test('disabled READING profile preserves the historical failure, without retry', async () => {
    const { transcribeScannedDocumentWithVision } = await import('@/lib/book-reader')
    configureReadingProfile(false)
    const pdf = await PDFDocument.create()
    pdf.addPage([300, 400])
    let calls = 0
    visionRouterCall = async () => { calls++; throw new Error('primary quota exhausted') }
    try {
      expect(transcribeScannedDocumentWithVision(Buffer.from(await pdf.save()), [1])).rejects.toThrow('primary quota exhausted')
      // The rejection above is checked before inspecting the attempt counter.
      await expect(transcribeScannedDocumentWithVision(Buffer.from(await pdf.save()), [1])).rejects.toThrow('primary quota exhausted')
      expect(calls).toBe(2)
    } finally {
      __setStageProfileStoreForTests(null)
    }
  })

  test('original document vision rescue is a restricted, opt-in model call', async () => {
    const { rescueOriginalBookVisionWithReadingProfile } = await import('@/lib/book-reader')
    configureReadingProfile(true)
    const calls: any[] = []
    visionRouterCall = async (opts) => {
      calls.push(opts)
      const text = '{"textContent":"محتوى الكتاب"}'
      opts.validate?.(text)
      return { provider: 'OPENAI', model: 'gpt-4o', text }
    }
    try {
      const rescued = await rescueOriginalBookVisionWithReadingProfile({
        buffer: Buffer.from('image-bytes'), mimeType: 'image/png', prompt: 'انسخ النص', maxOutputTokens: 1024,
      })
      expect(rescued?.provider).toBe('OPENAI')
      expect(calls).toHaveLength(1)
      expect(calls[0].attachments[0].mimeType).toBe('image/png')
      expect(calls[0].restrictToModels).toEqual([{ provider: 'OPENAI', model: 'gpt-4o' }])
    } finally {
      __setStageProfileStoreForTests(null)
    }
  })

  test('knowledge rebuild only accesses the reading/analysis profiles on legacy failures', () => {
    const content = readFileSync('src/lib/book-content.ts', 'utf8')
    const knowledge = readFileSync('src/lib/knowledge-bank.ts', 'utf8')
    const reader = readFileSync('src/lib/book-reader.ts', 'utf8')
    expect(content.indexOf('const visual = await readVisualDocumentWithGemini')).toBeLessThan(content.indexOf('rescueOriginalBookVisionWithReadingProfile'))
    expect(knowledge.indexOf('geminiVisionJson({', knowledge.indexOf('async function aiKnowledgeItemsFromUploadedFile'))).toBeLessThan(knowledge.indexOf('rescueOriginalBookVisionWithReadingProfile', knowledge.indexOf('async function aiKnowledgeItemsFromUploadedFile')))
    expect(knowledge).toContain("await prepareStageRun('ANALYSIS')")
    expect(knowledge).toContain('restrictToModels: models')
    expect(reader).toContain('allowGlobalFallback: false')
  })
})
