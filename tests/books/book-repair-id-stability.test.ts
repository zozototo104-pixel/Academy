import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 6d — repair stays in place: a repair run must never delete
// chunks/knowledge or change their IDs/links. Chunk text may be
// re-read and item fields corrected, but the IDs and the
// BookChunk → BookKnowledgeItem links are identical before/after.
const cleanArabic = 'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة. '.repeat(50)
const cleanOcr = 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية. '.repeat(50)
const garbled = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)

let chunks: any[]
let items: any[]
let repairJob: any

function matches(row: any, where: any): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    const value = row[key]
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('in' in cond) return (cond.in as unknown[]).includes(value)
      return false
    }
    return value === cond
  })
}

const fakeDb: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(fakeDb),
  bookRepairJob: {
    findUnique: async ({ where }: any) => (repairJob.id === where.id ? { ...repairJob } : null),
    update: async ({ where, data }: any) => {
      if (repairJob.id !== where.id) throw new Error('JOB_NOT_FOUND')
      Object.assign(repairJob, data)
      return { ...repairJob }
    },
  },
  bookReadJob: {
    findFirst: async () => null,
    findUnique: async () => null,
    update: async () => ({ count: 0 }),
  },
  bookChunk: {
    findMany: async ({ where }: any) =>
      chunks.filter((c) => matches(c, where)).sort((a, b) => a.index - b.index).map((c) => ({ ...c })),
    findUnique: async ({ where }: any) => chunks.find((c) => c.id === where.id) || null,
    updateMany: async ({ where, data }: any) => {
      const chunk = chunks.find((c) => c.id === where.id && (!where.contentHash || c.contentHash === where.contentHash))
      if (!chunk) return { count: 0 }
      Object.assign(chunk, data)
      return { count: 1 }
    },
  },
  bookKnowledgeItem: {
    findMany: async ({ where }: any) => items.filter((i) => matches(i, where)).map((i) => ({ ...i })),
    findUnique: async ({ where }: any) => items.find((i) => i.id === where.id) || null,
    update: async ({ where, data }: any) => {
      const item = items.find((i) => i.id === where.id)
      if (!item) throw new Error('ITEM_NOT_FOUND')
      Object.assign(item, data)
      return { ...item }
    },
  },
  programStudyGuide: { findMany: async () => [], update: async () => ({}) },
  questionBankItem: { findMany: async () => [], update: async () => ({}) },
  question: { findMany: async () => [], update: async () => ({}) },
  programQuestion: { findMany: async () => [], update: async () => ({}) },
}
mock.module('@/lib/db', () => ({ db: fakeDb }))

const { runBookRepairScanStep } = await import('../../src/lib/book-repair-job')

const ocrStub = async (_buffer: Buffer, pages: number[]) =>
  pages.map((page) => ({ page, text: cleanOcr }))

beforeEach(() => {
  chunks = [
    { id: 'chunk-1', bookId: 'book-1', index: 0, pageStart: 5, pageEnd: 6, text: garbled, contentHash: 'hash-1', status: 'ANALYZED' },
    { id: 'chunk-2', bookId: 'book-1', index: 1, pageStart: 7, pageEnd: 7, text: cleanArabic, contentHash: 'hash-2', status: 'ANALYZED' },
  ]
  items = [
    {
      id: 'item-1', bookId: 'book-1', chunkId: 'chunk-1', kbVersion: 2,
      title: 'الأصول المتداولة',
      summary: 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية.',
      excerpt: garbled.slice(0, 400), pageStart: 5, pageEnd: 6,
    },
    {
      id: 'item-2', bookId: 'book-1', chunkId: 'chunk-2', kbVersion: 2,
      title: 'القوائم المالية',
      summary: 'القوائم المالية تعرض المركز المالي للمنشأة في نهاية الفترة المالية.',
      excerpt: cleanArabic.slice(0, 300), pageStart: 7, pageEnd: 7,
    },
  ]
  repairJob = {
    id: 'repair-1', bookId: 'book-1', programId: 'program-1', status: 'QUEUED',
    chunksTotal: 2, itemsTotal: 2, progress: null, startedAt: null, finishedAt: null,
  }
})

describe('repair ID stability — in place, never delete-and-recreate', () => {
  test('chunk/knowledge IDs and BookChunk → BookKnowledgeItem links are identical before/after a repair run', async () => {
    const chunkIdsBefore = chunks.map((c) => c.id)
    const itemIdsBefore = items.map((i) => i.id)
    const linksBefore = items.map((i) => `${i.id}->${i.chunkId}`)
    const result = await runBookRepairScanStep('repair-1', Buffer.from('pdf'), Date.now() + 120_000, ocrStub as any)
    expect(result.processedChunks).toBeGreaterThan(0)
    // The repair actually ran: the garbled chunk was re-read from OCR.
    expect(chunks.find((c) => c.id === 'chunk-1')?.text).toContain('الأصول المتداولة')
    expect(chunks.find((c) => c.id === 'chunk-1')?.text).not.toContain('□')
    // ...but nothing was deleted or recreated: same IDs, same links.
    expect(chunks.map((c) => c.id)).toEqual(chunkIdsBefore)
    expect(items.map((i) => i.id)).toEqual(itemIdsBefore)
    expect(items.map((i) => `${i.id}->${i.chunkId}`)).toEqual(linksBefore)
    expect(chunks).toHaveLength(2)
    expect(items).toHaveLength(2)
    // The corrected item kept its ID; only its garbled excerpt changed.
    const item1 = items.find((i) => i.id === 'item-1')
    expect(item1?.chunkId).toBe('chunk-1')
    expect(item1?.excerpt).not.toContain('□')
  })

  test('a second repair run is idempotent on IDs and links', async () => {
    await runBookRepairScanStep('repair-1', Buffer.from('pdf'), Date.now() + 120_000, ocrStub as any)
    const chunkIds = chunks.map((c) => c.id)
    const links = items.map((i) => `${i.id}->${i.chunkId}`)
    await runBookRepairScanStep('repair-1', Buffer.from('pdf'), Date.now() + 120_000, ocrStub as any)
    expect(chunks.map((c) => c.id)).toEqual(chunkIds)
    expect(items.map((i) => `${i.id}->${i.chunkId}`)).toEqual(links)
  })
})
