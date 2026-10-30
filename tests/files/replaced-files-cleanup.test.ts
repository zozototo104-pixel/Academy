import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// تنظيف الملفات المستبدلة (تدقيق ٢٠٢٦-١٠-٣٠، الوحدة ٧): كل استبدال كان
// يترك جسم الملف القديم يتيماً في التخزين بلا سجل — وثائق هوية وملفات
// أطروحات وكتب وواجبات. القاعدة: بعد تثبيت الجديد رسمياً يُحذف القديم
// حذفاً جانبياً آمناً (فشله لا يُفشل الرفع)، ولا يُحذف أبداً قبل نجاح
// الاستبدال، ولا يُحذف المفتاح نفسه إن تطابق.
// ---------------------------------------------------------------------------

const deleted: string[] = []
const state: any = {
  supersededDocKeys: [] as string[],
  thesisFileKey: 'thesis/old-thesis.pdf',
  bookFileKey: 'books/prog/old-book.pdf',
  existingSubmissionKey: 'assignments/student-1/old-homework.pdf',
}

const ADMIN = { id: 'admin-1', role: 'ADMIN', name: 'الأدمن', email: 'admin@example.com' }
const STUDENT = { id: 'student-1', role: 'STUDENT', name: 'محمد', email: 'student@example.com' }
let currentUser: any = ADMIN

const admissionApp: any = {
  id: 'app-1',
  reference: 'AACT-2026-9999',
  email: 'student@example.com',
  userId: 'student-1',
  status: 'UPLOADING_DOCUMENTS',
  notes: null,
}

const txMock: any = {
  admissionDocument: {
    create: async ({ data }: any) => ({ id: 'doc-new', ...data }),
    findMany: async () => state.supersededDocKeys.map((storageKey) => ({ storageKey })),
    deleteMany: async () => ({ count: state.supersededDocKeys.length }),
  },
  thesisChunk: { deleteMany: async () => ({ count: 0 }) },
  thesisUploadChunk: { deleteMany: async () => ({ count: 0 }) },
  thesisSubmission: {
    updateMany: async () => ({ count: 1 }),
    findFirst: async () => ({ id: 'thesis-1', fileStorageKey: 'thesis/new-thesis.pdf' }),
  },
  bookChunk: { deleteMany: async () => ({ count: 0 }) },
  bookKnowledgeItem: { deleteMany: async () => ({ count: 0 }) },
  bookReadJob: { deleteMany: async () => ({ count: 0 }) },
  book: { update: async ({ data }: any) => ({ id: 'book-1', title: 'كتاب', program: { titleAr: 'برنامج' }, ...data }) },
}

mock.module('@/lib/db', () => ({
  db: {
    $transaction: async (fn: any) => fn(txMock),
    admissionApplication: { findFirst: async () => admissionApp, update: async () => ({}) },
    admissionDocument: { findMany: async () => [] },
    thesisSubmission: {
      findFirst: async () => ({
        id: 'thesis-1',
        userId: 'student-1',
        admissionId: 'app-1',
        status: 'PLAN_APPROVED',
        fileStorageKey: state.thesisFileKey,
      }),
    },
    thesisUploadChunk: {
      deleteMany: async () => ({ count: 0 }),
      findFirst: async () => null,
      findMany: async () => [
        { index: 0, data: Buffer.from('%PDF-1.4 thesis body').toString('base64') },
      ],
      upsert: async () => ({}),
    },
    book: {
      findUnique: async () => ({
        id: 'book-1',
        storageKey: state.bookFileKey,
        program: { id: 'prog-1', slug: 'prog', titleAr: 'برنامج' },
      }),
    },
    bookUploadChunk: {
      findMany: async () => [
        { index: 0, total: 1, chunk: Buffer.from('%PDF-1.4 book body').toString('base64'), fileName: 'book.pdf', mimeType: 'application/pdf' },
      ],
      deleteMany: async () => ({ count: 1 }),
    },
    unit: { count: async () => 0 },
    programAssignment: {
      findUnique: async () => ({
        id: 'asg-1',
        status: 'PUBLISHED',
        programId: 'prog-1',
        title: 'واجب',
        dueDays: null,
        dueAt: null,
        program: { id: 'prog-1', titleAr: 'برنامج' },
      }),
    },
    enrollment: { findFirst: async () => ({ id: 'enr-1', createdAt: new Date() }) },
    assignmentSubmission: {
      findUnique: async () => ({ status: 'SUBMITTED', fileStorageKey: state.existingSubmissionKey }),
      upsert: async (args: any) => ({ id: 'sub-1', ...args.create }),
    },
    user: { findMany: async () => [] },
  },
}))

mock.module('@/lib/auth', () => ({
  requireUser: async () => currentUser,
  requireAdmin: async () => currentUser,
  getCurrentUser: async () => currentUser,
}))

mock.module('@/lib/notify', () => ({ notify: async () => {}, audit: async () => {} }))

mock.module('@/lib/storage', () => ({
  storeFileBuffer: async (input: any) => ({
    key: `stored/${input.namespace}/new-file`,
    url: `/api/files/stored/${input.namespace}/new-file`,
    provider: 's3',
    size: input.buffer?.length || 0,
    mimeType: input.mimeType,
  }),
  deleteStoredFile: async (key: string) => {
    deleted.push(key)
    return true
  },
  storageErrorMessage: (e: any) => String(e?.message || e),
  getStorageDownloadPathForKey: (key: string) => `/api/files/${key}`,
  getPublicStorageUrlForKey: () => null,
  createSignedStorageUrlForKey: () => null,
  readStoredFile: async () => null,
  getFileBufferFromStorageOrBase64: async () => null,
  getFileStreamFromStorageOrBase64: async () => null,
  storeFileBufferAtKey: async () => ({}),
  signLocalStorageDownloadPath: (key: string) => `/api/files/${key}`,
  verifyLocalStorageDownloadSignature: () => false,
  configuredAllowedStorageHosts: () => [],
  isPrivateIp: () => false,
  externalStoredFile: (url: string, fileName: string) => ({ key: url, url, fileName }),
}))

mock.module('@prisma/client', () => ({ Prisma: { JsonNull: null, DbNull: null } }))

const admissionsFiles = await import('@/app/api/admissions/files/route')
const thesisUpload = await import('@/app/api/thesis/upload-chunk/route')
const bookUpload = await import('@/app/api/admin/books/upload-chunk/route')
const assignments = await import('@/app/api/assignments/route')

const pdfFile = (name: string) =>
  new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 1, 2, 3])], name, { type: 'application/pdf' })

beforeEach(() => {
  deleted.length = 0
  currentUser = ADMIN
  state.supersededDocKeys = []
  state.thesisFileKey = 'thesis/old-thesis.pdf'
  state.bookFileKey = 'books/prog/old-book.pdf'
  state.existingSubmissionKey = 'assignments/student-1/old-homework.pdf'
})

describe('وثائق الالتحاق المستبدلة', () => {
  test('استبدال وثيقة يحذف جسم القديمة من التخزين بعد تثبيت الجديدة', async () => {
    state.supersededDocKeys = ['admissions/aact-2026-9999/id_card/old-scan.pdf']
    const form = new FormData()
    form.set('applicationId', 'app-1')
    form.set('docType', 'doc_ID_CARD')
    form.set('file', pdfFile('id.pdf'))
    const res = await admissionsFiles.POST(new NextRequest('http://localhost/api/admissions/files', { method: 'POST', body: form }))
    expect(res.status).toBe(200)
    expect(deleted).toEqual(['admissions/aact-2026-9999/id_card/old-scan.pdf'])
  })

  test('أول رفع (لا نسخة سابقة) لا يحذف شيئاً', async () => {
    state.supersededDocKeys = []
    const form = new FormData()
    form.set('applicationId', 'app-1')
    form.set('docType', 'doc_ID_CARD')
    form.set('file', pdfFile('id.pdf'))
    const res = await admissionsFiles.POST(new NextRequest('http://localhost/api/admissions/files', { method: 'POST', body: form }))
    expect(res.status).toBe(200)
    expect(deleted).toEqual([])
  })
})

describe('ملف الأطروحة المعاد رفعه', () => {
  test('إكمال رفع جديد يحذف النسخة السابقة من التخزين', async () => {
    currentUser = STUDENT
    const form = new FormData()
    form.set('thesisId', 'thesis-1')
    form.set('uploadId', 'upl-1')
    form.set('index', '0')
    form.set('total', '1')
    form.set('complete', '1')
    form.set('fileName', 'thesis.pdf')
    form.set('mimeType', 'application/pdf')
    const res = await thesisUpload.POST(new NextRequest('http://localhost/api/thesis/upload-chunk', { method: 'POST', body: form }))
    expect(res.status).toBe(200)
    expect(deleted).toEqual(['thesis/old-thesis.pdf'])
  })

  test('أول رفع لملف أطروحة (لا مفتاح سابق) لا يحذف شيئاً', async () => {
    currentUser = STUDENT
    state.thesisFileKey = null
    const form = new FormData()
    form.set('thesisId', 'thesis-1')
    form.set('uploadId', 'upl-1')
    form.set('index', '0')
    form.set('total', '1')
    form.set('complete', '1')
    form.set('fileName', 'thesis.pdf')
    form.set('mimeType', 'application/pdf')
    const res = await thesisUpload.POST(new NextRequest('http://localhost/api/thesis/upload-chunk', { method: 'POST', body: form }))
    expect(res.status).toBe(200)
    expect(deleted).toEqual([])
  })
})

describe('ملف الكتاب المعاد رفعه', () => {
  test('إكمال رفع جديد يحذف ملف الكتاب السابق', async () => {
    const req = new NextRequest('http://localhost/api/admin/books/upload-chunk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'complete', bookId: 'book-1', uploadId: 'upl-1' }),
    })
    const res = await bookUpload.POST(req)
    expect(res.status).toBe(200)
    expect(deleted).toEqual(['books/prog/old-book.pdf'])
  })
})

describe('واجب الطالب المعاد تسليمه', () => {
  test('إعادة تسليم بملف جديد تحذف ملف التسليم السابق', async () => {
    currentUser = STUDENT
    const form = new FormData()
    form.set('assignmentId', 'asg-1')
    form.set('file', pdfFile('homework.pdf'))
    const res = await assignments.POST(new NextRequest('http://localhost/api/assignments', { method: 'POST', body: form }))
    expect(res.status).toBe(200)
    expect(deleted).toEqual(['assignments/student-1/old-homework.pdf'])
  })

  test('إعادة تسليم نصية (بلا ملف) تترك ملف السابق سليماً', async () => {
    currentUser = STUDENT
    const req = new NextRequest('http://localhost/api/assignments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assignmentId: 'asg-1', answerText: 'إجابة نصية' }),
    })
    const res = await assignments.POST(req)
    expect(res.status).toBe(200)
    expect(deleted).toEqual([])
  })
})
