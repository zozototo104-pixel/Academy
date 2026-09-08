import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyStripeWebhook } from '@/lib/payments'
import { markInvoicePaid } from '@/lib/settle-payment'

// POST /api/payments/webhook/stripe — نقطة استقبال Webhook من Stripe
// بعد إعداد Webhook في لوحة Stripe يشير إلى هذا المسار مع STRIPE_WEBHOOK_SECRET
// يُعتمد السداد تلقائياً عند checkout.session.completed ويُطبق كل آثار التسجيل
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
    if (event?.type === 'checkout.session.completed' || event?.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data?.object || {}
      const invoiceNo = session.client_reference_id || session.metadata?.invoiceNo
      if (invoiceNo) {
        const r = await markInvoicePaid(String(invoiceNo), 'STRIPE', { viaWebhook: true })
        if (!r.ok) return NextResponse.json({ received: true, warning: r.error })
      }
    }
    return NextResponse.json({ received: true })
  } catch (e) {
    console.error('stripe webhook error:', e)
    return NextResponse.json({ error: 'خطأ في معالجة الحدث' }, { status: 500 })
  }
}
