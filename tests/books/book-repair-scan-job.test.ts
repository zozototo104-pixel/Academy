import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { PDFDocument } from 'pdf-lib'

// Book-wide selective repair (SCAN mode): scan ALL chunks/items, re-read
// ONLY distorted pages from the original PDF, correct items IN PLACE (same
// ID, never delete-and-recreate), fix only the quoted parts of linked
// guides/questions, send unprovable items to REVIEW, never halt the book on
// one stuck chunk, and resume from persisted progress. Real route + driver
// code against an in-memory fake DB; no production records are touched.
const cleanArabic = 'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة. '.repeat(50)
const cleanOcr = 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية. '.repeat(50)
const garbled = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)

let chunks: any[]
let items: any[]
let guides: any[]
let bankQuestions: any[]
let examQuestions: any[]
let programQuestions: any[]
let readJob: any
let repairJobs: any[]
let ocrCalls: number[] = []
let ocrImpl: (pages: number[]) => Promise<{ page: number; text: string }[]> = async (pages) => {
  ocrCalls.push(...pages)
  return pages.map((page) => ({ page, text: cleanOcr }))
}

const pdfFixture = await PDFDocument.create()
pdfFixture.addPage([595, 842])
const repairPdf = Buffer.from(await pdfFixture.save())

mock.module('@/lib/storage', () => ({
  getFileBufferFromStorageOrBase64: async () => ({ buffer: repairPdf }),
}))
mock.module('@/lib/notify', () => ({ audit: async () => undefined }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', role: 'ADMIN' }) }))
mock.module('@/lib/book-reader', () => ({
  transcribeScannedDocumentWithVision: async (_buffer: Buffer, pages: number[]) => ocrImpl(pages),
}))

function matches(row: any, where: any): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    const value = row[key]
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('in' in cond) return (cond.in as unknown[]).includes(value)
      if ('not' in cond) return cond.not === null ? value !== null : value !== cond.not
      return false
    }
    return value === cond
  })
}

function latestFirst(rows: any[]) {
  return [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

const scanDb: any = {
  book: {
    findUnique: async () => ({
      id: 'book-1', programId: 'program-1', title: 'كتاب اختبار الفحص',
      storageProvider: 'TEST', storageKey: 'test-pdf', fileUrl: null, data: null, mimeType: 'application/pdf',
    }),
  },
  bookReadJob: {
    findFirst: async ({ where }: any) => (readJob && matches(readJob, where) ? { ...readJob } : null),
    findUnique: async ({ where }: any) => (readJob && readJob.id === where.id ? { ...readJob } : null),
    update: async ({ where, data }: any) => {
      if (!readJob || readJob.id !== where.id) throw new Error('JOB_NOT_FOUND')
      Object.assign(readJob, data)
      return { ...readJob }
    },
    updateMany: async () => ({ count: 0 }),
  },
  bookChunk: {
    findMany: async ({ where }: any) =>
      chunks.filter((chunk) => matches(chunk, where)).sort((a, b) => a.index - b.index).map((chunk) => ({ ...chunk })),
    findUnique: async ({ where }: any) => chunks.find((chunk) => chunk.id === where.id) || null,
    updateMany: async ({ where, data }: any) => {
      const chunk = chunks.find((c) => c.id === where.id && (!where.contentHash || c.contentHash === where.contentHash))
      if (!chunk) return { count: 0 }
      Object.assign(chunk, data)
      return { count: 1 }
    },
  },
  bookKnowledgeItem: {
    findMany: async ({ where }: any) => items.filter((item) => matches(item, where)).map((item) => ({ ...item })),
    findUnique: async ({ where }: any) => items.find((item) => item.id === where.id) || null,
    update: async ({ where, data }: any) => {
      const item = items.find((row) => row.id === where.id)
      if (!item) throw new Error('ITEM_NOT_FOUND')
      Object.assign(item, data)
      return { ...item }
    },
  },
  bookRepairJob: {
    findFirst: async ({ where }: any) => latestFirst(repairJobs.filter((job) => matches(job, where)))[0] || null,
    findUnique: async ({ where }: any) => repairJobs.find((job) => job.id === where.id) || null,
    findUniqueOrThrow: async ({ where }: any) => {
      const job = repairJobs.find((row) => row.id === where.id)
      if (!job) throw new Error('REPAIR_JOB_NOT_FOUND')
      return { ...job }
    },
    create: async ({ data }: any) => {
      const job = {
        id: `repair-${repairJobs.length + 1}`, createdAt: new Date(), updatedAt: new Date(),
        status: 'QUEUED', mode: 'SCAN', chunksTotal: 0, chunksHealthy: 0, chunksCorrected: 0,
        chunksRemaining: 0, chunksNeedsReview: 0, itemsTotal: 0, itemsHealthy: 0,
        itemsCorrected: 0, itemsRemaining: 0, itemsNeedsReview: 0,
        progress: null, lastError: null, startedAt: null, finishedAt: null, ...data,
      }
      repairJobs.push(job)
      return { ...job }
    },
    update: async ({ where, data }: any) => {
      const job = repairJobs.find((row) => row.id === where.id)
      if (!job) throw new Error('REPAIR_JOB_NOT_FOUND')
      Object.assign(job, data)
      return { ...job }
    },
  },
  programStudyGuide: {
    findMany: async ({ where }: any) => guides.filter((guide) => matches(guide, where)).map((guide) => ({ ...guide })),
    update: async ({ where, data }: any) => {
      const guide = guides.find((row) => row.id === where.id)
      if (!guide) throw new Error('GUIDE_NOT_FOUND')
      Object.assign(guide, data)
      return { ...guide }
    },
  },
  questionBankItem: {
    findMany: async ({ where }: any) => bankQuestions.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    update: async ({ where, data }: any) => {
      const row = bankQuestions.find((item) => item.id === where.id)
      if (!row) throw new Error('QUESTION_NOT_FOUND')
      Object.assign(row, data)
      return { ...row }
    },
  },
  question: {
    findMany: async ({ where }: any) => examQuestions.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    update: async ({ where, data }: any) => {
      const row = examQuestions.find((item) => item.id === where.id)
      if (!row) throw new Error('QUESTION_NOT_FOUND')
      Object.assign(row, data)
      return { ...row }
    },
  },
  programQuestion: {
    findMany: async ({ where }: any) => programQuestions.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    update: async ({ where, data }: any) => {
      const row = programQuestions.find((item) => item.id === where.id)
      if (!row) throw new Error('QUESTION_NOT_FOUND')
      Object.assign(row, data)
      return { ...row }
    },
  },
  $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(scanDb),
}
mock.module('@/lib/db', () => ({ db: scanDb }))

const repairApi = await import('@/app/api/admin/books/[id]/repair-corrupt-pages/route')
const { buildKeyTermForItem, buildSectionSummaryForItem } = await import('../../src/lib/book-repair-scan')
const { firstSentence } = await import('../../src/lib/outline-units')

function postRepair(body: any) {
  return repairApi.POST(
    new NextRequest('https://academy.test/api/admin/books/book-1/repair-corrupt-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'book-1' }) },
  )
}

function getRepair() {
  return repairApi.GET(
    new NextRequest('https://academy.test/api/admin/books/book-1/repair-corrupt-pages', { method: 'GET' }),
    { params: Promise.resolve({ id: 'book-1' }) },
  )
}

describe('book-wide selective repair (SCAN)', () => {
  beforeEach(() => {
    chunks = [
      { id: 'chunk-1', bookId: 'book-1', index: 0, pageStart: 5, pageEnd: 6, text: garbled, contentHash: 'hash-1', status: 'ANALYZED' },
      { id: 'chunk-2', bookId: 'book-1', index: 1, pageStart: 7, pageEnd: 7, text: cleanArabic, contentHash: 'hash-2', status: 'ANALYZED' },
      { id: 'chunk-3', bookId: 'book-1', index: 2, pageStart: 8, pageEnd: 9, text: garbled, contentHash: 'hash-3', status: 'ANALYZED' },
    ]
    const item1 = {
      id: 'item-1', bookId: 'book-1', chunkId: 'chunk-1', kbVersion: 2,
      title: 'الأصول المتداولة',
      summary: 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية.',
      excerpt: garbled.slice(0, 400),
      pageStart: 5, pageEnd: 6,
    }
    const item2 = {
      id: 'item-2', bookId: 'book-1', chunkId: 'chunk-2', kbVersion: 2,
      title: 'القوائم المالية',
      summary: 'القوائم المالية تعرض المركز المالي للمنشأة في نهاية الفترة المالية.',
      excerpt: cleanArabic.slice(0, 300),
      pageStart: 7, pageEnd: 7,
    }
    const item3 = {
      id: 'item-3', bookId: 'book-1', chunkId: 'chunk-3', kbVersion: 2,
      title: 'الأصول المتداولة',
      summary: 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية.',
      excerpt: cleanOcr.split('.')[0] + '.',
      pageStart: 8, pageEnd: 9,
    }
    items = [item1, item2, item3]
    guides = [{
      id: 'guide-1', programId: 'program-1',
      sourceKnowledgeIds: JSON.stringify(['item-1']),
      keyTerms: JSON.stringify([buildKeyTermForItem(item1)]),
      sections: JSON.stringify([{ title: 'الأصول المتداولة', summary: buildSectionSummaryForItem(item1), sourceKnowledgeIds: ['item-1'] }]),
    }]
    bankQuestions = [{
      id: 'q-1', knowledgeItemId: 'item-1',
      text: `ما المقصود بـ «${firstSentence(item1.excerpt, 220)}»؟`,
      sourceEvidence: item1.excerpt,
    }]
    examQuestions = []
    programQuestions = []
    readJob = {
      id: 'job-1', bookId: 'book-1', status: 'COMPLETED', phase: 'DONE',
      retryAt: null, lockedUntil: null, lastError: null,
    }
    repairJobs = []
    ocrCalls = []
    ocrImpl = async (pages) => {
      ocrCalls.push(...pages)
      return pages.map((page) => ({ page, text: cleanOcr }))
    }
  })

  test('scans the whole book, repairs distorted chunks in place, and fixes linked guides/questions', async () => {
    const itemIdsBefore = items.map((item) => item.id)
    const response = await postRepair({ mode: 'SCAN' })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.done).toBe(true)
    expect(body.counters).toMatchObject({
      chunksTotal: 3, chunksHealthy: 1, chunksCorrected: 2, chunksRemaining: 0, chunksNeedsReview: 0,
      itemsTotal: 3, itemsHealthy: 2, itemsCorrected: 1, itemsRemaining: 0, itemsNeedsReview: 0,
    })
    expect(body.counters.chunksHealthy + body.counters.chunksCorrected + body.counters.chunksRemaining + body.counters.chunksNeedsReview).toBe(3)
    expect(body.counters.itemsHealthy + body.counters.itemsCorrected + body.counters.itemsRemaining + body.counters.itemsNeedsReview).toBe(3)
    // Criterion 1: same IDs everywhere; nothing deleted, nothing recreated.
    expect(items.map((item) => item.id)).toEqual(itemIdsBefore)
    expect(items).toHaveLength(3)
    expect(chunks[0].text).toContain('الأصول المتداولة')
    expect(chunks[0].text).not.toContain('□')
    expect(chunks[0].status).toBe('ANALYZED')
    expect(chunks[2].text).toContain('الأصول المتداولة')
    expect(items[0].id).toBe('item-1')
    expect(items[0].excerpt).toContain('الأصول المتداولة')
    expect(items[0].excerpt).not.toContain('□')
    expect(items[2].excerpt).toBe(cleanOcr.split('.')[0] + '.')
    // Only the quoted parts of the linked guide/question changed.
    const keyTerms = JSON.parse(guides[0].keyTerms)
    expect(keyTerms).toHaveLength(1)
    expect(keyTerms[0]).toContain('الأصول المتداولة')
    expect(keyTerms[0]).not.toContain('□')
    expect(bankQuestions[0].text).not.toContain('□')
    expect(bankQuestions[0].text).toContain('الأصول المتداولة')
    expect(bankQuestions[0].sourceEvidence).toBe(items[0].excerpt)
    expect(body.job.status).toBe('COMPLETED')
  })

  test('a stuck chunk is recorded for review and never halts the book', async () => {
    ocrImpl = async (pages) => {
      ocrCalls.push(...pages)
      if (pages.some((page) => page >= 8)) throw new Error('OCR_PROVIDER_DOWN')
      return pages.map((page) => ({ page, text: cleanOcr }))
    }
    const response = await postRepair({ mode: 'SCAN' })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.done).toBe(true)
    expect(body.counters.chunksCorrected).toBe(1)
    expect(body.counters.chunksNeedsReview).toBe(1)
    expect(body.counters.chunksRemaining).toBe(0)
    expect(body.counters.itemsCorrected).toBe(1)
    expect(chunks[0].text).toContain('الأصول المتداولة')
    expect(chunks[2].text).toBe(garbled)
    expect(readJob.lastError).toContain('BOOK_PAGE_ISSUES:')
    expect(readJob.lastError).toContain('"page":8')
    expect(readJob.lastError).toContain('UNREADABLE')
    expect(body.job.status).toBe('COMPLETED')
  })

  test('a step resumes from persisted progress and never re-reads a repaired chunk', async () => {
    // Chunk 1 was already repaired by an earlier step (its text is clean
    // now); the job row remembers it. Only chunk 3 may be re-read.
    chunks[0].text = cleanOcr
    repairJobs.push({
      id: 'repair-1', bookId: 'book-1', programId: 'program-1', status: 'QUEUED', mode: 'SCAN',
      chunksTotal: 3, chunksHealthy: 1, chunksCorrected: 1, chunksRemaining: 1, chunksNeedsReview: 0,
      itemsTotal: 3, itemsHealthy: 2, itemsCorrected: 1, itemsRemaining: 0, itemsNeedsReview: 0,
      progress: JSON.stringify({
        distortedChunkIds: ['chunk-1', 'chunk-3'], distortedItemIds: ['item-1'],
        repairedChunkIds: ['chunk-1'], reviewChunkIds: [],
        correctedItemIds: ['item-1'], reviewItemIds: [],
      }),
      lastError: null, startedAt: new Date(), finishedAt: null, createdAt: new Date('2026-11-24T09:00:00Z'),
    })
    const response = await postRepair({ mode: 'SCAN' })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.done).toBe(true)
    expect(ocrCalls).not.toContain(5)
    expect(ocrCalls).not.toContain(6)
    expect(ocrCalls).toContain(8)
    expect(ocrCalls).toContain(9)
    expect(body.counters.chunksCorrected).toBe(2)
    expect(body.counters.chunksRemaining).toBe(0)
    expect(body.counters.itemsCorrected).toBe(1)
    expect(repairJobs).toHaveLength(1)
    expect(body.job.status).toBe('COMPLETED')
  })

  test('STOP pauses the job, a scan step while paused does nothing, RESUME continues it', async () => {
    repairJobs.push({
      id: 'repair-1', bookId: 'book-1', programId: 'program-1', status: 'RUNNING', mode: 'SCAN',
      chunksTotal: 0, chunksHealthy: 0, chunksCorrected: 0, chunksRemaining: 0, chunksNeedsReview: 0,
      itemsTotal: 0, itemsHealthy: 0, itemsCorrected: 0, itemsRemaining: 0, itemsNeedsReview: 0,
      progress: null, lastError: null, startedAt: new Date(), finishedAt: null, createdAt: new Date('2026-11-24T09:00:00Z'),
    })
    const stopped = await postRepair({ action: 'STOP' })
    expect(stopped.status).toBe(200)
    expect((await stopped.json()).job.status).toBe('PAUSED')
    const callsBefore = ocrCalls.length
    const pausedStep = await postRepair({ mode: 'SCAN' })
    const pausedBody = await pausedStep.json()
    expect(pausedStep.status).toBe(200)
    expect(pausedBody.done).toBe(false)
    expect(pausedBody.processedChunks).toBe(0)
    expect(ocrCalls.length).toBe(callsBefore)
    const resumed = await postRepair({ action: 'RESUME' })
    expect((await resumed.json()).job.status).toBe('QUEUED')
    const continued = await postRepair({ mode: 'SCAN' })
    const continuedBody = await continued.json()
    expect(continued.status).toBe(200)
    expect(continuedBody.done).toBe(true)
    expect(continuedBody.counters.chunksCorrected).toBe(2)
  })

  test('a scan refuses to start while a read job is active (criterion 4)', async () => {
    readJob.status = 'RUNNING'
    readJob.lockedUntil = new Date(Date.now() + 60_000)
    const response = await postRepair({ mode: 'SCAN' })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('BOOK_REPAIR_JOB_ACTIVE')
    expect(repairJobs).toHaveLength(0)
    expect(chunks[0].text).toBe(garbled)
  })

  test('GET returns the latest scan job with its counters', async () => {
    await postRepair({ mode: 'SCAN' })
    const response = await getRepair()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.job.status).toBe('COMPLETED')
    expect(body.job.chunksCorrected).toBe(2)
    expect(body.job.itemsCorrected).toBe(1)
    expect(body.job.itemsNeedsReview).toBe(0)
  })

  test('reconciles stale remaining ids the fresh scan no longer flags and completes', async () => {
    // Live stall of 2026-11-25: the job list says chunk-1 is still
    // distorted, but its text is clean now (fixed by another path), so
    // the fresh scan no longer flags it. The old code would batch
    // nothing, leave remaining at 1 and never finish; the reconciled
    // step resolves the stale id (healthy, NOT "corrected") and completes.
    chunks[0].text = cleanOcr
    repairJobs.push({
      id: 'repair-1', bookId: 'book-1', programId: 'program-1', status: 'QUEUED', mode: 'SCAN',
      chunksTotal: 3, chunksHealthy: 1, chunksCorrected: 0, chunksRemaining: 2, chunksNeedsReview: 0,
      itemsTotal: 3, itemsHealthy: 1, itemsCorrected: 0, itemsRemaining: 2, itemsNeedsReview: 0,
      progress: JSON.stringify({
        distortedChunkIds: ['chunk-1', 'chunk-3'], distortedItemIds: ['item-1', 'item-2'],
        repairedChunkIds: [], reviewChunkIds: [],
        correctedItemIds: [], reviewItemIds: [],
      }),
      lastError: null, startedAt: new Date(), finishedAt: null, createdAt: new Date('2026-11-24T09:00:00Z'),
    })
    const response = await postRepair({ mode: 'SCAN' })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.done).toBe(true)
    expect(body.noProgress).toBe(false)
    expect(body.processedChunks).toBe(1)
    // Chunk-1 was never re-read: its pages stay out of the OCR calls.
    expect(ocrCalls).not.toContain(5)
    expect(ocrCalls).not.toContain(6)
    expect(ocrCalls).toContain(8)
    expect(ocrCalls).toContain(9)
    expect(body.counters).toMatchObject({
      chunksTotal: 3, chunksHealthy: 2, chunksCorrected: 1, chunksRemaining: 0, chunksNeedsReview: 0,
      itemsTotal: 3, itemsHealthy: 2, itemsCorrected: 1, itemsRemaining: 0, itemsNeedsReview: 0,
    })
    expect(body.job.status).toBe('COMPLETED')
  })

  test('records an empty-text remaining chunk as a hole and completes', async () => {
    // Empty text is a hole, never distortion: the fresh scan ignores
    // chunk-1, so without reconciliation the job would stall with
    // remaining 1 forever. The hole goes to review with an UNREADABLE
    // ledger entry, like an OCR failure.
    chunks[0].text = ''
    repairJobs.push({
      id: 'repair-1', bookId: 'book-1', programId: 'program-1', status: 'QUEUED', mode: 'SCAN',
      chunksTotal: 3, chunksHealthy: 1, chunksCorrected: 0, chunksRemaining: 2, chunksNeedsReview: 0,
      itemsTotal: 3, itemsHealthy: 1, itemsCorrected: 0, itemsRemaining: 1, itemsNeedsReview: 0,
      progress: JSON.stringify({
        distortedChunkIds: ['chunk-1', 'chunk-3'], distortedItemIds: ['item-1'],
        repairedChunkIds: [], reviewChunkIds: [],
        correctedItemIds: [], reviewItemIds: [],
      }),
      lastError: null, startedAt: new Date(), finishedAt: null, createdAt: new Date('2026-11-24T09:00:00Z'),
    })
    const response = await postRepair({ mode: 'SCAN' })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.done).toBe(true)
    expect(body.counters).toMatchObject({
      chunksTotal: 3, chunksHealthy: 1, chunksCorrected: 1, chunksRemaining: 0, chunksNeedsReview: 1,
      itemsTotal: 3, itemsHealthy: 2, itemsCorrected: 0, itemsRemaining: 0, itemsNeedsReview: 1,
    })
    expect(readJob.lastError).toContain('BOOK_PAGE_ISSUES:')
    expect(readJob.lastError).toContain('"page":5')
    expect(readJob.lastError).toContain('UNREADABLE')
    expect(body.job.status).toBe('COMPLETED')
  })

  test('records a repeatedly CAS-skipped chunk for review after the bound', async () => {
    // Every transaction sees a changed contentHash (a concurrent writer):
    // each press OCRs the chunk again but records nothing. After
    // BOOK_REPAIR_MAX_CAS_SKIPS consecutive skips the chunk goes to
    // review instead of being retried forever.
    const originalFindUnique = scanDb.bookChunk.findUnique
    scanDb.bookChunk.findUnique = async ({ where }: any) => {
      const chunk = chunks.find((row) => row.id === where.id) || null
      return chunk ? { ...chunk, contentHash: 'changed-mid-step' } : null
    }
    try {
      const first = await postRepair({ mode: 'SCAN' })
      const firstBody = await first.json()
      expect(first.status).toBe(200)
      expect(firstBody.done).toBe(false)
      expect(firstBody.noProgress).toBe(true)
      expect(firstBody.processedChunks).toBe(0)
      expect(firstBody.counters.chunksRemaining).toBe(2)
      expect(firstBody.counters.chunksNeedsReview).toBe(0)
      const second = await postRepair({ mode: 'SCAN' })
      const secondBody = await second.json()
      expect(secondBody.done).toBe(false)
      expect(secondBody.noProgress).toBe(true)
      expect(secondBody.counters.chunksRemaining).toBe(2)
      expect(secondBody.counters.chunksNeedsReview).toBe(0)
      const third = await postRepair({ mode: 'SCAN' })
      const thirdBody = await third.json()
      expect(third.status).toBe(200)
      expect(thirdBody.done).toBe(true)
      expect(thirdBody.counters.chunksRemaining).toBe(0)
      expect(thirdBody.counters.chunksNeedsReview).toBe(2)
      // Only item-1 (on chunk-1) was distorted; item-3's excerpt was
      // already clean, so only one item goes to review with the chunks.
      expect(thirdBody.counters.itemsNeedsReview).toBe(1)
      expect(thirdBody.job.status).toBe('COMPLETED')
      // Each press retried the OCR before giving up to review.
      expect(ocrCalls.filter((page) => page === 5).length).toBe(3)
      expect(ocrCalls.filter((page) => page === 8).length).toBe(3)
    } finally {
      scanDb.bookChunk.findUnique = originalFindUnique
    }
  })

  test('a step that moves nothing while work remains reports noProgress', async () => {
    // Same CAS-skip setup, one press only: the step ran, made no
    // progress, and says so instead of repeating «بقي عمل» counters.
    const originalFindUnique = scanDb.bookChunk.findUnique
    scanDb.bookChunk.findUnique = async ({ where }: any) => {
      const chunk = chunks.find((row) => row.id === where.id) || null
      return chunk ? { ...chunk, contentHash: 'changed-mid-step' } : null
    }
    try {
      const response = await postRepair({ mode: 'SCAN' })
      const body = await response.json()
      expect(response.status).toBe(200)
      expect(body.done).toBe(false)
      expect(body.noProgress).toBe(true)
      expect(body.processedChunks).toBe(0)
      expect(body.processedItems).toBe(0)
      expect(body.counters.chunksRemaining).toBe(2)
    } finally {
      scanDb.bookChunk.findUnique = originalFindUnique
    }
  })
})
