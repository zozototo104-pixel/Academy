import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { getGatewayConfig } from '@/lib/payments'
import { verifyUsdtTransaction } from '@/lib/usdt-verifier'
import { notify } from '@/lib/notify'

export const runtime = 'nodejs'

function ownsPayment(payment: any, user: any) {
  const email = String(user?.email || '').toLowerCase()
  return Boolean(
    payment.userId === user?.id ||
      String(payment.payerEmail || '').toLowerCase() === email ||
      payment.admission?.userId === user?.id ||
      String(payment.admission?.email || '').toLowerCase() === email
  )
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })

    const { invoiceNo, paymentId, txHash } = await req.json()
    const payment = await db.payment.findFirst({
      where: paymentId ? { id: String(paymentId) } : { invoiceNo: String(invoiceNo || '') },
      include: { admission: { select: { userId: true, email: true, reference: true, fullName: true } } },
    })
    if (!payment) return NextResponse.json({ error: 'الفاتورة غير موجودة' }, { status: 404 })
    if (payment.status === 'PAID') return NextResponse.json({ error: 'الفاتورة مسددة بالفعل' }, { status: 400 })
    if (!['ADMIN', 'STAFF'].includes(user.role || '') && !ownsPayment(payment, user)) {
      return NextResponse.json({ error: 'هذه الفاتورة غير مرتبطة بحسابك' }, { status: 403 })
    }
    if (payment.method !== 'USDT' && payment.provider !== 'USDT') {
      return NextResponse.json({ error: 'هذه الفاتورة ليست مفعلة لطريقة USDT. اختر USDT من نافذة الدفع أولاً.' }, { status: 400 })
    }

    const cfg = await getGatewayConfig()
    const expectedWallet = payment.cryptoWalletAddress || cfg.usdtWalletAddress
    const network = payment.cryptoNetwork || cfg.usdtNetwork || 'TRC20'
    if (!expectedWallet) return NextResponse.json({ error: 'عنوان محفظة USDT غير مضبوط في النظام' }, { status: 400 })

    const result = await verifyUsdtTransaction({
      txHash: String(txHash || '').trim(),
      network,
      expectedWallet,
      expectedAmount: Number(payment.amount || 0),
    })

    const updated = await db.payment.update({
      where: { id: payment.id },
      data: {
        cryptoTxHash: String(txHash || '').trim(),
        cryptoNetwork: network,
        cryptoWalletAddress: expectedWallet,
        cryptoVerificationStatus: result.status,
        cryptoVerificationNote: result.note,
        cryptoVerifiedAt: result.status === 'VERIFIED' ? new Date() : null,
        cryptoVerificationRaw: result.raw || { explorerUrl: result.explorerUrl || null, amount: result.amount || null, toAddress: result.toAddress || null, token: result.token || null },
      },
    })

    const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
    for (const admin of admins) {
      await notify(
        admin.id,
        'PAYMENT',
        result.status === 'VERIFIED' ? 'تحقق آلي ناجح من تحويل USDT' : 'تم إدخال Hash دفع USDT ويحتاج مراجعة',
        result.status === 'VERIFIED'
          ? `الفاتورة ${payment.invoiceNo} بمبلغ ${payment.amount}$ تم التحقق آلياً من تحويلها. راجعها ثم اضغط تأكيد الدفع لإصدار الإيصال.`
          : `الفاتورة ${payment.invoiceNo}: ${result.note}`,
        'admin'
      ).catch(() => {})
    }

    return NextResponse.json({ ok: true, payment: updated, verification: result })
  } catch (e) {
    console.error('USDT proof error:', e)
    return NextResponse.json({ error: 'تعذر التحقق من تحويل USDT' }, { status: 500 })
  }
}
