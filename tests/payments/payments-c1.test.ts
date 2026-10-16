/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

const calls: string[] = []
let proofStatus: 'PENDING' | 'ACCEPTED' | 'REJECTED' = 'PENDING'
let duplicateInstallmentInvoice: string | null = null

const proofPayment = {
  id: 'payment-1',
  invoiceNo: 'INV-1',
  method: 'BANK_TRANSFER',
  provider: 'BANK_TRANSFER',
  userId: 'student-1',
  amount: 100,
  description: 'رسوم دراسية',
  admission: null,
  enrollment: null,
}

const db: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(db),
  $queryRaw: async () => { calls.push('lock') },
  paymentProof: {
    findUnique: async ({ where }: any) => ({ id: where.id, status: proofStatus, payment: proofPayment, fileName: 'receipt.pdf' }),
    updateMany: async ({ where, data }: any) => {
      calls.push(`proof.updateMany:${where.status}:${data.status}`)
      if (proofStatus !== where.status) return { count: 0 }
      proofStatus = data.status
      return { count: 1 }
    },
  },
  payment: {
    findUnique: async () => ({
      ...proofPayment,
      status: 'UNPAID',
      admission: { programRef: null },
      enrollment: null,
      agent: null,
      proofs: [{ id: 'proof-1', status: 'PENDING' }],
    }),
    findMany: async () => [],
    findFirst: async () => duplicateInstallmentInvoice ? { invoiceNo: duplicateInstallmentInvoice } : null,
    create: async ({ data }: any) => ({ id: 'payment-new', ...data }),
  },
  admissionApplication: {
    findFirst: async () => ({ id: 'adm-1', userId: 'student-1', email: 'student@example.test', fullName: 'طالب', reference: 'ADM-1', program: 'برنامج', status: 'AWAITING_TUITION' }),
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireAdmin: async () => ({ id: 'admin-1', name: 'مدير', email: 'admin@example.test', role: 'ADMIN' }),
  requireUser: async () => ({ id: 'student-1', email: 'student@example.test', name: 'طالب', role: 'STUDENT' }),
}))
mock.module('@/lib/notify', () => ({
  notify: async (...args: any[]) => { calls.push(`notify:${args[0]}:${args[2]}:${args[3]}`) },
  audit: async (...args: any[]) => { calls.push(`audit:${args[1]}:${args[3]}`) },
}))
mock.module('@/lib/settle-payment', () => ({
  markInvoicePaid: async (invoiceNo: string, method: string) => {
    calls.push(`markInvoicePaid:${invoiceNo}:${method}`)
    return { ok: true, payment: { ...proofPayment, status: 'PAID', method }, receiptNo: 'RCT-1' }
  },
}))
mock.module('@/lib/settings', () => ({ nextInvoiceNo: async () => 'INV-NEW' }))
mock.module('@/lib/payment-waivers', () => ({ applyScholarshipToNewInvoiceData: async (_tx: any, data: any) => data }))
mock.module('@/lib/tuition-installments', () => ({
  roundMoney: (value: number) => Math.round((Number(value) || 0) * 100) / 100,
  getAdmissionTuitionPlan: async () => ({ applicationFeePaid: true, appealStatus: 'APPROVED', remainingTuition: 300, paidTuition: 100, approvedInitialAmount: null }),
}))

const proofReviewRoute = await import('../../src/app/api/admin/payments/proofs/[id]/route')
const adminPaymentsRoute = await import('../../src/app/api/admin/payments/route')
const installmentRoute = await import('../../src/app/api/payments/installment/route')
const { visiblePaymentMethods } = await import('../../src/components/aact/DashboardExtras')

async function json(res: Response) {
  return res.json() as Promise<any>
}

beforeEach(() => {
  calls.splice(0, calls.length)
  proofStatus = 'PENDING'
  duplicateInstallmentInvoice = null
})

describe('payments C1 safety', () => {
  test('pending manual proof cannot settle invoice through generic confirm endpoint', async () => {
    const res = await adminPaymentsRoute.PATCH(new NextRequest('https://academy.test/api/admin/payments', {
      method: 'PATCH',
      body: JSON.stringify({ id: 'payment-1' }),
      headers: { 'content-type': 'application/json' },
    }))
    const payload = await json(res as any)
    expect(res.status).toBe(409)
    expect(payload.error).toContain('إثبات الدفع بانتظار مراجعة')
    expect(calls.some((call) => call.startsWith('markInvoicePaid'))).toBe(false)
  })

  test('admin accepts or rejects manual proof explicitly, rejection requires reason and notifies student', async () => {
    const missingReason = await proofReviewRoute.PATCH(new NextRequest('https://academy.test/api/admin/payments/proofs/proof-1', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'REJECT', reason: '' }),
      headers: { 'content-type': 'application/json' },
    }), { params: { id: 'proof-1' } } as any)
    expect(missingReason.status).toBe(400)

    const rejected = await proofReviewRoute.PATCH(new NextRequest('https://academy.test/api/admin/payments/proofs/proof-1', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'REJECT', reason: 'الصورة غير واضحة' }),
      headers: { 'content-type': 'application/json' },
    }), { params: { id: 'proof-1' } } as any)
    expect(rejected.status).toBe(200)
    expect(calls).toContain('proof.updateMany:PENDING:REJECTED')
    expect(calls.some((call) => call.includes('notify:student-1:تم رفض إثبات الدفع') && call.includes('الصورة غير واضحة'))).toBe(true)
    expect(calls.some((call) => call.startsWith('markInvoicePaid'))).toBe(false)

    proofStatus = 'PENDING'
    const accepted = await proofReviewRoute.PATCH(new NextRequest('https://academy.test/api/admin/payments/proofs/proof-1', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'ACCEPT' }),
      headers: { 'content-type': 'application/json' },
    }), { params: { id: 'proof-1' } } as any)
    expect(accepted.status).toBe(200)
    expect(calls).toContain('proof.updateMany:PENDING:ACCEPTED')
    expect(calls).toContain('markInvoicePaid:INV-1:BANK_TRANSFER')
  })

  test('installment invoice creation is locked and returns conflict for duplicate pending installment', async () => {
    duplicateInstallmentInvoice = 'INV-PENDING'
    const res = await installmentRoute.POST(new NextRequest('https://academy.test/api/payments/installment', {
      method: 'POST',
      body: JSON.stringify({ admissionId: 'adm-1', amount: 100 }),
      headers: { 'content-type': 'application/json' },
    }))
    const payload = await json(res as any)
    expect(res.status).toBe(409)
    expect(calls).toContain('lock')
    expect(payload.error).toContain('INV-PENDING')
  })

  test('student payment selector hides Stripe and PayPal when keys are not configured', () => {
    const visible = visiblePaymentMethods([
      { id: 'STRIPE', label: 'Stripe', enabled: false, configured: false, kind: 'gateway' },
      { id: 'PAYPAL', label: 'PayPal', enabled: false, configured: false, kind: 'gateway' },
      { id: 'DIRECT_PAYMENT', label: 'دفع مباشر', enabled: true, configured: true, kind: 'manual' },
    ])
    expect(visible.map((m: any) => m.id)).toEqual(['DIRECT_PAYMENT'])
    const configured = visiblePaymentMethods([
      { id: 'STRIPE', label: 'Stripe', enabled: false, configured: true, kind: 'gateway' },
      { id: 'PAYPAL', label: 'PayPal', enabled: false, configured: true, kind: 'gateway' },
    ])
    expect(configured.map((m: any) => m.id)).toEqual(['STRIPE', 'PAYPAL'])
  })
})
