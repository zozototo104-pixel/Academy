import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { notify } from '@/lib/notify'
import { AI_UNAVAILABLE_MESSAGE, generateSupervisorQuestions, gradeSupervisorAttemptWithAi } from '@/lib/supervisor-assessment-ai'
import {
  ASSESSMENT_MAX_WINDOW_RESTARTS,
  assessmentWindowEndsAt,
  buildAssessmentPolicy,
  getAssessmentMaxAttempts,
  hideCorrectAnswersInFeedback,
  isAssessmentWindowExpired,
  loadAssessmentPolicy,
  type AssessmentAttemptPolicy,
} from '@/lib/assessment-attempt-policy'

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

// مفاتيح التصحيح لا تصل الطالب أبداً — لا في قائمة الأسئلة ولا متداخلة داخل
// أسئلة محاولاته السابقة. إخفاؤها في الواجهة لا يكفي: استجابة الشبكة نفسها
// يجب أن تخلو منها، وإلا قرأها الطالب قبل التسليم.
function stripQuestionKeys(q: any): any {
  if (!q || typeof q !== 'object') return q
  const { correctAnswer, modelAnswer, correctRationale, sourceEvidence, ...rest } = q
  return rest
}

// وصول الطالب للمحاولات: مفاتيح التصحيح منزوعة دائماً، ونصوص التصحيح التي
// تذكر الإجابة الصحيحة صراحة محجوبة ما دام الكشف غير مسموح (لم ينجح الطالب
// بعد ولم يستنفد محاولاته) — سياسة المحاولات في lib/assessment-attempt-policy.
function attemptsForStudent(attempts: any[], reveal = true): any[] {
  return (attempts || []).map((at: any) => ({
    ...at,
    feedback: reveal ? at?.feedback : hideCorrectAnswersInFeedback(at?.feedback),
    answers: (at?.answers || []).map((an: any) => {
      const base = reveal ? an : { ...an, aiFeedback: hideCorrectAnswersInFeedback(an?.aiFeedback) }
      return an?.question ? { ...base, question: stripQuestionKeys(an.question) } : base
    }),
  }))
}

function windowView(w: any, durationMin: number) {
  if (!w) return null
  return { startedAt: w.startedAt, endsAt: assessmentWindowEndsAt(w.startedAt, durationMin), restarts: w.restarts }
}

async function loadWindow(assessmentId: string, studentId: string) {
  const model = (db as any).supervisorAssessmentAttemptWindow
  if (!model?.findUnique) return null
  return model
    .findUnique({ where: { assessmentId_studentId: { assessmentId, studentId } } })
    .catch(() => null)
}

async function serializeAssessment(id: string, studentId?: string | null, opts?: { forStudent?: boolean }) {
  const assessment = await db.supervisorAssessment.findUnique({
    where: { id },
    include: {
      questions: { orderBy: { order: 'asc' } },
      attempts: { where: studentId ? { studentId } : {}, orderBy: { submittedAt: 'desc' }, take: 5, include: { answers: { include: { question: true } } } },
    },
  })
  if (!assessment) return null
  const forStudent = !!opts?.forStudent
  let attemptPolicy: AssessmentAttemptPolicy | null = null
  let attemptWindow: any = null
  if (forStudent && studentId) {
    // Safe default on any failure: answers stay hidden.
    attemptPolicy = await loadAssessmentPolicy(id, studentId).catch(() => null)
    if (!attemptPolicy) {
      const maxAttempts = await getAssessmentMaxAttempts().catch(() => 3)
      attemptPolicy = buildAssessmentPolicy({ maxAttempts, completedAttempts: 0, passed: false })
    }
    attemptWindow = windowView(await loadWindow(id, studentId), assessment.durationMin)
  }
  return {
    ...assessment,
    sourceBookIds: assessment.sourceBookIds ? JSON.parse(assessment.sourceBookIds) : [],
    questions: assessment.questions.map((q: any) => {
      const base = forStudent ? stripQuestionKeys(q) : q
      return { ...base, options: parseOptions(q.options) }
    }),
    ...(forStudent
      ? { attempts: attemptsForStudent((assessment as any).attempts || [], attemptPolicy?.reveal ?? false), attemptPolicy, attemptWindow }
      : {}),
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
    const forStudent = user.role === 'STUDENT'
    const policyByAssessment = new Map<string, AssessmentAttemptPolicy>()
    const windowByAssessment = new Map<string, any>()
    if (forStudent && app.userId && assessments.length) {
      const maxAttempts = await getAssessmentMaxAttempts().catch(() => 3)
      const ids = assessments.map((a: any) => a.id)
      const attemptModel = db.supervisorAssessmentAttempt as any
      const allAttempts: { assessmentId: string; passed: boolean | null }[] = attemptModel?.findMany
        ? await attemptModel.findMany({ where: { assessmentId: { in: ids }, studentId: app.userId }, select: { assessmentId: true, passed: true } }).catch(() => [])
        : []
      const windowModel = (db as any).supervisorAssessmentAttemptWindow
      const windows: any[] = windowModel?.findMany
        ? await windowModel.findMany({ where: { assessmentId: { in: ids }, studentId: app.userId } }).catch(() => [])
        : []
      for (const w of windows) windowByAssessment.set(w.assessmentId, w)
      for (const a of assessments) {
        const rows = allAttempts.filter((r) => r.assessmentId === a.id)
        policyByAssessment.set(a.id, buildAssessmentPolicy({
          maxAttempts,
          completedAttempts: rows.length,
          passed: rows.some((r) => r.passed === true),
        }))
      }
      for (const a of assessments) {
        // keep the map warm for rows with no attempts at all
        if (!policyByAssessment.has(a.id)) policyByAssessment.set(a.id, buildAssessmentPolicy({ maxAttempts, completedAttempts: 0, passed: false }))
      }
    }
    return NextResponse.json({ assessments: assessments.map((a: any) => {
      const policy = forStudent ? policyByAssessment.get(a.id) : null
      return {
        ...a,
        sourceBookIds: a.sourceBookIds ? JSON.parse(a.sourceBookIds) : [],
        questions: a.questions.map((q: any) => {
          const base = forStudent ? stripQuestionKeys(q) : q
          return { ...base, options: parseOptions(q.options) }
        }),
        ...(forStudent
          ? {
              attempts: attemptsForStudent(a.attempts || [], policy?.reveal ?? false),
              attemptPolicy: policy,
              attemptWindow: windowView(windowByAssessment.get(a.id), a.durationMin),
            }
          : {}),
      }
    }) })
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

async function startAttempt(body: any, user: any) {
  const assessmentId = String(body.assessmentId || '')
  const assessment = await db.supervisorAssessment.findUnique({ where: { id: assessmentId } })
  if (!assessment || assessment.status !== 'PUBLISHED') return NextResponse.json({ error: 'الاختبار غير متاح' }, { status: 404 })
  const app = await admissionForAccess(assessment.admissionId, user, 'read')
  if (!app || user.role !== 'STUDENT' || assessment.studentId !== user.id) return NextResponse.json({ error: 'هذا الاختبار ليس مخصصاً لحسابك' }, { status: 403 })
  const policy = await loadAssessmentPolicy(assessment.id, user.id)
  if (policy.passed) return NextResponse.json({ error: 'سبق أن اجتزت هذا التقييم', code: 'ALREADY_PASSED' }, { status: 409 })
  if (!policy.canAttempt) return NextResponse.json({ error: `استنفدت محاولاتك (${policy.maxAttempts}) في هذا التقييم`, code: 'ATTEMPTS_EXHAUSTED' }, { status: 409 })

  const now = new Date()
  const existing = await loadWindow(assessment.id, user.id)
  if (existing) {
    if (!isAssessmentWindowExpired(existing.startedAt, assessment.durationMin, now)) {
      return NextResponse.json({ ok: true, resumed: true, attemptWindow: windowView(existing, assessment.durationMin) })
    }
    if ((existing.restarts || 0) >= ASSESSMENT_MAX_WINDOW_RESTARTS) {
      return NextResponse.json({ error: 'انتهت مدة التقييم ولا تتوفر إعادة بدء أخرى لهذه المحاولة', code: 'WINDOW_LOCKED' }, { status: 410 })
    }
    const restarted = await (db as any).supervisorAssessmentAttemptWindow.update({
      where: { id: existing.id },
      data: { startedAt: now, restarts: (existing.restarts || 0) + 1 },
    })
    return NextResponse.json({ ok: true, restarted: true, attemptWindow: windowView(restarted, assessment.durationMin) })
  }
  const created = await (db as any).supervisorAssessmentAttemptWindow.create({
    data: { assessmentId: assessment.id, studentId: user.id, startedAt: now },
  })
  return NextResponse.json({ ok: true, attemptWindow: windowView(created, assessment.durationMin) })
}

async function submitAttempt(body: any, user: any) {
  const assessmentId = String(body.assessmentId || '')
  const assessment = await db.supervisorAssessment.findUnique({ where: { id: assessmentId }, include: { questions: { orderBy: { order: 'asc' } } } })
  if (!assessment || assessment.status !== 'PUBLISHED') return NextResponse.json({ error: 'الاختبار غير متاح' }, { status: 404 })
  const app = await admissionForAccess(assessment.admissionId, user, 'read')
  if (!app || user.role !== 'STUDENT' || assessment.studentId !== user.id) return NextResponse.json({ error: 'هذا الاختبار ليس مخصصاً لحسابك' }, { status: 403 })

  // بوابة سياسة المحاولات: ناجح لا يعيد، ومن استنفد محاولاته لا يسلّم مجدداً.
  const policy = await loadAssessmentPolicy(assessment.id, user.id)
  if (policy.passed) return NextResponse.json({ error: 'سبق أن اجتزت هذا التقييم', code: 'ALREADY_PASSED' }, { status: 409 })
  if (!policy.canAttempt) return NextResponse.json({ error: `استنفدت محاولاتك (${policy.maxAttempts}) في هذا التقييم`, code: 'ATTEMPTS_EXHAUSTED' }, { status: 409 })

  // تطبيق المدة من ساعة السيرفر: لا تسليم دون نافذة بدء حية لهذه المحاولة.
  let attemptWindowRow: any = null
  if (assessment.durationMin > 0) {
    attemptWindowRow = await loadWindow(assessment.id, user.id)
    if (!attemptWindowRow) return NextResponse.json({ error: 'ابدأ التقييم أولاً من زر «بدء التقييم» حتى تُحتسب مدته', code: 'START_REQUIRED' }, { status: 400 })
    if (isAssessmentWindowExpired(attemptWindowRow.startedAt, assessment.durationMin)) {
      return NextResponse.json({ error: 'انتهت مدة التقييم قبل التسليم', code: 'TIME_EXPIRED' }, { status: 410 })
    }
  }

  const answers = Array.isArray(body.answers) ? body.answers : []
  const hasOpen = assessment.questions.some((q: any) => q.type === 'SHORT' || q.type === 'ESSAY')
  let grade: any = null
  if (assessment.aiGradingEnabled || !hasOpen) {
    grade = await gradeSupervisorAttemptWithAi({
      assessmentTitle: assessment.title,
      passScore: assessment.passScore,
      questions: assessment.questions.map((q: any) => ({ id: q.id, type: q.type, text: q.text, correctAnswer: q.correctAnswer, modelAnswer: q.modelAnswer, points: q.points })),
      answers,
      attemptNumber: policy.completedAttempts + 1,
      maxAttempts: policy.maxAttempts,
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
  if (attemptWindowRow) {
    await (db as any).supervisorAssessmentAttemptWindow.delete({ where: { id: attemptWindowRow.id } }).catch(() => {})
  }
  await notify(app.supervisorId || null, 'SUPERVISION_ASSESSMENT', 'تسليم اختبار خاص', `${app.fullName} سلّم اختبار «${assessment.title}»${grade ? ` بنتيجة ${grade.score}%` : ' وهو بانتظار المراجعة'}.`, 'supervisor')
  const policyAfter = buildAssessmentPolicy({
    maxAttempts: policy.maxAttempts,
    completedAttempts: policy.completedAttempts + 1,
    passed: policy.passed || attempt.passed === true,
  })
  const safeAttempt = policyAfter.reveal ? attempt : { ...attempt, feedback: hideCorrectAnswersInFeedback(attempt.feedback) }
  return NextResponse.json({ ok: true, attempt: safeAttempt, assessment: await serializeAssessment(assessment.id, user.id, { forStudent: true }) })
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
  const maxAttempts = await getAssessmentMaxAttempts().catch(() => 3)
  const attemptOrdinal = await db.supervisorAssessmentAttempt.count({
    where: { assessmentId: attempt.assessmentId, studentId: attempt.studentId, submittedAt: { lte: attempt.submittedAt } },
  }).catch(() => 1)
  const grade = await gradeSupervisorAttemptWithAi({
    assessmentTitle: attempt.assessment.title,
    passScore: attempt.assessment.passScore,
    questions: attempt.assessment.questions.map((q: any) => ({ id: q.id, type: q.type, text: q.text, correctAnswer: q.correctAnswer, modelAnswer: q.modelAnswer, points: q.points })),
    answers: attempt.answers.map((a: any) => ({ questionId: a.questionId, answerText: a.answerText, selectedOption: a.selectedOption })),
    attemptNumber: Math.max(1, attemptOrdinal),
    maxAttempts,
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
    if (action === 'start') return startAttempt(body, user)
    if (action === 'ai-grade-attempt') return aiGradeAttempt(body, user)
    return createAssessment(body, user)
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    if (e?.code === 'AI_UNAVAILABLE' || e?.message === AI_UNAVAILABLE_MESSAGE) return NextResponse.json({ error: AI_UNAVAILABLE_MESSAGE, code: 'AI_UNAVAILABLE' }, { status: 503 })
    console.error('supervisor assessments POST error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر تنفيذ العملية' }, { status: 500 })
  }
}
