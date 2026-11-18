// حارس ترحيل ملفات الوكالة/الاعتماد (مرحلة 2 — 2026-11-18): كل ملف
// يُرفع بطلب مستقل فور اختياره، فيرجع مفتاحه ورمز ربطه بصاحبه ونوعه.
import { describe, expect, test, mock } from 'bun:test'
import { NextRequest, NextResponse } from 'next/server'

process.env.AACT_UPLOAD_TOKEN_SECRET = 'agent-files-test-secret'

let currentUser: any = null
let storedKeys: string[] = []
let deletedKeys: string[] = []
let linkedKey: string | null = null
let pendingKey: string | null = null
let pendingCancelled = false
let rateLimited = false
let concurrentClaim = false

mock.module('@/lib/rate-limit', () => ({
  enforceDatabaseApiRateLimit: async () => rateLimited
    ? NextResponse.json({ error: 'طلبات كثيرة' }, { status: 429 })
    : null,
}))

mock.module('@/lib/auth', () => ({
  getCurrentUser: async () => currentUser,
}))

mock.module('@/lib/storage', () => ({
  storageErrorMessage: () => 'storage error',
  getStorageDownloadPathForKey: (key: string) => `/api/files/${key}`,
  storeFileBuffer: async (input: any) => {
    const key = `${String(input.namespace || 'uploads')}/2026-11-18/uuid-1-${input.fileName}`
    storedKeys.push(key)
    return { provider: 'local', key, url: `/api/files/${key}`, mimeType: input.mimeType, size: input.buffer.byteLength }
  },
  deleteStoredFile: async (key: string) => { deletedKeys.push(key); return true },
}))

mock.module('@/lib/db', () => ({
  db: {
    agentPendingUpload: {
      create: async ({ data }: any) => { pendingKey = data.storageKey; pendingCancelled = false },
      findMany: async () => pendingKey ? [{ storageKey: pendingKey, cancelled: pendingCancelled }] : [],
      updateMany: async ({ where, data }: any) => {
        if (pendingKey !== where.storageKey || pendingCancelled || concurrentClaim) return { count: 0 }
        pendingCancelled = !!data.cancelled
        return { count: 1 }
      },
      deleteMany: async () => { pendingKey = null; pendingCancelled = false; return { count: 1 } },
    },
    agentDocument: {
      findFirst: async (args: any) => args.where.storageKey === linkedKey ? { id: 'saved-doc' } : null,
    },
  },
}))

const { createAgentUploadToken, verifyAgentUploadToken } = await import('@/lib/agent-upload-token')

function stageForm(docType = 'LICENSE', file: File = new File(['x'], 'license.png', { type: 'image/png' })) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('docType', docType)
  return new NextRequest('http://localhost/api/agent-apply/files', { method: 'POST', body: fd })
}

async function stageOne() {
  const { POST } = await import('@/app/api/agent-apply/files/route')
  return POST(stageForm())
}

describe('ترحيل ملف وكالة/اعتماد واحد', () => {
  test('زائر بلا دخول يُرفض 401 ولا يُخزَّن شيء', async () => {
    currentUser = null
    storedKeys = []
    const res = await stageOne()
    const body = await res.json()
    expect(res.status).toBe(401)
    expect(body.code).toBe('LOGIN_REQUIRED')
    expect(storedKeys).toEqual([])
  })

  test('حساب الإدارة/المشرف لا يرحّل ملفات', async () => {
    currentUser = { id: 'admin1', role: 'ADMIN' }
    storedKeys = []
    expect((await stageOne()).status).toBe(403)
    currentUser = { id: 'sup1', role: 'SUPERVISOR' }
    expect((await stageOne()).status).toBe(403)
    expect(storedKeys).toEqual([])
  })

  test('بلا ملف يُرفض 400', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    const fd = new FormData()
    fd.append('docType', 'LICENSE')
    const { POST } = await import('@/app/api/agent-apply/files/route')
    const res = await POST(new NextRequest('http://localhost/api/agent-apply/files', { method: 'POST', body: fd }))
    expect(res.status).toBe(400)
  })

  test('ملف أكبر من 4MB يُرفض', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    const big = new File([new Uint8Array(5 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    const { POST } = await import('@/app/api/agent-apply/files/route')
    const res = await POST(stageForm('LICENSE', big))
    expect(res.status).toBe(400)
  })

  test('صيغة غير مدعومة تُرفض', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    const { POST } = await import('@/app/api/agent-apply/files/route')
    const res = await POST(stageForm('LICENSE', new File(['x'], 'notes.txt', { type: 'text/plain' })))
    expect(res.status).toBe(400)
  })

  test('نجاح الترحيل يرجع مفتاحاً ببادئة agent-documents ورمزاً صالحاً لصاحبه', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    storedKeys = []
    const res = await stageOne()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.document.docType).toBe('LICENSE')
    expect(body.document.storageKey.startsWith('agent-documents/license/')).toBe(true)
    expect(verifyAgentUploadToken(body.document.uploadToken, { userId: 'u1', docType: 'LICENSE', storageKey: body.document.storageKey })).toBe(true)
    expect(verifyAgentUploadToken(body.document.uploadToken, { userId: 'u9', docType: 'LICENSE', storageKey: body.document.storageKey })).toBe(false)
  })

  test('معدل الرفع المحظور يُرفض 429 قبل قراءة الملف أو تخزينه', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    storedKeys = []
    rateLimited = true
    try {
      expect((await stageOne()).status).toBe(429)
      expect(storedKeys).toEqual([])
    } finally {
      rateLimited = false
    }
  })
})

const { cleanupExpiredAgentUploads } = await import('@/lib/agent-upload-token')

describe('تنظيف الرفع المرحّل المنتهي بعد 24 ساعة', () => {

  test('يلغي الملف قبل حذف الكائن، وينظف صفه إن كان غير مرتبط', async () => {
    pendingKey = 'agent-documents/license/expired.png'
    pendingCancelled = false
    linkedKey = null
    deletedKeys = []
    const result = await cleanupExpiredAgentUploads()
    expect(result).toEqual({ checked: 1, removed: 1, linked: 0, failed: 0 })
    expect(deletedKeys).toEqual(['agent-documents/license/expired.png'])
    expect(pendingKey).toBeNull()
  })

  test('لا يحذف وثيقة مرتبطة بطلب محفوظ حتى لو بقي صف مؤقت بالخطأ', async () => {
    pendingKey = 'agent-documents/id/saved.png'
    pendingCancelled = false
    linkedKey = pendingKey
    deletedKeys = []
    const result = await cleanupExpiredAgentUploads()
    expect(result.linked).toBe(1)
    expect(deletedKeys).toEqual([])
    linkedKey = null
  })

  test('يراعي فوز التقديم/الإلغاء بالسباق: الملف الذي لا نملكه لا يُحذف', async () => {
    pendingKey = 'agent-documents/id/claimed.png'
    pendingCancelled = true
    linkedKey = null
    deletedKeys = []
    // A cancelled upload is retried by cron; it has already been removed
    // from submissions and remains safe for cleanup.
    const result = await cleanupExpiredAgentUploads()
    expect(result.removed).toBe(1)
    expect(deletedKeys).toEqual(['agent-documents/id/claimed.png'])
  })

  test('إذا استهلك التقديم المفتاح أولاً، لا يلمس التنظيف كائن التخزين', async () => {
    pendingKey = 'agent-documents/id/submitted.png'
    pendingCancelled = false
    linkedKey = null
    deletedKeys = []
    concurrentClaim = true
    try {
      const result = await cleanupExpiredAgentUploads()
      expect(result.removed).toBe(0)
      expect(deletedKeys).toEqual([])
    } finally {
      concurrentClaim = false
      pendingKey = null
    }
  })
})

describe('حذف مفتاح مرحّل', () => {
  test('رمز خاطئ يُرفض 403 ولا يُحذف شيء', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    deletedKeys = []
    const key = 'agent-documents/license/2026-11-18/uuid-1-license.png'
    const { DELETE } = await import('@/app/api/agent-apply/files/route')
    const res = await DELETE(new NextRequest('http://localhost/api/agent-apply/files', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageKey: key, uploadToken: 'bad.token' }),
    }))
    expect(res.status).toBe(403)
    expect(deletedKeys).toEqual([])
  })

  test('مفتاح خارج البادئة يُرفض 400', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    const { DELETE } = await import('@/app/api/agent-apply/files/route')
    const res = await DELETE(new NextRequest('http://localhost/api/agent-apply/files', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageKey: 'admissions/x/id.pdf', uploadToken: 'x.y' }),
    }))
    expect(res.status).toBe(400)
  })

  test('رمز صالح يحذف المفتاح', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    deletedKeys = []
    const key = 'agent-documents/license/2026-11-18/uuid-1-license.png'
    linkedKey = null
    pendingKey = key
    const token = createAgentUploadToken({ userId: 'u1', docType: 'LICENSE', storageKey: key, storageProvider: 'local', fileName: 'license.png', mimeType: 'image/png', size: 100 })
    const { DELETE } = await import('@/app/api/agent-apply/files/route')
    const res = await DELETE(new NextRequest('http://localhost/api/agent-apply/files', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageKey: key, uploadToken: token }),
    }))
    expect(res.status).toBe(200)
    expect(deletedKeys).toEqual([key])
  })

  test('a consumed key cannot be removed even before the linked-document lookup sees it', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    deletedKeys = []
    linkedKey = null
    pendingKey = null
    const key = 'agent-documents/license/consumed.png'
    const token = createAgentUploadToken({ userId: 'u1', docType: 'LICENSE', storageKey: key, storageProvider: 'local', fileName: 'consumed.png', mimeType: 'image/png', size: 100 })
    const { DELETE } = await import('@/app/api/agent-apply/files/route')
    const response = await DELETE(new NextRequest('http://localhost/api/agent-apply/files', {
      method: 'DELETE', body: JSON.stringify({ storageKey: key, uploadToken: token }),
    }))
    expect(response.status).toBe(409)
    expect(deletedKeys).toEqual([])
  })

  test('رمز الرفع لا يسمح بحذف وثيقة أصبحت مرتبطة بطلب محفوظ', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    deletedKeys = []
    const key = 'agent-documents/license/2026-11-18/uuid-1-license.png'
    linkedKey = key
    const token = createAgentUploadToken({ userId: 'u1', docType: 'LICENSE', storageKey: key, storageProvider: 'local', fileName: 'license.png', mimeType: 'image/png', size: 100 })
    const { DELETE } = await import('@/app/api/agent-apply/files/route')
    const res = await DELETE(new NextRequest('http://localhost/api/agent-apply/files', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageKey: key, uploadToken: token }),
    }))
    expect(res.status).toBe(409)
    expect(deletedKeys).toEqual([])
    linkedKey = null
  })
})
