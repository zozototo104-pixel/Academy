import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { notify } from '@/lib/notify'
import { getAdmissionTuitionPlan, roundMoney } from '@/lib/tuition-installments'

export async function GET() {
  try {
    const user = await requireUser()
    const appeals = await db.tuitionInstallmentAppeal.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({ appeals })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    console.error('tuition appeals GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الالتماسات' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json()
    const admissionId = String(body?.admissionId || '')
    const requestedInitialAmount = roundMoney(Number(body?.requestedInitialAmount || 0))
    const proposedSchedule = typeof body?.proposedSchedule === 'string' ? body.proposedSchedule.trim().slice(0, 1500) : ''
    const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 1500) : ''

    if (!admissionId) return NextResponse.json({ error: 'رقم الطلب مطلوب' }, { status: 400 })
    if (requestedInitialAmount <= 0) return NextResponse.json({ error: 'أدخل مبلغ الدفعة الأولى المقترحة' }, { status: 400 })

    const app = await db.admissionApplication.findFirst({
      where: { id: admissionId, OR: [{ userId: user.id }, { email: user.email }] },
      include: { programRef: { select: { id: true } } },
    })
    if (!app) return NextResponse.json({ error: 'الطلب غير مرتبط بحسابك' }, { status: 403 })
    if (!['AWAITING_TUITION', 'SUPERVISOR_ASSIGNED', 'THESIS'].includes(app.status)) {
      return NextResponse.json({ error: 'يمكن تقديم التماس التقسيط بعد موافقة الإدارة وظهور فاتورة الرسوم الدراسية' }, { status: 400 })
    }

    const plan = await getAdmissionTuitionPlan(app.id)
    if (!plan || plan.totalTuition <= 0) return NextResponse.json({ error: 'لا توجد فاتورة رسوم دراسية قابلة للتقسيط لهذا الطلب' }, { status: 400 })
    if (requestedInitialAmount >= plan.remainingTuition) return NextResponse.json({ error: 'المبلغ المقترح يساوي أو يتجاوز المتبقي؛ يمكنك سداد الفاتورة مباشرة' }, { status: 400 })

    const existing = await db.tuitionInstallmentAppeal.findFirst({
      where: { admissionId: app.id, status: { in: ['PENDING', 'APPROVED'] } },
      orderBy: { createdAt: 'desc' },
    })
    if (existing) return NextResponse.json({ error: existing.status === 'APPROVED' ? 'يوجد طلب تقسيط معتمد بالفعل' : 'يوجد التماس تقسيط قيد الدراسة بالفعل' }, { status: 400 })

    const appeal = await db.tuitionInstallmentAppeal.create({
      data: {
        admissionId: app.id,
        userId: user.id,
        programId: app.programId || null,
        enrollmentId: app.enrollment?.id || null,
        requestedInitialAmount,
        proposedSchedule: proposedSchedule || null,
        reason: reason || null,
      },
    })

    const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
    for (const admin of admins) {
      await notify(
        admin.id,
        'PAYMENT',
        'التماس تقسيط رسوم دراسية بانتظار القرار',
        `${app.fullName} قدم التماساً لدفع ${requestedInitialAmount}$ الآن من أصل ${plan.totalTuition}$ لطلب ${app.reference}.`,
        'admin'
      ).catch(() => {})
    }

    return NextResponse.json({ ok: true, appeal })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    console.error('tuition appeals POST error:', e)
    return NextResponse.json({ error: 'تعذر إرسال الالتماس' }, { status: 500 })
  }
}
