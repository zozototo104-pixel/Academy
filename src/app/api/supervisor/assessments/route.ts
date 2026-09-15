import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { notify } from '@/lib/notify'
import { generateSupervisorQuestions, gradeSupervisorAttemptWithAi } from '@/lib/supervisor-assessment-ai'

async function admissionForAccess(admissionId: string, user: any, mode: 'read' | 'write' = 'read') {
  const app = await db.admissionApplication.findUnique({ where: { id: admissionId } })
  if (!app) return null
  const isAdmin = user.role === 'ADMIN'
  const isSupervisor = user.role === 'SUPERVISOR' && app.supervisorId === user.id
  const isStudent = user.role === 'STUDENT' && (app.userId === user.id || app.email?.toLowerCase() === user.email?.toLowerCase())
  if (mode === 'write') {
    if (!isAdmin && !isSupervisor) return null
  } else if (!isAdmin && !isSupervisor && !isStudent) return null
  return app
}

function parseOptions(v: any): string[] {
  if (Array.isArray(v)) return v.map(String)
  try {
    const parsed = JSON.parse(String(v || '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch { return [] }
}

async function serializeAssessment(id: string, studentId?: string | null) {
  const assessment = await db.supervisorAssessment.findUnique({
    where: { id },
    include: {
      questions: { orderBy: { order: 'asc' } },
      attempts: { where: studentId ? { studentId } : {}, orderBy: { submittedAt: 'desc' }, take: 5, include: { answers: { include: { question: true } } } },
    },
  })
  if (!assessment) return null
  return {
    ...assessment,
    sourceBookIds: assessment.sourceBookIds ? JSON.parse(assessment.sourceBookIds) : [],
    questions: assessment.questions.map((q: any) => ({ ...q, options: parseOptions(q.options) })),
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const admissionId = req.nextUrl.searchParams.get('admissionId') || ''
    if (!admissionId) return NextResponse.json({ error: 'معرّف الطالب/الطلب مطلوب' }, { status: 400 })
    const app = await admissionForAccess(admissionId, user)
    if (!app) return NextResponse.json({ error: 'لا تملك صلاحية قراءة هذه الاختبارات' }, { status: 403 })
    const assessments = await db.supervisorAssessment.findMany({
      where: { admissionId, ...(user.role === 'STUDENT' ? { status: { in: ['PUBLISHED', 'CLOSED'] } } : {}) },
      orderBy: { createdAt: 'desc' },
      include: {
        questions: { orderBy: { order: 'asc' } },
        attempts: { where: app.userId ? { studentId: app.userId } : {}, orderBy: { submittedAt: 'desc' }, take: 5, include: { answers: { include: { question: true } } } },
      },
    })
    return NextResponse.json({ assessments: assessments.map((a: any) => ({
      ...a,
      sourceBookIds: a.sourceBookIds ? JSON.parse(a.sourceBookIds) : [],
      questions: a.questions.map((q: any) => ({ ...q, options: parseOptions(q.options) })),
    })) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('supervisor assessments GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل اختبارات المشرف' }, { status: 500 })
  }
}

async function createAssessment(body: any, user: any) {
  const admissionId = String(body.admissionId || '')
  const app = await admissionForAccess(admissionId, user, 'write')
  if (!app) return NextResponse.json({ error: 'لا تملك صلاحية إنشاء اختبار لهذا الطالب' }, { status: 403 })
  if (!app.userId) return NextResponse.json({ error: 'لا يمكن إنشاء اختبار خاص قبل ربط الطلب بحساب طالب' }, { status: 400 })
  const title = String(body.title || '').trim() || 'اختبار خاص من المشرف'
  const type = String(body.type || 'DAILY_TEST').toUpperCase()
  const semester = Math.max(1, Math.min(3, Number(body.semester || 1)))
  const durationMin = Math.max(5, Math.min(240, Number(body.durationMin || 30)))
  const passScore = Math.max(0, Math.min(100, Number(body.passScore || 60)))
  const aiGradingEnabled = body.aiGradingEnabled !== false
  const aiGenerated = body.aiGenerated !== false
  const sourceBookIds = Array.isArray(body.sourceBookIds) ? body.sourceBookIds.map(String).filter(Boolean) : []
  let questions = Array.isArray(body.questions) ? body.questions : []
  if (aiGenerated || !questions.length) {
    questions = await generateSupervisorQuestions({
      programId: app.programId || '',
      bookIds: sourceBookIds,
      semester,
      count: Number(body.questionCount || 8),
      assessmentType: type,
      studentName: app.fullName,
      specialty: app.program,
    })
  }
  if (!questions.length) return NextResponse.json({ error: 'لم يتم توليد أسئلة صالحة' }, { status: 400 })
  const normalized = questions.slice(0, 40).map((q: any, i: number) => {
    const qType = ['MCQ', 'TF', 'SHORT', 'ESSAY'].includes(String(q.type || '').toUpperCase()) ? String(q.type).toUpperCase() : 'SHORT'
    const points = Math.max(1, Math.min(10, Number(q.points || (qType === 'ESSAY' ? 6 : qType === 'SHORT' ? 4 : 2))))
    return {
      order: i + 1,
      type: qType,
      text: String(q.text || '').trim(),
      options: q.options ? JSON.stringify(Array.isArray(q.options) ? q.options.map(String) : parseOptions(q.options)) : null,
      correctAnswer: q.correctAnswer != null ? String(q.correctAnswer) : null,
      modelAnswer: q.modelAnswer ? String(q.modelAnswer) : null,
      sourceEvidence: q.sourceEvidence ? String(q.sourceEvidence).slice(0, 1200) : null,
      sourceBookTitle: q.sourceBookTitle ? String(q.sourceBookTitle) : null,
      cognitiveSkill: q.cognitiveSkill ? String(q.cognitiveSkill) : null,
      difficulty: q.difficulty ? String(q.difficulty) : null,
      correctRationale: q.correctRationale ? String(q.correctRationale).slice(0, 1000) : null,
      points,
    }
  }).filter((q: any) => q.text.length > 8)
  const totalPoints = normalized.reduce((s: number, q: any) => s + q.points, 0)
  const assessment = await db.supervisorAssessment.create({
    data: {
      admissionId: app.id,
      studentId: app.userId,
      supervisorId: app.supervisorId || user.id,
      programId: app.programId || null,
      title,
      description: String(body.description || '').trim() || null,
      type,
      semester,
      status: 'PUBLISHED',
      aiGenerated,
      aiGradingEnabled,
      sourceBookIds: JSON.stringify(sourceBookIds),
      durationMin,
      passScore,
      totalPoints,
      createdById: user.id,
      createdByRole: user.role === 'ADMIN' ? 'ADMIN' : 'SUPERVISOR',
      questions: { create: normalized },
    },
  })
  await notify(app.userId, 'SUPERVISION_ASSESSMENT', 'اختبار خاص جديد من المشرف', `تم نشر «${title}» لك من مشرفك الأكاديمي.`, 'dashboard')
  return NextResponse.json({ ok: true, assessment: await serializeAssessment(assessment.id, app.userId) })
}

async function submitAttempt(body: any, user: any) {
  const assessmentId = String(body.assessmentId || '')
  const assessment = await db.supervisorAssessment.findUnique({ where: { id: assessmentId }, include: { questions: { orderBy: { order: 'asc' } } } })
  if (!assessment || assessment.status !== 'PUBLISHED') return NextResponse.json({ error: 'الاختبار غير متاح' }, { status: 404 })
  const app = await admissionForAccess(assessment.admissionId, user, 'read')
  if (!app || user.role !== 'STUDENT' || assessment.studentId !== user.id) return NextResponse.json({ error: 'هذا الاختبار ليس مخصصاً لحسابك' }, { status: 403 })
  const answers = Array.isArray(body.answers) ? body.answers : []
  const hasOpen = assessment.questions.some((q: any) => q.type === 'SHORT' || q.type === 'ESSAY')
  let grade: any = null
  if (assessment.aiGradingEnabled || !hasOpen) {
    grade = await gradeSupervisorAttemptWithAi({
      assessmentTitle: assessment.title,
      passScore: assessment.passScore,
      questions: assessment.questions.map((q: any) => ({ id: q.id, type: q.type, text: q.text, correctAnswer: q.correctAnswer, modelAnswer: q.modelAnswer, points: q.points })),
      answers,
    })
  }
  const attempt = await db.supervisorAssessmentAttempt.create({
    data: {
      assessmentId: assessment.id,
      studentId: user.id,
      status: grade ? 'GRADED' : 'NEEDS_REVIEW',
      score: grade?.score ?? null,
      passed: grade?.passed ?? null,
      feedback: grade?.feedback || (hasOpen ? 'تم التسليم ويحتاج مراجعة المشرف.' : null),
      aiGraded: !!grade,
      gradedAt: grade ? new Date() : null,
      answers: {
        create: assessment.questions.map((q: any) => {
          const a = answers.find((x: any) => String(x.questionId) === q.id) || {}
          const g = grade?.perQuestion?.[q.id]
          return {
            questionId: q.id,
            answerText: a.answerText != null ? String(a.answerText) : null,
            selectedOption: a.selectedOption != null && a.selectedOption !== '' ? Number(a.selectedOption) : null,
            isCorrect: g?.isCorrect ?? null,
            points: g?.points ?? null,
            maxPoints: q.points,
            aiFeedback: g?.feedback || null,
          }
        }),
      },
    },
  })
  await notify(app.supervisorId || null, 'SUPERVISION_ASSESSMENT', 'تسليم اختبار خاص', `${app.fullName} سلّم اختبار «${assessment.title}»${grade ? ` بنتيجة ${grade.score}%` : ' وهو بانتظار المراجعة'}.`, 'supervisor')
  return NextResponse.json({ ok: true, attempt, assessment: await serializeAssessment(assessment.id, user.id) })
}

async function aiGradeAttempt(body: any, user: any) {
  const attemptId = String(body.attemptId || '')
  const attempt = await db.supervisorAssessmentAttempt.findUnique({
    where: { id: attemptId },
    include: { assessment: { include: { questions: { orderBy: { order: 'asc' } } } }, answers: true },
  })
  if (!attempt) return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
  const app = await admissionForAccess(attempt.assessment.admissionId, user, 'write')
  if (!app) return NextResponse.json({ error: 'لا تملك صلاحية تصحيح هذه المحاولة' }, { status: 403 })
  const grade = await gradeSupervisorAttemptWithAi({
    assessmentTitle: attempt.assessment.title,
    passScore: attempt.assessment.passScore,
    questions: attempt.assessment.questions.map((q: any) => ({ id: q.id, type: q.type, text: q.text, correctAnswer: q.correctAnswer, modelAnswer: q.modelAnswer, points: q.points })),
    answers: attempt.answers.map((a: any) => ({ questionId: a.questionId, answerText: a.answerText, selectedOption: a.selectedOption })),
  })
  await db.$transaction([
    db.supervisorAssessmentAttempt.update({ where: { id: attempt.id }, data: { status: 'GRADED', score: grade.score, passed: grade.passed, feedback: grade.feedback, aiGraded: true, gradedAt: new Date() } }),
    ...attempt.answers.map((a: any) => db.supervisorAssessmentAnswer.update({
      where: { id: a.id },
      data: {
        points: grade.perQuestion?.[a.questionId]?.points ?? a.points,
        isCorrect: grade.perQuestion?.[a.questionId]?.isCorrect ?? a.isCorrect,
        aiFeedback: grade.perQuestion?.[a.questionId]?.feedback ?? a.aiFeedback,
      },
    })),
  ])
  await notify(app.userId || null, 'SUPERVISION_ASSESSMENT', 'تم تصحيح اختبار خاص', `تم تصحيح «${attempt.assessment.title}» بنتيجة ${grade.score}%.`, 'dashboard')
  return NextResponse.json({ ok: true, assessment: await serializeAssessment(attempt.assessmentId, attempt.studentId) })
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json()
    const action = String(body.action || 'create')
    if (action === 'submit') return submitAttempt(body, user)
    if (action === 'ai-grade-attempt') return aiGradeAttempt(body, user)
    return createAssessment(body, user)
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('supervisor assessments POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر تنفيذ العملية' }, { status: 500 })
  }
}
