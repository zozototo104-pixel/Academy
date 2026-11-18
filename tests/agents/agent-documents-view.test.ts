// حارس عرض وثيقة الوكالة والاعتماد (فحص 2026-11-18): الملكية بـ userId
// أولاً، وبالبريد للطلبات التاريخية بلا userId — والبريد لا يُقبل إلا إذا
// كان userId فارغاً: طلب جديد بـ userId مختلف لا يفتحه البريد وحده (شرط 2026-11-18).
import { describe, expect, test, mock } from 'bun:test'
import { NextRequest } from 'next/server'

let currentUser: any = null
let currentDoc: any = null

mock.module('@/lib/auth', () => ({
  getCurrentUser: async () => currentUser,
}))

mock.module('@/lib/db', () => ({
  db: {
    agentDocument: { findUnique: async () => currentDoc },
  },
}))

mock.module('@/lib/storage', () => ({
  getFileBufferFromStorageOrBase64: async () => ({ buffer: Buffer.from('fake-image'), mimeType: 'image/png' }),
}))

async function getDoc() {
  const { GET } = await import('@/app/api/agent-docs/[id]/route')
  return GET(new NextRequest('http://localhost/api/agent-docs/doc1'), { params: Promise.resolve({ id: 'doc1' }) })
}

describe('عرض وثيقة الوكالة والاعتماد', () => {
  test('زائر بلا دخول يُرفض 401', async () => {
    currentUser = null
    currentDoc = { id: 'doc1', fileName: 'id.png', mimeType: 'image/png', agent: { userId: 'u1', email: 'rep@test.com' } }
    expect((await getDoc()).status).toBe(401)
  })

  test('صاحب الطلب بـ userId يفتح وثيقته ولو اختلف البريد', async () => {
    currentUser = { id: 'u1', email: 'new@test.com', role: 'STUDENT' }
    currentDoc = { id: 'doc1', fileName: 'id.png', mimeType: 'image/png', agent: { userId: 'u1', email: 'rep@test.com' } }
    const res = await getDoc()
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
  })

  test('صاحب الطلب بالبريد يفتح وثيقته (طلب تاريخي بلا userId)', async () => {
    currentUser = { id: 'u2', email: 'rep@test.com', role: 'VISITOR' }
    currentDoc = { id: 'doc1', fileName: 'id.png', mimeType: 'image/png', agent: { userId: null, email: 'rep@test.com' } }
    expect((await getDoc()).status).toBe(200)
  })

  test('شخص غريب يُرفض 403', async () => {
    currentUser = { id: 'u9', email: 'stranger@test.com', role: 'STUDENT' }
    currentDoc = { id: 'doc1', fileName: 'id.png', mimeType: 'image/png', agent: { userId: 'u1', email: 'rep@test.com' } }
    expect((await getDoc()).status).toBe(403)
  })

  test('نفس البريد مع userId مختلف يُرفض 403 (البريد للطلبات التاريخية بلا userId فقط)', async () => {
    currentUser = { id: 'u9', email: 'rep@test.com', role: 'STUDENT' }
    currentDoc = { id: 'doc1', fileName: 'id.png', mimeType: 'image/png', agent: { userId: 'u1', email: 'rep@test.com' } }
    expect((await getDoc()).status).toBe(403)
  })

  test('الإدارة تفتح أي وثيقة', async () => {
    currentUser = { id: 'admin1', email: 'admin@aact.academy', role: 'ADMIN' }
    currentDoc = { id: 'doc1', fileName: 'id.png', mimeType: 'image/png', agent: { userId: 'u1', email: 'rep@test.com' } }
    expect((await getDoc()).status).toBe(200)
  })

  test('وثيقة غير موجودة 404', async () => {
    currentUser = { id: 'admin1', email: 'admin@aact.academy', role: 'ADMIN' }
    currentDoc = null
    expect((await getDoc()).status).toBe(404)
  })
})
