/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

type RecordMap = Map<string, Record<string, any>>

const payments: RecordMap = new Map()
const admissions: RecordMap = new Map()
const users: RecordMap = new Map()
const enrollments: RecordMap = new Map()
const rulesSnapshots: RecordMap = new Map()
const semesterStates: RecordMap = new Map()
let snapshotWriteFails = false
const waiverCodes: Record<string, any>[] = []
const waiverAttempts: Record<string, any>[] = []
const notifications: Record<string, any>[] = []
const audits: Record<string, any>[] = []
const receiptEmails: Record<string, any>[] = []
const finalRegistrationEmails: Record<string, any>[] = []
let admissionFindUniqueCalls = 0
let receiptSequence = 0
let tuitionPlan: Record<string, any> | null = null
const agentApplications: RecordMap = new Map()
const certificates: Record<string, any>[] = []
const examAttempts: Record<string, any>[] = []
let certPhantomSerial: string | null = null
let tuitionInvoiceCollisionOnce = false
let transactionCalls = 0

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
  if (typeof where.purpose === 'string' && payment.purpose !== where.purpose) return false
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
    transactionCalls++
    const snapshot = {
      payments: cloneMap(payments),
      admissions: cloneMap(admissions),
      users: cloneMap(users),
      enrollments: cloneMap(enrollments),
      waiverCodes: cloneArray(waiverCodes),
      waiverAttempts: cloneArray(waiverAttempts),
    }
    try {
      // Prisma's interactive transaction client is distinct from the root
      // client; this distinction catches forbidden in-transaction P2002 retry.
      return await work({ ...db })
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
    findUniqueOrThrow: async ({ where }: { where: Record<string, any> }) => {
      const payment = where.id
        ? payments.get(where.id)
        : [...payments.values()].find((item) => item.invoiceNo === where.invoiceNo)
      if (!payment) throw new Error('PAYMENT_NOT_FOUND')
      return { ...payment }
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
    findUnique: async ({ where, include }: { where: Record<string, any>; include?: Record<string, any> }) => {
      const waiver = waiverCodes.find((item) => item.id === where.id)
      if (!waiver) return null
      const result: Record<string, any> = { ...waiver }
      if (include?.payment) {
        const payment = payments.get(waiver.paymentId)
        result.payment = payment ? { ...payment } : null
      }
      return result
    },
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
      const enrollment = { ...data, id: `enrollment-${enrollments.size + 1}`, createdAt: new Date(), extensionDays: 0 }
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
  program: {
    findUnique: async () => ({ id: 'program-1', category: 'DIPLOMA', admissionRules: null, semestersCount: 2, maxStudyDays: 90 }),
  },
  unit: {
    findMany: async () => [
      { id: 'unit-1', semester: 1, order: 1 },
      { id: 'unit-2', semester: 2, order: 2 },
    ],
  },
  enrollmentRulesSnapshot: {
    findUnique: async ({ where }: any) => rulesSnapshots.get(where.enrollmentId) || null,
    create: async ({ data }: any) => {
      if (snapshotWriteFails) throw new Error('snapshot database unavailable')
      const row = { id: `snapshot-${rulesSnapshots.size + 1}`, ...data, capturedAt: new Date() }
      rulesSnapshots.set(data.enrollmentId, row)
      return row
    },
  },
  enrollmentSemesterState: {
    findUnique: async ({ where }: any) => {
      const w = where.enrollmentId_semester
      return semesterStates.get(`${w.enrollmentId}:${w.semester}`) || null
    },
    create: async ({ data }: any) => {
      const key = `${data.enrollmentId}:${data.semester}`
      const row = { ...data, id: `state-${semesterStates.size + 1}` }
      semesterStates.set(key, row)
      return row
    },
    count: async ({ where }: any) => [...semesterStates.values()].filter((row) => row.enrollmentId === where.enrollmentId).length,
    findFirst: async ({ where }: any) => {
      const row = [...semesterStates.values()].find((item) => {
        if (item.enrollmentId !== where.enrollmentId) return false
        if (!where.OR) return true
        return where.OR.some((clause: any) => {
          if ('status' in clause) return item.status === clause.status
          if (clause.result?.not === null) return item.result != null
          if (clause.approvedScore?.not === null) return item.approvedScore != null
          return false
        })
      })
      return row || null
    },
  },
  aiLiveCredit: { findFirst: async () => null },
  agentApplication: {
    findUnique: async ({ where }: { where: Record<string, any> }) => {
      const agent = agentApplications.get(where.id)
      return agent ? { ...agent } : null
    },
  },
  certificate: {
    count: async () => certificates.length,
    create: async ({ data }: { data: Record<string, any> }) => {
      // محاكاة فائز متزامن: أول إنشاء بالرقم المشطوب يزرع شهادة «المنافس»
      // بالرقم نفسه (فيرتفع العدّ) ثم يرمي P2002 كما تفعل قاعدة البيانات.
      if (certPhantomSerial && data.serial === certPhantomSerial) {
        certificates.push({ id: `cert-phantom-${certificates.length + 1}`, ...data })
        certPhantomSerial = null
        const error: any = new Error('Unique constraint failed on the fields: (`serial`)')
        error.code = 'P2002'
        throw error
      }
      if (certificates.some((item) => item.serial === data.serial)) {
        const error: any = new Error('Unique constraint failed on the fields: (`serial`)')
        error.code = 'P2002'
        throw error
      }
      const row = { id: `cert-${certificates.length + 1}`, ...data }
      certificates.push(row)
      return { ...row }
    },
  },
  examAttempt: {
    count: async ({ where }: { where: Record<string, any> }) => examAttempts.filter((item) => item.userId === where.userId).length,
  },
  programExamAttempt: { count: async () => 0 },
  graduationRequest: { findUnique: async () => null },
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

mock.module('@/lib/auth', () => ({
  requireAdmin: async () => ({ id: 'admin-1', name: 'Admin', email: 'admin@example.test' }),
}))

const { verifyPaymentWaiverCode, approvePaymentWaiver } = await import('../../src/lib/payment-waivers')
const { markInvoicePaid, finalizeAdmissionAfterSettlement } = await import('../../src/lib/settle-payment')
const { PATCH: waiversRoutePATCH } = await import('../../src/app/api/admin/payments/waivers/route')
const { PATCH: paymentsRoutePATCH } = await import('../../src/app/api/admin/payments/route')
const { hasLifecycleFootprint, progressionGate } = await import('../../src/lib/progression')

beforeEach(() => {
  payments.clear()
  admissions.clear()
  users.clear()
  enrollments.clear()
  rulesSnapshots.clear()
  semesterStates.clear()
  snapshotWriteFails = false
  waiverCodes.splice(0, waiverCodes.length)
  waiverAttempts.splice(0, waiverAttempts.length)
  notifications.splice(0, notifications.length)
  audits.splice(0, audits.length)
  receiptEmails.splice(0, receiptEmails.length)
  finalRegistrationEmails.splice(0, finalRegistrationEmails.length)
  admissionFindUniqueCalls = 0
  receiptSequence = 0
  tuitionPlan = null
  agentApplications.clear()
  certificates.splice(0, certificates.length)
  examAttempts.splice(0, examAttempts.length)
  certPhantomSerial = null
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

function seedAcademicAdmission(tuitionStatus: 'UNPAID' | 'WAIVED') {
  users.set('student-1', { id: 'student-1', email: 'student@example.test', name: 'Student', role: 'STUDENT' })
  admissions.set('admission-1', {
    id: 'admission-1', userId: 'student-1', email: 'student@example.test',
    fullName: 'Student', country: 'PS', reference: 'APP-STUDY',
    program: 'دبلوم تجريبي', programId: 'program-1', status: 'AWAITING_TUITION', supervisorId: null,
  })
  payments.set('fee', {
    id: 'fee', invoiceNo: 'INV-APPLICATION', admissionId: 'admission-1',
    userId: 'student-1', status: 'PAID', purpose: 'APPLICATION_FEE',
    description: 'رسوم تقديم', amount: 30, amountCents: 3_000,
  })
  payments.set('tuition', {
    id: 'tuition', invoiceNo: 'INV-TUITION', admissionId: 'admission-1',
    userId: 'student-1', status: tuitionStatus, purpose: 'TUITION',
    description: 'رسوم الدراسة', amount: 350, amountCents: 35_000,
    payerName: 'Student', payerEmail: 'student@example.test',
  })
}

describe('new academic enrollment lifecycle', () => {
  test('full tuition settlement stores ENROLLMENT snapshot and both semester states', async () => {
    seedAcademicAdmission('UNPAID')
    const paid = await markInvoicePaid('INV-TUITION', 'CARD', { actor: { id: 'admin-1', name: 'Admin' } })
    expect(paid.ok).toBe(true)
    const enrollment = enrollments.get('student-1:program-1')
    expect(enrollment?.status).toBe('ACTIVE')
    expect(rulesSnapshots.get(enrollment!.id)?.basis).toBe('ENROLLMENT')
    expect(semesterStates.has(`${enrollment!.id}:1`)).toBe(true)
    expect(semesterStates.has(`${enrollment!.id}:2`)).toBe(true)
    expect(await hasLifecycleFootprint(db, enrollment!.id)).toBe(true)
    const gate = await progressionGate(db, {
      id: enrollment!.id, userId: 'student-1', programId: 'program-1',
    }, 2, 'DIPLOMA')
    expect(gate.open).toBe(false)
    expect(gate.reasons.join(' ')).toContain('غير معتمدة')
  })

  test('approved installment activation stores the same frozen lifecycle', async () => {
    seedAcademicAdmission('UNPAID')
    payments.set('installment', {
      id: 'installment', invoiceNo: 'INV-INSTALLMENT', admissionId: 'admission-1',
      userId: 'student-1', status: 'UNPAID', purpose: 'TUITION_INSTALLMENT',
      description: 'الدفعة الأولى', amount: 100, amountCents: 10_000,
      payerName: 'Student', payerEmail: 'student@example.test',
    })
    tuitionPlan = { appealStatus: 'APPROVED', approvedInitialAmount: 100, paidTuition: 100 }
    const paid = await markInvoicePaid('INV-INSTALLMENT', 'CARD', { actor: { id: 'admin-1', name: 'Admin' } })
    expect(paid.ok).toBe(true)
    const enrollment = enrollments.get('student-1:program-1')
    expect(rulesSnapshots.get(enrollment!.id)?.basis).toBe('ENROLLMENT')
    expect(semesterStates.has(`${enrollment!.id}:2`)).toBe(true)
  })

  test('tuition waiver activates the student with enrollment provenance and semester states', async () => {
    seedAcademicAdmission('WAIVED')
    await finalizeAdmissionAfterSettlement(db, 'admission-1', { source: 'WAIVER' })
    const enrollment = enrollments.get('student-1:program-1')
    expect(enrollment?.status).toBe('ACTIVE')
    expect(rulesSnapshots.get(enrollment!.id)?.basis).toBe('ENROLLMENT')
    expect(semesterStates.has(`${enrollment!.id}:1`)).toBe(true)
    expect(semesterStates.has(`${enrollment!.id}:2`)).toBe(true)
  })

  test('failed snapshot creation does not finalize admission; retry completes without duplicate enrollment', async () => {
    seedAcademicAdmission('UNPAID')
    snapshotWriteFails = true
    await expect(markInvoicePaid('INV-TUITION', 'CARD', { actor: { name: 'Admin' } }))
      .rejects.toThrow('ENROLLMENT_RULES_SNAPSHOT_REQUIRED')
    expect(admissions.get('admission-1')?.status).toBe('AWAITING_TUITION')
    expect(rulesSnapshots.size).toBe(0)
    expect(enrollments.size).toBe(1)
    snapshotWriteFails = false
    const resumed = await markInvoicePaid('INV-TUITION', 'CARD', { actor: { name: 'Admin' } })
    expect(resumed.ok).toBe(true)
    expect(enrollments.size).toBe(1)
    const enrollment = enrollments.get('student-1:program-1')
    expect(rulesSnapshots.get(enrollment!.id)?.basis).toBe('ENROLLMENT')
    expect(admissions.get('admission-1')?.status).toBe('SUPERVISOR_ASSIGNED')
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

function patchRequest(url: string, body: Record<string, any>) {
  return new NextRequest(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function seedWaiverAdmission() {
  users.set('student-1', { id: 'student-1', email: 'student@example.test', name: 'Student', role: 'STUDENT' })
  admissions.set('admission-1', {
    id: 'admission-1', userId: 'student-1', email: 'student@example.test',
    fullName: 'Student', country: 'PS', reference: 'APP-WAIVER',
    program: 'دبلوم تجريبي', programId: 'program-1', status: 'AWAITING_TUITION',
    supervisorId: null, approvedAt: new Date(), scholarshipFull: false,
  })
}

describe('waiver approval atomicity and expiry (audit fixes 1 + 4)', () => {
  test('expired VERIFIED code cannot be approved and stays VERIFIED', async () => {
    seedWaiverAdmission()
    payments.set('tuition', {
      id: 'tuition', invoiceNo: 'INV-TUIT-EXP', admissionId: 'admission-1', userId: 'student-1',
      status: 'UNPAID', purpose: 'TUITION', description: 'رسوم الدراسة', amount: 350, amountCents: 35_000,
    })
    waiverCodes.push({
      id: 'wv-expired', paymentId: 'tuition', status: 'VERIFIED', waiverType: 'FULL_SCHOLARSHIP',
      requestedAmountCents: null, reason: 'منحة كاملة', codePreview: '••••-2222',
      expiresAt: new Date(Date.now() - 60_000), approvedById: null,
    })

    await expect(approvePaymentWaiver({ waiverId: 'wv-expired', actor: { id: 'admin-1', name: 'Admin' } }))
      .rejects.toThrow('انتهت صلاحية كود الإعفاء')
    expect(waiverCodes.find((w) => w.id === 'wv-expired')?.status).toBe('VERIFIED')
    expect(payments.get('tuition')?.status).toBe('UNPAID')
    expect(payments.get('tuition')?.waivedAmountCents || 0).toBe(0)
  })

  test('approval refuses a freshly PAID invoice and the code is NOT left APPROVED', async () => {
    seedWaiverAdmission()
    payments.set('tuition', {
      id: 'tuition', invoiceNo: 'INV-TUIT-PAID', admissionId: 'admission-1', userId: 'student-1',
      status: 'PAID', purpose: 'TUITION', description: 'رسوم الدراسة', amount: 350, amountCents: 35_000,
    })
    waiverCodes.push({
      id: 'wv-paid', paymentId: 'tuition', status: 'VERIFIED', waiverType: 'FULL_SCHOLARSHIP',
      requestedAmountCents: null, reason: 'منحة كاملة', codePreview: '••••-3333',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })

    await expect(approvePaymentWaiver({ waiverId: 'wv-paid', actor: { id: 'admin-1', name: 'Admin' } }))
      .rejects.toThrow('لا يمكن إعفاء فاتورة مسددة فعلياً')
    // قبل الإصلاح كان قلب الكود يلتزم في معاملة منفصلة فيبقى APPROVED بلا آثار.
    expect(waiverCodes.find((w) => w.id === 'wv-paid')?.status).toBe('VERIFIED')
    expect(payments.get('tuition')?.status).toBe('PAID')
  })

  test('partial tuition approval applies amounts and code flip together', async () => {
    seedWaiverAdmission()
    payments.set('tuition', {
      id: 'tuition', invoiceNo: 'INV-TUIT-PART', admissionId: 'admission-1', userId: 'student-1',
      status: 'UNPAID', purpose: 'TUITION', description: 'رسوم الدراسة', amount: 350, amountCents: 35_000,
    })
    waiverCodes.push({
      id: 'wv-part', paymentId: 'tuition', status: 'VERIFIED', waiverType: 'PARTIAL_TUITION',
      requestedAmountCents: 10_000, reason: 'إعفاء جزئي موثق', codePreview: '••••-4444',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })

    const updated = await approvePaymentWaiver({ waiverId: 'wv-part', actor: { id: 'admin-1', name: 'Admin' } })
    expect(updated.status).toBe('UNPAID')
    expect(updated.amountCents).toBe(25_000)
    expect(updated.waivedAmountCents).toBe(10_000)
    expect(updated.waiverStatus).toBe('APPROVED')
    expect(waiverCodes.find((w) => w.id === 'wv-part')?.status).toBe('APPROVED')
    expect(audits.map((a) => a.action)).toContain('PAYMENT_WAIVER_APPROVED')
    expect(admissions.get('admission-1')?.status).toBe('AWAITING_TUITION')
    expect(enrollments.size).toBe(0)
  })

  test('application-fee partial approval creates the tuition invoice via the retrying helper and activates (fix 7)', async () => {
    seedWaiverAdmission()
    payments.set('fee', {
      id: 'fee', invoiceNo: 'INV-FEE-PART', admissionId: 'admission-1', userId: 'student-1',
      status: 'UNPAID', purpose: 'APPLICATION_FEE', description: 'رسوم تقديم', amount: 30, amountCents: 3_000,
    })
    waiverCodes.push({
      id: 'wv-fee', paymentId: 'fee', status: 'VERIFIED', waiverType: 'PARTIAL_TUITION',
      requestedAmountCents: 38_000, reason: 'إعفاء يغطي التقديم والدراسة', codePreview: '••••-5555',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })

    const updated = await approvePaymentWaiver({ waiverId: 'wv-fee', actor: { id: 'admin-1', name: 'Admin' } })
    expect(updated.status).toBe('WAIVED')
    expect(updated.waiverStatus).toBe('PROGRAM_APPLIED')
    const tuition = [...payments.values()].find((p) => p.purpose === 'TUITION')
    expect(tuition).toBeTruthy()
    if (!tuition) throw new Error('Expected tuition invoice from approved application-fee waiver')
    // رقم الفاتورة جاء من nextInvoiceNo عبر createPaymentWithInvoiceNo
    // (ترقيم هذا الحarness التجريبي: INV-<عدد الفواتير + 1>).
    expect(tuition.invoiceNo).toBe('INV-2')
    expect(tuition.status).toBe('WAIVED')
    expect(tuition.amountCents).toBe(0)
    expect(tuition.waivedAmountCents).toBe(35_000)
    const enrollment = enrollments.get('student-1:program-1')
    expect(enrollment?.status).toBe('ACTIVE')
    expect(admissions.get('admission-1')?.status).toBe('SUPERVISOR_ASSIGNED')
  })
})

describe('accreditation certificate serial collision retry (audit fix 6)', () => {
  test('a concurrent serial winner makes the first create collide; settlement retries with the next serial', async () => {
    agentApplications.set('agent-1', {
      id: 'agent-1', status: 'APPROVED', kind: 'ACCREDITATION', accreditationType: 'TRAINER',
      orgName: 'Test Org', repName: 'Rep', email: '', country: 'PS', certificates: [],
    })
    payments.set('acc-pay', {
      id: 'acc-pay', invoiceNo: 'INV-ACC-1', status: 'UNPAID', purpose: 'ACCREDITATION',
      agentId: 'agent-1', description: 'رسوم اعتماد', amount: 200, amountCents: 20_000,
      payerName: 'Rep', payerEmail: '',
    })
    const year = new Date().getFullYear()
    certPhantomSerial = `AACT-C-${year}-00001`

    const result = await markInvoicePaid('INV-ACC-1', 'BANK_TRANSFER', { actor: { id: 'admin-1', name: 'Admin' } })
    expect(result.ok).toBe(true)
    expect(payments.get('acc-pay')?.status).toBe('PAID')
    expect(certificates).toHaveLength(2)
    expect(certificates[0].serial).toBe(`AACT-C-${year}-00001`)
    expect(certificates[1].serial).toBe(`AACT-C-${year}-00002`)
    expect(certificates[1].agentId).toBe('agent-1')
  })
})

describe('waiver cancel reversal (audit fix 2)', () => {
  function seedFullScholarshipActivation() {
    seedWaiverAdmission()
    const admission = admissions.get('admission-1')!
    admission.status = 'THESIS'
    admission.supervisorId = 'sup-1'
    admission.scholarshipFull = true
    payments.set('fee', {
      id: 'fee', invoiceNo: 'INV-FEE-FULL', admissionId: 'admission-1', userId: 'student-1',
      status: 'WAIVED', purpose: 'APPLICATION_FEE', description: 'رسوم تقديم',
      amount: 0, amountCents: 0, originalAmount: 30, originalAmountCents: 3_000,
      waivedAmount: 30, waivedAmountCents: 3_000, waiverType: 'FULL_SCHOLARSHIP',
      waiverStatus: 'APPROVED', waiverReason: 'منحة كاملة معتمدة', waiverApprovedById: 'admin-1',
      receiptNo: 'RCPT-FEE', method: 'WAIVER', paidAt: new Date(),
    })
    payments.set('tuition', {
      id: 'tuition', invoiceNo: 'INV-TUIT-FULL', admissionId: 'admission-1', userId: 'student-1',
      status: 'WAIVED', purpose: 'TUITION', description: 'رسوم الدراسة',
      amount: 0, amountCents: 0, originalAmount: 350, originalAmountCents: 35_000,
      waivedAmount: 350, waivedAmountCents: 35_000, waiverType: 'FULL_SCHOLARSHIP',
      waiverStatus: 'APPROVED', waiverReason: 'منحة كاملة معتمدة', waiverApprovedById: 'admin-1',
      receiptNo: 'RCPT-TUIT', method: 'WAIVER', paidAt: new Date(),
    })
    waiverCodes.push({
      id: 'wv-full', paymentId: 'tuition', status: 'APPROVED', waiverType: 'FULL_SCHOLARSHIP',
      requestedAmountCents: null, reason: 'منحة كاملة معتمدة', codePreview: '••••-9999',
      expiresAt: new Date(Date.now() + 60_000), approvedById: 'admin-1',
    })
    enrollments.set('student-1:program-1', {
      id: 'enr-1', userId: 'student-1', programId: 'program-1', status: 'ACTIVE',
      completedUnits: '[]', finalScore: null, certificateNo: null, createdAt: new Date(), extensionDays: 0,
    })
  }

  test('safe cancel restores both invoices, the admission stage and the enrollment', async () => {
    seedFullScholarshipActivation()
    const res = await waiversRoutePATCH(patchRequest('http://localhost/api/admin/payments/waivers', { action: 'CANCEL', waiverId: 'wv-full' }))
    expect(res.status).toBe(200)
    const tuition = payments.get('tuition')!
    expect(tuition.status).toBe('UNPAID')
    expect(tuition.amountCents).toBe(35_000)
    expect(tuition.waivedAmountCents).toBe(0)
    expect(tuition.receiptNo).toBe(null)
    const fee = payments.get('fee')!
    expect(fee.status).toBe('UNPAID')
    expect(fee.amountCents).toBe(3_000)
    expect(fee.waivedAmountCents).toBe(0)
    expect(admissions.get('admission-1')?.status).toBe('AWAITING_TUITION')
    expect(admissions.get('admission-1')?.scholarshipFull).toBe(false)
    expect(enrollments.get('student-1:program-1')?.status).toBe('PENDING_PAYMENT')
    expect(waiverCodes.find((w) => w.id === 'wv-full')?.status).toBe('CANCELLED')
  })

  test('cancel refused with 409 when another invoice was really paid', async () => {
    seedFullScholarshipActivation()
    payments.set('inst', {
      id: 'inst', invoiceNo: 'INV-INST-1', admissionId: 'admission-1', userId: 'student-1',
      status: 'PAID', purpose: 'TUITION_INSTALLMENT', description: 'دفعة', amount: 100, amountCents: 10_000,
    })
    const res = await waiversRoutePATCH(patchRequest('http://localhost/api/admin/payments/waivers', { action: 'CANCEL', waiverId: 'wv-full' }))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('WAIVER_CANCEL_UNSAFE')
    expect(waiverCodes.find((w) => w.id === 'wv-full')?.status).toBe('APPROVED')
    expect(payments.get('tuition')?.status).toBe('WAIVED')
    expect(enrollments.get('student-1:program-1')?.status).toBe('ACTIVE')
    expect(admissions.get('admission-1')?.status).toBe('THESIS')
  })

  test('cancel refused with 409 when the student already completed a unit', async () => {
    seedFullScholarshipActivation()
    enrollments.get('student-1:program-1')!.completedUnits = '["unit-1"]'
    const res = await waiversRoutePATCH(patchRequest('http://localhost/api/admin/payments/waivers', { action: 'CANCEL', waiverId: 'wv-full' }))
    expect(res.status).toBe(409)
    expect(waiverCodes.find((w) => w.id === 'wv-full')?.status).toBe('APPROVED')
    expect(payments.get('tuition')?.status).toBe('WAIVED')
  })

  test('cancel of an approved code without an admission keeps the plain invoice restore', async () => {
    payments.set('pay-x', {
      id: 'pay-x', invoiceNo: 'INV-X-1', status: 'WAIVED', purpose: 'ACCREDITATION',
      amount: 0, amountCents: 0, originalAmount: 200, originalAmountCents: 20_000,
      waivedAmount: 200, waivedAmountCents: 20_000, waiverType: 'FULL_SCHOLARSHIP',
      waiverStatus: 'APPROVED', waiverReason: 'منحة اعتماد', waiverApprovedById: 'admin-1',
    })
    waiverCodes.push({
      id: 'wv-x', paymentId: 'pay-x', status: 'APPROVED', waiverType: 'FULL_SCHOLARSHIP',
      requestedAmountCents: null, reason: 'منحة اعتماد', codePreview: '••••-1212',
      expiresAt: new Date(Date.now() + 60_000), approvedById: 'admin-1',
    })
    const res = await waiversRoutePATCH(patchRequest('http://localhost/api/admin/payments/waivers', { action: 'CANCEL', waiverId: 'wv-x' }))
    expect(res.status).toBe(200)
    expect(payments.get('pay-x')?.status).toBe('UNPAID')
    expect(payments.get('pay-x')?.amountCents).toBe(20_000)
    expect(waiverCodes.find((w) => w.id === 'wv-x')?.status).toBe('CANCELLED')
  })
})

describe('REFRESH_AMOUNT waiver awareness (audit fix 3)', () => {
  function seedRefreshPayment(overrides: Record<string, any> = {}) {
    payments.set('pay-refresh', {
      id: 'pay-refresh', invoiceNo: 'INV-REF-1', status: 'UNPAID', purpose: 'TUITION',
      description: 'رسوم الدراسة', amount: 250, amountCents: 25_000,
      originalAmount: 350, originalAmountCents: 35_000,
      waivedAmount: 100, waivedAmountCents: 10_000,
      waiverStatus: 'APPROVED', waiverType: 'PARTIAL_TUITION',
      admission: { programRef: { price: 400, category: 'DIPLOMA' }, program: 'دبلوم تجريبي', education: 'BACHELOR' },
      enrollment: null, agent: null, proofs: [],
      ...overrides,
    })
  }

  test('partial waiver: due = new total − waived, original moves to the new total, waiver preserved', async () => {
    seedRefreshPayment()
    const res = await paymentsRoutePATCH(patchRequest('http://localhost/api/admin/payments', { id: 'pay-refresh', action: 'REFRESH_AMOUNT', reason: 'تحديث سعر البرنامج السنوي' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.newAmount).toBe(300)
    const stored = payments.get('pay-refresh')!
    expect(stored.amountCents).toBe(30_000)
    expect(stored.originalAmountCents).toBe(40_000)
    expect(stored.waivedAmountCents).toBe(10_000)
  })

  test('partial waiver dry run reports the waived-aware due without writing', async () => {
    seedRefreshPayment()
    const res = await paymentsRoutePATCH(patchRequest('http://localhost/api/admin/payments', { id: 'pay-refresh', action: 'REFRESH_AMOUNT', dryRun: true }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.newAmount).toBe(300)
    expect(body.newTotalCents).toBe(40_000)
    expect(body.waivedAmountCents).toBe(10_000)
    expect(payments.get('pay-refresh')?.amountCents).toBe(25_000)
  })

  test('full scholarship on an unpaid invoice: refresh refused', async () => {
    seedRefreshPayment({ waiverType: 'FULL_SCHOLARSHIP' })
    const res = await paymentsRoutePATCH(patchRequest('http://localhost/api/admin/payments', { id: 'pay-refresh', action: 'REFRESH_AMOUNT', reason: 'تحديث سعر البرنامج السنوي' }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(String(body.error)).toContain('منحة كاملة')
    expect(payments.get('pay-refresh')?.amountCents).toBe(25_000)
  })

  test('plain invoice without a waiver keeps the legacy refresh behavior', async () => {
    seedRefreshPayment({ waiverStatus: null, waiverType: null, waivedAmount: null, waivedAmountCents: null, originalAmount: null, originalAmountCents: null, amount: 350, amountCents: 35_000 })
    const res = await paymentsRoutePATCH(patchRequest('http://localhost/api/admin/payments', { id: 'pay-refresh', action: 'REFRESH_AMOUNT', reason: 'تحديث سعر البرنامج السنوي' }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.newAmount).toBe(400)
    const stored = payments.get('pay-refresh')!
    expect(stored.amountCents).toBe(40_000)
    expect(stored.originalAmountCents).toBe(null)
  })
})
