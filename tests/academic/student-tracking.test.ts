import { describe, expect, mock, test } from 'bun:test'

// Guard suite for the shared semester-tracking layer (قرار المالك
// 2026-11-07، حالة الطالبة إشراق): متابعة الفصول منفصلة عن المعدل
// التراكمي للبرنامج. Pins:
//  - per-semester unit averages and counters (never pooled): S1 counts
//    only S1 units, S2 only S2 units — a pooled 10/18 view is the bug;
//  - a semester average without a stored, still-valid approval is
//    PROVISIONAL («مؤقت — غير معتمد») even when it exceeds 50;
//  - legacy graded results in a later semester are PRESERVED (visible,
//    counted in their own semester, untouched) and never enter the
//    current semester's progress before official progression;
//  - after S1 approval, the same S2 results surface as normal S2
//    progress — identical numbers, nothing deleted or re-graded;
//  - the programme earned figure is the untouched flat engine's own
//    output on the same fixture (27.37 for the Ishraq shape);
//  - the layer is read-only: fixture grade data is byte-identical
//    after every call.

mock.module('@/lib/db', () => ({ db: {} }))

const { getStudentSemesterTracking } = await import('@/lib/student-tracking')
const { calculateFinalGrade } = await import('@/lib/final-grade')
const { calculateSemesterAverages } = await import('@/lib/semester-grade')

type UnitExamRow = { id: string; passScore: number; semester: number; unitTitle: string; questions: number }

interface Fixture {
  unitExams: UnitExamRow[]
  unitAttempts: Record<string, { score: number; passed: boolean }[]>
  programExams: { id: string; semester: number; passScore: number; status: 'READY' }[]
  programAttempts: Record<string, { score: number; passed: boolean }[]>
  assignments: { id: string; points: number; weight: number; semester: number }[]
  submissions: Record<string, { status: string; score: number }>
  approvals: Record<number, { score: number } | null>
}

function fakeClient(fx: Fixture) {
  return {
    program: {
      findUnique: async () => ({ category: 'DIPLOMA', admissionRules: null, semestersCount: 2 }),
    },
    enrollment: {
      findUnique: async () => ({ id: 'enr1', userId: 'u1', programId: 'p1', createdAt: new Date('2025-09-01'), status: 'ACTIVE', finalScore: null }),
    },
    enrollmentRulesSnapshot: {
      findUnique: async () => ({
        id: 'snap1', enrollmentId: 'enr1', weightSource: 'category_default',
        weightsJson: JSON.stringify({ quizzes: 20, assignments: 20, final_exam: 60 }),
        requirementsJson: JSON.stringify({ semestersCount: 2, requiredComponents: ['final_exam'] }),
        passThreshold: 50, thresholdStrict: true, basis: 'BACKFILL',
        capturedAt: new Date('2026-11-06'),
      }),
    },
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
      findMany: async (args: any) => fx.programExams
        .filter((e) => args?.where?.semester === undefined || e.semester === args.where.semester)
        .map((e) => ({
          ...e, title: `امتحان الفصل ${e.semester}`,
          createdAt: new Date(`2026-11-0${e.semester}`),
          questions: [{ points: 100 }],
        })),
    },
    programExamAttempt: {
      findMany: async (args: any) => (fx.programAttempts[args?.where?.examId] || [])
        .filter((a) => args?.where?.passed !== true || a.passed)
        .map((a, i) => ({
          id: `pa${i}`, status: 'GRADED', score: a.score, finalScore: null,
          passed: a.passed, appealStatus: null, feedback: null,
          answers: [{ points: a.score, maxPoints: 100 }],
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
    thesisSubmission: { findFirst: async () => null },
    semesterResultApproval: {
      findUnique: async (args: any) => {
        const key = args?.where?.enrollmentId_semester
        const row = key ? fx.approvals[key.semester] : null
        return row ? { enrollmentId: 'enr1', semester: key.semester, status: 'APPROVED', score: row.score } : null
      },
    },
  } as any
}

// Realistic, synthetic Ishraq-shaped scenario: 7 S1 units (5 graded),
// 11 S2 units (5 graded before the access gate), five S1 graded assignments,
// and one READY, unattempted programme examination in EACH semester.
// No personal records or production IDs are copied into these fixtures.
function ishrakFixture(): Fixture {
  const s1Scores: Record<string, number> = { ue1: 99.8, ue2: 52.2, ue3: 80, ue4: 79.7, ue5: 96.5 }
  const s2Scores: Record<string, number> = { ue8: 80, ue9: 80, ue10: 82.3, ue11: 66.7, ue12: 68.3 }
  const unitExams: UnitExamRow[] = []
  const unitAttempts: Fixture['unitAttempts'] = {}
  for (let i = 1; i <= 18; i++) {
    const id = `ue${i}`
    unitExams.push({ id, passScore: 60, semester: i <= 7 ? 1 : 2, unitTitle: `وحدة ${i}`, questions: 5 })
    const score = s1Scores[id] ?? s2Scores[id]
    if (score !== undefined) unitAttempts[id] = [{ score, passed: score >= 60 }]
  }
  return {
    unitExams,
    unitAttempts,
    programExams: [
      { id: 'pe1', semester: 1, passScore: 60, status: 'READY' },
      { id: 'pe2', semester: 2, passScore: 60, status: 'READY' },
    ],
    programAttempts: {},
    assignments: Array.from({ length: 5 }, (_, i) => ({
      id: `a${i + 1}`, points: i === 4 ? 20 : 100, weight: 20, semester: 1,
    })),
    submissions: {
      a1: { status: 'GRADED', score: 85 },
      a2: { status: 'GRADED', score: 88 },
      a3: { status: 'GRADED', score: 95 },
      a4: { status: 'GRADED', score: 98 },
      a5: { status: 'GRADED', score: 20 },
    },
    approvals: {},
  }
}

describe('متابعة الفصول — حالة إشراق (7/11)', () => {
  test('متوسطات وعدّادات منفصلة لكل فصل — لا تجميع 10/18', async () => {
    const fx = ishrakFixture()
    const tracking = await getStudentSemesterTracking(fakeClient(fx), { userId: 'u1', programId: 'p1' })
    const [s1, s2] = tracking.semesters
    expect(s1.unitExamsTotal).toBe(7)
    expect(s1.unitExamsGraded).toBe(5)
    expect(s1.unitAverage).toBeCloseTo(58.31, 2)
    expect(s2.unitExamsTotal).toBe(11)
    expect(s2.unitExamsGraded).toBe(5)
    expect(s2.unitAverage).toBeCloseTo(34.30, 2)
    // The pooled figure (43.64) must not leak into either semester.
    expect(Math.abs((s1.unitAverage ?? 0) - 43.64)).toBeGreaterThan(1)
    expect(Math.abs((s2.unitAverage ?? 0) - 43.64)).toBeGreaterThan(1)
  })

  test('بلا اعتماد: الكل مؤقت، الفصل الثاني محفوظ، والمحصّل يطابق المحرك', async () => {
    const fx = ishrakFixture()
    const client = fakeClient(fx)
    const tracking = await getStudentSemesterTracking(client, { userId: 'u1', programId: 'p1' })
    const [s1, s2] = tracking.semesters
    expect(s1.approval).toBe('PROVISIONAL')
    expect(s2.approval).toBe('PROVISIONAL')
    // Her provisional S1 semester average exists and exceeds 50 — and is
    // still NOT an official pass (no approval stored).
    expect(s1.semesterAverage).toBeCloseTo(75.76, 1)
    expect(s1.semesterPassed).toBe(true)
    expect(s2.preserved).toBe(true)
    expect(s1.preserved).toBe(false)
    const flat = await calculateFinalGrade({ userId: 'u1', programId: 'p1', client })
    expect(tracking.programme?.earnedScore).toBe(flat.earnedScore)
    expect(tracking.programme?.earnedScore).toBeCloseTo(27.37, 2)
    expect(tracking.programme?.score).toBeNull()
  })

  test('بعد اعتماد الفصل الأول: معتمد، والثاني يظهر ضمن تقدمه بنفس الأرقام', async () => {
    const fx = ishrakFixture()
    const averages = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client: fakeClient(fx) })
    const s1Average = averages.semesters[0].average
    expect(s1Average).not.toBeNull()
    fx.approvals = { 1: { score: s1Average as number } }
    const tracking = await getStudentSemesterTracking(fakeClient(fx), { userId: 'u1', programId: 'p1' })
    const [s1, s2] = tracking.semesters
    expect(s1.approval).toBe('APPROVED')
    expect(s1.approvedScore).toBe(s1Average)
    expect(s1.semesterAverage).toBe(s1Average)
    expect(s2.preserved).toBe(false)
    // Preservation through the transition: identical S2 numbers.
    expect(s2.unitExamsGraded).toBe(5)
    expect(s2.unitAverage).toBeCloseTo(34.30, 2)
  })

  test('الطبقة قراءة فقط: بيانات الدرجات لا تتغير بعد الاستدعاءات', async () => {
    const fx = ishrakFixture()
    const before = JSON.stringify({ attempts: fx.unitAttempts, submissions: fx.submissions })
    const client = fakeClient(fx)
    await getStudentSemesterTracking(client, { userId: 'u1', programId: 'p1' })
    fx.approvals = { 1: { score: 75.76 } }
    await getStudentSemesterTracking(client, { userId: 'u1', programId: 'p1' })
    expect(JSON.stringify({ attempts: fx.unitAttempts, submissions: fx.submissions })).toBe(before)
  })
})
