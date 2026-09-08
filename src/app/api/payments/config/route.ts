import { NextResponse } from 'next/server'
import { getGatewayConfig } from '@/lib/payments'

// GET /api/payments/config — توزيع إعدادات الدفع الآمنة على الواجهة
// يخبر الواجهة: وضع الدفع (SANDBOX/LIVE) والمزودين المتاحين فعلياً — بدون أي أسرار
export async function GET() {
  try {
    const cfg = await getGatewayConfig()
    return NextResponse.json({
      mode: cfg.mode,
      providers: {
        STRIPE: !!cfg.stripeSecret,
        PAYPAL: !!(cfg.paypalClientId && cfg.paypalSecret),
      },
      methods: [
        { id: 'PAYMOB', label: 'Paymob — بطاقة / محافظ مصر' },
        { id: 'FAWRY', label: 'فوري Fawry — مراكز الدفع' },
        { id: 'STRIPE', label: 'Stripe — بطاقة دولية' },
        { id: 'PAYPAL', label: 'PayPal — خارج مصر' },
        { id: 'BANK_TRANSFER', label: 'تحويل بنكي — بإيرادات الأكاديمية' },
      ],
    })
  } catch {
    return NextResponse.json({ mode: 'SANDBOX', providers: { STRIPE: false, PAYPAL: false }, methods: [] })
  }
}
