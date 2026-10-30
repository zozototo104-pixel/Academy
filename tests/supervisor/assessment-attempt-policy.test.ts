import { describe, expect, mock, test } from 'bun:test'

// ---------- in-memory store ----------
type Row = Record<string, any>
const store = {
  attempts: [] as Row[],
  answers: [] as Row[],
  windows: new Map<string, Row>(),
  seq: 0,
}
const nextId = (p: string) => `${p}${++store.seq}`

const app: Row = { id: 'app1', userId: 'stu1', supervisorId: 'sup1', email: 'stu@x.com', fullName: 'طالب تجريبي', program: 'HR', programId: 'prog1', supervisor: { id: 'sup1', name: 'المشرف' }, programRef: { id: 'prog1', titleAr: 'HR', books: [] }, theses: [] }
const questions: Row[] = [
  { id: 'q1', assessmentId: 'as1', type: 'MCQ', text: 'سؤال أول طويل بما يكفي', options: JSON.stringify(['أ', 'ب']), correctAnswer: '1', modelAnswer: null, correctRationale: 'لأن ب هي الصحيحة', sourceEvidence: 'دليل', points: 5, order: 1 },
  { id: 'q2', assessmentId: 'as1', type: 'MCQ', text: 'سؤال ثان طويل بما يكفي', options: JSON.stringify(['صح', 'خطأ']), correctAnswer: '0', modelAnswer: null, correctRationale: 'لأن صح', sourceEvidence: 'دليل', points: 5, order: 2 },
]
const assessment: Row = { id: 'as1', admissionId: 'app1', studentId: 'stu1', supervisorId: 'sup1', title: 'تقييم سياسة المحاولات', status: 'PUBLISHED', passScore: 60, durationMin: 30, aiGradingEnabled: true, totalPoints: 10, sourceBookIds: '[]', createdAt: new Date() }

function assembledAttempts(assessmentId: string, studentId?: string) {
  return store.attempts
    .filter((t) => t.assessmentId === assessmentId && (!studentId || t.studentId === studentId))
    .sort((a, b) => +new Date(b.submittedAt) - +new Date(a.submittedAt))
    .map((t) => ({
      ...t,
      answers: store.answers.filter((an) => an.attemptId === t.id).map((an) => ({ ...an, question: questions.find((q) => q.id === an.questionId) })),
    }))
}
function assembledAssessment(a: Row, studentId?: string) {
  return { ...a, questions: questions.filter((q) => q.assessmentId === a.id), attempts: assembledAttempts(a.id, studentId) }
}

const dbMock: any = {
  setting: { findFirst: async () => null, findMany: async () => [] },
  admissionApplication: {
    findUnique: async ({ where }: any) => (where.id === app.id ? app : null),
    findMany: async () => [app],
  },
  supervisorChannelMessage: { findMany: async () => [] },
  supervisorAssessment: {
    findUnique: async ({ where }: any) => (where.id === assessment.id ? assembledAssessment(assessment, undefined) : null),
    findMany: async () => [assembledAssessment(assessment, 'stu1')],
    create: async () => { throw new Error('not used') },
  },
  supervisorAssessmentAttempt: {
    findMany: async ({ where }: any) => {
      let rows = store.attempts.filter((t) => t.studentId === where.studentId)
      if (typeof where.assessmentId === 'string') rows = rows.filter((t) => t.assessmentId === where.assessmentId)
      if (where.assessmentId?.in) rows = rows.filter((t) => where.assessmentId.in.includes(t.assessmentId))
      return rows
    },
    findUnique: async ({ where }: any) => {
      const t = store.attempts.find((x) => x.id === where.id)
      if (!t) return null
      return { ...t, assessment: assembledAssessment(assessment, undefined), answers: store.answers.filter((an) => an.attemptId === t.id) }
    },
    count: async ({ where }: any) => store.attempts.filter((t) => t.assessmentId === where.assessmentId && t.studentId === where.studentId && +new Date(t.submittedAt) <= +new Date(where.submittedAt.lte)).length,
    create: async ({ data }: any) => {
      const t: Row = { id: nextId('at'), assessmentId: data.assessmentId, studentId: data.studentId, status: data.status, score: data.score, passed: data.passed, feedback: data.feedback, aiGraded: data.aiGraded, gradedAt: data.gradedAt, submittedAt: new Date() }
      store.attempts.push(t)
      for (const an of data.answers?.create || []) {
        store.answers.push({ id: nextId('an'), attemptId: t.id, ...an })
      }
      return t
    },
    update: async ({ where, data }: any) => {
      const t = store.attempts.find((x) => x.id === where.id)
      if (t) Object.assign(t, data)
      return t
    },
  },
  supervisorAssessmentAnswer: {
    update: async ({ where, data }: any) => {
      const an = store.answers.find((x) => x.id === where.id)
      if (an) Object.assign(an, data)
      return an
    },
  },
  supervisorAssessmentAttemptWindow: {
    findUnique: async ({ where }: any) => store.windows.get(`${where.assessmentId_studentId.assessmentId}:${where.assessmentId_studentId.studentId}`) || null,
    findMany: async ({ where }: any) => [...store.windows.values()].filter((w) => where.assessmentId.in.includes(w.assessmentId) && w.studentId === where.studentId),
    create: async ({ data }: any) => {
      const w: Row = { id: nextId('w'), restarts: 0, createdAt: new Date(), updatedAt: new Date(), ...data }
      store.windows.set(`${w.assessmentId}:${w.studentId}`, w)
      return w
    },
    update: async ({ where, data }: any) => {
      const w = [...store.windows.values()].find((x) => x.id === where.id)
      if (w) Object.assign(w, data)
      return w
    },
    delete: async ({ where }: any) => {
      const w = [...store.windows.values()].find((x) => x.id === where.id)
      if (w) store.windows.delete(`${w.assessmentId}:${w.studentId}`)
      return w
    },
  },
  $transaction: async (ops: any[]) => Promise.all(ops),
}
mock.module('@/lib/db', () => ({ db: dbMock }))
mock.module('@/lib/notify', () => ({ notify: async () => {} }))

let currentUser: Row | null = null
mock.module('@/lib/auth', () => ({
  requireUser: async () => {
    if (!currentUser) throw new Error('UNAUTHORIZED')
    return currentUser
  },
}))

const { gradeSupervisorAttemptWithAi } = await import('@/lib/supervisor-assessment-ai')
const { hideCorrectAnswersInFeedback, buildAssessmentPolicy } = await import('@/lib/assessment-attempt-policy')
const route = await import('@/app/api/supervisor/assessments/route')
const mySupervision = await import('@/app/api/my/supervision/route')
const { NextRequest } = await import('next/server')

const student: Row = { id: 'stu1', role: 'STUDENT', email: 'stu@x.com', name: 'طالب تجريبي' }
const post = (body: any) => route.POST(new NextRequest('https://example.test/api/supervisor/assessments', { method: 'POST', body: JSON.stringify(body) }))
const wrongAnswers = [{ questionId: 'q1', selectedOption: 0, answerText: '0' }, { questionId: 'q2', selectedOption: 1, answerText: '1' }]
const rightAnswers = [{ questionId: 'q1', selectedOption: 1, answerText: '1' }, { questionId: 'q2', selectedOption: 0, answerText: '0' }]
function reset() {
  store.attempts = []
  store.answers = []
  store.windows.clear()
  currentUser = student
}

describe('grader feedback reveal (deterministic MCQ)', () => {
  const qs = questions.map((q) => ({ id: q.id, type: q.type, text: q.text, correctAnswer: q.correctAnswer, modelAnswer: q.modelAnswer, points: q.points }))
  test('a wrong answer on attempt 1 of 3 does NOT name the correct answer', async () => {
    const g = await gradeSupervisorAttemptWithAi({ assessmentTitle: 'ت', passScore: 60, questions: qs, answers: wrongAnswers, attemptNumber: 1, maxAttempts: 3 })
    expect(g.passed).toBe(false)
    expect(g.perQuestion.q1.feedback).toBe('إجابة غير صحيحة.')
    expect(JSON.stringify(g.perQuestion)).not.toContain('الإجابة الصحيحة:')
  })
  test('the same failure on the LAST attempt reveals the correct answer', async () => {
    const g = await gradeSupervisorAttemptWithAi({ assessmentTitle: 'ت', passScore: 60, questions: qs, answers: wrongAnswers, attemptNumber: 3, maxAttempts: 3 })
    expect(g.perQuestion.q1.feedback).toContain('الإجابة الصحيحة: 1')
  })
  test('a passing attempt reveals (and needs no leak to begin with)', async () => {
    const g = await gradeSupervisorAttemptWithAi({ assessmentTitle: 'ت', passScore: 60, questions: qs, answers: rightAnswers, attemptNumber: 1, maxAttempts: 3 })
    expect(g.passed).toBe(true)
    expect(g.perQuestion.q1.feedback).toBe('إجابة صحيحة.')
  })
})

describe('feedback scrubber + policy builder', () => {
  test('hideCorrectAnswersInFeedback removes the giveaway segment only', () => {
    expect(hideCorrectAnswersInFeedback('الإجابة غير صحيحة. الإجابة الصحيحة: 2. راجع الدرس.')).toBe('الإجابة غير صحيحة. الإجابة الصحيحة محجوبة حتى تنهي محاولاتك. راجع الدرس.')
    expect(hideCorrectAnswersInFeedback('ملاحظة عادية بلا إجابات')).toBe('ملاحظة عادية بلا إجابات')
    expect(hideCorrectAnswersInFeedback(null)).toBeNull()
  })
  test('buildAssessmentPolicy mirrors the exam reveal rule', () => {
    expect(buildAssessmentPolicy({ maxAttempts: 3, completedAttempts: 1, passed: false }).reveal).toBe(false)
    expect(buildAssessmentPolicy({ maxAttempts: 3, completedAttempts: 3, passed: false }).reveal).toBe(true)
    expect(buildAssessmentPolicy({ maxAttempts: 3, completedAttempts: 1, passed: true }).reveal).toBe(true)
    expect(buildAssessmentPolicy({ maxAttempts: 3, completedAttempts: 3, passed: false }).canAttempt).toBe(false)
  })
})

describe('route: attempts cap, duration window, reveal lifecycle', () => {
  test('submit requires a started window; three failures exhaust; the third reveals', async () => {
    reset()
    const noStart = await post({ action: 'submit', assessmentId: 'as1', answers: wrongAnswers })
    expect(noStart.status).toBe(400)
    expect((await noStart.json()).code).toBe('START_REQUIRED')

    for (let i = 1; i <= 3; i++) {
      const started = await post({ action: 'start', assessmentId: 'as1' })
      expect(started.status).toBe(200)
      const submitted = await post({ action: 'submit', assessmentId: 'as1', answers: wrongAnswers })
      expect(submitted.status).toBe(200)
      const payload = await submitted.json()
      const fb = JSON.stringify(payload.assessment.attempts)
      if (i < 3) {
        expect(fb).not.toContain('الإجابة الصحيحة:')
        expect(payload.assessment.attemptPolicy.attemptsLeft).toBe(3 - i)
      } else {
        expect(fb).toContain('الإجابة الصحيحة:')
        expect(payload.assessment.attemptPolicy.canAttempt).toBe(false)
      }
      // the window is consumed by the submission
      expect(store.windows.size).toBe(0)
    }

    const fourthStart = await post({ action: 'start', assessmentId: 'as1' })
    expect(fourthStart.status).toBe(409)
    const fourthSubmit = await post({ action: 'submit', assessmentId: 'as1', answers: wrongAnswers })
    expect(fourthSubmit.status).toBe(409)
    expect((await fourthSubmit.json()).code).toBe('ATTEMPTS_EXHAUSTED')
    expect(store.attempts.length).toBe(3)
  })

  test('passing blocks any further attempt (start and submit)', async () => {
    reset()
    await post({ action: 'start', assessmentId: 'as1' })
    const submitted = await post({ action: 'submit', assessmentId: 'as1', answers: rightAnswers })
    expect(submitted.status).toBe(200)
    expect(store.attempts[0].passed).toBe(true)
    const againStart = await post({ action: 'start', assessmentId: 'as1' })
    expect(againStart.status).toBe(409)
    expect((await againStart.json()).code).toBe('ALREADY_PASSED')
    const againSubmit = await post({ action: 'submit', assessmentId: 'as1', answers: rightAnswers })
    expect(againSubmit.status).toBe(409)
  })

  test('an expired window rejects the submit; one restart is allowed, then locked', async () => {
    reset()
    await post({ action: 'start', assessmentId: 'as1' })
    const w = store.windows.get('as1:stu1')!
    w.startedAt = new Date(Date.now() - 2 * 3600_000)
    const late = await post({ action: 'submit', assessmentId: 'as1', answers: wrongAnswers })
    expect(late.status).toBe(410)
    expect((await late.json()).code).toBe('TIME_EXPIRED')
    expect(store.attempts.length).toBe(0)

    const restarted = await post({ action: 'start', assessmentId: 'as1' })
    expect(restarted.status).toBe(200)
    expect(store.windows.get('as1:stu1')!.restarts).toBe(1)

    store.windows.get('as1:stu1')!.startedAt = new Date(Date.now() - 2 * 3600_000)
    const locked = await post({ action: 'start', assessmentId: 'as1' })
    expect(locked.status).toBe(410)
    expect((await locked.json()).code).toBe('WINDOW_LOCKED')
  })

  test('GET list: legacy leaking feedback is scrubbed while attempts remain, revealed at exhaustion', async () => {
    reset()
    store.attempts.push({ id: 'legacy1', assessmentId: 'as1', studentId: 'stu1', status: 'GRADED', score: 0, passed: false, feedback: 'نتيجتك 0%', aiGraded: true, submittedAt: new Date() })
    store.answers.push({ id: 'legacyAn', attemptId: 'legacy1', questionId: 'q1', answerText: '0', selectedOption: 0, isCorrect: false, points: 0, maxPoints: 5, aiFeedback: 'الإجابة غير صحيحة. الإجابة الصحيحة: 1.' })

    const res1 = await route.GET(new NextRequest('https://example.test/api/supervisor/assessments?admissionId=app1'))
    const list1 = (await res1.json()).assessments[0]
    expect(JSON.stringify(list1.attempts)).not.toContain('الإجابة الصحيحة: 1')
    expect(JSON.stringify(list1.attempts)).toContain('محجوبة')
    expect(list1.questions[0].correctAnswer).toBeUndefined()

    store.attempts.push(
      { id: 'legacy2', assessmentId: 'as1', studentId: 'stu1', status: 'GRADED', score: 0, passed: false, feedback: null, aiGraded: true, submittedAt: new Date() },
      { id: 'legacy3', assessmentId: 'as1', studentId: 'stu1', status: 'GRADED', score: 0, passed: false, feedback: null, aiGraded: true, submittedAt: new Date() },
    )
    const res2 = await route.GET(new NextRequest('https://example.test/api/supervisor/assessments?admissionId=app1'))
    const list2 = (await res2.json()).assessments[0]
    expect(JSON.stringify(list2.attempts)).toContain('الإجابة الصحيحة: 1')
    expect(list2.attemptPolicy.reveal).toBe(true)
  })

  test('my/supervision carries the same scrubbing and policy', async () => {
    reset()
    store.attempts.push({ id: 'legacy1', assessmentId: 'as1', studentId: 'stu1', status: 'GRADED', score: 0, passed: false, feedback: 'نتيجتك 0%', aiGraded: true, submittedAt: new Date() })
    store.answers.push({ id: 'legacyAn', attemptId: 'legacy1', questionId: 'q1', answerText: '0', selectedOption: 0, isCorrect: false, points: 0, maxPoints: 5, aiFeedback: 'الإجابة غير صحيحة. الإجابة الصحيحة: 1.' })
    const res = await mySupervision.GET()
    const row = (await res.json()).supervision[0]
    const a = row.assessments[0]
    expect(JSON.stringify(a.attempts)).not.toContain('الإجابة الصحيحة: 1')
    expect(a.attemptPolicy.completedAttempts).toBe(1)
    expect(a.attemptPolicy.attemptsLeft).toBe(2)
  })
})
