import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { notify, audit } from '@/lib/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/admin/enrollments/extend — تمديد مباشر من الأدمن بلا طلب
// (يختار الأدمن الفترة كل مرة، بلا سقف — قرار هاريس).
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    const body = await req.json().catch(() => ({}))
    const enrollmentId = String(body.enrollmentId || '')
    const days = Number(body.days)
    if (!enrollmentId || !Number.isFinite(days) || days < 1 || days > 3650) {
      return NextResponse.json({ error: 'عدد أيام التمديد يجب أن يكون بين 1 و 3650' }, { status: 400 })
    }
    const enrollment = await db.enrollment.findUnique({ where: { id: enrollmentId }, include: { user: { select: { name: true } }, program: { select: { titleAr: true } } } })
    if (!enrollment) return NextResponse.json({ error: 'التسجيل غير موجود' }, { status: 404 })
    await db.enrollment.update({
      where: { id: enrollmentId },
      data: {
        extensionDays: { increment: Math.floor(days) },
        ...(enrollment.status === 'EXPIRED' ? { status: 'ACTIVE', finalScore: null } : {}),
      },
    })
    await audit(user, 'ENROLLMENT_EXTENDED', 'Enrollment', enrollmentId, `مدّد الأدمن برنامج «${enrollment.program.titleAr}» للطالب ${enrollment.user.name} بمقدار ${Math.floor(days)} يومًا`)
    await notify(enrollment.userId, 'GENERAL', `تم تمديد برنامج «${enrollment.program.titleAr}» بمقدار ${Math.floor(days)} يومًا`, 'تم تمديد مدة برنامجك من قبل الإدارة.', '/?view=dashboard')
    return NextResponse.json({ ok: true })
  } catch (e) {
    console.error('admin extend enrollment error', e)
    return NextResponse.json({ error: 'تعذر تنفيذ التمديد' }, { status: 500 })
  }
}
