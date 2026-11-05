import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Guard suite for the owner-ratified freeze exception (2026-11-05,
// docs/semester-readiness-freeze-exception.md): readiness counts ONLY
// fully settled attempts — GRADED, every answer scored, no PENDING
// appeal — while a settled attempt whose score is merely DERIVABLE from
// its fully-scored answers (the legacy storage shape the grade engine
// itself accepts) still counts, so no deserving student is blocked by
// how their grade is stored. The fake db APPLIES the where semantics
// (status / answers-none / appeal OR) so the query filters themselves
// are under test, not bypassed.

interface AttemptRow {
  examId: string
  status: string
  score: number | null
  finalScore?: number | null
  passed: boolean
  appealStatus: string | null
  answers: { points: number | null; maxPoints: number | null }[]
}

const world = {
  enrollment: null as any,
  semestersCount: 2 as number | null,
  units: [] as any[],
  assignments: [] as any[],
  unitAttempts: [] as AttemptRow[],
  programExams: [] as any[],
  programAttempts: [] as AttemptRow[],
  updated: null as any,
}

function appealOk(row: AttemptRow): boolean {
  return row.appealStatus === null || row.appealStatus !== 'PENDING'
}
function answersComplete(row: AttemptRow): boolean {
  return !row.answers.some((a) => a.points === null)
}
function applyAttemptWhere(rows: AttemptRow[], where: any): AttemptRow[] {
  return rows.filter((row) => {
    if (where.examId?.in && !where.examId.in.includes(row.examId)) return false
    if (typeof where.examId === 'string' && row.examId !== where.examId) return false
    if (where.status && row.status !== where.status) return false
    if (where.passed !== undefined && row.passed !== where.passed) return false
    if (where.answers?.none?.points === null && !answersComplete(row)) return false
    if (where.OR && !appealOk(row)) return false
    return true
  })
}

const fakeDb = {
  enrollment: {
    findUnique: async () => world.enrollment,
    update: async (args: any) => { world.updated = args; return args },
  },
  program: { findUnique: async () => ({ semestersCount: world.semestersCount }) },
  unit: { findMany: async () => world.units },
  programAssignment: { findMany: async () => world.assignments },
  examAttempt: {
    findMany: async (args: any) =>
      applyAttemptWhere(world.unitAttempts, args.where).map((r) => ({
        examId: r.examId, score: r.score, passed: r.passed,
        answers: r.answers.map((a) => ({ points: a.points, maxPoints: a.maxPoints })),
      })),
  },
  programExam: { findMany: async () => world.programExams },
  programExamAttempt: {
    findMany: async (args: any) =>
      applyAttemptWhere(world.programAttempts, args.where)
        .slice(0, args.take ?? 1000)
        .map((r) => ({
          id: `att-${r.examId}`, score: r.score, finalScore: r.finalScore ?? null,
          answers: r.answers.map((a) => ({ points: a.points, maxPoints: a.maxPoints })),
        })),
  },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))

const { calculateSemesterReadiness, hasPassedFirstSemesterExam, markSemesterReady } = await import('@/lib/semester-readiness')

const completeAnswers = [{ points: 8, maxPoints: 10 }, { points: 9, maxPoints: 10 }]

function unitWorld(attempts: AttemptRow[]) {
  world.enrollment = { id: 'en1', examReadiness: '[]' }
  world.units = [{ id: 'u1', title: 'الوحدة الأولى', semester: 1, order: 1, exam: { id: 'e1', title: 'اختبار الوحدة', passScore: 60 } }]
  world.assignments = []
  world.unitAttempts = attempts
}

beforeEach(() => {
  world.enrollment = null
  world.semestersCount = 2
  world.units = []
  world.assignments = []
  world.unitAttempts = []
  world.programExams = []
  world.programAttempts = []
  world.updated = null
})

describe('جهوزية الفصل — لا تُحسب إلا المحاولة المستقرة تمامًا', () => {
  test('محاولة بانتظار المراجعة (NEEDS_REVIEW) بدرجة مؤقتة لا تُحسب', async () => {
    unitWorld([{ examId: 'e1', status: 'NEEDS_REVIEW', score: 80, passed: true, appealStatus: null, answers: completeAnswers }])
    const r = await calculateSemesterReadiness('u1', 'p1', 1)
    expect(r.complete).toBe(false)
    expect(r.missingUnitExams.map((x) => x.id)).toEqual(['e1'])
    expect(r.passedUnitExamsCount).toBe(0)
  })

  test('محاولة مصححة فيها إجابة بلا نقاط لا تُحسب', async () => {
    unitWorld([{ examId: 'e1', status: 'GRADED', score: 85, passed: true, appealStatus: null, answers: [{ points: 8, maxPoints: 10 }, { points: null, maxPoints: 10 }] }])
    const r = await calculateSemesterReadiness('u1', 'p1', 1)
    expect(r.complete).toBe(false)
    expect(r.passedUnitExamsCount).toBe(0)
  })

  test('محاولة مصححة عليها التماس معلّق لا تُحسب', async () => {
    unitWorld([{ examId: 'e1', status: 'GRADED', score: 90, passed: true, appealStatus: 'PENDING', answers: completeAnswers }])
    const r = await calculateSemesterReadiness('u1', 'p1', 1)
    expect(r.complete).toBe(false)
    expect(r.passedUnitExamsCount).toBe(0)
  })

  test('محاولة مصححة نهائيًا بدرجة مخزنة تُحسب والفصل مكتمل', async () => {
    unitWorld([{ examId: 'e1', status: 'GRADED', score: 85, passed: true, appealStatus: 'NONE', answers: completeAnswers }])
    const r = await calculateSemesterReadiness('u1', 'p1', 1)
    expect(r.complete).toBe(true)
    expect(r.passedUnitExamsCount).toBe(1)
  })

  test('محاولة راسبة (passed=false) لا تُحسب ولو كانت مستقرة', async () => {
    unitWorld([{ examId: 'e1', status: 'GRADED', score: 40, passed: false, appealStatus: null, answers: completeAnswers }])
    const r = await calculateSemesterReadiness('u1', 'p1', 1)
    expect(r.complete).toBe(false)
    expect(r.passedUnitExamsCount).toBe(0)
  })
})

describe('تكافؤ شكل التخزين — الطالب المستحق لا يُمنع', () => {
  test('درجة غير مخزنة لكنها مشتقة من إجابات كاملة التصحيح تُحسب (شكل قديم يقبله محرك الدرجات)', async () => {
    unitWorld([{ examId: 'e1', status: 'GRADED', score: null, passed: true, appealStatus: null, answers: [{ points: 10, maxPoints: 10 }, { points: 10, maxPoints: 10 }] }])
    const r = await calculateSemesterReadiness('u1', 'p1', 1)
    expect(r.complete).toBe(true)
    expect(r.passedUnitExamsCount).toBe(1)
  })

  test('لا درجة مخزنة ولا إجابات قابلة للاشتقاق: لا تُحسب (لا نتيجة قابلة للاستخدام)', async () => {
    unitWorld([{ examId: 'e1', status: 'GRADED', score: null, passed: true, appealStatus: null, answers: [] }])
    const r = await calculateSemesterReadiness('u1', 'p1', 1)
    expect(r.complete).toBe(false)
    expect(r.passedUnitExamsCount).toBe(0)
  })
})

describe('قفل امتحان الفصل الأول (hasPassedFirstSemesterExam)', () => {
  function examWorld(attempts: AttemptRow[]) {
    world.programExams = [{ id: 'pe1', status: 'READY', createdAt: new Date('2026-01-01'), questions: [{ points: 10 }] }]
    world.programAttempts = attempts
  }

  test('محاولة بانتظار المراجعة فقط: القفل قائم', async () => {
    examWorld([{ examId: 'pe1', status: 'NEEDS_REVIEW', score: 88, passed: true, appealStatus: null, answers: completeAnswers }])
    expect(await hasPassedFirstSemesterExam('u1', 'p1')).toBe(false)
  })

  test('محاولة مستقرة عليها التماس معلّق: القفل قائم', async () => {
    examWorld([{ examId: 'pe1', status: 'GRADED', score: 88, passed: true, appealStatus: 'PENDING', answers: completeAnswers }])
    expect(await hasPassedFirstSemesterExam('u1', 'p1')).toBe(false)
  })

  test('محاولة مصححة نهائيًا بدرجة مخزنة: القفل يُفتح', async () => {
    examWorld([{ examId: 'pe1', status: 'GRADED', score: 88, passed: true, appealStatus: null, answers: completeAnswers }])
    expect(await hasPassedFirstSemesterExam('u1', 'p1')).toBe(true)
  })

  test('درجة مشتقة من إجابات كاملة بلا درجة مخزنة: القفل يُفتح (تكافؤ التخزين)', async () => {
    examWorld([{ examId: 'pe1', status: 'GRADED', score: null, passed: true, appealStatus: null, answers: [{ points: 8, maxPoints: 10 }] }])
    expect(await hasPassedFirstSemesterExam('u1', 'p1')).toBe(true)
  })

  test('الدرجة النهائية بعد التماس (finalScore) بلا درجة أولية: القفل يُفتح', async () => {
    examWorld([{ examId: 'pe1', status: 'GRADED', score: null, finalScore: 77, passed: true, appealStatus: 'REVIEWED', answers: completeAnswers }])
    expect(await hasPassedFirstSemesterExam('u1', 'p1')).toBe(true)
  })
})

describe('markSemesterReady — التحقق من نطاق الفصل وقفل الفصل الثاني', () => {
  test('فصل خارج نطاق البرنامج المهيأ يُرفض INVALID_SEMESTER', async () => {
    world.enrollment = { id: 'en1', examReadiness: '[]' }
    world.semestersCount = 2
    await expect(markSemesterReady('u1', 'p1', 3)).rejects.toThrow('INVALID_SEMESTER')
  })

  test('تأشير الفصل الثاني قبل نجاح امتحان الأول يُرفض SEM1_REQUIRED', async () => {
    world.enrollment = { id: 'en1', examReadiness: '[]' }
    world.programExams = [{ id: 'pe1', status: 'READY', createdAt: new Date('2026-01-01'), questions: [{ points: 10 }] }]
    world.programAttempts = []
    await expect(markSemesterReady('u1', 'p1', 2)).rejects.toThrow('SEM1_REQUIRED')
  })
})
