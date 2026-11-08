// قرار المالك 2026-11-08: الاسترحام لتحسين معدل رسوب فصل
// بعد تقديم امتحانه فعليًا، ولا يمكنه بأي حال تعويض عدم التقديم.
// اعتماد فصل راسب يسمح بالانتقال بعد الجلوس الحقيقي للامتحان، سواء
// عالج الاسترحام الرسوب أو بقي المعدل تحت حد النجاح.
// أرقام العالم: وحدات 100 بلا امتحان فصل = معدل 25 (المحرك يعيد
// توزيع أوزان المكونات الحاضرة: (100×20 + 0×60)/80)؛ استرحام
// بوزن 50 ودرجة 100 يدمجه إلى 62.5، وبدرجة 30 إلى 27.5.
// التشغيل: bun test tests/academic/mercy-progression.test.ts (منفردًا)
import { describe, expect, mock, test } from 'bun:test'

mock.module('@/lib/db', () => ({ db: {} }))

const { progressionGate, thesisGate } = await import('@/lib/progression')

type MercyRow = { semester: number; status: string; score?: number; weightPercent?: number }
type Cfg = {
  approvals?: Record<number, number | null>
  states?: Record<number, string>
  unitScore?: Record<number, number>
  examScore?: Record<number, number>
  mercy?: MercyRow[]
  requiredComponents?: string[]
}

function fakeClient(cfg: Cfg) {
  const snapshotRow = {
    id: 'snap1', enrollmentId: 'e1',
    weightsJson: JSON.stringify({ quizzes: 20, assignments: 20, final_exam: 60 }),
    weightSource: 'category_default', weightWarning: null,
    passThreshold: 50, thresholdStrict: true,
    requirementsJson: JSON.stringify({ semestersCount: 2, requiredComponents: cfg.requiredComponents || ['final_exam'] }),
    basis: 'ENROLLMENT', capturedAt: new Date('2026-01-01'),
  }
  const approvals = cfg.approvals || {}
  const states = cfg.states || {}
  return {
    program: { findUnique: async () => ({ category: 'DIPLOMA', admissionRules: null, semestersCount: 2 }) },
    enrollment: { findUnique: async () => ({ id: 'e1', userId: 'u1', programId: 'p1', createdAt: new Date('2026-01-01'), status: 'ACTIVE', finalScore: null, extensionDays: 0 }) },
    enrollmentRulesSnapshot: { findUnique: async () => snapshotRow },
    enrollmentSemesterState: {
      count: async () => Object.keys(states).length,
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
        return [1, 2].filter((s) => semester === undefined || s === semester)
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
        return [1, 2].filter((s) => semester === undefined || s === semester)
          .map((s) => ({ id: `pe${s}`, title: `امتحان الفصل ${s}`, semester: s, passScore: 50, status: 'READY', createdAt: new Date('2026-01-01'), questions: [{ points: 10 }] }))
      },
    },
    programExamAttempt: {
      findMany: async (args: any) => {
        const s = Number(String(args?.where?.examId || '').replace('pe', ''))
        const score = cfg.examScore?.[s]
        if (score === undefined) return []
        const passed = score >= 50
        if (args?.where?.passed === true && !passed) return []
        if (args?.where?.status && args.where.status !== 'GRADED' && !(Array.isArray(args.where.status?.in))) return []
        return [{ id: `pa${s}`, score, finalScore: null, passed, appealStatus: null, answers: [{ points: score, maxPoints: 100 }] }]
      },
    },
    mercyRequest: {
      findFirst: async (args: any) => {
        const s = args?.where?.semester
        const st = args?.where?.status
        const row = (cfg.mercy || []).find((m) => m.semester === s
          && (st === undefined || (typeof st === 'string' ? m.status === st : Array.isArray(st?.in) && st.in.includes(m.status))))
        return row ? { id: 'm1', enrollmentId: 'e1', semester: s, status: row.status, score: row.score ?? null, weightPercent: row.weightPercent ?? null } : null
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
// الفصل الأول بلا جلوس للامتحان: وحدات كاملة (100) والمعدل المحسوب 25.
const NEVER_SAT_S1 = { unitScore: { 1: 100 }, states: { 1: 'CLOSED' } }

describe('بوابة الانتقال والاسترحام المكتمل', () => {
  test('لم يجلس + نتيجة معتمدة (25) + لا استرحام → محبوس بشرط التقديم', async () => {
    const gate = await progressionGate(fakeClient({ ...NEVER_SAT_S1, approvals: { 1: 25 } }), ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(false)
    expect(gate.reasons.join(' ')).toContain('لم يُقدَّم')
  })

  test('لم يجلس للامتحان + استرحام مكتمل ومعدل ناجح → الانتقال ممنوع', async () => {
    const gate = await progressionGate(fakeClient({
      ...NEVER_SAT_S1, approvals: { 1: 62.5 },
      mercy: [{ semester: 1, status: 'COMPLETED', score: 100, weightPercent: 50 }],
    }), ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(false)
    expect(gate.reasons.join(' ')).toContain('لم يُقدَّم')
  })

  test('لم يجلس للامتحان + استرحام مكتمل ومعدل راسب → الانتقال ممنوع', async () => {
    const gate = await progressionGate(fakeClient({
      ...NEVER_SAT_S1, approvals: { 1: 27.5 },
      mercy: [{ semester: 1, status: 'COMPLETED', score: 30, weightPercent: 50 }],
    }), ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(false)
    expect(gate.reasons.join(' ')).toContain('لم يُقدَّم')
  })

  test('استرحام مدرَّج فقط (GRADED) والاعتماد لم يُجدَّد → تبقى البوابة مغلقة', async () => {
    const gate = await progressionGate(fakeClient({
      ...NEVER_SAT_S1, approvals: { 1: 25 },
      mercy: [{ semester: 1, status: 'GRADED', score: 100, weightPercent: 50 }],
    }), ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(false)
  })

  test('استرحام مكتمل لفصل آخر لا يغطّي هذا الفصل', async () => {
    const gate = await progressionGate(fakeClient({
      ...NEVER_SAT_S1, approvals: { 1: 25 },
      mercy: [{ semester: 2, status: 'COMPLETED', score: 100, weightPercent: 50 }],
    }), ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(false)
    expect(gate.reasons.join(' ')).toContain('لم يُقدَّم')
  })

  test('جلس للامتحان (30) + نتيجة معتمدة (47.5) + لا استرحام → ينتقل (القانون الجديد بلا مساس)', async () => {
    const gate = await progressionGate(fakeClient({
      unitScore: { 1: 100 }, examScore: { 1: 30 }, states: { 1: 'CLOSED' }, approvals: { 1: 47.5 },
    }), ENROLLMENT, 2, 'DIPLOMA')
    expect(gate.open).toBe(true)
  })

  test('بوابة الرسالة: آخر فصل لم يُجلس له + استرحام مكتمل له → تُفتح', async () => {
    const gate = await thesisGate(fakeClient({
      unitScore: { 1: 40, 2: 48 }, examScore: { 1: 40 },
      states: { 1: 'CLOSED', 2: 'CLOSED' }, approvals: { 1: 40, 2: 56 },
      mercy: [{ semester: 2, status: 'COMPLETED', score: 100, weightPercent: 50 }],
      requiredComponents: ['final_exam', 'thesis'],
    }), ENROLLMENT, PROGRAM)
    expect(gate.open).toBe(true)
  })

  test('بوابة الرسالة: آخر فصل لم يُجلس له وبلا استرحام → تبقى مغلقة', async () => {
    const gate = await thesisGate(fakeClient({
      unitScore: { 1: 40, 2: 48 }, examScore: { 1: 40 },
      states: { 1: 'CLOSED', 2: 'CLOSED' }, approvals: { 1: 40, 2: 12 },
      requiredComponents: ['final_exam', 'thesis'],
    }), ENROLLMENT, PROGRAM)
    expect(gate.open).toBe(false)
    expect(gate.reasons.join(' ')).toContain('لم تُقدَّم')
  })
})
