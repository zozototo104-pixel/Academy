import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Guard: urgent-message alert API (breaking-news banner for students).
// Only ADMIN_MESSAGE (admin) and SUPERVISION (human supervisor) unread
// notifications count as urgent; marking is per kind; non-students get
// zeros and cannot mark anything.

type Row = { id: string; userId: string; type: string; read: boolean; createdAt: Date; link: string | null }
let rows: Row[] = []
let currentUser: any = { id: 'student-1', role: 'STUDENT' }

function matches(row: Row, where: any): boolean {
  if (where.userId && row.userId !== where.userId) return false
  if (where.read !== undefined && row.read !== where.read) return false
  if (where.type) {
    if (typeof where.type === 'string' && row.type !== where.type) return false
    if (where.type.in && !where.type.in.includes(row.type)) return false
  }
  return true
}

mock.module('@/lib/db', () => ({
  db: {
    notification: {
      count: async ({ where }: any) => rows.filter((r) => matches(r, where)).length,
      findFirst: async ({ where }: any) => rows.filter((r) => matches(r, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] || null,
      updateMany: async ({ where, data }: any) => {
        let n = 0
        for (const r of rows) if (matches(r, where)) { r.read = data.read; n++ }
        return { count: n }
      },
    },
  },
}))

mock.module('@/lib/auth', () => ({
  requireUser: async () => currentUser,
}))

const { GET, POST } = await import('@/app/api/student/urgent-messages/route')
const { NextRequest } = await import('next/server')

const at = (h: number) => new Date(Date.now() - h * 3600_000)

beforeEach(() => {
  currentUser = { id: 'student-1', role: 'STUDENT' }
  rows = [
    { id: 'n1', userId: 'student-1', type: 'ADMIN_MESSAGE', read: false, createdAt: at(5), link: 'admin-messages:adm-1' },
    { id: 'n2', userId: 'student-1', type: 'ADMIN_MESSAGE', read: false, createdAt: at(1), link: 'admin-messages:adm-9' },
    { id: 'n3', userId: 'student-1', type: 'ADMIN_MESSAGE', read: true, createdAt: at(9), link: 'admin-messages:adm-1' },
    { id: 'n4', userId: 'student-1', type: 'SUPERVISION', read: false, createdAt: at(2), link: 'dashboard' },
    { id: 'n5', userId: 'student-1', type: 'PAYMENT', read: false, createdAt: at(1), link: null },
    { id: 'n6', userId: 'student-2', type: 'ADMIN_MESSAGE', read: false, createdAt: at(1), link: 'admin-messages:adm-2' },
  ]
})

describe('GET /api/student/urgent-messages', () => {
  test('counts only the student\'s own unread admin + supervisor messages, with the latest admin conversation id', async () => {
    const res = await GET()
    const body = await res.json()
    expect(body.admin.count).toBe(2)
    expect(body.admin.admissionId).toBe('adm-9')
    expect(body.supervisor.count).toBe(1)
  })

  test('non-students get zeros', async () => {
    currentUser = { id: 'sup-1', role: 'SUPERVISOR' }
    const res = await GET()
    const body = await res.json()
    expect(body.admin.count).toBe(0)
    expect(body.supervisor.count).toBe(0)
  })
})

describe('POST /api/student/urgent-messages', () => {
  test('kind ADMIN marks only admin messages read', async () => {
    const res = await POST(new NextRequest('http://localhost/api/student/urgent-messages', { method: 'POST', body: JSON.stringify({ kind: 'ADMIN' }) }))
    const body = await res.json()
    expect(body.updated).toBe(2)
    expect(rows.find((r) => r.id === 'n4')!.read).toBe(false)
    const after = await (await GET()).json()
    expect(after.admin.count).toBe(0)
    expect(after.supervisor.count).toBe(1)
  })

  test('kind ALL clears both kinds but leaves other notification types untouched', async () => {
    const res = await POST(new NextRequest('http://localhost/api/student/urgent-messages', { method: 'POST', body: JSON.stringify({ kind: 'ALL' }) }))
    const body = await res.json()
    expect(body.updated).toBe(3)
    expect(rows.find((r) => r.id === 'n5')!.read).toBe(false)
    expect(rows.find((r) => r.id === 'n6')!.read).toBe(false)
  })

  test('an invalid kind is rejected', async () => {
    const res = await POST(new NextRequest('http://localhost/api/student/urgent-messages', { method: 'POST', body: JSON.stringify({ kind: 'BOGUS' }) }))
    expect(res.status).toBe(400)
  })
})
