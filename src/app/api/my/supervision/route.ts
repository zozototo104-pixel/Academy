import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import {
  assessmentWindowEndsAt,
  buildAssessmentPolicy,
  getAssessmentMaxAttempts,
  hideCorrectAnswersInFeedback,
  type AssessmentAttemptPolicy,
} from '@/lib/assessment-attempt-policy'

function parseOptions(v: any): string[] {
  if (Array.isArray(v)) return v.map(String)
  try {
    const parsed = JSON.parse(String(v || '[]'))
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch { return [] }
}

// هذا المسار للطالب فقط: مفاتيح التصحيح لا تغادر الخادم أبداً — نفس قاعدة
// مسار تقييمات المشرف (stripQuestionKeys هناك). تُنزع من أسئلة التقييم
// ومن الأسئلة المتداخلة داخل أجوبة محاولات الطالب على حد سواء.
function stripQuestionKeys(q: any): any {
  if (!q || typeof q !== 'object') return q
  const { correctAnswer, modelAnswer, correctRationale, sourceEvidence, ...rest } = q
  return rest
}

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

export async function GET() {
  try {
    const user = await requireUser()
    if (user.role !== 'STUDENT') {
      return NextResponse.json({ supervision: [], active: null, restricted: true })
    }
    const apps = await db.admissionApplication.findMany({
      where: { OR: [{ userId: user.id }, { email: user.email }] },
      orderBy: [{ supervisorAt: 'desc' }, { createdAt: 'desc' }],
      take: 10,
      include: {
        supervisor: { select: { id: true, name: true, email: true, phone: true } },
        programRef: { select: { id: true, titleAr: true, books: { select: { id: true, title: true, semester: true } } } },
        theses: { orderBy: { updatedAt: 'desc' }, take: 3, select: { id: true, title: true, status: true, updatedAt: true } },
      },
    })
    const rows = await Promise.all(apps.map(async (app: any) => {
      const [messages, assessments] = await Promise.all([
        db.supervisorChannelMessage.findMany({ where: { admissionId: app.id, scope: 'SUPERVISION' }, orderBy: { createdAt: 'asc' }, take: 100 }),
        db.supervisorAssessment.findMany({
          where: { admissionId: app.id, studentId: user.id, status: { in: ['PUBLISHED', 'CLOSED'] } },
          orderBy: { createdAt: 'desc' },
          include: {
            questions: { orderBy: { order: 'asc' } },
            attempts: { where: { studentId: user.id }, orderBy: { submittedAt: 'desc' }, take: 3, include: { answers: { include: { question: true } } } },
          },
        }),
      ])
      const maxAttempts = await getAssessmentMaxAttempts().catch(() => 3)
      const assessmentIds = assessments.map((a: any) => a.id)
      const attemptModel = db.supervisorAssessmentAttempt as any
      const allAttempts: { assessmentId: string; passed: boolean | null }[] = assessmentIds.length && attemptModel?.findMany
        ? await attemptModel.findMany({ where: { assessmentId: { in: assessmentIds }, studentId: user.id }, select: { assessmentId: true, passed: true } }).catch(() => [])
        : []
      const windowModel = (db as any).supervisorAssessmentAttemptWindow
      const windows: any[] = assessmentIds.length && windowModel?.findMany
        ? await windowModel.findMany({ where: { assessmentId: { in: assessmentIds }, studentId: user.id } }).catch(() => [])
        : []
      const policyFor = (a: any): AssessmentAttemptPolicy => {
        const rows = allAttempts.filter((r) => r.assessmentId === a.id)
        return buildAssessmentPolicy({ maxAttempts, completedAttempts: rows.length, passed: rows.some((r) => r.passed === true) })
      }
      const windowFor = (a: any) => {
        const w = windows.find((x: any) => x.assessmentId === a.id)
        return w ? { startedAt: w.startedAt, endsAt: assessmentWindowEndsAt(w.startedAt, a.durationMin), restarts: w.restarts } : null
      }
      return {
        admission: {
          id: app.id,
          reference: app.reference,
          fullName: app.fullName,
          program: app.programRef?.titleAr || app.program,
          programId: app.programId,
          status: app.status,
          supervisionMode: app.supervisionMode || (app.supervisorId ? 'HUMAN' : 'AI'),
          supervisor: app.supervisor,
          thesisDeadline: app.thesisDeadline,
          books: app.programRef?.books || [],
          theses: app.theses || [],
        },
        messages,
        assessments: assessments.map((a: any) => {
          const policy = policyFor(a)
          return {
            ...a,
            sourceBookIds: a.sourceBookIds ? JSON.parse(a.sourceBookIds) : [],
            questions: a.questions.map((q: any) => ({ ...stripQuestionKeys(q), options: parseOptions(q.options) })),
            attempts: attemptsForStudent(a.attempts || [], policy.reveal),
            attemptPolicy: policy,
            attemptWindow: windowFor(a),
          }
        }),
      }
    }))
    return NextResponse.json({ supervision: rows, active: rows[0] || null })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('my supervision error:', e)
    return NextResponse.json({ error: 'تعذر تحميل متابعة المشرف' }, { status: 500 })
  }
}
