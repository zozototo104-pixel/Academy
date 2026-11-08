import { describe, expect, mock, test } from 'bun:test'

// ===== اشتقاق نضج الرفع على الخادم =====
// النضج لا يصل من أي مستدعٍ: يُشتق هنا من وقائع الامتحان والتصحيح —
// امتحان منشور، والطالب جلسه فعلًا، ولا عمل مقدَّم مفتوح (ماسح الموانع
// فارغ). اختبار وحدة أو واجب غير مقدَّم لا يمنع النضج: اختيار الطالب
// الصريح هو ما يقبل صفره الحسابي.

const facts = {
  blockers: [] as { code: string; count: number }[],
  satCount: 0,
  readyExams: 1,
  average: 63.25 as number | null,
  finalExamStatus: 'GRADED',
  finalExamScore: 75 as number | null,
  answerPoints: [5] as (number | null)[],
  appealStatus: 'NONE',
}

mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/notify', () => ({
  audit: async () => {},
  notify: async () => {},
  notifyAdmins: async () => {},
}))
mock.module('@/lib/semester-approval', () => ({
  collectSemesterApprovalBlockers: async () => facts.blockers,
}))
mock.module('@/lib/semester-grade', () => ({
  calculateSemesterAverages: async () => ({
    semesters: [{ semester: 1, average: facts.average, gradesComplete: false }],
  }),
}))
mock.module('@/lib/student-standing', () => ({
  getSemesterStanding: async () => ({
    programExams: {
      ready: facts.readyExams,
      satCount: facts.satCount,
      rows: facts.readyExams ? [{ examId: 'sem-exam-1', status: 'READY' }] : [],
    },
  }),
}))

const { computeSemesterRaiseMaturity, requestSemesterDecision, matureSemesterRaiseIfReady } = await import(
  '../../src/lib/semester-raise'
)
const { getSemesterDecision } = await import('../../src/lib/semester-decision')

const CREATED = new Date(Date.now() - 5 * 86400000) // قبل 5 أيام: نافذة الفصل الأول مفتوحة بالساعة الحقيقية

function makeClient() {
  const decisions = new Map<string, any>()
  const key = (enrollmentId: string, semester: number) => `${enrollmentId}:${semester}`
  const client: any = {
    enrollment: {
      findUnique: async () => ({
        id: 'enr-1',
        userId: 'user-1',
        programId: 'prog-1',
        createdAt: CREATED,
        extensionDays: 0,
        program: { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 },
      }),
    },
    unit: {
      findMany: async () => [
        { id: 'u1', semester: 1, order: 1 },
        { id: 'u2', semester: 2, order: 1 },
      ],
    },
    semesterDecision: {
      findUnique: async ({ where }: any) =>
        decisions.get(key(where.enrollmentId_semester.enrollmentId, where.enrollmentId_semester.semester)) ?? null,
      create: async ({ data }: any) => {
        const row = { id: `dec-${decisions.size + 1}`, ...data }
        decisions.set(key(data.enrollmentId, data.semester), row)
        return row
      },
      update: async ({ where, data }: any) => {
        const k = key(where.enrollmentId_semester.enrollmentId, where.enrollmentId_semester.semester)
        const row = { ...decisions.get(k), ...data }
        decisions.set(k, row)
        return row
      },
      updateMany: async ({ where, data }: any) => {
        const k = key(where.enrollmentId, where.semester)
        const existing = decisions.get(k)
        if (!existing || !(where.status?.in ?? []).includes(existing.status)) return { count: 0 }
        decisions.set(k, { ...existing, ...data })
        return { count: 1 }
      },
    },
    semesterResultApproval: { findUnique: async () => null },
    enrollmentSemesterState: { findUnique: async () => null },
  }
  return client
}

const ctx = {
  enrollmentId: 'enr-1',
  userId: 'user-1',
  programId: 'prog-1',
  semester: 1,
  enrollment: { createdAt: CREATED, status: 'ACTIVE', extensionDays: 0 },
  program: { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 },
}

function resetFacts(patch: Partial<typeof facts>) {
  facts.blockers = patch.blockers ?? []
  facts.satCount = patch.satCount ?? 0
  facts.readyExams = patch.readyExams ?? 1
  facts.average = patch.average === undefined ? 63.25 : patch.average
}

describe('computeSemesterRaiseMaturity — الاشتقاق الخادمي', () => {
  test('امتحان مجلوس + لا موانع + منشور = ناضج بلقطة المعدل الخادمية', async () => {
    resetFacts({ satCount: 1 })
    const m = await computeSemesterRaiseMaturity(makeClient(), ctx as any)
    expect(m.mature).toBe(true)
    expect(m.score).toBe(63.25)
    expect(m.examTaken).toBe(true)
  })
  test('امتحان لم يُجلس: لا نضج ولو فرغت الموانع (لا صفر مفترض أثناء الفترة)', async () => {
    resetFacts({ satCount: 0 })
    const m = await computeSemesterRaiseMaturity(makeClient(), ctx as any)
    expect(m.mature).toBe(false)
    expect(m.examTaken).toBe(false)
  })
  test('عمل مقدَّم قيد التصحيح يمنع النضج', async () => {
    resetFacts({ satCount: 1, blockers: [{ code: 'PROGRAM_EXAM_UNGRADED', count: 1 }] })
    const m = await computeSemesterRaiseMaturity(makeClient(), ctx as any)
    expect(m.mature).toBe(false)
    expect(m.blockers.length).toBe(1)
  })
  test('لا امتحان منشور أصلًا: لا نضج', async () => {
    resetFacts({ satCount: 0, readyExams: 0 })
    const m = await computeSemesterRaiseMaturity(makeClient(), ctx as any)
    expect(m.mature).toBe(false)
    expect(m.examPublished).toBe(false)
  })
})

describe('requestSemesterDecision / matureSemesterRaiseIfReady', () => {
  test('طلب إنهاء مبكر والامتحان غير مجلوس: يُحفظ نية ولا يرفع', async () => {
    resetFacts({ satCount: 0 })
    const client = makeClient()
    const r = await requestSemesterDecision(client, { ...ctx, intent: 'EARLY_FINISH' } as any)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.decision?.status).toBe('INTENT')
  })
  test('بعد جلوس الامتحان وفراغ الموانع: النية تنضج عبر مسار التصحيح', async () => {
    resetFacts({ satCount: 0 })
    const client = makeClient()
    await requestSemesterDecision(client, { ...ctx, intent: 'EARLY_FINISH' } as any)
    resetFacts({ satCount: 1 })
    const { decision } = await matureSemesterRaiseIfReady(client, ctx as any)
    expect(decision?.status).toBe('RAISED')
    expect(decision?.scoreAtRaise).toBe(63.25)
    const stored = await getSemesterDecision(client, 'enr-1', 1)
    expect(stored?.status).toBe('RAISED')
  })
  test('طلب مباشر والشروط مكتملة: يرفع فورًا', async () => {
    resetFacts({ satCount: 1 })
    const client = makeClient()
    const r = await requestSemesterDecision(client, { ...ctx, intent: 'EARLY_FINISH' } as any)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.decision?.status).toBe('RAISED')
      expect(r.decision?.raiseSource).toBe('STUDENT')
    }
  })
})

describe('getSemesterDecisionBrief — موجز العرض الوحيد', () => {
  test('بلا قرار: حق الإغلاق بانتظار الطالب والوقائع من الخادم', async () => {
    resetFacts({ satCount: 1 })
    const { getSemesterDecisionBrief } = await import('../../src/lib/semester-raise')
    const brief = await getSemesterDecisionBrief(makeClient(), { ...ctx, enrollmentId: 'enr-1' } as any)
    expect(brief.decision).toBeNull()
    expect(brief.closure.allowed).toBe(false)
    expect(brief.closure.reason).toBe('AWAITING_STUDENT')
    expect(brief.provisionalAverage).toBe(63.25)
    expect(brief.examTaken).toBe(true)
    expect(brief.periodEndAt).not.toBeNull()
    expect(brief.periodEnded).toBe(false)
  })
  test('درجة تغيّرت بعد الرفع تُعلَّم: changedSinceRaise', async () => {
    resetFacts({ satCount: 1, average: 63.25 })
    const client = makeClient()
    await client.semesterDecision.create({
      data: {
        enrollmentId: 'enr-1', semester: 1, intent: 'EARLY_FINISH', status: 'RAISED',
        raiseSource: 'STUDENT', raisedAt: new Date(), scoreAtIntent: 50, scoreAtRaise: 50,
      },
    })
    const { getSemesterDecisionBrief } = await import('../../src/lib/semester-raise')
    const brief = await getSemesterDecisionBrief(client, { ...ctx, enrollmentId: 'enr-1' } as any)
    expect(brief.scoreAtRaise).toBe(50)
    expect(brief.changedSinceRaise).toBe(true)
    expect(brief.closure.allowed).toBe(true)
    expect(brief.closure.source).toBe('STUDENT')
  })
  test('نفس النتيجة بعد الرفع: لا علم تغيير', async () => {
    resetFacts({ satCount: 1, average: 50 })
    const client = makeClient()
    await client.semesterDecision.create({
      data: {
        enrollmentId: 'enr-1', semester: 1, intent: 'EARLY_FINISH', status: 'RAISED',
        raiseSource: 'STUDENT', raisedAt: new Date(), scoreAtIntent: 50, scoreAtRaise: 50,
      },
    })
    const { getSemesterDecisionBrief } = await import('../../src/lib/semester-raise')
    const brief = await getSemesterDecisionBrief(client, { ...ctx, enrollmentId: 'enr-1' } as any)
    expect(brief.changedSinceRaise).toBe(false)
  })
})
