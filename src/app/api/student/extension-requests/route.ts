import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/student/extension-requests — طلب تمديد بأسباب مقنعة.
// لا موافقة تلقائية: يبقى معلقًا حتى يقرر الأدمن.
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول أولًا' }, { status: 401 })
    const body = await req.json().catch(() => ({}))
    const enrollmentId = String(body.enrollmentId || '')
    const requestedDays = Number(body.requestedDays)
    const reason = String(body.reason || '').trim()
    if (!enrollmentId) return NextResponse.json({ error: 'التسجيل مطلوب' }, { status: 400 })
    if (!Number.isFinite(requestedDays) || requestedDays < 1 || requestedDays > 365) {
      return NextResponse.json({ error: 'عدد أيام التمديد يجب أن يكون بين 1 و 365' }, { status: 400 })
    }
    if (reason.length < 10 || reason.length > 2000) {
      return NextResponse.json({ error: 'اكتب سببًا مقنعًا (10 أحرف على الأقل)' }, { status: 400 })
    }
    const enrollment = await db.enrollment.findFirst({ where: { id: enrollmentId, userId: user.id } })
    if (!enrollment) return NextResponse.json({ error: 'التسجيل غير موجود' }, { status: 403 })
    if (!['ACTIVE', 'SUPERVISOR_ASSIGNED', 'EXPIRED'].includes(enrollment.status)) {
      return NextResponse.json({ error: 'لا يمكن طلب تمديد لهذا التسجيل حاليًا' }, { status: 400 })
    }
    const existing = await db.programExtensionRequest.findFirst({ where: { enrollmentId, status: 'PENDING' } })
    if (existing) return NextResponse.json({ error: 'لديك طلب تمديد معلق لهذا البرنامج بالفعل' }, { status: 409 })
    const created = await db.programExtensionRequest.create({
      data: { enrollmentId, userId: user.id, programId: enrollment.programId, requestedDays: Math.floor(requestedDays), reason },
    })
    return NextResponse.json({ ok: true, request: created })
  } catch (e) {
    console.error('extension request error', e)
    return NextResponse.json({ error: 'تعذر إرسال طلب التمديد' }, { status: 500 })
  }
}
