import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
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
