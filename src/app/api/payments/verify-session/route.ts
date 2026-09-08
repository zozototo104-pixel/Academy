import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { getGatewayConfig, verifyStripeSessionPaid, capturePaypalOrder } from '@/lib/payments'
import { markInvoicePaid } from '@/lib/settle-payment'

// GET /api/payments/verify-session?invoiceNo=... — تحقق خادمي من السداد الفعلي لدى المزود
// يُستدعى عند عودة الطالب من بوابة Stripe/PayPal — لا ثقة أبداً بتأكيد من المتصفح
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    const invoiceNo = req.nextUrl.searchParams.get('invoiceNo')
    if (!invoiceNo) return NextResponse.json({ error: 'رقم الفاتورة مطلوب' }, { status: 400 })

    const payment = await db.payment.findUnique({ where: { invoiceNo } })
    if (!payment) return NextResponse.json({ error: 'الفاتورة غير موجودة' }, { status: 404 })

    // ملكية الفاتورة للمستخدم الحالي
    const email = user.email.toLowerCase()
    let owns = false
    if (payment.userId) owns = payment.userId === user.id
    else if (payment.admissionId) {
      const app = await db.admissionApplication.findUnique({
        where: { id: payment.admissionId },
        select: { userId: true, email: true },
      })
      owns = !!app && (app.userId === user.id || (app.email || '').trim().toLowerCase() === email)
    } else if (payment.agentId) {
      const agent = await db.agentApplication.findUnique({ where: { id: payment.agentId }, select: { email: true } })
      owns = !!agent && (agent.email || '').trim().toLowerCase() === email
    } else if (payment.enrollmentId) {
      const enr = await db.enrollment.findUnique({ where: { id: payment.enrollmentId }, select: { userId: true } })
      owns = !!enr && enr.userId === user.id
    }
    if (!owns) return NextResponse.json({ error: 'هذه الفاتورة غير مرتبطة بحسابك' }, { status: 403 })

    if (payment.status === 'PAID') {
      return NextResponse.json({ ok: true, status: 'PAID', receiptNo: payment.receiptNo })
    }

    // فاتورة بلا جلسة مزود حقيقي (SANDBOX أو طريقة يدوية) — تُسدد من مسار التأكيد الداخلي
    if (!payment.providerRef || !payment.provider || payment.provider === 'SANDBOX') {
      return NextResponse.json({ ok: false, status: payment.status, note: 'NO_PROVIDER_SESSION' })
    }

    const cfg = await getGatewayConfig()
    const v =
      payment.provider === 'STRIPE'
        ? await verifyStripeSessionPaid(payment.providerRef, cfg)
        : await capturePaypalOrder(payment.providerRef, cfg)

    if (v.paid) {
      const r = await markInvoicePaid(payment.invoiceNo, payment.provider, {
        viaWebhook: false,
        actor: { id: user.id, name: user.name },
      })
      if (!r.ok) return NextResponse.json({ error: r.error || 'تعذر تسوية الفاتورة' }, { status: 400 })
      return NextResponse.json({ ok: true, status: 'PAID', receiptNo: r.receiptNo })
    }

    return NextResponse.json({ ok: false, status: 'UNPAID', note: v.error || 'لم يؤكد المزود السداد بعد — إن أكملت الدفع فسيُعتمد تلقائياً عبر Webhook' })
  } catch (e) {
    console.error('verify-session error:', e)
    return NextResponse.json({ error: 'تعذر التحقق من حالة الدفع' }, { status: 500 })
  }
}
