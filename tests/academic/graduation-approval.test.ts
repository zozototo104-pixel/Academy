import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { NextRequest } from 'next/server'

// ===== قانون المصادقة على التخرج =====
// إنشاء شهادة إتمام برنامج يتطلب طلب تخرج بحالة APPROVED محفوظًا في قاعدة
// البيانات. الأحداث الأكاديمية تسجّل المعاملة أو تحدّث لقطتها فقط،
// والإصدار نفسه يعيد فحص الشروط طازجة قبل إنشاء أي شهادة.

function makeWorld() {
  const state: any = {
    enrollment: { id: 'enrollment-1', userId: 'user-1', programId: 'program-1', status: 'ACTIVE', certificateNo: null as string | null },
    // Historical graduation-approval cases start after the programme
    // period; dedicated tests below use a recent start to verify that
    // a direct admin POST cannot decide an unraised pending request.
    enrollmentCreatedAt: new Date('2025-01-01T00:00:00Z'),
    lastSemesterDecision: null as string | null,
    certificate: null as any,
    createdCertificate: null as any,
    request: null as any,
    outbox: [] as any[],
    enrollmentUpdates: [] as any[],
    failTransaction: false,
    admissionStatus: 'APPROVED',
    scholarshipFull: false,
    programPrice: 1000,
    payments: [{ purpose: 'TUITION', status: 'PAID', amount: 1000, amountCents: 100000 }],
  }
  const admission = {
    id: 'admission-1', userId: 'user-1', programId: 'program-1', fullName: 'طالب عربي', fullNameEn: null,
    program: 'برنامج عربي للاختبار', country: 'فلسطين', email: 'student@example.test', status: 'APPROVED', scholarshipFull: false,
  }
  let decisionRevision = 0
  const decisionUpdatedAt = () => new Date(1_700_000_000_000 + ++decisionRevision * 1000)
  const tx: any = {
    $queryRaw: async () => [{ value: 1 }],
    admissionApplication: {
      findUnique: async () => ({ ...admission, status: state.admissionStatus, scholarshipFull: state.scholarshipFull }),
      findFirst: async () => ({ ...admission, status: state.admissionStatus, scholarshipFull: state.scholarshipFull }),
      update: async ({ data }: any) => {
        if (data.status) state.admissionStatus = data.status
        return { ...admission, status: state.admissionStatus, ...data }
      },
    },
    enrollment: {
      findUnique: async () => ({
        ...state.enrollment,
        createdAt: state.enrollmentCreatedAt,
        extensionDays: 0,
        program: { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 },
      }),
      update: async ({ data }: any) => { state.enrollmentUpdates.push(data); Object.assign(state.enrollment, data); return state.enrollment },
    },
    unit: {
      findMany: async () => [
        { id: 'unit-sem1', semester: 1, order: 1 },
        { id: 'unit-sem2', semester: 2, order: 1 },
      ],
    },
    semesterDecision: {
      findUnique: async () => state.lastSemesterDecision
        ? { status: state.lastSemesterDecision }
        : null,
    },
    program: {
      findUnique: async () => ({ id: 'program-1', titleAr: 'برنامج عربي للاختبار', titleEn: 'Arabic Test Program', price: state.programPrice, category: 'DIPLOMA' }),
    },
    payment: { findMany: async () => state.payments },
    certificate: {
      findFirst: async () => state.certificate,
      create: async ({ data }: any) => { state.createdCertificate = { id: 'cert-new', ...data }; state.certificate = state.createdCertificate; return state.createdCertificate },
    },
    graduationRequest: {
      findUnique: async () => state.request,
      create: async ({ data }: any) => { state.request = { id: 'grad-1', ...data, updatedAt: decisionUpdatedAt() }; return state.request },
      update: async ({ data }: any) => { Object.assign(state.request, data, { updatedAt: decisionUpdatedAt() }); return state.request },
      updateMany: async ({ where, data }: any) => {
        const row = state.request
        if (!row || row.id !== where.id || row.status !== where.status ||
            (where.ready !== undefined && row.ready !== where.ready) ||
            (where.score !== undefined && row.score !== where.score) ||
            (where.updatedAt && row.updatedAt?.getTime() !== where.updatedAt.getTime())) {
          return { count: 0 }
        }
        Object.assign(row, data, { updatedAt: decisionUpdatedAt() })
        return { count: 1 }
      },
    },
    exam: { findMany: async () => [{ id: 'unit-empty', title: 'اختبار فارغ', passScore: 51, unit: { title: 'وحدة' }, _count: { questions: 0 } }] },
    examAttempt: { findMany: async () => [] },
    programExam: { findMany: async () => [{ id: 'program-exam-1', title: 'اختبار نهائي', semester: 1, passScore: 51 }] },
    programExamAttempt: { findMany: async () => [{ score: 95, finalScore: 95, appealStatus: 'REVIEWED', passed: true, answers: [{ points: 95, maxPoints: 100 }] }] },
    programAssignment: { findMany: async () => [{ id: 'assignment-1', title: 'واجب', points: 100 }] },
    assignmentSubmission: { findUnique: async () => ({ status: 'GRADED', score: 95 }) },
    thesisSubmission: { findFirst: async () => null },
    user: {
      findMany: async () => [{ id: 'admin-1', email: 'admin@aact.academy' }],
      findUnique: async () => ({ id: 'user-1', email: 'student@example.test', role: 'STUDENT', name: 'طالب عربي' }),
    },
    notification: { createMany: async () => ({ count: 1 }), create: async () => ({}) },
    notificationOutbox: {
      create: async ({ data }: any) => {
        if (state.outbox.some((row: any) => row.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error('duplicate'), { code: 'P2002' })
        }
        const row = { id: `outbox-${state.outbox.length + 1}`, ...data }
        state.outbox.push(row)
        return row
      },
      findUnique: async ({ where }: any) =>
        state.outbox.find((row: any) => row.idempotencyKey === where.idempotencyKey) ?? null,
    },
  }
  const db: any = { ...tx, $transaction: async (work: any) => {
    if (state.failTransaction) throw new Error('simulated readiness refresh failure')
    return work(tx)
  } }
  return { state, tx, db }
}

const world = makeWorld()
mock.module('@/lib/db', () => ({ db: world.db }))
mock.module('@/lib/auth', () => ({
  requireAdmin: async () => ({ id: 'admin-1', role: 'ADMIN' }),
  getCurrentUser: async () => ({ id: 'admin-1', role: 'ADMIN', name: 'المسؤول' }),
}))
const sentGraduationNotifications: Array<{ title: string; link?: string }> = []
mock.module('@/lib/notify', () => ({
  AUDIT_ACTIONS: {},
  notify: async () => {},
  notifyAdmins: async (_type: string, title: string, _body: string, link?: string) => {
    sentGraduationNotifications.push({ title, link })
  },
  audit: async () => {},
}))
// Keep the actual module's export surface for dependent payment/admission
// imports; replace only outbound mail side effects under test.
const realMailer = await import('../../src/lib/mailer')
mock.module('@/lib/mailer', () => ({
  ...realMailer,
  emailAdmissionDecision: async () => {},
  emailAdmissionDocumentsRequested: async () => {},
  emailCertificateIssued: async () => {},
  emailPaymentReceipt: async () => {},
  emailFinalRegistration: async () => {},
  emailPaymentWaiverCode: async () => {},
}))

const { completeEnrollmentIfEligibleInTransaction, registerGraduationRequest } = await import('../../src/lib/enrollment-completion')
const { POST: graduationAction } = await import('../../src/app/api/admin/graduation-requests/route')
const { PATCH: admissionAction } = await import('../../src/app/api/admin/admissions/route')

function certifyFromAdmissions() {
  return admissionAction(new NextRequest('http://localhost/api/admin/admissions', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'admission-1', status: 'CERTIFIED' }),
  }))
}

function postGraduationAction(action: 'REFRESH' | 'APPROVE' | 'REJECT') {
  return graduationAction(new NextRequest('http://localhost/api/admin/graduation-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, requestId: 'grad-1' }),
  }))
}

beforeEach(() => {
  sentGraduationNotifications.length = 0
  world.state.enrollment = { id: 'enrollment-1', userId: 'user-1', programId: 'program-1', status: 'ACTIVE', certificateNo: null }
  world.state.enrollmentCreatedAt = new Date('2025-01-01T00:00:00Z')
  world.state.lastSemesterDecision = null
  world.state.certificate = null
  world.state.createdCertificate = null
  world.state.request = null
  world.state.enrollmentUpdates = []
  world.state.failTransaction = false
  world.state.admissionStatus = 'APPROVED'
  world.state.scholarshipFull = false
  world.state.programPrice = 1000
  world.state.payments = [{ purpose: 'TUITION', status: 'PAID', amount: 1000, amountCents: 100000 }]
})

describe('graduation approval law', () => {
  test('paid programme without any tuition invoice is not ready and cannot issue even after an approval', async () => {
    world.state.payments = []
    const request = await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(request.registered).toBe(true)
    expect(world.state.request.ready).toBe(false)
    expect(world.state.request.snapshot.financeError).toContain('فاتورة')
    world.state.request.status = 'APPROVED'
    world.state.request.decidedById = 'admin-1'
    world.state.request.decidedAt = new Date()
    const result = await completeEnrollmentIfEligibleInTransaction(world.tx, {
      enrollmentId: 'enrollment-1', admissionId: 'admission-1',
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('PAYMENT_REQUIRED')
    expect(world.state.createdCertificate).toBeNull()
  })

  test('documented full scholarship still allows readiness without tuition invoices', async () => {
    world.state.payments = []
    world.state.scholarshipFull = true
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(world.state.request.ready).toBe(true)
    world.state.request.status = 'APPROVED'
    world.state.request.decidedById = 'admin-1'
    world.state.request.decidedAt = new Date()
    const result = await completeEnrollmentIfEligibleInTransaction(world.tx, {
      enrollmentId: 'enrollment-1', admissionId: 'admission-1',
    })
    expect(result.ok).toBe(true)
    expect(result.certificateIssued).toBe(true)
  })

  test('a genuinely free programme remains eligible without an invoice', async () => {
    world.state.programPrice = 0
    world.state.payments = []
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(world.state.request.ready).toBe(true)
  })

  test('previously issued linked certificate can be retrieved even when old tuition invoices are missing', async () => {
    world.state.payments = []
    world.state.enrollment.status = 'COMPLETED'
    world.state.enrollment.certificateNo = 'CERT-HISTORICAL'
    world.state.certificate = { id: 'cert-old', serial: 'CERT-HISTORICAL', enrollmentId: 'enrollment-1', type: 'PROGRAM_COMPLETION' }
    const result = await completeEnrollmentIfEligibleInTransaction(world.tx, {
      enrollmentId: 'enrollment-1', admissionId: 'admission-1',
    })
    expect(result.ok).toBe(true)
    expect(result.certificateIssued).toBe(false)
    expect(result.certificate?.serial).toBe('CERT-HISTORICAL')
    expect(world.state.createdCertificate).toBeNull()
  })

  test('a new student missing tuition is tracked without an approval notification; only becoming eligible alerts admins once', async () => {
    world.state.payments = []
    const first = await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(first.registered).toBe(true)
    expect(first.ready).toBe(false)
    expect(world.state.request.status).toBe('PENDING')
    expect(sentGraduationNotifications).toHaveLength(0)

    world.state.payments = [{ purpose: 'TUITION', status: 'PAID', amount: 1000, amountCents: 100000 }]
    const second = await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(second.ready).toBe(true)
    expect(sentGraduationNotifications).toHaveLength(1)
    expect(sentGraduationNotifications[0].title).toContain('مستوفٍ')
    expect(sentGraduationNotifications[0].link).toContain('tab=certs')

    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(sentGraduationNotifications).toHaveLength(1)
  })

  test('registration creates one living PENDING transaction with a readiness snapshot', async () => {
    const first = await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(first.registered).toBe(true)
    expect(first.status).toBe('PENDING')
    expect(world.state.request).not.toBeNull()
    expect(world.state.request.ready).toBe(true)
    expect(world.state.request.score).toBe(95)
    const createdId = world.state.request.id

    const second = await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(second.registered).toBe(true)
    expect(world.state.request.id).toBe(createdId)
  })

  test('registration refreshes the snapshot but never rewrites a recorded decision', async () => {
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    world.state.request.status = 'APPROVED'
    world.state.request.decidedById = 'admin-1'
    const again = await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(again.registered).toBe(true)
    expect(world.state.request.status).toBe('APPROVED')
    expect(world.state.request.decidedById).toBe('admin-1')
    expect(world.state.request.ready).toBe(true)
  })

  test('issuance is refused when no graduation request exists at all', async () => {
    const result = await completeEnrollmentIfEligibleInTransaction(world.tx, { enrollmentId: 'enrollment-1', admissionId: 'admission-1' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ADMIN_GRADUATION_APPROVAL_REQUIRED')
    expect(result.httpStatus).toBe(409)
    expect(world.state.createdCertificate).toBeNull()
    expect(world.state.enrollment.status).toBe('ACTIVE')
  })

  test('issuance is refused while the request is only PENDING', async () => {
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(world.state.request.status).toBe('PENDING')
    const result = await completeEnrollmentIfEligibleInTransaction(world.tx, { enrollmentId: 'enrollment-1', admissionId: 'admission-1' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ADMIN_GRADUATION_APPROVAL_REQUIRED')
    expect(world.state.createdCertificate).toBeNull()
    expect(world.state.enrollment.status).toBe('ACTIVE')
  })

  test('issuance is refused when the stored approval lacks its decider identity or timestamp', async () => {
    world.state.request = { id: 'grad-1', enrollmentId: 'enrollment-1', userId: 'user-1', programId: 'program-1', admissionId: 'admission-1', status: 'APPROVED', ready: true, score: 95, snapshot: null, decidedById: null, decidedAt: null }
    const result = await completeEnrollmentIfEligibleInTransaction(world.tx, { enrollmentId: 'enrollment-1', admissionId: 'admission-1' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ADMIN_GRADUATION_APPROVAL_REQUIRED')
    expect(world.state.createdCertificate).toBeNull()
    expect(world.state.enrollment.status).toBe('ACTIVE')
  })

  test('issuance is refused when the final score changed after approval', async () => {
    world.state.request = { id: 'grad-1', enrollmentId: 'enrollment-1', userId: 'user-1', programId: 'program-1', admissionId: 'admission-1', status: 'APPROVED', ready: true, score: 88, snapshot: null, decidedById: 'admin-1', decidedAt: new Date() }
    const result = await completeEnrollmentIfEligibleInTransaction(world.tx, { enrollmentId: 'enrollment-1', admissionId: 'admission-1' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('GRADUATION_APPROVAL_STALE')
    expect(result.httpStatus).toBe(409)
    expect(world.state.createdCertificate).toBeNull()
    expect(world.state.enrollment.status).toBe('ACTIVE')
  })

  test('issuance succeeds under a stored APPROVED request and closes the transaction as ISSUED', async () => {
    world.state.request = { id: 'grad-1', enrollmentId: 'enrollment-1', userId: 'user-1', programId: 'program-1', admissionId: 'admission-1', status: 'APPROVED', ready: true, score: 95, snapshot: null, decidedById: 'admin-1', decidedAt: new Date() }
    const result = await completeEnrollmentIfEligibleInTransaction(world.tx, { enrollmentId: 'enrollment-1', admissionId: 'admission-1' })
    expect(result.ok).toBe(true)
    expect(result.certificateIssued).toBe(true)
    expect(world.state.createdCertificate).not.toBeNull()
    expect(world.state.enrollment.status).toBe('COMPLETED')
    expect(world.state.request.status).toBe('ISSUED')
    expect(world.state.request.certificateId).toBe('cert-new')
  })

  test('admissions certification route refuses a missing administrative graduation approval', async () => {
    const response = await certifyFromAdmissions()
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('ADMIN_GRADUATION_APPROVAL_REQUIRED')
    expect(world.state.createdCertificate).toBeNull()
    expect(world.state.enrollment.status).toBe('ACTIVE')
  })

  test('admissions certification uses the same atomic issuer and links the certificate to the enrollment', async () => {
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    world.state.request.status = 'APPROVED'
    world.state.request.decidedById = 'admin-1'
    world.state.request.decidedAt = new Date()

    const response = await certifyFromAdmissions()
    expect(response.status).toBe(200)
    expect((await response.json()).ok).toBe(true)
    expect(world.state.createdCertificate?.enrollmentId).toBe('enrollment-1')
    expect(world.state.createdCertificate?.admissionId).toBe('admission-1')
    expect(world.state.enrollment.status).toBe('COMPLETED')
    expect(world.state.enrollment.certificateNo).toBe(world.state.createdCertificate?.serial)
    expect(world.state.request.status).toBe('ISSUED')
    expect(world.state.request.certificateId).toBe(world.state.createdCertificate?.id)

    const existing = world.state.createdCertificate
    const second = await certifyFromAdmissions()
    expect(second.status).toBe(200)
    expect(world.state.createdCertificate).toBe(existing)
  })

  test('admissions certification does not reissue a legacy unlinked certificate', async () => {
    world.state.certificate = {
      id: 'legacy-cert', admissionId: 'admission-1', enrollmentId: null,
      type: 'PROGRAM_COMPLETION', serial: 'AACT-C-2026-OLD',
    }
    const response = await certifyFromAdmissions()
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('CERTIFICATE_RECONCILIATION_REQUIRED')
    expect(world.state.createdCertificate).toBeNull()
  })

  test('historical CERTIFIED admission stays retrievable without rechecking current invoices', async () => {
    world.state.admissionStatus = 'CERTIFIED'
    world.state.certificate = {
      id: 'legacy-cert', admissionId: 'admission-1', enrollmentId: null,
      type: 'PROGRAM_COMPLETION', serial: 'AACT-C-2026-OLD',
    }
    const payments = world.db.payment.findMany
    world.db.payment.findMany = async () => [{ purpose: 'TUITION', status: 'PENDING', amount: 1000, amountCents: 100000 }]
    try {
      const response = await certifyFromAdmissions()
      expect(response.status).toBe(200)
      expect((await response.json()).ok).toBe(true)
      expect(world.state.createdCertificate).toBeNull()
      expect(world.state.admissionStatus).toBe('CERTIFIED')
    } finally {
      world.db.payment.findMany = payments
    }
  })

  test('an open last semester without student raise blocks BOTH direct admin approval and rejection', async () => {
    world.state.enrollmentCreatedAt = new Date()
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(world.state.request.status).toBe('PENDING')
    for (const action of ['APPROVE', 'REJECT'] as const) {
      const response = await postGraduationAction(action)
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('GRADUATION_NOT_RAISED')
      expect(world.state.request.status).toBe('PENDING')
    }
  })

  test('an explicit mature student raise permits an early graduation decision', async () => {
    world.state.enrollmentCreatedAt = new Date()
    world.state.lastSemesterDecision = 'RAISED'
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    const response = await postGraduationAction('APPROVE')
    expect(response.status).toBe(200)
    expect(world.state.request.status).toBe('APPROVED')
  })

  test('a withdrawn early raise does not authorize a graduation decision', async () => {
    world.state.enrollmentCreatedAt = new Date()
    world.state.lastSemesterDecision = 'WITHDRAWN'
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    const response = await postGraduationAction('REJECT')
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('GRADUATION_NOT_RAISED')
  })

  test('stale 88 approval -> admin refresh to 95 -> new approval -> issuance at 95', async () => {
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    world.state.request.status = 'APPROVED'
    world.state.request.decidedById = 'admin-1'
    world.state.request.decidedAt = new Date()
    world.state.request.score = 88

    const stale = await completeEnrollmentIfEligibleInTransaction(world.tx, { enrollmentId: 'enrollment-1', admissionId: 'admission-1' })
    expect(stale.code).toBe('GRADUATION_APPROVAL_STALE')
    expect(world.state.createdCertificate).toBeNull()

    const refresh = await postGraduationAction('REFRESH')
    expect(refresh.status).toBe(200)
    expect((await refresh.json()).request.score).toBe(95)
    expect(world.state.request.status).toBe('PENDING')
    expect(world.state.request.decidedById).toBeNull()
    expect(world.state.request.decidedAt).toBeNull()

    const pending = await completeEnrollmentIfEligibleInTransaction(world.tx, { enrollmentId: 'enrollment-1', admissionId: 'admission-1' })
    expect(pending.code).toBe('ADMIN_GRADUATION_APPROVAL_REQUIRED')
    expect(world.state.createdCertificate).toBeNull()

    const approval = await postGraduationAction('APPROVE')
    expect(approval.status).toBe(200)
    expect(world.state.request.status).toBe('APPROVED')
    expect(world.state.request.score).toBe(95)
    expect(world.state.request.decidedById).toBe('admin-1')
    expect(world.state.request.decidedAt).toBeInstanceOf(Date)

    const issued = await completeEnrollmentIfEligibleInTransaction(world.tx, { enrollmentId: 'enrollment-1', admissionId: 'admission-1' })
    expect(issued.ok).toBe(true)
    expect(issued.certificateIssued).toBe(true)
    expect(world.state.enrollment.finalScore).toBe(95)
    expect(world.state.request.status).toBe('ISSUED')
    expect(world.state.request.certificateId).toBe('cert-new')
  })

  test('failed readiness refresh never returns success or approves the old snapshot', async () => {
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    world.state.failTransaction = true
    for (const action of ['REFRESH', 'APPROVE'] as const) {
      const response = await postGraduationAction(action)
      expect(response.status).toBe(503)
      expect((await response.json()).code).toBe('GRADUATION_REFRESH_FAILED')
      expect(world.state.request.status).toBe('PENDING')
      expect(world.state.request.decidedById).toBeUndefined()
      expect(world.state.createdCertificate).toBeNull()
    }
  })

  test('concurrent approval cannot overwrite an already-recorded admin decision', async () => {
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    const original = world.db.graduationRequest.updateMany
    world.db.graduationRequest.updateMany = async (args: any) => {
      // A second admin acted after the route refreshed readiness but before CAS.
      world.state.request.status = 'APPROVED'
      world.state.request.decidedById = 'admin-other'
      world.state.request.updatedAt = new Date(world.state.request.updatedAt.getTime() + 1000)
      return original(args)
    }
    try {
      const response = await postGraduationAction('APPROVE')
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('GRADUATION_DECISION_CONFLICT')
      expect(world.state.request.decidedById).toBe('admin-other')
    } finally {
      world.db.graduationRequest.updateMany = original
    }
  })

  test('concurrent rejection cannot overwrite a just-issued request', async () => {
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    const original = world.db.graduationRequest.updateMany
    world.db.graduationRequest.updateMany = async (args: any) => {
      world.state.request.status = 'ISSUED'
      world.state.request.updatedAt = new Date(world.state.request.updatedAt.getTime() + 1000)
      return original(args)
    }
    try {
      const response = await postGraduationAction('REJECT')
      expect(response.status).toBe(409)
      expect((await response.json()).code).toBe('GRADUATION_DECISION_CONFLICT')
      expect(world.state.request.status).toBe('ISSUED')
    } finally {
      world.db.graduationRequest.updateMany = original
    }
  })

  test('an already-issued certificate is returned as-is, never recreated or regraded', async () => {
    world.state.enrollment = { id: 'enrollment-1', userId: 'user-1', programId: 'program-1', status: 'COMPLETED', certificateNo: 'AACT-C-2026-00001' }
    world.state.certificate = { id: 'cert-1', serial: 'AACT-C-2026-00001', type: 'PROGRAM_COMPLETION', enrollmentId: 'enrollment-1' }
    const result = await completeEnrollmentIfEligibleInTransaction(world.tx, { enrollmentId: 'enrollment-1', admissionId: 'admission-1' })
    expect(result.ok).toBe(true)
    expect(result.certificateIssued).toBe(false)
    expect(result.certificate?.serial).toBe('AACT-C-2026-00001')
    expect(world.state.createdCertificate).toBeNull()
  })
})
