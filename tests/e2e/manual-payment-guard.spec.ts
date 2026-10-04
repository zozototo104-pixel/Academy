import { expect, test } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

function requiredAnyEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  throw new Error(`Missing required environment variable. Expected one of: ${names.join(', ')}`)
}

async function loginAsAdmin(request: any) {
  const email = requiredAnyEnv(['ADMIN_EMAIL', 'E2E_ADMIN_EMAIL'])
  const password = requiredAnyEnv(['ADMIN_PASSWORD', 'E2E_ADMIN_PASSWORD'])
  const response = await request.post('/api/auth/login', { data: { email, password } })
  const body = await response.json().catch(() => ({}))
  expect(response.ok(), `Admin login failed: ${response.status()} ${JSON.stringify(body).slice(0, 700)}`).toBeTruthy()
  expect(body?.token, 'Admin login response must include token').toBeTruthy()
  return String(body.token)
}

function stamp() {
  return `qa-manual-payment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

async function createPayment(prefix: string, method: string) {
  return prisma.payment.create({
    data: {
      invoiceNo: `AACT-INV-${prefix}`,
      purpose: 'OTHER',
      description: `QA manual payment guard ${prefix}`,
      amount: 7,
      amountCents: 700,
      currency: 'USD',
      method,
      provider: method,
      status: 'UNPAID',
      payerName: 'QA Manual Payment Guard',
      payerEmail: `${prefix}@aact.test`,
    },
  })
}

async function addProof(paymentId: string, status: 'PENDING' | 'ACCEPTED' | 'REJECTED', suffix: string) {
  return prisma.paymentProof.create({
    data: {
      paymentId,
      proofType: 'TRANSFER_RECEIPT',
      status,
      note: `QA proof ${status}`,
      adminNote: status === 'REJECTED' ? 'Rejected by guardrail fixture' : null,
      fileName: `qa-proof-${suffix}.txt`,
      mimeType: 'text/plain',
      fileSize: 32,
      checksum: `qa-${paymentId}-${status}-${suffix}`,
      storageProvider: 'QA_FIXTURE',
      storageKey: `qa/manual-payment-guard/${paymentId}/${suffix}.txt`,
      storageUrl: null,
      reviewedAt: status === 'REJECTED' ? new Date() : null,
    },
  })
}

async function cleanup(prefixes: string[]) {
  const invoiceNos = prefixes.map((prefix) => `AACT-INV-${prefix}`)
  const payments = await prisma.payment.findMany({ where: { invoiceNo: { in: invoiceNos } }, select: { id: true } }).catch(() => [])
  const paymentIds = payments.map((payment) => payment.id)
  if (paymentIds.length) {
    await prisma.auditLog.deleteMany({ where: { entity: 'Payment', entityId: { in: paymentIds } } }).catch(() => {})
  }
  await prisma.payment.deleteMany({ where: { invoiceNo: { in: invoiceNos } } }).catch(() => {})
}

test.describe('Manual payment approval guardrails', () => {
  test.setTimeout(70_000)

  const prefixes: string[] = []

  test.afterEach(async () => {
    await cleanup(prefixes)
    prefixes.length = 0
  })

  test.afterAll(async () => {
    await prisma.$disconnect()
  })

  test('admin cannot approve unsafe manual payments and can approve a documented direct payment', async ({ request }) => {
    if (process.env.E2E_QA_ONLY !== '1') {
      throw new Error('Manual payment guardrail test must run only in QA E2E mode.')
    }

    const token = await loginAsAdmin(request)
    const headers = { Authorization: `Bearer ${token}` }

    const directNoNotePrefix = stamp()
    prefixes.push(directNoNotePrefix)
    const directNoNote = await createPayment(directNoNotePrefix, 'DIRECT_PAYMENT')
    await addProof(directNoNote.id, 'PENDING', 'pending')

    const directNoNoteRes = await request.patch('/api/admin/payments', {
      headers,
      data: { id: directNoNote.id },
    })
    const directNoNoteBody = await directNoNoteRes.json().catch(() => ({}))
    expect(directNoNoteRes.status(), `DIRECT_PAYMENT without admin note must be rejected: ${JSON.stringify(directNoNoteBody)}`).toBe(400)
    expect(String(directNoNoteBody?.error || '')).toContain('ملاحظة')

    const rejectedOnlyPrefix = stamp()
    prefixes.push(rejectedOnlyPrefix)
    const rejectedOnly = await createPayment(rejectedOnlyPrefix, 'BANK_TRANSFER')
    await addProof(rejectedOnly.id, 'REJECTED', 'rejected')

    const rejectedOnlyRes = await request.patch('/api/admin/payments', {
      headers,
      data: { id: rejectedOnly.id },
    })
    const rejectedOnlyBody = await rejectedOnlyRes.json().catch(() => ({}))
    expect(rejectedOnlyRes.status(), `Rejected-only proof payment must be rejected: ${JSON.stringify(rejectedOnlyBody)}`).toBe(400)
    expect(String(rejectedOnlyBody?.error || '')).toContain('مرفوضة')

    const happyPrefix = stamp()
    prefixes.push(happyPrefix)
    const happyPayment = await createPayment(happyPrefix, 'DIRECT_PAYMENT')
    await addProof(happyPayment.id, 'PENDING', 'pending')

    const happyRes = await request.patch('/api/admin/payments', {
      headers,
      data: {
        id: happyPayment.id,
        approvalNote: 'تم التحقق من التحويل في بيئة QA',
      },
    })
    const happyBody = await happyRes.json().catch(() => ({}))
    expect(happyRes.ok(), `Documented DIRECT_PAYMENT with reviewable proof must be accepted: ${happyRes.status()} ${JSON.stringify(happyBody)}`).toBeTruthy()
    expect(happyBody?.ok).toBe(true)
    expect(happyBody?.receiptNo, 'Successful manual approval must return a receipt number').toBeTruthy()

    const paid = await prisma.payment.findUnique({ where: { id: happyPayment.id }, select: { status: true, manualApprovalNote: true, receiptNo: true } })
    expect(paid?.status).toBe('PAID')
    expect(paid?.manualApprovalNote).toContain('بيئة QA')
    expect(paid?.receiptNo).toBeTruthy()
  })
})
