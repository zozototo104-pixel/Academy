import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'
import { markInvoicePaid } from '@/lib/settle-payment'
import { paymentAmountDollars } from '@/lib/money'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

function cleanText(value: unknown, max = 700) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function manualMethod(method?: string | null, provider?: string | null) {
  const value = String(method || provider || '').toUpperCase()
  return ['DIRECT_PAYMENT', 'BANK_TRANSFER', 'USDT', 'CASH'].includes(value)
}

function paymentRecipient(payment: any) {
  return payment.userId || payment.admission?.userId || payment.enrollment?.userId || null
}

export async function PATCH(req: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdmin()
    const { id } = await Promise.resolve(context.params)
    const body = await req.json().catch(() => ({}))
    const action = cleanText(body.action, 40).toUpperCase()
    const reason = cleanText(body.reason, 700)
    const confirmUnderpayment = body.confirmUnderpayment === true || body.confirmUnderpayment === 'true'
    if (!id) return NextResponse.json({ error: 'معرّف إثبات الدفع مطلوب' }, { status: 400 })
    if (!['ACCEPT', 'REJECT'].includes(action)) return NextResponse.json({ error: 'الإجراء غير معروف' }, { status: 400 })
    if (action === 'REJECT' && reason.length < 6) {
      return NextResponse.json({ error: 'رفض إثبات الدفع يحتاج سبباً واضحاً يصل للطالب.' }, { status: 400 })
    }

    const proof = await db.paymentProof.findUnique({
      where: { id },
      include: {
        payment: {
          include: {
            admission: { select: { userId: true, email: true, fullName: true, reference: true } },
            enrollment: { select: { userId: true } },
          },
        },
      },
    })
    if (!proof) return NextResponse.json({ error: 'إثبات الدفع غير موجود' }, { status: 404 })
    if (!manualMethod(proof.payment?.method, proof.payment?.provider)) {
      return NextResponse.json({ error: 'مراجعة الإثباتات اليدوية متاحة فقط للحوالات وUSDT والنقدي.' }, { status: 400 })
    }
    if (proof.status !== 'PENDING') {
      return NextResponse.json({ error: 'تمت مراجعة هذا الإثبات مسبقاً ولا يمكن تغيير القرار.' }, { status: 409 })
    }
    if (proof.payment?.status === 'PAID') {
      return NextResponse.json({ error: 'الفاتورة مسددة بالفعل ولا يمكن قبول إثبات دفع ثانٍ لها.' }, { status: 409 })
    }
    if (proof.payment?.status === 'WAIVED') {
      return NextResponse.json({ error: 'الفاتورة معفاة ولا يمكن قبول إثبات دفع لها.' }, { status: 409 })
    }

    if (action === 'REJECT') {
      const updatedRows = await db.paymentProof.updateMany({
        where: { id: proof.id, status: 'PENDING' },
        data: { status: 'REJECTED', adminNote: reason, reviewedById: admin.id, reviewedAt: new Date() },
      })
      if (updatedRows.count !== 1) return NextResponse.json({ error: 'تمت مراجعة هذا الإثبات من جلسة أخرى.' }, { status: 409 })
      const recipientId = paymentRecipient(proof.payment)
      await notify(
        recipientId,
        'PAYMENT',
        'تم رفض إثبات الدفع',
        `رُفض إثبات الدفع للفاتورة ${proof.payment.invoiceNo}. السبب: ${reason}. ارفع إثباتاً جديداً أو تواصل مع الإدارة.`,
        '/?view=dashboard&tab=payments'
      ).catch(() => null)
      await audit(admin, 'REJECT_PAYMENT_PROOF', 'PaymentProof', proof.id, `${proof.payment.invoiceNo} — ${reason}`)
      const updated = await db.paymentProof.findUnique({ where: { id: proof.id } })
      return NextResponse.json({ ok: true, proof: updated })
    }

    const accepted = await db.paymentProof.updateMany({
      where: { id: proof.id, status: 'PENDING' },
      data: { status: 'ACCEPTED', adminNote: reason || 'تم قبول إثبات الدفع ومطابقة المبلغ.', reviewedById: admin.id, reviewedAt: new Date() },
    })
    if (accepted.count !== 1) return NextResponse.json({ error: 'تمت مراجعة هذا الإثبات من جلسة أخرى.' }, { status: 409 })

    const confirmMethod = proof.payment.method === 'USDT'
      ? 'USDT'
      : proof.payment.method === 'DIRECT_PAYMENT'
        ? 'DIRECT_PAYMENT'
        : proof.payment.method === 'CASH'
          ? 'CASH'
          : 'BANK_TRANSFER'
    let result: Awaited<ReturnType<typeof markInvoicePaid>>
    try {
      result = await markInvoicePaid(proof.payment.invoiceNo, confirmMethod, {
        actor: { id: admin.id, name: admin.name },
      })
    } catch (error: any) {
      await db.paymentProof.updateMany({
        where: { id: proof.id, status: 'ACCEPTED' },
        data: { status: 'PENDING', reviewedById: null, reviewedAt: null },
      })
      return NextResponse.json({ error: error?.message || 'تم قبول الإثبات لكن تعذر تسوية الفاتورة' }, { status: 500 })
    }
    if (!result.ok) {
      await db.paymentProof.updateMany({
        where: { id: proof.id, status: 'ACCEPTED' },
        data: { status: 'PENDING', reviewedById: null, reviewedAt: null },
      })
      return NextResponse.json({ error: result.error || 'تم قبول الإثبات لكن تعذر تسوية الفاتورة' }, { status: 400 })
    }

    await audit(admin, 'ACCEPT_PAYMENT_PROOF', 'PaymentProof', proof.id, `${proof.payment.invoiceNo} — ${result.receiptNo || ''}`)
    const updated = await db.paymentProof.findUnique({ where: { id: proof.id } })
    return NextResponse.json({ ok: true, proof: updated, payment: result.payment, receiptNo: result.receiptNo })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('admin payment proof review error:', e)
    return NextResponse.json({ error: 'تعذر مراجعة إثبات الدفع' }, { status: 500 })
  }
}
