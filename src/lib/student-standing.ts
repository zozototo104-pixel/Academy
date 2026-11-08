// كشف وضع الطالب في فصل واحد — طبقة قراءة فقط (قرار المالك 2026-11-08،
// حالة الطالب عبيدة وأمثاله): شاشة اعتماد نتيجة الفصل كانت تعرض المعدلات
// وموانع الدرجات فقط، فلا يرى صانع القرار ما قدّمه الطالب فعلًا: أيّ وحدات
// قدّمها وأيّها لم يقدّمها، هل جلس لامتحان الفصل، هل انتهت نوافذ وحداته،
// وهل انتهت مدة تسجيله أصلًا — مع أن كل هذه الوقائع محفوظة أصلًا في
// المحاولات والواجبات ونوافذ المدة. هذه الدالة تجمعها من مصادرها نفسها
// (نوافذ الوحدات ومهلة التسجيل من program-duration حرفيًا، وهي نفسها
// التي تُنهي التسجيلات المنتهية في التذكيرات اليومية) ولا تكتب شيئًا
// ولا تحسب درجة: المعدلات تبقى من محرك درجات الفصل، وهذا الكشف وقائع
// تقديم ومواعيد فقط.

import { daysLeftUntil, getEnrollmentDeadline, getSemesterUnitWindows } from './program-duration'

export type StandingUnitState = 'GRADED' | 'IN_PROGRESS' | 'NOT_STARTED'

export interface StandingUnitRow {
  unitId: string
  title: string
  order: number
  hasScorableExam: boolean
  state: StandingUnitState
  bestScore: number | null
  passed: boolean | null
  windowEndAt: string | null
  windowEnded: boolean | null
}

export interface StandingProgramExamRow {
  examId: string
  title: string
  status: string
  sat: boolean
  attemptsCount: number
  bestScore: number | null
  passed: boolean
}

export interface StandingAssignmentRow {
  assignmentId: string
  title: string
  submitted: boolean
  status: string | null
  score: number | null
  dueAt: string | null
}

export interface SemesterStanding {
  semester: number
  enrollment: {
    status: string
    deadlineAt: string | null
    daysLeft: number | null
    periodEnded: boolean
  }
  units: {
    total: number
    scorable: number
    graded: number
    missingTitles: string[]
    rows: StandingUnitRow[]
  }
  assignments: {
    total: number
    submitted: number
    missingTitles: string[]
    rows: StandingAssignmentRow[]
  }
  programExams: {
    ready: number
    satCount: number
    rows: StandingProgramExamRow[]
  }
  semesterPeriod: {
    endAt: string | null
    ended: boolean | null
  }
}

const SAT_PROGRAM_ATTEMPT_STATUSES = new Set(['SUBMITTED', 'NEEDS_REVIEW', 'GRADED', 'EXPIRED'])

export async function getSemesterStanding(
  client: any,
  args: {
    userId: string
    programId: string
    enrollment: { createdAt: Date | string; status: string; extensionDays?: number | null }
    program: { category?: string | null; maxStudyDays?: number | null; semestersCount?: number | null }
    semester: number
    now?: Date
  },
): Promise<SemesterStanding> {
  const now = args.now ?? new Date()
  const createdAt = new Date(args.enrollment.createdAt)
  const extensionDays = Math.max(0, args.enrollment.extensionDays || 0)

  const allUnits: {
    id: string
    title: string
    semester: number
    order: number
    exam: { id: string; status: string; passScore: number; questions: { id: string }[] } | null
  }[] = await client.unit.findMany({
    where: { programId: args.programId },
    orderBy: [{ semester: 'asc' }, { order: 'asc' }],
    select: {
      id: true,
      title: true,
      semester: true,
      order: true,
      exam: { select: { id: true, status: true, passScore: true, questions: { select: { id: true } } } },
    },
  })

  const semesterUnits = allUnits.filter((u) => u.semester === args.semester)
  const semesterExamIds = semesterUnits.map((u) => u.exam?.id).filter((x): x is string => Boolean(x))

  const windows = getSemesterUnitWindows(
    createdAt,
    args.program,
    allUnits.map((u) => ({ id: u.id, semester: u.semester, order: u.order })),
    extensionDays,
  )
  const windowByUnit = new Map(windows.map((w) => [w.unitId, w]))

  const [unitAttempts, programExams, assignments]: [any[], any[], any[]] = await Promise.all([
    semesterExamIds.length
      ? client.examAttempt.findMany({
          where: { userId: args.userId, examId: { in: semesterExamIds } },
          select: { examId: true, score: true, passed: true, status: true },
        })
      : Promise.resolve([] as any[]),
    client.programExam.findMany({
      where: { programId: args.programId, semester: args.semester },
      orderBy: [{ createdAt: 'asc' }],
      select: { id: true, title: true, status: true, passScore: true },
    }),
    client.programAssignment.findMany({
      where: { programId: args.programId, semester: args.semester, status: 'PUBLISHED' },
      orderBy: [{ createdAt: 'asc' }],
      select: { id: true, title: true, dueAt: true },
    }),
  ])

  const programExamIds = programExams.map((x: any) => x.id)
  const assignmentIds = assignments.map((a: any) => a.id)
  const [programAttempts, submissions]: [any[], any[]] = await Promise.all([
    programExamIds.length
      ? client.programExamAttempt.findMany({
          where: { userId: args.userId, examId: { in: programExamIds } },
          select: { examId: true, score: true, finalScore: true, passed: true, status: true, submittedAt: true },
        })
      : Promise.resolve([] as any[]),
    assignmentIds.length
      ? client.assignmentSubmission.findMany({
          where: { userId: args.userId, assignmentId: { in: assignmentIds } },
          select: { assignmentId: true, status: true, score: true },
        })
      : Promise.resolve([] as any[]),
  ])

  const unitRows: StandingUnitRow[] = semesterUnits.map((u) => {
    const exam = u.exam
    const hasScorableExam = Boolean(exam && exam.status === 'READY' && (exam.questions?.length || 0) > 0)
    const attempts = exam ? unitAttempts.filter((a: any) => a.examId === exam.id) : []
    const graded = attempts.filter((a: any) => a.status === 'GRADED')
    const bestScore = graded.reduce<number | null>(
      (best: number | null, a: any) => (typeof a.score === 'number' ? (best == null ? a.score : Math.max(best, a.score)) : best),
      null,
    )
    const passed = exam
      ? graded.some((a: any) => a.passed === true) || (bestScore != null && bestScore >= exam.passScore)
      : null
    const state: StandingUnitState = graded.length > 0 ? 'GRADED' : attempts.length > 0 ? 'IN_PROGRESS' : 'NOT_STARTED'
    const win = windowByUnit.get(u.id)
    return {
      unitId: u.id,
      title: u.title,
      order: u.order,
      hasScorableExam,
      state,
      bestScore,
      passed: exam ? passed : null,
      windowEndAt: win ? win.endAt.toISOString() : null,
      windowEnded: win ? now.getTime() >= win.endAt.getTime() : null,
    }
  })

  const programExamRows: StandingProgramExamRow[] = programExams.map((x: any) => {
    const atts = programAttempts.filter((a: any) => a.examId === x.id)
    const satAttempts = atts.filter((a: any) => SAT_PROGRAM_ATTEMPT_STATUSES.has(a.status) || a.submittedAt != null)
    const bestScore = atts.reduce<number | null>((best: number | null, a: any) => {
      const v = typeof (a.finalScore ?? a.score) === 'number' ? Number(a.finalScore ?? a.score) : null
      return v == null ? best : best == null ? v : Math.max(best, v)
    }, null)
    return {
      examId: x.id,
      title: x.title,
      status: x.status,
      sat: satAttempts.length > 0,
      attemptsCount: atts.length,
      bestScore,
      passed: atts.some((a: any) => a.passed === true),
    }
  })

  const submissionByAssignment = new Map<string, any>(submissions.map((s: any) => [s.assignmentId, s]))
  const assignmentRows: StandingAssignmentRow[] = assignments.map((a: any) => {
    const sub = submissionByAssignment.get(a.id)
    return {
      assignmentId: a.id,
      title: a.title,
      submitted: Boolean(sub),
      status: sub?.status ?? null,
      score: typeof sub?.score === 'number' ? sub.score : null,
      dueAt: a.dueAt ? new Date(a.dueAt).toISOString() : null,
    }
  })

  const semesterWindowEnds = semesterUnits
    .map((u) => windowByUnit.get(u.id)?.endAt)
    .filter((d): d is Date => d instanceof Date)
  const semesterEnd = semesterWindowEnds.length ? new Date(Math.max(...semesterWindowEnds.map((d) => d.getTime()))) : null

  const deadline = getEnrollmentDeadline(createdAt, args.program, extensionDays)

  return {
    semester: args.semester,
    enrollment: {
      status: args.enrollment.status,
      deadlineAt: deadline ? deadline.toISOString() : null,
      daysLeft: deadline ? daysLeftUntil(deadline, now) : null,
      periodEnded: args.enrollment.status === 'EXPIRED' || (deadline != null && now.getTime() >= deadline.getTime()),
    },
    units: {
      total: semesterUnits.length,
      scorable: unitRows.filter((r) => r.hasScorableExam).length,
      graded: unitRows.filter((r) => r.hasScorableExam && r.state === 'GRADED').length,
      missingTitles: unitRows.filter((r) => r.hasScorableExam && r.state !== 'GRADED').map((r) => r.title),
      rows: unitRows,
    },
    assignments: {
      total: assignmentRows.length,
      submitted: assignmentRows.filter((r) => r.submitted).length,
      missingTitles: assignmentRows.filter((r) => !r.submitted).map((r) => r.title),
      rows: assignmentRows,
    },
    programExams: {
      ready: programExamRows.filter((r) => r.status === 'READY').length,
      satCount: programExamRows.filter((r) => r.sat).length,
      rows: programExamRows,
    },
    semesterPeriod: {
      endAt: semesterEnd ? semesterEnd.toISOString() : null,
      ended: semesterEnd ? now.getTime() >= semesterEnd.getTime() : null,
    },
  }
}
