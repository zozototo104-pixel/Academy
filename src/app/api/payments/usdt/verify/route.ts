import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { notify } from '@/lib/notify'
import { verifyUsdtTransaction } from '@/lib/usdt-verification'

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })

    const { invoiceNo, paymentId, txHash } = await req.json()
    const cleanHash = String(txHash || '').trim()
    if ((!invoiceNo && !paymentId) || !cleanHash) {
      return NextResponse.json({ error: 'رقم الفاتورة أو معرفها و TX Hash مطلوبان' }, { status: 400 })
    }

    const payment = await db.payment.findFirst({
      where: paymentId ? { id: String(paymentId) } : { invoiceNo: String(invoiceNo) },
      include: { admission: { select: { userId: true, email: true, reference: true, fullName: true } } },
    })
    if (!payment) return NextResponse.json({ error: 'الفاتورة غير موجودة' }, { status: 404 })
    if (payment.status === 'PAID') return NextResponse.json({ error: 'الفاتورة مسددة بالفعل' }, { status: 400 })
    if (payment.method !== 'USDT' && payment.provider !== 'USDT') {
      return NextResponse.json({ error: 'هذه الفاتورة ليست معدة للدفع عبر USDT' }, { status: 400 })
    }

    const isPrivileged = ['ADMIN', 'STAFF'].includes(user.role || '')
    const ownerMatches =
      payment.userId === user.id ||
      payment.payerEmail?.toLowerCase() === user.email.toLowerCase() ||
      payment.admission?.userId === user.id ||
      payment.admission?.email?.toLowerCase() === user.email.toLowerCase()
    if (!isPrivileged && !ownerMatches) {
      return NextResponse.json({ error: 'هذه الفاتورة غير مرتبطة بحسابك' }, { status: 403 })
    }

    const normalizedHash = cleanHash.replace(/^0x/i, '').toLowerCase()
    const duplicate = await db.payment.findFirst({
      where: {
        id: { not: payment.id },
        cryptoTxHash: { in: [cleanHash, normalizedHash, `0x${normalizedHash}`] },
      },
      select: { invoiceNo: true, status: true },
    })
    if (duplicate) {
      return NextResponse.json({ error: `هذا TX Hash مستخدم مسبقاً على الفاتورة ${duplicate.invoiceNo}` }, { status: 409 })
    }

    const network = payment.cryptoNetwork || 'TRC20'
    const walletAddress = payment.cryptoWalletAddress || ''
    const result = await verifyUsdtTransaction({
      txHash: cleanHash,
      network,
      walletAddress,
      expectedAmount: payment.amount,
    })

    const updateData: any = {
      cryptoTxHash: cleanHash,
      cryptoNetwork: network,
      cryptoWalletAddress: walletAddress,
      cryptoVerificationStatus: result.status,
      cryptoVerificationNote: result.note,
      cryptoVerifiedAt: result.status === 'VERIFIED' ? new Date() : null,
    }
    if (result.raw) updateData.cryptoVerificationRaw = result.raw

    const updated = await db.payment.update({ where: { id: payment.id }, data: updateData })

    if (result.status === 'VERIFIED') {
      const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
      for (const admin of admins) {
        await notify(
          admin.id,
          'PAYMENT',
          'تم التحقق آلياً من تحويل USDT',
          `الفاتورة ${payment.invoiceNo} بمبلغ ${payment.amount}$ تم التحقق من Hash الخاص بها. بانتظار تأكيد الإدارة لإصدار الإيصال.`,
          'admin'
        ).catch(() => {})
      }
    }

    return NextResponse.json({
      ok: result.status === 'VERIFIED',
      status: result.status,
      note: result.note,
      verification: { status: result.status, note: result.note, amount: result.amount || null, txHash: result.txHash || cleanHash },
      payment: updated,
    })
  } catch (e) {
    console.error('USDT verify error:', e)
    return NextResponse.json({ error: 'تعذر التحقق من تحويل USDT' }, { status: 500 })
  }
}
