import { NextResponse } from 'next/server'
import { getGatewayConfig, paymentDiagnostics, sandboxPaymentsAllowed } from '@/lib/payments'
import { DEFAULT_OFFICIAL_CONTACT, getSettings } from '@/lib/settings'

// أرقام التواصل الرسمية من إعداد OFFICIAL_CONTACT — بيانات عامة بطبيعتها
// (تظهر بفوتر الموقع وأجوبة المساعد) وتحتاجها تعليمات الدفع المباشر.
async function officialContactForPayments() {
  try {
    const settings = await getSettings()
    let parsed: any = DEFAULT_OFFICIAL_CONTACT
    try {
      parsed = { ...DEFAULT_OFFICIAL_CONTACT, ...JSON.parse(settings.OFFICIAL_CONTACT || '{}') }
    } catch {
      parsed = DEFAULT_OFFICIAL_CONTACT
    }
    const list = (primary: unknown, arr: unknown): string[] => {
      const out: string[] = []
      const push = (v: unknown) => {
        const s = String(v || '').trim()
        if (s && !out.includes(s)) out.push(s)
      }
      push(primary)
      if (Array.isArray(arr)) arr.forEach(push)
      return out
    }
    return {
      phones: list(parsed.phone, parsed.phones),
      whatsapps: list(parsed.whatsapp, parsed.whatsapps),
      email: String(parsed.email || ''),
    }
  } catch {
    return { phones: [] as string[], whatsapps: [] as string[], email: '' }
  }
}

// GET /api/payments/config — توزيع إعدادات الدفع الآمنة على الواجهة
// يخبر الواجهة: وضع الدفع (SANDBOX/LIVE) والمزودين المتاحين فعلياً — بدون أي أسرار
export async function GET() {
  try {
    const cfg = await getGatewayConfig()
    const diagnostics = paymentDiagnostics(cfg)
    const contact = await officialContactForPayments()
    return NextResponse.json({
      contact,
      mode: diagnostics.mode,
      sandboxAllowed: diagnostics.sandboxAllowed,
      providers: {
        STRIPE: diagnostics.methods.find((m) => m.id === 'STRIPE')?.enabled || false,
        PAYPAL: diagnostics.methods.find((m) => m.id === 'PAYPAL')?.enabled || false,
        USDT: diagnostics.methods.find((m) => m.id === 'USDT')?.enabled || false,
      },
      usdt: {
        configured: diagnostics.usdtConfigured || false,
        network: cfg.usdtNetwork || 'TRC20',
        instructions: cfg.usdtInstructions || '',
        walletAddress: cfg.usdtWalletAddress || '',
        binancePayUserId: cfg.usdtBinancePayUserId || '',
        binancePayQrImageUrl: cfg.usdtBinancePayQrImageUrl || '',
        binanceDownloadUrl: cfg.binanceDownloadUrl || '',
        binancePayWebUrl: cfg.binancePayWebUrl || '',
        binancePayGuideUrl: cfg.binancePayGuideUrl || '',
      },
      trueGatewayCount: diagnostics.trueGatewayCount,
      warnings: diagnostics.warnings,
      errors: diagnostics.errors,
      methods: diagnostics.methods,
    })
  } catch {
    return NextResponse.json({
      contact: { phones: [], whatsapps: [], email: '' },
      mode: 'SANDBOX',
      sandboxAllowed: sandboxPaymentsAllowed(),
      providers: { STRIPE: false, PAYPAL: false, USDT: false },
      usdt: { configured: false, network: 'BINANCE_PAY', instructions: '', walletAddress: '', binancePayUserId: '', binancePayQrImageUrl: '', binanceDownloadUrl: 'https://www.binance.com/en/download', binancePayWebUrl: '', binancePayGuideUrl: '' },
      trueGatewayCount: 0,
      warnings: [],
      errors: ['تعذر تحميل إعدادات الدفع مؤقتاً.'],
      methods: [],
    })
  }
}
