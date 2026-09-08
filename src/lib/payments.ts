import { db } from '@/lib/db'

// ===== بوابات الدفع الحقيقية =====
// البنية: إعدادات المزودين تُدار من لوحة الإدارة (تبويب «البريد والدفع») أو من متغيرات البيئة.
// عند إدخال المفاتيح الفعلية وتفعيل وضع LIVE يعمل الدفع الحقيقي عبر:
//  - Stripe Checkout (بطاقات دولية) — REST API مباشرة بلا حاجة لأي SDK
//  - PayPal Orders v2 (حسابات PayPal) — REST API مباشرة
//  - Paymob/فوري/تحويل بنكي — تعليمات سداد + مراجعة الإدارة (كما هو)
// بدون مفاتيح: وضع SANDBOX (محاكاة آمنة داخل المنصة) مع شارة واضحة للطالب.

export type ProviderId = 'STRIPE' | 'PAYPAL' | 'SANDBOX'

export interface PaymentGatewayConfig {
  mode: 'SANDBOX' | 'LIVE'
  stripeSecret: string
  stripeWebhookSecret: string
  paypalClientId: string
  paypalSecret: string
  paypalApiBase: string
}

function env(name: string): string {
  try {
    return process.env[name] || ''
  } catch {
    return ''
  }
}

export async function getGatewayConfig(): Promise<PaymentGatewayConfig> {
  const keys = ['PAYMENT_MODE', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'PAYPAL_API_BASE']
  const rows = await db.setting.findMany({ where: { key: { in: keys } } })
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value
  const stripeSecret = map.STRIPE_SECRET_KEY || env('STRIPE_SECRET_KEY') || ''
  const paypalClientId = map.PAYPAL_CLIENT_ID || env('PAYPAL_CLIENT_ID') || ''
  const paypalSecret = map.PAYPAL_SECRET || env('PAYPAL_SECRET') || ''
  const paypalApiBase = (map.PAYPAL_API_BASE || env('PAYPAL_API_BASE') || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '')
  const modeSetting = map.PAYMENT_MODE || env('PAYMENT_MODE') || 'SANDBOX'
  const hasRealProviders = !!(stripeSecret || (paypalClientId && paypalSecret))
  const mode: 'SANDBOX' | 'LIVE' = modeSetting === 'LIVE' && hasRealProviders ? 'LIVE' : 'SANDBOX'
  return {
    mode,
    stripeSecret,
    stripeWebhookSecret: map.STRIPE_WEBHOOK_SECRET || env('STRIPE_WEBHOOK_SECRET') || '',
    paypalClientId,
    paypalSecret,
    paypalApiBase,
  }
}

// المزود المناسب لكل طريقة دفع يختارها الطالب
export function providerForMethod(method: string, cfg: PaymentGatewayConfig): ProviderId {
  if (method === 'STRIPE' && cfg.stripeSecret) return 'STRIPE'
  if (method === 'PAYPAL' && cfg.paypalClientId && cfg.paypalSecret) return 'PAYPAL'
  return 'SANDBOX'
}

export interface CheckoutResult {
  ok: boolean
  redirectUrl?: string
  providerRef?: string
  provider?: ProviderId
  error?: string
}

// ===== Stripe Checkout Session (REST مباشر) =====
export async function createStripeCheckout(params: {
  invoiceNo: string
  description: string
  amountUsd: number
  payerEmail?: string | null
  origin: string
  cfg: PaymentGatewayConfig
}): Promise<CheckoutResult> {
  try {
    const body = new URLSearchParams()
    body.set('mode', 'payment')
    body.set('success_url', `${params.origin}/?view=dashboard&paid=${encodeURIComponent(params.invoiceNo)}`)
    body.set('cancel_url', `${params.origin}/?view=dashboard&canceled=${encodeURIComponent(params.invoiceNo)}`)
    body.set('client_reference_id', params.invoiceNo)
    body.set('customer_email', params.payerEmail || '')
    body.set('line_items[0][quantity]', '1')
    body.set('line_items[0][price_data][currency]', 'usd')
    body.set('line_items[0][price_data][unit_amount]', String(Math.round(params.amountUsd * 100)))
    body.set('line_items[0][price_data][product_data][name]', params.description.slice(0, 120))
    body.set('metadata[invoiceNo]', params.invoiceNo)

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.cfg.stripeSecret}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })
    const data: any = await res.json()
    if (!res.ok || !data?.url) {
      return { ok: false, error: data?.error?.message || 'تعذر إنشاء جلسة الدفع لدى Stripe' }
    }
    return { ok: true, redirectUrl: data.url, providerRef: data.id, provider: 'STRIPE' }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

// ===== PayPal Orders v2 (REST مباشر) =====
async function paypalAccessToken(cfg: PaymentGatewayConfig): Promise<string | null> {
  try {
    const auth = Buffer.from(`${cfg.paypalClientId}:${cfg.paypalSecret}`).toString('base64')
    const res = await fetch(`${cfg.paypalApiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    })
    const data: any = await res.json()
    return data?.access_token || null
  } catch {
    return null
  }
}

export async function createPaypalOrder(params: {
  invoiceNo: string
  description: string
  amountUsd: number
  origin: string
  cfg: PaymentGatewayConfig
}): Promise<CheckoutResult> {
  try {
    const token = await paypalAccessToken(params.cfg)
    if (!token) return { ok: false, error: 'تعذر الاتصال بـ PayPal — تحقق من المفاتيح' }
    const res = await fetch(`${params.cfg.paypalApiBase}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            custom_id: params.invoiceNo,
            description: params.description.slice(0, 127),
            amount: { currency_code: 'USD', value: params.amountUsd.toFixed(2) },
          },
        ],
        application_context: {
          brand_name: 'AACT — الأكاديمية الأمريكية',
          locale: 'ar-EG',
          user_action: 'PAY_NOW',
          return_url: `${params.origin}/?view=dashboard&paid=${encodeURIComponent(params.invoiceNo)}`,
          cancel_url: `${params.origin}/?view=dashboard&canceled=${encodeURIComponent(params.invoiceNo)}`,
        },
      }),
    })
    const data: any = await res.json()
    const approve = (data?.links || []).find((l: any) => l.rel === 'approve')?.href
    if (!res.ok || !approve) {
      return { ok: false, error: data?.message || 'تعذر إنشاء الطلب لدى PayPal' }
    }
    return { ok: true, redirectUrl: approve, providerRef: data.id, provider: 'PAYPAL' }
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) }
  }
}

export async function createProviderCheckout(params: {
  method: string
  invoiceNo: string
  description: string
  amountUsd: number
  payerEmail?: string | null
  origin: string
}): Promise<CheckoutResult> {
  const cfg = await getGatewayConfig()
  const provider = providerForMethod(params.method, cfg)
  if (provider === 'STRIPE') {
    return createStripeCheckout({ ...params, cfg })
  }
  if (provider === 'PAYPAL') {
    return createPaypalOrder({ ...params, cfg })
  }
  return { ok: true, provider: 'SANDBOX', providerRef: `SBX-${Date.now()}` }
}

// ===== التحقق الخادمي من السداد الفعلي لدى المزود =====
// يُستخدم عند العودة من بوابة الدفع (success_url) قبل اعتماد الفاتورة — لا ثقة بالمتصفح

export async function verifyStripeSessionPaid(sessionId: string, cfg: PaymentGatewayConfig): Promise<{ paid: boolean; error?: string }> {
  try {
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${cfg.stripeSecret}` },
    })
    const data: any = await res.json()
    if (!res.ok) return { paid: false, error: data?.error?.message || 'تعذر التحقق من الجلسة لدى Stripe' }
    return { paid: data?.payment_status === 'paid' || data?.status === 'complete' }
  } catch (e: any) {
    return { paid: false, error: String(e?.message || e) }
  }
}

export async function capturePaypalOrder(orderId: string, cfg: PaymentGatewayConfig): Promise<{ paid: boolean; error?: string }> {
  try {
    const token = await paypalAccessToken(cfg)
    if (!token) return { paid: false, error: 'تعذر الاتصال بـ PayPal' }
    // محاولة الالتقاط (إن سبق الالتقاط نتعامل معها كنجاح) ثم قراءة حالة الطلب
    let res = await fetch(`${cfg.paypalApiBase}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    })
    let data: any = await res.json().catch(() => ({}))
    if (!res.ok && data?.details?.[0]?.issue !== 'ORDER_ALREADY_CAPTURED') {
      return { paid: false, error: data?.message || 'تعذر التقاط الدفعة من PayPal' }
    }
    res = await fetch(`${cfg.paypalApiBase}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    data = await res.json().catch(() => ({}))
    return { paid: data?.status === 'COMPLETED' }
  } catch (e: any) {
    return { paid: false, error: String(e?.message || e) }
  }
}

// ===== التحقق من توقيع Webhook الخاص بـ Stripe =====
// تنفيذ موثوق للتحقق (t=timestamp,v1=signature) بـ HMAC-SHA256 دون الاعتماد على SDK
export async function verifyStripeWebhook(payload: string, sigHeader: string, secret: string): Promise<boolean> {
  try {
    if (!sigHeader || !secret) return false
    const parts = sigHeader.split(',').reduce<Record<string, string[]>>((acc, p) => {
      const [k, v] = p.split('=')
      if (k && v) (acc[k] = acc[k] || []).push(v)
      return acc
    }, {})
    const t = parts.t?.[0]
    const v1List = parts.v1 || []
    if (!t || v1List.length === 0) return false
    const { createHmac, timingSafeEqual } = await import('crypto')
    const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')
    const expectedBuf = Buffer.from(expected, 'hex')
    return v1List.some((v1) => {
      try {
        const given = Buffer.from(v1, 'hex')
        return given.length === expectedBuf.length && timingSafeEqual(given, expectedBuf)
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}
