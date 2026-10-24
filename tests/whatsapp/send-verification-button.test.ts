/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_APP_URL = 'https://aactacademy.com'

let currentUser: any
let adminThrows = false
let rateOk = true
let windowConversation: any
const textCalls: any[] = []
const templateCalls: any[] = []
const recordCalls: any[] = []

const db: any = {
  user: {
    findUnique: async () => currentUser,
    update: async () => ({}),
  },
  whatsAppConversation: {
    findUnique: async () => windowConversation,
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireAdmin: async () => {
    if (adminThrows) throw new Error('UNAUTHORIZED')
    return { id: 'admin-1', name: 'المدير' }
  },
}))
mock.module('@/lib/rate-limit', () => ({
  checkDatabaseRateLimit: async () => ({ ok: rateOk }),
}))
mock.module('@/lib/whatsapp-cloud', () => ({
  sendOfficialWhatsAppText: async (to: string, text: string) => {
    textCalls.push({ to, text })
    return { messages: [{ id: 'wamid.text' }] }
  },
  sendOfficialWhatsAppHumanFollowup: async (to: string, name: string) => {
    templateCalls.push({ to, name })
    return { messages: [{ id: 'wamid.template' }] }
  },
}))
mock.module('@/lib/whatsapp-conversations', () => ({
  hashWhatsAppId: (value: string) => `hash:${String(value || '').replace(/\D/g, '')}`,
  recordWhatsAppOutboundMessage: async (args: any) => {
    recordCalls.push(args)
    return {}
  },
}))

const { POST } = await import('../../src/app/api/admin/students/send-verification-whatsapp/route')

function post(email: string) {
  return new NextRequest('http://localhost/api/admin/students/send-verification-whatsapp', {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: { 'Content-Type': 'application/json' },
  })
}

function defaultUser() {
  return {
    id: 'user-1',
    name: 'طالب اختبار',
    email: 'student@example.test',
    phone: '+970598400510',
    role: 'STUDENT',
    emailVerifiedAt: null,
    emailVerificationSentAt: null,
    emailVerificationExpiresAt: null,
  }
}

beforeEach(() => {
  currentUser = defaultUser()
  adminThrows = false
  rateOk = true
  windowConversation = null
  textCalls.length = 0
  templateCalls.length = 0
  recordCalls.length = 0
})

describe('زر إرسال رابط التحقق عبر واتساب', () => {
  test('يرفض غير الأدمن بـ 401 وبلا إرسال', async () => {
    adminThrows = true
    const res = await POST(post('student@example.test'))
    expect(res.status).toBe(401)
    expect(textCalls).toHaveLength(0)
    expect(templateCalls).toHaveLength(0)
  })

  test('يرفض عند غياب الحساب بـ 404 وبلا إرسال', async () => {
    currentUser = null
    const res = await POST(post('student@example.test'))
    expect(res.status).toBe(404)
    expect(textCalls).toHaveLength(0)
    expect(templateCalls).toHaveLength(0)
  })

  test('يرفض الحساب الموثّق بـ 409 وبلا إرسال', async () => {
    currentUser = { ...defaultUser(), emailVerifiedAt: new Date() }
    const res = await POST(post('student@example.test'))
    expect(res.status).toBe(409)
    expect(textCalls).toHaveLength(0)
    expect(templateCalls).toHaveLength(0)
  })

  test('يرفض عند غياب الهاتف بـ 409 وبلا إرسال', async () => {
    currentUser = { ...defaultUser(), phone: null }
    const res = await POST(post('student@example.test'))
    expect(res.status).toBe(409)
    expect(textCalls).toHaveLength(0)
    expect(templateCalls).toHaveLength(0)
  })

  test('يرفض الإصدار الحديث خلال 10 دقائق بـ 409 وبلا إرسال', async () => {
    const now = new Date()
    currentUser = { ...defaultUser(), emailVerificationSentAt: now, emailVerificationExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000) }
    const res = await POST(post('student@example.test'))
    expect(res.status).toBe(409)
    expect(textCalls).toHaveLength(0)
    expect(templateCalls).toHaveLength(0)
  })

  test('يمنع تجاوز حد المعدل بـ 429 وبلا إرسال', async () => {
    rateOk = false
    const res = await POST(post('student@example.test'))
    expect(res.status).toBe(429)
    expect(textCalls).toHaveLength(0)
    expect(templateCalls).toHaveLength(0)
  })

  test('يرسل الرابط نصاً عند فتح النافذة', async () => {
    windowConversation = { lastInboundAt: new Date() }
    const res = await POST(post('student@example.test'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.sent).toBe('link')
    expect(textCalls).toHaveLength(1)
    expect(textCalls[0].to).toBe('970598400510')
    expect(textCalls[0].text).toContain('/api/auth/verify-email?token=')
    expect(templateCalls).toHaveLength(0)
    expect(recordCalls).toHaveLength(1)
  })

  test('يرسل القالب المعتمد عند غلق النافذة ولا يدّعي إرسال الرابط', async () => {
    windowConversation = null
    const res = await POST(post('student@example.test'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.sent).toBe('template')
    expect(templateCalls).toHaveLength(1)
    expect(templateCalls[0].to).toBe('970598400510')
    expect(templateCalls[0].name).toBe('طالب اختبار')
    expect(textCalls).toHaveLength(0)
    expect(recordCalls).toHaveLength(1)
  })

  test('واجهة الزر موصولة بحقول الهاتف والتوثيق', () => {
    const view = readFileSync(new URL('../../src/components/aact/AdminView.tsx', import.meta.url), 'utf-8')
    expect(view).toContain('إرسال رابط التحقق')
    expect(view).toContain('!!s.emailVerifiedAt')
    expect(view).toContain('sendVerificationWhatsApp')
    const studentsRoute = readFileSync(new URL('../../src/app/api/admin/students/route.ts', import.meta.url), 'utf-8')
    expect(studentsRoute).toContain('emailVerifiedAt: true')
    expect(studentsRoute).toContain('phone: true')
  })
})
