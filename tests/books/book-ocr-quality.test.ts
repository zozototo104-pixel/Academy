import { mock, describe, test, expect } from 'bun:test'
import { PDFDocument } from 'pdf-lib'

// The reader pulls the Prisma client at import time, and the sandbox has
// no generated client, so the database module is mocked here; the extract
// step under test never touches the database (store/pages/OCR are injected).
mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/gemini', () => ({ geminiCompleteJson: async () => '{"items":[]}' }))

// The OCR call goes through the router; stub it so the verification can be
// exercised without a live provider. The other names are what the reader's
// import chain binds at load time (stage profiles, pipeline log).
let nextOcrMeta: () => Promise<{ text: string; provider: string; model: string }> = async () => ({
  text: '{"pages":[{"page":1,"text":""}]}', provider: 'GEMINI', model: 'gemini-3.5-flash-lite',
})
mock.module('@/lib/text-ai', () => ({
  textAiCompleteJsonWithMetadata: async () => nextOcrMeta(),
  textAiAutomaticManagementEnabled: async () => false,
  CUSTOM_AI_PROVIDERS_SETTING: 'AI_CUSTOM_PROVIDERS',
  parseCustomTextAiProviders: () => [],
  pipelineConfigSnapshot: () => ({}),
}))

const reader = await import('../../src/lib/book-reader')
const { __testExtractPdfBatchInnerForTests, __testTranscribeOnceForTests, pagesNeedingOcr, pageNeedsOcrText } = reader

const cleanPage = 'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة. '.repeat(50)
const cleanOcrPage = 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية. '.repeat(50)
const garbledPage = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)

type SavedChunk = { index: number; pageStart: number; pageEnd: number; text: string; textProvenance: string }
type SavedIssue = { page: number; kind: string; reason: string }

function makeStore() {
  const chunks: SavedChunk[] = []
  const issues: SavedIssue[] = []
  return {
    chunks,
    issues,
    store: {
      upsertChunk: async (chunk: SavedChunk) => { chunks.push({ ...chunk }) },
      saveProgress: async (_jobId: string, _pagesDone: number, _totalPages: number, _totalChunks: number, _phase: string, nextIssues: readonly SavedIssue[] = []) => {
        issues.push(...nextIssues.map((issue) => ({ ...issue })))
      },
    },
  }
}

function runExtract(pages: { page: number; text: string }[], ocr: (pages: number[]) => Promise<{ page: number; text: string; textProvenance: 'VISION_OCR' }[]>) {
  const { store, ...collected } = makeStore()
  const input = {
    buffer: Buffer.from('not-a-real-pdf'),
    bookId: 'book-1', programId: 'program-1', jobId: 'job-1',
    pagesDone: 0, totalPages: pages.length, existingChunks: 0,
    store, deadlineMs: Date.now() + 120_000,
    extractPages: async () => pages.map((p) => ({ ...p, textProvenance: 'NATIVE_TEXT' as const })),
    ocrPages: async (_buffer: Buffer, numbers: number[]) => ocr(numbers),
  }
  return { collected, promise: __testExtractPdfBatchInnerForTests(input as any) }
}

describe('page quality gate at extraction', () => {
  test('a garbled long page needs OCR, a clean long page does not', () => {
    expect(pageNeedsOcrText(garbledPage)).toBe(true)
    expect(pageNeedsOcrText(cleanPage)).toBe(false)
    expect(pageNeedsOcrText('short')).toBe(true)
    const batches = pagesNeedingOcr([
      { page: 1, text: cleanPage },
      { page: 2, text: garbledPage },
      { page: 3, text: '' },
    ])
    expect(batches).toEqual([[2, 3]])
  })

  test('a garbled page recovered by OCR becomes a VISION_OCR chunk', async () => {
    const { collected, promise } = runExtract(
      [{ page: 1, text: cleanPage }, { page: 2, text: garbledPage }],
      async (numbers) => numbers.map((page) => ({ page, text: cleanOcrPage, textProvenance: 'VISION_OCR' as const })),
    )
    const result = await promise
    expect(result.pagesDone).toBe(2)
    expect(collected.chunks.length).toBe(2)
    expect(collected.chunks[0].textProvenance).toBe('NATIVE_TEXT')
    expect(collected.chunks[1].textProvenance).toBe('VISION_OCR')
    expect(collected.chunks[1].text).toContain('الأصول المتداولة')
    expect(collected.chunks.some((chunk) => chunk.text.includes('□'))).toBe(false)
    expect(collected.issues.filter((issue) => issue.kind === 'UNREADABLE')).toEqual([])
  })

  test('a garbled page whose OCR fails is dropped as UNREADABLE and the clean page survives', async () => {
    const { collected, promise } = runExtract(
      [{ page: 1, text: cleanPage }, { page: 2, text: garbledPage }],
      async () => { throw new Error('OCR_PROVIDER_DOWN') },
    )
    const result = await promise
    expect(result.pagesDone).toBe(2)
    expect(collected.chunks.length).toBe(1)
    expect(collected.chunks[0].pageStart).toBe(1)
    expect(collected.chunks[0].textProvenance).toBe('NATIVE_TEXT')
    expect(collected.chunks.some((chunk) => chunk.text.includes('□'))).toBe(false)
    expect(collected.issues).toContainEqual(expect.objectContaining({ page: 2, kind: 'UNREADABLE' }))
  })

  test('a garbled OCR answer is a failure for that page, never saved text', async () => {
    const { collected, promise } = runExtract(
      [{ page: 1, text: cleanPage }, { page: 2, text: garbledPage }],
      async (numbers) => numbers.map((page) => ({ page, text: garbledPage, textProvenance: 'VISION_OCR' as const })),
    )
    await promise
    expect(collected.chunks.length).toBe(1)
    expect(collected.chunks[0].pageStart).toBe(1)
    expect(collected.chunks.some((chunk) => chunk.text.includes('□'))).toBe(false)
    expect(collected.issues).toContainEqual(expect.objectContaining({ page: 2, kind: 'UNREADABLE', reason: 'OCR_TEXT_FAILED_VERIFICATION' }))
  })

  test('a clean native page is still chunked as NATIVE_TEXT with no issues', async () => {
    const { collected, promise } = runExtract(
      [{ page: 1, text: cleanPage }],
      async () => { throw new Error('OCR_MUST_NOT_RUN') },
    )
    const result = await promise
    expect(result.pagesDone).toBe(1)
    expect(collected.chunks.length).toBe(1)
    expect(collected.chunks[0].textProvenance).toBe('NATIVE_TEXT')
    expect(collected.issues).toEqual([])
  })
})

describe('OCR result verification', () => {
  test('a broken OCR answer fails the call instead of becoming a page', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([595, 842])
    const buffer = Buffer.from(await pdf.save())
    nextOcrMeta = async () => ({
      text: JSON.stringify({ pages: [{ page: 1, text: garbledPage }] }),
      provider: 'GEMINI', model: 'gemini-3.5-flash-lite',
    })
    await expect(__testTranscribeOnceForTests(buffer, [1], Date.now() + 120_000, null))
      .rejects.toThrow('OCR_TEXT_FAILED_VERIFICATION')
  })

  test('a clean OCR answer is returned as VISION_OCR', async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage([595, 842])
    const buffer = Buffer.from(await pdf.save())
    nextOcrMeta = async () => ({
      text: JSON.stringify({ pages: [{ page: 1, text: cleanOcrPage }] }),
      provider: 'GEMINI', model: 'gemini-3.5-flash-lite',
    })
    const out = await __testTranscribeOnceForTests(buffer, [1], Date.now() + 120_000, null)
    expect(out.pages).toEqual([{ page: 1, text: cleanOcrPage.trim(), textProvenance: 'VISION_OCR' }])
    expect(out.provider).toBe('GEMINI')
  })
})
