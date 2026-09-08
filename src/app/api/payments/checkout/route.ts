import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { createProviderCheckout } from '@/lib/payments'

// POST /api/payments/checkout — إنشاء جلسة دفع حقيقية لدى المزود
// مع STRIPE_SECRET_KEY أو مفاتيح PayPal يُعاد رابط دفع حقيقي (redirectUrl)
// بدون مفاتيح يعيد وضع SANDBOX ليكتمل السداد عبر تأكيد آمن داخل المنصة
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    const { invoiceNo, method } = await req.json()
    if (!invoiceNo || !method) {
      return NextResponse.json({ error: 'رقم الفاتورة وطريقة الدفع مطلوبان' }, { status: 400 })
    }
    const payment = await db.payment.findUnique({ where: { invoiceNo } })
    if (!payment) return NextResponse.json({ error: 'الفاتورة غير موجودة' }, { status: 404 })
    if (payment.status === 'PAID') {
      return NextResponse.json({ error: 'الفاتورة مسددة بالفعل' }, { status: 400 })
    }

    const origin = req.headers.get('origin') || new URL(req.url).origin
    const result = await createProviderCheckout({
      method: String(method),
      invoiceNo: payment.invoiceNo,
      description: payment.description,
      amountUsd: payment.amount,
      payerEmail: payment.payerEmail || user?.email || null,
      origin,
    })

    if (result.providerRef || result.provider) {
      await db.payment.update({
        where: { id: payment.id },
        data: {
          provider: result.provider || 'SANDBOX',
          providerRef: result.providerRef || null,
          checkoutUrl: result.redirectUrl || null,
          method: String(method),
          userId: payment.userId || user?.id || null,
        },
      })
    }

    if (!result.ok) {
      return NextResponse.json({ error: result.error || 'تعذر بدء الدفع لدى المزود' }, { status: 502 })
    }

    return NextResponse.json({
      ok: true,
      mode: result.provider === 'SANDBOX' ? 'SANDBOX' : 'LIVE',
      provider: result.provider || 'SANDBOX',
      redirectUrl: result.redirectUrl || null,
    })
  } catch (e) {
    console.error('payments checkout error:', e)
    return NextResponse.json({ error: 'تعذر بدء عملية الدفع' }, { status: 500 })
  }
}
