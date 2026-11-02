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
import { findUngradedAnswers } from '../../src/lib/answer-completeness'

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

describe('حراس نصية للمسارات', () => {
  test('اعتماد الإدارة: الفحص يشمل كل الإجابات بلا مرشح نوع', () => {
    const route = read('src/app/api/admin/attempts-review/route.ts')
    const gate = route.slice(route.indexOf('async function ensureAllAnswersGraded'), route.indexOf('async function ensureManualAnswerIdsBelongToAttempt'))
    expect(gate).toContain('findUngradedAnswers')
    expect(gate).toContain('ANSWERS_NOT_FULLY_GRADED')
    expect(gate).not.toContain("type: { in: ['ESSAY', 'SHORT'] }")
    expect(route).not.toContain('ensureNoNullOpenAnswers')
  })

  test('مراجعة المشرف: لا حسم قبل اكتمال النقاط', () => {
    const lib = read('src/lib/supervisor-grade-review.ts')
    const gateAt = lib.indexOf('ANSWERS_NOT_FULLY_GRADED')
    expect(gateAt).toBeGreaterThan(-1)
    expect(gateAt).toBeLessThan(lib.indexOf('const maxTotal'))
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
