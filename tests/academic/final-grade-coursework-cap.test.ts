import { describe, expect, mock, test } from 'bun:test'

// Route-level persistence is tested elsewhere; this is the grade calculation's behavioral contract.
mock.module('@/lib/db', () => ({ db: {} }))
const { calculateFinalGrade } = await import('@/lib/final-grade')
const { gradingFormulaSignature } = await import('@/lib/program-tracks')

const diplomaFormula = [
  { key: 'quizzes', label: 'اختبارات قصيرة ومتابعة', weight: 30 },
  { key: 'assignments', label: 'واجبات أو أنشطة تطبيقية', weight: 20 },
  { key: 'final_exam', label: 'الاختبار النهائي', weight: 50 },
]

type Scenario = {
  units?: Record<number, number>
  assignments?: Record<number, number>
  assignmentWeights?: number[]
  examRaw?: number
  examStored?: number
  appealFinal?: number
  formula?: Array<{ key?: string; label: string; weight: number }>
  approval?: 'APPROVED' | 'UNAPPROVED'
  thesisScore?: number
}

function fakeClient(scenario: Scenario = {}) {
  const units = scenario.units || {}
  const assignments = scenario.assignments || {}
  const weights = scenario.assignmentWeights || [5, 5, 5, 5]
  return {
    program: {
      findUnique: async () => ({
        category: 'DIPLOMA',
        admissionRules: {
          academicProfile: {
            finalEvaluationFormula: scenario.formula || diplomaFormula,
            approvedFormulaSignature: scenario.approval === 'UNAPPROVED'
              ? undefined : gradingFormulaSignature(scenario.formula || diplomaFormula),
          },
        },
      }),
    },
    exam: {
      findMany: async () => Array.from({ length: 6 }, (_, i) => ({
        id: `unit-${i + 1}`, title: `اختبار ${i + 1}`, passScore: 60,
        unit: { title: `وحدة ${i + 1}` }, _count: { questions: 5 },
      })),
    },
    examAttempt: {
      findMany: async ({ where }: any) => {
        const number = Number(String(where.examId).replace('unit-', ''))
        const score = units[number]
        return score === undefined ? [] : [{ score, passed: score >= 60, status: 'GRADED', answers: [{ points: score, maxPoints: 100 }] }]
      },
    },
    programAssignment: {
      findMany: async () => weights.map((weight, i) => ({ id: `a-${i + 1}`, title: `واجب ${i + 1}`, points: 100, weight })),
    },
    assignmentSubmission: {
      findUnique: async ({ where }: any) => {
        const number = Number(String(where.assignmentId_userId.assignmentId).replace('a-', ''))
        return assignments[number] === undefined ? null : { status: 'GRADED', score: assignments[number] }
      },
    },
    programExam: {
      findMany: async () => [{ id: 'final-1', title: 'الامتحان الفصلي', semester: 1, passScore: 60 }],
    },
    programExamAttempt: {
      findMany: async () => scenario.examRaw === undefined ? [] : [{
        status: 'GRADED', passed: true,
        score: scenario.examStored ?? scenario.examRaw,
        finalScore: scenario.appealFinal ?? null,
        appealStatus: scenario.appealFinal === undefined ? null : 'REVIEWED',
        feedback: JSON.stringify({ rawScoreBeforeCourseworkCap: scenario.examRaw }),
        answers: [{ points: scenario.examRaw, maxPoints: 100 }],
      }],
    },
    thesisSubmission: {
      findFirst: async () => scenario.thesisScore == null ? null : {
        status: 'RESULT_APPROVED', passed: true, resultScore: scenario.thesisScore,
        aiScore: scenario.thesisScore,
      },
    },
  } as any
}

async function calculate(scenario: Scenario) {
  return calculateFinalGrade({ userId: 'student-1', programId: 'program-1', client: fakeClient(scenario) })
}

const unitsThree = { 1: 70, 2: 70, 3: 70 }
const assignmentsTwo = { 1: 80, 2: 80 }

describe('التجميع التراكمي بالأوزان الرسمية', () => {
  test('٣ وحدات من ٦ بمتوسط ٧٠ = ١٠٫٥ من ٣٠؛ واجبان ٨٠ = ٨ من ٢٠؛ فصلي ٩٠ = ٤٥ من ٥٠', async () => {
    const grade = await calculate({ units: unitsThree, assignments: assignmentsTwo, examRaw: 90 })
    expect(grade.progressScore).toBeCloseTo(63.5, 6)
    expect(grade.score).toBeNull() // A certificate grade is not final while required work is outstanding.
    expect(grade.weightSource).toBe('academic_profile')
    expect(grade.components.find((c) => c.key === 'quizzes')?.weighted).toBeCloseTo(10.5, 6)
    expect(grade.components.find((c) => c.key === 'assignments')?.weighted).toBeCloseTo(8, 6)
    expect(grade.components.find((c) => c.key === 'final_exam')?.weighted).toBeCloseTo(45, 6)
  })

  test('نجاح وحدة رابعة يعيد الحساب دون فقدان أو تضخيم الوحدات السابقة', async () => {
    const before = await calculate({ units: unitsThree, assignments: assignmentsTwo, examRaw: 90 })
    const after = await calculate({ units: { ...unitsThree, 4: 70 }, assignments: assignmentsTwo, examRaw: 90 })
    expect(after.progressScore - before.progressScore).toBeCloseTo(3.5, 6)
    expect(after.score).toBeNull()
  })

  test('بعد إكمال كل الوحدات والواجبات تُصبح النتيجة النهائية هي المجموع دون خصم مزدوج', async () => {
    const grade = await calculate({
      units: { 1: 70, 2: 70, 3: 70, 4: 70, 5: 70, 6: 70 },
      assignments: { 1: 80, 2: 80, 3: 80, 4: 80 },
      examRaw: 90,
    })
    expect(grade.score).toBeCloseTo(82, 6)
    expect(grade.progressScore).toBeCloseTo(82, 6)
    expect(grade.missing).toEqual([])
  })

  test('العلامة القديمة المقيدة ٧٠ لا تخفض الامتحان الخام ٩٥ مرة ثانية', async () => {
    const grade = await calculate({
      units: { 1: 70, 2: 70, 3: 70, 4: 70, 5: 70, 6: 70 },
      assignments: { 1: 80, 2: 80, 3: 80, 4: 80 },
      examRaw: 95, examStored: 70,
    })
    expect(grade.components.find((c) => c.key === 'final_exam')?.score).toBe(95)
    expect(grade.score).toBeCloseTo(84.5, 6)
  })

  test('قرار مراجعة الطعن المعتمد يتقدم على العلامة الخام', async () => {
    const grade = await calculate({
      units: { 1: 70, 2: 70, 3: 70, 4: 70, 5: 70, 6: 70 },
      assignments: { 1: 80, 2: 80, 3: 80, 4: 80 },
      examRaw: 95, examStored: 70, appealFinal: 88,
    })
    expect(grade.components.find((c) => c.key === 'final_exam')?.score).toBe(88)
    expect(grade.score).toBeCloseTo(81, 6)
  })

  test('واجب بوزن صفر لا يكسب علامات ولا يعطل كسب العلامات الأخرى', async () => {
    const grade = await calculate({
      units: unitsThree, examRaw: 90,
      assignmentWeights: [20, 10, 0, 0],
      assignments: { 1: 80, 2: 70 },
    })
    // (80*20 + 70*10)/30 = 76.666% of the assignment component.
    expect(grade.components.find((c) => c.key === 'assignments')?.weighted).toBeCloseTo(15.333333, 5)
    expect(grade.score).toBeNull() // Zero-weight assignments can still be mandatory completion work.
  })

  test('توزيع دبلوم خاص ٢٠/٢٠/٤٠/٢٠ يضيف البحث بدل تغيير وزن الامتحان إلى ٦٠', async () => {
    const grade = await calculate({
      units: { 1: 70, 2: 70, 3: 70, 4: 70, 5: 70, 6: 70 },
      assignments: { 1: 80, 2: 80, 3: 80, 4: 80 },
      examRaw: 90, thesisScore: 80,
      formula: [
        { key: 'quizzes', label: 'اختبارات قصيرة ومتابعة', weight: 20 },
        { key: 'assignments', label: 'واجبات أو أنشطة تطبيقية', weight: 20 },
        { key: 'final_exam', label: 'الاختبار النهائي', weight: 40 },
        { key: 'thesis', label: 'بحث تخرج', weight: 20 },
      ],
    })
    expect(grade.weightSource).toBe('academic_profile')
    expect(grade.components.find((c) => c.key === 'thesis')?.weighted).toBeCloseTo(16, 6)
    expect(grade.score).toBeCloseTo(82, 6)
  })

  test('صيغة وزن غير كاملة لا تُستخدم بصمت؛ يرجع النظام لتوزيع الفئة مع تحذير', async () => {
    const grade = await calculate({
      units: { 1: 70, 2: 70, 3: 70, 4: 70, 5: 70, 6: 70 },
      assignments: { 1: 80, 2: 80, 3: 80, 4: 80 },
      examRaw: 90,
      formula: [{ label: 'الاختبار النهائي', weight: 60 }],
    })
    expect(grade.weightSource).toBe('category_default')
    expect(grade.weightWarning).toBe('ASSESSMENT_FORMULA_INVALID')
    expect(grade.score).toBeCloseTo(84, 6)
  })
})
