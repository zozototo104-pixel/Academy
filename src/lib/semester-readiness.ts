import { db } from '@/lib/db'

/**
 * FREEZE EXCEPTION — APPROVED BY THE OWNER 2026-11-05 (documented in
 * docs/semester-readiness-freeze-exception.md): this file was frozen
 * verbatim by the academic-lifecycle plan, and the 2026-11-04 hardening
 * below was ratified as an exception rather than reverted. Scope of the
 * exception: an attempt counts toward readiness ONLY when it is fully
 * settled — status GRADED, every answer scored, no PENDING appeal — so a
 * provisional or partially graded result can never unlock progression
 * before it is final. Storage-shape parity with the grade engine is part
 * of the ratification: a GRADED attempt whose score is derivable (stored
 * score, or finalScore, or a percentage computed from its fully-scored
 * answers — the legacy shape the engine itself accepts) counts exactly
 * like a stored-score attempt, so no deserving student is blocked by how
 * their grade happens to be stored.
 */

function percentFromStoredAnswers(answers: { points: number | null; maxPoints: number | null }[] | undefined): number | null {
  if (!answers?.length) return null
  const max = answers.reduce((sum, a) => sum + Math.max(0, Number(a.maxPoints || 0)), 0)
  if (max <= 0) return null
  const points = answers.reduce((sum, a) => sum + Math.max(0, Number(a.points || 0)), 0)
  return (points / max) * 100
}

/** A settled attempt has a usable score: stored, final, or derivable from
 * its fully-scored answers (the same fallback the grade engine applies). */
function hasUsableScore(attempt: {
  score?: number | null
  finalScore?: number | null
  answers?: { points: number | null; maxPoints: number | null }[]
}): boolean {
  if (typeof attempt.score === 'number' && Number.isFinite(attempt.score)) return true
  if (typeof attempt.finalScore === 'number' && Number.isFinite(attempt.finalScore)) return true
  return percentFromStoredAnswers(attempt.answers) !== null
}

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
    const candidates = await db.programExamAttempt.findMany({
      where: {
        userId,
        examId: exam.id,
        status: 'GRADED',
        passed: true,
        answers: { none: { points: null } },
        OR: [{ appealStatus: null }, { appealStatus: { not: 'PENDING' } }],
      },
      select: { id: true, score: true, finalScore: true, answers: { select: { points: true, maxPoints: true } } },
      take: 25,
    })
    if (!candidates.some((attempt) => hasUsableScore(attempt))) return false
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
    ? await db.examAttempt.findMany({
        where: { userId, examId: { in: unitExamIds }, status: 'GRADED', answers: { none: { points: null } }, OR: [{ appealStatus: null }, { appealStatus: { not: 'PENDING' } }] },
        select: { examId: true, score: true, passed: true, answers: { select: { points: true, maxPoints: true } } },
      })
    : []

  const passedUnitExamIds = new Set<string>()
  for (const attempt of unitAttempts) {
    if (attempt.examId && attempt.passed && hasUsableScore(attempt)) passedUnitExamIds.add(attempt.examId)
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
  const program = await db.program.findUnique({ where: { id: programId }, select: { semestersCount: true } })
  if (!Number.isInteger(semester) || semester < 1 || (program?.semestersCount != null && semester > program.semestersCount)) {
    throw new Error('INVALID_SEMESTER')
  }
  const ready = new Set(parseJsonArray(enrollment.examReadiness).map((x) => Number(x)).filter(Boolean))
  ready.add(semester)
  await db.enrollment.update({
    where: { id: enrollment.id },
    data: { examReadiness: JSON.stringify(Array.from(ready).sort((a, b) => a - b)) },
  })
  return calculateSemesterReadiness(userId, programId, semester)
}
