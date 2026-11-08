import { beforeEach, describe, expect, mock, test } from 'bun:test'

// ===== اعتماد نتيجة الفصل بمكوّنات راسبة (إصلاح U03/H2) =====
// الاكتمال الذي يحرس قرار الاعتماد هو نهائية التصحيح لا نجاح كل مكوّن:
// كل تقييم مطلوب له نتيجة نهائية مصحَّحة ومعتمدة (بما فيها الراسب
// والصفر)، ولا إجراء مفتوحًا. النجاح/الرسوب يُحسم من المعدل وحده أمام
// الحدّ الصارم (> 50). قبل الإصلاح كان entry.complete (نجاح كل مكوّن)
// يمنع الاعتماد بنتيجتيه، فلا يُغلق فصل راسب أبدًا ويموت الاسترحام.
//
// كل الحالات هنا ينتجها التصحيح الحقيقي: passed = score >= passScore.

const UNITS = [
  { id: 'un1', programId: 'p1', semester: 1 },
  { id: 'un1b', programId: 'p1', semester: 1 },
  { id: 'un2', programId: 'p1', semester: 2 },
]
const UNIT_TITLES: Record<string, string> = { un1: 'وحدة ١', un1b: 'وحدة ٢', un2: 'وحدة ٣' }
const UNIT_EXAMS = [
  { id: 'ue1', unitId: 'un1', passScore: 60 },
  { id: 'ue2', unitId: 'un1b', passScore: 60 },
  { id: 'ue3', unitId: 'un2', passScore: 60 },
]
const PROGRAM_EXAMS = [
  { id: 'pe1', title: 'امتحان الفصل الأول', semester: 1, passScore: 60 },
  { id: 'pe2', title: 'امتحان الفصل الثاني', semester: 2, passScore: 60 },
]
const ASSIGNMENTS = [{ id: 'as1', title: 'واجب الفصل الأول', points: 100, weight: 10, semester: 1 }]

function makeWorld() {
  const state: any = {
    unitAttempts: [] as any[],
    programAttempts: [] as any[],
    submissions: new Map<string, any>(),
    gradeApprovals: [] as any[],
    approvals: new Map<string, any>(),
    semesterStates: new Map<string, any>(),
    outbox: [] as any[],
    mercyRows: [] as any[],
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
    // Prisma uses status: { in: [...] } to detect an actually submitted
    // semester exam. A test double must model this filter correctly.
    if (where.status && (typeof where.status === 'string'
      ? a.status !== where.status
      : Array.isArray(where.status?.in) && !where.status.in.includes(a.status))) return false
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
  const matchMercy = (row: any, where: any) =>
    Object.entries(where || {}).every(([k, v]: any) => {
      if (v === undefined) return true
      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k])
      if (v && typeof v === 'object' && 'lt' in v) return new Date(row[k]).getTime() < new Date(v.lt).getTime()
      return row[k] === v
    })
  let mercySeq = 0
  const enrollmentRow = {
    id: 'enr1', userId: 'u1', programId: 'p1', createdAt: new Date('2026-06-01T00:00:00Z'),
    extensionDays: 0, status: 'ACTIVE', finalScore: null,
    program: { semestersCount: 2, category: 'DIPLOMA', maxStudyDays: 90 },
  }
  const db: any = {
    $transaction: async (cb: any) => cb(db),
    user: { findUnique: async () => ({ role: 'ADMIN', name: 'مسؤول' }) },
    program: { findUnique: async () => ({ category: 'DIPLOMA', admissionRules: null, semestersCount: 2 }) },
    enrollment: {
      findUnique: async ({ where }: any) => {
        if (where.id) return where.id === 'enr1' ? enrollmentRow : null
        return enrollmentRow
      },
    },
    unit: {
      findMany: async ({ where }: any) => UNITS.filter((u) => u.programId === where.programId && u.semester === where.semester),
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
      findMany: async ({ where }: any) => PROGRAM_EXAMS.filter((e) => (!where.semester || e.semester === where.semester)),
    },
    programExamAttempt: {
      count: async ({ where }: any) => state.programAttempts.filter((a: any) => matchAttempt(a, where)).length,
      findMany: async ({ where }: any) => state.programAttempts.filter((a: any) => matchAttempt(a, where)),
    },
    programAssignment: {
      findMany: async ({ where }: any) => ASSIGNMENTS.filter((a) => (!where.semester || a.semester === where.semester) && (!where.status || where.status === 'PUBLISHED')),
    },
    assignmentSubmission: {
      count: async ({ where }: any) => {
        const ids = where.assignmentId?.in || []
        return [...state.submissions.values()].filter((s: any) =>
          s.userId === where.userId && ids.includes(s.assignmentId) &&
          ((where.OR || []).some((c: any) =>
            (c.status?.in ? c.status.in.includes(s.status) : s.status === c.status) &&
            (!Object.prototype.hasOwnProperty.call(c, 'score') || (c.score === null ? s.score == null : true)),
          )),
        ).length
      },
      findMany: async () => [],
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
      create: async ({ data }: any) => { const row = { id: `mercy-${++mercySeq}`, ...data }; state.mercyRows.push(row); return row },
      findUnique: async ({ where }: any) => {
        if (where.id) return state.mercyRows.find((r: any) => r.id === where.id) ?? null
        const k = where.enrollmentId_semester
        return state.mercyRows.find((r: any) => r.enrollmentId === k.enrollmentId && r.semester === k.semester) ?? null
      },
      findFirst: async ({ where }: any) => state.mercyRows.find((r: any) => matchMercy(r, where)) ?? null,
      findMany: async ({ where }: any) => state.mercyRows.filter((r: any) => matchMercy(r, where)),
      updateMany: async ({ where, data }: any) => {
        let count = 0
        for (const row of state.mercyRows) if (matchMercy(row, where)) { Object.assign(row, data); count++ }
        return { count }
      },
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
const { requestMercy } = await import('../../src/lib/mercy')

const ADMIN = { id: 'admin-1' }
const gradedAttempt = (id: string, examId: string, score: number, passScore = 60) => ({
  id, userId: 'u1', examId, status: 'GRADED', score, passed: score >= passScore, appealStatus: 'NONE', answers: [],
})
const approvalFor = (targetType: string, attempt: any) => ({
  targetType, attemptId: attempt.id, score: attempt.score, userId: 'u1', programId: 'p1', semester: 1,
})

function seedPassingWithFailedUnit() {
  // اختبارا وحدة: 50 (راسب، حدّ النجاح 60) و100 — متوسط الاختبارات 75
  world.state.unitAttempts = [gradedAttempt('ua1', 'ue1', 50), gradedAttempt('ua2', 'ue2', 100)]
  // امتحان الفصل: 70 ناجح — والواجب: 70 مصحَّح
  world.state.programAttempts = [gradedAttempt('pa1', 'pe1', 70)]
  world.state.submissions = new Map([['as1:u1', { assignmentId: 'as1', userId: 'u1', status: 'GRADED', score: 70 }]])
  world.state.gradeApprovals = [
    approvalFor('UNIT_EXAM', world.state.unitAttempts[0]),
    approvalFor('UNIT_EXAM', world.state.unitAttempts[1]),
    approvalFor('PROGRAM_EXAM', world.state.programAttempts[0]),
  ]
}

function seedFailingSemester() {
  // كل شيء مصحَّح ومعتمد، وبعضه راسب: وحدتان 20 و30، واجب 40، امتحان فصل 35
  world.state.unitAttempts = [gradedAttempt('ua1', 'ue1', 20), gradedAttempt('ua2', 'ue2', 30)]
  world.state.programAttempts = [gradedAttempt('pa1', 'pe1', 35)]
  world.state.submissions = new Map([['as1:u1', { assignmentId: 'as1', userId: 'u1', status: 'GRADED', score: 40 }]])
  world.state.gradeApprovals = [
    approvalFor('UNIT_EXAM', world.state.unitAttempts[0]),
    approvalFor('UNIT_EXAM', world.state.unitAttempts[1]),
    approvalFor('PROGRAM_EXAM', world.state.programAttempts[0]),
  ]
}

beforeEach(() => {
  world.state.unitAttempts = []
  world.state.programAttempts = []
  world.state.submissions = new Map()
  world.state.gradeApprovals = []
  world.state.approvals = new Map()
  world.state.semesterStates = new Map()
  world.state.outbox = []
  world.state.mercyRows = []
})

describe('اعتماد فصل فيه مكوّن راسب (U03/H2)', () => {
  test('(أ) معدل 71 مع اختبار وحدة راسب واحد ⟹ اعتماد ناجح وإغلاق PASSED', async () => {
    seedPassingWithFailedUnit()
    const averages = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client: world.db })
    const s1 = averages.semesters.find((s) => s.semester === 1)
    // (75×20 + 70×20 + 70×60)/100 = 71
    expect(s1?.average).toBe(71)
    expect(s1?.passed).toBe(true)
    // الفصلان مفصولان: التصحيح نهائي بالكامل، والاكتمال بمعنى «الكل ناجح» غير متحقق
    expect(s1?.gradesComplete).toBe(true)
    expect(s1?.complete).toBe(false)

    const decision = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(true)
    expect(world.state.approvals.get('enr1:1').score).toBe(71)
    const st = world.state.semesterStates.get('enr1:1')
    expect(st.status).toBe('CLOSED')
    expect(st.result).toBe('PASSED')
  })

  test('(ب) تصحيح مكتمل ومعدل 34 مع مكوّنات راسبة ⟹ اعتماد راسب وإغلاق واسترحام متاح', async () => {
    seedFailingSemester()
    const averages = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client: world.db })
    const s1 = averages.semesters.find((s) => s.semester === 1)
    // (25×20 + 40×20 + 35×60)/100 = 34
    expect(s1?.average).toBe(34)
    expect(s1?.passed).toBe(false)
    expect(s1?.gradesComplete).toBe(true)
    expect(s1?.complete).toBe(false)

    const decision = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(true)
    expect(world.state.approvals.get('enr1:1').score).toBe(34)
    const st = world.state.semesterStates.get('enr1:1')
    expect(st.status).toBe('CLOSED')
    expect(st.result).toBe('FAILED')

    // باب الاسترحام كان ميتًا لهذا الطالب قبل الإصلاح:
    const mercy = await requestMercy(world.db, { userId: 'u1', programId: 'p1', semester: 1 })
    expect(mercy.ok).toBe(true)
  })

  test('(ج1) محاولة بانتظار المراجعة تمنع الاعتماد رغم نهائية الباقي', async () => {
    seedPassingWithFailedUnit()
    world.state.unitAttempts[0] = { ...world.state.unitAttempts[0], status: 'NEEDS_REVIEW', score: null }
    const decision = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe('SEMESTER_GRADES_INCOMPLETE')
      expect(decision.blockers).toEqual([{ code: 'UNIT_REVIEW_PENDING', count: 1 }])
    }
    expect(world.state.approvals.size).toBe(0)
    expect(world.state.semesterStates.size).toBe(0)
  })

  test('(ج2) درجة نهائية بلا اعتماد رسمي تمنع الاعتماد', async () => {
    seedPassingWithFailedUnit()
    world.state.gradeApprovals = world.state.gradeApprovals.filter((r: any) => r.attemptId !== 'ua2')
    const decision = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe('SEMESTER_GRADES_INCOMPLETE')
      expect(decision.blockers).toEqual([{ code: 'UNIT_GRADES_UNAPPROVED', count: 1 }])
    }
    expect(world.state.approvals.size).toBe(0)
  })

  test('(ج3) التماس درجات معلّق على امتحان الفصل يمنع الاعتماد', async () => {
    seedPassingWithFailedUnit()
    world.state.programAttempts[0] = { ...world.state.programAttempts[0], appealStatus: 'PENDING' }
    const decision = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe('SEMESTER_GRADES_INCOMPLETE')
      expect(decision.blockers).toEqual([{ code: 'PROGRAM_EXAM_APPEAL_PENDING', count: 1 }])
    }
    expect(world.state.approvals.size).toBe(0)
  })

  test('(ج4) واجب مقدَّم بلا تصحيح يمنع الاعتماد ولا يُحتسب نهائيًا', async () => {
    seedPassingWithFailedUnit()
    world.state.submissions = new Map([['as1:u1', { assignmentId: 'as1', userId: 'u1', status: 'SUBMITTED', score: null }]])
    const averages = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client: world.db })
    expect(averages.semesters.find((s) => s.semester === 1)?.gradesComplete).toBe(false)
    const decision = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: ADMIN })
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.code).toBe('SEMESTER_GRADES_INCOMPLETE')
      expect(decision.blockers).toEqual([{ code: 'ASSIGNMENT_GRADING_PENDING', count: 1 }])
    }
    expect(world.state.approvals.size).toBe(0)
  })
})
