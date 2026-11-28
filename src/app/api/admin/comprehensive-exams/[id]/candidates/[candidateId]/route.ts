import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'
import { emailPaymentReceipt } from '@/lib/mailer'
import { nextInvoiceNo } from '@/lib/settings'
import { markInvoicePaid } from '@/lib/settle-payment'
import {
  ComprehensiveExamPhase2Error,
  isComprehensiveCertificateScopeConflict,
  qualifyComprehensiveExamCandidate,
  sendComprehensiveCandidatePasswordSetup,
} from '@/lib/comprehensive-exam-phase2'

export const runtime = 'nodejs'

function phase2ErrorResponse(e: unknown, fallback: string) {
  if (e instanceof ComprehensiveExamPhase2Error) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
  }
  if (isComprehensiveCertificateScopeConflict(e)) {
    return NextResponse.json({ error: 'موجود أصلاً كخريج في هذا التخصص', code: 'CERTIFICATE_ALREADY_EXISTS' }, { status: 409 })
  }
  console.error('comprehensive exam candidate review error:', e)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

function cleanText(value: unknown, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

async function loadCandidate(examId: string, candidateId: string) {
  return db.comprehensiveExamCandidate.findFirst({
    where: { id: candidateId, examId },
    include: { exam: { select: { id: true, programId: true, specializationProgramId: true, title: true, status: true } } },
  })
}

// PATCH — اعتماد مرشح أو رفضه (الرفض يتطلب سبباً)
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; candidateId: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id, candidateId } = await ctx.params
    const candidate = await loadCandidate(id, candidateId)
    if (!candidate) return NextResponse.json({ error: 'المرشح غير موجود' }, { status: 404 })
    if (candidate.status !== 'PENDING_REVIEW') {
      return NextResponse.json({ error: 'هذا المرشح رُوجع سابقاً — لا يمكن إعادة مراجعته' }, { status: 409 })
    }
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    const action = String(body?.action || '')
    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json({ error: 'الإجراء غير معروف — المسموح: approve أو reject' }, { status: 400 })
    }
    const rejectedReason = action === 'reject' ? cleanText(body?.rejectedReason, 300) : ''
    if (action === 'reject' && !rejectedReason) {
      return NextResponse.json({ error: 'رفض المرشح يتطلب سبباً' }, { status: 400 })
    }
    const updated = await db.comprehensiveExamCandidate.update({
      // Conditional unique update: the first review wins even if both
      // browser tabs read PENDING_REVIEW before either submits.
      where: { id: candidate.id, status: 'PENDING_REVIEW' },
      data: {
        status: action === 'approve' ? 'APPROVED' : 'REJECTED',
        rejectedReason: action === 'reject' ? rejectedReason : null,
        reviewedById: admin.id,
        reviewedAt: new Date(),
      },
    })
    await audit(
      { id: admin.id, name: admin.name },
      action === 'approve' ? 'APPROVE_COMPREHENSIVE_EXAM_CANDIDATE' : 'REJECT_COMPREHENSIVE_EXAM_CANDIDATE',
      'ComprehensiveExamCandidate',
      candidate.id,
      `${action === 'approve' ? 'اعتماد' : 'رفض'} مرشح الامتحان الشامل «${candidate.exam.title}»: ${candidate.fullName} — ${candidate.email}${rejectedReason ? ` — السبب: ${rejectedReason}` : ''}`,
    )
    return NextResponse.json({ ok: true, candidate: { id: updated.id, status: updated.status, rejectedReason: updated.rejectedReason } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (e?.code === 'P2025') return NextResponse.json({ error: 'رُوجع المرشح بالتزامن — حدّث القائمة', code: 'CANDIDATE_ALREADY_REVIEWED' }, { status: 409 })
    return phase2ErrorResponse(e, 'تعذر مراجعة المرشح')
  }
}

// POST {action: 'qualify'} — إعادة محاولة التأهيل لمحاولة ناجحة لم
// تُصدَر شهادتها (مثال: التأهيل الأول توقف على تكرار حله المدير بعدها).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; candidateId: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id, candidateId } = await ctx.params
    const candidate = await loadCandidate(id, candidateId)
    if (!candidate) return NextResponse.json({ error: 'المرشح غير موجود' }, { status: 404 })
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    const action = String(body?.action || '')
    if (action === 'resend_account_setup') {
      if (candidate.submittedBy !== 'ADMIN' || !candidate.userId) {
        return NextResponse.json({ error: 'إرسال تعليمات الدخول متاح فقط لحسابات المرشحين المدخلين من الإدارة' }, { status: 409 })
      }
      const emailStatus = await sendComprehensiveCandidatePasswordSetup(req, candidate.userId)
      await audit({ id: admin.id, name: admin.name }, 'RESEND_COMPREHENSIVE_CANDIDATE_SETUP', 'ComprehensiveExamCandidate', candidate.id, `تعليمات الدخول للمرشح — ${emailStatus}`)
      return NextResponse.json({ ok: emailStatus === 'SENT', emailStatus }, { status: emailStatus === 'SENT' ? 200 : 503 })
    }
    if (action === 'record_paid') {
      if (candidate.submittedBy !== 'ADMIN' || candidate.admissionApplicationId || candidate.status !== 'APPROVED' || !candidate.userId) {
        return NextResponse.json({ error: 'تسجيل الدفع المباشر متاح فقط لمرشح أدخلته الإدارة وتم اعتماده' }, { status: 409 })
      }
      const rawAmount = String(body?.amount ?? '').trim().replace(',', '.')
      if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(rawAmount)) {
        return NextResponse.json({ error: 'أدخل المبلغ المستلم بالدولار، بحد أقصى منزلتين عشريتين' }, { status: 400 })
      }
      const amountCents = Math.round(Number(rawAmount) * 100)
      if (amountCents <= 0) return NextResponse.json({ error: 'المبلغ المدفوع يجب أن يكون أكبر من صفر' }, { status: 400 })
      const note = cleanText(body?.note, 300)
      if (note.length < 6) return NextResponse.json({ error: 'أدخل ملاحظة استلام واضحة (6 أحرف على الأقل)' }, { status: 400 })

      // Lock the candidate and enforce one official SERVICE_FEE invoice.
      // The unique candidate FK is the final guard against duplicate clicks.
      const invoice = await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ComprehensiveExamCandidate" WHERE id = ${candidate.id} FOR UPDATE`
        const fresh = await tx.comprehensiveExamCandidate.findFirst({
          where: { id: candidate.id, examId: id, status: 'APPROVED', submittedBy: 'ADMIN' },
          select: { id: true },
        })
        if (!fresh) throw new ComprehensiveExamPhase2Error(409, 'CANDIDATE_CHANGED', 'تغيّرت حالة المرشح — حدّث القائمة')
        const existing = await tx.payment.findFirst({ where: { comprehensiveExamCandidateId: candidate.id } })
        if (existing) {
          const existingCents = existing.amountCents ?? Math.round(Number(existing.amount) * 100)
          if (existingCents !== amountCents) throw new ComprehensiveExamPhase2Error(409, 'PAYMENT_ALREADY_RECORDED', 'سُجلت دفعة لهذا المرشح بمبلغ مختلف — راجع قسم المالية')
          if (existing.status === 'WAIVED') throw new ComprehensiveExamPhase2Error(409, 'PAYMENT_WAIVED', 'الفاتورة معفاة ولا يمكن تحويلها إلى دفع نقدي')
          return { payment: existing, created: false }
        }
        const payment = await tx.payment.create({ data: {
          comprehensiveExamCandidateId: candidate.id,
          userId: candidate.userId,
          invoiceNo: await nextInvoiceNo(),
          purpose: 'SERVICE_FEE',
          description: `رسوم معادلة الشهادة — ${candidate.exam.title}`,
          amount: amountCents / 100,
          amountCents,
          currency: 'USD',
          method: 'DIRECT_PAYMENT',
          status: 'UNPAID',
          manualApprovalReference: `CEX-${candidate.id}`,
          manualApprovalNote: note,
          payerName: candidate.fullName,
          payerEmail: candidate.email,
        } })
        return { payment, created: true }
      }, { isolationLevel: 'Serializable' })
      const settled = await markInvoicePaid(invoice.payment.invoiceNo, 'DIRECT_PAYMENT', { actor: { id: admin.id, name: admin.name } })
      if (!settled.ok) return NextResponse.json({ error: settled.error || 'تعذرت تسوية الدفعة' }, { status: 409 })
      if (invoice.created) {
        await audit({ id: admin.id, name: admin.name }, 'RECORD_COMPREHENSIVE_EXAM_DIRECT_PAYMENT', 'ComprehensiveExamCandidate', candidate.id,
          `استلمت الإدارة ${(amountCents / 100).toFixed(2)}$ — فاتورة ${invoice.payment.invoiceNo} — إيصال ${settled.receiptNo} — ${note}`)
        await notify(candidate.userId, 'PAYMENT', 'تم تسجيل سداد رسوم المعادلة', `تم توثيق مبلغ ${(amountCents / 100).toFixed(2)}$ للمعادلة — إيصال ${settled.receiptNo}`, 'dashboard').catch(() => null)
        await emailPaymentReceipt(candidate.email, candidate.fullName, invoice.payment.invoiceNo, invoice.payment.description, amountCents / 100, settled.receiptNo || '').catch(() => false)
      }
      return NextResponse.json({ ok: true, payment: { id: settled.payment?.id, invoiceNo: invoice.payment.invoiceNo, amount: amountCents / 100, status: 'PAID', receiptNo: settled.receiptNo }, created: invoice.created })
    }
    if (action !== 'qualify') {
      return NextResponse.json({ error: 'الإجراء غير معروف — المسموح: qualify أو resend_account_setup أو record_paid' }, { status: 400 })
    }
    const attempt = await db.comprehensiveExamAttempt.findFirst({
      where: { candidateId: candidate.id, status: 'GRADED', passed: true },
      orderBy: { createdAt: 'desc' },
    })
    if (!attempt || attempt.score === null || attempt.score === undefined) {
      return NextResponse.json({ error: 'لا توجد محاولة ناجحة لهذا المرشح ليعاد تأهيلها' }, { status: 409 })
    }
    const program = await db.program.findUnique({
      where: { id: candidate.exam.programId },
      select: { id: true, titleAr: true, titleEn: true },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    if (!candidate.exam.specializationProgramId) {
      return NextResponse.json({ error: 'الامتحان بلا تخصص — حدّد تخصص الامتحان قبل إعادة التأهيل' }, { status: 409 })
    }
    const specialization = await db.program.findUnique({
      where: { id: candidate.exam.specializationProgramId },
      select: { id: true, titleAr: true, titleEn: true },
    })
    if (!specialization) return NextResponse.json({ error: 'برنامج التخصص غير موجود' }, { status: 404 })
    const result = await db.$transaction(async (tx) =>
      qualifyComprehensiveExamCandidate(tx, {
        candidate: { id: candidate.id, userId: candidate.userId, fullName: candidate.fullName, nationalId: candidate.nationalId, email: candidate.email, phone: candidate.phone },
        exam: { id: candidate.exam.id, programId: candidate.exam.programId },
        program,
        specialization,
        attempt: { id: attempt.id, score: attempt.score as number },
        admin: { id: admin.id, name: admin.name },
      }),
      { isolationLevel: 'Serializable' },
    )
    return NextResponse.json({ ok: true, certificate: { id: result.certificate.id, serial: result.certificate.serial, qrToken: result.certificate.qrToken } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (e?.code === 'P2034') return NextResponse.json({ error: 'تزامنت محاولة تأهيل أخرى — حدّث الشهادات والنتائج', code: 'QUALIFICATION_CONFLICT' }, { status: 409 })
    return phase2ErrorResponse(e, 'تعذر إعادة التأهيل')
  }
}
