import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { markInvoicePaid } from '@/lib/settle-payment'

// GET /api/payments — فواتير المستخدم (حسب حسابه أو بريده في طلبات الالتحاق)
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ payments: [] })
    const ownAdmissions = await db.admissionApplication.findMany({
      where: { OR: [{ userId: user.id }, { email: user.email }] },
      select: { id: true, reference: true, program: true, fullName: true },
    })
    const admissionIds = ownAdmissions.map((a) => a.id)
    const payments = await db.payment.findMany({
      where: { OR: [{ userId: user.id }, { admissionId: { in: admissionIds } }, { payerEmail: user.email }] },
      orderBy: { createdAt: 'desc' },
    })
    // إثراء البيانات بمرجع الطلب
    const refById: Record<string, string> = {}
    for (const a of ownAdmissions) refById[a.id] = a.reference
    return NextResponse.json({
      payments: payments.map((p) => ({ ...p, reference: p.admissionId ? refById[p.admissionId] : null })),
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

    // تحقق ملكية صارم: الفاتورة يجب أن تخص المستخدم الحالي (حسابه أو بريده في الطلب/التسجيل/الوكالة)
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
      const agent = await db.agentApplication.findUnique({
        where: { id: payment.agentId },
        select: { email: true },
      })
      owns = !!agent && (agent.email || '').trim().toLowerCase() === email
    } else if (payment.enrollmentId) {
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
