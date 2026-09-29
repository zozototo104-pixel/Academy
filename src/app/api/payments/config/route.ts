import { NextResponse } from 'next/server'
import { getGatewayConfig, paymentDiagnostics, sandboxPaymentsAllowed } from '@/lib/payments'

// GET /api/payments/config — توزيع إعدادات الدفع الآمنة على الواجهة
// يخبر الواجهة: وضع الدفع (SANDBOX/LIVE) والمزودين المتاحين فعلياً — بدون أي أسرار
export async function GET() {
  try {
    const cfg = await getGatewayConfig()
    const diagnostics = paymentDiagnostics(cfg)
    return NextResponse.json({
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
