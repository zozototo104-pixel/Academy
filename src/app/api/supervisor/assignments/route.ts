import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { db } from '@/lib/db'
import {
  loadSupervisorAssignmentDetail,
  analyzeAssignmentSubmission,
  gradeAssignmentSubmission,
} from '@/lib/supervisor-assignment-grading'

export const runtime = 'nodejs'
export const maxDuration = 180

function asString(value: unknown, max = 4000): string {
  return String(value || '').trim().slice(0, max)
}

function statusFor(error: any): number {
  if (typeof error?.status === 'number') return error.status
  if (error?.message === 'UNAUTHORIZED') return 401
  if (error?.message === 'FORBIDDEN') return 403
  return 500
}

function publicMessage(error: any, fallback: string): string {
  const status = statusFor(error)
  if (status === 401) return 'يجب تسجيل الدخول'
  if (status === 403) return 'هذا التسليم ليس من طلابك المعيّنين لك'
  if (status === 404) return 'التسليم غير موجود'
  if (status === 422) return 'لا يوجد نص قابل للتحليل في هذا التسليم؛ راجع الملف المرفق يدوياً'
  if (String(error?.message || '').startsWith('REFERENCE_')) return 'تعذرت إعادة قراءة صفحات المرجع الأصلي؛ راجع ملف الكتاب يدوياً ولا تعتمد خصماً على الاستشهادات.'
  if (status === 409 && error?.message === 'SOURCE_REVIEW_REQUIRED') return 'تعذر التحقق من بعض الاستشهادات أو قراءة المرجع أو المرفق؛ راجع صفحات المصدر الأصلي وأكد مراجعتها قبل اعتماد الدرجة'
  if (status === 502) return 'تعذر التحليل بالذكاء الآن؛ حاول مرة أخرى بعد قليل أو صحّح يدوياً'
  if (status === 400) return 'بيانات التصحيح غير صالحة'
  return fallback
}

// GET /api/supervisor/assignments?submissionId=xxx — تفاصيل تسليم واحد ضمن نطاق المشرف فقط.
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    if (!['SUPERVISOR', 'ADMIN'].includes(user.role)) {
      return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    }
    const mode = req.nextUrl.searchParams.get('mode')
    if (mode === 'roster') {
      const semester = Number(req.nextUrl.searchParams.get('semester'))
      const page = Number(req.nextUrl.searchParams.get('page') || 1)
      const pageSize = 20
      if (!Number.isInteger(semester) || semester < 1 || semester > 12 || !Number.isInteger(page) || page < 1 || page > 10000) {
        return NextResponse.json({ error: 'الفصل أو رقم الصفحة غير صالح' }, { status: 400 })
      }
      const programId = asString(req.nextUrl.searchParams.get('programId'), 80)
      if (!programId) return NextResponse.json({ error: 'البرنامج مطلوب' }, { status: 400 })
      const scope = { programId, userId: { not: null }, ...(user.role === 'ADMIN' ? {} : { supervisorId: user.id }) }
      const [total, apps, assignments] = await Promise.all([
        db.admissionApplication.count({ where: scope }),
        db.admissionApplication.findMany({
          where: scope,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: { id: true, userId: true, fullName: true },
        }),
        db.programAssignment.findMany({
          where: { programId, semester, status: 'PUBLISHED' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, title: true, points: true, dueAt: true, dueDays: true, type: true },
        }),
      ])
      const userIds = apps.map(app => app.userId).filter((id): id is string => Boolean(id))
      const submissions = userIds.length && assignments.length ? await db.assignmentSubmission.findMany({
        where: { userId: { in: userIds }, assignmentId: { in: assignments.map(a => a.id) } },
        select: { id: true, userId: true, assignmentId: true, status: true, score: true, submittedAt: true },
      }) : []
      const enrollments = userIds.length ? await db.enrollment.findMany({
        where: { programId, userId: { in: userIds } },
        select: { userId: true, createdAt: true },
      }) : []
      const enrolledAt = new Map(enrollments.map(e => [e.userId, e.createdAt]))
      const byPair = new Map(submissions.map(s => [s.userId + ':' + s.assignmentId, s]))
      const students = apps.map(app => ({
        admissionId: app.id,
        userId: app.userId,
        name: app.fullName || 'طالب',
        assignments: assignments.map(a => {
          const sub = byPair.get(app.userId + ':' + a.id)
          const start = enrolledAt.get(app.userId)
          const deadline = a.dueAt || (a.dueDays != null && start ? new Date(start.getTime() + a.dueDays * 86400000) : null)
          return {
            id: a.id, title: a.title, points: a.points, type: a.type, dueAt: a.dueAt,
            submissionId: sub?.id || null, score: sub?.score ?? null,
            submittedAt: sub?.submittedAt || null,
            status: sub?.status || (a.dueAt && a.dueAt.getTime() < Date.now() ? 'OVERDUE' : 'NOT_SUBMITTED'),
          }
        }),
      }))
      return NextResponse.json({ semester, page, pageSize, total, totalPages: Math.ceil(total / pageSize), students })
    }
    const submissionId = req.nextUrl.searchParams.get('submissionId') || ''
    if (!submissionId) return NextResponse.json({ error: 'معرف التسليم مطلوب' }, { status: 400 })
    const detail = await loadSupervisorAssignmentDetail(submissionId, user)
    if (!detail) return NextResponse.json({ error: 'التسليم غير موجود' }, { status: 404 })
    return NextResponse.json({ detail })
  } catch (e: any) {
    console.error('supervisor assignments GET error:', e)
    return NextResponse.json({ error: publicMessage(e, 'تعذر تحميل التسليم') }, { status: statusFor(e) })
  }
}

// POST /api/supervisor/assignments — { action: 'analyze' } مسودة فقط بلا حفظ،
// أو { action: 'grade' } اعتماد بشري يحفظ الدرجة والملاحظة.
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    if (!['SUPERVISOR', 'ADMIN'].includes(user.role)) {
      return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    }
    const body = await req.json().catch(() => ({}))
    const action = asString(body.action, 30)
    const submissionId = asString(body.submissionId, 80)
    if (!submissionId) return NextResponse.json({ error: 'معرف التسليم مطلوب' }, { status: 400 })

    if (action === 'analyze') {
      const result = await analyzeAssignmentSubmission(submissionId, user)
      return NextResponse.json({ ...result, saved: false })
    }

    if (action === 'grade') {
      const score = Number(body.score)
      const feedback = asString(body.feedback, 4000)
      const status = asString(body.status, 30).toUpperCase()
      if (!['GRADED', 'NEEDS_REVISION'].includes(status)) {
        return NextResponse.json({ error: 'حالة التصحيح غير صالحة' }, { status: 400 })
      }
      const updated = await gradeAssignmentSubmission(submissionId, user, {
        score,
        feedback,
        sourceReviewed: body.sourceReviewed === true,
        status: status as 'GRADED' | 'NEEDS_REVISION',
      })
      return NextResponse.json({ submission: updated })
    }

    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    console.error('supervisor assignments POST error:', e)
    return NextResponse.json({ error: publicMessage(e, 'تعذر تنفيذ الطلب') }, { status: statusFor(e) })
  }
}
