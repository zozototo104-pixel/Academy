/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { OPEN_ENROLLMENT_STATUSES } from '../../src/lib/enrollment-status'

let capturedUserWhere: any = null
const db = {
  user: {
    findMany: async ({ where }: any) => {
      capturedUserWhere = where
      return [{ id: 'student-no-enrollment', email: 'no-enrollment@example.test', name: 'طالب بلا تسجيل', country: 'فلسطين', status: 'ACTIVE', createdAt: new Date('2026-01-01') }]
    },
    count: async ({ where }: any) => {
      capturedUserWhere = where
      return 1
    },
    findFirst: async () => null,
  },
  enrollment: { findMany: async () => [] },
  admissionApplication: { findMany: async () => [] },
  examAttempt: { groupBy: async () => [] },
  programExamAttempt: { groupBy: async () => [] },
  chatMessage: { groupBy: async () => [] },
} as any

const realDb = await import('../../src/lib/db')
mock.module('@/lib/db', () => ({ ...realDb, db }))

const realAuth = await import('../../src/lib/auth')
mock.module('@/lib/auth', () => ({ ...realAuth, requireAdmin: async () => ({ id: 'admin-1', name: 'مدير', role: 'ADMIN' }) }))

const adminStudentsRoute = await import('../../src/app/api/admin/students/route')

describe('files C2 admin student listing', () => {
  test('student list includes STUDENT users even if they have no enrollments', async () => {
    const res = await adminStudentsRoute.GET(new NextRequest('https://academy.test/api/admin/students'))
    const payload = await res.json()
    expect(res.status).toBe(200)
    expect(capturedUserWhere).toMatchObject({ role: 'STUDENT' })
    expect(capturedUserWhere.enrollments).toBeUndefined()
    expect(payload.students[0]).toMatchObject({ id: 'student-no-enrollment', enrollments: [] })
  })
})
