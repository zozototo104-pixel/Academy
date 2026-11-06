import { describe, expect, mock, test } from 'bun:test'
mock.module('@/lib/db', () => ({ db: {} }))
const { calculateFinalGrade } = await import('../../src/lib/final-grade')
const { calculateSemesterAverages } = await import('../../src/lib/semester-grade')
const { captureEnrollmentSnapshot, ensureEnrollmentSnapshot } = await import('../../src/lib/rules-snapshot')
const { gradingFormulaSignature } = await import('../../src/lib/program-tracks')

// T1 — شرط إغلاق المرحلة الثالثة (قرار المالك 2026-11-05): تغيير الأوزان
// بعد التحاق الطالب لا يغيّر نتيجته التاريخية، لأن محركي الدرجات يقرآن
// لقطة الطالب المجمّدة لا إعدادات البرنامج الحالية.
const W1 = [
  { key: 'semester1_quizzes', label: 'اختبارات الفصل الأول القصيرة', weight: 10 }, { key: 'semester1_exam', label: 'امتحان الفصل الأول', weight: 20 },
  { key: 'semester2_quizzes', label: 'اختبارات الفصل الثاني القصيرة', weight: 10 }, { key: 'semester2_exam', label: 'امتحان الفصل الثاني', weight: 20 },
  { key: 'thesis', label: 'بحث التخرج المهني', weight: 25 }, { key: 'defense', label: 'المناقشة النهائية', weight: 15 },
]
const W2 = [
  { key: 'semester1_quizzes', label: 'اختبارات الفصل الأول القصيرة', weight: 5 }, { key: 'semester1_exam', label: 'امتحان الفصل الأول', weight: 25 },
  { key: 'semester2_quizzes', label: 'اختبارات الفصل الثاني القصيرة', weight: 5 }, { key: 'semester2_exam', label: 'امتحان الفصل الثاني', weight: 25 },
  { key: 'thesis', label: 'بحث التخرج المهني', weight: 25 }, { key: 'defense', label: 'المناقشة النهائية', weight: 15 },
]
const rules = (formula: typeof W1, approvedAt: string) => ({
  academicProfile: {
    finalEvaluationFormula: formula,
    approvedFormulaSignature: gradingFormulaSignature(formula),
    approvedFormulaAt: approvedAt,
  },
})

function makeWorld(formula: typeof W1) {
  const state: any = {
    admissionRules: rules(formula, '2026-01-01T00:00:00Z'),
    snapshots: new Map<string, any>(),
  }
  const client: any = {
    program: { findUnique: async () => ({ category: 'MASTERS', admissionRules: state.admissionRules, semestersCount: 2 }) },
    enrollment: {
      findUnique: async () => ({ id: 'enr1', createdAt: new Date('2026-06-01T00:00:00Z'), status: 'ACTIVE', finalScore: null }),
    },
    enrollmentRulesSnapshot: {
      findUnique: async ({ where }: any) => state.snapshots.get(where.enrollmentId) ?? null,
      create: async ({ data }: any) => {
        const row = { id: 'snap-' + data.enrollmentId, ...data, capturedAt: new Date(), createdAt: new Date() }
        state.snapshots.set(data.enrollmentId, row)
        return row
      },
    },
    exam: {
      findMany: async ({ where }: any) => [
        { id: 'ue1', passScore: 60, unit: { title: 'وحدة ١', semester: 1 }, _count: { questions: 5 } },
        { id: 'ue2', passScore: 60, unit: { title: 'وحدة ٢', semester: 2 }, _count: { questions: 5 } },
      ].filter((e) => !where.unit?.semester || e.unit.semester === where.unit.semester),
    },
    examAttempt: {
      findMany: async ({ where }: any) => (where.examId === 'ue1' ? [{ score: 100, passed: true }] : [{ score: 70, passed: true }]),
    },
    programExam: {
      findMany: async ({ where }: any) => [
        { id: 'pe1', title: 'امتحان الفصل الأول', semester: 1, passScore: 30 },
        { id: 'pe2', title: 'امتحان الفصل الثاني', semester: 2, passScore: 60 },
      ].filter((e) => !where.semester || e.semester === where.semester),
    },
    programExamAttempt: {
      findMany: async ({ where }: any) => (where.examId === 'pe1' ? [{ score: 40, passed: true }] : [{ score: 60, passed: true }]),
    },
    programAssignment: { findMany: async () => [] },
    assignmentSubmission: { findMany: async () => [] },
    thesisSubmission: {
      findFirst: async () => ({ status: 'RESULT_APPROVED', passed: true, resultScore: 80, aiScore: 90, defenseStatus: 'DONE' }),
    },
  }
  return { state, client }
}

const ENROLLMENT = { id: 'enr1', userId: 'u1', programId: 'p1', createdAt: new Date('2026-06-01T00:00:00Z') }

describe('لقطة قواعد الالتحاق المجمّدة', () => {
  test('T1: تغيير أوزان البرنامج بعد الالتحاق لا يغيّر نتيجة الطالب التاريخية', async () => {
    const { state, client } = makeWorld(W1)
    const before = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client })
    // W1: فصل ١ = (100×10 + 40×20)/30 = 60 — فصل ٢ = (70×10 + 60×20)/30 ≈ 63.33
    expect(before.semesters.map((s) => s.average)).toEqual([60, 63.33])
    // المركّب مع رسالة 90 ومناقشة 80: (60×30 + 63.33×30 + 90×25 + 80×15)/100 = 71.5
    expect(before.composedFinal).toBe(71.5)
    const flatBefore = await calculateFinalGrade({ userId: 'u1', programId: 'p1', client })
    expect(flatBefore.earnedScore).toBe(71.5)
    expect(flatBefore.score).toBe(71.5)

    // الإدارة تعتمد خريطة مختلفة بعد التحاق الطالب (واعتمادها قبل التحاقه
    // زمنيًا، فالحسم الحيّ نفسه كان سيستخدمها لطالب بلا لقطة):
    state.admissionRules = rules(W2, '2026-02-01T00:00:00Z')

    const after = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client })
    expect(after.semesters.map((s) => s.average)).toEqual([60, 63.33])
    expect(after.composedFinal).toBe(71.5)
    expect(after.weightSource).toBe('academic_profile')
    const flatAfter = await calculateFinalGrade({ userId: 'u1', programId: 'p1', client })
    expect(flatAfter.earnedScore).toBe(71.5)
    expect(flatAfter.score).toBe(71.5)
  })

  test('شاهد الضبط: بلا لقطة، الخريطة الجديدة هي التي تحكم (الاختبار يميّز فعلًا)', async () => {
    const { client } = makeWorld(W2)
    const result = await calculateSemesterAverages({ userId: 'u1', programId: 'p1', client })
    // اللقطة تُستكمَل عند أول احتساب من الحسم الحالي (W2) ثم تثبّته:
    expect(result.semesters[0].average).toBe(50)
    const flat = await calculateFinalGrade({ userId: 'u1', programId: 'p1', client })
    // (100×5 + 40×25 + 70×5 + 60×25 + 90×25 + 80×15)/100 = 68
    expect(flat.earnedScore).toBe(68)
  })

  test('اللقطة ثابتة: إعادة الالتقاط بعد تغيير القواعد لا تستبدل الأولى', async () => {
    const { state, client } = makeWorld(W1)
    const first = await captureEnrollmentSnapshot(client, ENROLLMENT, 'ENROLLMENT')
    expect(first?.basis).toBe('ENROLLMENT')
    expect(first?.passThreshold).toBe(50)
    expect(first?.thresholdStrict).toBe(true)
    expect(first?.requirements.requiredComponents).toEqual(['semester1_exam', 'semester2_exam', 'thesis', 'defense'])
    state.admissionRules = rules(W2, '2026-02-01T00:00:00Z')
    const second = await captureEnrollmentSnapshot(client, ENROLLMENT, 'ENROLLMENT')
    expect(second?.weights).toEqual(first?.weights)
    expect(state.snapshots.size).toBe(1)
  })

  test('الاستكمال عند أول احتساب يُعلَّم BACKFILL بأمانة', async () => {
    const { client } = makeWorld(W1)
    const snap = await ensureEnrollmentSnapshot(client, ENROLLMENT)
    expect(snap?.basis).toBe('BACKFILL')
    expect(snap?.weights.semester1_exam).toBe(20)
  })
})
