import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { NextRequest } from 'next/server'

// ===== قانون المصادقة على التخرج =====
// إنشاء شهادة إتمام برنامج يتطلب طلب تخرج بحالة APPROVED محفوظًا في قاعدة
// البيانات. الأحداث الأكاديمية تسجّل المعاملة أو تحدّث لقطتها فقط،
// والإصدار نفسه يعيد فحص الشروط طازجة قبل إنشاء أي شهادة.

function makeWorld() {
  const state: any = {
    enrollment: { id: 'enrollment-1', userId: 'user-1', programId: 'program-1', status: 'ACTIVE', certificateNo: null as string | null },
    certificate: null as any,
    createdCertificate: null as any,
    request: null as any,
    enrollmentUpdates: [] as any[],
    failTransaction: false,
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
      findUnique: async () => admission,
      findFirst: async () => admission,
      update: async ({ data }: any) => ({ id: 'admission-1', ...data }),
    },
    enrollment: {
      findUnique: async () => state.enrollment,
      update: async ({ data }: any) => { state.enrollmentUpdates.push(data); Object.assign(state.enrollment, data); return state.enrollment },
    },
    program: {
      findUnique: async () => ({ id: 'program-1', titleAr: 'برنامج عربي للاختبار', titleEn: 'Arabic Test Program', price: 1000, category: 'DIPLOMA' }),
    },
    payment: { findMany: async () => [] },
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
      findUnique: async () => ({ id: 'user-1', email: 'student@example.test' }),
    },
    notification: { createMany: async () => ({ count: 1 }), create: async () => ({}) },
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
mock.module('@/lib/notify', () => ({
  notify: async () => {},
  notifyAdmins: async () => {},
  audit: async () => {},
}))
mock.module('@/lib/mailer', () => ({
  emailAdmissionDecision: async () => {},
  emailAdmissionDocumentsRequested: async () => {},
  emailCertificateIssued: async () => {},
}))

const { completeEnrollmentIfEligibleInTransaction, registerGraduationRequest } = await import('../../src/lib/enrollment-completion')
const { POST: graduationAction } = await import('../../src/app/api/admin/graduation-requests/route')
const { PATCH: admissionAction } = await import('../../src/app/api/admin/admissions/route')

function postGraduationAction(action: 'REFRESH' | 'APPROVE' | 'REJECT') {
  return graduationAction(new NextRequest('http://localhost/api/admin/graduation-requests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, requestId: 'grad-1' }),
  }))
}

beforeEach(() => {
  world.state.enrollment = { id: 'enrollment-1', userId: 'user-1', programId: 'program-1', status: 'ACTIVE', certificateNo: null }
  world.state.certificate = null
  world.state.createdCertificate = null
  world.state.request = null
  world.state.enrollmentUpdates = []
  world.state.failTransaction = false
})

describe('graduation approval law', () => {
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
