import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@prisma/client', () => ({ Prisma: { JsonNull: null, DbNull: null } }))

const { paymentDiagnostics } = await import('../../src/lib/payments')
type PaymentGatewayConfig = import('../../src/lib/payments').PaymentGatewayConfig

// ---------------------------------------------------------------------------
// الدفع المباشر هو الخيار الأول والافتراضي (قرار المالك ٢٠٢٦-١٠-٣٠).
// الخلل الأصلي: نافذة الدفع كانت تستبدل الاختيار الافتراضي بأول طريقة
// «مفعّلة» في قائمة التشخيص — والدفع المباشر آخرها — فكانت تعليمات
// Binance/USDT تنفتح على الموبايل دون أن يختارها الطالب.
// ---------------------------------------------------------------------------

const baseCfg: PaymentGatewayConfig = {
  mode: 'LIVE',
  stripeSecret: '',
  stripeWebhookSecret: '',
  paypalClientId: '',
  paypalSecret: '',
  paypalApiBase: '',
  usdtWalletAddress: '',
  usdtNetwork: 'BINANCE_PAY',
  usdtInstructions: '',
  usdtBinancePayUserId: '',
  usdtBinancePayQrImageUrl: '',
  binanceDownloadUrl: '',
  binancePayWebUrl: '',
  binancePayGuideUrl: '',
}

const { preferredPaymentMethodId } = await import('../../src/components/aact/DashboardExtras')

describe('ترتيب طرق الدفع والاختيار الافتراضي', () => {
  test('USDT مضبوط: الدفع المباشر أول القائمة وقبل USDT، وهو أول المفعّل', () => {
    const diag = paymentDiagnostics({ ...baseCfg, usdtBinancePayUserId: 'aact-pay' })
    expect(diag.methods[0].id).toBe('DIRECT_PAYMENT')
    const directIdx = diag.methods.findIndex((m) => m.id === 'DIRECT_PAYMENT')
    const usdtIdx = diag.methods.findIndex((m) => m.id === 'USDT')
    expect(directIdx).toBeGreaterThanOrEqual(0)
    expect(usdtIdx).toBeGreaterThan(directIdx)
    expect(diag.methods.find((m) => m.enabled)?.id).toBe('DIRECT_PAYMENT')
    expect(diag.methods.find((m) => m.id === 'USDT')?.enabled).toBe(true)
  })

  test('USDT غير مضبوط: الدفع المباشر يبقى الأول والمفعّل الوحيد تقريباً', () => {
    const diag = paymentDiagnostics({ ...baseCfg })
    expect(diag.methods[0].id).toBe('DIRECT_PAYMENT')
    expect(diag.methods.find((m) => m.enabled)?.id).toBe('DIRECT_PAYMENT')
    expect(diag.methods.find((m) => m.id === 'USDT')?.enabled).toBe(false)
  })

  test('دالة الاختيار الافتراضي في الواجهة ترجع الدفع المباشر دائماً عند تفعيله', () => {
    const withUsdt = paymentDiagnostics({ ...baseCfg, usdtBinancePayUserId: 'aact-pay' })
    expect(preferredPaymentMethodId(withUsdt.methods as any)).toBe('DIRECT_PAYMENT')
    const withoutUsdt = paymentDiagnostics({ ...baseCfg })
    expect(preferredPaymentMethodId(withoutUsdt.methods as any)).toBe('DIRECT_PAYMENT')
  })

  test('تعليمات الدفع المباشر تعرض أرقام الإعدادات الرسمية (واتساب/اتصال)', () => {
    const src = readFileSync(join(import.meta.dir, '../../src/components/aact/DashboardExtras.tsx'), 'utf8')
    expect(src).toContain('تعليمات الدفع المباشر')
    expect(src).toContain('payConfig?.contact?.whatsapps')
    expect(src).toContain('https://wa.me/')
    const route = readFileSync(join(import.meta.dir, '../../src/app/api/payments/config/route.ts'), 'utf8')
    expect(route).toContain('OFFICIAL_CONTACT')
    expect(route).toContain('contact')
  })
})
