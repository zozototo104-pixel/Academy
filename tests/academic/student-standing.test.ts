import { describe, expect, test } from 'bun:test'

// Guard suite for the read-only semester standing brief (قرار المالك
// 2026-11-08، حالة الطالب عبيدة): قبل اعتماد نتيجة الفصل يجب أن يرى
// صانع القرار وقائع التقديم والمواعيد — ما قُدّم وما لم يُقدَّم
// بالأسماء، هل جلس الطالب لامتحان الفصل، هل انتهت نوافذ وحداته،
// وهل انتهت مدة تسجيله. Pins:
//  - a stalled/expired student: graded vs missing units BY NAME, the
//    semester exam UNSAT, lapsed unit windows, ended semester period,
//    ended enrollment deadline — all from the same fixtures;
//  - an active student who did everything: nothing missing, exam sat
//    with its real best score, nothing ended — the brief must not cry
//    wolf;
//  - semester isolation: semester 2's brief never pools semester 1
//    units or exams (the إشراق lesson);
//  - the layer is factual only: it reports attempts/windows and never
//    invents a grade.

const { getSemesterStanding } = await import('../../src/lib/student-standing')

const CREATED = new Date('2026-08-01T00:00:00Z')
const DAY = 86_400_000

const UNITS = [
  { id: 'u1', title: 'وحدة مقدّمة', semester: 1, order: 0, exam: { id: 'e1', status: 'READY', passScore: 60, questions: [{ id: 'q1' }, { id: 'q2' }] } },
  { id: 'u2', title: 'وحدة لم تُقدَّم', semester: 1, order: 1, exam: { id: 'e2', status: 'READY', passScore: 60, questions: [{ id: 'q1' }] } },
  { id: 'u3', title: 'وحدة الفصل الثاني', semester: 2, order: 0, exam: { id: 'e3', status: 'READY', passScore: 60, questions: [{ id: 'q1' }] } },
]
const PROGRAM_EXAMS = [
  { id: 'pe1', title: 'امتحان الفصل الأول', semester: 1, status: 'READY', passScore: 60 },
  { id: 'pe2', title: 'امتحان الفصل الثاني', semester: 2, status: 'READY', passScore: 60 },
]
const ASSIGNMENTS = [{ id: 'as1', title: 'واجب البحث', semester: 1, dueAt: null }]

function fakeClient(opts: {
  unitAttempts?: Record<string, any[]>
  programAttempts?: Record<string, any[]>
  submissions?: any[]
}) {
  const unitAttempts = opts.unitAttempts ?? { e1: [{ examId: 'e1', score: 80, passed: true, status: 'GRADED' }] }
  const programAttempts = opts.programAttempts ?? {}
  const submissions = opts.submissions ?? []
  return {
    unit: { findMany: async () => UNITS },
    examAttempt: {
      findMany: async ({ where }: any) => (where.examId.in as string[]).flatMap((id) => unitAttempts[id] ?? []),
    },
    programExam: {
      findMany: async ({ where }: any) => PROGRAM_EXAMS.filter((x) => x.semester === where.semester),
    },
    programExamAttempt: {
      findMany: async ({ where }: any) => (where.examId.in as string[]).flatMap((id) => programAttempts[id] ?? []),
    },
    programAssignment: {
      findMany: async ({ where }: any) => ASSIGNMENTS.filter((a) => a.semester === where.semester),
    },
    assignmentSubmission: {
      findMany: async ({ where }: any) => submissions.filter((s) => (where.assignmentId.in as string[]).includes(s.assignmentId)),
    },
  }
}

const PROGRAM = { category: 'DIPLOMA', maxStudyDays: null, semestersCount: 2 }

describe('student standing brief', () => {
  test('stalled expired student: missing units by name, exam unsat, windows and deadlines ended', async () => {
    const standing = await getSemesterStanding(fakeClient({}), {
      userId: 'u-stalled',
      programId: 'p1',
      enrollment: { createdAt: CREATED, status: 'EXPIRED', extensionDays: 0 },
      program: PROGRAM,
      semester: 1,
      now: new Date('2026-11-08T00:00:00Z'),
    })

    expect(standing.enrollment.status).toBe('EXPIRED')
    expect(standing.enrollment.periodEnded).toBe(true)
    expect(standing.enrollment.deadlineAt).not.toBeNull()
    expect(Math.abs((new Date(standing.enrollment.deadlineAt!).getTime() - CREATED.getTime()) / DAY - 90)).toBeLessThanOrEqual(1)
    expect(standing.enrollment.daysLeft!).toBeLessThan(0)

    expect(standing.units.total).toBe(2)
    expect(standing.units.scorable).toBe(2)
    expect(standing.units.graded).toBe(1)
    expect(standing.units.missingTitles).toEqual(['وحدة لم تُقدَّم'])
    const [done, missing] = standing.units.rows
    expect(done.state).toBe('GRADED')
    expect(done.bestScore).toBe(80)
    expect(done.passed).toBe(true)
    expect(missing.state).toBe('NOT_STARTED')
    expect(done.windowEnded).toBe(true)
    expect(missing.windowEnded).toBe(true)

    expect(standing.semesterPeriod.ended).toBe(true)
    expect(Math.abs((new Date(standing.semesterPeriod.endAt!).getTime() - CREATED.getTime()) / DAY - 45)).toBeLessThanOrEqual(1)

    expect(standing.programExams.ready).toBe(1)
    expect(standing.programExams.satCount).toBe(0)
    expect(standing.programExams.rows[0].sat).toBe(false)
    expect(standing.programExams.rows[0].bestScore).toBeNull()

    expect(standing.assignments.total).toBe(1)
    expect(standing.assignments.submitted).toBe(0)
    expect(standing.assignments.missingTitles).toEqual(['واجب البحث'])
  })

  test('active student who submitted everything: nothing missing, exam sat, nothing ended', async () => {
    const standing = await getSemesterStanding(fakeClient({
      unitAttempts: {
        e1: [{ examId: 'e1', score: 80, passed: true, status: 'GRADED' }],
        e2: [{ examId: 'e2', score: 70, passed: true, status: 'GRADED' }],
      },
      programAttempts: {
        pe1: [{ examId: 'pe1', score: 75, finalScore: 75, passed: true, status: 'GRADED', submittedAt: new Date('2026-08-15T00:00:00Z') }],
      },
      submissions: [{ assignmentId: 'as1', status: 'GRADED', score: 95 }],
    }), {
      userId: 'u-active',
      programId: 'p1',
      enrollment: { createdAt: CREATED, status: 'ACTIVE', extensionDays: 0 },
      program: PROGRAM,
      semester: 1,
      now: new Date('2026-08-20T00:00:00Z'),
    })

    expect(standing.enrollment.periodEnded).toBe(false)
    expect(standing.units.graded).toBe(2)
    expect(standing.units.missingTitles).toEqual([])
    expect(standing.units.rows.every((r) => r.windowEnded === false)).toBe(true)
    expect(standing.semesterPeriod.ended).toBe(false)
    expect(standing.programExams.satCount).toBe(1)
    expect(standing.programExams.rows[0].sat).toBe(true)
    expect(standing.programExams.rows[0].bestScore).toBe(75)
    expect(standing.programExams.rows[0].passed).toBe(true)
    expect(standing.assignments.submitted).toBe(1)
    expect(standing.assignments.missingTitles).toEqual([])
  })

  test('semester isolation: the semester-2 brief never pools semester-1 work', async () => {
    const standing = await getSemesterStanding(fakeClient({}), {
      userId: 'u-stalled',
      programId: 'p1',
      enrollment: { createdAt: CREATED, status: 'EXPIRED', extensionDays: 0 },
      program: PROGRAM,
      semester: 2,
      now: new Date('2026-11-08T00:00:00Z'),
    })

    expect(standing.units.total).toBe(1)
    expect(standing.units.rows[0].unitId).toBe('u3')
    expect(standing.units.missingTitles).toEqual(['وحدة الفصل الثاني'])
    expect(standing.programExams.rows.map((r) => r.examId)).toEqual(['pe2'])
    expect(standing.assignments.total).toBe(0)
  })
})
