import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

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
  const [program, attempts, assignments, privateAssessments, messages] = await Promise.all([
    programId ? db.program.findUnique({
      where: { id: programId },
      include: {
        books: { select: { id: true, title: true, semester: true, linkReadStatus: true, source: true } },
        knowledgeItems: { select: { id: true, category: true, title: true, importance: true }, orderBy: { importance: 'desc' }, take: 12 },
        programExams: { select: { id: true, title: true, semester: true, status: true, passScore: true, durationMin: true, totalPoints: true, _count: { select: { questions: true } } } },
      },
    }) : null,
    userId ? db.programExamAttempt.findMany({
      where: { userId, ...(programId ? { exam: { programId } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        exam: { select: { id: true, title: true, semester: true, passScore: true, programId: true } },
        answers: { include: { question: { select: { text: true, modelAnswer: true, correctAnswer: true, cognitiveSkill: true, sourceBookTitle: true, points: true } } } },
      },
    }) : [],
    userId && programId ? db.assignmentSubmission.findMany({
      where: { userId, assignment: { programId } },
      orderBy: { submittedAt: 'desc' },
      take: 20,
      include: { assignment: { select: { id: true, title: true, semester: true, points: true, weight: true, type: true } } },
    }) : [],
    userId ? db.supervisorAssessment.findMany({
      where: { studentId: userId, ...(app.id ? { admissionId: app.id } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { attempts: { where: { studentId: userId }, orderBy: { submittedAt: 'desc' }, take: 3 } },
    }) : [],
    userId ? db.supervisorChannelMessage.findMany({
      where: { OR: [{ admissionId: app.id }, { studentId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: 3,
    }) : [],
  ])

  const graded = attempts.filter((a: any) => a.score != null)
  const failed = graded.filter((a: any) => (a.finalScore ?? a.score ?? 0) < (a.exam?.passScore ?? 60))
  const avgScore = graded.length ? Math.round(graded.reduce((s: number, a: any) => s + Number(a.finalScore ?? a.score ?? 0), 0) / graded.length) : null
  const weakSignals = attempts.flatMap((a: any) => (a.answers || [])
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

  return {
    id: app.id,
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
    attempts: attempts.map((a: any) => ({
      id: a.id,
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
      attemptsCount: attempts.length,
      failedCount: failed.length,
      assignmentsCount: assignments.length,
      assignmentsGraded: assignments.filter((s: any) => s.status === 'GRADED').length,
      privateAssessmentsCount: privateAssessments.length,
      privateAssessmentsSubmitted: privateAssessments.filter((x: any) => x.attempts?.length).length,
      booksCount: program?.books?.length || 0,
      knowledgeCount: program?.knowledgeItems?.length || 0,
      examCoverage: pct(attempts.length, program?.programExams?.length || 0),
    },
    weakSignals,
  }
}

export async function GET() {
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
        theses: { orderBy: { updatedAt: 'desc' }, take: 5, select: { id: true, title: true, status: true, aiScore: true, resultScore: true, passed: true, defenseDate: true, updatedAt: true } },
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
