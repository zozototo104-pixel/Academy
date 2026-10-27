import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ActivePaymentWaiverExistsError, approvePaymentWaiver, createPaymentWaiverCode, isPaymentWaiverType, resendPaymentWaiverCode } from '@/lib/payment-waivers'
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
    return NextResponse.json({ code: result.code, waiver: result.waiver, emailStatus: result.emailStatus })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    if (e instanceof ActivePaymentWaiverExistsError || e?.code === 'ACTIVE_WAIVER_EXISTS') {
      return NextResponse.json({ error: e.message, code: 'ACTIVE_WAIVER_EXISTS' }, { status: 409 })
    }
    return NextResponse.json({ error: e?.message || 'تعذر توليد كود الإعفاء' }, { status: 400 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const action = cleanText(body.action, 40).toUpperCase()
    if (action === 'RESEND') {
      const paymentId = cleanText(body.paymentId, 80)
      if (!paymentId) return NextResponse.json({ error: 'معرّف الفاتورة مطلوب' }, { status: 400 })
      const result = await resendPaymentWaiverCode({ paymentId, actor: { id: admin.id, name: admin.name || admin.email || 'Admin' } })
      return NextResponse.json({ code: result.code, waiver: result.waiver, emailStatus: result.emailStatus, whatsapp: result.whatsapp })
    }
    const waiverId = cleanText(body.waiverId, 80)
    if (!waiverId) return NextResponse.json({ error: 'معرّف كود الإعفاء مطلوب' }, { status: 400 })

    if (action === 'APPROVE') {
      const payment = await approvePaymentWaiver({ waiverId, actor: { id: admin.id, name: admin.name || admin.email || 'Admin' } })
      return NextResponse.json({ payment })
    }

    if (action === 'REJECT' || action === 'CANCEL') {
      const status = action === 'REJECT' ? 'REJECTED' : 'CANCELLED'
      const waiver = await db.paymentWaiverCode.findUnique({ where: { id: waiverId }, include: { payment: true } })
      if (!waiver) return NextResponse.json({ error: 'كود الإعفاء غير موجود' }, { status: 404 })
      if (action === 'REJECT' && waiver.status === 'APPROVED') {
        return NextResponse.json({ error: 'لا يمكن رفض إعفاء معتمد. استخدم إلغاء الإعفاء لإعادة الفاتورة لحالتها.' }, { status: 400 })
      }
      const result = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${waiver.paymentId} FOR UPDATE`
        const updatedWaiver = await tx.paymentWaiverCode.update({ where: { id: waiverId }, data: { status } })
        let updatedPayment: any = null
        if (action === 'CANCEL' && waiver.status === 'APPROVED') {
          const originalCents = Math.max(Number(waiver.payment.originalAmountCents || 0), Number(waiver.payment.amountCents || 0) + Number(waiver.payment.waivedAmountCents || 0))
          const originalAmount = originalCents > 0 ? originalCents / 100 : Number(waiver.payment.originalAmount || waiver.payment.amount || 0)
          updatedPayment = await tx.payment.update({
            where: { id: waiver.paymentId },
            data: {
              status: 'UNPAID',
              amount: originalAmount,
              amountCents: Math.round(originalAmount * 100),
              waivedAmount: 0,
              waivedAmountCents: 0,
              waiverStatus: 'CANCELLED',
              waiverReason: waiver.payment.waiverReason ? `${waiver.payment.waiverReason} — تم إلغاء الإعفاء المعتمد` : 'تم إلغاء الإعفاء المعتمد',
              waiverApprovedById: null,
              waiverApprovedAt: null,
              paidAt: null,
              method: null,
              receiptNo: null,
            },
          })
          if (waiver.waiverType === 'FULL_SCHOLARSHIP' && waiver.payment.admissionId) {
            await tx.admissionApplication.update({ where: { id: waiver.payment.admissionId }, data: { scholarshipFull: false } }).catch(() => null)
          }
        } else {
          updatedPayment = await tx.payment.updateMany({ where: { id: waiver.paymentId, waiverStatus: { in: ['REQUESTED', 'VERIFIED'] } }, data: { waiverStatus: status } })
        }
        return { waiver: updatedWaiver, payment: updatedPayment }
      })
      await audit({ id: admin.id, name: admin.name || admin.email || 'Admin' }, `PAYMENT_WAIVER_${status}`, 'Payment', waiver.paymentId, `${waiver.codePreview} — ${waiver.waiverType}${waiver.status === 'APPROVED' ? ' — إعادة الفاتورة إلى UNPAID' : ''}`)
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: 'إجراء غير مدعوم' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: e?.message || 'تعذر تحديث الإعفاء' }, { status: 400 })
  }
}
