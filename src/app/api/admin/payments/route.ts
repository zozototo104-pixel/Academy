import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { markInvoicePaid } from '@/lib/settle-payment'
import { notify, audit } from '@/lib/notify'
import { adminPaginationMeta, cleanAdminQuery, parseAdminPagination } from '@/lib/admin-query'
import { getSettings } from '@/lib/settings'
import { dollarsToCents } from '@/lib/money'

function cleanText(value: unknown, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

class RefreshAmountConflictError extends Error {
  status = 409
  code = 'REFRESH_AMOUNT_CONFLICT'

  constructor() {
    super('تغيّرت حالة الفاتورة أو مبلغ إعفائها أثناء المعالجة. أعد تحميل البيانات وراجع الحالة الحالية قبل إعادة المحاولة.')
  }
}

function isManualPaymentMethod(method?: string | null, provider?: string | null) {
  const value = String(method || provider || '').toUpperCase()
  return ['DIRECT_PAYMENT', 'BANK_TRANSFER', 'USDT', 'CASH'].includes(value)
}

function numberSetting(settings: Record<string, string>, key: string, fallback = 0) {
  const n = Number(settings[key])
  return Number.isFinite(n) ? n : fallback
}

function roundMoney(value: number) {
  return Math.round((Number(value) || 0) * 100) / 100
}

function hasPositivePrice(value: unknown): value is number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0
}

function secureProofPayload(proof: any) {
  const { storageKey, storageUrl, ...safeProof } = proof || {}
  const protectedUrl = safeProof.id ? `/api/admin/payments/proofs/${encodeURIComponent(safeProof.id)}/download` : null
  return {
    ...safeProof,
    fileUrl: protectedUrl,
    downloadUrl: protectedUrl,
  }
}

function tuitionFallbackForProgram(params: {
  settings: Record<string, string>
  program?: { category?: string | null; price?: number | null } | null
  admission?: { program?: string | null; education?: string | null } | null
}) {
  const { settings, program, admission } = params
  if (hasPositivePrice(program?.price)) return Number(program?.price)
  const category = String(program?.category || '').toUpperCase()
  const programText = String(admission?.program || '')
  if (category === 'DOCTORATE' || programText.includes('دكتوراه') || programText.includes('دكتوراة')) return numberSetting(settings, 'FEE_DOCTORATE', 0)
  if (category === 'MASTERS' || admission?.education === 'MASTER') return numberSetting(settings, 'FEE_MASTERS', 0)
  if (category === 'SERVICE') return numberSetting(settings, 'FEE_SERVICE_DEFAULT', 0)
  return numberSetting(settings, 'FEE_DIPLOMAS_MAX', numberSetting(settings, 'FEE_DIPLOMAS_MIN', 0))
}

async function resolveCurrentInvoiceAmount(payment: any): Promise<{ ok: true; amount: number; source: string } | { ok: false; error: string }> {
  const settings = await getSettings()
  const purpose = String(payment.purpose || '').toUpperCase()
  const program = payment.admission?.programRef || payment.enrollment?.program || null

  if (purpose === 'APPLICATION_FEE') {
    return { ok: true, amount: numberSetting(settings, 'FEE_APPLICATION', 0), source: 'FEE_APPLICATION' }
  }

  if (purpose === 'TUITION') {
    return {
      ok: true,
      amount: tuitionFallbackForProgram({ settings, program, admission: payment.admission }),
      source: program?.price ? 'Program.price' : 'program category default setting',
    }
  }

  if (purpose === 'SERVICE_FEE') {
    const amount = hasPositivePrice(program?.price) ? Number(program.price) : numberSetting(settings, 'FEE_SERVICE_DEFAULT', 0)
    return { ok: true, amount, source: hasPositivePrice(program?.price) ? 'Program.price' : 'FEE_SERVICE_DEFAULT' }
  }

  if (purpose === 'ACCREDITATION_APP') {
    return { ok: true, amount: numberSetting(settings, 'FEE_ACC_APPLICATION', 0), source: 'FEE_ACC_APPLICATION' }
  }

  if (purpose === 'ACCREDITATION' || purpose === 'ACCREDITATION_FEE') {
    const type = String(payment.agent?.accreditationType || '').toUpperCase()
    if (type === 'COMPANY') return { ok: true, amount: numberSetting(settings, 'FEE_ACC_COMPANY', 0), source: 'FEE_ACC_COMPANY' }
    if (type === 'CONSULTANT') return { ok: true, amount: numberSetting(settings, 'FEE_ACC_CONSULTANT', 0), source: 'FEE_ACC_CONSULTANT' }
    if (type === 'TRAINER') return { ok: true, amount: numberSetting(settings, 'FEE_ACC_TRAINER', 0), source: 'FEE_ACC_TRAINER' }
    return { ok: false, error: 'لا يمكن حساب مبلغ الاعتماد الحالي لأن نوع الاعتماد غير محدد أو يعتمد على تقدير خاص.' }
  }

  if (purpose === 'TUITION_INSTALLMENT') {
    return { ok: false, error: 'دفعات التقسيط لا تُحدَّث تلقائياً من سعر البرنامج الكامل حتى لا تتغير خطة التقسيط المعتمدة.' }
  }

  return { ok: false, error: 'هذا النوع من الفواتير لا يملك قاعدة مبلغ حالية قابلة للحساب تلقائياً.' }
}

// GET /api/admin/payments — كل الفواتير والمستحقات (للإدارة)
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const sp = req.nextUrl.searchParams
    const { page, pageSize, skip, take } = parseAdminPagination(sp, { pageSize: 25, maxPageSize: 100 })
    const search = cleanAdminQuery(sp.get('search'))
    const status = cleanAdminQuery(sp.get('status'))
    const method = cleanAdminQuery(sp.get('method'))

    const knownStatuses = new Set(['PAID', 'UNPAID', 'WAIVED'])
    const knownPurposes = new Set(['APPLICATION_FEE', 'TUITION', 'TUITION_INSTALLMENT', 'ACCREDITATION_APP', 'ACCREDITATION_FEE', 'ACCREDITATION', 'SERVICE_FEE', 'AI_LIVE_CREDIT', 'OTHER'])
    const manualPendingWhere = {
      status: 'UNPAID',
      OR: [
        { method: { in: ['DIRECT_PAYMENT', 'BANK_TRANSFER', 'USDT', 'CASH'] } },
        { provider: { in: ['DIRECT_PAYMENT', 'BANK_TRANSFER', 'USDT', 'CASH'] } },
      ],
    }

    const andFilters: any[] = []
    if (status && status !== 'ALL') {
      if (status === 'MANUAL_PENDING') andFilters.push(manualPendingWhere)
      else if (status === 'WAIVER_AWAITING_ENTRY') andFilters.push({ waiverCodes: { some: { status: 'ISSUED' } } })
      else if (status === 'WAIVER_AWAITING_APPROVAL') andFilters.push({ waiverCodes: { some: { status: 'VERIFIED' } } })
      else if (knownStatuses.has(status)) andFilters.push({ status })
      else if (knownPurposes.has(status)) andFilters.push({ purpose: status })
      else andFilters.push({ status })
    }
    if (method && method !== 'ALL') andFilters.push({ OR: [{ method }, { provider: method }] })
    if (search) {
      andFilters.push({
        OR: [
          { invoiceNo: { contains: search, mode: 'insensitive' } },
          { receiptNo: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
          { payerName: { contains: search, mode: 'insensitive' } },
          { payerEmail: { contains: search, mode: 'insensitive' } },
          { cryptoTxHash: { contains: search, mode: 'insensitive' } },
          { admission: { reference: { contains: search, mode: 'insensitive' } } },
          { admission: { fullName: { contains: search, mode: 'insensitive' } } },
          { admission: { program: { contains: search, mode: 'insensitive' } } },
        ],
      })
    }
    const where: any = andFilters.length ? { AND: andFilters } : {}

    const [payments, total, paidCount, paidSum, unpaidSum, manualPendingCount, manualPendingSum, manualAiPendingCount, manualAiPendingSum] = await Promise.all([
      db.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          admission: { select: { reference: true, fullName: true, country: true, program: true } },
          proofs: {
            orderBy: { createdAt: 'desc' },
            take: 5,
            include: {
              uploadedBy: { select: { id: true, name: true, email: true } },
              reviewedBy: { select: { id: true, name: true, email: true } },
            },
          },
          waiverCodes: {
            orderBy: { createdAt: 'desc' },
            take: 3,
            select: { id: true, codePreview: true, waiverType: true, requestedAmount: true, reason: true, status: true, emailStatus: true, expiresAt: true, verifiedAt: true, approvedAt: true, createdAt: true },
          },
        },
      }),
      db.payment.count({ where }),
      db.payment.count({ where: { ...where, status: 'PAID' } }),
      db.payment.aggregate({ where: { ...where, status: 'PAID' }, _sum: { amount: true } }),
      db.payment.aggregate({ where: { ...where, status: 'UNPAID' }, _sum: { amount: true } }),
      db.payment.count({ where: manualPendingWhere }),
      db.payment.aggregate({ where: manualPendingWhere, _sum: { amount: true } }),
      db.payment.count({ where: { AND: [manualPendingWhere, { purpose: 'AI_LIVE_CREDIT' }] } }),
      db.payment.aggregate({ where: { AND: [manualPendingWhere, { purpose: 'AI_LIVE_CREDIT' }] }, _sum: { amount: true } }),
    ])
    const totals = {
      collected: paidSum._sum.amount || 0,
      pending: unpaidSum._sum.amount || 0,
      count: total,
      paidCount,
      manualPendingCount,
      manualPendingAmount: manualPendingSum._sum.amount || 0,
      manualAiLiveCreditCount: manualAiPendingCount,
      manualAiLiveCreditAmount: manualAiPendingSum._sum.amount || 0,
    }
    const safePayments = payments.map((payment: any) => ({
      ...payment,
      proofs: (payment.proofs || []).map(secureProofPayload),
    }))
    return NextResponse.json({ payments: safePayments, totals, total, pagination: adminPaginationMeta(page, pageSize, total) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin payments GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل المدفوعات' }, { status: 500 })
  }
}

// PATCH /api/admin/payments — تأكيد دفعة يدوية، أو تحديث مبلغ فاتورة غير مدفوعة بعد معاينة إدارية
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const id = cleanText(body?.id, 120)
    const action = cleanText(body?.action, 80)
    const approvalReference = cleanText(body?.approvalReference, 180)
    const approvalNote = cleanText(body?.approvalNote, 700)

    const payment = await db.payment.findUnique({
      where: { id },
      include: {
        admission: { include: { programRef: true } },
        enrollment: { include: { program: true } },
        agent: true,
        proofs: {
          select: { id: true, status: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    })
    if (!payment) return NextResponse.json({ error: 'الفاتورة غير موجودة' }, { status: 404 })

    if (action === 'REFRESH_AMOUNT') {
      if (payment.status !== 'UNPAID') {
        return NextResponse.json({ error: 'لا يمكن تحديث مبلغ فاتورة مدفوعة. الفواتير المسددة تبقى كما صدرت.' }, { status: 400 })
      }
      // فاتورة عليها إعفاء معتمد: إعادة حساب المبلغ من قواعد السعر الحالية
      // يجب أن تحترم المبلغ المعفى — تجاهله كان يعيد المستحق إلى السعر
      // الكامل ويجعل «المعفى + المستحق» أكبر من أصل الفاتورة. المنحة
      // الكاملة المعتمدة على فاتورة غير مسددة حالة لا يعرّفها مسار الإعفاء
      // (المنحة تجعل الفاتورة WAIVED أصلاً) فنرفض التحديث بدل تخمين معناه.
      const waivedCents = payment.waivedAmountCents ?? dollarsToCents(Number(payment.waivedAmount || 0))
      const hasApprovedWaiver = payment.waiverStatus === 'APPROVED' || payment.waiverStatus === 'PROGRAM_APPLIED'
      if (hasApprovedWaiver && payment.waiverType === 'FULL_SCHOLARSHIP') {
        return NextResponse.json({ error: 'لا يمكن تحديث مبلغ فاتورة خاضعة لمنحة كاملة معتمدة. ألغِ الإعفاء أولاً إذا أردت إعادة تسعير الفاتورة.' }, { status: 400 })
      }
      const waiverAware = hasApprovedWaiver && waivedCents > 0
      const resolved = await resolveCurrentInvoiceAmount(payment)
      if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 })

      const oldAmount = roundMoney(Number(payment.amount || 0))
      const newTotalCents = dollarsToCents(roundMoney(resolved.amount))
      const newAmountCents = waiverAware ? Math.max(0, newTotalCents - waivedCents) : newTotalCents
      const newAmount = roundMoney(newAmountCents / 100)
      const oldAmountCents = payment.amountCents ?? dollarsToCents(oldAmount)
      const changed = oldAmountCents !== newAmountCents

      // قاعدة محسومة لا تُعاد مناقشتها: مبلغ الإعفاء المعتمد جزء من عقد
      // الفاتورة، وإعادة تسعير تجعل الإجمالي الجديد يساوي المعفى أو يقل
      // عنه تترك «معفى أكبر من الأصل» أو فاتورة مستحقها صفر بحالة
      // UNPAID — وكلاهما حالة مالية غير متسقة. الرفض هنا قبل فرع
      // المعاينة حتى ترى المعاينة (dryRun) الرفض نفسه الذي يراه التنفيذ.
      if (waiverAware && newTotalCents <= waivedCents) {
        return NextResponse.json({ error: 'لا يمكن تحديث مبلغ الفاتورة إلى مبلغ يساوي الإعفاء المعتمد أو يقل عنه. ألغِ الإعفاء أو عدّله أولاً إذا أردت إعادة تسعير الفاتورة.' }, { status: 400 })
      }

      if (body?.dryRun) {
        return NextResponse.json({ ok: true, changed, oldAmount, newAmount, oldAmountCents, newAmountCents, source: resolved.source, ...(waiverAware ? { waivedAmountCents: waivedCents, newTotalCents } : {}) })
      }

      const reason = cleanText(body?.reason, 700)
      if (reason.length < 6) {
        return NextResponse.json({ error: 'تحديث مبلغ الفاتورة يحتاج سبباً واضحاً لا يقل عن 6 أحرف.' }, { status: 400 })
      }
      if (!changed) {
        return NextResponse.json({ ok: true, changed: false, oldAmount, newAmount, payment })
      }

      // الكتابة داخل معاملة تقفل صف الفاتورة أولاً وتعيد التحقق من
      // الحالة المرصودة عند قراءة المسار: القراءة الأولى تمت خارج أي
      // قفل، فتأكيد نقدي أو اعتماد/تعديل إعفاء متزامن بين القراءة
      // والكتابة يجب ألا يُكتب فوقه. أي تغيّر في الحالة أو مبلغ الإعفاء
      // أو المستحق المرصود ⇒ 409 ولا كتابة.
      let updated: any
      try {
        updated = await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${payment.id} FOR UPDATE`
          const fresh = await tx.payment.findUnique({ where: { id: payment.id } })
          const freshWaivedCents = fresh ? (fresh.waivedAmountCents ?? dollarsToCents(Number(fresh.waivedAmount || 0))) : null
          const freshAmountCents = fresh ? (fresh.amountCents ?? dollarsToCents(roundMoney(Number(fresh.amount || 0)))) : null
          if (!fresh || fresh.status !== 'UNPAID' || freshWaivedCents !== waivedCents || freshAmountCents !== oldAmountCents) {
            throw new RefreshAmountConflictError()
          }
          return tx.payment.update({
            where: { id: payment.id },
            data: waiverAware
              ? {
                  amount: newAmount,
                  amountCents: newAmountCents,
                  originalAmount: roundMoney(newTotalCents / 100),
                  originalAmountCents: newTotalCents,
                }
              : {
                  amount: newAmount,
                  amountCents: newAmountCents,
                },
          })
        })
      } catch (e: any) {
        if (e instanceof RefreshAmountConflictError || e?.code === 'REFRESH_AMOUNT_CONFLICT') {
          return NextResponse.json({ error: e.message, code: 'REFRESH_AMOUNT_CONFLICT' }, { status: 409 })
        }
        throw e
      }

      await audit(
        admin,
        'REFRESH_PAYMENT_AMOUNT',
        'Payment',
        id,
        `تحديث مبلغ فاتورة غير مدفوعة ${payment.invoiceNo}: من ${oldAmount}$ إلى ${newAmount}$ — المصدر: ${resolved.source} — السبب: ${reason}${waiverAware ? ` — مع الحفاظ على مبلغ معفى معتمد ${roundMoney(waivedCents / 100)}$ من إجمالي جديد ${roundMoney(newTotalCents / 100)}$` : ''}`
      )

      return NextResponse.json({ ok: true, changed: true, oldAmount, newAmount, payment: updated })
    }

    if (payment.status === 'PAID') return NextResponse.json({ ok: true, payment })
    if (payment.status === 'WAIVED') return NextResponse.json({ error: 'الفاتورة معفاة ولا يمكن تحويلها إلى مدفوعة. ألغِ الإعفاء أولاً إذا أردت إعادة فتح الفاتورة.' }, { status: 400 })
    if (!payment.method) {
      return NextResponse.json({ error: 'لا يمكن تأكيد الفاتورة قبل أن يختار الطالب طريقة الدفع من بوابة الطالب.' }, { status: 400 })
    }
    if (payment.method === 'USDT') {
      const hasTx = !!payment.cryptoTxHash
      const canManualReview = hasTx && payment.cryptoVerificationStatus === 'UNSUPPORTED'
      if (payment.cryptoVerificationStatus !== 'VERIFIED' && !canManualReview) {
        return NextResponse.json({ error: 'لا يمكن تأكيد دفع USDT قبل إدخال TX Hash والتحقق الأولي منه. الشبكات غير المدعومة آلياً يمكن اعتمادها يدوياً بعد وجود TxID واضح.' }, { status: 400 })
      }
    }

    const proofCount = payment.proofs.length
    const pendingProofs = payment.proofs.filter((proof) => proof.status === 'PENDING')
    if (isManualPaymentMethod(payment.method, payment.provider) && pendingProofs.length > 0) {
      return NextResponse.json({ error: 'إثبات الدفع بانتظار مراجعة الإدارة. استخدم زر قبول الإثبات لتسوية الفاتورة أو زر الرفض مع سبب واضح.' }, { status: 409 })
    }
    const reviewableProofs = payment.proofs.filter((proof) => proof.status === 'ACCEPTED')
    const hasReviewableProof = reviewableProofs.length > 0
    const effectiveApprovalReference = approvalReference || payment.manualApprovalReference || ''
    const effectiveApprovalNote = approvalNote || payment.manualApprovalNote || ''
    const hasAdminEvidence = effectiveApprovalReference.length >= 3
    const hasCryptoReference = payment.method === 'USDT' && !!payment.cryptoTxHash

    if (payment.method === 'DIRECT_PAYMENT' && effectiveApprovalNote.length < 6) {
      return NextResponse.json({ error: 'اعتماد الدفع المباشر يحتاج ملاحظة إدارية واضحة توضّح أساس الاعتماد.' }, { status: 400 })
    }

    if (isManualPaymentMethod(payment.method, payment.provider) && !hasReviewableProof && !hasAdminEvidence && !hasCryptoReference) {
      const rejectedOnly = proofCount > 0
      return NextResponse.json({
        error: rejectedOnly
          ? 'لا يمكن اعتماد الدفع اليدوي لأن كل إثباتات الدفع المرفوعة مرفوضة. أرفق إثباتاً جديداً أو اكتب مرجعاً/ملاحظة إدارية واضحة.'
          : 'قبل اعتماد الدفع اليدوي أرفق إثبات دفع داخل المنصة، أو اكتب رقم حوالة/ملاحظة إدارية واضحة.',
      }, { status: 400 })
    }

    if (approvalReference || approvalNote || hasCryptoReference) {
      await db.payment.update({
        where: { id: payment.id },
        data: {
          manualApprovalReference: approvalReference || (hasCryptoReference ? payment.cryptoTxHash : payment.manualApprovalReference || null),
          manualApprovalNote: approvalNote || payment.manualApprovalNote || null,
        },
      })
    }

    const confirmMethod = payment.method === 'DIRECT_PAYMENT' ? 'DIRECT_PAYMENT' : payment.method === 'USDT' ? 'USDT' : 'BANK_TRANSFER'
    const r = await markInvoicePaid(payment.invoiceNo, confirmMethod, {
      actor: { id: admin.id, name: admin.name },
    })
    if (!r.ok) return NextResponse.json({ error: r.error || 'تعذر تأكيد السداد' }, { status: 400 })

    await audit(
      admin,
      'CONFIRM_PAYMENT',
      'Payment',
      id,
      `${r.receiptNo} — ${payment.description} (${payment.amount}$) [تأكيد إداري يدوي${hasReviewableProof ? ` · إثباتات قابلة للمراجعة: ${reviewableProofs.length}/${proofCount}` : ''}${approvalReference || hasCryptoReference ? ` · مرجع: ${approvalReference || payment.cryptoTxHash}` : ''}${approvalNote ? ` · ملاحظة: ${approvalNote}` : ''}]`
    )
    return NextResponse.json({ ok: true, payment: r.payment, receiptNo: r.receiptNo })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin payments PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تنفيذ العملية على الفاتورة' }, { status: 500 })
  }
}
