import { describe, expect, mock, test } from 'bun:test'

// Phase-3 suite: per-semester averages as decision values, derived from the
// same approved weight map as the final-grade engine. Pins:
//  - within-semester renormalization and the STRICT > 50 pass rule;
//  - the recomposition S1avg×W1 + S2avg×W2 + thesis×Wr (+defense) and its
//    equality with the flat engine's earned score on shared fixtures;
//  - the future-cohort fallback (defaults + warning), shared with the
//    golden suite's case 4;
//  - incomplete semesters counting missing work as zero, and a semester
//    with no scorable activity yielding a null average (never a fake 0).

mock.module('@/lib/db', () => ({ db: {} }))

const { calculateSemesterAverages } = await import('@/lib/semester-grade')
const { calculateFinalGrade } = await import('@/lib/final-grade')
const { gradingFormulaSignature } = await import('@/lib/program-tracks')

type UnitExamRow = { id: string; passScore: number; semester: number; unitTitle: string; questions: number }
type ProgramExamRow = { id: string; title: string; semester: number; passScore: number }
type AssignmentRow = { id: string; points: number; weight: number; semester: number }

interface Fixture {
  category: string
  admissionRules: unknown
  semestersCount: number | null
  enrollment: { createdAt: Date; status: string; finalScore: number | null } | null
  unitExams: UnitExamRow[]
  unitAttempts: Record<string, { score: number; passed: boolean }[]>
  programExams: ProgramExamRow[]
  programAttempts: Record<string, { score: number; passed: boolean }[]>
  assignments: AssignmentRow[]
  submissions: Record<string, { status: string; score: number }>
  thesis: { status: string; resultScore: number | null; aiScore: number | null; passed: boolean; defenseStatus: string | null } | null
}

function fakeClient(fx: Fixture) {
  return {
    program: {
      findUnique: async () => ({ category: fx.category, admissionRules: fx.admissionRules, semestersCount: fx.semestersCount }),
    },
    enrollment: { findUnique: async () => fx.enrollment },
    exam: {
      findMany: async (args: any) => {
        const semester = args?.where?.unit?.semester
        return fx.unitExams
          .filter((e) => semester === undefined || e.semester === semester)
          .map((e) => ({ id: e.id, title: e.unitTitle, passScore: e.passScore, unit: { title: e.unitTitle }, _count: { questions: e.questions } }))
      },
    },
    examAttempt: {
      findMany: async (args: any) =>
        (fx.unitAttempts[args?.where?.examId] || []).map((a) => ({ score: a.score, passed: a.passed, answers: [] as any[] })),
    },
    programExam: {
      findMany: async (args: any) => {
        const semester = args?.where?.semester
        return fx.programExams
          .filter((e) => semester === undefined || e.semester === semester)
          .map((e) => ({ id: e.id, title: e.title, semester: e.semester, passScore: e.passScore }))
      },
    },
    programExamAttempt: {
      findMany: async (args: any) =>
        (fx.programAttempts[args?.where?.examId] || []).map((a) => ({
          score: a.score, finalScore: null, feedback: null, appealStatus: null, passed: a.passed, answers: [] as any[],
        })),
    },
    programAssignment: {
      findMany: async (args: any) => {
        const semester = args?.where?.semester
        return fx.assignments
          .filter((a) => semester === undefined || a.semester === semester)
          .map((a) => ({ id: a.id, title: a.id, points: a.points, weight: a.weight }))
      },
    },
    assignmentSubmission: {
      findUnique: async (args: any) => {
        const key = args?.where?.assignmentId_userId
        const sub = key ? fx.submissions[key.assignmentId] : undefined
        return sub ? { status: sub.status, score: sub.score } : null
      },
    },
    thesisSubmission: { findFirst: async () => fx.thesis },
  } as any
}

const baseDiploma: Fixture = {
  category: 'DIPLOMA',
  admissionRules: null,
  semestersCount: 2,
  enrollment: { createdAt: new Date('2026-01-01'), status: 'ACTIVE', finalScore: null },
  unitExams: [
    { id: 'ue1', passScore: 60, semester: 1, unitTitle: 'الوحدة الأولى', questions: 5 },
    { id: 'ue2', passScore: 60, semester: 2, unitTitle: 'الوحدة الثانية', questions: 5 },
  ],
  unitAttempts: { ue1: [{ score: 80, passed: true }], ue2: [{ score: 100, passed: true }] },
  programExams: [
    { id: 'pe1', title: 'امتحان الفصل الأول', semester: 1, passScore: 60 },
    { id: 'pe2', title: 'امتحان الفصل الثاني', semester: 2, passScore: 60 },
  ],
  programAttempts: { pe1: [{ score: 70, passed: true }], pe2: [{ score: 90, passed: true }] },
  assignments: [
    { id: 'a1', points: 100, weight: 10, semester: 1 },
    { id: 'a2', points: 100, weight: 10, semester: 2 },
  ],
  submissions: { a1: { status: 'GRADED', score: 90 }, a2: { status: 'GRADED', score: 70 } },
  thesis: null,
}

describe('معدلات الفصول — دبلوم (أوزان افتراضية، خريطة مجمّعة)', () => {
  test('معدلا الفصلين والتركيب النهائي يساوي محرك الدرجة المسطّح (82)', async () => {
    const client = fakeClient(baseDiploma)
    const result = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client })
    // S1: (80×20 + 90×20 + 70×60)/100 = 76 — S2: (100×20 + 70×20 + 90×60)/100 = 88
    expect(result.semesters[0].average).toBe(76)
    expect(result.semesters[0].passed).toBe(true)
    expect(result.semesters[0].complete).toBe(true)
    expect(result.semesters[1].average).toBe(88)
    expect(result.semesters[1].passed).toBe(true)
    // التركيب: (76×50 + 88×50)/100 = 82
    expect(result.composedFinal).toBe(82)
    const flat = await calculateFinalGrade({ userId: 'u1', programId: 'p1', client })
    expect(flat.earnedScore).toBe(82)
    expect(result.composedFinal).toBe(flat.earnedScore)
  })

  test('حدّ النجاح صارم: معدل 50.0 بالضبط = غير ناجح، و51 = ناجح', async () => {
    const fx: Fixture = {
      ...baseDiploma,
      unitAttempts: { ue1: [{ score: 50, passed: false }], ue2: [{ score: 51, passed: false }] },
      programAttempts: { pe1: [{ score: 50, passed: false }], pe2: [{ score: 51, passed: false }] },
      submissions: { a1: { status: 'GRADED', score: 50 }, a2: { status: 'GRADED', score: 51 } },
    }
    const result = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client: fakeClient(fx) })
    expect(result.semesters[0].average).toBe(50)
    expect(result.semesters[0].passed).toBe(false)
    expect(result.semesters[1].average).toBe(51)
    expect(result.semesters[1].passed).toBe(true)
  })

  test('وحدة بلا محاولة تُحسب صفرًا داخل فصلها والفصل غير مكتمل', async () => {
    const fx: Fixture = { ...baseDiploma, unitAttempts: { ue1: [{ score: 80, passed: true }], ue2: [] } }
    const result = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client: fakeClient(fx) })
    const s2 = result.semesters[1]
    // S2 quizzes component = 0 (missing counts zero, full denominator)
    expect(s2.components.find((c) => c.key === 'quizzes')?.score).toBe(0)
    expect(s2.complete).toBe(false)
    // S2: (0×20 + 70×20 + 90×60)/100 = 68
    expect(s2.average).toBe(68)
  })

  test('فصل بلا أي نشاط قابل للاحتساب: معدله null ونجاحه null والتركيب null', async () => {
    const fx: Fixture = {
      ...baseDiploma,
      unitExams: baseDiploma.unitExams.filter((e) => e.semester === 1),
      programExams: baseDiploma.programExams.filter((e) => e.semester === 1),
      assignments: baseDiploma.assignments.filter((a) => a.semester === 1),
    }
    const result = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client: fakeClient(fx) })
    expect(result.semesters[1].average).toBeNull()
    expect(result.semesters[1].passed).toBeNull()
    expect(result.composedFinal).toBeNull()
  })
})

const mastersFormula = [
  { key: 'semester1_quizzes', weight: 10 },
  { key: 'semester1_exam', weight: 20 },
  { key: 'semester2_quizzes', weight: 10 },
  { key: 'semester2_exam', weight: 20 },
  { key: 'thesis', weight: 25 },
  { key: 'defense', weight: 15 },
]
const mastersRules = {
  academicProfile: {
    finalEvaluationFormula: mastersFormula,
    approvedFormulaSignature: gradingFormulaSignature(mastersFormula as any),
    approvedFormulaAt: '2026-01-01T00:00:00.000Z',
  },
}
const baseMasters: Fixture = {
  category: 'MASTERS',
  admissionRules: mastersRules,
  semestersCount: 2,
  enrollment: { createdAt: new Date('2026-02-01'), status: 'ACTIVE', finalScore: null },
  unitExams: [
    { id: 'ue1', passScore: 60, semester: 1, unitTitle: 'وحدة ١', questions: 5 },
    { id: 'ue2', passScore: 60, semester: 2, unitTitle: 'وحدة ٢', questions: 5 },
  ],
  unitAttempts: { ue1: [{ score: 80, passed: true }], ue2: [{ score: 60, passed: true }] },
  programExams: [
    { id: 'pe1', title: 'امتحان الفصل الأول', semester: 1, passScore: 60 },
    { id: 'pe2', title: 'امتحان الفصل الثاني', semester: 2, passScore: 60 },
  ],
  programAttempts: { pe1: [{ score: 70, passed: true }], pe2: [{ score: 90, passed: true }] },
  assignments: [],
  submissions: {},
  thesis: { status: 'RESULT_APPROVED', resultScore: 85, aiScore: 75, passed: true, defenseStatus: 'DONE' },
}

describe('معدلات الفصول — ماجستير (خريطة معتمدة موقّعة لكل فصل)', () => {
  test('معدلات لكل فصل من مفاتيح الخريطة نفسها والتركيب يطابق المحرك المسطّح', async () => {
    const client = fakeClient(baseMasters)
    const result = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client })
    expect(result.weightSource).toBe('academic_profile')
    // S1: (80×10 + 70×20)/30 = 73.33 — S2: (60×10 + 90×20)/30 = 80
    expect(result.semesters[0].average).toBe(73.33)
    expect(result.semesters[1].average).toBe(80)
    // التركيب: (73.33×30 + 80×30 + 75×25 + 85×15)/100 = 77.5
    expect(result.composedFinal).toBe(77.5)
    const flat = await calculateFinalGrade({ userId: 'u1', programId: 'p1', client })
    expect(flat.earnedScore).toBeCloseTo(77.5, 6)
    expect(result.composedFinal).toBeCloseTo(flat.earnedScore, 6)
  })

  test('التحاق قبل اعتماد الخريطة: أوزان افتراضية + تحذير الدفعة المستقبلية', async () => {
    // قاعدة المحرك (منذ #170): الخريطة المعتمدة تلزم فقط الالتحاقات الواقعة
    // في تاريخ اعتمادها أو بعده؛ مَن التحق قبل الاعتماد يبقى على الافتراضي.
    const fx: Fixture = { ...baseMasters, enrollment: { createdAt: new Date('2025-06-01'), status: 'ACTIVE', finalScore: null } }
    const result = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client: fakeClient(fx) })
    expect(result.weightSource).toBe('category_default')
    expect(result.weightWarning).toBe('ASSESSMENT_FORMULA_FUTURE_COHORT_ONLY')
    // بالأوزان الافتراضية (10/15): S1 = (80×10 + 70×15)/25 = 74
    expect(result.semesters[0].average).toBe(74)
  })
})
