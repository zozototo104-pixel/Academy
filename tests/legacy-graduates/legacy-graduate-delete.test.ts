/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

// Deleting a legacy graduate must remove the certificate and its files,
// and must remove the enrollment and the user account ONLY when nothing
// else references them. A pre-existing account (other enrollments,
// payments, ...) must survive: only its legacy certificate goes.
// Non-legacy certificates are never deletable through this route.
let certs: any[] = []
let enrollments: any[] = []
let users: any[] = []
let payments: any[] = []
let sessions: any[] = []
let notifications: any[] = []
let audits: any[] = []
let deletedFiles: string[] = []

function match(row: any, where: any): boolean {
  return Object.entries(where || {}).every(([k, v]) => row[k] === v)
}

const db: any = {
  certificate: {
    findUnique: async ({ where }: any) => certs.find((c) => match(c, where)) || null,
    delete: async ({ where }: any) => {
      const idx = certs.findIndex((c) => match(c, where))
      if (idx === -1) throw new Error('not found')
      return certs.splice(idx, 1)[0]
    },
    count: async ({ where }: any) => certs.filter((c) => match(c, where)).length,
  },
  enrollment: {
    delete: async ({ where }: any) => {
      const idx = enrollments.findIndex((e) => match(e, where))
      if (idx === -1) throw new Error('not found')
      return enrollments.splice(idx, 1)[0]
    },
    count: async ({ where }: any) => enrollments.filter((e) => match(e, where)).length,
  },
  user: {
    delete: async ({ where }: any) => {
      const idx = users.findIndex((u) => match(u, where))
      if (idx === -1) throw new Error('not found')
      return users.splice(idx, 1)[0]
    },
  },
  payment: { count: async ({ where }: any) => payments.filter((p) => match(p, where)).length },
  session: { count: async ({ where }: any) => sessions.filter((s) => match(s, where)).length },
  notification: { count: async ({ where }: any) => notifications.filter((n) => match(n, where)).length },
  auditLog: {
    create: async ({ data }: any) => {
      audits.push(data)
      return data
    },
  },
  $transaction: async (fn: any) => fn(db),
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireAdmin: async () => ({ id: 'admin-1', name: 'المدير', email: 'admin@test.com' }),
}))
mock.module('@/lib/storage', () => ({
  deleteStoredFile: async (key: string) => {
    deletedFiles.push(key)
    return true
  },
}))

const { DELETE } = await import('../../src/app/api/admin/legacy-graduates/[certificateId]/route')

function seedFresh() {
  certs = [
    {
      id: 'cert-1',
      legacy: true,
      serial: 'AACT-C-2026-00001',
      holderName: 'أحمد محمد علي',
      userId: 'user-1',
      enrollmentId: 'enr-1',
      uploadedFileKey: 'up-1',
      stampedFileKey: 'st-1',
    },
  ]
  enrollments = [{ id: 'enr-1', userId: 'user-1' }]
  users = [{ id: 'user-1', email: 'ahmed@test.com' }]
  payments = []
  sessions = []
  notifications = []
}

beforeEach(() => {
  audits = []
  deletedFiles = []
})

function callDelete(id: string) {
  return DELETE(new NextRequest(`http://localhost/api/admin/legacy-graduates/${id}`), {
    params: Promise.resolve({ certificateId: id }),
  } as any)
}

describe('legacy graduate delete', () => {
  test('fresh graduate: certificate, enrollment, account and files all go', async () => {
    seedFresh()
    const res = await callDelete('cert-1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deleted).toEqual({ certificate: true, enrollment: true, user: true })
    expect(certs).toHaveLength(0)
    expect(enrollments).toHaveLength(0)
    expect(users).toHaveLength(0)
    expect(deletedFiles).toEqual(['up-1', 'st-1'])
    expect(audits).toHaveLength(1)
    expect(audits[0].action).toBe('DELETE_LEGACY_GRADUATE')
  })

  test('pre-existing account: certificate goes, account stays', async () => {
    seedFresh()
    enrollments.push({ id: 'enr-2', userId: 'user-1' })
    payments.push({ id: 'pay-1', userId: 'user-1' })
    const res = await callDelete('cert-1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deleted).toEqual({ certificate: true, enrollment: true, user: false })
    expect(certs).toHaveLength(0)
    expect(enrollments).toEqual([{ id: 'enr-2', userId: 'user-1' }])
    expect(users).toHaveLength(1)
  })

  test('enrollment with another certificate is kept', async () => {
    seedFresh()
    certs.push({
      id: 'cert-2',
      legacy: false,
      serial: 'AACT-C-2026-00002',
      holderName: 'آخر',
      userId: 'user-1',
      enrollmentId: 'enr-1',
    })
    const res = await callDelete('cert-1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deleted).toEqual({ certificate: true, enrollment: false, user: false })
    expect(certs).toEqual([expect.objectContaining({ id: 'cert-2' })])
    expect(enrollments).toHaveLength(1)
    expect(users).toHaveLength(1)
  })

  test('non-legacy certificate is refused and nothing is deleted', async () => {
    seedFresh()
    certs[0].legacy = false
    const res = await callDelete('cert-1')
    expect(res.status).toBe(404)
    expect(certs).toHaveLength(1)
    expect(enrollments).toHaveLength(1)
    expect(users).toHaveLength(1)
    expect(deletedFiles).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  test('missing certificate is a 404', async () => {
    seedFresh()
    const res = await callDelete('cert-nope')
    expect(res.status).toBe(404)
    expect(certs).toHaveLength(1)
  })
})
