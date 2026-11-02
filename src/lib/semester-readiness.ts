import { db } from '@/lib/db'

/**
 * Semester two is locked until the programme's designated first-semester
 * exams are all published (READY) and passed. The designated set is: every
 * READY exam, plus the programme's current exam (the latest one) while it
 * is still being prepared — a required exam that has not been published yet
 * must keep the lock. Older superseded drafts/failures that are neither
 * READY nor the current exam are NOT designated: an abandoned leftover must
 * never block every student in the programme forever. With no first-semester
 * exam at all, the semester stays locked (nothing designated to pass yet).
 */
export async function hasPassedFirstSemesterExam(userId: string, programId: string): Promise<boolean> {
  const exams = await db.programExam.findMany({
    where: { programId, semester: 1 },
    select: {
      id: true,
      status: true,
      createdAt: true,
      questions: { where: { status: 'PUBLISHED' }, select: { points: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (exams.length === 0) return false
  const current = exams[0]
  const designated = exams.filter((exam) => exam.status === 'READY' || exam.id === current.id)
  for (const exam of designated) {
    if (exam.status !== 'READY' || !exam.questions.some((q) => q.points > 0)) return false
    const passed = await db.programExamAttempt.findFirst({
      where: {
        userId,
        examId: exam.id,
        status: 'GRADED',
        passed: true,
        OR: [{ appealStatus: null }, { appealStatus: { not: 'PENDING' } }],
      },
      select: { id: true },
    })
    if (!passed) return false
  }
  return true
}

function parseJsonArray(value: string | null | undefined): any[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function passedScore(score: number | null | undefined, max: number | null | undefined, passPercent = 60) {
  if (score == null) return false
  const maxPoints = Number(max || 0)
  if (maxPoints <= 0) return score >= passPercent
  return (score / maxPoints) * 100 >= passPercent
}

export async function calculateSemesterReadiness(userId: string, programId: string, semester: number) {
  const enrollment = await db.enrollment.findUnique({ where: { userId_programId: { userId, programId } } })
  const readySemesters = parseJsonArray(enrollment?.examReadiness).map((x) => Number(x)).filter(Boolean)

  const [units, assignments] = await Promise.all([
    db.unit.findMany({
      where: { programId, semester },
      include: { exam: { select: { id: true, title: true, passScore: true } } },
      orderBy: { order: 'asc' },
    }),
    db.programAssignment.findMany({
      where: { programId, semester, status: 'PUBLISHED' },
      select: {
        id: true,
        title: true,
        points: true,
        weight: true,
        submissions: { where: { userId }, select: { score: true, status: true }, orderBy: { submittedAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const unitExamIds = units.map((u) => u.exam?.id).filter(Boolean) as string[]
  const unitAttempts = unitExamIds.length
    ? await db.examAttempt.findMany({ where: { userId, examId: { in: unitExamIds }, score: { not: null } }, orderBy: { score: 'desc' } })
    : []

  const passedUnitExamIds = new Set<string>()
  for (const attempt of unitAttempts) {
    if (attempt.examId && attempt.passed) passedUnitExamIds.add(attempt.examId)
  }

  const missingUnitExams = units
    .filter((u) => u.exam?.id && !passedUnitExamIds.has(u.exam.id))
    .map((u) => ({ id: u.exam!.id, title: u.exam!.title || u.title }))

  const assignmentItems = assignments.map((a) => {
    const sub = a.submissions[0]
    const ok = !!sub && sub.status === 'GRADED' && passedScore(sub.score, a.points, 60)
    return {
      id: a.id,
      title: a.title,
      points: a.points,
      weight: Number(a.weight || 0),
      passed: ok,
      score: sub?.score ?? null,
      status: sub?.status || null,
    }
  })
  const missingAssignments = assignmentItems.filter((a) => !a.passed)
  const assignmentWeight = assignmentItems.reduce((sum, a) => sum + Number(a.weight || 0), 0)
  const missingAssignmentWeight = missingAssignments.reduce((sum, a) => sum + Number(a.weight || 0), 0)
  // Retained response field for older clients. Missing assignments no longer cap the exam mark:
  // their earned contribution is computed separately by calculateFinalGrade.
  const maxExamScore = 100
  const complete = missingUnitExams.length === 0 && missingAssignments.length === 0

  return {
    semester,
    readyMarked: readySemesters.includes(semester),
    complete,
    maxExamScore,
    assignmentWeight,
    missingAssignmentWeight,
    unitsCount: units.length,
    unitExamsCount: unitExamIds.length,
    passedUnitExamsCount: unitExamIds.length - missingUnitExams.length,
    assignmentsCount: assignmentItems.length,
    passedAssignmentsCount: assignmentItems.length - missingAssignments.length,
    missingUnitExams,
    missingAssignments,
    assignments: assignmentItems,
  }
}

export async function markSemesterReady(userId: string, programId: string, semester: number) {
  if (semester === 2 && !(await hasPassedFirstSemesterExam(userId, programId))) {
    throw new Error('SEM1_REQUIRED')
  }
  const enrollment = await db.enrollment.findUnique({ where: { userId_programId: { userId, programId } } })
  if (!enrollment) throw new Error('ENROLLMENT_NOT_FOUND')
  const ready = new Set(parseJsonArray(enrollment.examReadiness).map((x) => Number(x)).filter(Boolean))
  ready.add(semester)
  await db.enrollment.update({
    where: { id: enrollment.id },
    data: { examReadiness: JSON.stringify(Array.from(ready).sort((a, b) => a - b)) },
  })
  return calculateSemesterReadiness(userId, programId, semester)
}
