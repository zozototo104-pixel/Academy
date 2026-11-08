import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ===== رحلة الطالب الكاملة عبر نظام قرار الفصل (الخطوة 6) =====
// قانون المالك: العنصر غير المقدَّم ليس نهائيًا لمجرد أن المحرك
// يحتسبه صفرًا — يصير صفره نهائيًا لغرض الاعتماد فقط عند ثبوت حق
// الإغلاق (رفع ناضج من الطالب أو نهاية فترة الفصل). وعنصر له محاولة
// أو تسليم غير نهائي يبقي الرفض قائمًا مهما كان سبب الإغلاق. محرك
// المعدلات نفسه لا يتغير: gradesComplete تبقى false في العرض.

const UNITS = [
  { id: 'un1', programId: 'p1', semester: 1 },
  { id: 'un1b', programId: 'p1', semester: 1 },
  { id: 'un2', programId: 'p1', semester: 2 },
]
const UNIT_TITLES: Record<string, string> = { un1: 'وحدة ١', un1b: 'وحدة ٢', un2: 'وحدة ٣' }
const UNIT_EXAMS = [
  { id: 'ue1', unitId: 'un1', passScore: 60, status: 'READY' },
  { id: 'ue2', unitId: 'un1b', passScore: 60, status: 'READY' },
  { id: 'ue3', unitId: 'un2', passScore: 60, status: 'READY' },
]
const PROGRAM_EXAMS = [
  { id: 'pe1', title: 'امتحان الفصل الأول', semester: 1, passScore: 60, status: 'READY' },
  { id: 'pe2', title: 'امتحان الفصل الثاني', semester: 2, passScore: 60, status: 'READY' },
]
const ASSIGNMENTS = [{ id: 'as1', title: 'واجب الفصل الأول', points: 100, weight: 10, semester: 1 }]
const RECENT = new Date(Date.now() - 5 * 86400000) // فترة الفصل الأول مفتوحة (45 يومًا من 90)
const OLD = new Date('2026-01-01T00:00:00Z') // فترة الفصل الأول منتهية

function makeWorld() {
  const state: any = {
    createdAt: RECENT,
    unitAttempts: [] as any[],
    programAttempts: [] as any[],
    submissions: new Map<string, any>(),
    gradeApprovals: [] as any[],
    approvals: new Map<string, any>(),
    semesterStates: new Map<string, any>(),
    decisions: new Map<string, any>(),
    outbox: [] as any[],
    mercyRows: [] as any[],
    noProgramExam: false,
  }
  const matchExamId = (a: any, cond: any) => {
    if (cond == null) return true
    if (typeof cond === 'string') return a.examId === cond
    if (Array.isArray(cond.in)) return cond.in.includes(a.examId)
    return true
  }
  const matchAttempt = (a: any, where: any) => {
    if (a.userId !== where.userId) return false
    if (!matchExamId(a, where.examId)) return false
    if (where.status && a.status !== where.status) return false
    if (Object.prototype.hasOwnProperty.call(where, 'score')) {
      if (where.score === null && a.score != null) return false
      if (where.score?.not === null && a.score == null) return false
    }
    if (where.answers?.some && a.answerPointsMissing !== true) return false
    if (where.NOT?.answers?.some && a.answerPointsMissing === true) return false
    if (where.appealStatus) {
      if (typeof where.appealStatus === 'string' && a.appealStatus !== where.appealStatus) return false
      if (where.appealStatus.not && a.appealStatus === where.appealStatus.not) return false
    }
    if (Array.isArray(where.OR)) {
      const ok = where.OR.some((clause: any) => {
        if (Object.prototype.hasOwnProperty.call(clause, 'appealStatus') && clause.appealStatus === null) return a.appealStatus == null
        if (clause.appealStatus?.not) return a.appealStatus !== clause.appealStatus.not
        return false
      })
      if (!ok) return false
    }
    return true
  }
  const enrollmentRow = {
    id: 'enr1', userId: 'u1', programId: 'p1',
    extensionDays: 0, status: 'ACTIVE', finalScore: null,
    program: { semestersCount: 2, category: 'DIPLOMA', maxStudyDays: 90 },
    get createdAt() { return state.createdAt },
  }
  const db: any = {
    $transaction: async (cb: any) => cb(db),
    user: { findUnique: async () => ({ role: 'ADMIN', name: 'مسؤول' }) },
    program: { findUnique: async () => ({ category: 'DIPLOMA', admissionRules: null, semestersCount: 2 }) },
    enrollment: {
      findMany: async ({ where }: any) =>
        where?.status === 'ACTIVE' && enrollmentRow.status === 'ACTIVE' ? [enrollmentRow] : [],
      findUnique: async ({ where }: any) => {
        if (where.id) return where.id === 'enr1' ? enrollmentRow : null
        return enrollmentRow
      },
    },
    unit: {
      findMany: async ({ where }: any) =>
        UNITS.filter((u) => u.programId === where.programId && (where.semester == null || u.semester === where.semester)),
    },
    exam: {
      findMany: async ({ where }: any) => {
        let rows = UNIT_EXAMS
        if (where.unitId?.in) rows = rows.filter((e) => where.unitId.in.includes(e.unitId))
        if (where.unit?.semester) rows = rows.filter((e) => UNITS.find((u) => u.id === e.unitId)?.semester === where.unit.semester)
        return rows.map((e) => ({ ...e, unit: { title: UNIT_TITLES[e.unitId], semester: UNITS.find((u) => u.id === e.unitId)?.semester }, _count: { questions: 5 } }))
      },
    },
    examAttempt: {
      count: async ({ where }: any) => state.unitAttempts.filter((a: any) => matchAttempt(a, where)).length,
      findMany: async ({ where }: any) => state.unitAttempts.filter((a: any) => matchAttempt(a, where)),
    },
    programExam: {
      findMany: async ({ where }: any) =>
        (state.noProgramExam && where.semester === 1 ? [] : PROGRAM_EXAMS).filter((e) => !where.semester || e.semester === where.semester),
    },
    programExamAttempt: {
      count: async ({ where }: any) => state.programAttempts.filter((a: any) => matchAttempt(a, where)).length,
      findMany: async ({ where }: any) => state.programAttempts.filter((a: any) => matchAttempt(a, where)),
    },
    programAssignment: {
      findMany: async ({ where }: any) => ASSIGNMENTS.filter((a) => (!where.semester || a.semester === where.semester) && (!where.status || where.status === 'PUBLISHED')),
    },
    assignmentSubmission: {
      count: async () => 0,
      findMany: async () => [...state.submissions.values()],
      findUnique: async ({ where }: any) => state.submissions.get(`${where.assignmentId_userId.assignmentId}:${where.assignmentId_userId.userId}`) ?? null,
    },
    thesisSubmission: { findFirst: async () => null },
    gradeApproval: {
      findMany: async ({ where }: any) => state.gradeApprovals.filter((r: any) => r.userId === where.userId && r.programId === where.programId && r.semester === where.semester),
    },
    semesterResultApproval: {
      findUnique: async ({ where }: any) => state.approvals.get(`${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const k = `${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`
        const row = { id: 'appr-' + k, ...(state.approvals.get(k) || create), ...update }
        state.approvals.set(k, row)
        return row
      },
    },
    semesterDecision: {
      findMany: async ({ where, take }: any) =>
        [...state.decisions.values()].filter((d: any) => !where?.status || d.status === where.status).slice(0, take ?? 100),
      findUnique: async ({ where }: any) => state.decisions.get(`${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `dec-${data.enrollmentId}-${data.semester}`, ...data }
        state.decisions.set(`${data.enrollmentId}:${data.semester}`, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const k = `${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`
        const row = { ...state.decisions.get(k), ...data }
        state.decisions.set(k, row)
        return row
      },
      updateMany: async ({ where, data }: any) => {
        const k = `${where.enrollmentId}:${where.semester}`
        const existing = state.decisions.get(k)
        // العميل الحقيقي يقبل المساواة المباشرة وقائمة in معًا
        const allowed = typeof where.status === 'string' ? [where.status] : (where.status?.in ?? [])
        if (!existing || !allowed.includes(existing.status)) return { count: 0 }
        state.decisions.set(k, { ...existing, ...data })
        return { count: 1 }
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
    mercyRequest: {
      updateMany: async () => ({ count: 0 }),
    },
  }
  return { state, db }
}

const world = makeWorld()
mock.module('@/lib/db', () => ({ db: world.db }))
mock.module('@/lib/notify', () => ({ audit: async () => {}, notify: async () => {}, notifyAdmins: async () => {} }))
mock.module('@/lib/mailer', () => ({ emailTemplate: (t: string) => t, sendEmailDetailed: async () => 'SKIPPED' }))
const { approveSemesterResult } = await import('../../src/lib/semester-approval')
const { calculateSemesterAverages } = await import('../../src/lib/semester-grade')

const ADMIN = { id: 'admin-1' }
const gradedAttempt = (id: string, examId: string, score: number, passScore = 60) => ({
  id, userId: 'u1', examId, status: 'GRADED', score, passed: score >= passScore, appealStatus: 'NONE', answers: [],
})
const approvalFor = (targetType: string, attempt: any) => ({
  targetType, attemptId: attempt.id, score: attempt.score, userId: 'u1', programId: 'p1', semester: 1,
})

function seedOmissions(state: any) {
  // وحدة ue1 مصححة 90، وحدة ue2 لم تُحاوَل، واجب as1 لم يُسلَّم، امتحان الفصل 80 مصحح
  state.unitAttempts = [gradedAttempt('ua1', 'ue1', 90)]
  state.programAttempts = [gradedAttempt('pa1', 'pe1', 80)]
  state.submissions = new Map()
  state.gradeApprovals = [approvalFor('UNIT_EXAM', state.unitAttempts[0]), approvalFor('PROGRAM_EXAM', state.programAttempts[0])]
}
function seedRaised(state: any) {
  state.decisions.set('enr1:1', {
    id: 'dec1', enrollmentId: 'enr1', semester: 1, intent: 'EARLY_FINISH', status: 'RAISED',
    raiseSource: 'STUDENT', raisedAt: new Date(), scoreAtIntent: 57, scoreAtRaise: 57,
  })
}
const { state } = world

beforeEach(() => {
  state.createdAt = RECENT
  state.unitAttempts = []
  state.programAttempts = []
  state.submissions = new Map()
  state.gradeApprovals = []
  state.approvals = new Map()
  state.semesterStates = new Map()
  state.decisions = new Map()
  state.outbox = []
  state.noProgramExam = false
})


const { requestSemesterDecision } = await import('../../src/lib/semester-raise')
const { withdrawSemesterRaise, materializeDeadlineRaises } = await import('../../src/lib/semester-decision')
const { matureSemesterRaisesAfterGrading } = await import('../../src/lib/semester-raise-hooks')

const ctxFor = () => ({
  enrollment: { createdAt: state.createdAt, status: 'ACTIVE', extensionDays: 0 },
  program: { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 },
})
const gradedProgramAttempt = (id: string, examId: string, score: number) => ({
  id, userId: 'u1', examId, status: 'GRADED', score, finalScore: score, passed: score >= 60,
  appealStatus: 'NONE',
  answers: [{ points: score / 2, maxPoints: 50 }, { points: score / 2, maxPoints: 50 }],
})

describe('رحلة الطالب: اختيار → نضج → اعتماد', () => {
  test('J1-J3: إنهاء مبكر قبل الامتحان يُحفظ نية، وبعد الجلوس والتصحيح والمصادقة يرتفع، والإدارة تعتمد', async () => {
    // J1: الطالب يختار الإنهاء المبكر قبل أن يجلس الامتحان
    seedOmissions(state)
    state.programAttempts = []
    state.gradeApprovals = [approvalFor('UNIT_EXAM', state.unitAttempts[0])]
    const choice = await requestSemesterDecision(world.db, {
      enrollmentId: 'enr1', userId: 'u1', programId: 'p1', semester: 1, intent: 'EARLY_FINISH', ...ctxFor(),
    })
    expect(choice.ok).toBe(true)
    expect(state.decisions.get('enr1:1')?.status).toBe('INTENT')
    // J2: يجلس الامتحان ويُصحَّح وتُصادق درجته — حدث التصحيح ينضّج الطلب
    state.programAttempts = [gradedProgramAttempt('pa1', 'pe1', 80)]
    state.gradeApprovals.push(approvalFor('PROGRAM_EXAM', state.programAttempts[0]))
    await matureSemesterRaisesAfterGrading(world.db, { enrollmentId: 'enr1' })
    const raised = state.decisions.get('enr1:1')
    expect(raised?.status).toBe('RAISED')
    expect(raised?.scoreAtRaise).toBe(57)
    // J3: الإدارة تعتمد — الصفر المحسوب للإغفالات داخل المعدل المحفوظ
    const decision = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(true)
    expect(state.approvals.get('enr1:1')?.score).toBe(57)
    expect(state.decisions.get('enr1:1')?.status).toBe('DECIDED')
    expect(state.semesterStates.get('enr1:1')?.status).toBe('CLOSED')
  })

  test('J4: سحب الطلب ثم تصحيح متأخر — لا قيامة للمسحوب، والاعتماد مرفوض بلا رفع', async () => {
    seedOmissions(state)
    state.programAttempts = [gradedProgramAttempt('pa1', 'pe1', 80)]
    state.gradeApprovals.push(approvalFor('PROGRAM_EXAM', state.programAttempts[0]))
    const choice = await requestSemesterDecision(world.db, {
      enrollmentId: 'enr1', userId: 'u1', programId: 'p1', semester: 1, intent: 'EARLY_FINISH', ...ctxFor(),
    })
    expect(choice.ok).toBe(true)
    expect(state.decisions.get('enr1:1')?.status).toBe('RAISED')
    const withdrawn = await withdrawSemesterRaise(world.db, { enrollmentId: 'enr1', userId: 'u1', semester: 1 })
    expect(withdrawn.ok).toBe(true)
    await matureSemesterRaisesAfterGrading(world.db, { enrollmentId: 'enr1' })
    expect(state.decisions.get('enr1:1')?.status).toBe('WITHDRAWN')
    // أكمل كل درجاته: الرفض الآن هو بوابة الإغلاق نفسها
    state.unitAttempts.push(gradedAttempt('ua2', 'ue2', 70))
    state.submissions.set('as1:u1', { assignmentId: 'as1', userId: 'u1', status: 'GRADED', score: 70 })
    state.gradeApprovals.push(approvalFor('UNIT_EXAM', state.unitAttempts[1]))
    const decision = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(false)
    if (!decision.ok) expect(decision.code).toBe('SEMESTER_NOT_RAISED')
  })

  test('J5: نية قديمة تنتهي فترتها — كرون المهلة يجسّد الرفع ثم يمر الاعتماد', async () => {
    seedOmissions(state)
    const choice = await requestSemesterDecision(world.db, {
      enrollmentId: 'enr1', userId: 'u1', programId: 'p1', semester: 1, intent: 'EARLY_FINISH', ...ctxFor(),
    })
    expect(choice.ok).toBe(true)
    expect(state.decisions.get('enr1:1')?.status).toBe('INTENT')
    state.createdAt = OLD // انتهى الفصل الأول وحده في نقطة الفحص
    const swept = await materializeDeadlineRaises(world.db, {
      now: new Date('2026-03-01T00:00:00Z'),
    })
    expect(swept).toBe(1)
    expect(state.decisions.get('enr1:1')?.status).toBe('RAISED')
    expect(state.decisions.get('enr1:1')?.raiseSource).toBe('DEADLINE')
    const decision = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(true)
    expect(state.approvals.get('enr1:1')?.score).toBe(57)
  })

  test('J6: شكل عبيدة — لم يجلس امتحان الفصل قط: النية لا تنضج والاعتماد مرفوض أثناء الفترة، وبعد نهايتها يمر بصفر الامتحان المنشور', async () => {
    seedOmissions(state)
    state.programAttempts = [] // لم يجلس امتحان الفصل أبدًا
    state.gradeApprovals = [approvalFor('UNIT_EXAM', state.unitAttempts[0])]
    const choice = await requestSemesterDecision(world.db, {
      enrollmentId: 'enr1', userId: 'u1', programId: 'p1', semester: 1, intent: 'EARLY_FINISH', ...ctxFor(),
    })
    expect(choice.ok).toBe(true)
    // النية محفوظة لكنها لا تنضج: امتحان الفصل لم يُقدَّم
    expect(state.decisions.get('enr1:1')?.status).toBe('INTENT')
    const duringWindow = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: ADMIN })
    expect(duringWindow.ok).toBe(false)
    expect(state.approvals.size).toBe(0)
    // بعد نهاية الفترة: الصفر النظامي للامتحان المنشور غير المقدَّم
    state.createdAt = OLD
    const afterEnd = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: ADMIN })
    expect(afterEnd.ok).toBe(true)
    // امتحان الفصل صفر نظامي بعد نهاية الفترة: (45×0.2 + 0×0.2 + 0×0.6) = 9
    expect(state.approvals.get('enr1:1')?.score).toBe(9)
  })
})
