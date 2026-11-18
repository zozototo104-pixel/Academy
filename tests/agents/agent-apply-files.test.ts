// حارس ترحيل ملفات الوكالة/الاعتماد (مرحلة 2 — 2026-11-18): كل ملف
// يُرفع بطلب مستقل فور اختياره، فيرجع مفتاحه ورمز ربطه بصاحبه ونوعه.
import { describe, expect, test, mock } from 'bun:test'
import { NextRequest } from 'next/server'

process.env.AACT_UPLOAD_TOKEN_SECRET = 'agent-files-test-secret'

let currentUser: any = null
let storedKeys: string[] = []
let deletedKeys: string[] = []
let linkedKey: string | null = null

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
