import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Guard: supervisor powers (Haris's locked design 2026-10-29).
// - Content scope comes from assignments only (his students' programs).
// - Manual questions are DIRECT + live; admins are notified + audited.
// - A program question answered by students cannot be deleted.
// - Grade review: the assigned supervisor can amend his student's
//   AI-graded attempt; anyone else gets 403.
// - Unit-exam appeals exist ONLY for students with a human supervisor
//   and are resolved by that supervisor; program-exam appeal resolution
//   is widened from admin-only to admin OR the assigned supervisor.

let currentUser: any = { id: 'sup-1', name: 'المشرف أول', role: 'SUPERVISOR' }
let notifications: any[] = []
let adminNotices: any[] = []
let audits: any[] = []

let S: any

function matches(row: any, where: any): boolean {
  if (!where) return true
  for (const [key, cond] of Object.entries<any>(where)) {
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('in' in cond) { if (!cond.in.includes(row[key])) return false; continue }
      if ('not' in cond) { if (cond.not === null && (row[key] === null || row[key] === undefined)) return false; if (cond.not !== null && row[key] === cond.not) return false; continue }
      if ('notIn' in cond) { if (cond.notIn.includes(row[key])) return false; continue }
      continue // nested relation filters: seeded data already satisfies them
    }
    if (row[key] !== cond) return false
  }
  return true
}

function makeModel(getRows: () => any[]) {
  return {
    findMany: async ({ where, orderBy, take, distinct }: any = {}) => {
      let rows = getRows().filter((r) => matches(r, where))
      if (distinct?.length) {
        const seen = new Set()
        rows = rows.filter((r) => { const k = distinct.map((f: string) => String(r[f])).join('|'); if (seen.has(k)) return false; seen.add(k); return true })
      }
      if (orderBy) {
        const entries = Array.isArray(orderBy) ? orderBy : [orderBy]
        for (const o of entries.reverse()) {
          const [field, dir] = Object.entries<any>(o)[0]
          rows = [...rows].sort((a, b) => (new Date(a[field] || 0).getTime() - new Date(b[field] || 0).getTime()) * (dir === 'desc' ? -1 : 1))
        }
      }
      return take ? rows.slice(0, take) : rows
    },
    findFirst: async ({ where, orderBy }: any = {}) => (await makeModel(getRows).findMany({ where, orderBy }))[0] || null,
    findUnique: async ({ where }: any = {}) => {
      if (where.userId_programId) return getRows().find((r) => r.userId === where.userId_programId.userId && r.programId === where.userId_programId.programId) || null
      return getRows().find((r) => r.id === where.id) || null
    },
    create: async ({ data }: any) => { const row = { id: `new-${Math.random().toString(36).slice(2, 9)}`, ...data }; getRows().push(row); return row },
    update: async ({ where, data }: any) => { const row = getRows().find((r) => r.id === where.id); if (!row) throw new Error('missing'); Object.assign(row, data); return row },
    updateMany: async ({ where, data }: any) => { let n = 0; for (const r of getRows()) if (matches(r, where)) { Object.assign(r, data); n++ } return { count: n } },
    delete: async ({ where }: any) => { const rows = getRows(); const i = rows.findIndex((r) => r.id === where.id); if (i >= 0) rows.splice(i, 1); return {} },
    count: async ({ where }: any = {}) => getRows().filter((r) => matches(r, where)).length,
    aggregate: async ({ where, _sum }: any = {}) => ({ _sum: { points: getRows().filter((r) => matches(r, where)).reduce((s, r) => s + (r.points || 0), 0) } }),
  }
}

function seed() {
  notifications = []; adminNotices = []; audits = []
  const P1: any = { id: 'P1', titleAr: 'برنامج أ', titleEn: 'A', books: [{ id: 'B1', title: 'كتاب أ', semester: 1, source: 'X' }], units: [], programExams: [] }
  const P2: any = { id: 'P2', titleAr: 'برنامج ب', titleEn: 'B', books: [], units: [], programExams: [] }
  const U1 = { id: 'U1', programId: 'P1', title: 'الوحدة الأولى', order: 1, semester: 1, status: 'APPROVED', summary: '', exam: { id: 'E1', title: 'امتحان الوحدة', status: 'READY', passScore: 60, _count: { questions: 2 } }, program: { titleAr: 'برنامج أ' } }
  const U2 = { id: 'U2', programId: 'P2', title: 'وحدة ب', order: 1, semester: 1, status: 'APPROVED', summary: '', exam: null, program: { titleAr: 'برنامج ب' } }
  P1.units = [U1]; P2.units = [U2]
  const PQ1 = { id: 'PQ1', examId: 'PE1', order: 1, type: 'MCQ', text: 'سؤال قائم', options: '["أ","ب"]', correctAnswer: '0', modelAnswer: null, points: 2, status: 'PUBLISHED', difficulty: 'MEDIUM', exam: { id: 'PE1', title: 'فصلي أ', programId: 'P1', program: { titleAr: 'برنامج أ' } } }
  const PQ2 = { id: 'PQ2', examId: 'PE1', order: 2, type: 'ESSAY', text: 'سؤال بلا إجابات', options: null, correctAnswer: null, modelAnswer: 'نموذج', points: 5, status: 'PUBLISHED', difficulty: 'MEDIUM', exam: { id: 'PE1', title: 'فصلي أ', programId: 'P1', program: { titleAr: 'برنامج أ' } } }
  const PE1 = { id: 'PE1', programId: 'P1', title: 'فصلي أ', semester: 1, status: 'READY', passScore: 60, durationMin: 120, totalPoints: 7, generatedBy: 'AI', program: { titleAr: 'برنامج أ' }, _count: { questions: 2 }, questions: [PQ1, PQ2] }
  P1.programExams = [PE1]
  const UA1 = { id: 'UA1', attemptId: 'AT1', questionId: 'Q1', points: 10, maxPoints: 10, isCorrect: true, answerText: '', selectedOption: 0, aiFeedback: null, question: { order: 1, type: 'MCQ', text: 'اختر', options: '["أ","ب"]', correctAnswer: '0', modelAnswer: null, rubric: null, points: 10 } }
  const UA2 = { id: 'UA2', attemptId: 'AT1', questionId: 'Q2', points: 4, maxPoints: 10, isCorrect: null, answerText: 'إجابة الطالب', selectedOption: null, aiFeedback: '{"points":4,"feedback":"مقيدة"}', question: { order: 2, type: 'ESSAY', text: 'اشرح', options: null, correctAnswer: null, modelAnswer: 'النموذجية', rubric: null, points: 10 } }
  const AT1 = {
    id: 'AT1', userId: 'stu-1', status: 'GRADED', score: 70, passed: true, aiGraded: true, appealStatus: 'NONE', appealReason: null, appealResponse: null, appealedAt: null, reviewedById: null, reviewedAt: null, submittedAt: new Date(),
    user: { id: 'stu-1', name: 'طالب أول', email: 's1@x.io' },
    exam: { id: 'E1', title: 'امتحان الوحدة', passScore: 60, questions: [{ points: 10 }, { points: 10 }], unit: { title: 'الوحدة الأولى', programId: 'P1', program: { id: 'P1', titleAr: 'برنامج أ' } } },
    answers: [UA1, UA2],
  }
  const AT2 = { id: 'AT2', userId: 'stu-2', status: 'GRADED', score: 50, passed: false, aiGraded: true, appealStatus: 'NONE', appealReason: null, appealResponse: null, appealedAt: null, reviewedById: null, reviewedAt: null, submittedAt: new Date(), user: { id: 'stu-2', name: 'طالب ثان', email: 's2@x.io' }, exam: AT1.exam, answers: [] }
  const PAT1 = {
    id: 'PAT1', userId: 'stu-1', status: 'GRADED', score: 55, finalScore: null, passed: false, appealStatus: 'PENDING', appealReason: 'أستحق أكثر', appealResponse: null, appealedAt: new Date(), reviewedById: null, reviewedAt: null, submittedAt: new Date(),
    user: { id: 'stu-1', name: 'طالب أول', email: 's1@x.io' },
    exam: { id: 'PE1', title: 'فصلي أ', passScore: 60, programId: 'P1', semester: 1, program: { id: 'P1', titleAr: 'برنامج أ' }, questions: [] },
    answers: [],
  }
  const PAT2 = { ...PAT1, id: 'PAT2', appealReason: 'اعتراض ثان' }
  S = {
    users: [
      { id: 'admin-1', name: 'الأدمن', role: 'ADMIN', status: 'ACTIVE', email: 'a@x.io' },
      { id: 'sup-1', name: 'المشرف أول', role: 'SUPERVISOR', status: 'ACTIVE', email: 'sup1@x.io' },
      { id: 'sup-2', name: 'المشرف ثان', role: 'SUPERVISOR', status: 'ACTIVE', email: 'sup2@x.io' },
      { id: 'stu-1', name: 'طالب أول', role: 'STUDENT', status: 'ACTIVE', email: 's1@x.io' },
      { id: 'stu-2', name: 'طالب ثان', role: 'STUDENT', status: 'ACTIVE', email: 's2@x.io' },
    ],
    admissions: [{ id: 'adm-1', supervisorId: 'sup-1', userId: 'stu-1', programId: 'P1', supervisionMode: 'HYBRID', supervisorAt: new Date(), createdAt: new Date() }],
    series: [],
    programs: [P1, P2],
    units: [U1, U2],
    bankItems: [{ id: 'BK1', programId: 'P1', unitId: 'U1', type: 'MCQ', text: 'سؤال بنك قائم', options: '["أ","ب"]', correctAnswer: '1', modelAnswer: null, rubric: null, difficulty: 'MEDIUM', status: 'APPROVED', generatedBy: 'AI', sourceEvidence: null, sourceBookTitle: null, createdAt: new Date() }],
    programExams: [PE1],
    programQuestions: [PQ1, PQ2],
    programAnswers: [{ id: 'PA1', questionId: 'PQ1', attemptId: 'PAT1' }],
    unitAttempts: [AT1, AT2],
    programAttempts: [PAT1, PAT2],
    unitAnswers: [UA1, UA2],
    proposals: [],
    enrollments: [],
  }
}

mock.module('@/lib/db', () => ({
  db: {
    user: makeModel(() => S.users),
    admissionApplication: makeModel(() => S.admissions),
    lectureSeries: makeModel(() => S.series),
    program: makeModel(() => S.programs),
    unit: makeModel(() => S.units),
    questionBankItem: makeModel(() => S.bankItems),
    programExam: makeModel(() => S.programExams),
    programQuestion: makeModel(() => S.programQuestions),
    programAnswer: makeModel(() => S.programAnswers),
    examAttempt: makeModel(() => S.unitAttempts),
    programExamAttempt: makeModel(() => S.programAttempts),
    answer: makeModel(() => S.unitAnswers),
    supervisorUnitProposal: makeModel(() => S.proposals),
    enrollment: makeModel(() => S.enrollments),
    notification: { create: async ({ data }: any) => { notifications.push(data); return data }, createMany: async ({ data }: any) => { notifications.push(...data); return { count: data.length } } },
    auditLog: { create: async ({ data }: any) => { audits.push(data); return data } },
    $transaction: async (fn: any) => fn((globalThis as any).__fakeDb),
  },
}))

mock.module('@/lib/auth', () => ({
  requireUser: async () => currentUser,
  requireAdmin: async () => { if (currentUser.role !== 'ADMIN') throw new Error('UNAUTHORIZED'); return currentUser },
}))

mock.module('@/lib/notify', () => ({
  notify: async (userId: string, type: string, title: string, body: string, link?: string) => { notifications.push({ userId, type, title, body, link }) },
  notifyAdmins: async (type: string, title: string, body: string, link?: string) => { adminNotices.push({ type, title, body, link }) },
  audit: async (actor: any, action: string, entity: string, entityId: any, details: any) => { audits.push({ actor, action, entity, entityId, details }) },
}))

mock.module('@/lib/semester-readiness', () => ({ calculateSemesterReadiness: async () => ({ maxExamScore: 100 }) }))
mock.module('@/lib/enrollment-completion', () => ({ completeEnrollmentIfEligible: async () => ({ ok: false }) }))

const dbModule: any = await import('@/lib/db')
;(globalThis as any).__fakeDb = dbModule.db

const contentRoute = await import('@/app/api/supervisor/content/route')
const proposalsRoute = await import('@/app/api/supervisor/unit-proposals/route')
const questionsRoute = await import('@/app/api/supervisor/questions/route')
const gradeReviewRoute = await import('@/app/api/supervisor/grade-review/route')
const supervisorAppealsRoute = await import('@/app/api/supervisor/appeals/route')
const unitAppealRoute = await import('@/app/api/unit-exam/appeal/route')
const programAppealRoute = await import('@/app/api/program-exam/appeal/route')
const { NextRequest } = await import('next/server')

const req = (url: string, method = 'GET', body?: any) => new NextRequest(`http://localhost${url}`, { method, body: body ? JSON.stringify(body) : undefined })
const asSupervisor = () => { currentUser = { id: 'sup-1', name: 'المشرف أول', role: 'SUPERVISOR' } }
const asSupervisor2 = () => { currentUser = { id: 'sup-2', name: 'المشرف ثان', role: 'SUPERVISOR' } }
const asAdmin = () => { currentUser = { id: 'admin-1', name: 'الأدمن', role: 'ADMIN' } }
const asStudent = (id: string) => { currentUser = { id, name: 'طالب', role: 'STUDENT' } }

beforeEach(() => { seed(); asSupervisor() })

describe('supervisor content scope', () => {
  test('lists only his students\' programs', async () => {
    const res = await contentRoute.GET(req('/api/supervisor/content'))
    const body = await res.json()
    expect(body.programs.map((p: any) => p.id)).toEqual(['P1'])
  })

  test('program detail outside his scope is 403', async () => {
    const res = await contentRoute.GET(req('/api/supervisor/content?programId=P2'))
    expect(res.status).toBe(403)
  })

  test('program detail inside scope includes units with their bank questions', async () => {
    const res = await contentRoute.GET(req('/api/supervisor/content?programId=P1'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.program.units[0].bankQuestions.map((q: any) => q.id)).toEqual(['BK1'])
    expect(body.program.programExams[0].questions.length).toBe(2)
  })
})

describe('supervisor manual questions', () => {
  test('MCQ without a correct answer is rejected — auto-grading depends on it', async () => {
    const res = await questionsRoute.POST(req('/api/supervisor/questions', 'POST', { kind: 'BANK', unitId: 'U1', type: 'MCQ', text: 'س؟', options: ['أ', 'ب'] }))
    expect(res.status).toBe(400)
  })

  test('ESSAY without a model answer is rejected — AI grading depends on it', async () => {
    const res = await questionsRoute.POST(req('/api/supervisor/questions', 'POST', { kind: 'BANK', unitId: 'U1', type: 'ESSAY', text: 'اشرح؟' }))
    expect(res.status).toBe(400)
  })

  test('valid bank question goes live APPROVED as MANUAL and notifies admins + audit', async () => {
    const res = await questionsRoute.POST(req('/api/supervisor/questions', 'POST', { kind: 'BANK', unitId: 'U1', type: 'MCQ', text: 'سؤال المشرف؟', options: ['أ', 'ب', 'ج'], correctAnswer: '2' }))
    expect(res.status).toBe(200)
    const created = S.bankItems.find((q: any) => q.text === 'سؤال المشرف؟')
    expect(created.status).toBe('APPROVED')
    expect(created.generatedBy).toBe('MANUAL')
    expect(created.approvedBy).toBe('sup-1')
    expect(adminNotices.length).toBeGreaterThan(0)
    expect(audits.some((a: any) => a.action === 'SUPERVISOR_ADD_QUESTION')).toBe(true)
  })

  test('adding to another program\'s unit is 403', async () => {
    const res = await questionsRoute.POST(req('/api/supervisor/questions', 'POST', { kind: 'BANK', unitId: 'U2', type: 'MCQ', text: 'س؟', options: ['أ', 'ب'], correctAnswer: '0' }))
    expect(res.status).toBe(403)
  })

  test('program-exam manual question is PUBLISHED and refreshes exam totals', async () => {
    const res = await questionsRoute.POST(req('/api/supervisor/questions', 'POST', { kind: 'PROGRAM', examId: 'PE1', type: 'ESSAY', text: 'مقالي جديد', modelAnswer: 'الإجابة', points: 10 }))
    expect(res.status).toBe(200)
    const created = S.programQuestions.find((q: any) => q.text === 'مقالي جديد')
    expect(created.status).toBe('PUBLISHED')
    expect(S.programExams[0].totalPoints).toBe(17)
  })

  test('deleting an answered program question is 409; an unanswered one deletes', async () => {
    const blocked = await questionsRoute.DELETE(req('/api/supervisor/questions', 'DELETE', { kind: 'PROGRAM', questionId: 'PQ1' }))
    expect(blocked.status).toBe(409)
    const ok = await questionsRoute.DELETE(req('/api/supervisor/questions', 'DELETE', { kind: 'PROGRAM', questionId: 'PQ2' }))
    expect(ok.status).toBe(200)
    expect(S.programQuestions.find((q: any) => q.id === 'PQ2')).toBeUndefined()
  })
})

describe('unit proposals', () => {
  test('proposal in his program is stored PENDING and admins are notified', async () => {
    const res = await proposalsRoute.POST(req('/api/supervisor/unit-proposals', 'POST', { programId: 'P1', unitId: 'U1', kind: 'EDIT', title: 'توسيع الوحدة', details: 'نحتاج أمثلة أكثر' }))
    expect(res.status).toBe(200)
    expect(S.proposals.length).toBe(1)
    expect(S.proposals[0].status).toBe('PENDING')
    expect(adminNotices.length).toBeGreaterThan(0)
  })

  test('proposal for a foreign program is 403', async () => {
    const res = await proposalsRoute.POST(req('/api/supervisor/unit-proposals', 'POST', { programId: 'P2', kind: 'ADD', title: 'وحدة', details: 'تفاصيل' }))
    expect(res.status).toBe(403)
  })
})

describe('grade review', () => {
  test('assigned supervisor amends the essay grade and the total is recomputed + documented', async () => {
    const res = await gradeReviewRoute.PATCH(req('/api/supervisor/grade-review', 'PATCH', { type: 'UNIT', attemptId: 'AT1', scores: { UA2: 9 } }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.score).toBe(95)
    expect(body.passed).toBe(true)
    const attempt = S.unitAttempts.find((a: any) => a.id === 'AT1')
    expect(attempt.score).toBe(95)
    expect(attempt.reviewedById).toBe('sup-1')
    expect(JSON.parse(attempt.feedback).supervisorReview.changes).toEqual([{ answerId: 'UA2', from: 4, to: 9 }])
    expect(notifications.some((n: any) => n.userId === 'stu-1')).toBe(true)
  })

  test('a different supervisor cannot touch the attempt (403)', async () => {
    asSupervisor2()
    const res = await gradeReviewRoute.PATCH(req('/api/supervisor/grade-review', 'PATCH', { type: 'UNIT', attemptId: 'AT1', scores: { UA2: 9 } }))
    expect(res.status).toBe(403)
    expect(S.unitAttempts.find((a: any) => a.id === 'AT1').score).toBe(70)
  })
})

describe('appeals', () => {
  test('unit appeal is refused when the student has NO human supervisor', async () => {
    asStudent('stu-2')
    const res = await unitAppealRoute.POST(req('/api/unit-exam/appeal', 'POST', { attemptId: 'AT2', reason: 'أراجع تصحيحي من فضلك' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('NO_HUMAN_SUPERVISOR')
  })

  test('unit appeal files to the assigned supervisor, who resolves it', async () => {
    asStudent('stu-1')
    const filed = await unitAppealRoute.POST(req('/api/unit-exam/appeal', 'POST', { attemptId: 'AT1', reason: 'المقالي انظلمت فيه' }))
    expect(filed.status).toBe(200)
    expect(S.unitAttempts.find((a: any) => a.id === 'AT1').appealStatus).toBe('PENDING')
    expect(notifications.some((n: any) => n.userId === 'sup-1')).toBe(true)

    asSupervisor()
    const list = await supervisorAppealsRoute.GET()
    const listBody = await list.json()
    expect(listBody.appeals.some((a: any) => a.id === 'AT1' && a.type === 'UNIT')).toBe(true)

    const resolved = await supervisorAppealsRoute.PATCH(req('/api/supervisor/appeals', 'PATCH', { type: 'UNIT', attemptId: 'AT1', action: 'APPROVE', finalScore: 88, response: 'معك حق' }))
    expect(resolved.status).toBe(200)
    const attempt = S.unitAttempts.find((a: any) => a.id === 'AT1')
    expect(attempt.appealStatus).toBe('REVIEWED')
    expect(attempt.score).toBe(88)
    expect(attempt.reviewedById).toBe('sup-1')
  })

  test('program-exam appeal resolution: assigned supervisor allowed, other supervisor 403, admin still allowed', async () => {
    asSupervisor2()
    const foreign = await programAppealRoute.PATCH(req('/api/program-exam/appeal', 'PATCH', { attemptId: 'PAT1', action: 'APPROVE', finalScore: 80 }))
    expect(foreign.status).toBe(403)

    asSupervisor()
    const own = await programAppealRoute.PATCH(req('/api/program-exam/appeal', 'PATCH', { attemptId: 'PAT1', action: 'APPROVE', finalScore: 80 }))
    expect(own.status).toBe(200)
    const pat1 = S.programAttempts.find((a: any) => a.id === 'PAT1')
    expect(pat1.finalScore).toBe(80)
    expect(pat1.appealStatus).toBe('REVIEWED')
    expect(pat1.reviewedById).toBe('sup-1')

    asAdmin()
    const byAdmin = await programAppealRoute.PATCH(req('/api/program-exam/appeal', 'PATCH', { attemptId: 'PAT2', action: 'REJECT', response: 'راجعنا ورفضنا' }))
    expect(byAdmin.status).toBe(200)
    expect(S.programAttempts.find((a: any) => a.id === 'PAT2').appealStatus).toBe('REVIEWED')
  })
})
