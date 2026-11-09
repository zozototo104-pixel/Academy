/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

type RecordMap = Map<string, Record<string, any>>

const payments: RecordMap = new Map()
const grantSettings: RecordMap = new Map()
const scholarshipDefinitions: RecordMap = new Map()
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
// أدوات محاكاة السباقات للبنود U07/U09/U16/U17 (فحص 2026-11-07):
// - beforeTransactionHook: يُنفَّذ مرة واحدة في بداية أول $transaction
//   تالية وقبل لقطة التراجع، فيحاكي التزام عملية متزامنة بين قراءة
//   المسار قبل المعاملة وقراءته الطازجة داخلها.
// - rawQueries: نصوص $queryRaw المنفذة (الأقفال) بترتيبها.
// - enrollmentRacePhantom: إنشاء الالتحاق يزرع صف «فائز» متزامن ثم
//   يرمي P2002 كما تفعل قاعدة البيانات عند سباق الإنشاء.
// - siblingPaidRaceId: عند أول كتابة تستهدف هذه الفاتورة تُقلب أولاً
//   إلى PAID بإيصال نقدي (تحصيل متزامن هبط بين القراءة والكتابة).
let beforeTransactionHook: (() => void) | null = null
const rawQueries: string[] = []
let enrollmentRacePhantom = false
let enrollmentCreateFails = false
let siblingPaidRaceId: string | null = null

function consumeSiblingPaidRace(targetId: string | undefined) {
  if (!targetId || siblingPaidRaceId !== targetId) return
  siblingPaidRaceId = null
  const stored = payments.get(targetId)
  if (stored) {
    stored.status = 'PAID'
    stored.receiptNo = 'RCPT-RACE'
    stored.paidAt = new Date()
    stored.method = 'CASH'
  }
}

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
  scholarshipDefinition: {
    findMany: async () => [...scholarshipDefinitions.values()].map((row) => ({ ...row })),
    findUnique: async ({ where }: any) => scholarshipDefinitions.get(where.id) || null,
    create: async ({ data }: any) => {
      const id = 'test-scholarship-' + (scholarshipDefinitions.size + 1)
      const row = { ...data, id, programs: (data.programs?.create || []).map((p: any) => ({ programId: p.programId })), createdAt: new Date(), updatedAt: new Date() }
      scholarshipDefinitions.set(id, row)
      return { ...row }
    },
    update: async ({ where, data }: any) => {
      const row = scholarshipDefinitions.get(where.id)
      if (!row) throw new Error('SCHOLARSHIP_NOT_FOUND')
      Object.assign(row, data)
      return { ...row }
    },
  },
  setting: {
    findMany: async ({ where }: any = {}) => [...grantSettings.values()]
      .filter((row) => !where?.key?.startsWith || row.key.startsWith(where.key.startsWith))
      .map((row) => ({ ...row })),
    findUnique: async ({ where }: any) => grantSettings.get(where.key) || null,
    create: async ({ data }: any) => {
      if (grantSettings.has(data.key)) throw new Error('UNIQUE_SETTING')
      const row = { ...data, updatedAt: new Date() }
      grantSettings.set(row.key, row)
      return { ...row }
    },
    update: async ({ where, data }: any) => {
      const row = grantSettings.get(where.key)
      if (!row) throw new Error('SETTING_NOT_FOUND')
      Object.assign(row, data)
      return { ...row }
    },
    upsert: async ({ where, create, update }: any) => {
      const row = grantSettings.get(where.key) || { ...create }
      if (grantSettings.has(where.key)) Object.assign(row, update)
      grantSettings.set(where.key, row)
      return { ...row }
    },
    delete: async ({ where }: any) => { grantSettings.delete(where.key); return {} },
    deleteMany: async ({ where }: any) => { grantSettings.delete(where.key); return { count: 1 } },
  },
  $queryRaw: async (strings: any) => {
    rawQueries.push(Array.isArray(strings) ? strings.join('?') : String(strings))
    return []
  },
  $transaction: async (work: (tx: any) => Promise<any>) => {
    transactionCalls++
    if (beforeTransactionHook) {
      const hook = beforeTransactionHook
      beforeTransactionHook = null
      hook()
    }
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
      consumeSiblingPaidRace(where.id)
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
      consumeSiblingPaidRace(where.id)
      Object.assign(payment, data)
      return { ...payment }
    },
    create: async ({ data }: { data: Record<string, any> }) => {
      if (tuitionInvoiceCollisionOnce && data.purpose === 'TUITION') {
        tuitionInvoiceCollisionOnce = false
        const error: any = new Error('Unique constraint failed on invoiceNo')
        error.code = 'P2002'
        throw error
      }
      const payment = { ...data, id: data.id || `payment-${payments.size + 1}` }
      payments.set(payment.id, payment)
      return { ...payment }
    },
  },
  paymentWaiverCode: {
    findMany: async ({ where }: any) => waiverCodes.filter((row) => {
      if (where?.status?.in && !where.status.in.includes(row.status)) return false
      if (where?.waiverType?.in && !where.waiverType.in.includes(row.waiverType)) return false
      const payment = payments.get(row.paymentId)
      if (!payment) return false
      const ownership = where?.payment?.is?.OR
      if (ownership && !ownership.some((rule: any) =>
        (rule.userId && payment.userId === rule.userId) ||
        (rule.admission?.is?.userId && payment.admission?.userId === rule.admission.is.userId)
      )) return false
      return true
    }).map((row) => ({ ...row, payment: payments.get(row.paymentId) })),
    count: async ({ where }: any) => waiverCodes.filter((row) =>
      (!where?.paymentId?.in || where.paymentId.in.includes(row.paymentId))
      && (!where?.status?.in || where.status.in.includes(row.status))
    ).length,
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
      if (enrollmentCreateFails) throw new Error('INJECTED_ENROLLMENT_CREATE_OUTAGE')
      if (enrollmentRacePhantom) {
        enrollmentRacePhantom = false
        const key = `${data.userId}:${data.programId}`
        if (!enrollments.has(key)) {
          enrollments.set(key, { ...data, id: 'enrollment-winner', createdAt: new Date(), extensionDays: 0 })
        }
        const error: any = new Error('Unique constraint failed on the fields: (`userId`, `programId`)')
        error.code = 'P2002'
        throw error
      }
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
    count: async ({ where }: { where: Record<string, any> }) => examAttempts.filter((item) => (
      item.userId === where.userId
      && (!where.exam?.is?.unit?.is?.programId || item.programId === where.exam.is.unit.is.programId)
    )).length,
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
const { GET: waiversRouteGET, POST: waiversRoutePOST, PATCH: waiversRoutePATCH } = await import('../../src/app/api/admin/payments/waivers/route')
const { PATCH: paymentsRoutePATCH } = await import('../../src/app/api/admin/payments/route')
const { hasLifecycleFootprint, progressionGate } = await import('../../src/lib/progression')

beforeEach(() => {
  scholarshipDefinitions.clear()
  grantSettings.clear()
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
  tuitionInvoiceCollisionOnce = false
  transactionCalls = 0
  beforeTransactionHook = null
  rawQueries.splice(0, rawQueries.length)
  enrollmentRacePhantom = false
  enrollmentCreateFails = false
  siblingPaidRaceId = null
})

describe('organization schema migration gate', () => {
  test('finance UI sees server-side readiness as false until grant migration is present', async () => {
    const response = await waiversRouteGET(new NextRequest('http://localhost/api/admin/payments/waivers?mode=policies'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ready).toBe(false)
    expect(body.policies).toEqual([])
  })

  test('new grant issuance and definition creation reject without writing', async () => {
    for (const action of ['CREATE_POLICY', 'ISSUE_POLICY']) {
      const response = await waiversRoutePOST(new NextRequest('http://localhost/api/admin/payments/waivers', {
        method: 'POST',
        body: JSON.stringify({ action, paymentId: 'missing', policyId: 'missing' }),
      }))
      expect(response.status).toBe(503)
      expect((await response.json()).code).toBe('GRANT_ORGANIZATION_NOT_READY')
    }
    expect(grantSettings.size).toBe(0)
    expect(waiverCodes.length).toBe(0)
  })

  test('draft policy status cannot change before migration', async () => {
    const response = await waiversRoutePATCH(new NextRequest('http://localhost/api/admin/payments/waivers', {
      method: 'PATCH',
      body: JSON.stringify({ action: 'TOGGLE_POLICY', policyId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }),
    }))
    expect(response.status).toBe(503)
    expect((await response.json()).code).toBe('GRANT_ORGANIZATION_NOT_READY')
    expect(grantSettings.size).toBe(0)
  })
})

describe('organized grant eligibility before issuing an existing waiver code', () => {
  const programPolicyId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
  const individualPolicyId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
  const basePolicy = {
    title: 'منحة اختبار', scope: 'PROGRAM', programIds: ['program-A'], admissionId: null,
    coverage: 'TUITION', valueMode: 'PERCENT', value: 25, reason: 'قرار لجنة المنح',
    active: true, createdAt: new Date().toISOString(),
  }
  function seedPolicy(id: string, overrides: Record<string, any> = {}) {
    const policy = { id, ...basePolicy, ...overrides }
    scholarshipDefinitions.set(id, {
      ...policy,
      value: policy.valueMode === 'FULL' ? 0 : policy.value * 100,
      createdAt: new Date(policy.createdAt),
      startsAt: null,
      endsAt: null,
      programs: (policy.programIds || []).map((programId: string) => ({ programId })),
      operations: policy.scope === 'INDIVIDUAL' ? [{
        admissionId: policy.admissionId,
        userId: 'student-grant-1',
        status: 'TARGETED',
      }] : [],
    })
  }
  function seedStudentPayment(programId: string) {
    const payment = {
      id: 'grant-payment', admissionId: 'admission-1', userId: 'student-grant-1',
      admission: { id: 'admission-1', fullName: 'طالب تجريبي', programId, userId: 'student-grant-1' },
      purpose: 'TUITION', status: 'UNPAID', amount: 199.99, amountCents: 19999,
      invoiceNo: 'GRANT-INVOICE',
    }
    payments.set(payment.id, payment)
    return payment
  }
  function quoteRequest(id: string) {
    const params = new URLSearchParams({
      mode: 'quote', policyId: id, paymentId: 'grant-payment',
      requestedAmount: '999999', // injected amount must not override the server calculation
    })
    return new NextRequest('http://localhost/api/admin/payments/waivers?' + params.toString())
  }
  test('read-only scholarship catalog is backed by migrated tables and converts stored basis points', async () => {
    seedPolicy(programPolicyId, { value: 33.33 })
    const response = await waiversRouteGET(new NextRequest('http://localhost/api/admin/payments/waivers?mode=policies'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ready).toBe(false)
    expect(body.policies).toHaveLength(1)
    expect(body.policies[0].value).toBe(33.33)
    expect(body.policies[0].programIds).toEqual(['program-A'])
    expect(grantSettings.size).toBe(0)
  })

  test('server blocks a program grant when the applicant belongs to another specialty', async () => {
    seedStudentPayment('program-B')
    seedPolicy(programPolicyId)
    const response = await waiversRouteGET(quoteRequest(programPolicyId))
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.code).toBe('GRANT_NOT_ELIGIBLE')
    expect(body.error).toContain('غير مشمول')
  })
  test('individual exception can serve any specialty but remains bound to that admission', async () => {
    seedStudentPayment('program-B')
    seedPolicy(individualPolicyId, { scope: 'INDIVIDUAL', programIds: [], admissionId: 'admission-1' })
    const response = await waiversRouteGET(quoteRequest(individualPolicyId))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.quote.baseCents).toBe(19999)
    expect(body.quote.grantCents).toBe(5000)
    expect(body.quote.requestedAmount).toBe(50)
    expect(body.quote.waiverType).toBe('PARTIAL_TUITION')
  })
  test('percentage discounts use exact basis-point rounding to whole cents', async () => {
    seedStudentPayment('program-A')
    seedPolicy(programPolicyId, { value: 33.33 })
    const result = await waiversRouteGET(quoteRequest(programPolicyId))
    expect(result.status).toBe(200)
    const quote = (await result.json()).quote
    expect(quote.baseCents).toBe(19999)
    expect(quote.grantCents).toBe(6666)
    expect(quote.requestedAmount).toBe(66.66)
  })
  test('unsupported percentage precision and rounded full waiver are rejected', async () => {
    const payment = seedStudentPayment('program-A')
    seedPolicy(programPolicyId, { value: 33.333 })
    const excessivePrecision = await waiversRouteGET(quoteRequest(programPolicyId))
    expect(excessivePrecision.status).toBe(409)

    payment.amountCents = 1
    payment.amount = 0.01
    seedPolicy(programPolicyId, { value: 99.99 })
    const accidentallyFull = await waiversRouteGET(quoteRequest(programPolicyId))
    expect(accidentallyFull.status).toBe(409)
    expect((await accidentallyFull.json()).error).toContain('كامل')
  })
  test('student with a scholarship on another admission cannot receive a second scholarship', async () => {
    seedStudentPayment('program-A')
    payments.set('grant-payment-other', {
      id: 'grant-payment-other', userId: 'student-grant-1', admissionId: 'admission-2',
      admission: { id: 'admission-2', userId: 'student-grant-1', programId: 'program-B' },
      purpose: 'TUITION', status: 'UNPAID', amount: 200, amountCents: 20000,
    })
    waiverCodes.push({ id: 'prior-scholarship', paymentId: 'grant-payment-other', waiverType: 'FULL_SCHOLARSHIP', status: 'APPROVED' })
    seedPolicy(programPolicyId)
    const response = await waiversRouteGET(quoteRequest(programPolicyId))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('منحة')
  })
  test('registration-only waiver does not consume the one tuition scholarship', async () => {
    seedStudentPayment('program-A')
    payments.set('grant-registration-other', {
      id: 'grant-registration-other', userId: 'student-grant-1', admissionId: 'admission-2',
      admission: { id: 'admission-2', userId: 'student-grant-1', programId: 'program-B' },
      purpose: 'APPLICATION_FEE', status: 'WAIVED', amount: 30, amountCents: 3000,
    })
    waiverCodes.push({ id: 'registration-only', paymentId: 'grant-registration-other', waiverType: 'APPLICATION_FEE', status: 'APPROVED' })
    seedPolicy(programPolicyId)
    const response = await waiversRouteGET(quoteRequest(programPolicyId))
    expect(response.status).toBe(200)
  })
  test('unlinked student identity is not accepted for tuition scholarships', async () => {
    const payment: any = seedStudentPayment('program-A')
    payment.userId = null
    payment.admission.userId = null
    seedPolicy(programPolicyId)
    const response = await waiversRouteGET(quoteRequest(programPolicyId))
    expect(response.status).toBe(409)
    expect((await response.json()).error).toContain('هوية')
  })
  test('individual grant for a different admission and an active existing code are both blocked', async () => {
    seedStudentPayment('program-A')
    seedPolicy(individualPolicyId, { scope: 'INDIVIDUAL', programIds: [], admissionId: 'admission-other' })
    const wrongStudent = await waiversRouteGET(quoteRequest(individualPolicyId))
    expect(wrongStudent.status).toBe(409)
    seedPolicy(programPolicyId)
    waiverCodes.push({ id: 'active-existing', paymentId: 'grant-payment', status: 'ISSUED' })
    const activeCode = await waiversRouteGET(quoteRequest(programPolicyId))
    expect(activeCode.status).toBe(409)
    expect((await activeCode.json()).error).toContain('كود إعفاء نشط')
  })
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

  test('item 7 — WAIVER finalize fault at enrollment creation (after money committed) retries safely: one enrollment, one activation notice', async () => {
    seedAcademicAdmission('WAIVED')
    // المال ملتزم أصلًا في هذا الفرع (الفواتير WAIVED) والتفعيل هو الأثر
    // اللاحق وحده: العطل المحقون يضرب إنشاء الالتحاق منتصف التفعيل.
    enrollmentCreateFails = true
    await expect(finalizeAdmissionAfterSettlement(db, 'admission-1', { source: 'WAIVER' }))
      .rejects.toThrow('INJECTED_ENROLLMENT_CREATE_OUTAGE')
    // الحالة الوسيطة الآمنة: القبول لم يتقدم (بقي قبل البوابة) فترى
    // إعادة المحاولة عملها كاملًا — قبل الإصلاح كانت الحالة تتقدم هنا
    // ولا يعود الفرع يُدخل أبدًا فيضيع الالتحاق رغم التزام المال.
    expect(admissions.get('admission-1')?.status).toBe('AWAITING_TUITION')
    expect(enrollments.size).toBe(0)
    enrollmentCreateFails = false
    const retried = await finalizeAdmissionAfterSettlement(db, 'admission-1', { source: 'WAIVER' })
    expect(retried?.allSettled).toBe(true)
    expect(enrollments.size).toBe(1)
    const enrollment = enrollments.get('student-1:program-1')
    expect(enrollment?.status).toBe('ACTIVE')
    expect(rulesSnapshots.get(enrollment!.id)?.basis).toBe('ENROLLMENT')
    expect(admissions.get('admission-1')?.status).toBe('SUPERVISOR_ASSIGNED')
    // إشعار التفعيل وبريد التسجيل النهائي صدرا مرة واحدة فقط (من
    // المحاولة الناجحة) — لا تضاعف من المحاولة المعطوبة.
    expect(notifications.filter((n) => n.userId === 'student-1' && n.title === 'تم تفعيل تسجيلك بمنحة/إعفاء')).toHaveLength(1)
    expect(finalRegistrationEmails).toHaveLength(1)
    // إعادة ثالثة فوق المكتمل: لا التحاق ثانٍ ولا إشعارات جديدة.
    await finalizeAdmissionAfterSettlement(db, 'admission-1', { source: 'WAIVER' })
    expect(enrollments.size).toBe(1)
    expect(notifications.filter((n) => n.userId === 'student-1' && n.title === 'تم تفعيل تسجيلك بمنحة/إعفاء')).toHaveLength(1)
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
  test('a tuition invoice P2002 rolls back then retries the entire waiver-approval transaction', async () => {
    seedWaiverAdmission()
    payments.set('fee', {
      id: 'fee', invoiceNo: 'INV-FEE-RACE', admissionId: 'admission-1', userId: 'student-1',
      status: 'UNPAID', purpose: 'APPLICATION_FEE', description: 'رسوم تقديم', amount: 30, amountCents: 3_000,
    })
    waiverCodes.push({
      id: 'wv-race', paymentId: 'fee', status: 'VERIFIED', waiverType: 'PARTIAL_TUITION',
      requestedAmountCents: 38_000, reason: 'إعفاء يغطي التقديم والدراسة', codePreview: '••••-5555',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })
    tuitionInvoiceCollisionOnce = true
    const updated = await approvePaymentWaiver({ waiverId: 'wv-race', actor: { id: 'admin-1', name: 'Admin' } })
    expect(tuitionInvoiceCollisionOnce).toBe(false)
    expect(transactionCalls).toBeGreaterThanOrEqual(2)
    expect(updated.status).toBe('WAIVED')
    expect(waiverCodes.find((w) => w.id === 'wv-race')?.status).toBe('APPROVED')
    expect([...payments.values()].filter((p) => p.purpose === 'TUITION')).toHaveLength(1)
    expect(audits.filter((a) => a.action === 'PAYMENT_WAIVER_APPROVED')).toHaveLength(1)
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

  test('revoking a tuition grant keeps the separately paid application fee and blocks enrollment immediately', async () => {
    seedFullScholarshipActivation()
    Object.assign(payments.get('fee')!, {
      status: 'PAID',
      amount: 30,
      amountCents: 3_000,
      waivedAmount: 0,
      waivedAmountCents: 0,
      waiverType: null,
      waiverStatus: null,
      waiverReason: null,
      waiverApprovedById: null,
      receiptNo: 'RCPT-CASH-APPLICATION',
      method: 'BANK_TRANSFER',
    })
    const response = await waiversRoutePATCH(patchRequest('http://localhost/api/admin/payments/waivers', {
      action: 'CANCEL', waiverId: 'wv-full',
    }))
    expect(response.status).toBe(200)
    expect(payments.get('fee')?.status).toBe('PAID')
    expect(payments.get('fee')?.amountCents).toBe(3_000)
    expect(payments.get('fee')?.receiptNo).toBe('RCPT-CASH-APPLICATION')
    expect(payments.get('fee')?.method).toBe('BANK_TRANSFER')
    expect(payments.get('tuition')?.status).toBe('UNPAID')
    expect(payments.get('tuition')?.amountCents).toBe(35_000)
    expect(admissions.get('admission-1')?.scholarshipFull).toBe(false)
    expect(enrollments.get('student-1:program-1')?.status).toBe('PENDING_PAYMENT')
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

  test('academic attempts in another program do not block safe scholarship cancellation', async () => {
    seedFullScholarshipActivation()
    examAttempts.push({ id: 'attempt-other', userId: 'student-1', programId: 'program-2' })
    const res = await waiversRoutePATCH(patchRequest('http://localhost/api/admin/payments/waivers', { action: 'CANCEL', waiverId: 'wv-full' }))
    expect(res.status).toBe(200)
    expect(enrollments.get('student-1:program-1')?.status).toBe('PENDING_PAYMENT')
    expect(payments.get('tuition')?.status).toBe('UNPAID')
  })

  test('academic attempts in the affected program still refuse cancellation without touching grades', async () => {
    seedFullScholarshipActivation()
    examAttempts.push({ id: 'attempt-current', userId: 'student-1', programId: 'program-1' })
    const res = await waiversRoutePATCH(patchRequest('http://localhost/api/admin/payments/waivers', { action: 'CANCEL', waiverId: 'wv-full' }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('WAIVER_CANCEL_UNSAFE')
    expect(waiverCodes.find((w) => w.id === 'wv-full')?.status).toBe('APPROVED')
    expect(enrollments.get('student-1:program-1')?.status).toBe('ACTIVE')
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

describe('waiver cancel: own paid invoice guard (U15, completion-audit finding 1)', () => {
  function seedPartialWaiverPaidTuition() {
    seedWaiverAdmission()
    admissions.get('admission-1')!.status = 'SUPERVISOR_ASSIGNED'
    payments.set('tuition', {
      id: 'tuition', invoiceNo: 'INV-TUIT-U15', admissionId: 'admission-1', userId: 'student-1',
      status: 'PAID', purpose: 'TUITION', description: 'رسوم الدراسة',
      amount: 250, amountCents: 25_000, originalAmount: 350, originalAmountCents: 35_000,
      waivedAmount: 100, waivedAmountCents: 10_000, waiverType: 'PARTIAL_TUITION',
      waiverStatus: 'APPROVED', waiverReason: 'إعفاء جزئي موثق', waiverApprovedById: 'admin-1',
      receiptNo: 'RCPT-CASH-1', paidAt: new Date(), method: 'CASH',
    })
    waiverCodes.push({
      id: 'wv-u15', paymentId: 'tuition', status: 'APPROVED', waiverType: 'PARTIAL_TUITION',
      requestedAmountCents: 10_000, reason: 'إعفاء جزئي موثق', codePreview: '••••-1501',
      expiresAt: new Date(Date.now() + 60_000), approvedById: 'admin-1',
    })
    enrollments.set('student-1:program-1', {
      id: 'enr-1', userId: 'student-1', programId: 'program-1', status: 'ACTIVE',
      completedUnits: '[]', finalScore: null, certificateNo: null, createdAt: new Date(), extensionDays: 0,
    })
  }

  test('cancel refused with 409 when the student paid the remainder of a partially waived invoice', async () => {
    seedPartialWaiverPaidTuition()
    const res = await waiversRoutePATCH(patchRequest('http://localhost/api/admin/payments/waivers', { action: 'CANCEL', waiverId: 'wv-u15' }))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('WAIVER_CANCEL_UNSAFE')
    // السداد الحقيقي وإيصاله والإعفاء المعتمد كلها تبقى كما هي.
    expect(waiverCodes.find((w) => w.id === 'wv-u15')?.status).toBe('APPROVED')
    const tuition = payments.get('tuition')!
    expect(tuition.status).toBe('PAID')
    expect(tuition.receiptNo).toBe('RCPT-CASH-1')
    expect(tuition.waivedAmountCents).toBe(10_000)
    expect(tuition.amountCents).toBe(25_000)
    expect(enrollments.get('student-1:program-1')?.status).toBe('ACTIVE')
    expect(admissions.get('admission-1')?.status).toBe('SUPERVISOR_ASSIGNED')
  })

  test('cancel refused with 409 for a paid invoice even when the waiver has no admission (planner never runs)', async () => {
    payments.set('pay-y', {
      id: 'pay-y', invoiceNo: 'INV-Y-1', status: 'PAID', purpose: 'SERVICE_FEE',
      amount: 250, amountCents: 25_000, originalAmount: 350, originalAmountCents: 35_000,
      waivedAmount: 100, waivedAmountCents: 10_000, waiverType: 'PARTIAL_TUITION',
      waiverStatus: 'APPROVED', waiverReason: 'إعفاء جزئي', waiverApprovedById: 'admin-1',
      receiptNo: 'RCPT-CASH-2', paidAt: new Date(), method: 'BANK_TRANSFER',
    })
    waiverCodes.push({
      id: 'wv-y', paymentId: 'pay-y', status: 'APPROVED', waiverType: 'PARTIAL_TUITION',
      requestedAmountCents: 10_000, reason: 'إعفاء جزئي', codePreview: '••••-1502',
      expiresAt: new Date(Date.now() + 60_000), approvedById: 'admin-1',
    })
    const res = await waiversRoutePATCH(patchRequest('http://localhost/api/admin/payments/waivers', { action: 'CANCEL', waiverId: 'wv-y' }))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('WAIVER_CANCEL_UNSAFE')
    expect(waiverCodes.find((w) => w.id === 'wv-y')?.status).toBe('APPROVED')
    expect(payments.get('pay-y')?.status).toBe('PAID')
    expect(payments.get('pay-y')?.receiptNo).toBe('RCPT-CASH-2')
  })
})

describe('waiver cancel/reject: decision from the fresh in-transaction read (U07/M5)', () => {
  function seedVerifiedFullScholarship() {
    seedWaiverAdmission()
    admissions.get('admission-1')!.scholarshipFull = true
    payments.set('tuition', {
      id: 'tuition', invoiceNo: 'INV-TUIT-U07', admissionId: 'admission-1', userId: 'student-1',
      status: 'UNPAID', purpose: 'TUITION', description: 'رسوم الدراسة', amount: 350, amountCents: 35_000,
      waiverStatus: 'VERIFIED', waiverType: 'FULL_SCHOLARSHIP', waiverReason: 'منحة كاملة معتمدة',
    })
    waiverCodes.push({
      id: 'wv-u07', paymentId: 'tuition', status: 'VERIFIED', waiverType: 'FULL_SCHOLARSHIP',
      requestedAmountCents: null, reason: 'منحة كاملة معتمدة', codePreview: '••••-0701',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })
  }

  function concurrentApprovalCommits() {
    const code = waiverCodes.find((w) => w.id === 'wv-u07')!
    code.status = 'APPROVED'
    code.approvedById = 'admin-1'
    const payment = payments.get('tuition')!
    payment.status = 'WAIVED'
    payment.amount = 0
    payment.amountCents = 0
    payment.waivedAmount = 350
    payment.waivedAmountCents = 35_000
    payment.waiverStatus = 'APPROVED'
  }

  test('cancel adapts to an approval that committed while waiting for the payment lock: full reversal, no WAIVED leftover', async () => {
    seedVerifiedFullScholarship()
    beforeTransactionHook = concurrentApprovalCommits
    const res = await waiversRoutePATCH(patchRequest('http://localhost/api/admin/payments/waivers', { action: 'CANCEL', waiverId: 'wv-u07' }))
    expect(res.status).toBe(200)
    expect(waiverCodes.find((w) => w.id === 'wv-u07')?.status).toBe('CANCELLED')
    const tuition = payments.get('tuition')!
    expect(tuition.status).toBe('UNPAID')
    expect(tuition.amountCents).toBe(35_000)
    expect(tuition.waivedAmountCents).toBe(0)
    expect(admissions.get('admission-1')?.scholarshipFull).toBe(false)
  })

  test('reject after a concurrent approval is a 409 conflict, not a silent overwrite', async () => {
    seedVerifiedFullScholarship()
    beforeTransactionHook = concurrentApprovalCommits
    const res = await waiversRoutePATCH(patchRequest('http://localhost/api/admin/payments/waivers', { action: 'REJECT', waiverId: 'wv-u07' }))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('WAIVER_DECISION_CONFLICT')
    expect(waiverCodes.find((w) => w.id === 'wv-u07')?.status).toBe('APPROVED')
    expect(payments.get('tuition')?.status).toBe('WAIVED')
    expect(payments.get('tuition')?.waiverStatus).toBe('APPROVED')
  })

  test('item 8b — approve after a cancel that committed while waiting for the payment lock: clean refusal, zero money movement', async () => {
    seedVerifiedFullScholarship()
    // الإلغاء التزم بين قراءة الاعتماد قبل المعاملة وقراءته الطازجة
    // داخلها (حاجز التداخل نفسه): الاعتماد يجب أن يرفض من القراءة
    // الطازجة لا أن يعيد إحياء كود ملغي أو يحرك مالًا.
    beforeTransactionHook = () => {
      const code = waiverCodes.find((w) => w.id === 'wv-u07')!
      code.status = 'CANCELLED'
    }
    await expect(approvePaymentWaiver({ waiverId: 'wv-u07', actor: { id: 'admin-1', name: 'Admin' } }))
      .rejects.toThrow('لا يمكن اعتماد الكود قبل أن يدخله الطالب ويتحقق منه')
    expect(waiverCodes.find((w) => w.id === 'wv-u07')?.status).toBe('CANCELLED')
    const tuition = payments.get('tuition')!
    expect(tuition.status).toBe('UNPAID')
    expect(tuition.waivedAmountCents || 0).toBe(0)
    // علم المنحة كما زرعه الـfixture (قائم من الإصدار/التحقق) — الاعتماد
    // المرفوض لم يلمس القبول أصلًا؛ عكسُ العلم وظيفة إلغاء ناجح لا رفضِ اعتماد.
    expect(admissions.get('admission-1')?.scholarshipFull).toBe(true)
  })
})

describe('full scholarship sweep: a concurrent cash payment is never overwritten (U08/M6)', () => {
  test('installment flipped to PAID between the sweep read and write stays PAID with its receipt', async () => {
    seedWaiverAdmission()
    payments.set('fee', {
      id: 'fee', invoiceNo: 'INV-FEE-U08', admissionId: 'admission-1', userId: 'student-1',
      status: 'UNPAID', purpose: 'APPLICATION_FEE', description: 'رسوم تقديم', amount: 30, amountCents: 3_000,
    })
    payments.set('inst-race', {
      id: 'inst-race', invoiceNo: 'INV-INST-U08', admissionId: 'admission-1', userId: 'student-1',
      status: 'UNPAID', purpose: 'TUITION_INSTALLMENT', description: 'دفعة أولى', amount: 100, amountCents: 10_000,
    })
    waiverCodes.push({
      id: 'wv-u08', paymentId: 'fee', status: 'VERIFIED', waiverType: 'FULL_SCHOLARSHIP',
      requestedAmountCents: null, reason: 'منحة كاملة معتمدة', codePreview: '••••-0801',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })
    siblingPaidRaceId = 'inst-race'
    const updated = await approvePaymentWaiver({ waiverId: 'wv-u08', actor: { id: 'admin-1', name: 'Admin' } })
    expect(updated.status).toBe('WAIVED')
    const inst = payments.get('inst-race')!
    expect(inst.status).toBe('PAID')
    expect(inst.receiptNo).toBe('RCPT-RACE')
    expect(inst.amountCents).toBe(10_000)
    const tuitions = [...payments.values()].filter((p) => p.purpose === 'TUITION')
    expect(tuitions).toHaveLength(1)
    expect(tuitions[0].status).toBe('WAIVED')
    expect(waiverCodes.find((w) => w.id === 'wv-u08')?.status).toBe('APPROVED')
  })
})

describe('fee-branch ensure never rewrites a settled tuition invoice (item 8c — found by PG Scenario G)', () => {
  function seedPaidTuition() {
    seedWaiverAdmission()
    payments.set('fee', {
      id: 'fee', invoiceNo: 'INV-FEE-8C', admissionId: 'admission-1', userId: 'student-1',
      status: 'UNPAID', purpose: 'APPLICATION_FEE', description: 'رسوم تقديم', amount: 30, amountCents: 3_000,
    })
    payments.set('tuition', {
      id: 'tuition', invoiceNo: 'INV-TUIT-8C', admissionId: 'admission-1', userId: 'student-1',
      status: 'PAID', purpose: 'TUITION', description: 'رسوم الدراسة', amount: 350, amountCents: 35_000,
      method: 'CASH', receiptNo: 'RCPT-8C-1', paidAt: new Date('2026-11-01T10:00:00.000Z'),
    })
  }

  test('FULL_SCHOLARSHIP on the fee leaves a cash-PAID tuition byte-identical', async () => {
    seedPaidTuition()
    waiverCodes.push({
      id: 'wv-8c-full', paymentId: 'fee', status: 'VERIFIED', waiverType: 'FULL_SCHOLARSHIP',
      requestedAmountCents: null, reason: 'منحة كاملة معتمدة', codePreview: '••••-0803',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })
    await approvePaymentWaiver({ waiverId: 'wv-8c-full', actor: { id: 'admin-1', name: 'Admin' } })
    const tuition = payments.get('tuition')!
    expect(tuition.status).toBe('PAID')
    expect(tuition.receiptNo).toBe('RCPT-8C-1')
    expect(tuition.amountCents).toBe(35_000)
    expect(tuition.waivedAmountCents || 0).toBe(0)
    expect(tuition.waiverStatus).toBeUndefined()
    expect(payments.get('fee')?.status).toBe('WAIVED')
    expect(waiverCodes.find((w) => w.id === 'wv-8c-full')?.status).toBe('APPROVED')
    expect(enrollments.get('student-1:program-1')?.status).toBe('ACTIVE')
  })

  test('cash flip landing between the ensure read and its write: the status pin misses and the PAID tuition survives', async () => {
    seedWaiverAdmission()
    payments.set('fee', {
      id: 'fee', invoiceNo: 'INV-FEE-8C2', admissionId: 'admission-1', userId: 'student-1',
      status: 'UNPAID', purpose: 'APPLICATION_FEE', description: 'رسوم تقديم', amount: 30, amountCents: 3_000,
    })
    payments.set('tuition', {
      id: 'tuition', invoiceNo: 'INV-TUIT-8C2', admissionId: 'admission-1', userId: 'student-1',
      status: 'UNPAID', purpose: 'TUITION', description: 'رسوم الدراسة', amount: 350, amountCents: 35_000,
    })
    waiverCodes.push({
      id: 'wv-8c-race', paymentId: 'fee', status: 'VERIFIED', waiverType: 'FULL_SCHOLARSHIP',
      requestedAmountCents: null, reason: 'منحة كاملة معتمدة', codePreview: '••••-0805',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })
    // أول كتابة تستهدف فاتورة الدراسة (كتابة الـensure) تجدها قد قُلبت
    // PAID بإيصال نقدي في هذه الأثناء — التثبيت بالحالة المرصودة يجب
    // أن يُخطئ فلا يُكتب فوق التسوية النقدية.
    siblingPaidRaceId = 'tuition'
    await approvePaymentWaiver({ waiverId: 'wv-8c-race', actor: { id: 'admin-1', name: 'Admin' } })
    const tuition = payments.get('tuition')!
    expect(tuition.status).toBe('PAID')
    expect(tuition.receiptNo).toBe('RCPT-RACE')
    expect(tuition.amountCents).toBe(35_000)
    expect(tuition.waivedAmountCents || 0).toBe(0)
    expect(payments.get('fee')?.status).toBe('WAIVED')
    expect(waiverCodes.find((w) => w.id === 'wv-8c-race')?.status).toBe('APPROVED')
  })

  test('PARTIAL_TUITION credit on the fee also leaves a cash-PAID tuition untouched', async () => {
    seedPaidTuition()
    waiverCodes.push({
      id: 'wv-8c-part', paymentId: 'fee', status: 'VERIFIED', waiverType: 'PARTIAL_TUITION',
      requestedAmountCents: 38_000, reason: 'إعفاء يغطي التقديم والدراسة', codePreview: '••••-0804',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })
    await approvePaymentWaiver({ waiverId: 'wv-8c-part', actor: { id: 'admin-1', name: 'Admin' } })
    const tuition = payments.get('tuition')!
    expect(tuition.status).toBe('PAID')
    expect(tuition.receiptNo).toBe('RCPT-8C-1')
    expect(tuition.amountCents).toBe(35_000)
    expect(tuition.waivedAmountCents || 0).toBe(0)
    expect(payments.get('fee')?.status).toBe('WAIVED')
  })
})

describe('tuition invoice creation under the admission lock (U16)', () => {
  test('fee-branch approval locks Payment first, then AdmissionApplication, before creating the tuition invoice', async () => {
    seedWaiverAdmission()
    payments.set('fee', {
      id: 'fee', invoiceNo: 'INV-FEE-U16', admissionId: 'admission-1', userId: 'student-1',
      status: 'UNPAID', purpose: 'APPLICATION_FEE', description: 'رسوم تقديم', amount: 30, amountCents: 3_000,
    })
    waiverCodes.push({
      id: 'wv-u16', paymentId: 'fee', status: 'VERIFIED', waiverType: 'PARTIAL_TUITION',
      requestedAmountCents: 38_000, reason: 'إعفاء يغطي التقديم والدراسة', codePreview: '••••-1601',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })
    await approvePaymentWaiver({ waiverId: 'wv-u16', actor: { id: 'admin-1', name: 'Admin' } })
    const paymentLockIdx = rawQueries.findIndex((q) => q.includes('FROM "Payment"') && q.includes('FOR UPDATE'))
    const admissionLockIdx = rawQueries.findIndex((q) => q.includes('FROM "AdmissionApplication"') && q.includes('FOR UPDATE'))
    expect(paymentLockIdx).toBeGreaterThanOrEqual(0)
    expect(admissionLockIdx).toBeGreaterThan(paymentLockIdx)
    expect([...payments.values()].filter((p) => p.purpose === 'TUITION')).toHaveLength(1)
  })

  test('two different fee waivers on one admission, approved sequentially, still yield exactly one tuition invoice', async () => {
    seedWaiverAdmission()
    for (const suffix of ['1', '2']) {
      payments.set(`fee${suffix}`, {
        id: `fee${suffix}`, invoiceNo: `INV-FEE-U16-${suffix}`, admissionId: 'admission-1', userId: 'student-1',
        status: 'UNPAID', purpose: 'APPLICATION_FEE', description: 'رسوم تقديم', amount: 30, amountCents: 3_000,
      })
    }
    waiverCodes.push({
      id: 'wv-c1', paymentId: 'fee1', status: 'VERIFIED', waiverType: 'PARTIAL_TUITION',
      requestedAmountCents: 38_000, reason: 'إعفاء يغطي التقديم والدراسة', codePreview: '••••-1602',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })
    waiverCodes.push({
      id: 'wv-c2', paymentId: 'fee2', status: 'VERIFIED', waiverType: 'APPLICATION_FEE',
      requestedAmountCents: null, reason: 'إعفاء رسوم تقديم', codePreview: '••••-1603',
      expiresAt: new Date(Date.now() + 60_000), approvedById: null,
    })
    await approvePaymentWaiver({ waiverId: 'wv-c1', actor: { id: 'admin-1', name: 'Admin' } })
    await approvePaymentWaiver({ waiverId: 'wv-c2', actor: { id: 'admin-1', name: 'Admin' } })
    expect(waiverCodes.find((w) => w.id === 'wv-c1')?.status).toBe('APPROVED')
    expect(waiverCodes.find((w) => w.id === 'wv-c2')?.status).toBe('APPROVED')
    const tuitions = [...payments.values()].filter((p) => p.purpose === 'TUITION')
    expect(tuitions).toHaveLength(1)
    expect(tuitions[0].status).toBe('WAIVED')
    expect(tuitions[0].waivedAmountCents).toBe(35_000)
    expect(payments.get('fee1')?.waivedAmountCents).toBe(3_000)
    expect(payments.get('fee2')?.waivedAmountCents).toBe(3_000)
  })
})

describe('REFRESH_AMOUNT waiver consistency rule (U17)', () => {
  function seedRefreshCase(price: number) {
    payments.set('pay-u17', {
      id: 'pay-u17', invoiceNo: 'INV-U17', status: 'UNPAID', purpose: 'TUITION',
      description: 'رسوم الدراسة', amount: 250, amountCents: 25_000,
      originalAmount: 350, originalAmountCents: 35_000,
      waivedAmount: 100, waivedAmountCents: 10_000,
      waiverStatus: 'APPROVED', waiverType: 'PARTIAL_TUITION',
      admission: { programRef: { price, category: 'DIPLOMA' }, program: 'دبلوم تجريبي', education: 'BACHELOR' },
      enrollment: null, agent: null, proofs: [],
    })
  }

  test('new total below the approved waiver is refused and nothing is written', async () => {
    seedRefreshCase(50)
    const res = await paymentsRoutePATCH(patchRequest('http://localhost/api/admin/payments', { id: 'pay-u17', action: 'REFRESH_AMOUNT', reason: 'تخفيض سعر البرنامج السنوي' }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(String(body.error)).toContain('يساوي الإعفاء المعتمد أو يقل عنه')
    const stored = payments.get('pay-u17')!
    expect(stored.amountCents).toBe(25_000)
    expect(stored.originalAmountCents).toBe(35_000)
    expect(stored.waivedAmountCents).toBe(10_000)
  })

  test('new total equal to the waiver is refused too — and the dry run shows the same refusal', async () => {
    seedRefreshCase(100)
    const res = await paymentsRoutePATCH(patchRequest('http://localhost/api/admin/payments', { id: 'pay-u17', action: 'REFRESH_AMOUNT', reason: 'مساواة السعر للإعفاء المعتمد' }))
    expect(res.status).toBe(400)
    const dry = await paymentsRoutePATCH(patchRequest('http://localhost/api/admin/payments', { id: 'pay-u17', action: 'REFRESH_AMOUNT', dryRun: true }))
    expect(dry.status).toBe(400)
    const stored = payments.get('pay-u17')!
    expect(stored.amountCents).toBe(25_000)
    expect(stored.originalAmountCents).toBe(35_000)
    expect(stored.waivedAmountCents).toBe(10_000)
  })

  test('waiver amount changed by a concurrent decision between read and write: 409 and no write', async () => {
    seedRefreshCase(400)
    beforeTransactionHook = () => {
      const stored = payments.get('pay-u17')!
      stored.waivedAmountCents = 15_000
      stored.waivedAmount = 150
    }
    const res = await paymentsRoutePATCH(patchRequest('http://localhost/api/admin/payments', { id: 'pay-u17', action: 'REFRESH_AMOUNT', reason: 'تحديث سعر البرنامج السنوي' }))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('REFRESH_AMOUNT_CONFLICT')
    expect(payments.get('pay-u17')?.amountCents).toBe(25_000)
    expect(payments.get('pay-u17')?.originalAmountCents).toBe(35_000)
  })
})

describe('finalize enrollment creation race (U09/M7)', () => {
  test('PAYMENT branch: a concurrent enrollment winner turns the create P2002 into a completed activation', async () => {
    seedAcademicAdmission('UNPAID')
    enrollmentRacePhantom = true
    const paid = await markInvoicePaid('INV-TUITION', 'CARD', { actor: { id: 'admin-1', name: 'Admin' } })
    expect(paid.ok).toBe(true)
    expect(enrollments.size).toBe(1)
    const enrollment = enrollments.get('student-1:program-1')
    expect(enrollment?.status).toBe('ACTIVE')
    expect(rulesSnapshots.get(enrollment!.id)?.basis).toBe('ENROLLMENT')
    expect(admissions.get('admission-1')?.status).toBe('SUPERVISOR_ASSIGNED')
  })

  test('WAIVER branch: the same race resolves onto the winner enrollment instead of throwing', async () => {
    seedAcademicAdmission('WAIVED')
    enrollmentRacePhantom = true
    const result = await finalizeAdmissionAfterSettlement(db, 'admission-1', { source: 'WAIVER' })
    expect(result?.tuitionSettled).toBe(true)
    expect(enrollments.size).toBe(1)
    const enrollment = enrollments.get('student-1:program-1')
    expect(enrollment?.status).toBe('ACTIVE')
    expect(rulesSnapshots.get(enrollment!.id)?.basis).toBe('ENROLLMENT')
  })
})
