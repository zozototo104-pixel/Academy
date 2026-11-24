/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 9 (d) — OCR-incomplete flag: if SOME pages of a chunk come back
// empty/broken but the JOINED text still passes verification, the old
// code "repaired" the chunk from the surviving pages and silently
// dropped the lost page. The fix records a scan-level
// 'OCR_INCOMPLETE_OR_INVALID_PAGES' reason so the per-page UNREADABLE
// issues carry it — for the bad pages only. Real repair-job code
// against an in-memory fake DB; no production records are touched.
const cleanArabic = 'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة. '.repeat(50)
const cleanOcr = 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية. '.repeat(50)
const garbled = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)

let chunks: any[]
let items: any[]
let readJob: any
let repairJobs: any[]

mock.module('@/lib/book-reader', () => ({
  transcribeScannedDocumentWithVision: async () => [],
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

const repairDb: any = {
  bookReadJob: {
    findFirst: async ({ where }: any) => (readJob && matches(readJob, where) ? { ...readJob } : null),
    findUnique: async ({ where }: any) => (readJob && readJob.id === where.id ? { ...readJob } : null),
    update: async ({ where, data }: any) => {
      if (!readJob || readJob.id !== where.id) throw new Error('JOB_NOT_FOUND')
      Object.assign(readJob, data)
      return { ...readJob }
    },
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
    findUnique: async ({ where }: any) => repairJobs.find((job) => job.id === where.id) || null,
    update: async ({ where, data }: any) => {
      const job = repairJobs.find((row) => row.id === where.id)
      if (!job) throw new Error('REPAIR_JOB_NOT_FOUND')
      Object.assign(job, data)
      return { ...job }
    },
  },
  programStudyGuide: {
    findMany: async () => [],
    update: async () => { throw new Error('GUIDE_NOT_FOUND') },
  },
  questionBankItem: { findMany: async () => [], update: async () => { throw new Error('QUESTION_NOT_FOUND') } },
  question: { findMany: async () => [], update: async () => { throw new Error('QUESTION_NOT_FOUND') } },
  programQuestion: { findMany: async () => [], update: async () => { throw new Error('QUESTION_NOT_FOUND') } },
  $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(repairDb),
}
mock.module('@/lib/db', () => ({ db: repairDb }))

const { runBookRepairScanStep } = await import('../../src/lib/book-repair-job')

describe('book repair scan — OCR-incomplete flag', () => {
  beforeEach(() => {
    chunks = [
      { id: 'chunk-1', bookId: 'book-1', index: 0, pageStart: 5, pageEnd: 6, text: garbled, contentHash: 'hash-1', status: 'ANALYZED' },
    ]
    items = [
      {
        id: 'item-1', bookId: 'book-1', chunkId: 'chunk-1', kbVersion: 2,
        title: 'الأصول المتداولة',
        summary: 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية.',
        excerpt: garbled.slice(0, 400),
        pageStart: 5, pageEnd: 6,
      },
    ]
    readJob = {
      id: 'job-1', bookId: 'book-1', status: 'COMPLETED', phase: 'DONE',
      retryAt: null, lockedUntil: null, lastError: null,
    }
    repairJobs = [
      {
        id: 'repair-1', bookId: 'book-1', programId: 'program-1', status: 'QUEUED', mode: 'SCAN',
        chunksTotal: 1, chunksHealthy: 0, chunksCorrected: 0, chunksRemaining: 1, chunksNeedsReview: 0,
        itemsTotal: 1, itemsHealthy: 0, itemsCorrected: 0, itemsRemaining: 1, itemsNeedsReview: 0,
        progress: null, lastError: null, startedAt: null, finishedAt: null, createdAt: new Date('2026-11-24T09:00:00Z'),
      },
    ]
  })

  test('one empty page among good pages records the incomplete flag + UNREADABLE issue for that page only', async () => {
    const ocr = async (_buffer: Buffer, pages: number[]) =>
      pages.map((page) => ({ page, text: page === 6 ? '' : cleanOcr }))
    const result = await runBookRepairScanStep('repair-1', Buffer.from([]), Date.now() + 60_000, ocr)
    // The chunk is NOT repaired from the surviving page: it goes to review.
    expect(result.counters.chunksCorrected).toBe(0)
    expect(result.counters.chunksNeedsReview).toBe(1)
    expect(result.counters.chunksRemaining).toBe(0)
    expect(chunks[0].text).toBe(garbled)
    expect(JSON.parse(repairJobs[0].progress).reviewChunkIds).toContain('chunk-1')
    // The ledger carries the scan-level reason, for the bad page only.
    expect(readJob.lastError).toContain('BOOK_PAGE_ISSUES:')
    expect(readJob.lastError).toContain('OCR_INCOMPLETE_OR_INVALID_PAGES')
    expect(readJob.lastError).toContain('"page":6')
    expect(readJob.lastError).toContain('UNREADABLE')
    expect(readJob.lastError).not.toContain('"page":5')
  })

  test('all-good pages record no flag and the chunk is repaired', async () => {
    const ocr = async (_buffer: Buffer, pages: number[]) =>
      pages.map((page) => ({ page, text: cleanOcr }))
    const result = await runBookRepairScanStep('repair-1', Buffer.from([]), Date.now() + 60_000, ocr)
    expect(result.counters.chunksCorrected).toBe(1)
    expect(result.counters.chunksNeedsReview).toBe(0)
    expect(result.done).toBe(true)
    expect(chunks[0].text).toContain('الأصول المتداولة')
    expect(chunks[0].text).not.toContain('□')
    expect(readJob.lastError).toBeNull()
  })

  test('a broken (tofu-only) page among good pages is also flagged for that page only', async () => {
    const ocr = async (_buffer: Buffer, pages: number[]) =>
      pages.map((page) => ({ page, text: page === 6 ? '□ □ □' : cleanOcr }))
    const result = await runBookRepairScanStep('repair-1', Buffer.from([]), Date.now() + 60_000, ocr)
    expect(result.counters.chunksCorrected).toBe(0)
    expect(result.counters.chunksNeedsReview).toBe(1)
    expect(readJob.lastError).toContain('OCR_INCOMPLETE_OR_INVALID_PAGES')
    expect(readJob.lastError).toContain('"page":6')
    expect(readJob.lastError).not.toContain('"page":5')
  })
})
