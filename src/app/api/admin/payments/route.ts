import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { markInvoicePaid } from '@/lib/settle-payment'
import { notify, audit } from '@/lib/notify'

// GET /api/admin/payments — كل الفواتير والمستحقات (للإدارة)
export async function GET() {
  try {
    await requireAdmin()
    const payments = await db.payment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: {
        admission: { select: { reference: true, fullName: true, country: true, program: true } },
      },
    })
    const totals = {
      collected: payments.filter((p) => p.status === 'PAID').reduce((s, p) => s + p.amount, 0),
      pending: payments.filter((p) => p.status === 'UNPAID').reduce((s, p) => s + p.amount, 0),
      count: payments.length,
      paidCount: payments.filter((p) => p.status === 'PAID').length,
    }
    return NextResponse.json({ payments, totals })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin payments GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل المدفوعات' }, { status: 500 })
  }
}

// PATCH /api/admin/payments — تأكيد دفعة يدوية (تحويل بنكي/واتساب)
// يستخدم markInvoicePaid كي تُطبَّق كل آثار السداد رسمياً: الإيصال + تحويل حالة الطلب + تفعيل التسجيل + البريد
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { id } = await req.json()
    const payment = await db.payment.findUnique({ where: { id } })
    if (!payment) return NextResponse.json({ error: 'الفاتورة غير موجودة' }, { status: 404 })
    if (payment.status === 'PAID') return NextResponse.json({ ok: true, payment })

    const r = await markInvoicePaid(payment.invoiceNo, 'BANK_TRANSFER', {
      actor: { id: admin.id, name: admin.name },
    })
    if (!r.ok) return NextResponse.json({ error: r.error || 'تعذر تأكيد السداد' }, { status: 400 })

    await audit(admin, 'CONFIRM_PAYMENT', 'Payment', id, `${r.receiptNo} — ${payment.description} (${payment.amount}$) [تأكيد إداري يدوي]`)
    return NextResponse.json({ ok: true, payment: r.payment, receiptNo: r.receiptNo })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin payments PATCH error:', e)
    return NextResponse.json({ error: 'تعذر التأكيد' }, { status: 500 })
  }
}
