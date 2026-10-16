/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test'
import { NextRequest, NextResponse } from 'next/server'

const realAuth = await import('../../src/lib/auth')
mock.module('@/lib/auth', () => ({
  ...realAuth,
  requireUser: async () => ({ id: 'student-ui-e', role: 'STUDENT' }),
  requireAdmin: async () => ({ id: 'admin-ui-e', name: 'مدير', role: 'ADMIN' }),
}))

const realAccess = await import('../../src/lib/student-ai-access')
mock.module('@/lib/student-ai-access', () => ({
  ...realAccess,
  requireStudentAiSupervisorAccess: async () => undefined,
}))

const realRateLimit = await import('../../src/lib/rate-limit')
mock.module('@/lib/rate-limit', () => ({
  ...realRateLimit,
  enforceDatabaseApiRateLimit: async () => NextResponse.json({ error: 'طلبات كثيرة' }, { status: 429 }),
  enforceApiRateLimit: () => null,
}))

const realDb = await import('../../src/lib/db')
mock.module('@/lib/db', () => ({
  db: {
    user: {
      findFirst: async () => { throw new Error('secret internal') },
    },
  },
}))

const chatRoute = await import('../../src/app/api/chat/route')
const supervisorsRoute = await import('../../src/app/api/admin/supervisors/route')

describe('UI-E API behavior', () => {
  test('POST /api/chat returns the database rate-limit response (429)', async () => {
    const response = await chatRoute.POST(new NextRequest('https://academy.test/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'مرحبا' }),
    }))
    expect(response.status).toBe(429)
  })

  test('PATCH /api/admin/supervisors hides internal database errors', async () => {
    const response = await supervisorsRoute.PATCH(new NextRequest('https://academy.test/api/admin/supervisors', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'supervisor-ui-e', action: 'revoke-supervisor' }),
    }))
    const body = await response.json()
    expect(response.status).toBe(500)
    expect(body.error).toBe('تعذر تنفيذ العملية')
    expect(JSON.stringify(body)).not.toContain('secret internal')
  })
})
