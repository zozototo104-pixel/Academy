import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { approvePaymentWaiver, createPaymentWaiverCode, isPaymentWaiverType } from '@/lib/payment-waivers'
import { audit } from '@/lib/notify'

function cleanText(value: unknown, max = 700) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const paymentId = cleanText(body.paymentId, 80)
    const waiverType = cleanText(body.waiverType, 40)
    const reason = cleanText(body.reason)
    const requestedAmount = body.requestedAmount === undefined || body.requestedAmount === null || body.requestedAmount === '' ? null : Number(body.requestedAmount)
    if (!paymentId) return NextResponse.json({ error: 'معرّف الفاتورة مطلوب' }, { status: 400 })
    if (!isPaymentWaiverType(waiverType)) return NextResponse.json({ error: 'نوع الإعفاء غير صحيح' }, { status: 400 })
    const result = await createPaymentWaiverCode({
      paymentId,
      waiverType,
      reason,
      requestedAmount,
      actor: { id: admin.id, name: admin.name || admin.email || 'Admin' },
      expiresDays: Number(body.expiresDays || 7),
    })
    return NextResponse.json({ code: result.code, waiver: result.waiver })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: e?.message || 'تعذر توليد كود الإعفاء' }, { status: 400 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const action = cleanText(body.action, 40).toUpperCase()
    const waiverId = cleanText(body.waiverId, 80)
    if (!waiverId) return NextResponse.json({ error: 'معرّف كود الإعفاء مطلوب' }, { status: 400 })

    if (action === 'APPROVE') {
      const payment = await approvePaymentWaiver({ waiverId, actor: { id: admin.id, name: admin.name || admin.email || 'Admin' } })
      return NextResponse.json({ payment })
    }

    if (action === 'REJECT' || action === 'CANCEL') {
      const status = action === 'REJECT' ? 'REJECTED' : 'CANCELLED'
      const waiver = await db.paymentWaiverCode.update({ where: { id: waiverId }, data: { status } })
      await db.payment.updateMany({ where: { id: waiver.paymentId, waiverStatus: { in: ['REQUESTED', 'VERIFIED'] } }, data: { waiverStatus: status } })
      await audit({ id: admin.id, name: admin.name || admin.email || 'Admin' }, `PAYMENT_WAIVER_${status}`, 'Payment', waiver.paymentId, `${waiver.codePreview} — ${waiver.waiverType}`)
      return NextResponse.json({ waiver })
    }

    return NextResponse.json({ error: 'إجراء غير مدعوم' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: e?.message || 'تعذر تحديث الإعفاء' }, { status: 400 })
  }
}
