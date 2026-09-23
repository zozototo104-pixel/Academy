import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { nextInvoiceNo } from '@/lib/settings'
import { getAdmissionTuitionPlan, roundMoney } from '@/lib/tuition-installments'

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json()
    const admissionId = String(body?.admissionId || '')
    const amount = roundMoney(Number(body?.amount || 0))
    if (!admissionId || amount <= 0) {
      return NextResponse.json({ error: 'حدد الطلب والمبلغ' }, { status: 400 })
    }

    const app = await db.admissionApplication.findFirst({
      where: { id: admissionId, OR: [{ userId: user.id }, { email: user.email }] },
      select: {
        id: true,
        userId: true,
        email: true,
        fullName: true,
        reference: true,
        program: true,
        status: true,
      },
    })
    if (!app) return NextResponse.json({ error: 'الطلب غير مرتبط بحسابك' }, { status: 403 })

    const plan = await getAdmissionTuitionPlan(app.id)
    if (!plan) return NextResponse.json({ error: 'تعذر قراءة خطة الرسوم' }, { status: 400 })
    if (plan.appealStatus !== 'APPROVED') {
      return NextResponse.json({ error: 'الدفع الجزئي متاح فقط بعد موافقة الإدارة على التماس التقسيط' }, { status: 400 })
    }
    if (plan.remainingTuition <= 0) {
      return NextResponse.json({ error: 'لا توجد رسوم متبقية' }, { status: 400 })
    }

    const pendingInstallments = await db.payment.findMany({
      where: { admissionId: app.id, purpose: 'TUITION_INSTALLMENT', status: 'UNPAID' },
      select: { amount: true, invoiceNo: true },
    })
    if (pendingInstallments.length > 0) {
      return NextResponse.json({ error: `توجد فاتورة دفعة غير مسددة بالفعل (${pendingInstallments[0].invoiceNo}). ادفعها أو راجع الإدارة قبل إنشاء دفعة جديدة.` }, { status: 400 })
    }
    const pendingAmount = pendingInstallments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
    const availableToInvoice = roundMoney(Math.max(0, plan.remainingTuition - pendingAmount))
    const requiredInitialRemaining = plan.approvedInitialAmount !== null && app.status === 'AWAITING_TUITION'
      ? roundMoney(Math.max(0, plan.approvedInitialAmount - plan.paidTuition))
      : 0
    if (requiredInitialRemaining > 0 && Math.abs(amount - requiredInitialRemaining) > 0.009) {
      return NextResponse.json({ error: `يجب أن تكون الدفعة الأولى المعتمدة ${requiredInitialRemaining}$ حتى يتم تفعيل التسجيل الدراسي.` }, { status: 400 })
    }
    if (amount > availableToInvoice) {
      return NextResponse.json({ error: `المبلغ يتجاوز المتبقي غير المفوتر: ${availableToInvoice}import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { nextInvoiceNo } from '@/lib/settings'
import { getAdmissionTuitionPlan, roundMoney } from '@/lib/tuition-installments'

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json()
    const admissionId = String(body?.admissionId || '')
    const amount = roundMoney(Number(body?.amount || 0))
    if (!admissionId || amount <= 0) {
      return NextResponse.json({ error: 'حدد الطلب والمبلغ' }, { status: 400 })
    }

    const app = await db.admissionApplication.findFirst({
      where: { id: admissionId, OR: [{ userId: user.id }, { email: user.email }] },
      select: {
        id: true,
        userId: true,
        email: true,
        fullName: true,
        reference: true,
        program: true,
        status: true,
      },
    })
    if (!app) return NextResponse.json({ error: 'الطلب غير مرتبط بحسابك' }, { status: 403 })

    const plan = await getAdmissionTuitionPlan(app.id)
    if (!plan) return NextResponse.json({ error: 'تعذر قراءة خطة الرسوم' }, { status: 400 })
    if (plan.appealStatus !== 'APPROVED') {
      return NextResponse.json({ error: 'الدفع الجزئي متاح فقط بعد موافقة الإدارة على التماس التقسيط' }, { status: 400 })
    }
    if (plan.remainingTuition <= 0) {
      return NextResponse.json({ error: 'لا توجد رسوم متبقية' }, { status: 400 })
    }

 }, { status: 400 })
    }

    const payment = await db.payment.create({
      data: {
        invoiceNo: await nextInvoiceNo(),
        purpose: 'TUITION_INSTALLMENT',
        description: `دفعة جزئية من الرسوم الدراسية — ${app.program}`,
        amount,
        currency: 'USD',
        status: 'UNPAID',
        admissionId: app.id,
        userId: app.userId || user.id,
        payerName: app.fullName,
        payerEmail: app.email,
      },
    })

    return NextResponse.json({ ok: true, payment })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    console.error('installment payment POST error:', e)
    return NextResponse.json({ error: 'تعذر إنشاء دفعة جزئية' }, { status: 500 })
  }
}
