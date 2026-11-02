import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'fs'

// Scenario guard (added 2026-11-02 on Haris's order): a supervisor/admin
// adjusts a unit attempt's approved score from 40 to 75 while the stored
// answer points still sum to 40. The final-grade unit component MUST use
// the approved stored score (75); answer points are only a fallback for
// legacy graded attempts that have no stored score at all.

mock.module('@/lib/db', () => ({ db: {} }))

const { calculateFinalGrade } = await import('@/lib/final-grade')
const { gradingFormulaSignature } = await import('@/lib/program-tracks')

const formula = [
  { key: 'quizzes', label: 'اختبارات قصيرة ومتابعة', weight: 30 },
  { key: 'assignments', label: 'واجبات أو أنشطة تطبيقية', weight: 20 },
  { key: 'final_exam', label: 'الاختبار النهائي', weight: 50 },
]

// Answer points that recompute to exactly 40%.
const answersWorth40 = [
  { points: 20, maxPoints: 50 },
  { points: 20, maxPoints: 50 },
]

function fakeClient(attempts: any[]) {
  return {
    program: {
      findUnique: async () => ({
        category: 'DIPLOMA',
        admissionRules: {
          academicProfile: {
            finalEvaluationFormula: formula,
            approvedFormulaSignature: gradingFormulaSignature(formula),
            approvedFormulaAt: '2026-10-01T00:00:00.000Z',
          },
        },
      }),
    },
    enrollment: {
      findUnique: async () => ({ createdAt: new Date('2026-10-05T00:00:00.000Z'), status: 'ACTIVE', finalScore: null }),
    },
    exam: {
      findMany: async () => [
        { id: 'unit-1', title: 'اختبار الوحدة', passScore: 60, unit: { title: 'وحدة ١' }, _count: { questions: 2 } },
      ],
    },
    examAttempt: {
      findMany: async () => attempts,
    },
    programAssignment: { findMany: async () => [] },
    assignmentSubmission: { findUnique: async () => null },
    programExam: { findMany: async () => [] },
    programExamAttempt: { findMany: async () => [] },
    thesisSubmission: { findFirst: async () => null },
  } as any
}

async function quizzesScore(attempts: any[]) {
  const grade = await calculateFinalGrade({ userId: 'student-1', programId: 'program-1', client: fakeClient(attempts) })
  return grade.components.find((c) => c.key === 'quizzes')?.score
}

describe('الدرجة المعتمدة المعدّلة يدويًا تتقدم على نقاط الإجابات', () => {
  test('سيناريو 40 ← 75: درجة مخزّنة 75 ونقاط إجابات 40 — المكوّن يستخدم 75', async () => {
    const score = await quizzesScore([
      { score: 75, passed: true, status: 'GRADED', answers: answersWorth40 },
    ])
    expect(score).toBe(75)
  })

  test('محاولة قديمة بلا درجة مخزّنة ترجع لنقاط الإجابات (40)', async () => {
    const score = await quizzesScore([
      { score: null, passed: true, status: 'GRADED', answers: answersWorth40 },
    ])
    expect(score).toBe(40)
  })

  test('أفضل محاولة تُختار من الدرجات المعتمدة لا من النقاط الخام', async () => {
    const score = await quizzesScore([
      { score: 75, passed: true, status: 'GRADED', answers: answersWorth40 },
      { score: 50, passed: false, status: 'GRADED', answers: [{ points: 50, maxPoints: 100 }] },
    ])
    expect(score).toBe(75)
  })

  test('دبوس ثابت: تعليق الأسبقية موجود بملف الدرجات', () => {
    const src = readFileSync('src/lib/final-grade.ts', 'utf8')
    expect(src).toContain('The approved attempt score is authoritative after manual review.')
  })
})
