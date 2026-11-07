import { describe, expect, mock, test } from 'bun:test'

// تفعيل اعتماد نتيجة الفصل (المرحلة 4): الاعتماد الناجح يخزّن المتوسط
// المحسوب خادميًا من قواعد الطالب المجمّدة، ويُغلق الفصل ذرّيًا، ويضع
// أحداث الإشعار في الصادر — وتغيّر درجة لاحق يجعل الاعتماد STALE.
const W1 = [
  { key: 'semester1_quizzes', label: 'اختبارات الفصل الأول القصيرة', weight: 10 },
  { key: 'semester1_exam', label: 'امتحان الفصل الأول', weight: 20 },
  { key: 'semester2_quizzes', label: 'اختبارات الفصل الثاني القصيرة', weight: 10 },
  { key: 'semester2_exam', label: 'امتحان الفصل الثاني', weight: 20 },
  { key: 'thesis', label: 'بحث التخرج المهني', weight: 25 },
  { key: 'defense', label: 'المناقشة النهائية', weight: 15 },
]
const { gradingFormulaSignature } = await import('../../src/lib/program-tracks')
const ADMISSION_RULES = {
  academicProfile: {
    finalEvaluationFormula: W1,
    approvedFormulaSignature: gradingFormulaSignature(W1),
    approvedFormulaAt: '2026-01-01T00:00:00Z',
  },
}

function makeWorld(unitScore: number) {
  const state: any = {
    unitAttempts: [
      { id: 'ea1', userId: 'u1', examId: 'ue1', status: 'GRADED', score: unitScore, passed: unitScore >= 60, appealStatus: 'NONE', answers: [] },
    ],
    programAttempts: [
      { id: 'pa1', userId: 'u1', examId: 'pe1', status: 'GRADED', score: 40, passed: true, appealStatus: 'NONE', answers: [] },
    ],
    gradeApprovals: [
      { targetType: 'UNIT_EXAM', attemptId: 'ea1', score: unitScore, userId: 'u1', programId: 'p1', semester: 1 },
      { targetType: 'PROGRAM_EXAM', attemptId: 'pa1', score: 40, userId: 'u1', programId: 'p1', semester: 1 },
    ],
    approvals: new Map<string, any>(),
    semesterStates: new Map<string, any>(),
    outbox: [] as any[],
    role: 'ADMIN',
  }
  const inList = (v: string, cond: any) => !cond || !cond.in || cond.in.includes(v)
  const matchAttempt = (a: any, where: any) =>
    a.userId === where.userId && inList(a.examId, where.examId) &&
    (!where.status || a.status === where.status) &&
    (!Object.prototype.hasOwnProperty.call(where, 'score') || (where.score === null ? a.score == null : where.score?.not === null ? a.score != null : true)) &&
    (!where.answers?.some || a.answerPointsMissing === true) &&
    (!where.NOT?.answers || a.answerPointsMissing !== true) &&
    (!where.appealStatus || (where.appealStatus.not ? a.appealStatus !== where.appealStatus.not : a.appealStatus === where.appealStatus))
  const db: any = {
    $transaction: async (cb: any) => cb(db),
    user: { findUnique: async () => ({ role: state.role, name: 'مسؤول' }) },
    program: { findUnique: async () => ({ category: 'MASTERS', admissionRules: ADMISSION_RULES, semestersCount: 2, maxStudyDays: 180 }) },
    enrollment: {
      findUnique: async ({ where }: any) => {
        const row = { id: 'enr1', userId: 'u1', programId: 'p1', createdAt: new Date('2026-06-01T00:00:00Z'), extensionDays: 0, status: 'ACTIVE', finalScore: null, program: { semestersCount: 2, category: 'MASTERS', maxStudyDays: 180 } }
        if (where.id) return where.id === 'enr1' ? row : null
        return row
      },
    },
    unit: { findMany: async () => [{ id: 'un1', semester: 1, order: 1 }, { id: 'un2', semester: 2, order: 1 }] },
    exam: {
      findMany: async ({ where }: any) => [
        { id: 'ue1', unitId: 'un1', passScore: 60, unit: { title: 'وحدة ١', semester: 1 }, _count: { questions: 5 } },
        { id: 'ue2', unitId: 'un2', passScore: 60, unit: { title: 'وحدة ٢', semester: 2 }, _count: { questions: 5 } },
      ].filter((e) => (!where.unitId || inList(e.unitId, where.unitId)) && (!where.unit?.semester || e.unit.semester === where.unit.semester)),
    },
    examAttempt: {
      count: async ({ where }: any) => state.unitAttempts.filter((a: any) => matchAttempt(a, where)).length,
      findMany: async ({ where }: any) => state.unitAttempts.filter((a: any) => matchAttempt(a, where)),
    },
    programExam: {
      findMany: async ({ where }: any) => [
        { id: 'pe1', title: 'امتحان الفصل الأول', semester: 1, passScore: 30 },
        { id: 'pe2', title: 'امتحان الفصل الثاني', semester: 2, passScore: 60 },
      ].filter((e) => !where.semester || e.semester === where.semester),
    },
    programExamAttempt: {
      count: async ({ where }: any) => state.programAttempts.filter((a: any) => matchAttempt(a, where)).length,
      findMany: async ({ where }: any) => state.programAttempts.filter((a: any) => matchAttempt(a, where)),
    },
    programAssignment: { findMany: async () => [] },
    assignmentSubmission: { count: async () => 0, findMany: async () => [], findUnique: async () => null },
    thesisSubmission: { findFirst: async () => null },
    gradeApproval: { findMany: async () => state.gradeApprovals },
    semesterResultApproval: {
      findUnique: async ({ where }: any) => state.approvals.get(`${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const k = `${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`
        const row = { id: 'appr-' + k, ...(state.approvals.get(k) || create), ...update }
        state.approvals.set(k, row)
        return row
      },
    },
    enrollmentSemesterState: {
      findUnique: async ({ where }: any) => state.semesterStates.get(`${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `st-${data.enrollmentId}-${data.semester}`, ...data }
        state.semesterStates.set(`${data.enrollmentId}:${data.semester}`, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const k = `${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`
        const row = { ...state.semesterStates.get(k), ...data }
        state.semesterStates.set(k, row)
        return row
      },
    },
    notificationOutbox: {
      create: async ({ data }: any) => { const row = { id: 'ob-' + state.outbox.length, ...data }; state.outbox.push(row); return row },
      findUnique: async ({ where }: any) => state.outbox.find((r: any) => r.idempotencyKey === where.idempotencyKey) ?? null,
    },
  }
  return { state, db }
}

const world = makeWorld(100)
mock.module('@/lib/db', () => ({ db: world.db }))
mock.module('@/lib/notify', () => ({ audit: async () => {}, notify: async () => {}, notifyAdmins: async () => {} }))
mock.module('@/lib/mailer', () => ({ emailTemplate: (t: string) => t, sendEmailDetailed: async () => 'SKIPPED' }))
const { approveSemesterResult, semesterApprovalState } = await import('../../src/lib/semester-approval')
const { getSemesterWindows } = await import('../../src/lib/semester-lifecycle')

const ENROLLMENT = { id: 'enr1', userId: 'u1', programId: 'p1' }
function reset(unitScore: number, role = 'ADMIN') {
  const fresh = makeWorld(unitScore)
  world.state.unitAttempts = fresh.state.unitAttempts
  world.state.programAttempts = fresh.state.programAttempts
  world.state.gradeApprovals = fresh.state.gradeApprovals
  world.state.approvals = fresh.state.approvals
  world.state.semesterStates = fresh.state.semesterStates
  world.state.outbox = fresh.state.outbox
  world.state.role = role
}

describe('تفعيل اعتماد نتيجة الفصل ودورة حياته (المرحلة 4)', () => {
  test('نوافذ الفصول: تقسيم متساوٍ للمدة والباقي للأخير', () => {
    const day = 86_400_000
    const windows = getSemesterWindows(new Date('2026-01-01T00:00:00Z'), { category: 'MASTERS', maxStudyDays: 181, semestersCount: 2 }, [])
    expect(windows.length).toBe(2)
    // متجاورة بلا فجوات، ومجموعها المدة كاملة، والباقي (يوم) للفصل الأخير:
    expect(windows[1].startAt.getTime()).toBe(windows[0].endAt.getTime())
    expect(Math.round((windows[0].endAt.getTime() - windows[0].startAt.getTime()) / day)).toBe(90)
    expect(Math.round((windows[1].endAt.getTime() - windows[1].startAt.getTime()) / day)).toBe(91)
  })

  test('اعتماد ناجح: يُخزّن المتوسط المحسوب، يُغلق الفصل، ويُشعر الطالب', async () => {
    reset(100)
    const decision = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: { id: 'admin-1' } })
    expect(decision.ok).toBe(true)
    // المعدل من قواعد الطالب: (100×10 + 40×20)/30 = 60
    const stored = world.state.approvals.get('enr1:1')
    expect(stored.score).toBe(60)
    const st = world.state.semesterStates.get('enr1:1')
    expect(st.status).toBe('CLOSED')
    expect(st.result).toBe('PASSED')
    expect(st.approvedScore).toBe(60)
    expect(world.state.outbox.map((r: any) => r.kind)).toEqual(['SEMESTER_CLOSED'])
    expect(await semesterApprovalState(world.db, ENROLLMENT, 1)).toBe('APPROVED')
  })

  test('تغيّر درجة بعد الاعتماد يجعل الاعتماد STALE دون محو قراره', async () => {
    reset(100)
    await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: { id: 'admin-1' } })
    world.state.unitAttempts[0].score = 50
    expect(await semesterApprovalState(world.db, ENROLLMENT, 1)).toBe('STALE')
    expect(world.state.approvals.get('enr1:1').score).toBe(60)
  })

  test('فصل راسب: يُغلق بالرسوب ويُشعر الإدارة بإمكانية الاسترحام', async () => {
    reset(20)
    const decision = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: { id: 'admin-1' } })
    expect(decision.ok).toBe(true)
    const st = world.state.semesterStates.get('enr1:1')
    expect(st.result).toBe('FAILED')
    expect(world.state.outbox.map((r: any) => r.kind)).toContain('SEMESTER_FAILED')
  })

  test('غير الإداري مرفوض، ودرجة العميل المختلفة عن المحسوبة مرفوضة', async () => {
    reset(100, 'SUPERVISOR')
    const forbidden = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: { id: 'sup-1' } })
    expect(forbidden).toEqual({ ok: false, code: 'SEMESTER_APPROVAL_FORBIDDEN' })
    reset(100)
    const mismatch = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: { id: 'admin-1' }, score: 61 })
    expect(mismatch).toEqual({ ok: false, code: 'SEMESTER_SCORE_NOT_VERIFIED' })
    expect(world.state.approvals.size).toBe(0)
  })
})
