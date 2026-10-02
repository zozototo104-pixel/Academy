import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyStripeWebhook } from '@/lib/payments'
import { markInvoicePaid } from '@/lib/settle-payment'
import { paymentAmountCents } from '@/lib/money'

const STRIPE_SETTLEMENT_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded'])

function stripeInvoiceNo(session: any): string {
  return String(session?.client_reference_id || session?.metadata?.invoiceNo || '').trim()
}

async function validateStripeCheckoutSession(session: any): Promise<{ ok: true; invoiceNo: string } | { ok: false; error: string }> {
  const invoiceNo = stripeInvoiceNo(session)
  if (!invoiceNo) return { ok: false, error: 'حدث Stripe لا يحتوي رقم فاتورة' }
  if (session?.payment_status !== 'paid') return { ok: false, error: 'جلسة Stripe ليست بحالة paid' }

  const amountTotal = Number(session?.amount_total)
  if (!Number.isSafeInteger(amountTotal) || amountTotal <= 0) {
    return { ok: false, error: 'حدث Stripe لا يحتوي مبلغاً صحيحاً' }
  }

  const stripeCurrency = String(session?.currency || '').trim().toUpperCase()
  if (!stripeCurrency) return { ok: false, error: 'حدث Stripe لا يحتوي عملة الدفع' }

  const payment = await db.payment.findUnique({
    where: { invoiceNo },
    select: { invoiceNo: true, amount: true, amountCents: true, currency: true, providerRef: true },
  })
  if (!payment) return { ok: false, error: 'الفاتورة غير موجودة' }

  const invoiceCurrency = String(payment.currency || 'USD').trim().toUpperCase()
  if (stripeCurrency !== invoiceCurrency) {
    return { ok: false, error: 'عملة Stripe لا تطابق عملة الفاتورة' }
  }

  if (amountTotal !== paymentAmountCents(payment)) {
    return { ok: false, error: 'مبلغ Stripe لا يطابق مبلغ الفاتورة' }
  }

  if (payment.providerRef && session?.id && payment.providerRef !== String(session.id)) {
    return { ok: false, error: 'معرف جلسة Stripe لا يطابق جلسة الفاتورة' }
  }

  return { ok: true, invoiceNo: payment.invoiceNo }
}

// POST /api/payments/webhook/stripe — نقطة استقبال Webhook من Stripe
// بعد إعداد Webhook في لوحة Stripe يشير إلى هذا المسار مع STRIPE_WEBHOOK_SECRET
// يُعتمد السداد تلقائياً فقط بعد توقيع حديث + حالة paid + مطابقة المبلغ والعملة
export async function POST(req: NextRequest) {
  try {
    const payload = await req.text()
    const sig = req.headers.get('stripe-signature') || ''
    const rows = await db.setting.findMany({
      where: { key: { in: ['STRIPE_WEBHOOK_SECRET'] } },
    })
    const secret = rows[0]?.value || process.env.STRIPE_WEBHOOK_SECRET || ''
    if (!secret) {
      return NextResponse.json({ error: 'Webhook secret غير مهيأ' }, { status: 503 })
    }
    if (!(await verifyStripeWebhook(payload, sig, secret))) {
      return NextResponse.json({ error: 'توقيع Webhook غير صحيح' }, { status: 400 })
    }
    const event = JSON.parse(payload)
    if (STRIPE_SETTLEMENT_EVENTS.has(event?.type)) {
      const session = event.data?.object || {}
      const validation = await validateStripeCheckoutSession(session)
      if (!validation.ok) {
        console.warn('stripe webhook ignored:', validation.error)
        return NextResponse.json({ received: true, warning: validation.error })
      }
      const r = await markInvoicePaid(validation.invoiceNo, 'STRIPE', { viaWebhook: true })
      if (!r.ok) return NextResponse.json({ received: true, warning: r.error })
    }
    return NextResponse.json({ received: true })
  } catch (e) {
    console.error('stripe webhook error:', e)
    return NextResponse.json({ error: 'خطأ في معالجة الحدث' }, { status: 500 })
  }
}
