import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guard suite for the three pre-merge fixes approved on PR #170
// (reviewer round-4, Haris's decision 2026-11-02):
// 1) The semester-2 gate binds only the programme's DESIGNATED semester-1
//    exams: every READY exam + the current (latest) exam while unpublished.
//    Superseded leftovers must not block; a required unpublished exam must.
// 2) The student progress page picks the best GRADED attempt — the same
//    rule the final-grade engine uses — never the latest attempt.
// 3) Admin approval never rewrites a program attempt's submittedAt.

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

// ---------- 1) Semester-2 gate (mocked db) ----------
type GateExam = { id: string; status: string; createdAt: Date; questions: Array<{ points: number }> }
let gateExams: GateExam[] = []
let gatePassedExamIds = new Set<string>()
const examRow = (id: string, status: string, createdAt: string, questionPoints = 10): GateExam => ({
  id,
  status,
  createdAt: new Date(createdAt),
  questions: questionPoints > 0 ? [{ points: questionPoints }] : [],
})
const gateDb: any = {
  programExam: {
    // The real query orders by createdAt desc; fixtures are pre-ordered.
    findMany: async () => gateExams,
  },
  programExamAttempt: {
    findFirst: async ({ where }: any) => (gatePassedExamIds.has(where.examId) ? { id: 'attempt-' + where.examId } : null),
  },
}
mock.module('@/lib/db', () => ({ db: gateDb }))
const { hasPassedFirstSemesterExam } = await import('../../src/lib/semester-readiness')
const { pickBestGradedAttempt } = await import('../../src/lib/final-grade')

describe('قفل الفصل الثاني — الامتحانات المعينة فقط', () => {
  test('امتحان جاهز ناجح + بقايا فاشلة قديمة لا تقفل الفصل', async () => {
    gateExams = [examRow('ready-1', 'READY', '2026-10-02'), examRow('failed-old', 'FAILED', '2026-09-01')]
    gatePassedExamIds = new Set(['ready-1'])
    expect(await hasPassedFirstSemesterExam('student-1', 'program-1')).toBe(true)
  })
  test('امتحان جاهز ناجح + مسودة توليد قديمة مهجورة لا تقفل الفصل', async () => {
    gateExams = [examRow('ready-1', 'READY', '2026-10-02'), examRow('gen-old', 'GENERATING', '2026-08-01')]
    gatePassedExamIds = new Set(['ready-1'])
    expect(await hasPassedFirstSemesterExam('student-1', 'program-1')).toBe(true)
  })
  test('الامتحان الحالي بانتظار المراجعة (لم يُنشر) يبقي القفل', async () => {
    gateExams = [examRow('review-1', 'REVIEW', '2026-10-02')]
    gatePassedExamIds = new Set()
    expect(await hasPassedFirstSemesterExam('student-1', 'program-1')).toBe(false)
  })
  test('امتحان مطلوب جديد لم يُنشر يقفل حتى لو القديم الجاهز ناجح', async () => {
    gateExams = [examRow('review-new', 'REVIEW', '2026-10-05'), examRow('ready-1', 'READY', '2026-09-01')]
    gatePassedExamIds = new Set(['ready-1'])
    expect(await hasPassedFirstSemesterExam('student-1', 'program-1')).toBe(false)
  })
  test('امتحان جاهز غير ناجح يبقي القفل', async () => {
    gateExams = [examRow('ready-1', 'READY', '2026-10-02')]
    gatePassedExamIds = new Set()
    expect(await hasPassedFirstSemesterExam('student-1', 'program-1')).toBe(false)
  })
  test('كل امتحان جاهز ملزم: الثاني غير الناجح يقفل رغم نجاح الأول', async () => {
    gateExams = [examRow('ready-2', 'READY', '2026-10-03'), examRow('ready-1', 'READY', '2026-10-02')]
    gatePassedExamIds = new Set(['ready-1'])
    expect(await hasPassedFirstSemesterExam('student-1', 'program-1')).toBe(false)
  })
  test('لا يوجد أي امتحان فصل أول: يبقى مقفلًا', async () => {
    gateExams = []
    gatePassedExamIds = new Set()
    expect(await hasPassedFirstSemesterExam('student-1', 'program-1')).toBe(false)
  })
  test('امتحان جاهز بلا أسئلة منشورة عليها نقاط يبقي القفل', async () => {
    gateExams = [examRow('ready-1', 'READY', '2026-10-02', 0)]
    gatePassedExamIds = new Set(['ready-1'])
    expect(await hasPassedFirstSemesterExam('student-1', 'program-1')).toBe(false)
  })
  test('امتحان جاهز واحد ناجح يفتح الفصل', async () => {
    gateExams = [examRow('ready-1', 'READY', '2026-10-02')]
    gatePassedExamIds = new Set(['ready-1'])
    expect(await hasPassedFirstSemesterExam('student-1', 'program-1')).toBe(true)
  })
  test('الكود يرتّب حسب الأحدث ويبني المجموعة المعينة (READY أو الحالي)', () => {
    const source = read('src/lib/semester-readiness.ts')
    expect(source).toContain("orderBy: { createdAt: 'desc' }")
    expect(source).toContain("exam.status === 'READY' || exam.id === current.id")
  })
})

// ---------- 2) Best GRADED attempt selection ----------
describe('اختيار أفضل محاولة مصححة', () => {
  const attempt = (score: number | null, status: string, submittedAt: string, passed = false) => ({
    score,
    status,
    passed,
    submittedAt: new Date(submittedAt),
  })
  test('الأحدث ليست الأفضل: 55 ثم 40 يعرض 55 وناجح', () => {
    // Attempts arrive newest-first from the progress query.
    const best = pickBestGradedAttempt([
      attempt(40, 'GRADED', '2026-10-03', false),
      attempt(55, 'GRADED', '2026-10-01', true),
    ])
    expect(best?.score).toBe(55)
    expect(best?.passed).toBe(true)
  })
  test('محاولة قيد المراجعة بعلامة أعلى مؤقتة لا تُحتسب', () => {
    const best = pickBestGradedAttempt([
      attempt(90, 'NEEDS_REVIEW', '2026-10-03'),
      attempt(50, 'GRADED', '2026-10-01', true),
    ])
    expect(best?.score).toBe(50)
  })
  test('محاولة بلا علامة لا تُحتسب ولا يوجد معتمد يرجع null', () => {
    expect(pickBestGradedAttempt([attempt(null, 'GRADED', '2026-10-01')])).toBeNull()
    expect(pickBestGradedAttempt([])).toBeNull()
  })
  test('عند التعادل تختار الأحدث تسليمًا', () => {
    const best = pickBestGradedAttempt([
      attempt(70, 'GRADED', '2026-10-01', true),
      attempt(70, 'GRADED', '2026-10-04', true),
    ])
    expect(best?.submittedAt).toEqual(new Date('2026-10-04'))
  })
  test('صفحة التقدم تستخدم نفس الدالة ولا تأخذ أول محاولة بالترتيب', () => {
    const source = read('src/app/api/progress/route.ts')
    expect(source).toContain('pickBestGradedAttempt')
    expect(source).not.toContain('!bestByExam[a.examId] && a.score !== null')
  })
})

// ---------- 3) submittedAt protection (static pin; behavioral proof lives
// in tests/exams/attempt-grading-integrity.test.ts) ----------
describe('حماية تاريخ التسليم الأصلي', () => {
  test('مسار اعتماد الإدارة لا يكتب submittedAt جديدًا', () => {
    const source = read('src/app/api/admin/attempts-review/route.ts')
    expect(source).not.toContain('submittedAt: new Date()')
  })
})
