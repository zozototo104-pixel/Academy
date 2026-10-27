/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

let waivers: any[] = []
let conversation: any = null
let paymentFixture: any = null

const calls: Record<string, any[]> = {
  paymentUpdate: [],
  waiverUpdate: [],
  waiverCreate: [],
  waiverUpdateMany: [],
  email: [],
  waText: [],
  waTemplate: [],
  outbound: [],
  notify: [],
  audit: [],
}

const tx: any = {
  $queryRaw: async () => [],
  paymentWaiverCode: {
    findFirst: async (args: any) => {
      let list = waivers.filter((w) => w.paymentId === args.where.paymentId && (args.where.status === undefined || w.status === args.where.status))
      if (args.orderBy?.createdAt === 'desc') list = [...list].sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      return list[0] || null
    },
    updateMany: async (args: any) => {
      let count = 0
      for (const w of waivers) {
        if (w.id === args.where.id && w.status === args.where.status) { Object.assign(w, args.data); count += 1 }
      }
      calls.waiverUpdateMany.push(args)
      return { count }
    },
    create: async (args: any) => {
      const row = {
        id: `w-new-${waivers.length + 1}`,
        status: 'ISSUED',
        emailStatus: 'SKIPPED',
        emailSentAt: null,
        verifiedAt: null,
        approvedAt: null,
        createdAt: new Date(),
        ...args.data,
      }
      waivers.push(row)
      calls.waiverCreate.push(row)
      return row
    },
  },
}

const db: any = {
  payment: {
    findUnique: async () => paymentFixture,
    update: async (args: any) => { calls.paymentUpdate.push(args); return { ...paymentFixture, ...args.data } },
  },
  paymentWaiverCode: {
    update: async (args: any) => {
      const w = waivers.find((x) => x.id === args.where.id)
      if (w) Object.assign(w, args.data)
      calls.waiverUpdate.push(args)
      return w
    },
  },
  whatsAppConversation: {
    findUnique: async () => conversation,
  },
  $transaction: async (fn: any) => fn(tx),
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireAdmin: async () => ({ id: 'admin-1', name: 'المدير', email: 'admin@test.com' }),
}))
mock.module('@/lib/notify', () => ({
  notify: async (...args: any[]) => { calls.notify.push(args) },
  audit: async (...args: any[]) => { calls.audit.push(args) },
}))
mock.module('@/lib/mailer', () => ({
  emailPaymentWaiverCode: async (...args: any[]) => { calls.email.push(args); return true },
  isEmailDeliveryConfigured: async () => true,
}))
mock.module('@/lib/whatsapp-cloud', () => ({
  sendOfficialWhatsAppText: async (...args: any[]) => { calls.waText.push(args); return { messages: [{ id: 'wamid-1' }] } },
  sendOfficialWhatsAppHumanFollowup: async (...args: any[]) => { calls.waTemplate.push(args); return { messages: [{ id: 'wamid-2' }] } },
}))
mock.module('@/lib/whatsapp-conversations', () => ({
  hashWhatsAppId: (digits: string) => `hash:${digits}`,
  recordWhatsAppOutboundMessage: async (...args: any[]) => { calls.outbound.push(args) },
}))
mock.module('@/lib/settle-payment', () => ({
  finalizeAdmissionAfterSettlement: async () => ({}),
}))
mock.module('@/lib/settings', () => ({
  getSettings: async () => ({}),
  nextInvoiceNo: async () => 'AACT-INV-2026-0002',
}))

const { PATCH } = await import('../../src/app/api/admin/payments/waivers/route')

function basePayment() {
  return {
    id: 'pay-1',
    invoiceNo: 'AACT-INV-2026-0001',
    purpose: 'TUITION',
    description: 'رسوم دراسية',
    amount: 100,
    amountCents: 10000,
    status: 'UNPAID',
    payerName: null,
    payerEmail: null,
    user: { id: 'user-1', email: 'student@test.com', name: 'طالب اختبار', phone: '+970599123456' },
    admission: { id: 'adm-1', userId: 'user-1', email: 'student@test.com', fullName: 'طالب اختبار', phone: '+970599123456' },
    enrollment: null,
    agent: null,
  }
}

function waiverFixture(overrides: any = {}) {
  return {
    id: 'w-1',
    paymentId: 'pay-1',
    codeHash: 'hash-old',
    codePreview: '••••-1111',
    waiverType: 'FULL_SCHOLARSHIP',
    requestedAmount: null,
    requestedAmountCents: null,
    reason: 'منحة دراسية معتمدة',
    status: 'ISSUED',
    emailStatus: 'SENT',
    emailSentAt: new Date(),
    issuedById: 'admin-1',
    verifiedById: null,
    approvedById: null,
    verifiedAt: null,
    approvedAt: null,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdAt: new Date(Date.now() - 60 * 60 * 1000),
    updatedAt: new Date(),
    ...overrides,
  }
}

function patch(body: any) {
  return new NextRequest('http://localhost/api/admin/payments/waivers', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  waivers = []
  conversation = null
  paymentFixture = basePayment()
  for (const key of Object.keys(calls)) calls[key].length = 0
})

describe('waiver code resend', () => {
  test('window open: cancels old ISSUED, creates new ISSUED, emails + WhatsApps the new code', async () => {
    waivers = [waiverFixture()]
    conversation = { lastInboundAt: new Date(Date.now() - 60 * 60 * 1000) }
    const res = await PATCH(patch({ action: 'RESEND', paymentId: 'pay-1' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.code).toMatch(/^AACT-WV-/)
    expect(body.emailStatus).toBe('SENT')
    expect(body.whatsapp).toBe('sent')
    expect(waivers).toHaveLength(2)
    expect(waivers[0].status).toBe('CANCELLED')
    const created = waivers[1]
    expect(created.status).toBe('ISSUED')
    expect(created.waiverType).toBe('FULL_SCHOLARSHIP')
    expect(created.requestedAmountCents).toBe(null)
    expect(created.reason).toBe('منحة دراسية معتمدة')
    expect(new Date(created.expiresAt).getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
    expect(new Date(created.expiresAt).getTime() - Date.now()).toBeLessThan(8 * 24 * 60 * 60 * 1000)
    expect(calls.email).toHaveLength(1)
    expect(calls.email[0][1].code).toBe(body.code)
    expect(calls.waText).toHaveLength(1)
    expect(calls.waText[0][0]).toBe('970599123456')
    expect(calls.waText[0][1]).toContain(body.code)
    expect(calls.waText[0][1]).toContain('dashboard&tab=payments')
    expect(calls.waTemplate).toHaveLength(0)
    expect(calls.audit.map((a) => a[1])).toContain('PAYMENT_WAIVER_CODE_RESENT')
  })

  test('window closed: template sent, code still emailed, whatsapp reports template_pending', async () => {
    waivers = [waiverFixture()]
    conversation = { lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000) }
    const res = await PATCH(patch({ action: 'RESEND', paymentId: 'pay-1' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.whatsapp).toBe('template_pending')
    expect(body.emailStatus).toBe('SENT')
    expect(calls.waTemplate).toHaveLength(1)
    expect(calls.waTemplate[0][0]).toBe('970599123456')
    expect(calls.waText).toHaveLength(0)
    expect(waivers[0].status).toBe('CANCELLED')
    expect(waivers[1].status).toBe('ISSUED')
  })

  test('no conversation at all behaves like a closed window', async () => {
    waivers = [waiverFixture()]
    conversation = null
    const res = await PATCH(patch({ action: 'RESEND', paymentId: 'pay-1' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.whatsapp).toBe('template_pending')
    expect(calls.waTemplate).toHaveLength(1)
    expect(calls.waText).toHaveLength(0)
  })

  test('VERIFIED code: resend refused, old code untouched', async () => {
    waivers = [waiverFixture({ status: 'VERIFIED' })]
    conversation = { lastInboundAt: new Date() }
    const res = await PATCH(patch({ action: 'RESEND', paymentId: 'pay-1' }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(String(body.error)).toContain('بانتظار الاعتماد')
    expect(waivers).toHaveLength(1)
    expect(waivers[0].status).toBe('VERIFIED')
    expect(calls.waiverCreate).toHaveLength(0)
    expect(calls.waiverUpdateMany).toHaveLength(0)
    expect(calls.email).toHaveLength(0)
    expect(calls.waText).toHaveLength(0)
    expect(calls.waTemplate).toHaveLength(0)
  })

  test('no ISSUED code: resend refused, nothing created', async () => {
    waivers = [waiverFixture({ status: 'CANCELLED' })]
    const first = await PATCH(patch({ action: 'RESEND', paymentId: 'pay-1' }))
    const firstBody = await first.json()
    expect(first.status).toBe(400)
    expect(String(firstBody.error)).toContain('لا يوجد كود إعفاء نشط')
    waivers = []
    const second = await PATCH(patch({ action: 'RESEND', paymentId: 'pay-1' }))
    expect(second.status).toBe(400)
    expect(calls.waiverCreate).toHaveLength(0)
    expect(calls.email).toHaveLength(0)
  })

  test('no valid phone: resend still succeeds, whatsapp skipped', async () => {
    waivers = [waiverFixture()]
    paymentFixture.user.phone = ''
    paymentFixture.admission.phone = ''
    conversation = { lastInboundAt: new Date() }
    const res = await PATCH(patch({ action: 'RESEND', paymentId: 'pay-1' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.whatsapp).toBe('skipped')
    expect(body.emailStatus).toBe('SENT')
    expect(calls.waText).toHaveLength(0)
    expect(calls.waTemplate).toHaveLength(0)
    expect(waivers[1].status).toBe('ISSUED')
  })

  test('source pins: resend seam + mutually exclusive row buttons', () => {
    const route = readFileSync('src/app/api/admin/payments/waivers/route.ts', 'utf8')
    expect(route).toContain("action === 'RESEND'")
    expect(route).toContain('resendPaymentWaiverCode')
    const lib = readFileSync('src/lib/payment-waivers.ts', 'utf8')
    expect(lib).toContain('export async function resendPaymentWaiverCode')
    expect(lib).toContain('PAYMENT_WAIVER_CODE_RESENT')
    const ui = readFileSync('src/components/aact/AdminExtras.tsx', 'utf8')
    expect(ui).toContain('إعادة إرسال تحقق')
    expect(ui).toContain("body: JSON.stringify({ action: 'RESEND', paymentId: payment.id })")
    const rowStart = ui.indexOf('const activeWaiver = activeWaiverForPayment(p)')
    expect(rowStart).toBeGreaterThan(-1)
    const rowSlice = ui.slice(rowStart, rowStart + 4000)
    const verifiedAt = rowSlice.indexOf("activeWaiver?.status === 'VERIFIED'")
    const issuedAt = rowSlice.indexOf("activeWaiver?.status === 'ISSUED'")
    expect(verifiedAt).toBeGreaterThan(-1)
    expect(issuedAt).toBeGreaterThan(verifiedAt)
    expect(rowSlice.slice(verifiedAt, issuedAt)).toContain('اعتماد الإعفاء')
    expect(rowSlice.indexOf('إعادة إرسال تحقق')).toBeGreaterThan(issuedAt)
  })
})
