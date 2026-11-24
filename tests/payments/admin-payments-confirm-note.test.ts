/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

const calls: string[] = []

// Fixture: a no-proof direct payment, Haris's invoice-0065 situation.
let fixtureMethod = 'DIRECT_PAYMENT'
let fixtureProofs: any[] = []
let fixtureStatus = 'UNPAID'
let fixtureCryptoTxHash: string | null = null
let fixtureCryptoStatus: string | null = null

const fixturePayment = () => ({
  id: 'payment-1',
  invoiceNo: 'AACT-INV-2026-0065',
  method: fixtureMethod,
  provider: fixtureMethod,
  userId: 'student-1',
  amount: 88,
  description: 'دفعة جزئية من الرسوم الدراسية',
  status: fixtureStatus,
  cryptoTxHash: fixtureCryptoTxHash,
  cryptoVerificationStatus: fixtureCryptoStatus,
  manualApprovalReference: null,
  manualApprovalNote: null,
  admission: null,
  enrollment: null,
  agent: null,
  proofs: fixtureProofs,
})

const db: any = {
  payment: {
    findUnique: async () => fixturePayment(),
    update: async ({ data }: any) => {
      calls.push(`payment.update:ref=${data.manualApprovalReference || ''}:note=${data.manualApprovalNote || ''}`)
      return { ...fixturePayment(), ...data }
    },
  },
}

mock.module('@/lib/db', () => ({ db }))

const realAuth = await import('../../src/lib/auth')
mock.module('@/lib/auth', () => ({
  ...realAuth,
  requireAdmin: async () => ({ id: 'admin-1', name: 'مدير', email: 'admin@example.test', role: 'ADMIN' }),
}))

const realNotify = await import('../../src/lib/notify')
mock.module('@/lib/notify', () => ({
  ...realNotify,
  notify: async () => {},
  audit: async (...args: any[]) => { calls.push(`audit:${args[1]}`) },
}))

const realSettlePayment = await import('../../src/lib/settle-payment')
mock.module('@/lib/settle-payment', () => ({
  ...realSettlePayment,
  markInvoicePaid: async (invoiceNo: string, method: string) => {
    calls.push(`markInvoicePaid:${invoiceNo}:${method}`)
    return { ok: true, payment: { ...fixturePayment(), status: 'PAID', method }, receiptNo: 'RCT-1' }
  },
}))

const realSettings = await import('../../src/lib/settings')
mock.module('@/lib/settings', () => ({
  ...realSettings,
  getSettings: async () => ({}),
}))

const adminPaymentsRoute = await import('../../src/app/api/admin/payments/route')

async function patch(body: any) {
  const res = await adminPaymentsRoute.PATCH(new NextRequest('https://academy.test/api/admin/payments', {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }))
  return { status: res.status, payload: await (res as any).json() }
}

beforeEach(() => {
  calls.splice(0, calls.length)
  fixtureMethod = 'DIRECT_PAYMENT'
  fixtureProofs = []
  fixtureStatus = 'UNPAID'
  fixtureCryptoTxHash = null
  fixtureCryptoStatus = null
})

const NOTE = 'استلمت المبلغ نقداً من الطالب'

describe('admin payment confirm accepts a written note', () => {
  test('no-proof direct payment with note sent as note + reference is accepted', async () => {
    const { status, payload } = await patch({ id: 'payment-1', approvalNote: NOTE, approvalReference: NOTE })
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(payload.receiptNo).toBe('RCT-1')
    expect(calls.some((call) => call.startsWith('markInvoicePaid:AACT-INV-2026-0065:DIRECT_PAYMENT'))).toBe(true)
    expect(calls.some((call) => call.includes(`note=${NOTE}`))).toBe(true)
  })

  test('note alone (no reference) is still rejected: the server rule is unchanged', async () => {
    const { status, payload } = await patch({ id: 'payment-1', approvalNote: NOTE })
    expect(status).toBe(400)
    expect(String(payload.error || '')).toContain('أرفق إثبات')
    expect(calls.some((call) => call.startsWith('markInvoicePaid'))).toBe(false)
  })

  test('short note is still rejected by the direct-payment note rule', async () => {
    const { status, payload } = await patch({ id: 'payment-1', approvalNote: 'تم', approvalReference: 'تم' })
    expect(status).toBe(400)
    expect(String(payload.error || '')).toContain('ملاحظة')
    expect(calls.some((call) => call.startsWith('markInvoicePaid'))).toBe(false)
  })

  test('no-proof bank transfer with note + reference is accepted', async () => {
    fixtureMethod = 'BANK_TRANSFER'
    const { status, payload } = await patch({ id: 'payment-1', approvalNote: NOTE, approvalReference: NOTE })
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
  })

  test('pending proof still blocks the generic confirm endpoint', async () => {
    fixtureProofs = [{ id: 'proof-1', status: 'PENDING' }]
    const { status, payload } = await patch({ id: 'payment-1', approvalNote: NOTE, approvalReference: NOTE })
    expect(status).toBe(409)
    expect(String(payload.error || '')).toContain('إثبات الدفع بانتظار مراجعة')
    expect(calls.some((call) => call.startsWith('markInvoicePaid'))).toBe(false)
  })

  test('rejected-only proof with note + reference is accepted', async () => {
    fixtureProofs = [{ id: 'proof-1', status: 'REJECTED' }]
    const { status, payload } = await patch({ id: 'payment-1', approvalNote: NOTE, approvalReference: NOTE })
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(calls.some((call) => call.startsWith('markInvoicePaid:AACT-INV-2026-0065:DIRECT_PAYMENT'))).toBe(true)
  })

  test('direct payment with accepted proof but no saved note still needs the note', async () => {
    fixtureProofs = [{ id: 'proof-1', status: 'ACCEPTED' }]
    const { status, payload } = await patch({ id: 'payment-1' })
    expect(status).toBe(400)
    expect(String(payload.error || '')).toContain('ملاحظة')
    expect(calls.some((call) => call.startsWith('markInvoicePaid'))).toBe(false)
  })

  test('USDT note-only keeps the verified TX hash as the reference', async () => {
    fixtureMethod = 'USDT'
    fixtureCryptoTxHash = '0xabc123def456'
    fixtureCryptoStatus = 'VERIFIED'
    const { status, payload } = await patch({ id: 'payment-1', approvalNote: NOTE })
    expect(status).toBe(200)
    expect(payload.ok).toBe(true)
    expect(calls.some((call) => call === `payment.update:ref=0xabc123def456:note=${NOTE}`)).toBe(true)
  })
})
