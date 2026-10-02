import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { markInvoicePaid } from '@/lib/settle-payment'
import { sandboxPaymentsAllowed, sandboxPaymentsBlockedMessage } from '@/lib/payments'
import { getAdmissionTuitionPlan } from '@/lib/tuition-installments'
import { repairVerifiedStudentRecordOwnership, studentAdmissionOwnershipWhere, studentPaymentOwnershipWhere } from '@/lib/student-record-ownership'

// GET /api/payments — فواتير المستخدم (حسب حسابه أو بريده في طلبات الالتحاق)
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ payments: [] })
    await repairVerifiedStudentRecordOwnership(user).catch(() => null)
    const ownAdmissions = await db.admissionApplication.findMany({
      where: studentAdmissionOwnershipWhere(user),
      select: { id: true, reference: true, program: true, fullName: true },
    })
    const admissionIds = ownAdmissions.map((a) => a.id)
    const payments = await db.payment.findMany({
      where: studentPaymentOwnershipWhere(user),
      orderBy: { createdAt: 'desc' },
    })
    // إثراء البيانات بمرجع الطلب وخطط التقسيط الدراسية
    const refById: Record<string, string> = {}
    for (const a of ownAdmissions) refById[a.id] = a.reference
    const tuitionPlans = (await Promise.all(admissionIds.map((id) => getAdmissionTuitionPlan(id)))).filter(Boolean)
    const approvedInstallmentAdmissions = new Set(tuitionPlans.filter((p: any) => p?.appealStatus === 'APPROVED').map((p: any) => p.admissionId))
    const visiblePayments = payments.filter((p) => !(p.purpose === 'TUITION' && p.status === 'UNPAID' && p.admissionId && approvedInstallmentAdmissions.has(p.admissionId)))
    return NextResponse.json({
      payments: visiblePayments.map((p) => ({ ...p, reference: p.admissionId ? refById[p.admissionId] : null })),
      tuitionPlans,
    })
  } catch (e) {
    console.error('payments GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل المدفوعات' }, { status: 500 })
  }
}

// POST /api/payments — تأكيد سداد فاتورة داخل المنصة (SANDBOX أو طرق المراجعة اليدوية)
// عند وجود مفاتيح مزود حقيقي (Stripe/PayPal) يستخدم الطالب /api/payments/checkout للحصول على رابط الدفع،
// ويُعتمد السداد تلقائياً عبر Webhook — لكن هذا المسار يبقى مدعوماً للطرق اليدوية والتأكيد الآمن
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) {
      return NextResponse.json({ error: 'يجب تسجيل الدخول لإتمام السداد' }, { status: 401 })
    }
    const { invoiceNo, method } = await req.json()
    if (!invoiceNo || !method) {
      return NextResponse.json({ error: 'رقم الفاتورة وطريقة الدفع مطلوبان' }, { status: 400 })
    }
    const payment = await db.payment.findUnique({ where: { invoiceNo } })
    if (!payment) return NextResponse.json({ error: 'الفاتورة غير موجودة' }, { status: 404 })
    if (payment.status === 'PAID') {
      return NextResponse.json({ error: 'الفاتورة مسددة بالفعل' }, { status: 400 })
    }

    // تحقق ملكية صارم: الطالب يملك الفاتورة فقط إذا كان بريد الطلب/الفاتورة يطابق بريده المؤكد.
    const email = user.email.toLowerCase()
    const isPrivileged = user.role === 'ADMIN' || user.role === 'SUPERVISOR'
    let owns = isPrivileged
    if (!owns && payment.admissionId) {
      const app = await db.admissionApplication.findUnique({
        where: { id: payment.admissionId },
        select: { id: true, userId: true, email: true },
      })
      const verifiedEmailOwner = !!app && user.role === 'STUDENT' && Boolean((user as any).emailVerifiedAt) && (app.email || '').trim().toLowerCase() === email
      if (verifiedEmailOwner && app.userId !== user.id) {
        await db.$transaction([
          db.admissionApplication.update({ where: { id: app.id }, data: { userId: user.id } }),
          db.payment.update({ where: { id: payment.id }, data: { userId: user.id } }),
        ]).catch(() => {})
      }
      owns = verifiedEmailOwner
    } else if (!owns && payment.userId) {
      owns = user.role === 'STUDENT' && Boolean((user as any).emailVerifiedAt) && payment.userId === user.id && (!payment.payerEmail || payment.payerEmail.trim().toLowerCase() === email)
    } else if (!owns && payment.agentId) {
      const agent = await db.agentApplication.findUnique({
        where: { id: payment.agentId },
        select: { email: true },
      })
      owns = !!agent && (agent.email || '').trim().toLowerCase() === email
    } else if (!owns && payment.enrollmentId) {
      const enr = await db.enrollment.findUnique({
        where: { id: payment.enrollmentId },
        select: { userId: true },
      })
      owns = !!enr && enr.userId === user.id
    } else {
      // فاتورة بلا رابط مالك معروف — للإدارة فقط
      owns = user.role === 'ADMIN' || user.role === 'SUPERVISOR'
    }
    if (!owns) {
      return NextResponse.json({ error: 'هذه الفاتورة غير مرتبطة بحسابك' }, { status: 403 })
    }

    // فاتورة لها جلسة مزود حقيقي (Stripe/PayPal): لا تُسوّى من هنا أبداً —
    // تُعتمد فقط بعد تحقق خادمي (verify-session أو Webhook موقّع) لمنع تخطي الدفع
    if (payment.providerRef && payment.provider && payment.provider !== 'SANDBOX') {
      return NextResponse.json(
        { error: 'هذه الفاتورة مرتبطة ببوابة دفع حقيقية — يُعتمد سدادها تلقائياً بعد تأكيد المزود (أو عبر زر التحقق بعد العودة من البوابة)' },
        { status: 400 }
      )
    }

    if (!sandboxPaymentsAllowed() && user.role === 'STUDENT') {
      return NextResponse.json({ error: sandboxPaymentsBlockedMessage() }, { status: 403 })
    }

    const r = await markInvoicePaid(String(invoiceNo), String(method), {
      actor: { id: user.id, name: user.name },
    })
    if (!r.ok) return NextResponse.json({ error: r.error || 'تعذر إتمام الدفع' }, { status: 400 })

    return NextResponse.json({ ok: true, payment: r.payment, receiptNo: r.receiptNo })
  } catch (e) {
    console.error('payments POST error:', e)
    return NextResponse.json({ error: 'تعذر إتمام الدفع' }, { status: 500 })
  }
}
