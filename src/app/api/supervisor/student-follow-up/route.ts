import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getStudentFollowUpRecord, listFollowUpBoard } from '@/lib/student-follow-up'

export const runtime = 'nodejs'

// نطاق المشرف: طلابه فقط عبر طلبات القبول المسندة إليه (نفس نطاق
// /api/supervisor/students). الأدمن بلا قيد. null = بلا تقييد.
async function scopedUserIds(user: { id: string; role: string }): Promise<string[] | null> {
  if (user.role === 'ADMIN') return null
  const apps = await db.admissionApplication.findMany({
    where: { supervisorId: user.id, userId: { not: null } },
    select: { userId: true },
  })
  return [...new Set(apps.map((a) => a.userId).filter(Boolean))] as string[]
}

// GET /api/supervisor/student-follow-up — لوحة المتابعة لطلاب المشرف فقط.
// ومع ?userId= يعيد سجل متابعات الطالب إن كان من طلابه، وإلا 403.
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    if (!['SUPERVISOR', 'ADMIN'].includes(user.role)) {
      return NextResponse.json({ ok: false, error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    }
    const allowed = await scopedUserIds(user)
    const userId = req.nextUrl.searchParams.get('userId')
    if (userId) {
      if (allowed && !allowed.includes(userId)) {
        return NextResponse.json({ ok: false, error: 'هذا الطالب ليس من طلابك' }, { status: 403 })
      }
      const record = await getStudentFollowUpRecord(userId)
      return NextResponse.json({ ok: true, record })
    }
    const students = await listFollowUpBoard(allowed ? { userIds: allowed } : undefined)
    return NextResponse.json({ ok: true, students })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ ok: false, error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('supervisor student follow-up error', e)
    return NextResponse.json({ ok: false, error: 'تعذر تحميل متابعة الطلاب' }, { status: 500 })
  }
}
