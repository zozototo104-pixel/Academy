import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { createProviderCheckout, getGatewayConfig, paymentMethodStatus } from '@/lib/payments'
import { notify } from '@/lib/notify'

function paymentPurposeLabel(purpose?: string | null) {
  const labels: Record<string, string> = {
    APPLICATION_FEE: 'رسوم تقديم',
    TUITION: 'رسوم دراسية',
    TUITION_INSTALLMENT: 'دفعة رسوم دراسية',
    ACCREDITATION_APP: 'رسوم تقديم اعتماد',
    ACCREDITATION_FEE: 'رسوم اعتماد',
    ACCREDITATION: 'اعتماد',
    SERVICE_FEE: 'رسوم خدمة',
    AI_LIVE_CREDIT: 'باقة دقائق صوت للمشرف الذكي',
    OTHER: 'رسوم أخرى',
  }
  return labels[String(purpose || '')] || String(purpose || 'فاتورة')
}

// POST /api/payments/checkout — إنشاء جلسة دفع حقيقية لدى المزود
// مع STRIPE_SECRET_KEY live أو مفاتيح PayPal live يُعاد رابط دفع حقيقي (redirectUrl)
// الطرق غير المضبوطة تُرفض برسالة واضحة. SANDBOX لا يعمل إلا إذا كان مسموحاً في البيئة الحالية.
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    const { invoiceNo, method } = await req.json()
    if (!invoiceNo || !method) {
      return NextResponse.json({ error: 'رقم الفاتورة وطريقة الدفع مطلوبان' }, { status: 400 })
    }
    const payment = await db.payment.findUnique({
      where: { invoiceNo },
      include: { admission: { select: { userId: true, email: true } } },
    })
    if (!payment) return NextResponse.json({ error: 'الفاتورة غير موجودة' }, { status: 404 })
    const isPrivileged = ['ADMIN', 'STAFF'].includes(user?.role || '')
    const verifiedEmailOwner =
      user?.role === 'STUDENT' &&
      Boolean((user as any).emailVerifiedAt) &&
      !payment.userId &&
      !payment.admission?.userId &&
      (
        payment.payerEmail?.toLowerCase() === user?.email?.toLowerCase() ||
        payment.admission?.email?.toLowerCase() === user?.email?.toLowerCase()
      )
    if (verifiedEmailOwner) {
      await db.$transaction([
        ...(payment.admissionId ? [db.admissionApplication.update({ where: { id: payment.admissionId }, data: { userId: user.id } })] : []),
        db.payment.update({ where: { id: payment.id }, data: { userId: user.id } }),
      ]).catch(() => {})
    }
    const ownerMatches =
      payment.userId === user?.id ||
      payment.admission?.userId === user?.id ||
      verifiedEmailOwner
    if (!isPrivileged && !ownerMatches) {
      return NextResponse.json({ error: 'هذه الفاتورة غير مرتبطة بحسابك' }, { status: 403 })
    }
    if (payment.status === 'PAID') {
      return NextResponse.json({ error: 'الفاتورة مسددة بالفعل' }, { status: 400 })
    }

    // الطرق اليدوية ليست بوابات إلكترونية ولا Sandbox: تسجل طلب دفع وينتظر تأكيد الإدارة.
    if (['DIRECT_PAYMENT', 'USDT'].includes(String(method))) {
      const cfg = await getGatewayConfig()
      const usdtDestinationReady = !!(cfg.usdtWalletAddress || cfg.usdtBinancePayUserId || cfg.usdtBinancePayQrImageUrl)
      if (String(method) === 'USDT' && !usdtDestinationReady) {
        return NextResponse.json({ error: 'USDT غير متاح حالياً لأن وجهة Binance Pay أو عنوان المحفظة غير مضبوط.' }, { status: 400 })
      }
      const manualProvider = String(method) === 'USDT' ? 'USDT' : 'DIRECT_PAYMENT'
      const purposeLabel = paymentPurposeLabel(payment.purpose)
      await db.payment.update({
        where: { id: payment.id },
        data: {
          provider: manualProvider,
          providerRef: `${manualProvider}-${Date.now()}`,
          checkoutUrl: null,
          method: manualProvider,
          userId: payment.userId || user?.id || null,
          ...(manualProvider === 'USDT'
            ? {
                cryptoNetwork: cfg.usdtWalletAddress ? (cfg.usdtNetwork || 'TRC20') : 'BINANCE_PAY',
                cryptoWalletAddress: cfg.usdtWalletAddress || cfg.usdtBinancePayUserId || 'BINANCE_PAY_QR',
                cryptoVerificationStatus: 'WAITING_TX',
                cryptoVerificationNote: cfg.usdtWalletAddress
                  ? 'بانتظار إدخال TX Hash من الطالب/العميل ثم التحقق الآلي إن كانت الشبكة مدعومة.'
                  : 'بانتظار إدخال رقم عملية Binance Pay أو إرفاق إثبات الدفع؛ ستراجعه الإدارة يدوياً.',
              }
            : {}),
        },
      })
      const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
      for (const admin of admins) {
        await notify(
          admin.id,
          'PAYMENT',
          manualProvider === 'USDT' ? 'طالب اختار الدفع عبر USDT' : 'طالب اختار الدفع المباشر',
          manualProvider === 'USDT'
            ? `الفاتورة ${payment.invoiceNo} بمبلغ ${payment.amount}$ مقابل ${purposeLabel} بانتظار وصول USDT عبر ${cfg.usdtWalletAddress ? `شبكة ${cfg.usdtNetwork || 'TRC20'}` : `Binance Pay (${cfg.usdtBinancePayUserId || 'QR'})`} وتأكيد الإدارة.`
            : `الفاتورة ${payment.invoiceNo} بمبلغ ${payment.amount}$ مقابل ${purposeLabel} بانتظار تأكيد الإدارة بعد استلام المبلغ.`,
          'admin'
        ).catch(() => {})
      }
      const usdtMessage = cfg.usdtWalletAddress
        ? `تم تسجيل طلب الدفع عبر USDT. أرسل ${payment.amount}$ USDT على شبكة ${cfg.usdtNetwork || 'TRC20'} إلى العنوان: ${cfg.usdtWalletAddress}${cfg.usdtInstructions ? ` — ${cfg.usdtInstructions}` : ''}. ستؤكد الإدارة السداد بعد التحقق من التحويل.`
        : `تم تسجيل طلب الدفع عبر Binance Pay. أرسل ${payment.amount} USDT عبر QR أو إلى ${cfg.usdtBinancePayUserId || 'حساب Binance Pay الموضح'}، ثم أدخل رقم العملية/إثبات الدفع ليتم تأكيده من الإدارة.`
      return NextResponse.json({
        ok: true,
        mode: 'MANUAL',
        provider: manualProvider,
        redirectUrl: null,
        walletAddress: manualProvider === 'USDT' ? cfg.usdtWalletAddress : null,
        network: manualProvider === 'USDT' ? cfg.usdtNetwork : null,
        binancePayUserId: manualProvider === 'USDT' ? cfg.usdtBinancePayUserId : null,
        binancePayQrImageUrl: manualProvider === 'USDT' ? cfg.usdtBinancePayQrImageUrl : null,
        binanceDownloadUrl: manualProvider === 'USDT' ? cfg.binanceDownloadUrl : null,
        binancePayWebUrl: manualProvider === 'USDT' ? cfg.binancePayWebUrl : null,
        message: manualProvider === 'USDT' ? usdtMessage : 'تم تسجيل طلب الدفع المباشر. تواصل مع الإدارة لتسليم المبلغ، وستؤكد الإدارة السداد من لوحة الإدارة.',
      })
    }

    const cfg = await getGatewayConfig()
    const selectedMethod = paymentMethodStatus(String(method), cfg)
    if (!selectedMethod?.enabled) {
      return NextResponse.json({ error: selectedMethod?.reason || 'طريقة الدفع غير متاحة حالياً.' }, { status: 400 })
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
