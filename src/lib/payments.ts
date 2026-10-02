import { db } from '@/lib/db'
import { centsToDollars, dollarsToCents } from '@/lib/money'

// ===== بوابات الدفع الحقيقية =====
// البنية: إعدادات المزودين تُدار من لوحة الإدارة (تبويب «البريد والدفع») أو من متغيرات البيئة.
// عند إدخال المفاتيح الفعلية وتفعيل وضع LIVE يعمل الدفع الحقيقي عبر:
//  - Stripe Checkout (بطاقات دولية) — REST API مباشرة بلا حاجة لأي SDK
//  - PayPal Orders v2 (حسابات PayPal) — REST API مباشرة
//  - Paymob/فوري/تحويل بنكي — خيارات ظاهرة للطالب لكنها مقفلة حتى تُربط كبوابات/إجراءات حقيقية.
// بدون مفاتيح live: لا يُعتمد الدفع التجريبي في الإنتاج إلا إذا سُمحت SANDBOX صراحة لبيئة اختبار.

export type ProviderId = 'STRIPE' | 'PAYPAL' | 'SANDBOX'

export type PaymentMethodId = 'PAYMOB' | 'FAWRY' | 'STRIPE' | 'PAYPAL' | 'USDT' | 'BANK_TRANSFER' | 'DIRECT_PAYMENT'

export interface PaymentMethodStatus {
  id: PaymentMethodId
  label: string
  enabled: boolean
  configured: boolean
  kind: 'gateway' | 'manual' | 'placeholder'
  reason?: string
}

export interface PaymentDiagnostics {
  mode: 'SANDBOX' | 'LIVE'
  sandboxAllowed: boolean
  stripeConfigured: boolean
  stripeWebhookConfigured: boolean
  stripeKeyKind: 'live' | 'test' | 'unknown' | 'missing'
  paypalConfigured: boolean
  paypalApiBase: string
  paypalBaseKind: 'live' | 'sandbox' | 'custom' | 'missing'
  usdtConfigured?: boolean
  usdtNetwork?: string
  usdtBinancePayUserId?: string
  usdtBinancePayQrImageUrl?: string
  binanceDownloadUrl?: string
  binancePayUrl?: string
  trueGatewayCount: number
  warnings: string[]
  errors: string[]
  methods: PaymentMethodStatus[]
}

export interface PaymentGatewayConfig {
  mode: 'SANDBOX' | 'LIVE'
  stripeSecret: string
  stripeWebhookSecret: string
  paypalClientId: string
  paypalSecret: string
  paypalApiBase: string
  usdtWalletAddress: string
  usdtNetwork: string
  usdtInstructions: string
  usdtBinancePayUserId: string
  usdtBinancePayQrImageUrl: string
  binanceDownloadUrl: string
  binancePayWebUrl: string
  binancePayGuideUrl: string
}

function env(name: string): string {
  try {
    return process.env[name] || ''
  } catch {
    return ''
  }
}

function isTruthy(value: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function isProductionRuntime(): boolean {
  const vercelEnv = env('VERCEL_ENV')
  if (vercelEnv) return vercelEnv === 'production'
  if (isTruthy(env('CI')) || isTruthy(env('GITHUB_ACTIONS'))) return false
  return env('NODE_ENV') === 'production'
}

export function sandboxPaymentsAllowed(): boolean {
  if (!isProductionRuntime()) return true
  return isTruthy(env('AACT_ALLOW_SANDBOX_PAYMENTS_IN_PRODUCTION'))
}

export function sandboxPaymentsBlockedMessage(): string {
  return 'الدفع التجريبي SANDBOX معطّل في بيئة الإنتاج. استخدم بوابة دفع حقيقية أو سجّل طلب دفع يدوي لتراجعه الإدارة.'
}

export function stripeKeyKind(key: string): PaymentDiagnostics['stripeKeyKind'] {
  if (!key) return 'missing'
  if (key.startsWith('sk_live_')) return 'live'
  if (key.startsWith('sk_test_')) return 'test'
  return 'unknown'
}

export function paypalBaseKind(base: string): PaymentDiagnostics['paypalBaseKind'] {
  if (!base) return 'missing'
  const normalized = base.replace(/\/$/, '').toLowerCase()
  if (normalized === 'https://api-m.paypal.com') return 'live'
  if (normalized === 'https://api-m.sandbox.paypal.com' || normalized.includes('sandbox.paypal.com')) return 'sandbox'
  return 'custom'
}

export function paymentDiagnostics(cfg: PaymentGatewayConfig): PaymentDiagnostics {
  const sandboxAllowed = sandboxPaymentsAllowed()
  const stripeKind = stripeKeyKind(cfg.stripeSecret)
  const paypalKind = paypalBaseKind(cfg.paypalApiBase)
  const stripeReady = cfg.mode === 'LIVE' && stripeKind === 'live'
  const paypalReady = cfg.mode === 'LIVE' && !!(cfg.paypalClientId && cfg.paypalSecret) && paypalKind === 'live'
  const usdtReady = !!(cfg.usdtWalletAddress || cfg.usdtBinancePayUserId || cfg.usdtBinancePayQrImageUrl)
  const preparingReason = 'جاري التجهيز — هذه الطريقة مغلقة مؤقتاً ولن تُستخدم حتى تعتمدها الإدارة.'
  const warnings: string[] = []
  const errors: string[] = []

  if (cfg.mode === 'LIVE' && stripeKind === 'test') warnings.push('Stripe مضبوط بمفتاح sk_test في وضع LIVE؛ استخدم sk_live لتفعيل الدفع الحقيقي.')
  if (cfg.mode === 'LIVE' && cfg.stripeSecret && stripeKind === 'unknown') warnings.push('مفتاح Stripe لا يبدأ بـ sk_live أو sk_test؛ تحقق من نسخه من لوحة Stripe.')
  if (cfg.mode === 'LIVE' && cfg.stripeSecret && !cfg.stripeWebhookSecret) warnings.push('Stripe Secret موجود لكن Webhook Secret غير مضبوط؛ قد لا يعتمد السداد تلقائياً بعد الدفع.')
  if (cfg.mode === 'LIVE' && cfg.paypalClientId && cfg.paypalSecret && paypalKind === 'sandbox') warnings.push('PayPal مضبوط على sandbox في وضع LIVE؛ استخدم https://api-m.paypal.com للدفع الحقيقي.')
  if (cfg.mode === 'LIVE' && !stripeReady && !paypalReady && !usdtReady) errors.push('لا توجد بوابة دفع حقيقية أو وسيلة USDT مفعلة حالياً. الدفع الإلكتروني غير متاح للطلاب حتى ضبط Stripe live أو PayPal live أو عنوان USDT.')
  if (cfg.mode === 'SANDBOX' && !sandboxAllowed) errors.push(sandboxPaymentsBlockedMessage())

  const methods: PaymentMethodStatus[] = [
    {
      id: 'PAYMOB',
      label: 'Paymob — بطاقة / محافظ مصر',
      enabled: false,
      configured: false,
      kind: 'placeholder',
      reason: preparingReason,
    },
    {
      id: 'FAWRY',
      label: 'فوري Fawry — مراكز الدفع',
      enabled: false,
      configured: false,
      kind: 'placeholder',
      reason: preparingReason,
    },
    {
      id: 'STRIPE',
      label: 'Stripe — Visa / MasterCard / بطاقة دولية',
      enabled: false,
      configured: !!cfg.stripeSecret,
      kind: 'gateway',
      reason: preparingReason,
    },
    {
      id: 'PAYPAL',
      label: 'PayPal — حسابات وبطاقات عبر PayPal',
      enabled: false,
      configured: !!(cfg.paypalClientId && cfg.paypalSecret),
      kind: 'gateway',
      reason: preparingReason,
    },
    {
      id: 'USDT',
      label: cfg.usdtBinancePayUserId || cfg.usdtBinancePayQrImageUrl
        ? 'USDT عبر Binance Pay — يدوي'
        : `USDT / Tether${cfg.usdtNetwork ? ` — ${cfg.usdtNetwork}` : ''}`,
      enabled: usdtReady,
      configured: usdtReady,
      kind: 'manual',
      reason: usdtReady ? undefined : 'لم يتم ضبط وجهة USDT بعد. أضف Binance Pay User ID/QR أو عنوان محفظة USDT من إعدادات الدفع أو Vercel.',
    },
    {
      id: 'BANK_TRANSFER',
      label: 'تحويل بنكي — مراجعة الإدارة',
      enabled: false,
      configured: false,
      kind: 'manual',
      reason: preparingReason,
    },
    {
      id: 'DIRECT_PAYMENT',
      label: 'دفع مباشر — تواصل مع الإدارة',
      enabled: true,
      configured: true,
      kind: 'manual',
      reason: undefined,
    },
  ]

  return {
    mode: cfg.mode,
    sandboxAllowed,
    stripeConfigured: !!cfg.stripeSecret,
    stripeWebhookConfigured: !!cfg.stripeWebhookSecret,
    stripeKeyKind: stripeKind,
    paypalConfigured: !!(cfg.paypalClientId && cfg.paypalSecret),
    paypalApiBase: cfg.paypalApiBase,
    paypalBaseKind: paypalKind,
    usdtConfigured: usdtReady,
    usdtNetwork: cfg.usdtNetwork,
    usdtBinancePayUserId: cfg.usdtBinancePayUserId,
    usdtBinancePayQrImageUrl: cfg.usdtBinancePayQrImageUrl,
    binanceDownloadUrl: cfg.binanceDownloadUrl,
    binancePayUrl: cfg.binancePayWebUrl,
    trueGatewayCount: 0,
    warnings,
    errors,
    methods,
  }
}

export async function getGatewayConfig(): Promise<PaymentGatewayConfig> {
  const keys = [
    'PAYMENT_MODE',
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'PAYPAL_CLIENT_ID',
    'PAYPAL_SECRET',
    'PAYPAL_API_BASE',
    'USDT_WALLET_ADDRESS',
    'USDT_NETWORK',
    'USDT_PAYMENT_INSTRUCTIONS',
    'USDT_BINANCE_PAY_USER_ID',
    'USDT_BINANCE_PAY_QR_IMAGE_URL',
    'BINANCE_DOWNLOAD_URL',
    'BINANCE_PAY_WEB_URL',
    'BINANCE_PAY_GUIDE_URL',
  ]
  const rows = await db.setting.findMany({ where: { key: { in: keys } } })
  const map: Record<string, string> = {}
  for (const r of rows) map[r.key] = r.value
  const stripeSecret = map.STRIPE_SECRET_KEY || env('STRIPE_SECRET_KEY') || ''
  const paypalClientId = map.PAYPAL_CLIENT_ID || env('PAYPAL_CLIENT_ID') || ''
  const paypalSecret = map.PAYPAL_SECRET || env('PAYPAL_SECRET') || ''
  const paypalApiBase = (map.PAYPAL_API_BASE || env('PAYPAL_API_BASE') || 'https://api-m.sandbox.paypal.com').replace(/\/$/, '')
  const usdtWalletAddress = map.USDT_WALLET_ADDRESS || env('USDT_WALLET_ADDRESS') || ''
  const usdtBinancePayUserId = map.USDT_BINANCE_PAY_USER_ID || env('USDT_BINANCE_PAY_USER_ID') || ''
  const usdtBinancePayQrImageUrl = map.USDT_BINANCE_PAY_QR_IMAGE_URL || env('USDT_BINANCE_PAY_QR_IMAGE_URL') || ''
  const usdtNetwork = map.USDT_NETWORK || env('USDT_NETWORK') || (usdtWalletAddress ? 'TRC20' : usdtBinancePayUserId || usdtBinancePayQrImageUrl ? 'BINANCE_PAY' : '')
  const usdtInstructions = map.USDT_PAYMENT_INSTRUCTIONS || env('USDT_PAYMENT_INSTRUCTIONS') || ''
  const binanceDownloadUrl = map.BINANCE_DOWNLOAD_URL || env('BINANCE_DOWNLOAD_URL') || 'https://www.binance.com/en/download'
  const binancePayWebUrl = map.BINANCE_PAY_WEB_URL || env('BINANCE_PAY_WEB_URL') || 'https://www.binance.com/en/my/wallet/account/payment/send'
  const binancePayGuideUrl = map.BINANCE_PAY_GUIDE_URL || env('BINANCE_PAY_GUIDE_URL') || 'https://www.binance.com/en/support/faq/detail/b3fa3ae045b9429084203c3a4ff1362f'
  const modeSetting = map.PAYMENT_MODE || env('PAYMENT_MODE') || 'SANDBOX'
  const hasUsdtManual = !!(usdtWalletAddress || usdtBinancePayUserId || usdtBinancePayQrImageUrl)
  const hasRealProviders = !!(stripeSecret || (paypalClientId && paypalSecret) || hasUsdtManual)
  const mode: 'SANDBOX' | 'LIVE' = modeSetting === 'LIVE' && hasRealProviders ? 'LIVE' : 'SANDBOX'
  return {
    mode,
    stripeSecret,
    stripeWebhookSecret: map.STRIPE_WEBHOOK_SECRET || env('STRIPE_WEBHOOK_SECRET') || '',
    paypalClientId,
    paypalSecret,
    paypalApiBase,
    usdtWalletAddress,
    usdtNetwork,
    usdtInstructions,
    usdtBinancePayUserId,
    usdtBinancePayQrImageUrl,
    binanceDownloadUrl,
    binancePayWebUrl,
    binancePayGuideUrl,
  }
}

// المزود المناسب لكل طريقة دفع يختارها الطالب
export function providerForMethod(method: string, cfg: PaymentGatewayConfig): ProviderId {
  const diag = paymentDiagnostics(cfg)
  if (method === 'STRIPE' && diag.methods.find((m) => m.id === 'STRIPE')?.enabled) return 'STRIPE'
  if (method === 'PAYPAL' && diag.methods.find((m) => m.id === 'PAYPAL')?.enabled) return 'PAYPAL'
  return 'SANDBOX'
}

export function paymentMethodStatus(method: string, cfg: PaymentGatewayConfig): PaymentMethodStatus | null {
  return paymentDiagnostics(cfg).methods.find((m) => m.id === method) || null
}

export interface CheckoutResult {
  ok: boolean
  redirectUrl?: string
  providerRef?: string
  provider?: ProviderId | 'DIRECT_PAYMENT' | 'USDT'
  error?: string
  message?: string
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
  if (!sandboxPaymentsAllowed()) {
    return { ok: false, error: sandboxPaymentsBlockedMessage() }
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
// Stripe يوصي بنافذة سماحية قصيرة ضد إعادة إرسال توقيع قديم؛ القيمة الافتراضية هنا 5 دقائق.
const DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SECONDS = 5 * 60

export async function verifyStripeWebhook(
  payload: string,
  sigHeader: string,
  secret: string,
  opts?: { toleranceSeconds?: number; nowSeconds?: number }
): Promise<boolean> {
  try {
    if (!sigHeader || !secret) return false
    const parts = sigHeader.split(',').reduce<Record<string, string[]>>((acc, p) => {
      const separator = p.indexOf('=')
      if (separator <= 0) return acc
      const k = p.slice(0, separator).trim()
      const v = p.slice(separator + 1).trim()
      if (k && v) (acc[k] = acc[k] || []).push(v)
      return acc
    }, {})
    const t = parts.t?.[0]
    const v1List = parts.v1 || []
    if (!t || v1List.length === 0) return false

    const timestamp = Number(t)
    const toleranceSeconds = opts?.toleranceSeconds ?? DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SECONDS
    const nowSeconds = opts?.nowSeconds ?? Math.floor(Date.now() / 1000)
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return false
    if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false

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
