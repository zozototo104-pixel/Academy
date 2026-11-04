import { describe, test, expect, mock, beforeEach } from 'bun:test'

// ===== حارس اعتماد نتيجة الفصل (المرحلة 2 من خطة دورة التخرج) =====
// اعتماد نتيجة الفصل سجل قرار مستقل (SemesterResultApproval) لا علاقة له
// بمراجعة التصحيح (reviewedById/reviewedAt). الحارس يرفض الاعتماد ما دامت
// في الفصل درجة قيد المراجعة أو التماس درجات معلّق، والاعتماد نفسه يبقى
// خاملًا بقرار الترتيب حتى تكتمل مرحلتا معدلات الفصول ودورة الحياة.

function makeWorld() {
  const units = [
    { id: 'unit-s1', programId: 'program-1', semester: 1 },
    { id: 'unit-s2', programId: 'program-1', semester: 2 },
  ]
  const exams = [
    { id: 'exam-s1', unitId: 'unit-s1' },
    { id: 'exam-s2', unitId: 'unit-s2' },
  ]
  const programExams = [
    { id: 'pexam-s1', programId: 'program-1', semester: 1 },
    { id: 'pexam-s2', programId: 'program-1', semester: 2 },
  ]
  const state: any = {
    enrollment: { id: 'enrollment-1', userId: 'user-1', programId: 'program-1' },
    unitAttempts: [] as any[],
    programAttempts: [] as any[],
    pendingAssignments: 0,
    approvals: new Map<string, any>(),
    throwOnApprovalRead: false,
  }
  const inList = (v: string, cond: any) => !cond || !cond.in || cond.in.includes(v)
  const matchAttempt = (a: any, where: any) =>
    a.userId === where.userId &&
    inList(a.examId, where.examId) &&
    (!where.status || a.status === where.status) &&
    (!Object.prototype.hasOwnProperty.call(where, 'score') || (where.score === null && a.score == null)) &&
    (!where.appealStatus || a.appealStatus === where.appealStatus)
  const db: any = {
    $transaction: async (cb: any) => cb(db),
    enrollment: {
      findUnique: async ({ where }: any) => (where.id === state.enrollment.id ? state.enrollment : null),
    },
    unit: {
      findMany: async ({ where }: any) => units.filter((u) => u.programId === where.programId && u.semester === where.semester),
    },
    exam: { findMany: async ({ where }: any) => exams.filter((e) => inList(e.unitId, where.unitId)) },
    programExam: {
      findMany: async ({ where }: any) => programExams.filter((e) => e.programId === where.programId && e.semester === where.semester),
    },
    examAttempt: { count: async ({ where }: any) => state.unitAttempts.filter((a: any) => matchAttempt(a, where)).length },
    programExamAttempt: { count: async ({ where }: any) => state.programAttempts.filter((a: any) => matchAttempt(a, where)).length },
    programAssignment: { findMany: async ({ where }: any) => where.semester === 1 ? [{ id: 'assignment-s1' }] : [] },
    assignmentSubmission: { count: async () => state.pendingAssignments },
    semesterResultApproval: {
      findUnique: async ({ where }: any) => {
        if (state.throwOnApprovalRead) throw new Error('table missing')
        const k = where.enrollmentId_semester
        return state.approvals.get(`${k.enrollmentId}:${k.semester}`) ?? null
      },
      upsert: async ({ where, create }: any) => {
        const k = where.enrollmentId_semester
        const row = { id: `approval-${k.enrollmentId}-${k.semester}`, ...create }
        state.approvals.set(`${k.enrollmentId}:${k.semester}`, row)
        return row
      },
    },
  }
  return { state, db }
}

const world = makeWorld()
mock.module('@/lib/db', () => ({ db: world.db }))
mock.module('@/lib/notify', () => ({ audit: async () => {}, notify: async () => {}, notifyAdmins: async () => {} }))
const { approveSemesterResult, collectSemesterApprovalBlockers, storedSemesterApproval, SEMESTER_APPROVAL_ACTIVE } =
  await import('../../src/lib/semester-approval')

const ADMIN = { id: 'admin-1' }

beforeEach(() => {
  world.state.unitAttempts = []
  world.state.programAttempts = []
  world.state.pendingAssignments = 0
  world.state.approvals = new Map()
  world.state.throwOnApprovalRead = false
})

describe('حارس اعتماد نتيجة الفصل', () => {
  test('واجب غير مصحح يمنع اعتماد فصله دون حجب الفصل الثاني', async () => {
    world.state.pendingAssignments = 1
    const blocked = await collectSemesterApprovalBlockers(world.db, { userId: 'user-1', programId: 'program-1', semester: 1 })
    expect(blocked).toEqual([{ code: 'ASSIGNMENT_GRADING_PENDING', count: 1 }])
    const second = await collectSemesterApprovalBlockers(world.db, { userId: 'user-1', programId: 'program-1', semester: 2 })
    expect(second).toEqual([])
  })
  test('رفض رقم فصل غير صالح قبل الوصول لقاعدة البيانات', async () => {
    const result = await approveSemesterResult({ enrollmentId: 'enrollment-1', semester: 0, actor: ADMIN })
    expect(result).toEqual({ ok: false, code: 'INVALID_SEMESTER_APPROVAL_INPUT' })
  })
  test('محاولة وحدة بانتظار تأكيد المراجعة تمنع الاعتماد', async () => {
    world.state.unitAttempts = [{ userId: 'user-1', examId: 'exam-s1', status: 'NEEDS_REVIEW', appealStatus: 'NONE' }]
    const blockers = await collectSemesterApprovalBlockers(world.db, { userId: 'user-1', programId: 'program-1', semester: 1 })
    expect(blockers).toEqual([{ code: 'UNIT_REVIEW_PENDING', count: 1 }])
    const decision = await approveSemesterResult({ enrollmentId: 'enrollment-1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.code).toBe('SEMESTER_GRADES_INCOMPLETE')
  })

  test('محاولة امتحان فصل بانتظار المراجعة تمنع الاعتماد', async () => {
    world.state.programAttempts = [{ userId: 'user-1', examId: 'pexam-s1', status: 'NEEDS_REVIEW', appealStatus: 'NONE' }]
    const decision = await approveSemesterResult({ enrollmentId: 'enrollment-1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe('SEMESTER_GRADES_INCOMPLETE')
      expect(decision.blockers).toEqual([{ code: 'PROGRAM_EXAM_REVIEW_PENDING', count: 1 }])
    }
  })

  test('التماسات الدرجات المعلّقة تمنع الاعتماد بنوعيها', async () => {
    world.state.unitAttempts = [{ userId: 'user-1', examId: 'exam-s1', status: 'GRADED', score: 70, appealStatus: 'PENDING' }]
    world.state.programAttempts = [{ userId: 'user-1', examId: 'pexam-s1', status: 'GRADED', score: 70, appealStatus: 'PENDING' }]
    const blockers = await collectSemesterApprovalBlockers(world.db, { userId: 'user-1', programId: 'program-1', semester: 1 })
    expect(blockers.map((b: any) => b.code).sort()).toEqual(['PROGRAM_EXAM_APPEAL_PENDING', 'UNIT_APPEAL_PENDING'])
  })

  test('موانع الفصل الثاني لا تحجب الفصل الأول، والاعتماد النظيف يصطدم بحارس الترتيب', async () => {
    world.state.unitAttempts = [{ userId: 'user-1', examId: 'exam-s2', status: 'NEEDS_REVIEW', appealStatus: 'NONE' }]
    world.state.programAttempts = [{ userId: 'user-1', examId: 'pexam-s2', status: 'NEEDS_REVIEW', appealStatus: 'NONE' }]
    const blockers = await collectSemesterApprovalBlockers(world.db, { userId: 'user-1', programId: 'program-1', semester: 1 })
    expect(blockers).toEqual([])
    expect(SEMESTER_APPROVAL_ACTIVE).toBe(false)
    const decision = await approveSemesterResult({ enrollmentId: 'enrollment-1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.code).toBe('SEMESTER_APPROVAL_NOT_ACTIVE')
    expect(world.state.approvals.size).toBe(0)
  })

  test('تسجيل غير موجود يُرفض برمزه الخاص', async () => {
    const decision = await approveSemesterResult({ enrollmentId: 'missing', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.code).toBe('ENROLLMENT_NOT_FOUND')
  })

  test('قراءة الاعتماد المحفوظ فاشلة بأمان عند غياب الجدول', async () => {
    world.state.throwOnApprovalRead = true
    expect(await storedSemesterApproval(world.db, 'enrollment-1', 1)).toBeNull()
    world.state.throwOnApprovalRead = false
    world.state.approvals.set('enrollment-1:1', { id: 'approval-1', status: 'APPROVED' })
    expect((await storedSemesterApproval(world.db, 'enrollment-1', 1))?.id).toBe('approval-1')
  })
})
