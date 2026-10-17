/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type RecordMap = Map<string, Record<string, any>>

const payments: RecordMap = new Map()
const admissions: RecordMap = new Map()
const users: RecordMap = new Map()
const enrollments: RecordMap = new Map()
const waiverCodes: Record<string, any>[] = []
const waiverAttempts: Record<string, any>[] = []
const notifications: Record<string, any>[] = []
const audits: Record<string, any>[] = []
const receiptEmails: Record<string, any>[] = []
const finalRegistrationEmails: Record<string, any>[] = []
let admissionFindUniqueCalls = 0
let receiptSequence = 0
let tuitionPlan: Record<string, any> | null = null

function cloneMap(map: RecordMap): RecordMap {
  return new Map([...map.entries()].map(([key, value]) => [key, { ...value }]))
}

function replaceMap(target: RecordMap, next: RecordMap) {
  target.clear()
  for (const [key, value] of next.entries()) target.set(key, { ...value })
}

function cloneArray(items: Record<string, any>[]) {
  return items.map((item) => ({ ...item }))
}

function paymentMatches(payment: Record<string, any>, where: Record<string, any>) {
  if (where.id && payment.id !== where.id) return false
  if (where.invoiceNo && payment.invoiceNo !== where.invoiceNo) return false
  if (where.admissionId && payment.admissionId !== where.admissionId) return false
  if (typeof where.status === 'string' && payment.status !== where.status) return false
  if (where.status?.not && payment.status === where.status.not) return false
  if (where.status?.notIn && where.status.notIn.includes(payment.status)) return false
  if (where.purpose?.in && !where.purpose.in.includes(payment.purpose)) return false
  if (where.OR) {
    return where.OR.some((clause: Record<string, any>) => {
      if ('userId' in clause) return payment.userId === clause.userId
      if (clause.NOT && 'userId' in clause.NOT) return payment.userId !== clause.NOT.userId
      return false
    })
  }
  return true
}

const db: any = {
  $queryRaw: async () => [],
  $transaction: async (work: (tx: any) => Promise<any>) => {
    const snapshot = {
      payments: cloneMap(payments),
      admissions: cloneMap(admissions),
      users: cloneMap(users),
      enrollments: cloneMap(enrollments),
      waiverCodes: cloneArray(waiverCodes),
      waiverAttempts: cloneArray(waiverAttempts),
    }
    try {
      return await work(db)
    } catch (error) {
      replaceMap(payments, snapshot.payments)
      replaceMap(admissions, snapshot.admissions)
      replaceMap(users, snapshot.users)
      replaceMap(enrollments, snapshot.enrollments)
      waiverCodes.splice(0, waiverCodes.length, ...snapshot.waiverCodes)
      waiverAttempts.splice(0, waiverAttempts.length, ...snapshot.waiverAttempts)
      throw error
    }
  },
  payment: {
    findUnique: async ({ where }: { where: Record<string, any> }) => {
      const payment = where.id
        ? payments.get(where.id)
        : [...payments.values()].find((item) => item.invoiceNo === where.invoiceNo)
      return payment ? { ...payment } : null
    },
    findFirst: async ({ where }: { where: Record<string, any> }) => {
      const payment = [...payments.values()].find((item) => paymentMatches(item, where))
      return payment ? { ...payment } : null
    },
    findMany: async ({ where }: { where: Record<string, any> }) =>
      [...payments.values()].filter((item) => paymentMatches(item, where)).map((item) => ({ ...item })),
    updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      let count = 0
      for (const payment of payments.values()) {
        if (!paymentMatches(payment, where)) continue
        Object.assign(payment, data)
        count++
      }
      return { count }
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
      const payment = payments.get(where.id)
      if (!payment) throw new Error('PAYMENT_NOT_FOUND')
      Object.assign(payment, data)
      return { ...payment }
    },
    create: async ({ data }: { data: Record<string, any> }) => {
      const payment = { ...data, id: data.id || `payment-${payments.size + 1}` }
      payments.set(payment.id, payment)
      return { ...payment }
    },
  },
  paymentWaiverCode: {
    findFirst: async ({ where }: { where: Record<string, any> }) =>
      waiverCodes.find((item) => item.paymentId === where.paymentId && item.codeHash === where.codeHash) || null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
      const waiver = waiverCodes.find((item) => item.id === where.id)
      if (!waiver) throw new Error('WAIVER_NOT_FOUND')
      Object.assign(waiver, data)
      return { ...waiver }
    },
    updateMany: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      let count = 0
      for (const waiver of waiverCodes) {
        if (where.id && waiver.id !== where.id) continue
        if (where.status && waiver.status !== where.status) continue
        Object.assign(waiver, data)
        count++
      }
      return { count }
    },
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const waiver = waiverCodes.find((item) => item.id === where.id)
      if (!waiver) throw new Error('WAIVER_NOT_FOUND')
      return { ...waiver }
    },
  },
  paymentWaiverAttempt: {
    count: async ({ where }: { where: Record<string, any> }) => waiverAttempts.filter((attempt) => {
      if (attempt.paymentId !== where.paymentId) return false
      if (attempt.userId !== where.userId) return false
      if (attempt.success !== where.success) return false
      if (where.createdAt?.gte && attempt.createdAt < where.createdAt.gte) return false
      return true
    }).length,
    create: async ({ data }: { data: Record<string, any> }) => {
      const attempt = { ...data, id: `attempt-${waiverAttempts.length + 1}`, createdAt: data.createdAt || new Date() }
      waiverAttempts.push(attempt)
      return { ...attempt }
    },
  },
  admissionApplication: {
    findUnique: async ({ where }: { where: { id: string } }) => {
      admissionFindUniqueCalls++
      const app = admissions.get(where.id)
      return app ? { ...app } : null
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
      const app = admissions.get(where.id)
      if (!app) throw new Error('ADMISSION_NOT_FOUND')
      Object.assign(app, data)
      return { ...app }
    },
  },
  user: {
    findUnique: async ({ where }: { where: Record<string, any> }) => {
      const user = where.id
        ? users.get(where.id)
        : [...users.values()].find((item) => item.email === where.email)
      return user ? { ...user } : null
    },
    findMany: async ({ where }: { where: Record<string, any> }) =>
      [...users.values()].filter((user) => !where.role || user.role === where.role).map((user) => ({ id: user.id })),
  },
  enrollment: {
    findUnique: async ({ where }: { where: Record<string, any> }) => {
      if (where.id) return enrollments.get(where.id) || null
      const key = `${where.userId_programId.userId}:${where.userId_programId.programId}`
      return enrollments.get(key) || null
    },
    create: async ({ data }: { data: Record<string, any> }) => {
      const enrollment = { ...data, id: `enrollment-${enrollments.size + 1}` }
      enrollments.set(`${data.userId}:${data.programId}`, enrollment)
      return { ...enrollment }
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, any> }) => {
      const entry = [...enrollments.entries()].find(([, value]) => value.id === where.id)
      if (!entry) throw new Error('ENROLLMENT_NOT_FOUND')
      Object.assign(entry[1], data)
      return { ...entry[1] }
    },
  },
  aiLiveCredit: { findFirst: async () => null },
  agentApplication: { findUnique: async () => null },
  auditLog: { create: async ({ data }: { data: Record<string, any> }) => ({ id: `audit-${audits.length + 1}`, ...data }) },
  notification: { create: async ({ data }: { data: Record<string, any> }) => ({ id: `notification-${notifications.length + 1}`, ...data }) },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/notify', () => ({
  notify: async (userId: string | null | undefined, type: string, title: string, body: string, link?: string) => {
    if (!userId) return
    notifications.push({ userId, type, title, body, link })
  },
  audit: async (actor: any, action: string, entity: string, entityId?: string | null, details?: string) => {
    audits.push({ actor, action, entity, entityId, details })
  },
}))
const realSettings = await import('../../src/lib/settings')
mock.module('@/lib/settings', () => ({
  ...realSettings,
  getSettings: async () => ({ THESIS_MAX_MONTHS: '6' }),
  nextInvoiceNo: async () => `INV-${payments.size + 1}`,
  nextReceiptNo: async () => `RCPT-${++receiptSequence}`,
}))

const realMailer = await import('../../src/lib/mailer')
mock.module('@/lib/mailer', () => ({
  ...realMailer,
  emailPaymentReceipt: async (email: string, name: string, invoiceNo: string, description: string, amount: number, receiptNo: string) => {
    receiptEmails.push({ email, name, invoiceNo, description, amount, receiptNo })
    return true
  },
  emailFinalRegistration: async (email: string, name: string, program: string) => {
    finalRegistrationEmails.push({ email, name, program })
    return true
  },
  emailPaymentWaiverCode: async () => true,
  isEmailDeliveryConfigured: async () => false,
}))

const realTuitionInstallments = await import('../../src/lib/tuition-installments')
mock.module('@/lib/tuition-installments', () => ({
  ...realTuitionInstallments,
  getAdmissionTuitionPlan: async () => tuitionPlan,
}))
mock.module('@/lib/live-usage-guard', () => ({ grantGeminiLiveCredit: async () => {} }))

const { verifyPaymentWaiverCode } = await import('../../src/lib/payment-waivers')
const { markInvoicePaid } = await import('../../src/lib/settle-payment')

beforeEach(() => {
  payments.clear()
  admissions.clear()
  users.clear()
  enrollments.clear()
  waiverCodes.splice(0, waiverCodes.length)
  waiverAttempts.splice(0, waiverAttempts.length)
  notifications.splice(0, notifications.length)
  audits.splice(0, audits.length)
  receiptEmails.splice(0, receiptEmails.length)
  finalRegistrationEmails.splice(0, finalRegistrationEmails.length)
  admissionFindUniqueCalls = 0
  receiptSequence = 0
  tuitionPlan = null
})

describe('payment waiver verification attempts', () => {
  test('failed attempts survive transaction rollback and the sixth invalid code is rate-limited without a new attempt', async () => {
    payments.set('payment-1', {
      id: 'payment-1',
      invoiceNo: 'INV-WAIVER-1',
      userId: 'student-1',
      status: 'UNPAID',
      purpose: 'TUITION',
      amount: 100,
      amountCents: 10_000,
    })

    for (let index = 0; index < 5; index++) {
      await expect(verifyPaymentWaiverCode({
        paymentId: 'payment-1',
        code: `wrong-${index}`,
        user: { id: 'student-1', email: 'student@example.test', name: 'Student' },
      })).rejects.toThrow('كود الإعفاء غير صحيح')
    }

    expect(waiverAttempts).toHaveLength(5)
    expect(waiverAttempts.every((attempt) => attempt.success === false)).toBe(true)

    try {
      await verifyPaymentWaiverCode({
        paymentId: 'payment-1',
        code: 'wrong-sixth',
        user: { id: 'student-1', email: 'student@example.test', name: 'Student' },
      })
      throw new Error('Expected sixth invalid waiver attempt to be rate-limited')
    } catch (error: any) {
      expect(error.status).toBe(429)
      expect(error.code).toBe('WAIVER_CODE_RATE_LIMITED')
    }

    expect(waiverAttempts).toHaveLength(5)
  })
})

describe('invoice settlement admission finalization', () => {
  test('waived invoice cannot be converted to paid settlement', async () => {
    payments.set('payment-waived', {
      id: 'payment-waived',
      invoiceNo: 'INV-WAIVED-1',
      admissionId: 'admission-1',
      userId: 'student-1',
      status: 'WAIVED',
      purpose: 'TUITION',
      description: 'رسوم دراسية معفاة',
      amount: 100,
      amountCents: 10_000,
    })

    const result = await markInvoicePaid('INV-WAIVED-1', 'BANK_TRANSFER', { actor: { id: 'admin-1', name: 'Admin' } })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('فاتورة معفاة')
    expect(payments.get('payment-waived')?.status).toBe('WAIVED')
    expect(receiptEmails).toHaveLength(0)
    expect(notifications).toHaveLength(0)
  })

  test('normal admission payment finalizes once and emits one payment notification', async () => {
    users.set('student-1', { id: 'student-1', email: 'student@example.test', name: 'Student', role: 'STUDENT' })
    admissions.set('admission-1', {
      id: 'admission-1',
      userId: 'student-1',
      email: 'student@example.test',
      fullName: 'Student One',
      country: 'PS',
      reference: 'APP-1',
      program: 'برنامج اختبار',
      programId: 'program-1',
      status: 'UNDER_REVIEW',
      supervisorId: null,
    })
    payments.set('payment-1', {
      id: 'payment-1',
      invoiceNo: 'INV-PAY-1',
      admissionId: 'admission-1',
      userId: 'student-1',
      status: 'UNPAID',
      purpose: 'APPLICATION_FEE',
      description: 'رسوم تقديم',
      amount: 30,
      amountCents: 3_000,
      payerName: 'Student One',
      payerEmail: 'student@example.test',
    })

    const result = await markInvoicePaid('INV-PAY-1', 'CARD', { actor: { id: 'admin-1', name: 'Admin' } })

    expect(result.ok).toBe(true)
    expect(result.receiptNo).toBe('RCPT-1')
    expect(admissionFindUniqueCalls).toBe(1)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      userId: 'student-1',
      type: 'PAYMENT',
      title: 'تم استلام دفعتك بنجاح',
    })
    expect(receiptEmails).toHaveLength(1)
    expect(admissions.get('admission-1')?.status).toBe('UNDER_REVIEW')
    expect(payments.get('payment-1')?.status).toBe('PAID')
  })
})
