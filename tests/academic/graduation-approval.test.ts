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
      create: async ({ data }: any) => { state.request = { id: 'grad-1', ...data }; return state.request },
      update: async ({ data }: any) => { Object.assign(state.request, data); return state.request },
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

const { completeEnrollmentIfEligibleInTransaction, registerGraduationRequest } = await import('../../src/lib/enrollment-completion')

beforeEach(() => {
  world.state.enrollment = { id: 'enrollment-1', userId: 'user-1', programId: 'program-1', status: 'ACTIVE', certificateNo: null }
  world.state.certificate = null
  world.state.createdCertificate = null
  world.state.request = null
  world.state.enrollmentUpdates = []
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

  test('a refresh after a score change returns the transaction to PENDING with the new score', async () => {
    await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    world.state.request.status = 'APPROVED'
    world.state.request.decidedById = 'admin-1'
    world.state.request.decidedAt = new Date()
    world.state.request.score = 88
    const again = await registerGraduationRequest({ enrollmentId: 'enrollment-1' })
    expect(again.registered).toBe(true)
    expect(world.state.request.status).toBe('PENDING')
    expect(world.state.request.decidedById).toBeNull()
    expect(world.state.request.score).toBe(95)
    const result = await completeEnrollmentIfEligibleInTransaction(world.tx, { enrollmentId: 'enrollment-1', admissionId: 'admission-1' })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ADMIN_GRADUATION_APPROVAL_REQUIRED')
    expect(world.state.createdCertificate).toBeNull()
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
