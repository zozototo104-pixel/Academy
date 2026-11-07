/// <reference types="bun-types" />
import { afterEach, describe, expect, mock, test } from 'bun:test'

// Guard: قائمة الحسابات التجريبية في لوحة الإدارة.
// - GET يخضع لنفس بوابة الإنتاج في POST بالضبط: في بيئة الإنتاج بلا تفعيل
//   صريح (ENABLE_DEMO_ACCOUNTS) يُرفض بـ403 — كلمات المرور معروفة من الكود.
// - وحين يكون مفعّلًا، الاستجابة لا تحمل أي حقل أو قيمة كلمة مرور بنيويًا.

mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/auth', () => ({
  requireAdmin: async () => ({ id: 'admin-test', role: 'ADMIN', name: 'Admin Test' }),
}))

const { GET } = await import('../../src/app/api/admin/demo-accounts/route')
const { DEMO_ACCOUNTS } = await import('@/lib/demo-accounts')

const ORIGINAL_VERCEL_ENV = process.env.VERCEL_ENV
const ORIGINAL_ENABLE = process.env.ENABLE_DEMO_ACCOUNTS

afterEach(() => {
  if (ORIGINAL_VERCEL_ENV === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = ORIGINAL_VERCEL_ENV
  if (ORIGINAL_ENABLE === undefined) delete process.env.ENABLE_DEMO_ACCOUNTS
  else process.env.ENABLE_DEMO_ACCOUNTS = ORIGINAL_ENABLE
})

function setEnv(vercelEnv?: string, enable?: string) {
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV
  else process.env.VERCEL_ENV = vercelEnv
  if (enable === undefined) delete process.env.ENABLE_DEMO_ACCOUNTS
  else process.env.ENABLE_DEMO_ACCOUNTS = enable
}

function allPasswords(): string[] {
  return Object.values(DEMO_ACCOUNTS as Record<string, any>)
    .map((account) => account?.password)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

describe('admin demo-accounts GET', () => {
  test('outside production: 200 and the response carries no password field or value', async () => {
    setEnv(undefined, undefined)
    const res = await GET()
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.includes('"password"')).toBe(false)
    for (const password of allPasswords()) {
      expect(text.includes(password)).toBe(false)
    }
    const body = JSON.parse(text)
    expect(body.accounts.admin.email).toBe((DEMO_ACCOUNTS as any).admin.email)
    expect(body.accounts.admin.role).toBe('ADMIN')
  })

  test('production without explicit enablement: refused with 403 like POST', async () => {
    setEnv('production', undefined)
    const res = await GET()
    expect(res.status).toBe(403)
    const text = await res.text()
    for (const password of allPasswords()) {
      expect(text.includes(password)).toBe(false)
    }
  })

  test('production with explicit enablement: 200 but still no passwords', async () => {
    setEnv('production', 'true')
    const res = await GET()
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.includes('"password"')).toBe(false)
    for (const password of allPasswords()) {
      expect(text.includes(password)).toBe(false)
    }
  })
})
