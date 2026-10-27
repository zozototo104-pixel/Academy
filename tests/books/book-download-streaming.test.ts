import { describe, expect, test, mock } from 'bun:test'
import { NextRequest } from 'next/server'

// Guard for the 2026-10-27 book-download streaming fix: the download route
// must stream file bytes (no full-file buffering) while preserving every
// auth/enrollment/redirect/error rule of the old buffered endpoint.

let currentUser: any = null
let bookRecord: any = null
let enrollmentRecord: any = null
let streamResult: any = null

mock.module('@/lib/auth', () => ({
  requireUser: async () => {
    if (!currentUser) throw new Error('UNAUTHORIZED')
    return currentUser
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    book: { findUnique: async () => bookRecord },
    enrollment: { findUnique: async () => enrollmentRecord },
  },
}))

mock.module('@/lib/storage', () => ({
  getFileStreamFromStorageOrBase64: async () => streamResult,
}))

function pdfStream(bytes: string) {
  const encoded = new TextEncoder().encode(bytes)
  return {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded)
        controller.close()
      },
    }),
    mimeType: 'application/pdf',
    size: encoded.byteLength,
  }
}

function getBook() {
  return new NextRequest('http://localhost/api/books/book-1/download', { method: 'GET' })
}

const context = { params: { id: 'book-1' } }

const storedBook = {
  id: 'book-1',
  programId: 'prog-1',
  title: 'HR Book',
  fileName: 'hr-book.pdf',
  storageProvider: 's3',
  storageKey: 'books/hr-book.pdf',
  fileUrl: null,
  data: null,
  link: null,
  mimeType: 'application/pdf',
}

describe('book download streaming', () => {
  test('authenticated admin + stored file streams exact bytes with inline disposition', async () => {
    currentUser = { id: 'admin-1', role: 'ADMIN' }
    bookRecord = storedBook
    streamResult = pdfStream('PDF-BYTES')
    const { GET } = await import('@/app/api/books/[id]/download/route')
    const res = await GET(getBook(), context)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBe(`inline; filename*=UTF-8''hr-book.pdf`)
    expect(res.headers.get('cache-control')).toBe('private, no-store, max-age=0')
    expect(res.headers.get('content-length')).toBe('9')
    expect(res.body).toBeInstanceOf(ReadableStream)
    expect(await res.text()).toBe('PDF-BYTES')
  })

  test('unauthenticated request is rejected with 401', async () => {
    currentUser = null
    bookRecord = storedBook
    streamResult = pdfStream('PDF-BYTES')
    const { GET } = await import('@/app/api/books/[id]/download/route')
    const res = await GET(getBook(), context)
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe('تسجيل الدخول مطلوب لفتح الكتاب')
  })

  test('non-admin with inactive enrollment is rejected with 403', async () => {
    currentUser = { id: 'student-1', role: 'STUDENT' }
    bookRecord = storedBook
    enrollmentRecord = { status: 'PENDING' }
    streamResult = pdfStream('PDF-BYTES')
    const { GET } = await import('@/app/api/books/[id]/download/route')
    const res = await GET(getBook(), context)
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('ENROLLMENT_NOT_ACTIVE')
  })

  test('no stored file + link redirects to the link', async () => {
    currentUser = { id: 'admin-1', role: 'ADMIN' }
    bookRecord = {
      ...storedBook,
      fileName: null,
      storageKey: null,
      fileUrl: null,
      data: null,
      link: 'https://example.com/book.pdf',
    }
    streamResult = null
    const { GET } = await import('@/app/api/books/[id]/download/route')
    const res = await GET(getBook(), context)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://example.com/book.pdf')
  })

  test('unreadable file + no link returns 404', async () => {
    currentUser = { id: 'admin-1', role: 'ADMIN' }
    bookRecord = storedBook
    streamResult = null
    const { GET } = await import('@/app/api/books/[id]/download/route')
    const res = await GET(getBook(), context)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('لا يوجد ملف أو رابط متاح لهذا الكتاب')
  })
})
