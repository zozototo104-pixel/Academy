import { describe, expect, mock, test } from 'bun:test'
import { PDFDocument } from 'pdf-lib'

// Step 6 — book OCR auto selection: the VISION ranking picks the OCR
// model (not the global order); an OCR-gate failure demotes the model
// mid-run; a group call that dies on budget records solo retries
// without re-running the group call for decided pages.
mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/gemini', () => ({ geminiCompleteJson: async () => '{"items":[]}' }))

let autoEnabled = true
let visionRanking: Array<{ provider: string; model: string }> = [
  { provider: 'GROQ', model: 'groq-model-a' },
  { provider: 'GROQ', model: 'groq-model-b' },
]
let lastRouterCall: any = null
mock.module('@/lib/text-ai', () => ({
  textAiCompleteJsonWithMetadata: async (opts: any) => {
    lastRouterCall = opts
    const first = opts.preferredModels?.[0]?.model || 'groq-model-a'
    return { text: '{"pages":[{"page":1,"text":"clean readable page text"}]}', provider: 'GROQ', model: first }
  },
  isTextAiAutoModeEnabled: async () => autoEnabled,
  autoRankingForPurpose: async () => [...visionRanking],
  CUSTOM_AI_PROVIDERS_SETTING: 'AI_CUSTOM_PROVIDERS',
  parseCustomTextAiProviders: () => [],
  pipelineConfigSnapshot: async () => ({ policy: 'primary_first', allowedModels: [], verifierPreferred: [] }),
}))

const reader = await import('../../src/lib/book-reader')
const autoMode = await import('../../src/lib/ai-auto-mode')
const { __testExtractPdfBatchInnerForTests, __testTranscribeWithMetaForTests } = reader

async function onePagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.addPage([612, 792])
  return Buffer.from(await doc.save())
}

describe('pickOcrModel — VISION ranking picks the OCR model', () => {
  test('first ranked candidate wins when its capability allows OCR', () => {
    const picked = autoMode.pickOcrModel({ ranking: visionRanking })
    expect(picked).toEqual({ provider: 'GROQ', model: 'groq-model-a' })
  })
  test('a candidate whose catalog says vision:false + ocr:false is skipped', () => {
    const picked = autoMode.pickOcrModel({
      ranking: visionRanking,
      capabilityOf: (provider, model) => (model === 'groq-model-a' ? { vision: false, ocr: false } : { vision: true, ocr: true }),
    })
    expect(picked).toEqual({ provider: 'GROQ', model: 'groq-model-b' })
  })
  test('empty ranking picks nothing — the caller falls back to the global order', () => {
    expect(autoMode.pickOcrModel({ ranking: [] })).toBeNull()
  })
})

describe('transcribeWithMeta — auto VISION ranking instead of the global order', () => {
  test('auto ON: the router call is pinned to the VISION ranking, top first', async () => {
    autoEnabled = true
    lastRouterCall = null
    const buffer = await onePagePdf()
    const result = await __testTranscribeWithMetaForTests(buffer, [1], Date.now() + 120_000, null)
    expect(result.autoSelected).toBe(true)
    expect(result.provider).toBe('GROQ')
    expect(lastRouterCall.preferredModels[0]).toEqual({ provider: 'GROQ', model: 'groq-model-a' })
    expect(lastRouterCall.restrictToModels[0]).toEqual({ provider: 'GROQ', model: 'groq-model-a' })
    expect(result.pages[0].text).toContain('clean readable page text')
  })

  test('auto OFF: no ranking pin — the global call goes out unpinned', async () => {
    autoEnabled = false
    lastRouterCall = null
    const buffer = await onePagePdf()
    const result = await __testTranscribeWithMetaForTests(buffer, [1], Date.now() + 120_000, null)
    expect(result.autoSelected).toBeUndefined()
    expect(lastRouterCall.preferredModels).toBeUndefined()
    expect(lastRouterCall.restrictToModels).toBeUndefined()
  })
})

describe('OCR-gate failure demotes the model in VISION rank mid-run', () => {
  test('3 OCR-gate failures demote ocr for VISION; the selector then skips that model', () => {
    const events = [1, 2, 3].map(() => autoMode.ocrGateFailureFeedbackEvent('GROQ', 'groq-model-a'))
    const { state, demotions } = autoMode.applyRunResultFeedback(autoMode.emptyCapabilityFeedbackState(), events)
    expect(demotions).toContainEqual(expect.objectContaining({ model: 'groq-model-a', purpose: 'VISION', flag: 'ocr' }))
    const demoted = autoMode.demotedCapabilityFlags(state, 'GROQ', 'groq-model-a', 'VISION')
    expect(demoted).toContain('ocr')
    const capability = autoMode.applyDemotedFlagsToCapability({ vision: true, ocr: true }, demoted)
    expect(capability?.ocr).toBe(false)
    const picked = autoMode.pickOcrModel({
      ranking: visionRanking,
      capabilityOf: (_p, model) => (model === 'groq-model-a' ? capability : { vision: true, ocr: true }),
    })
    expect(picked).toEqual({ provider: 'GROQ', model: 'groq-model-b' })
  })
  test('fewer than 3 gate failures do not demote — one bad call never demotes a model', () => {
    const { demotions } = autoMode.applyRunResultFeedback(
      autoMode.emptyCapabilityFeedbackState(),
      [autoMode.ocrGateFailureFeedbackEvent('GROQ', 'groq-model-a')],
    )
    expect(demotions).toEqual([])
  })
})

describe('group-call budget death — solo retries without re-running decided pages', () => {
  test('group call dies, solo recovery runs out of budget mid-batch: undecided pages are recorded solo, decided page 1 is kept, group never repeats', async () => {
    const BASE = Date.now()
    let fakeNow = BASE
    let groupCalls = 0
    const cleanOcrPage = 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية. '.repeat(50)
    const savedSolo: number[][] = []
    const savedProgress: Array<{ pagesDone: number }> = []
    const chunks: any[] = []
    const store = {
      upsertChunk: async (chunk: any) => { chunks.push({ ...chunk }) },
      saveProgress: async (_jobId: string, pagesDone: number) => { savedProgress.push({ pagesDone }) },
      saveOcrSoloPages: async (_jobId: string, pages: number[]) => { savedSolo.push([...pages]) },
    }
    const ocrPages = async (_buffer: Buffer, pages: number[]) => {
      if (pages.length > 1) {
        groupCalls++
        throw new Error('GROUP_DIED_ON_BUDGET')
      }
      if (pages[0] === 1) {
        // Solo page 1 succeeds — then the budget is spent before page 2.
        fakeNow = BASE + 290_000
        return [{ page: 1, text: cleanOcrPage, textProvenance: 'VISION_OCR' as const }]
      }
      return [{ page: pages[0], text: cleanOcrPage, textProvenance: 'VISION_OCR' as const }]
    }
    const result = await __testExtractPdfBatchInnerForTests({
      buffer: Buffer.from('not-a-real-pdf'),
      bookId: 'book-1', programId: 'program-1', jobId: 'job-1',
      pagesDone: 0, totalPages: 8, existingChunks: 0,
      store, deadlineMs: BASE + 300_000,
      extractPages: async (_buffer: Buffer, numbers: number[]) =>
        numbers.map((page) => ({ page, text: '', textProvenance: 'NATIVE_TEXT' as const })),
      ocrPages,
      clock: () => fakeNow,
    } as any)
    expect(groupCalls).toBe(1)
    expect(savedSolo).toEqual([[2, 3, 4]])
    expect(result.pagesDone).toBe(1)
    expect(savedProgress.at(-1)?.pagesDone).toBe(1)
    expect(chunks.length).toBe(1)
    expect(chunks[0].text).toContain('الأصول المتداولة')
  })
})
