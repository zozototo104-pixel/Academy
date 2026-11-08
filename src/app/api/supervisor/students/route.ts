import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { calculateFinalGrade } from '@/lib/final-grade'
import { getStudentSemesterTracking } from '@/lib/student-tracking'
import { getEnrollmentDeadline, daysLeftUntil } from '@/lib/program-duration'

function pct(n: number, d: number) {
  return d > 0 ? Math.round((n / d) * 100) : 0
}

function statusLabel(status: string) {
  const map: Record<string, string> = {
    AWAITING_FEE: 'بانتظار رسوم التقديم',
    UNDER_REVIEW: 'قيد دراسة القبول',
    AWAITING_TUITION: 'مقبول — بانتظار الرسوم الدراسية',
    THESIS: 'قيد الدراسة/بحث التخرج',
    SCHEDULED: 'مجدول للمناقشة',
    RESULT_APPROVED: 'نتيجة معتمدة',
    CERTIFIED: 'شهادة صادرة',
    REJECTED: 'مرفوض',
  }
  return map[status] || status
}

async function buildStudentCard(app: any) {
  const userId = app.userId
  const programId = app.programId
  const [program, attempts, unitAttempts, assignments, privateAssessments, messages] = await Promise.all([
    programId ? db.program.findUnique({
      where: { id: programId },
      include: {
        books: { select: { id: true, title: true, semester: true, linkReadStatus: true, source: true } },
        knowledgeItems: { select: { id: true, category: true, title: true, importance: true }, orderBy: { importance: 'desc' }, take: 12 },
        programExams: { orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }], select: { id: true, title: true, semester: true, status: true, passScore: true, durationMin: true, totalPoints: true, _count: { select: { questions: true } } } },
        units: { orderBy: { order: 'asc' }, select: { id: true, title: true, order: true, exam: { select: { id: true, title: true, passScore: true, _count: { select: { questions: true } } } } } },
        assignments: { where: { status: 'PUBLISHED' }, orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }], select: { id: true, title: true, semester: true, type: true, points: true, weight: true, dueDays: true, dueAt: true, status: true } },
      },
    }) : null,
    userId ? db.programExamAttempt.findMany({
      where: { userId, ...(programId ? { exam: { programId } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        exam: { select: { id: true, title: true, semester: true, passScore: true, programId: true } },
        answers: { include: { question: { select: { text: true, modelAnswer: true, correctAnswer: true, cognitiveSkill: true, sourceBookTitle: true, points: true } } } },
      },
    }) : [],
    userId ? db.examAttempt.findMany({
      where: { userId, ...(programId ? { exam: { unit: { programId } } } : {}) },
      orderBy: { submittedAt: 'desc' },
      take: 100,
      include: {
        exam: { select: { id: true, title: true, passScore: true, unit: { select: { title: true, order: true, programId: true } } } },
        answers: { include: { question: { select: { text: true, modelAnswer: true, correctAnswer: true, points: true } } } },
      },
    }) : [],
    userId && programId ? db.assignmentSubmission.findMany({
      where: { userId, assignment: { programId } },
      orderBy: { submittedAt: 'desc' },
      take: 100,
      include: { assignment: { select: { id: true, title: true, semester: true, points: true, weight: true, type: true } } },
    }) : [],
    userId ? db.supervisorAssessment.findMany({
      where: { studentId: userId, ...(app.id ? { admissionId: app.id } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { attempts: { where: { studentId: userId }, orderBy: { submittedAt: 'desc' }, take: 3 } },
    }) : [],
    userId ? db.supervisorChannelMessage.findMany({
      where: { scope: 'SUPERVISION', OR: [{ admissionId: app.id }, { studentId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: 3,
    }) : [],
  ])

  const graded = attempts.filter((a: any) => a.score != null)
  const unitGraded = unitAttempts.filter((a: any) => a.score != null)
  const allGraded = [...graded, ...unitGraded]
  const failed = graded.filter((a: any) => (a.finalScore ?? a.score ?? 0) < (a.exam?.passScore ?? 60))
  const unitFailed = unitGraded.filter((a: any) => Number(a.score ?? 0) < (a.exam?.passScore ?? 60))
  const avgScore = allGraded.length ? Math.round(allGraded.reduce((s: number, a: any) => s + Number(a.finalScore ?? a.score ?? 0), 0) / allGraded.length) : null
  const weakSignals = [...attempts, ...unitAttempts].flatMap((a: any) => (a.answers || [])
    .filter((ans: any) => ans.points != null && ans.maxPoints != null && Number(ans.points) < Number(ans.maxPoints) * 0.5)
    .slice(0, 5)
    .map((ans: any) => ({
      examTitle: a.exam?.title,
      question: ans.question?.text,
      skill: ans.question?.cognitiveSkill,
      sourceBookTitle: ans.question?.sourceBookTitle,
      feedback: ans.aiFeedback,
      score: ans.points,
      max: ans.maxPoints,
    }))
  ).slice(0, 12)

  const programExamAttemptByExamId = new Map<string, any>()
  for (const a of attempts) {
    if (a.examId && !programExamAttemptByExamId.has(a.examId)) programExamAttemptByExamId.set(a.examId, a)
  }
  const unitAttemptByExamId = new Map<string, any>()
  for (const a of unitAttempts) {
    if (a.examId && !unitAttemptByExamId.has(a.examId)) unitAttemptByExamId.set(a.examId, a)
  }
  const assignmentSubmissionByAssignmentId = new Map<string, any>()
  for (const s of assignments) {
    if (s.assignment?.id && !assignmentSubmissionByAssignmentId.has(s.assignment.id)) assignmentSubmissionByAssignmentId.set(s.assignment.id, s)
  }

  const availableProgramExams = (program?.programExams || []).map((exam: any) => {
    const attempt = programExamAttemptByExamId.get(exam.id)
    const studentAvailable = exam.status === 'READY'
    return {
      id: exam.id,
      title: exam.title,
      semester: exam.semester,
      status: exam.status,
      studentAvailable,
      passScore: exam.passScore,
      durationMin: exam.durationMin,
      totalPoints: exam.totalPoints,
      questionsCount: exam._count?.questions || 0,
      submitted: !!attempt,
      attemptId: attempt?.id || null,
      score: attempt?.score ?? null,
      finalScore: attempt?.finalScore ?? null,
      passed: attempt?.passed ?? null,
      submittedAt: attempt?.submittedAt || attempt?.createdAt || null,
      appealStatus: attempt?.appealStatus || null,
    }
  })

  const availableUnitExams = (program?.units || [])
    .filter((unit: any) => !!unit.exam)
    .map((unit: any) => {
      const attempt = unitAttemptByExamId.get(unit.exam.id)
      return {
        id: unit.exam.id,
        title: unit.exam.title,
        unitId: unit.id,
        unitTitle: unit.title,
        unitOrder: unit.order,
        passScore: unit.exam.passScore,
        questionsCount: unit.exam._count?.questions || 0,
        submitted: !!attempt,
        attemptId: attempt?.id || null,
        score: attempt?.score ?? null,
        passed: attempt?.passed ?? null,
        submittedAt: attempt?.submittedAt || attempt?.createdAt || null,
      }
    })

  const availableAssignments = (program?.assignments || []).map((assignment: any) => {
    const submission = assignmentSubmissionByAssignmentId.get(assignment.id)
    return {
      id: assignment.id,
      title: assignment.title,
      semester: assignment.semester,
      type: assignment.type,
      points: assignment.points,
      weight: assignment.weight,
      dueDays: assignment.dueDays,
      dueAt: assignment.dueAt || null,
      status: assignment.status,
      submitted: !!submission,
      submissionId: submission?.id || null,
      score: submission?.score ?? null,
      submissionStatus: submission?.status || null,
      submittedAt: submission?.submittedAt || null,
      feedback: submission?.feedback || null,
    }
  })

  return {
    id: app.id,
    userId: app.userId || null,
    reference: app.reference,
    fullName: app.fullName,
    email: app.email,
    phone: app.phone,
    country: app.country,
    status: app.status,
    statusLabel: statusLabel(app.status),
    supervisionMode: app.supervisionMode || (app.supervisorId ? 'HUMAN' : 'AI'),
    supervisorId: app.supervisorId,
    supervisorName: app.supervisor?.name || null,
    programId,
    programTitle: program?.titleAr || app.program,
    thesisDeadline: app.thesisDeadline,
    createdAt: app.createdAt,
    books: program?.books || [],
    knowledgeItems: program?.knowledgeItems || [],
    exams: program?.programExams || [],
    availableProgramExams,
    availableUnitExams,
    availableAssignments,
    attempts: attempts.map((a: any) => ({
      id: a.id,
      kind: 'PROGRAM_EXAM',
      examId: a.examId,
      examTitle: a.exam?.title,
      semester: a.exam?.semester,
      score: a.score,
      finalScore: a.finalScore,
      passed: a.passed,
      status: a.status,
      appealStatus: a.appealStatus,
      feedback: a.feedback,
      submittedAt: a.submittedAt || a.createdAt,
      weakAnswers: (a.answers || []).filter((ans: any) => Number(ans.points || 0) < Number(ans.maxPoints || 1) * 0.6).slice(0, 4).map((ans: any) => ({
        question: ans.question?.text,
        sourceBookTitle: ans.question?.sourceBookTitle,
        skill: ans.question?.cognitiveSkill,
        points: ans.points,
        maxPoints: ans.maxPoints,
        aiFeedback: ans.aiFeedback,
      })),
    })),
    unitAttempts: unitAttempts.map((a: any) => ({
      id: a.id,
      kind: 'UNIT_DAILY_EXAM',
      examId: a.examId,
      examTitle: a.exam?.title,
      unitTitle: a.exam?.unit?.title,
      unitOrder: a.exam?.unit?.order,
      score: a.score,
      passed: a.passed,
      status: a.status,
      feedback: a.feedback,
      submittedAt: a.submittedAt || a.createdAt,
      weakAnswers: (a.answers || []).filter((ans: any) => Number(ans.points || 0) < Number(ans.maxPoints || 1) * 0.6).slice(0, 4).map((ans: any) => ({
        question: ans.question?.text,
        points: ans.points,
        maxPoints: ans.maxPoints,
        aiFeedback: ans.aiFeedback,
      })),
    })),
    assignments: assignments.map((s: any) => ({
      id: s.id,
      title: s.assignment?.title,
      semester: s.assignment?.semester,
      points: s.assignment?.points,
      score: s.score,
      status: s.status,
      feedback: s.feedback,
      submittedAt: s.submittedAt,
    })),
    privateAssessments: privateAssessments.map((x: any) => ({
      id: x.id,
      title: x.title,
      type: x.type,
      semester: x.semester,
      status: x.status,
      aiGenerated: x.aiGenerated,
      aiGradingEnabled: x.aiGradingEnabled,
      totalPoints: x.totalPoints,
      createdAt: x.createdAt,
      attempts: x.attempts,
    })),
    theses: app.theses || [],
    messagesPreview: messages.reverse().map((m: any) => ({ id: m.id, senderRole: m.senderRole, content: m.content, mode: m.mode, createdAt: m.createdAt })),
    metrics: {
      avgScore,
      attemptsCount: attempts.length + unitAttempts.length,
      programExamAttemptsCount: attempts.length,
      unitExamAttemptsCount: unitAttempts.length,
      availableProgramExamsCount: availableProgramExams.length,
      pendingProgramExamsCount: availableProgramExams.filter((x: any) => x.studentAvailable && !x.submitted).length,
      availableUnitExamsCount: availableUnitExams.length,
      pendingUnitExamsCount: availableUnitExams.filter((x: any) => !x.submitted).length,
      failedCount: failed.length + unitFailed.length,
      assignmentsCount: assignments.length,
      availableAssignmentsCount: availableAssignments.length,
      pendingAssignmentsCount: availableAssignments.filter((x: any) => !x.submitted).length,
      assignmentsGraded: assignments.filter((s: any) => s.status === 'GRADED').length,
      privateAssessmentsCount: privateAssessments.length,
      privateAssessmentsSubmitted: privateAssessments.filter((x: any) => x.attempts?.length).length,
      booksCount: program?.books?.length || 0,
      knowledgeCount: program?.knowledgeItems?.length || 0,
      examCoverage: pct(attempts.length + unitAttempts.length, availableProgramExams.length + availableUnitExams.length),
    },
    weakSignals,
  }
}

// Read-only academic preview: same grade/semester engines as the admin's
// student preview, but only the one student AND programme assigned to this supervisor.
// Deliberately excludes administration messages, finances and account controls.
async function buildAcademicPreview(admission: { id: string; userId: string | null; programId: string | null; fullName: string }) {
  const userId = admission.userId!
  const programId = admission.programId!
  const enrollment = await db.enrollment.findUnique({
    where: { userId_programId: { userId, programId } },
    select: {
      id: true, status: true, createdAt: true, completedUnits: true, extensionDays: true,
      program: { select: { titleAr: true, category: true, maxStudyDays: true } },
    },
  })
  if (!enrollment) {
    return { previewMode: 'SUPERVISOR_ACADEMIC_READ_ONLY', studentName: admission.fullName,
      programId, enrollment: null, cumulative: null, tracking: null, counts: null,
      units: [], programExams: [], assignments: [], remaining: null }
  }
  const [units, unitVideos, watches, unitAttempts, programExams, programAttempts, publishedAssignments, submissions, grade] = await Promise.all([
    db.unit.findMany({
      where: { programId },
      orderBy: [{ semester: 'asc' }, { order: 'asc' }],
      select: { id: true, title: true, semester: true, order: true,
        exam: { select: { id: true, title: true, passScore: true, status: true } } },
    }),
    db.lectureVideoResource.findMany({
      where: { programId, unitId: { not: null }, status: 'PUBLISHED' },
      select: { id: true, unitId: true },
    }),
    db.lectureWatchProgress.findMany({
      where: { userId, video: { programId } },
      select: { watchedPercent: true, completedAt: true, video: { select: { unitId: true } } },
    }),
    db.examAttempt.findMany({
      where: { userId, exam: { unit: { programId } } },
      orderBy: { createdAt: 'desc' }, take: 300,
      select: { id: true, score: true, passed: true, status: true, examId: true },
    }),
    db.programExam.findMany({
      where: { programId }, orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, title: true, semester: true, status: true },
    }),
    db.programExamAttempt.findMany({
      where: { userId, exam: { programId } }, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, status: true, examId: true, passed: true },
    }),
    db.programAssignment.findMany({
      where: { programId, status: 'PUBLISHED' }, orderBy: { createdAt: 'asc' },
      select: { id: true, title: true, semester: true },
    }),
    db.assignmentSubmission.findMany({
      where: { userId, assignment: { programId } }, take: 200,
      select: { id: true, assignmentId: true, status: true, score: true },
    }),
    calculateFinalGrade({ userId, programId, admissionId: admission.id }),
  ])
  const tracking = await getStudentSemesterTracking(db, { userId, programId, admissionId: admission.id, finalGrade: grade })
  let completedIds: string[] = []
  try {
    const parsed = JSON.parse(enrollment.completedUnits || '[]')
    if (Array.isArray(parsed)) completedIds = parsed.filter((id): id is string => typeof id === 'string')
  } catch { /* Invalid legacy progress is not evidence of a completed unit. */ }
  const completed = new Set(completedIds)
  const unitRows = units.map((unit) => {
    const attempts = unit.exam ? unitAttempts.filter((a) => a.examId === unit.exam!.id) : []
    const graded = attempts.filter((a) => a.status === 'GRADED' && typeof a.score === 'number')
    const bestScore = graded.length ? Math.max(...graded.map((a) => a.score!)) : null
    const passed = unit.exam ? graded.some((a) => a.passed === true || (a.score != null && a.score >= unit.exam!.passScore)) : null
    const videosCount = unitVideos.filter((v) => v.unitId === unit.id).length
    const watched = watches.filter((w) => w.video.unitId === unit.id)
    const watch = videosCount === 0 ? null
      : watched.some((w) => w.completedAt) ? 'COMPLETED'
      : watched.some((w) => (w.watchedPercent ?? 0) > 0) ? 'STARTED' : 'NONE'
    const state = completed.has(unit.id) || passed === true ? 'COMPLETED'
      : attempts.length || watch === 'STARTED' || watch === 'COMPLETED' ? 'IN_PROGRESS' : 'NOT_STARTED'
    return {
      id: unit.id, title: unit.title, semester: unit.semester, order: unit.order,
      examTitle: unit.exam?.title ?? null, examStatus: unit.exam?.status ?? null,
      bestScore, attemptsCount: attempts.length, passed, videosCount, watch, state,
    }
  })
  const programExamRows = programExams.map((exam) => ({
    id: exam.id, title: exam.title, semester: exam.semester, status: exam.status,
    submitted: programAttempts.some((a) => a.examId === exam.id),
    passed: programAttempts.some((a) => a.examId === exam.id && a.passed === true),
  }))
  const assignmentRows = publishedAssignments.map((assignment) => {
    const submission = submissions.find((s) => s.assignmentId === assignment.id)
    return {
      id: assignment.id, title: assignment.title, semester: assignment.semester,
      submitted: Boolean(submission), status: submission?.status ?? null, score: submission?.score ?? null,
    }
  })
  const deadline = getEnrollmentDeadline(new Date(enrollment.createdAt), enrollment.program, enrollment.extensionDays || 0)
  const thesisPending = grade.components.some((c) => (c.key === 'thesis' || c.key === 'defense') && !c.ready && !c.exempt)
  return {
    previewMode: 'SUPERVISOR_ACADEMIC_READ_ONLY', studentName: admission.fullName, programId,
    enrollment: { id: enrollment.id, status: enrollment.status, programTitle: enrollment.program.titleAr,
      category: enrollment.program.category, daysLeft: deadline ? daysLeftUntil(deadline) : null },
    cumulative: { score: grade.score, earnedScore: grade.earnedScore, progressScore: grade.progressScore,
      weightSource: grade.weightSource, components: grade.components },
    tracking,
    counts: {
      unitsTotal: unitRows.length, unitsCompleted: unitRows.filter((u) => u.state === 'COMPLETED').length,
      unitExamsTotal: unitRows.filter((u) => u.examTitle).length,
      unitExamsPassed: unitRows.filter((u) => u.passed === true).length,
      assignmentsTotal: assignmentRows.length, assignmentsSubmitted: assignmentRows.filter((a) => a.submitted).length,
      programExamsTotal: programExamRows.length, programExamsPassed: programExamRows.filter((e) => e.passed).length,
    },
    units: unitRows, programExams: programExamRows, assignments: assignmentRows,
    remaining: {
      unitsNotCompleted: unitRows.filter((u) => u.state !== 'COMPLETED').map((u) => u.title),
      unitExamsNotPassed: unitRows.filter((u) => u.examTitle && u.passed !== true).map((u) => u.title),
      assignmentsNotSubmitted: assignmentRows.filter((a) => !a.submitted).map((a) => a.title),
      programExamsNotPassed: programExamRows.filter((e) => !e.passed).map((e) => e.title),
      thesisPending, gradeMissing: grade.missing,
    },
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    if (!['SUPERVISOR', 'ADMIN'].includes(user.role)) {
      return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    }
    const apps = await db.admissionApplication.findMany({
      where: user.role === 'ADMIN' ? { userId: { not: null } } : { supervisorId: user.id },
      orderBy: [{ supervisorAt: 'desc' }, { createdAt: 'desc' }],
      take: 80,
      include: {
        supervisor: { select: { id: true, name: true, role: true } },
        theses: { orderBy: { updatedAt: 'desc' }, take: 5, select: { id: true, title: true, status: true, aiScore: true, resultScore: true, passed: true, defenseDate: true, defenseMeetingUrl: true, updatedAt: true } },
      },
    })
    const students = await Promise.all(apps.map(buildStudentCard))
    return NextResponse.json({ students })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('supervisor students error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر تحميل متابعة المشرف' }, { status: 500 })
  }
}
