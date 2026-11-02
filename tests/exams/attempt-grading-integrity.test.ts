// حراس متابعة سلامة التصحيح (2026-11-02، فوق PR #170):
// 1) اعتماد الإدارة ومراجعة المشرف يُمنعان ما دامت أي إجابة — من أي نوع —
//    بلا نقاط، بدل احتساب الفارغ صفرًا ورسوب الطالب بصمت على إجابة صحيحة.
// 2) المحاولات العالقة بحالة SUBMITTED (أقدم من 30 دقيقة) تظهر في قائمة
//    مراجعة الإدارة، مع إجراء نقل محروس إلى NEEDS_REVIEW.
// 3) منح دقائق الصوت محمي بفهرس فريد على paymentId (+ ترحيلة) ومعالجة
//    P2002 بوصفها «ممنوح أصلًا».
// 4) مسارات فشل التصحيح تخزّن رموز سبب فقط، لا نص الخطأ الخام.
import { describe, test, expect, mock } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { findDuplicateAnswerQuestionIds, findMissingAnswerQuestionIds, findUngradedAnswers, sumRequiredAnswerPoints, gradeObjectiveAnswer } from '../../src/lib/answer-completeness'

const root = join(import.meta.dir, '..', '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

describe('findUngradedAnswers — بوابة اكتمال التصحيح', () => {
  test('يكشف إجابة اختيار من متعدد بلا نقاط (قلب خلل اعتماد الصفر)', () => {
    const rows = [
      { id: 'a1', points: 5, question: { type: 'ESSAY' } },
      { id: 'a2', points: null, question: { type: 'MCQ' } },
      { id: 'a3', points: 0, question: { type: 'TRUE_FALSE' } },
    ]
    expect(findUngradedAnswers(rows)).toEqual([{ id: 'a2', type: 'MCQ' }])
  })

  test('الصفر الصريح درجة مكتملة، لا يُعد غير مصحح', () => {
    const rows = [
      { id: 'a1', points: 0, question: { type: 'MCQ' } },
      { id: 'a2', points: 0, question: { type: 'ESSAY' } },
    ]
    expect(findUngradedAnswers(rows)).toEqual([])
  })

  test('يكشف كل الأنواع معًا ويحفظ النوع للرسالة', () => {
    const rows = [
      { id: 'a1', points: null, question: { type: 'ESSAY' } },
      { id: 'a2', points: null, question: { type: 'SHORT' } },
      { id: 'a3', points: null, question: { type: 'MCQ' } },
    ]
    expect(findUngradedAnswers(rows).map((r) => r.type)).toEqual(['ESSAY', 'SHORT', 'MCQ'])
  })

  test('لا إجابات = لا ناقص', () => {
    expect(findUngradedAnswers([])).toEqual([])
  })
})

describe('findMissingAnswerQuestionIds — بوابة التغطية', () => {
  test('سؤال مطلوب بلا سجل إجابة يُكشف (قلب ثقب الاعتماد الثاني)', () => {
    const required = ['q1', 'q2', 'q3']
    const answers = [{ questionId: 'q1' }, { questionId: 'q3' }]
    expect(findMissingAnswerQuestionIds(required, answers)).toEqual(['q2'])
  })

  test('مصفوفة إجابات فارغة مع أسئلة مطلوبة = كلها مفقودة', () => {
    expect(findMissingAnswerQuestionIds(['q1', 'q2'], [])).toEqual(['q1', 'q2'])
  })

  test('تغطية كاملة = لا مفقود، والإجابات الزائدة لا تضر', () => {
    const answers = [{ questionId: 'q1' }, { questionId: 'q2' }, { questionId: 'qX' }]
    expect(findMissingAnswerQuestionIds(['q1', 'q2'], answers)).toEqual([])
  })
})

describe('gradeObjectiveAnswer — إعادة التصحيح الحتمية', () => {
  const base = { optionsRaw: JSON.stringify(['أ', 'ب', 'ج']), correctAnswerRaw: '1', maxPoints: 10 }

  test('اختيار صحيح = العلامة الكاملة', () => {
    expect(gradeObjectiveAnswer({ ...base, selectedOption: 1 })).toEqual({ points: 10, isCorrect: true, correctAnswerText: 'ب' })
  })

  test('اختيار خاطئ أو غياب الاختيار = صفر صريح', () => {
    expect(gradeObjectiveAnswer({ ...base, selectedOption: 0 })?.points).toBe(0)
    expect(gradeObjectiveAnswer({ ...base, selectedOption: null })?.points).toBe(0)
    expect(gradeObjectiveAnswer({ ...base, selectedOption: null })?.isCorrect).toBe(false)
  })

  test('مفتاح ناقص = null (يُرفض بدل التخمين)', () => {
    expect(gradeObjectiveAnswer({ ...base, correctAnswerRaw: null, selectedOption: 1 })).toBeNull()
    expect(gradeObjectiveAnswer({ ...base, optionsRaw: null, selectedOption: 1 })).toBeNull()
  })
})

describe('حراس نصية للمسارات', () => {
  test('اعتماد الإدارة: الفحص يشمل كل الإجابات بلا مرشح نوع', () => {
    const route = read('src/app/api/admin/attempts-review/route.ts')
    const gate = route.slice(route.indexOf('async function ensureAllAnswersGraded'), route.indexOf('async function ensureManualAnswerIdsBelongToAttempt'))
    expect(gate).toContain('findUngradedAnswers')
    expect(gate).toContain('ANSWERS_NOT_FULLY_GRADED')
    expect(gate).not.toContain("type: { in: ['ESSAY', 'SHORT'] }")
    expect(route).not.toContain('ensureNoNullOpenAnswers')
  })

  test('اعتماد الإدارة: بوابة التغطية قبل بوابة النقاط', () => {
    const route = read('src/app/api/admin/attempts-review/route.ts')
    const gate = route.slice(route.indexOf('async function ensureAllAnswersGraded'), route.indexOf('async function ensureManualAnswerIdsBelongToAttempt'))
    expect(gate).toContain('findMissingAnswerQuestionIds')
    expect(gate).toContain('ANSWERS_COVERAGE_INCOMPLETE')
    expect(gate).toContain("status: 'PUBLISHED'")
    expect(gate.indexOf('ANSWERS_COVERAGE_INCOMPLETE')).toBeLessThan(gate.indexOf('ANSWERS_NOT_FULLY_GRADED'))
  })

  test('مراجعة المشرف: لا حسم قبل اكتمال النقاط والتغطية', () => {
    const lib = read('src/lib/supervisor-grade-review.ts')
    const gateAt = lib.indexOf('ANSWERS_NOT_FULLY_GRADED')
    expect(gateAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(lib.indexOf('const maxTotal'))
    expect(lib).toContain('ANSWERS_COVERAGE_INCOMPLETE')
    expect(lib.indexOf('ANSWERS_COVERAGE_INCOMPLETE')).toBeLessThan(lib.indexOf('const maxTotal'))
  })

  test('تفاصيل المراجعة: كل أنواع الأسئلة ظاهرة وقابلة لإعادة التصحيح الحتمي', () => {
    const route = read('src/app/api/admin/attempts-review/route.ts')
    const unitDetail = route.slice(route.indexOf('async function unitDetail'), route.indexOf('async function programDetail'))
    const programDetail = route.slice(route.indexOf('async function programDetail'), route.indexOf('async function readinessForProgramAttempt'))
    for (const detail of [unitDetail, programDetail]) {
      expect(detail).toContain('questionType')
      expect(detail).not.toContain("['ESSAY', 'SHORT']")
    }
    expect(route).toContain('gradeObjectiveAnswer')
    expect(route).toContain('ANSWER_KEY_MISSING')
  })

  test('قائمة المراجعة: العالق SUBMITTED الأقدم من 30 دقيقة ظاهر وقابل للنقل المحروس', () => {
    const route = read('src/app/api/admin/attempts-review/route.ts')
    expect(route).toContain('STUCK_SUBMITTED_MS = 30 * 60 * 1000')
    expect(route).toContain("status: 'SUBMITTED', submittedAt: { lt: stuckBefore }")
    expect(route).toContain("body?.action === 'MARK_NEEDS_REVIEW'")
    expect(route).toContain("status: 'SUBMITTED', submittedAt: { lt: stuckBefore } }, data: { status: 'NEEDS_REVIEW' }")
  })

  test('دقائق الصوت: فهرس فريد + ترحيلة + P2002 ممنوح أصلًا', () => {
    const schema = read('prisma/schema.prisma')
    const creditModel = schema.slice(schema.indexOf('model AiLiveCredit'), schema.indexOf('model AiLiveSession'))
    expect(creditModel).toContain('@unique')
    expect(creditModel).toContain('paymentId')
    const migrationPath = 'prisma/migrations/20261102130000_ai_live_credit_payment_id_unique/migration.sql'
    expect(existsSync(join(root, migrationPath))).toBe(true)
    expect(read(migrationPath)).toContain('CREATE UNIQUE INDEX "AiLiveCredit_paymentId_key"')
    const guard = read('src/lib/live-usage-guard.ts')
    expect(guard).toContain("error?.code !== 'P2002'")
    expect(guard).toContain('newlyGranted: false')
    // تعافي P2002 بقراءة جديدة خارج المعاملة المُجهضة، لا داخلها:
    // بحث tx الوحيد هو فحص الوجود المسبق ضمن القفل.
    expect(guard).toContain('await db.aiLiveCredit.findFirst({ where: { paymentId: input.paymentId } })')
    expect(guard.split('tx.aiLiveCredit.findFirst').length - 1).toBe(1)
  })

  test('مسارا التسليم: رموز سبب فقط في بيانات الفشل المخزنة', () => {
    const unit = read('src/app/api/exam/submit/route.ts')
    const program = read('src/app/api/program-exam/submit/route.ts')
    expect(unit).toContain("code: 'ESSAY_GRADING_FAILED'")
    expect(unit).not.toContain('reason: String(e?.message')
    expect(program).not.toContain('reason: String(e?.message')
    expect(program).not.toContain('reason: String(postCreateError?.message')
    expect(program).toContain("code: 'GRADING_INTERRUPTED' }")
    expect(program).toContain("postCreateError?.code === 'ANSWER_KEY_MISSING'")
    expect(program).toContain("'POST_SUBMIT_FAILURE' }")
    expect(program).toContain('const objective = gradeObjectiveAnswer({')
    expect(program).toContain("throw Object.assign(new Error('ANSWER_KEY_MISSING')")
    expect(program).toContain('status: \'NEEDS_REVIEW\'')
  })
})

describe('منع تكرار الإجابات وعدم احتساب الأسئلة المستبعدة', () => {
  test('مكرر ضمن المحاولة يُكتشف حتى لو جميع النقاط مكتملة', () => {
    expect(findDuplicateAnswerQuestionIds([
      { questionId: 'q1' }, { questionId: 'q2' }, { questionId: 'q1' },
    ])).toEqual(['q1'])
  })
  test('السؤال المستبعد لا يرفع بسط العلامة', () => {
    const answers = [
      { questionId: 'published', points: 10 },
      { questionId: 'rejected', points: 10 },
    ]
    expect(sumRequiredAnswerPoints(['published'], answers)).toBe(10)
    expect(sumRequiredAnswerPoints(['published', 'rejected'], answers)).toBe(20)
  })
  test('المشرف يفحص التكرار ويحسب البسط والمقام من الأسئلة المسموح بها فقط', () => {
    const source = read('src/lib/supervisor-grade-review.ts')
    expect(source).toContain('findDuplicateAnswerQuestionIds(attempt.answers)')
    expect(source).toContain("new Error('DUPLICATE_ANSWER_ROWS')")
    expect(source).toContain('const maxTotal = eligibleAnswers.reduce')
    expect(source).toContain('sumRequiredAnswerPoints(requiredIds, attempt.answers)')
  })
})

// Request-level tests of the actual admin PATCH handler, with an isolated,
// intentionally mutable database mock. No production data is ever written.
let auditAnswers: Array<Record<string, any>> = []
let auditQuestions: Array<Record<string, any>> = []
let auditFinalGrade: Record<string, any> | null = null
const auditExam = (type: 'UNIT' | 'PROGRAM', include?: any) => ({
  id: type + '-exam',
  title: 'اختبار تجريبي',
  passScore: 50,
  semester: 1,
  programId: null,
  program: { titleAr: 'برنامج تجريبي' },
  unit: { programId: null, program: { titleAr: 'برنامج تجريبي' } },
  questions: type === 'PROGRAM' && include?.exam?.include?.questions?.where?.status === 'PUBLISHED'
    ? auditQuestions.filter((question) => question.status === 'PUBLISHED')
    : auditQuestions,
})
const auditDb: any = {
  $transaction: async (operation: (tx: any) => Promise<any>) => operation(auditDb),
  examAttempt: {
    findUnique: async ({ include }: any) => ({
      id: 'UNIT-attempt', userId: 'student-1', examId: 'UNIT-exam',
      status: 'NEEDS_REVIEW', exam: auditExam('UNIT', include), answers: auditAnswers,
    }),
    updateMany: async () => ({ count: 1 }),
    update: async ({ data }: any) => { auditFinalGrade = data; return data },
  },
  programExamAttempt: {
    findUnique: async ({ include }: any) => ({
      id: 'PROGRAM-attempt', userId: 'student-1', examId: 'PROGRAM-exam',
      status: 'NEEDS_REVIEW', exam: auditExam('PROGRAM', include), answers: auditAnswers,
    }),
    updateMany: async () => ({ count: 1 }),
    update: async ({ data }: any) => { auditFinalGrade = data; return data },
  },
  question: {
    findMany: async () => auditQuestions.map((question) => ({ id: question.id })),
  },
  programQuestion: {
    findMany: async () => auditQuestions.filter((question) => question.status === 'PUBLISHED')
      .map((question) => ({ id: question.id })),
  },
  answer: {
    findMany: async () => auditAnswers,
    findUnique: async () => null,
  },
  programAnswer: {
    findMany: async () => auditAnswers,
    findUnique: async () => null,
  },
  bookKnowledgeItem: { findMany: async () => [] },
}
mock.module('@/lib/db', () => ({ db: auditDb }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1' }) }))
mock.module('@/lib/semester-readiness', () => ({ calculateSemesterReadiness: async () => null }))
mock.module('@/lib/enrollment-completion', () => ({ completeEnrollmentIfEligible: async () => null }))
mock.module('@/lib/essay-grading', () => ({
  EssayNeedsReviewError: class EssayNeedsReviewError extends Error {},
  gradeEssayWithRubric: async () => ({ points: 0, feedback: '' }),
}))
const reviewRoute = await import('../../src/app/api/admin/attempts-review/route')
function reviewRequest(type: 'UNIT' | 'PROGRAM') {
  return reviewRoute.PATCH(new NextRequest('https://academy.test/api/admin/attempts-review', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, attemptId: type + '-attempt', scores: {} }),
  }))
}
for (const type of ['UNIT', 'PROGRAM'] as const) {
  describe('اعتماد الإدارة الفعلي — ' + type, () => {
    test('يرفض إجابتين لنفس السؤال بدل احتساب 200%', async () => {
      auditFinalGrade = null
      auditQuestions = [{ id: 'q1', status: 'PUBLISHED', type: 'MCQ', points: 10, order: 1 }]
      auditAnswers = [
        { id: 'a1', questionId: 'q1', points: 10, maxPoints: 10, question: { type: 'MCQ' } },
        { id: 'a2', questionId: 'q1', points: 10, maxPoints: 10, question: { type: 'MCQ' } },
      ]
      const result = await reviewRequest(type)
      expect(result.status).toBe(409)
      expect((await result.json()).error).toContain('تكررت')
      expect(auditFinalGrade).toBeNull()
    })
    test('يمنع الاعتماد عندما لا يوجد سجل للسؤال المطلوب', async () => {
      auditFinalGrade = null
      auditQuestions = [{ id: 'q1', status: 'PUBLISHED', type: 'MCQ', points: 10 }]
      auditAnswers = []
      const result = await reviewRequest(type)
      expect(result.status).toBe(400)
      expect((await result.json()).error).toContain('سؤال مطلوب')
      expect(auditFinalGrade).toBeNull()
    })
    test('سؤال واحد صحيح يُعتمد بدرجة 100% دون تضخيم', async () => {
      auditFinalGrade = null
      auditQuestions = [{ id: 'q1', status: 'PUBLISHED', type: 'MCQ', points: 10 }]
      auditAnswers = [{ id: 'a1', questionId: 'q1', points: 10, maxPoints: 10, question: { type: 'MCQ' } }]
      const result = await reviewRequest(type)
      expect(result.status).toBe(200)
      expect((await result.json()).score).toBe(100)
      expect((auditFinalGrade as Record<string, any> | null)?.status).toBe('GRADED')
    })
  })
}
test('امتحان برنامج: إجابة محفوظة لسؤال REJECTED لا ترفع العلامة', async () => {
  auditFinalGrade = null
  auditQuestions = [
    { id: 'q1', status: 'PUBLISHED', type: 'MCQ', points: 10 },
    { id: 'q2', status: 'REJECTED', type: 'MCQ', points: 10 },
  ]
  auditAnswers = [
    { id: 'a1', questionId: 'q1', points: 10, maxPoints: 10, question: { type: 'MCQ' } },
    { id: 'a2', questionId: 'q2', points: 10, maxPoints: 10, question: { type: 'MCQ' } },
  ]
  const result = await reviewRequest('PROGRAM')
  expect(result.status).toBe(200)
  expect((await result.json()).score).toBe(100)
  expect((auditFinalGrade as Record<string, any> | null)?.status).toBe('GRADED')
})

// Supervisor review is a separate scoring entry point. Exercise the actual
// service with the same in-memory attempt rows so it cannot bypass the guard.
mock.module('@/lib/notify', () => ({ notify: async () => {} }))
const { applyScoreAdjustments } = await import('../../src/lib/supervisor-grade-review')
auditDb.answer.update = async ({ where, data }: any) => {
  const answer = auditAnswers.find((row) => row.id === where.id)
  if (!answer) throw new Error('MOCK_ANSWER_NOT_FOUND')
  Object.assign(answer, data)
  return answer
}
auditDb.programAnswer.update = auditDb.answer.update

test('المشرف يرفض تكرار الإجابة في محاولة واحدة دون اعتماد درجة مضاعفة', async () => {
  auditFinalGrade = null
  auditQuestions = [{ id: 'q1', type: 'MCQ', status: 'PUBLISHED', points: 10 }]
  auditAnswers = [
    { id: 'a1', questionId: 'q1', points: 10, maxPoints: 10, question: { type: 'MCQ', points: 10 } },
    { id: 'a2', questionId: 'q1', points: 10, maxPoints: 10, question: { type: 'MCQ', points: 10 } },
  ]
  await expect(applyScoreAdjustments(
    { id: 'admin', name: 'مسؤول', role: 'ADMIN' } as any, 'UNIT', 'UNIT-attempt', { a1: 10 },
  )).rejects.toThrow('DUPLICATE_ANSWER_ROWS')
  expect(auditFinalGrade).toBeNull()
})

test('المشرف يستثني نقاط السؤال REJECTED من الدرجة النهائية للفصل', async () => {
  auditFinalGrade = null
  auditQuestions = [
    { id: 'q1', type: 'MCQ', status: 'PUBLISHED', points: 10 },
    { id: 'q2', type: 'MCQ', status: 'REJECTED', points: 10 },
  ]
  auditAnswers = [
    { id: 'a1', questionId: 'q1', points: 10, maxPoints: 10, question: { type: 'MCQ', points: 10 } },
    { id: 'a2', questionId: 'q2', points: 10, maxPoints: 10, question: { type: 'MCQ', points: 10 } },
  ]
  const result = await applyScoreAdjustments(
    { id: 'admin', name: 'مسؤول', role: 'ADMIN' } as any, 'PROGRAM', 'PROGRAM-attempt', { a1: 10 },
  )
  expect(result.score).toBe(100)
  expect((auditFinalGrade as Record<string, any> | null)?.status).toBe('GRADED')
})

test('إعادة تصحيح البرنامج تتجاهل سجل سؤال REJECTED ذي مفتاح غير مكتمل', async () => {
  auditFinalGrade = null
  auditQuestions = [
    { id: 'q1', order: 1, type: 'MCQ', status: 'PUBLISHED', points: 10, options: JSON.stringify(['أ', 'ب']), correctAnswer: '1' },
    { id: 'q2', order: 2, type: 'MCQ', status: 'REJECTED', points: 10, options: null, correctAnswer: null },
  ]
  auditAnswers = [
    { id: 'a1', questionId: 'q1', points: null, maxPoints: 10, selectedOption: 1, question: auditQuestions[0] },
    { id: 'a2', questionId: 'q2', points: null, maxPoints: 10, selectedOption: 0, question: auditQuestions[1] },
  ]
  const result = await reviewRoute.POST(new NextRequest('https://academy.test/api/admin/attempts-review', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'PROGRAM', attemptId: 'PROGRAM-attempt' }),
  }))
  expect(result.status).toBe(200)
  expect((await result.json()).score).toBe(100)
  expect(auditAnswers.find((a) => a.id === 'a2')?.points).toBeNull()
  expect((auditFinalGrade as Record<string, any> | null)?.status).toBe('GRADED')
})

