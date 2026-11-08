import { describe, expect, mock, test } from 'bun:test'

// مسار الاسترحام الكامل (المرحلة 4): رسوب معتمد ومغلق ⟹ طلب ⟹ إسناد
// نشاط بوزن ومهلة ≤ 7 أيام ⟹ تسليم ⟹ تصحيح حقيقي ⟹ إعادة حساب
// بالصيغة المعتمدة ⟹ إعادة مصادقة رسمية — والرسوب الأصلي موثّق.
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
      // حالة ينتجها التصحيح الحقيقي: passed تُشتق من الدرجة أمام حدّ
      // نجاح الامتحان (60) كما تفعل مسارات التصحيح فعليًا
      // (passed = score >= passScore) — فمحاولة بدرجة 20 راسبة
      // (passed: false) لكنها نهائية ومصحَّحة ومعتمدة رسميًا.
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
    (!where.status || (typeof where.status === 'string'
      ? a.status === where.status : Array.isArray(where.status?.in) && where.status.in.includes(a.status))) &&
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


// إضافة مخزن الاسترحام ونطاق المشرف إلى عالم دورة الحياة
function extendWorld(w: any) {
  const mercyRows: any[] = []
  let seq = 0
  const matchMercy = (row: any, where: any) =>
    Object.entries(where || {}).every(([k, v]: any) => {
      if (v === undefined) return true
      if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k])
      if (v && typeof v === 'object' && 'lt' in v) return new Date(row[k]).getTime() < new Date(v.lt).getTime()
      return row[k] === v
    })
  w.db.mercyRequest = {
    create: async ({ data }: any) => { const row = { id: `mercy-${++seq}`, ...data }; mercyRows.push(row); return row },
    findUnique: async ({ where }: any) => {
      if (where.id) return mercyRows.find((r) => r.id === where.id) ?? null
      const k = where.enrollmentId_semester
      return mercyRows.find((r) => r.enrollmentId === k.enrollmentId && r.semester === k.semester) ?? null
    },
    findFirst: async ({ where }: any) => mercyRows.find((r) => matchMercy(r, where)) ?? null,
    findMany: async ({ where }: any) => mercyRows.filter((r) => matchMercy(r, where)),
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const row of mercyRows) if (matchMercy(row, where)) { Object.assign(row, data); count++ }
      return { count }
    },
  }
  w.db.admissionApplication = { findFirst: async () => null }
  w.state.mercyRows = mercyRows
  w.state.setSupervisorAssigned = (assigned: boolean) => {
    w.db.admissionApplication.findFirst = async ({ where }: any) => (assigned && where.userId === 'u1' && where.programId === 'p1' ? { id: 'app-1' } : null)
  }
  w.state.setRole2 = (role: string) => { w.state.actorRole = role }
  // المستخدم الفاعل الثاني (مشرف) — user.findUnique يفرّق بالمعرف
  const origUser = w.db.user.findUnique
  w.db.user = {
    findUnique: async ({ where }: any) => {
      if (where?.id === 'sup-1') return { role: 'SUPERVISOR', name: 'مشرف' }
      return origUser({ where })
    },
  }
  return w
}

const world = extendWorld(makeWorld(20))
mock.module('@/lib/db', () => ({ db: world.db }))
mock.module('@/lib/notify', () => ({ audit: async () => {}, notify: async () => {}, notifyAdmins: async () => {} }))
mock.module('@/lib/mailer', () => ({ emailTemplate: (t: string) => t, sendEmailDetailed: async () => 'SKIPPED' }))
const { approveSemesterResult } = await import('../../src/lib/semester-approval')
const { requestMercy, assignMercyActivity, submitMercyActivity, gradeMercyActivity, lapseOverdueMercy } = await import('../../src/lib/mercy')
const { calculateSemesterAverages } = await import('../../src/lib/semester-grade')
mock.module('@/lib/supervisor-scope', () => ({ requireSupervisor: async () => ({ id: 'sup-1', role: 'SUPERVISOR' }) }))
const { GET: supervisorMercyList } = await import('../../src/app/api/supervisor/mercy/route')

describe('مسار الاسترحام والنشاط العلاجي', () => {
  test('فصل راسب معتمد بلا تقديم امتحان: الاسترحام مرفوض؛ بعد تقديمه يحق الطلب', async () => {
    const isolated = extendWorld(makeWorld(20))
    isolated.state.programAttempts = []
    isolated.state.semesterStates.set('enr1:1', { status: 'CLOSED', result: 'FAILED' })
    isolated.state.approvals.set('enr1:1', { status: 'APPROVED', score: 25 })
    const request = { userId: 'u1', programId: 'p1', semester: 1 }
    const denied = await requestMercy(isolated.db, request)
    expect(denied).toEqual({ ok: false, code: 'SEMESTER_EXAM_NOT_TAKEN' })
    expect(isolated.state.mercyRows).toHaveLength(0)

    isolated.state.programAttempts.push({
      id: 'submitted-pe1', userId: 'u1', examId: 'pe1',
      status: 'GRADED', score: 25, passed: false, appealStatus: 'NONE', answers: [],
    })
    const permitted = await requestMercy(isolated.db, request)
    expect(permitted.ok).toBe(true)
    expect(isolated.state.mercyRows).toHaveLength(1)
  })

  test('الدورة الكاملة: رسوب مغلق ⟹ نشاط مصحَّح ⟹ معدل جديد ومصادقة جديدة', async () => {
    // ١) اعتماد الفصل الأول راسبًا وإغلاقه (معدل 33.33)
    const approval = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: { id: 'admin-1' } })
    expect(approval.ok).toBe(true)
    expect(world.state.semesterStates.get('enr1:1').result).toBe('FAILED')

    // ٢) طلب الاسترحام — ومرة ثانية مرفوضة (نشاط واحد لكل فصل)
    const req = await requestMercy(world.db, { userId: 'u1', programId: 'p1', semester: 1 })
    expect(req.ok).toBe(true)
    const dup = await requestMercy(world.db, { userId: 'u1', programId: 'p1', semester: 1 })
    expect(dup).toEqual({ ok: false, code: 'MERCY_ALREADY_EXISTS' })
    if (!req.ok) throw new Error('mercy request failed')
    const mercyId = req.mercy.id

    // ٣) إسناد: مهلة 8 أيام مرفوضة خادميًا، ووزن 60 مرفوض، ثم إسناد صالح
    const tooLong = await assignMercyActivity(world.db, { mercyId, actor: { id: 'admin-1' }, title: 'بحث تطبيقي', weightPercent: 50, dueAt: new Date(Date.now() + 8 * 86_400_000) })
    expect(tooLong).toEqual({ ok: false, code: 'MERCY_DEADLINE_TOO_LONG' })
    const badWeight = await assignMercyActivity(world.db, { mercyId, actor: { id: 'admin-1' }, title: 'بحث تطبيقي', weightPercent: 60 })
    expect(badWeight).toEqual({ ok: false, code: 'MERCY_WEIGHT_INVALID' })
    const assigned = await assignMercyActivity(world.db, { mercyId, actor: { id: 'admin-1' }, title: 'بحث تطبيقي', weightPercent: 50 })
    expect(assigned.ok).toBe(true)

    // ٤) تسليم الطالب، ثم تصحيح مشرف غير مُسند مرفوض، والمُسند يقدر
    const submitted = await submitMercyActivity(world.db, { mercyId, userId: 'u1', text: 'سلّمت البحث التطبيقي كاملًا' })
    expect(submitted.ok).toBe(true)
    const forbidden = await gradeMercyActivity(world.db, { mercyId, actor: { id: 'sup-1' }, score: 80 })
    expect(forbidden).toEqual({ ok: false, code: 'FORBIDDEN' })
    world.state.setSupervisorAssigned(true)
    const graded = await gradeMercyActivity(world.db, { mercyId, actor: { id: 'sup-1' }, score: 80 })
    expect(graded.ok).toBe(true)
    if (graded.ok) expect(graded.mercy.previousAverage).toBe(33.33)

    // ٥) المعدل الجديد بالصيغة: (33.33×50 + 80×50)/100 = 56.67
    const averages = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client: world.db })
    const s1 = averages.semesters.find((s) => s.semester === 1)
    expect(s1?.average).toBe(56.67)
    expect(s1?.passed).toBe(true)
    expect(s1?.mercyApplied).toEqual({ weightPercent: 50, score: 80 })

    // ٦) إعادة المصادقة الرسمية: الاعتماد الجديد بالمعدل الجديد،
    // والفصل ناجح، والطلب مكتمل — والرسوب الأصلي موثّق في الطلب.
    const reapproval = await approveSemesterResult({ enrollmentId: 'enr1', semester: 1, actor: { id: 'admin-1' } })
    expect(reapproval.ok).toBe(true)
    expect(world.state.approvals.get('enr1:1').score).toBe(56.67)
    expect(world.state.semesterStates.get('enr1:1').result).toBe('PASSED')
    const mercy = world.state.mercyRows[0]
    expect(mercy.status).toBe('COMPLETED')
    expect(mercy.newAverage).toBe(56.67)
    expect(mercy.previousAverage).toBe(33.33)

    // ٧) لا استرحام ثانيًا بعد النجاح
    const again = await requestMercy(world.db, { userId: 'u1', programId: 'p1', semester: 1 })
    expect(again.ok).toBe(false)
  })

  test('انقضاء المهلة دون تسليم: الطلب ينقضي والرسوب يبقى', async () => {
    // فصل غير مغلق بالرسوب (الثاني هنا) لا يقبل طلبًا أصلًا:
    const notFailed = await requestMercy(world.db, { userId: 'u1', programId: 'p1', semester: 2 })
    expect(notFailed).toEqual({ ok: false, code: 'SEMESTER_NOT_FAILED' })
    // انقضاء نشاط مُسند: نصنع طلبًا بحالة ACTIVITY_ASSIGNED منتهي المهلة
    world.state.mercyRows.push({
      id: 'mercy-lapse', enrollmentId: 'enr1', userId: 'u1', programId: 'p1', semester: 1,
      status: 'ACTIVITY_ASSIGNED', dueAt: new Date(Date.now() - 1000),
    })
    const lapsed = await lapseOverdueMercy(world.db, new Date())
    expect(lapsed).toBe(1)
    expect(world.state.mercyRows.find((r: any) => r.id === 'mercy-lapse').status).toBe('LAPSED')
    const lateSubmit = await submitMercyActivity(world.db, { mercyId: 'mercy-lapse', userId: 'u1', text: 'متأخر' })
    expect(lateSubmit).toEqual({ ok: false, code: 'MERCY_WRONG_STATE' })
  })

  test('supervisor assigned to student in programme A cannot assign or grade mercy in programme B', async () => {
    world.state.setSupervisorAssigned(true)
    const other = { id: 'mercy-other-program', enrollmentId: 'enr-other',
      userId: 'u1', programId: 'p2', semester: 1, status: 'REQUESTED' }
    world.state.mercyRows.push(other)
    try {
      const assign = await assignMercyActivity(world.db, {
        mercyId: other.id, actor: { id: 'sup-1' }, title: 'نشاط', weightPercent: 25,
      })
      expect(assign).toEqual({ ok: false, code: 'FORBIDDEN' })
      expect(other.status).toBe('REQUESTED')
      other.status = 'SUBMITTED'
      const grade = await gradeMercyActivity(world.db, { mercyId: other.id, actor: { id: 'sup-1' }, score: 90 })
      expect(grade).toEqual({ ok: false, code: 'FORBIDDEN' })
      expect(other.status).toBe('SUBMITTED')
    } finally {
      world.state.mercyRows.splice(world.state.mercyRows.indexOf(other), 1)
    }
  })

  test('supervisor mercy list shows only exact student-program assignments', async () => {
    const originalAdmissionFindMany = world.db.admissionApplication.findMany
    const originalMercyFindMany = world.db.mercyRequest.findMany
    const requests = [
      { id: 'allowed-1', userId: 'u1', programId: 'p1' },
      { id: 'allowed-2', userId: 'u2', programId: 'p2' },
      { id: 'hidden-cross-program', userId: 'u1', programId: 'p2' },
      { id: 'hidden-other-student', userId: 'u2', programId: 'p1' },
    ]
    world.db.admissionApplication.findMany = async () => [
      { userId: 'u1', programId: 'p1' }, { userId: 'u2', programId: 'p2' },
    ]
    world.db.mercyRequest.findMany = async ({ where }: any) => {
      expect(where.OR).toEqual([
        { userId: 'u1', programId: 'p1' },
        { userId: 'u2', programId: 'p2' },
      ])
      return requests.filter((r) => where.OR.some((p: any) =>
        p.userId === r.userId && p.programId === r.programId))
    }
    try {
      const res = await supervisorMercyList()
      expect(res.status).toBe(200)
      const payload = await res.json()
      expect(payload.requests.map((r: any) => r.id)).toEqual(['allowed-1', 'allowed-2'])
    } finally {
      world.db.admissionApplication.findMany = originalAdmissionFindMany
      world.db.mercyRequest.findMany = originalMercyFindMany
    }
  })
})

describe('سباق إنشاء الاسترحام (تدقيق 2026-11-06)', () => {
  test('خرق قيد التفرد عند الإنشاء ⟹ MERCY_ALREADY_EXISTS لا خطأ 500، وأي خطأ آخر يصعد', async () => {
    // العميل: فصل مغلق راسب معتمد، وقد جلس الطالب لامتحانه
    // فعليًا. نصل لاختبار سباق الإنشاء بدون تجاوز حارس الامتحان.
    const client: any = {
      enrollment: { findUnique: async () => ({ id: 'enr-race' }) },
      enrollmentSemesterState: { findUnique: async () => ({ status: 'CLOSED', result: 'FAILED' }) },
      semesterResultApproval: { findUnique: async () => ({ id: 'appr-race' }) },
      programExam: {
        findMany: async () => [{
          id: 'race-pe1', status: 'READY', createdAt: new Date(),
          questions: [{ points: 10 }],
        }],
      },
      programExamAttempt: {
        findMany: async ({ where }: any) =>
          where.userId === 'u-race' && where.examId === 'race-pe1' &&
          where.status?.in?.includes('GRADED')
            ? [{ id: 'race-submitted' }] : [],
      },
      mercyRequest: {
        findUnique: async () => null,
        create: async () => { throw Object.assign(new Error('Unique constraint failed on the fields: (`enrollmentId`,`semester`)'), { code: 'P2002' }) },
      },
      notificationOutbox: { create: async () => ({}), findUnique: async () => null },
    }
    const raced = await requestMercy(client, { userId: 'u-race', programId: 'p-race', semester: 1 })
    expect(raced).toEqual({ ok: false, code: 'MERCY_ALREADY_EXISTS' })
    client.mercyRequest.create = async () => { throw new Error('DB_DOWN') }
    await expect(requestMercy(client, { userId: 'u-race', programId: 'p-race', semester: 1 })).rejects.toThrow('DB_DOWN')
  })
})
