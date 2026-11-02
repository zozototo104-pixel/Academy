// حراس متابعة سلامة التصحيح (2026-11-02، فوق PR #170):
// 1) اعتماد الإدارة ومراجعة المشرف يُمنعان ما دامت أي إجابة — من أي نوع —
//    بلا نقاط، بدل احتساب الفارغ صفرًا ورسوب الطالب بصمت على إجابة صحيحة.
// 2) المحاولات العالقة بحالة SUBMITTED (أقدم من 30 دقيقة) تظهر في قائمة
//    مراجعة الإدارة، مع إجراء نقل محروس إلى NEEDS_REVIEW.
// 3) منح دقائق الصوت محمي بفهرس فريد على paymentId (+ ترحيلة) ومعالجة
//    P2002 بوصفها «ممنوح أصلًا».
// 4) مسارات فشل التصحيح تخزّن رموز سبب فقط، لا نص الخطأ الخام.
import { describe, test, expect } from 'bun:test'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { findMissingAnswerQuestionIds, findUngradedAnswers, gradeObjectiveAnswer } from '../../src/lib/answer-completeness'

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
    expect(program).toContain("const reviewState = { code: 'POST_SUBMIT_FAILURE' }")
  })
})
