import { describe, expect, mock, test } from 'bun:test'

// GOLDEN reference suite for the final-grade engine (frozen 2026-11-05,
// BEFORE the Phase-3 lifecycle changes). Every number below was first
// captured by running the CURRENT src/lib/final-grade.ts against these
// fixtures, then hand-verified against manual arithmetic (cases 1 and 2
// show the math inline). After Phase 3, this suite must produce IDENTICAL
// results for these fixtures — any drift fails it and means the engine's
// observable behavior changed unintentionally.

mock.module('@/lib/db', () => ({ db: {} }))

const { calculateFinalGrade } = await import('@/lib/final-grade')
const { gradingFormulaSignature } = await import('@/lib/program-tracks')

// ---------------------------------------------------------------------------
// Fake client: implements exactly the queries the engine's helpers issue.
// examAttempt / programExamAttempt filter by args.where.examId;
// assignmentSubmission is keyed by args.where.assignmentId_userId.
// ---------------------------------------------------------------------------

type UnitExamRow = { id: string; title: string; passScore: number; semester: number; unitTitle: string; questions: number }
type UnitAttemptRow = { examId: string; score: number; passed: boolean }
type ProgramExamRow = { id: string; title: string; semester: number; passScore: number }
type ProgramAttemptRow = { examId: string; score: number; passed: boolean }
type AssignmentRow = { id: string; title: string; points: number; weight: number }
type SubmissionRow = { status: string; score: number }

interface Fixture {
  category: string
  admissionRules: unknown
  enrollment: { createdAt: Date; status: string; finalScore: number | null } | null
  unitExams: UnitExamRow[]
  unitAttempts: UnitAttemptRow[]
  programExams: ProgramExamRow[]
  programAttempts: ProgramAttemptRow[]
  assignments: AssignmentRow[]
  submissions: Record<string, SubmissionRow>
  thesis: { status: string; resultScore: number | null; aiScore: number | null; passed: boolean; defenseStatus: string | null } | null
}

function fakeClient(fx: Fixture) {
  return {
    program: {
      findUnique: async () => ({ category: fx.category, admissionRules: fx.admissionRules }),
    },
    enrollment: {
      findUnique: async () => fx.enrollment,
    },
    exam: {
      findMany: async (args: any) => {
        const semester = args?.where?.unit?.semester
        return fx.unitExams
          .filter((e) => semester === undefined || e.semester === semester)
          .map((e) => ({
            id: e.id,
            title: e.title,
            passScore: e.passScore,
            unit: { title: e.unitTitle },
            _count: { questions: e.questions },
          }))
      },
    },
    examAttempt: {
      findMany: async (args: any) =>
        fx.unitAttempts
          .filter((a) => a.examId === args?.where?.examId)
          .map((a) => ({ score: a.score, passed: a.passed, answers: [] as any[] })),
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
        fx.programAttempts
          .filter((a) => a.examId === args?.where?.examId)
          .map((a) => ({ score: a.score, finalScore: null, feedback: null, appealStatus: null, passed: a.passed, answers: [] as any[] })),
    },
    programAssignment: {
      findMany: async () => fx.assignments.map((a) => ({ id: a.id, title: a.title, points: a.points, weight: a.weight })),
    },
    assignmentSubmission: {
      findUnique: async (args: any) => {
        const key = args?.where?.assignmentId_userId
        const sub = key ? fx.submissions[key.assignmentId] : undefined
        return sub ? { status: sub.status, score: sub.score } : null
      },
    },
    thesisSubmission: {
      findFirst: async () => fx.thesis,
    },
  } as any
}

// ---------------------------------------------------------------------------
// Shared fixture parts
// ---------------------------------------------------------------------------

const diplomaExams = {
  unitExams: [
    { id: 'ue1', title: 'اختبار الوحدة ١', passScore: 60, semester: 1, unitTitle: 'الوحدة الأولى', questions: 5 },
    { id: 'ue2', title: 'اختبار الوحدة ٢', passScore: 60, semester: 2, unitTitle: 'الوحدة الثانية', questions: 5 },
  ] as UnitExamRow[],
  unitAttempts: [
    { examId: 'ue1', score: 80, passed: true },
    { examId: 'ue2', score: 100, passed: true },
  ] as UnitAttemptRow[],
  programExams: [
    { id: 'pe1', title: 'امتحان الفصل الأول', semester: 1, passScore: 60 },
    { id: 'pe2', title: 'امتحان الفصل الثاني', semester: 2, passScore: 60 },
  ] as ProgramExamRow[],
  programAttempts: [
    { examId: 'pe1', score: 70, passed: true },
    { examId: 'pe2', score: 90, passed: true },
  ] as ProgramAttemptRow[],
}

const mastersFormula = [
  { key: 'semester1_quizzes', label: 'اختبارات الفصل الأول القصيرة', weight: 10 },
  { key: 'semester1_exam', label: 'امتحان الفصل الأول', weight: 20 },
  { key: 'semester2_quizzes', label: 'اختبارات الفصل الثاني القصيرة', weight: 10 },
  { key: 'semester2_exam', label: 'امتحان الفصل الثاني', weight: 20 },
  { key: 'thesis', label: 'بحث التخرج المهني', weight: 25 },
  { key: 'defense', label: 'المناقشة النهائية', weight: 15 },
]

const mastersRules = {
  academicProfile: {
    finalEvaluationFormula: mastersFormula,
    approvedFormulaSignature: gradingFormulaSignature(mastersFormula),
    approvedFormulaAt: '2026-09-01T00:00:00.000Z',
  },
}

const mastersParts = {
  unitExams: [
    { id: 'm-ue1', title: 'اختبار وحدة ماجستير ١', passScore: 60, semester: 1, unitTitle: 'وحدة ماجستير الأولى', questions: 4 },
    { id: 'm-ue2', title: 'اختبار وحدة ماجستير ٢', passScore: 60, semester: 2, unitTitle: 'وحدة ماجستير الثانية', questions: 4 },
  ] as UnitExamRow[],
  unitAttempts: [
    { examId: 'm-ue1', score: 80, passed: true },
    { examId: 'm-ue2', score: 90, passed: true },
  ] as UnitAttemptRow[],
  programExams: [
    { id: 'm-pe1', title: 'امتحان ماجستير الفصل الأول', semester: 1, passScore: 60 },
    { id: 'm-pe2', title: 'امتحان ماجستير الفصل الثاني', semester: 2, passScore: 60 },
  ] as ProgramExamRow[],
  programAttempts: [
    { examId: 'm-pe1', score: 70, passed: true },
    { examId: 'm-pe2', score: 85, passed: true },
  ] as ProgramAttemptRow[],
  thesis: { status: 'RESULT_APPROVED', resultScore: 88, aiScore: 92, passed: true, defenseStatus: 'DONE' },
}

const baseFixture: Fixture = {
  category: 'DIPLOMA',
  admissionRules: null,
  enrollment: { createdAt: new Date('2026-08-15T00:00:00.000Z'), status: 'ACTIVE', finalScore: null },
  unitExams: [],
  unitAttempts: [],
  programExams: [],
  programAttempts: [],
  assignments: [],
  submissions: {},
  thesis: null,
}

async function grade(fx: Fixture) {
  return calculateFinalGrade({ userId: 'student-1', programId: 'program-1', client: fakeClient(fx) })
}

function componentsOf(result: Awaited<ReturnType<typeof grade>>) {
  return result.components.map((c) => ({
    key: c.key, label: c.label, weight: c.weight, score: c.score, weighted: c.weighted, ready: c.ready,
  }))
}

// ---------------------------------------------------------------------------
// Case 1 — DIPLOMA, no approved formula (category defaults 20/20/60).
// Hand math:
//   quizzes     = avg(80, 100) = 90          → 90 × 20/100 = 18
//   assignments = avg(90, 70)  = 80 (w 10/10) → 80 × 20/100 = 16
//   final_exam  = avg(70, 90)  = 80 (pooled)  → 80 × 60/100 = 48
//   total = 18 + 16 + 48 = 82, nothing missing → score = 82
// ---------------------------------------------------------------------------
describe('ذهبي ١ — دبلوم بالأوزان الافتراضية', () => {
  test('المعدل الكلي 82 ومكوّناته مثبّتة', async () => {
    const result = await grade({
      ...baseFixture,
      ...diplomaExams,
      assignments: [
        { id: 'a1', title: 'واجب ١', points: 100, weight: 10 },
        { id: 'a2', title: 'واجب ٢', points: 100, weight: 10 },
      ],
      submissions: {
        a1: { status: 'GRADED', score: 90 },
        a2: { status: 'GRADED', score: 70 },
      },
    })
    expect(result.score).toBe(82)
    expect(result.earnedScore).toBe(82)
    expect(result.progressScore).toBe(82)
    expect(result.weightSource).toBe('category_default')
    expect(result.weightWarning).toBeUndefined()
    expect(result.missing).toEqual([])
    expect(componentsOf(result)).toEqual([
      { key: 'quizzes', label: 'اختبارات قصيرة ومتابعة', weight: 20, score: 90, weighted: 18, ready: true },
      { key: 'assignments', label: 'واجبات أو أنشطة تطبيقية', weight: 20, score: 80, weighted: 16, ready: true },
      { key: 'final_exam', label: 'الاختبار النهائي', weight: 60, score: 80, weighted: 48, ready: true },
    ])
  })
})

// ---------------------------------------------------------------------------
// Case 2 — DIPLOMA, Yousef pattern: stored weights 10/0/0/10.
// Hand math (declared weights win because some are positive; total shares 20):
//   assignments = 97×(10/20) + 92.86×(0/20) + 90×(0/20) + 0×(10/20) = 48.5
//   (zero-weight assignments earn exactly 0; the unsubmitted w10 earns 0 and
//    makes the component incomplete)
//   assignments weighted = 48.5 × 20/100 = 9.7
//   earned = 18 (quizzes) + 9.7 + 48 (final_exam) = 75.7
//   score = null because the missing list is non-empty.
// ---------------------------------------------------------------------------
describe('ذهبي ٢ — دبلوم بنمط أوزان يوسف 10/0/0/10', () => {
  test('مكوّن الواجبات 48.5 ومساهمته 9.7 والمعدل الرسمي null', async () => {
    const result = await grade({
      ...baseFixture,
      ...diplomaExams,
      assignments: [
        { id: 'y1', title: 'واجب يوسف ١', points: 100, weight: 10 },
        { id: 'y2', title: 'واجب يوسف ٢', points: 100, weight: 0 },
        { id: 'y3', title: 'واجب يوسف ٣', points: 100, weight: 0 },
        { id: 'y4', title: 'واجب يوسف ٤', points: 100, weight: 10 },
      ],
      submissions: {
        y1: { status: 'GRADED', score: 97 },
        y2: { status: 'GRADED', score: 92.86 },
        y3: { status: 'GRADED', score: 90 },
        // y4: no submission at all
      },
    })
    expect(result.score).toBeNull()
    expect(result.earnedScore).toBe(75.7)
    expect(result.progressScore).toBe(75.7)
    expect(result.weightSource).toBe('category_default')
    expect(result.weightWarning).toBeUndefined()
    expect(result.missing).toEqual([
      'واجب منشور غير مكتمل أو غير مجتاز: واجب يوسف ٤',
      'واجبات أو أنشطة تطبيقية',
    ])
    expect(componentsOf(result)).toEqual([
      { key: 'quizzes', label: 'اختبارات قصيرة ومتابعة', weight: 20, score: 90, weighted: 18, ready: true },
      { key: 'assignments', label: 'واجبات أو أنشطة تطبيقية', weight: 20, score: 48.5, weighted: 9.7, ready: false },
      { key: 'final_exam', label: 'الاختبار النهائي', weight: 60, score: 80, weighted: 48, ready: true },
    ])
  })
})

// ---------------------------------------------------------------------------
// Case 3 — MASTERS, approved signed formula (10/20/10/20/25/15), enrollment
// created AFTER approvedFormulaAt → the approved weights bind.
//   s1 quizzes 80 → 8 | s1 exam 70 → 14 | s2 quizzes 90 → 9 | s2 exam 85 → 17
//   thesis research = aiScore 92 → 23 | defense = resultScore 88 → 13.2
//   total = 84.2
// ---------------------------------------------------------------------------
describe('ذهبي ٣ — ماجستير بمعادلة معتمدة موقّعة', () => {
  test('الأوزان المعتمدة تُستخدم والمعدل 84.2', async () => {
    const result = await grade({
      ...baseFixture,
      category: 'MASTERS',
      admissionRules: mastersRules,
      enrollment: { createdAt: new Date('2026-10-05T00:00:00.000Z'), status: 'ACTIVE', finalScore: null },
      ...mastersParts,
    })
    expect(result.score).toBe(84.2)
    expect(result.earnedScore).toBe(84.2)
    expect(result.progressScore).toBe(84.2)
    expect(result.weightSource).toBe('academic_profile')
    expect(result.weightWarning).toBeUndefined()
    expect(result.missing).toEqual([])
    expect(componentsOf(result)).toEqual([
      { key: 'semester1_quizzes', label: 'اختبارات الفصل الأول القصيرة', weight: 10, score: 80, weighted: 8, ready: true },
      { key: 'semester1_exam', label: 'امتحان الفصل الأول', weight: 20, score: 70, weighted: 14, ready: true },
      { key: 'semester2_quizzes', label: 'اختبارات الفصل الثاني القصيرة', weight: 10, score: 90, weighted: 9, ready: true },
      { key: 'semester2_exam', label: 'امتحان الفصل الثاني', weight: 20, score: 85, weighted: 17, ready: true },
      { key: 'thesis', label: 'بحث التخرج المهني', weight: 25, score: 92, weighted: 23, ready: true },
      { key: 'defense', label: 'المناقشة النهائية', weight: 15, score: 88, weighted: 13.2, ready: true },
    ])
  })
})

// ---------------------------------------------------------------------------
// Case 4 — MASTERS, SAME approved rules but enrollment created BEFORE
// approvedFormulaAt → future-cohort rule: category defaults (10/15/10/15/30/20)
// plus warning ASSESSMENT_FORMULA_FUTURE_COHORT_ONLY.
//   80×.10 + 70×.15 + 90×.10 + 85×.15 + 92×.30 + 88×.20
//   = 8 + 10.5 + 9 + 12.75 + 27.6 + 17.6 = 85.45
//   (earnedScore keeps the raw float 85.44999999999999; progressScore rounds
//    to 85.45 — both pinned exactly as the engine produces them today.)
// ---------------------------------------------------------------------------
describe('ذهبي ٤ — ماجستير مسجّل قبل اعتماد المعادلة (قاعدة الدفعات اللاحقة)', () => {
  test('يرجع للافتراضي مع تحذير FUTURE_COHORT_ONLY والمعدل 85.45', async () => {
    const result = await grade({
      ...baseFixture,
      category: 'MASTERS',
      admissionRules: mastersRules,
      enrollment: { createdAt: new Date('2026-08-01T00:00:00.000Z'), status: 'ACTIVE', finalScore: null },
      ...mastersParts,
    })
    expect(result.score).toBe(85.44999999999999)
    expect(result.earnedScore).toBe(85.44999999999999)
    expect(result.progressScore).toBe(85.45)
    expect(result.weightSource).toBe('category_default')
    expect(result.weightWarning).toBe('ASSESSMENT_FORMULA_FUTURE_COHORT_ONLY')
    expect(result.missing).toEqual([])
    expect(componentsOf(result)).toEqual([
      { key: 'semester1_quizzes', label: 'اختبارات الفصل الأول القصيرة', weight: 10, score: 80, weighted: 8, ready: true },
      { key: 'semester1_exam', label: 'امتحان الفصل الأول', weight: 15, score: 70, weighted: 10.5, ready: true },
      { key: 'semester2_quizzes', label: 'اختبارات الفصل الثاني القصيرة', weight: 10, score: 90, weighted: 9, ready: true },
      { key: 'semester2_exam', label: 'امتحان الفصل الثاني', weight: 15, score: 85, weighted: 12.75, ready: true },
      { key: 'thesis', label: 'بحث التخرج المهني', weight: 30, score: 92, weighted: 27.6, ready: true },
      { key: 'defense', label: 'المناقشة النهائية', weight: 20, score: 88, weighted: 17.6, ready: true },
    ])
  })
})

// ---------------------------------------------------------------------------
// Case 5 — DOCTORATE, category defaults, stage 1 only.
//   reading_quizzes 75 × 8/100 = 6 | reading_exam 65 × 12/100 = 7.8
//   stage-2 components and thesis/defense absent → score null each, the
//   FULL denominator stays, so earned = 13.8 and the official score is null.
// ---------------------------------------------------------------------------
describe('ذهبي ٥ — دكتوراه جزئي (المرحلة الأولى فقط)', () => {
  test('المكتسب 13.8 والمعدل الرسمي null وقائمة النواقص كاملة', async () => {
    const result = await grade({
      ...baseFixture,
      category: 'DOCTORATE',
      unitExams: [
        { id: 'd-ue1', title: 'اختبار قراءات', passScore: 60, semester: 1, unitTitle: 'وحدة القراءات', questions: 3 },
      ],
      unitAttempts: [{ examId: 'd-ue1', score: 75, passed: true }],
      programExams: [{ id: 'd-pe1', title: 'امتحان مرحلة القراءات', semester: 1, passScore: 60 }],
      programAttempts: [{ examId: 'd-pe1', score: 65, passed: true }],
    })
    expect(result.score).toBeNull()
    expect(result.earnedScore).toBe(13.8)
    expect(result.progressScore).toBe(13.8)
    expect(result.weightSource).toBe('category_default')
    expect(result.weightWarning).toBeUndefined()
    expect(result.missing).toEqual([
      'اختبارات وحدات الفصل 2',
      'امتحان برنامج الفصل 2',
      'اختبارات/حالات التطبيق والتحليل',
      'اختبار مرحلة التطبيق والتحليل',
      'الأطروحة المهنية',
      'المناقشة النهائية',
    ])
    expect(componentsOf(result)).toEqual([
      { key: 'reading_quizzes', label: 'اختبارات/تقارير القراءات المتقدمة', weight: 8, score: 75, weighted: 6, ready: true },
      { key: 'reading_exam', label: 'اختبار مرحلة القراءات المتقدمة', weight: 12, score: 65, weighted: 7.8, ready: true },
      { key: 'analysis_quizzes', label: 'اختبارات/حالات التطبيق والتحليل', weight: 8, score: null, weighted: 0, ready: false },
      { key: 'analysis_exam', label: 'اختبار مرحلة التطبيق والتحليل', weight: 12, score: null, weighted: 0, ready: false },
      { key: 'thesis', label: 'الأطروحة المهنية', weight: 40, score: null, weighted: 0, ready: false },
      { key: 'defense', label: 'المناقشة النهائية', weight: 20, score: null, weighted: 0, ready: false },
    ])
  })
})

// ---------------------------------------------------------------------------
// Case 6 — DIPLOMA, COMPLETED enrollment with stored finalScore 77.
// The archived-score rule: a COMPLETED enrollment's stored finalScore is
// returned verbatim as `score` even though the live computation is
// incomplete (earned 20, missing non-empty — without the rule the score
// would be null). The stored score is never overwritten by recomputation.
// ---------------------------------------------------------------------------
describe('ذهبي ٦ — دبلوم منجز بدرجة مؤرشفة 77', () => {
  test('الدرجة المؤرشفة 77 تتقدم على الحساب الحي الناقص', async () => {
    const result = await grade({
      ...baseFixture,
      enrollment: { createdAt: new Date('2026-08-15T00:00:00.000Z'), status: 'COMPLETED', finalScore: 77 },
      unitExams: [
        { id: 'c-ue1', title: 'اختبار وحدة منجز', passScore: 60, semester: 1, unitTitle: 'وحدة منجزة', questions: 5 },
      ],
      unitAttempts: [{ examId: 'c-ue1', score: 100, passed: true }],
    })
    expect(result.score).toBe(77)
    expect(result.earnedScore).toBe(20)
    expect(result.progressScore).toBe(20)
    expect(result.weightSource).toBe('category_default')
    expect(result.weightWarning).toBeUndefined()
    expect(result.missing).toEqual([
      'امتحانات البرنامج المطلوبة',
      'الواجبات المنشورة المصححة',
      'واجبات أو أنشطة تطبيقية',
      'الاختبار النهائي',
    ])
    expect(componentsOf(result)).toEqual([
      { key: 'quizzes', label: 'اختبارات قصيرة ومتابعة', weight: 20, score: 100, weighted: 20, ready: true },
      { key: 'assignments', label: 'واجبات أو أنشطة تطبيقية', weight: 20, score: null, weighted: 0, ready: false },
      { key: 'final_exam', label: 'الاختبار النهائي', weight: 60, score: null, weighted: 0, ready: false },
    ])
  })
})
