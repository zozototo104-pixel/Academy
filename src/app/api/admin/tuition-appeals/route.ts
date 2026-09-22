import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { notify, audit } from '@/lib/notify'
import { getAdmissionTuitionPlan, roundMoney } from '@/lib/tuition-installments'

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const id = String(body?.id || '')
    const decision = String(body?.decision || '').toUpperCase()
    if (!id || !['APPROVE', 'REJECT'].includes(decision)) {
      return NextResponse.json({ error: 'معرف الالتماس والقرار مطلوبان' }, { status: 400 })
    }

    const appeal = await db.tuitionInstallmentAppeal.findUnique({ where: { id } })
    if (!appeal) return NextResponse.json({ error: 'الالتماس غير موجود' }, { status: 404 })
    if (appeal.status !== 'PENDING') return NextResponse.json({ error: 'تم اتخاذ قرار على هذا الالتماس سابقاً' }, { status: 400 })

    const app = await db.admissionApplication.findUnique({ where: { id: appeal.admissionId } })
    if (!app) return NextResponse.json({ error: 'طلب الالتحاق غير موجود' }, { status: 404 })
    const plan = await getAdmissionTuitionPlan(app.id)
    if (!plan || plan.totalTuition <= 0) return NextResponse.json({ error: 'لا توجد رسوم دراسية لهذا الطلب' }, { status: 400 })

    if (decision === 'REJECT') {
      const rejected = await db.tuitionInstallmentAppeal.update({
        where: { id },
        data: {
          status: 'REJECTED',
          adminNote: typeof body?.adminNote === 'string' ? body.adminNote.trim().slice(0, 1500) : null,
          decidedById: admin.id,
          decidedAt: new Date(),
        },
      })
      if (app.userId) {
        await notify(app.userId, 'PAYMENT', 'تم رفض التماس تقسيط الرسوم', rejected.adminNote || 'يرجى سداد الرسوم الدراسية وفق الفاتورة الأصلية لاستكمال الإجراءات.', 'dashboard').catch(() => {})
      }
      await audit({ id: admin.id, name: admin.name }, 'TUITION_APPEAL_REJECTED', 'TuitionInstallmentAppeal', id, `${app.reference}`)
      return NextResponse.json({ ok: true, appeal: rejected })
    }

    const approvedInitialAmount = roundMoney(Number(body?.approvedInitialAmount || appeal.requestedInitialAmount || 0))
    const firstSemesterRequiredAmount = roundMoney(Number(body?.firstSemesterRequiredAmount || plan.totalTuition / 2))
    const finalRequiredAmount = roundMoney(Number(body?.finalRequiredAmount || plan.totalTuition))
    if (approvedInitialAmount <= 0) return NextResponse.json({ error: 'حدد الدفعة الأولى المقبولة' }, { status: 400 })
    if (firstSemesterRequiredAmount < approvedInitialAmount) return NextResponse.json({ error: 'مبلغ فتح امتحان الفصل الأول يجب ألا يقل عن الدفعة الأولى' }, { status: 400 })
    if (finalRequiredAmount < firstSemesterRequiredAmount) return NextResponse.json({ error: 'مبلغ فتح الفصل الثاني يجب ألا يقل عن متطلب الفصل الأول' }, { status: 400 })

    const approved = await db.tuitionInstallmentAppeal.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedInitialAmount,
        firstSemesterRequiredAmount,
        finalRequiredAmount,
        adminNote: typeof body?.adminNote === 'string' ? body.adminNote.trim().slice(0, 1500) : null,
        decidedById: admin.id,
        decidedAt: new Date(),
      },
    })

    if (app.userId) {
      await notify(
        app.userId,
        'PAYMENT',
        'تم قبول التماس تقسيط الرسوم الدراسية',
        `يمكنك الآن دفع دفعات جزئية. يجب سداد ${firstSemesterRequiredAmount}$ قبل فتح امتحان الفصل الأول، وسداد ${finalRequiredAmount}$ قبل فتح امتحان الفصل الثاني.`,
        'dashboard'
      ).catch(() => {})
    }
    await audit({ id: admin.id, name: admin.name }, 'TUITION_APPEAL_APPROVED', 'TuitionInstallmentAppeal', id, `${app.reference} — initial ${approvedInitialAmount}$ / sem1 ${firstSemesterRequiredAmount}$ / final ${finalRequiredAmount}$`)

    return NextResponse.json({ ok: true, appeal: approved })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'غير مصرح' }, { status: 401 })
    console.error('admin tuition appeals PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تحديث الالتماس' }, { status: 500 })
  }
}
