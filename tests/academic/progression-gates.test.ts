// المرحلة 5 — بوابات الانتقال والرسالة: لا انتقال إلا بنجاح معتمد،
// ولا رسالة إلا ببوابتها، والحساب من نتائج معتمدة مخزّنة فقط.
// التشغيل: bun test tests/academic/progression-gates.test.ts (منفردًا)
import { describe, expect, mock, test } from 'bun:test'

mock.module('@/lib/db', () => ({ db: {} }))

const { progressionGate, thesisGate, semesterExamRequired } = await import('@/lib/progression')
const { submissionWindowCheck } = await import('@/lib/semester-lifecycle')

type Cfg = {
  weights?: Record<string, number>
  requiredComponents?: string[]
  approvals?: Record<number, number | null>
  states?: Record<number, string>
  unitScore?: Record<number, number>
  examScore?: Record<number, number>
  examPassed?: Record<number, boolean>
  examPassScore?: number
  footprint?: boolean
  snapshotBasis?: 'ENROLLMENT' | 'BACKFILL' | null
}

function fakeClient(cfg: Cfg) {
  const weights = cfg.weights || { quizzes: 20, assignments: 20, final_exam: 60 }
  const snapshotRow = {
    id: 'snap1',
    enrollmentId: 'e1',
    weightsJson: JSON.stringify(weights),
    weightSource: 'category_default',
    weightWarning: null,
    passThreshold: 50,
    thresholdStrict: true,
    requirementsJson: JSON.stringify({ semestersCount: 2, requiredComponents: cfg.requiredComponents || ['final_exam'] }),
    basis: cfg.snapshotBasis === undefined
      ? (cfg.footprint === false ? 'BACKFILL' : 'ENROLLMENT')
      : cfg.snapshotBasis,
    capturedAt: new Date('2026-01-01'),
  }
  const approvals = cfg.approvals || {}
  const states = cfg.states || {}
  const hasFootprint = cfg.footprint !== false && (Object.keys(approvals).length > 0 || Object.keys(states).length > 0)
  return {
    program: { findUnique: async () => ({ category: 'DIPLOMA', admissionRules: null, semestersCount: 2 }) },
    enrollment: {
      findUnique: async () => ({ id: 'e1', userId: 'u1', programId: 'p1', createdAt: new Date('2026-01-01'), status: 'ACTIVE', finalScore: null, extensionDays: 0 }),
    },
    enrollmentRulesSnapshot: {
      findUnique: async () => cfg.snapshotBasis === null ? null : snapshotRow,
      create: async () => snapshotRow,
    },
    enrollmentSemesterState: {
      count: async () => (hasFootprint ? Math.max(1, Object.keys(states).length) : 0),
      findUnique: async (args: any) => {
        const s = args?.where?.enrollmentId_semester?.semester
        return states[s] ? { enrollmentId: 'e1', semester: s, status: states[s] } : null
      },
    },
    semesterResultApproval: {
      count: async () => Object.keys(approvals).length,
      findUnique: async (args: any) => {
        const s = args?.where?.enrollmentId_semester?.semester
        return s in approvals ? { enrollmentId: 'e1', semester: s, status: 'APPROVED', score: approvals[s] } : null
      },
    },
    exam: {
      findMany: async (args: any) => {
        const semester = args?.where?.unit?.semester
        return [1, 2]
          .filter((s) => semester === undefined || s === semester)
          .map((s) => ({ id: `ue${s}`, title: `وحدة ${s}`, passScore: 60, unit: { title: `وحدة ${s}` }, _count: { questions: 5 } }))
      },
    },
    examAttempt: {
      findMany: async (args: any) => {
        const s = Number(String(args?.where?.examId || '').replace('ue', ''))
        const score = cfg.unitScore?.[s]
        return score === undefined ? [] : [{ score, passed: score >= 60, answers: [] }]
      },
    },
    programExam: {
      findMany: async (args: any) => {
        const semester = args?.where?.semester
        return [1, 2]
          .filter((s) => semester === undefined || s === semester)
          .map((s) => ({
            id: `pe${s}`,
            title: `امتحان الفصل ${s}`,
            semester: s,
            passScore: cfg.examPassScore ?? 50,
            status: 'READY',
            createdAt: new Date('2026-01-01'),
            questions: [{ points: 10 }],
          }))
      },
    },
    programExamAttempt: {
      findMany: async (args: any) => {
        const s = Number(String(args?.where?.examId || '').replace('pe', ''))
        const score = cfg.examScore?.[s]
        if (score === undefined) return []
        const passed = cfg.examPassed?.[s] ?? score >= 50
        if (args?.where?.passed === true && !passed) return []
        if (args?.where?.status && args.where.status !== 'GRADED' && !(Array.isArray(args.where.status?.in))) return []
        return [{ id: `pa${s}`, score, finalScore: null, passed, appealStatus: null, answers: [{ points: score, maxPoints: 100 }] }]
      },
    },
    programAssignment: { findMany: async () => [] },
    assignmentSubmission: { findUnique: async () => null },
    thesisSubmission: { findFirst: async () => null },
    unit: { findMany: async () => [] },
  } as any
}

const ENROLLMENT = { id: 'e1', userId: 'u1', programId: 'p1' }
const PROGRAM = { category: 'DIPLOMA', semestersCount: 2 }

describe('progression gate', () => {
  test('no lifecycle footprint → grandfathered open', async () => {
    const gate = await progressionGate(fakeClient({ footprint: false }), ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(true)
  })

  test('new enrollment snapshot locks semester two before any semester state is created', async () => {
    const client = fakeClient({ footprint: false, snapshotBasis: 'ENROLLMENT' })
    const gate = await progressionGate(client, ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(false)
    expect(gate.reasons.join(' ')).toContain('غير معتمدة')

    const window = await submissionWindowCheck(client, {
      enrollment: { id: 'e1', userId: 'u1', programId: 'p1', createdAt: new Date(), extensionDays: 0 },
      program: { category: 'DIPLOMA', maxStudyDays: null, semestersCount: 2 },
      semester: 2,
    })
    expect(window.ok).toBe(false)
    if (!window.ok) expect(window.code).toBe('PROGRESSION_LOCKED')
  })

  test('legacy BACKFILL snapshot without lifecycle state preserves grandfathered access', async () => {
    const gate = await progressionGate(fakeClient({ footprint: false, snapshotBasis: 'BACKFILL' }), ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(true)
  })

  test('new enrollment snapshot without semester states also locks a required thesis', async () => {
    const client = fakeClient({
      footprint: false, snapshotBasis: 'ENROLLMENT',
      requiredComponents: ['final_exam', 'thesis'],
      weights: { quizzes: 10, assignments: 10, final_exam: 50, thesis: 30 },
    })
    const gate = await thesisGate(client, ENROLLMENT, PROGRAM)
    expect(gate.required).toBe(true)
    expect(gate.open).toBe(false)
    expect(gate.reasons.join(' ')).toContain('غير مكتمل')
  })

  test('database failure during lifecycle footprint lookup never grants S2 access', async () => {
    const client = fakeClient({ states: { 1: 'CLOSED' }, approvals: { 1: 80 }, examScore: { 1: 80 } })
    client.enrollmentSemesterState.count = async () => { throw new Error('database unavailable') }
    const gate = await progressionGate(client, ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(false)
    expect(gate.reasons.join(' ')).toContain('تعذر التحقق')

    const window = await submissionWindowCheck(client, {
      enrollment: { id: 'e1', userId: 'u1', programId: 'p1', createdAt: new Date(), extensionDays: 0 },
      program: { category: 'DIPLOMA', maxStudyDays: null, semestersCount: 2 },
      semester: 2,
    })
    expect(window.ok).toBe(false)
    if (!window.ok) expect(window.code).toBe('PROGRESSION_LOCKED')
  })

  test('approved S1 at exactly 50.0 permits S2 despite not passing; graduation threshold stays separate', async () => {
    const client = fakeClient({ states: { 1: 'CLOSED' }, approvals: { 1: 50 }, unitScore: { 1: 50 }, examScore: { 1: 50 } })
    const gate = await progressionGate(client, ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(true)
  })

  test('approved S1 at 50.1 with its exam passed opens S2', async () => {
    const client = fakeClient({ states: { 1: 'CLOSED' }, approvals: { 1: 50.1 }, unitScore: { 1: 50.1 }, examScore: { 1: 50.1 } })
    const gate = await progressionGate(client, ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(true)
  })

  test('approved S1 opens S2 when its exam was sat but failed', async () => {
    // The student sat the exam (80) but failed its 85 threshold; the
    // failure remains on record, and the approved semester can progress.
    const client = fakeClient({ states: { 1: 'CLOSED' }, approvals: { 1: 80 }, unitScore: { 1: 80 }, examScore: { 1: 80 }, examPassed: { 1: false }, examPassScore: 85 })
    const gate = await progressionGate(client, ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(true)
    expect(gate.reasons).toEqual([])
  })

  test('stale approval (grades changed after approval) stays locked', async () => {
    const client = fakeClient({ states: { 1: 'CLOSED' }, approvals: { 1: 80 }, unitScore: { 1: 70 }, examScore: { 1: 70 } })
    const gate = await progressionGate(client, ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(false)
  })

  test('computed-but-unapproved average never counts', async () => {
    const client = fakeClient({ states: { 1: 'OPEN' }, unitScore: { 1: 90 }, examScore: { 1: 90 } })
    const gate = await progressionGate(client, ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(false)
  })

  test('window check opens S2 for an approved failed S1 but blocks unapproved results', async () => {
    const approvedFailed = fakeClient({ states: { 1: 'CLOSED' }, approvals: { 1: 40 }, unitScore: { 1: 40 }, examScore: { 1: 40 } })
    const args = {
      enrollment: { id: 'e1', userId: 'u1', programId: 'p1', createdAt: new Date(), extensionDays: 0 },
      program: { category: 'DIPLOMA', maxStudyDays: null, semestersCount: 2 },
      semester: 2,
    }
    const allowed = await submissionWindowCheck(approvedFailed, args)
    expect(allowed.ok).toBe(true)

    const unapproved = fakeClient({ states: { 1: 'OPEN' }, unitScore: { 1: 90 }, examScore: { 1: 90 } })
    const blocked = await submissionWindowCheck(unapproved, args)
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.code).toBe('PROGRESSION_LOCKED')

    const legacy = fakeClient({ footprint: false })
    const legacyVerdict = await submissionWindowCheck(legacy, args)
    expect(legacyVerdict.ok).toBe(true)
  })

  test('exam requirement keys per category', () => {
    expect(semesterExamRequired('MASTERS', ['semester1_exam'], 1)).toBe(true)
    expect(semesterExamRequired('MASTERS', ['semester1_exam'], 2)).toBe(false)
    expect(semesterExamRequired('DOCTORATE', ['analysis_exam'], 2)).toBe(true)
    expect(semesterExamRequired('DIPLOMA', ['final_exam'], 2)).toBe(true)
    expect(semesterExamRequired('DIPLOMA', [], 1)).toBe(false)
  })
})

describe('thesis gate', () => {
  const thesisCfg = (over: Cfg): Cfg => ({
    weights: { quizzes: 10, assignments: 10, final_exam: 50, thesis: 30 },
    requiredComponents: ['final_exam', 'thesis'],
    ...over,
  })

  test('database outage cannot open a required thesis gate', async () => {
    const client = fakeClient(thesisCfg({ states: { 1: 'CLOSED', 2: 'CLOSED' }, approvals: { 1: 90, 2: 90 } }))
    client.enrollmentSemesterState.count = async () => { throw new Error('database unavailable') }
    const gate = await thesisGate(client, ENROLLMENT, PROGRAM)
    expect(gate.required).toBe(true)
    expect(gate.open).toBe(false)
    expect(gate.reasons.join(' ')).toContain('تعذر التحقق')
  })

  test('not required by the frozen rules → no gate', async () => {
    const gate = await thesisGate(fakeClient({ requiredComponents: ['final_exam'] }), ENROLLMENT, PROGRAM)
    expect(gate.required).toBe(false)
    expect(gate.open).toBe(true)
  })

  test('cumulative from approved semesters at exactly 50.0 stays closed', async () => {
    const client = fakeClient(thesisCfg({
      states: { 1: 'CLOSED', 2: 'CLOSED' },
      approvals: { 1: 50, 2: 50 },
      unitScore: { 1: 50, 2: 50 },
      examScore: { 1: 50, 2: 50 },
    }))
    const gate = await thesisGate(client, ENROLLMENT, PROGRAM)
    expect(gate.required).toBe(true)
    expect(gate.cumulative).toBe(50)
    expect(gate.open).toBe(false)
  })

  test('cumulative 50.1 from approved semesters opens, with S2 exams sat', async () => {
    const client = fakeClient(thesisCfg({
      states: { 1: 'CLOSED', 2: 'CLOSED' },
      approvals: { 1: 50.1, 2: 50.1 },
      unitScore: { 1: 50.1, 2: 50.1 },
      examScore: { 1: 50.1, 2: 50.1 },
    }))
    const gate = await thesisGate(client, ENROLLMENT, PROGRAM)
    expect(gate.cumulative).toBe(50.1)
    expect(gate.open).toBe(true)
  })

  test('an unapproved semester keeps the thesis closed regardless of computed grades', async () => {
    const client = fakeClient(thesisCfg({
      states: { 1: 'CLOSED', 2: 'CLOSED' },
      approvals: { 1: 90 },
      unitScore: { 1: 90, 2: 95 },
      examScore: { 1: 90, 2: 95 },
    }))
    const gate = await thesisGate(client, ENROLLMENT, PROGRAM)
    expect(gate.open).toBe(false)
  })

  test('S2 exams not sat keeps the thesis closed', async () => {
    const client = fakeClient(thesisCfg({
      states: { 1: 'CLOSED', 2: 'CLOSED' },
      approvals: { 1: 80, 2: 80 },
      unitScore: { 1: 80, 2: 80 },
      examScore: { 1: 80 },
    }))
    const gate = await thesisGate(client, ENROLLMENT, PROGRAM)
    expect(gate.open).toBe(false)
  })
})
