import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Guard U13/M11: chunked uploads must be bounded BEFORE storage —
// total chunk count, per-chunk size, and accumulated size. Legit
// clients: thesis = 4MB chunks for files <= 20MB (max 5 chunks);
// books = 384KB chunks for files <= 10MB (max 27 chunks).

let thesisChunks: any[] = []
let bookChunks: any[] = []
let rateLimited = false

const dbMock: any = {
  thesisSubmission: {
    findFirst: async () => ({ id: 'TH1', userId: 'stu-1', admissionId: 'adm-1', status: 'PLAN_APPROVED', fileStorageKey: null }),
    updateMany: async () => ({ count: 1 }),
  },
  thesisChunk: { deleteMany: async () => ({ count: 0 }) },
  thesisUploadChunk: {
    deleteMany: async ({ where }: any) => {
      if (where?.uploadId) thesisChunks = thesisChunks.filter((r) => r.uploadId !== where.uploadId)
      return { count: 0 }
    },
    findFirst: async () => null,
    findMany: async ({ where }: any = {}) => thesisChunks.filter((r) => (!where.uploadId || r.uploadId === where.uploadId) && (!where.userId || r.userId === where.userId) && (!where.thesisId || r.thesisId === where.thesisId)).sort((a, b) => a.index - b.index),
    upsert: async ({ where, create, update }: any) => {
      const i = thesisChunks.findIndex((r) => r.uploadId === where.uploadId_index.uploadId && r.index === where.uploadId_index.index)
      if (i >= 0) { thesisChunks[i] = { ...thesisChunks[i], ...update }; return thesisChunks[i] }
      thesisChunks.push(create)
      return create
    },
  },
  book: { findUnique: async ({ where }: any) => (where.id === 'BK1' ? { id: 'BK1', program: { titleAr: 'برنامج' } } : null) },
  bookUploadChunk: {
    deleteMany: async () => ({ count: 0 }),
    findMany: async () => bookChunks,
    upsert: async ({ where, create }: any) => { bookChunks.push(create); return create },
  },
  $transaction: async (fn: any) => fn(dbMock),
}
mock.module('@/lib/db', () => ({ db: dbMock }))
mock.module('@/lib/auth', () => ({
  requireUser: async () => ({ id: 'stu-1', role: 'STUDENT', name: 'طالب' }),
  requireAdmin: async () => ({ id: 'admin-1', role: 'ADMIN', name: 'الأدمن' }),
}))
mock.module('@/lib/rate-limit', () => ({
  enforceApiRateLimit: () => (rateLimited ? new Response(JSON.stringify({ error: 'rate' }), { status: 429 }) : null),
}))
mock.module('@/lib/storage', () => ({
  storeFileBuffer: async () => ({ provider: 'local', key: 'key-1', url: '/files/key-1', size: 100 }),
  deleteStoredFile: async () => true,
  storageErrorMessage: (e: any) => String(e?.message || e),
}))
mock.module('@/lib/notify', () => ({ audit: async () => {} }))
mock.module('@/lib/file-signature', () => ({ validateAdmissionFileSignature: () => true }))
mock.module('@prisma/client', () => ({ Prisma: { JsonNull: null } }))

const thesisRoute = await import('@/app/api/thesis/upload-chunk/route')
const bookRoute = await import('@/app/api/admin/books/upload-chunk/route')
const { NextRequest } = await import('next/server')

function thesisPost(fields: Record<string, string>, chunkBytes?: number, firstChunk = false) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  if (chunkBytes != null) {
    const bytes = new Uint8Array(chunkBytes)
    if (firstChunk) bytes.set([0x25, 0x50, 0x44, 0x46], 0) // %PDF
    fd.set('chunk', new File([bytes], 'part.bin'))
  }
  return new NextRequest('http://localhost/api/thesis/upload-chunk', { method: 'POST', body: fd })
}
const thesisFields = (extra: Record<string, string> = {}) => ({ thesisId: 'TH1', uploadId: 'UP1', fileName: 'thesis.pdf', mimeType: 'application/pdf', ...extra })

const MB = 1024 * 1024

beforeEach(() => { thesisChunks = []; bookChunks = []; rateLimited = false })

describe('thesis chunked upload bounds (U13)', () => {
  test('total above the legit ceiling (6 > 5) is refused and nothing is stored', async () => {
    const res = await thesisRoute.POST(thesisPost(thesisFields({ index: '0', total: '6' }), 1024))
    expect(res.status).toBe(400)
    expect(thesisChunks.length).toBe(0)
  })

  test('absurd total (100000) is refused', async () => {
    const res = await thesisRoute.POST(thesisPost(thesisFields({ index: '0', total: '100000' }), 1024))
    expect(res.status).toBe(400)
    expect(thesisChunks.length).toBe(0)
  })

  test('a single chunk above the 4MB legit chunk size is refused 413', async () => {
    const res = await thesisRoute.POST(thesisPost(thesisFields({ index: '0', total: '5' }), 5 * MB))
    expect(res.status).toBe(413)
    expect(thesisChunks.length).toBe(0)
  })

  test('accumulated size beyond 20MB is refused BEFORE storing (legacy oversized rows)', async () => {
    for (let i = 0; i < 3; i++) {
      thesisChunks.push({ uploadId: 'UP1', userId: 'stu-1', thesisId: 'TH1', index: i, data: Buffer.alloc(7 * MB).toString('base64') })
    }
    const res = await thesisRoute.POST(thesisPost(thesisFields({ index: '3', total: '5' }), 1024))
    expect(res.status).toBe(413)
    expect(thesisChunks.length).toBe(3)
  })

  test('rate limit response short-circuits the upload', async () => {
    rateLimited = true
    const res = await thesisRoute.POST(thesisPost(thesisFields({ index: '0', total: '5' }), 1024))
    expect(res.status).toBe(429)
    expect(thesisChunks.length).toBe(0)
  })

  test('legit flow still works: 5 small chunks + complete assembles the file', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await thesisRoute.POST(thesisPost(thesisFields({ index: String(i), total: '5' }), 1024, i === 0))
      expect(res.status).toBe(200)
    }
    expect(thesisChunks.length).toBe(5)
    const done = await thesisRoute.POST(thesisPost(thesisFields({ total: '5', complete: '1' })))
    expect(done.status).toBe(200)
    const body = await done.json()
    expect(body.ok).toBe(true)
  })
})

describe('book chunked upload total bound (U13 sibling)', () => {
  const bookPost = (body: any) => new NextRequest('http://localhost/api/admin/books/upload-chunk', { method: 'POST', body: JSON.stringify(body) })

  test('absurd total is refused and nothing is stored', async () => {
    const res = await bookRoute.POST(bookPost({ bookId: 'BK1', uploadId: 'BU1', index: 0, total: 100000, chunk: 'AAAA', size: 100, fileName: 'b.pdf', mimeType: 'application/pdf' }))
    expect(res.status).toBe(400)
    expect(bookChunks.length).toBe(0)
  })

  test('legit total at the ceiling (27) is accepted', async () => {
    const res = await bookRoute.POST(bookPost({ bookId: 'BK1', uploadId: 'BU1', index: 0, total: 27, chunk: 'AAAA', size: 100, fileName: 'b.pdf', mimeType: 'application/pdf' }))
    expect(res.status).toBe(200)
    expect(bookChunks.length).toBe(1)
  })
})
