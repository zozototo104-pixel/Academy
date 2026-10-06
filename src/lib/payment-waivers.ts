import { createHash, randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { audit, notify } from '@/lib/notify'
import { dollarsToCents, paymentAmountCents, centsToDollars } from '@/lib/money'
import { getSettings, nextInvoiceNo } from '@/lib/settings'

export const PAYMENT_WAIVER_TYPES = ['APPLICATION_FEE', 'PARTIAL_TUITION', 'FULL_SCHOLARSHIP'] as const
export type PaymentWaiverType = typeof PAYMENT_WAIVER_TYPES[number]

export function isPaymentWaiverType(value: unknown): value is PaymentWaiverType {
  return PAYMENT_WAIVER_TYPES.includes(String(value || '') as PaymentWaiverType)
}

export function hashWaiverCode(code: string) {
  return createHash('sha256').update(String(code || '').trim().toUpperCase()).digest('hex')
}

export function generateWaiverCode() {
  const raw = randomBytes(10).toString('hex').toUpperCase()
  return `AACT-WV-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 20)}`
}

export function codePreview(code: string) {
  const value = String(code || '').trim().toUpperCase()
  return value ? `••••-${value.slice(-4)}` : '••••'
}

export function isSettledPayment(status?: string | null) {
  return status === 'PAID' || status === 'WAIVED'
}

function cleanReason(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 700)
}

export async function createPaymentWaiverCode(params: {
  paymentId: string
  waiverType: PaymentWaiverType
  reason: string
  requestedAmount?: number | null
  actor?: { id?: string | null; name: string } | null
  expiresDays?: number | null
}) {
  const payment = await db.payment.findUnique({ where: { id: params.paymentId } })
  if (!payment) throw new Error('الفاتورة غير موجودة')
  if (payment.status === 'PAID') throw new Error('لا يمكن إصدار إعفاء لفاتورة مسددة فعلياً')
  if (payment.status === 'WAIVED') throw new Error('هذه الفاتورة معفاة مسبقاً')

  const purpose = String(payment.purpose || '').toUpperCase()
  if (params.waiverType === 'APPLICATION_FEE' && purpose !== 'APPLICATION_FEE') {
    throw new Error('إعفاء رسوم التقديم مسموح لفاتورة رسوم التقديم فقط')
  }
  if (params.waiverType === 'PARTIAL_TUITION' && !['TUITION', 'TUITION_INSTALLMENT'].includes(purpose)) {
    throw new Error('الإعفاء الجزئي مسموح لفواتير الرسوم الدراسية فقط')
  }
  if (params.waiverType === 'FULL_SCHOLARSHIP' && !['TUITION', 'TUITION_INSTALLMENT', 'APPLICATION_FEE'].includes(purpose)) {
    throw new Error('المنحة الكاملة مسموحة لفواتير التقديم أو الرسوم الدراسية فقط')
  }

  const reason = cleanReason(params.reason)
  if (reason.length < 6) throw new Error('سبب الإعفاء مطلوب ولا يقل عن 6 أحرف')

  const currentCents = paymentAmountCents(payment)
  let requestedAmountCents: number | null = null
  if (params.waiverType === 'PARTIAL_TUITION') {
    requestedAmountCents = dollarsToCents(params.requestedAmount ?? 0)
    if (requestedAmountCents <= 0) throw new Error('مبلغ الإعفاء الجزئي يجب أن يكون أكبر من صفر')
    if (requestedAmountCents >= currentCents) throw new Error('الإعفاء الجزئي يجب أن يكون أقل من المبلغ المتبقي. استخدم منحة كاملة للإعفاء الكامل.')
  }

  await db.paymentWaiverCode.updateMany({
    where: { paymentId: payment.id, status: { in: ['ISSUED', 'VERIFIED'] } },
    data: { status: 'CANCELLED' },
  })

  const code = generateWaiverCode()
  const expiresDays = Number(params.expiresDays || 7)
  const expiresAt = new Date(Date.now() + Math.max(1, Math.min(60, expiresDays)) * 24 * 60 * 60 * 1000)
  const waiver = await db.paymentWaiverCode.create({
    data: {
      paymentId: payment.id,
      codeHash: hashWaiverCode(code),
      codePreview: codePreview(code),
      waiverType: params.waiverType,
      requestedAmount: requestedAmountCents === null ? null : centsToDollars(requestedAmountCents),
      requestedAmountCents,
      reason,
      issuedById: params.actor?.id || null,
      expiresAt,
    },
  })

  await db.payment.update({
    where: { id: payment.id },
    data: {
      waiverType: params.waiverType,
      waiverStatus: 'REQUESTED',
      waiverReason: reason,
      originalAmount: payment.originalAmount ?? payment.amount,
      originalAmountCents: payment.originalAmountCents ?? currentCents,
    },
  })

  await audit(params.actor || { name: 'Admin' }, 'PAYMENT_WAIVER_CODE_CREATED', 'Payment', payment.id, `${payment.invoiceNo} — ${params.waiverType} — ${waiver.codePreview}`)
  return { code, waiver }
}

export async function verifyPaymentWaiverCode(params: { paymentId: string; code: string; user: { id: string; email?: string | null; name?: string | null; emailVerifiedAt?: Date | string | null } }) {
  const payment = await db.payment.findUnique({
    where: { id: params.paymentId },
    include: { admission: { select: { id: true, userId: true, email: true, fullName: true, reference: true } }, enrollment: { select: { userId: true } } },
  })
  if (!payment) throw new Error('الفاتورة غير موجودة')
  const ownsPayment = payment.userId === params.user.id
    || payment.enrollment?.userId === params.user.id
    || payment.admission?.userId === params.user.id
    || (!!params.user.emailVerifiedAt && !!payment.admission?.email && payment.admission.email.trim().toLowerCase() === String(params.user.email || '').trim().toLowerCase())
  if (!ownsPayment) throw new Error('هذا الكود لا يخص هذه الفاتورة')
  if (payment.status === 'PAID') throw new Error('الفاتورة مسددة مسبقاً')
  if (payment.status === 'WAIVED') throw new Error('الفاتورة معفاة مسبقاً')

  const codeHash = hashWaiverCode(params.code)
  const waiver = await db.paymentWaiverCode.findFirst({ where: { paymentId: payment.id, codeHash, status: 'ISSUED' } })
  if (!waiver) throw new Error('كود الإعفاء غير صحيح أو تم استخدامه')
  if (waiver.expiresAt && waiver.expiresAt < new Date()) {
    await db.paymentWaiverCode.update({ where: { id: waiver.id }, data: { status: 'EXPIRED' } })
    throw new Error('انتهت صلاحية كود الإعفاء')
  }

  const updated = await db.paymentWaiverCode.update({
    where: { id: waiver.id },
    data: { status: 'VERIFIED', verifiedById: params.user.id, verifiedAt: new Date() },
  })
  await db.payment.update({ where: { id: payment.id }, data: { waiverStatus: 'VERIFIED', waiverType: waiver.waiverType, waiverReason: waiver.reason } })

  const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
  for (const admin of admins) {
    await notify(admin.id, 'PAYMENT', 'كود إعفاء بانتظار الاعتماد', `${payment.invoiceNo} — أدخل الطالب كود إعفاء صحيحاً (${updated.codePreview}). راجع الفاتورة واعتمد الإعفاء إن كان القرار صحيحاً.`, 'admin')
  }

  await audit({ id: params.user.id, name: params.user.name || params.user.email || 'Student' }, 'PAYMENT_WAIVER_CODE_VERIFIED', 'Payment', payment.id, `${payment.invoiceNo} — ${updated.codePreview}`)
  return updated
}

async function applyAdmissionWaiverEffects(payment: any, actor: { id?: string | null; name: string }) {
  if (!payment.admissionId) return
  const app = await db.admissionApplication.findUnique({ where: { id: payment.admissionId } })
  if (!app) return

  let linkedUserId = app.userId
  if (!linkedUserId && app.email) {
    const matchedUser = await db.user.findUnique({ where: { email: app.email.trim().toLowerCase() }, select: { id: true, role: true } }).catch(() => null)
    if (matchedUser?.role === 'STUDENT') {
      linkedUserId = matchedUser.id
      await db.admissionApplication.update({ where: { id: app.id }, data: { userId: linkedUserId } }).catch((error) => { console.warn('Failed to link admission user during waiver approval.', error) })
    }
  }
  if (linkedUserId) {
    await db.payment.updateMany({ where: { admissionId: app.id, OR: [{ userId: null }, { NOT: { userId: linkedUserId } }] }, data: { userId: linkedUserId } }).catch((error) => { console.warn('Failed to link admission payments during waiver approval.', error) })
  }

  const all = await db.payment.findMany({ where: { admissionId: app.id } })
  const allSettled = all.every((p) => isSettledPayment(p.status))
  const applicationFeeSettled = all.some((p) => p.purpose === 'APPLICATION_FEE' && isSettledPayment(p.status))

  if (applicationFeeSettled && app.status === 'AWAITING_FEE') {
    await db.admissionApplication.update({ where: { id: app.id }, data: { status: 'UNDER_REVIEW' } })
    const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
    for (const admin of admins) {
      await notify(admin.id, 'ADMISSION', 'طلب التحاق بانتظار الدراسة بعد إعفاء الرسوم', `تم اعتماد إعفاء رسوم التقديم للمتقدم ${app.fullName} (${app.reference}) — برنامج: ${app.program}.`, 'admin')
    }
    if (linkedUserId) {
      await notify(linkedUserId, 'PAYMENT', 'تم اعتماد إعفاء رسوم التقديم', `تم إعفاؤك من رسوم التقديم لطلب ${app.reference}. أصبح ملفك بانتظار دراسة الإدارة.`, 'dashboard')
    }
    await audit(actor, 'APPLICATION_FEE_WAIVED', 'AdmissionApplication', app.id, `${app.reference} — ${payment.invoiceNo}`)
  }

  if (allSettled && app.status === 'AWAITING_TUITION') {
    const newStatus = app.supervisorId ? 'THESIS' : 'SUPERVISOR_ASSIGNED'
    await db.admissionApplication.update({ where: { id: app.id }, data: { status: newStatus } })
    if (app.programId && linkedUserId) {
      const existingEnrollment = await db.enrollment.findUnique({ where: { userId_programId: { userId: linkedUserId, programId: app.programId } } })
      if (!existingEnrollment) await db.enrollment.create({ data: { userId: linkedUserId, programId: app.programId, status: 'ACTIVE' } })
    }
    if (linkedUserId) {
      await notify(linkedUserId, 'ADMISSION', 'تم تفعيل تسجيلك بمنحة/إعفاء', `تم اعتماد الإعفاء المالي المطلوب وأصبح تسجيلك في «${app.program}» فعالاً.`, 'dashboard')
    }
    await audit(actor, 'FINAL_REGISTRATION_BY_WAIVER', 'AdmissionApplication', app.id, `${app.reference} — ${payment.invoiceNo}`)
  }
}

export async function approvePaymentWaiver(params: { waiverId: string; actor: { id?: string | null; name: string } }) {
  const waiver = await db.paymentWaiverCode.findUnique({ where: { id: params.waiverId }, include: { payment: true } })
  if (!waiver) throw new Error('كود الإعفاء غير موجود')
  if (!['VERIFIED', 'ISSUED'].includes(waiver.status)) throw new Error('لا يمكن اعتماد هذا الكود بحالته الحالية')
  const payment = waiver.payment
  if (payment.status === 'PAID') throw new Error('لا يمكن إعفاء فاتورة مسددة فعلياً')
  if (payment.status === 'WAIVED') throw new Error('الفاتورة معفاة مسبقاً')

  const currentCents = paymentAmountCents(payment)
  const originalCents = payment.originalAmountCents ?? currentCents
  const waiveCents = waiver.waiverType === 'PARTIAL_TUITION'
    ? Math.min(Number(waiver.requestedAmountCents || 0), currentCents - 1)
    : currentCents
  if (waiveCents <= 0) throw new Error('مبلغ الإعفاء غير صالح')
  const remainingCents = Math.max(0, currentCents - waiveCents)
  const isFull = remainingCents === 0

  const updatedPayment = await db.payment.update({
    where: { id: payment.id },
    data: {
      status: isFull ? 'WAIVED' : 'UNPAID',
      waiverType: waiver.waiverType,
      waiverStatus: 'APPROVED',
      waiverReason: waiver.reason,
      waivedAmount: centsToDollars((payment.waivedAmountCents || 0) + waiveCents),
      waivedAmountCents: (payment.waivedAmountCents || 0) + waiveCents,
      originalAmount: payment.originalAmount ?? payment.amount,
      originalAmountCents: originalCents,
      amount: centsToDollars(remainingCents),
      amountCents: remainingCents,
      waiverApprovedById: params.actor.id || null,
      waiverApprovedAt: new Date(),
    },
  })
  await db.paymentWaiverCode.update({ where: { id: waiver.id }, data: { status: 'APPROVED', approvedById: params.actor.id || null, approvedAt: new Date() } })

  if (isFull) await applyAdmissionWaiverEffects(updatedPayment, params.actor)
  await audit(params.actor, 'PAYMENT_WAIVER_APPROVED', 'Payment', payment.id, `${payment.invoiceNo} — ${waiver.waiverType} — ${centsToDollars(waiveCents).toFixed(2)}$`)
  return updatedPayment
}
