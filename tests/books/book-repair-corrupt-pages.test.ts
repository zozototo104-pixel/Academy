import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { NextRequest } from 'next/server'
import { PDFDocument } from 'pdf-lib'

// Repair route tests (point 5 of the 2026-11-24 OCR quality fix):
// re-read ONLY corrupt pages from the original PDF via OCR, verify the
// corrected text, replace the chunk text and re-queue analysis — never a
// rebuild, never deleting linked knowledge. Mock DB follows the
// book-read-failure-honesty pattern; no production records are touched.
const cleanArabic = 'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة. '.repeat(50)
const cleanOcr = 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية. '.repeat(50)
const garbled = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)

type ChunkRow = { id: string; index: number; pageStart: number; pageEnd: number; text: string; contentHash: string; status: string; textProvenance?: string; charCount?: number; attempts?: number; lastError?: string | null; analysisPasses?: number; saturatedAt?: Date | null }
type JobRow = { id: string; bookId: string; status: string; phase: string; retryAt: Date | null; lockedUntil: Date | null; lastError: string | null; chunksFailed?: number; finishedAt?: Date | null }
type ItemRow = { id: string }

let chunks: ChunkRow[]
let job: JobRow | null
let items: ItemRow[]
let linkedQuestions = 0
let linkedAssignments: unknown[] = []
let linkedGuides: unknown[] = []
let pdfAvailable = true
let ocrImpl: (pages: number[]) => Promise<{ page: number; text: string }[]> = async (pages) =>
  pages.map((page) => ({ page, text: cleanOcr }))

const pdfFixture = await PDFDocument.create()
pdfFixture.addPage([595, 842])
const repairPdf = Buffer.from(await pdfFixture.save())

mock.module('@/lib/storage', () => ({
  getFileBufferFromStorageOrBase64: async () => (pdfAvailable ? { buffer: repairPdf } : null),
}))
mock.module('@/lib/notify', () => ({ audit: async () => undefined }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', role: 'ADMIN' }) }))
mock.module('@/lib/book-reader', () => ({
  transcribeScannedDocumentWithVision: async (_buffer: Buffer, pages: number[]) => ocrImpl(pages),
}))

const repairDb: any = {
  book: {
    findUnique: async () => ({
      id: 'book-1', programId: 'program-1', title: 'كتاب اختبار الإصلاح',
      storageProvider: 'TEST', storageKey: 'test-pdf', fileUrl: null, data: null, mimeType: 'application/pdf',
    }),
  },
  bookChunk: {
    findMany: async () => chunks.map((chunk) => ({ ...chunk })),
    findUnique: async ({ where }: any) => chunks.find((chunk) => chunk.id === where.id) || null,
    updateMany: async ({ where, data }: any) => {
      const chunk = chunks.find((c) => c.id === where.id && (!where.contentHash || c.contentHash === where.contentHash))
      if (!chunk) return { count: 0 }
      Object.assign(chunk, data)
      return { count: 1 }
    },
  },
  bookKnowledgeItem: {
    findMany: async ({ where }: any) => items.filter((item) => !where?.chunkId || (item as any).chunkId === where.chunkId),
  },
  bookReadJob: {
    findFirst: async () => (job ? { ...job } : null),
    findUnique: async ({ where }: any) => (job && job.id === where.id ? { ...job } : null),
    updateMany: async ({ where, data }: any) => {
      if (!job || job.id !== where.id || (where.status && job.status !== where.status)) return { count: 0 }
      Object.assign(job, data)
      return { count: 1 }
    },
    update: async ({ where, data }: any) => {
      if (!job || job.id !== where.id) throw new Error('JOB_NOT_FOUND')
      Object.assign(job, data)
      return { ...job }
    },
  },
  questionBankItem: { count: async () => linkedQuestions },
  question: { count: async () => 0 },
  programQuestion: { count: async () => 0 },
  programAssignment: { findMany: async () => linkedAssignments.map((sourceKnowledgeIds) => ({ sourceKnowledgeIds })) },
  programStudyGuide: { findMany: async () => linkedGuides.map((sourceKnowledgeIds) => ({ sourceKnowledgeIds })) },
  $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(repairDb),
}
mock.module('@/lib/db', () => ({ db: repairDb }))
const repairApi = await import('@/app/api/admin/books/[id]/repair-corrupt-pages/route')

function requestRepair() {
  return repairApi.POST(
    new NextRequest('https://academy.test/api/admin/books/book-1/repair-corrupt-pages', { method: 'POST' }),
    { params: Promise.resolve({ id: 'book-1' }) },
  )
}

describe('repair corrupt book pages', () => {
  beforeEach(() => {
    chunks = [
      { id: 'chunk-1', index: 0, pageStart: 5, pageEnd: 6, text: garbled, contentHash: 'old-hash', status: 'ANALYZED' },
      { id: 'chunk-2', index: 1, pageStart: 7, pageEnd: 7, text: cleanArabic, contentHash: 'clean-hash', status: 'ANALYZED' },
    ]
    job = {
      id: 'job-1', bookId: 'book-1', status: 'COMPLETED', phase: 'DONE',
      retryAt: null, lockedUntil: null, chunksFailed: 0,
      lastError: 'BOOK_PAGE_ISSUES:[{"page":5,"kind":"UNREADABLE","reason":"OCR_FAILED: x"}]',
    }
    items = []
    linkedQuestions = 0
    linkedAssignments = []
    linkedGuides = []
    pdfAvailable = true
    ocrImpl = async (pages) => pages.map((page) => ({ page, text: cleanOcr }))
  })

  it('repairs a corrupt chunk from the original PDF and re-queues analysis', async () => {
    const response = await requestRepair()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.repairedChunks).toEqual([{ index: 0, pages: [5, 6] }])
    expect(body.stillUnreadable).toEqual([])
    expect(body.skippedLinked).toEqual([])
    expect(body.remainingCorruptChunks).toBe(0)
    expect(body.jobRequeued).toBe(true)
    expect(chunks[0].status).toBe('EXTRACTED')
    expect(chunks[0].textProvenance).toBe('VISION_OCR')
    expect(chunks[0].text).toContain('الأصول المتداولة')
    expect(chunks[0].text).not.toContain('□')
    expect(chunks[1].text).toBe(cleanArabic)
    expect(job?.status).toBe('QUEUED')
    expect(job?.phase).toBe('ANALYZE')
    expect(job?.lastError).toBe(null)
  })

  it('skips a chunk whose knowledge items are linked and never re-queues', async () => {
    items = [{ id: 'item-1', chunkId: 'chunk-1' } as any]
    linkedQuestions = 1
    const response = await requestRepair()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.repairedChunks).toEqual([])
    expect(body.skippedLinked.length).toBe(1)
    expect(body.skippedLinked[0].index).toBe(0)
    expect(body.skippedLinked[0].linked.questions).toBe(1)
    expect(body.jobRequeued).toBe(false)
    expect(chunks[0].status).toBe('ANALYZED')
    expect(chunks[0].text).toBe(garbled)
    expect(job?.status).toBe('COMPLETED')
  })

  it('records an OCR failure as still unreadable and changes nothing', async () => {
    ocrImpl = async () => { throw new Error('OCR_PROVIDER_DOWN') }
    const response = await requestRepair()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.repairedChunks).toEqual([])
    expect(body.stillUnreadable.length).toBe(1)
    expect(body.stillUnreadable[0].index).toBe(0)
    expect(body.jobRequeued).toBe(false)
    expect(chunks[0].status).toBe('ANALYZED')
    expect(chunks[0].text).toBe(garbled)
    expect(job?.status).toBe('COMPLETED')
  })

  it('rejects a broken OCR answer instead of saving it', async () => {
    ocrImpl = async (pages) => pages.map((page) => ({ page, text: garbled }))
    const response = await requestRepair()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.repairedChunks).toEqual([])
    expect(body.stillUnreadable[0].reason).toBe('OCR_TEXT_FAILED_VERIFICATION')
    expect(chunks[0].text).toBe(garbled)
    expect(job?.status).toBe('COMPLETED')
  })

  it('refuses to race an active job', async () => {
    job!.status = 'RUNNING'
    job!.lockedUntil = new Date(Date.now() + 60_000)
    const response = await requestRepair()
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('BOOK_REPAIR_JOB_ACTIVE')
    expect(chunks[0].text).toBe(garbled)
  })

  it('reports nothing to do when no chunk is corrupt', async () => {
    chunks[0].text = cleanArabic
    let ocrCalls = 0
    ocrImpl = async (pages) => { ocrCalls++; return pages.map((page) => ({ page, text: cleanOcr })) }
    const response = await requestRepair()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.repairedChunks).toEqual([])
    expect(body.remainingCorruptChunks).toBe(0)
    expect(ocrCalls).toBe(0)
    expect(job?.status).toBe('COMPLETED')
  })

  it('does not change anything when the original PDF is unavailable', async () => {
    pdfAvailable = false
    const response = await requestRepair()
    expect(response.status).toBe(422)
    expect((await response.json()).error).toBe('BOOK_REPAIR_SOURCE_UNREADABLE')
    expect(chunks[0].text).toBe(garbled)
    expect(job?.status).toBe('COMPLETED')
  })

  it('repairs a manually stopped book without re-queuing it', async () => {
    job!.status = 'PAUSED'
    job!.phase = 'ANALYZE'
    job!.retryAt = new Date('9999-12-31T00:00:00.000Z')
    job!.lockedUntil = null
    const response = await requestRepair()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.repairedChunks.length).toBe(1)
    expect(body.jobRequeued).toBe(false)
    expect(body.manuallyStopped).toBe(true)
    expect(job?.status).toBe('PAUSED')
    expect(chunks[0].status).toBe('EXTRACTED')
  })
})
