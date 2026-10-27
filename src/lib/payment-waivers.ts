import { createHash, randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { audit, notify } from '@/lib/notify'
import { dollarsToCents, paymentAmountCents, centsToDollars } from '@/lib/money'
import { getSettings, nextInvoiceNo } from '@/lib/settings'
import { emailPaymentWaiverCode, isEmailDeliveryConfigured } from '@/lib/mailer'
import { finalizeAdmissionAfterSettlement } from '@/lib/settle-payment'
import { sendOfficialWhatsAppHumanFollowup, sendOfficialWhatsAppText } from '@/lib/whatsapp-cloud'
import { hashWhatsAppId, recordWhatsAppOutboundMessage } from '@/lib/whatsapp-conversations'

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

function waiverTypeLabel(type: string) {
  if (type === 'APPLICATION_FEE') return 'إعفاء رسوم التقديم'
  if (type === 'PARTIAL_TUITION') return 'إعفاء جزئي من الرسوم'
  if (type === 'FULL_SCHOLARSHIP') return 'منحة كاملة'
  return 'إعفاء مالي'
}

export async function applyScholarshipToNewInvoiceData(tx: any, data: any) {
  const purpose = String(data?.purpose || '').toUpperCase()
  if (!data?.admissionId || !['TUITION', 'TUITION_INSTALLMENT'].includes(purpose)) return data
  const app = await tx.admissionApplication.findUnique({
    where: { id: data.admissionId },
    select: { scholarshipFull: true },
  }).catch(() => null)
  if (!app?.scholarshipFull) return data

  const originalAmountCents = Number(data.amountCents ?? dollarsToCents(Number(data.amount || 0)))
  const originalAmount = Number(data.amount ?? centsToDollars(originalAmountCents))
  return {
    ...data,
    status: 'WAIVED',
    originalAmount,
    originalAmountCents,
    waivedAmount: originalAmount,
    waivedAmountCents: originalAmountCents,
    amount: 0,
    amountCents: 0,
    waiverType: 'FULL_SCHOLARSHIP',
    waiverStatus: 'APPROVED',
    waiverReason: data.waiverReason || 'منحة كاملة معتمدة مسبقاً لهذا الطلب',
    waiverApprovedAt: data.waiverApprovedAt || new Date(),
  }
}

async function resolveWaiverEmailRecipient(paymentId: string) {
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: {
      user: { select: { id: true, email: true, name: true, phone: true } },
      admission: { select: { id: true, userId: true, email: true, fullName: true, phone: true } },
      enrollment: { include: { user: { select: { id: true, email: true, name: true, phone: true } } } },
      agent: { select: { email: true, repName: true, orgName: true } },
    },
  })
  if (!payment) return null
  const email = payment.payerEmail || payment.user?.email || payment.admission?.email || payment.enrollment?.user?.email || payment.agent?.email || ''
  const name = payment.payerName || payment.user?.name || payment.admission?.fullName || payment.enrollment?.user?.name || payment.agent?.repName || payment.agent?.orgName || 'الطالب'
  const userId = payment.user?.id || payment.admission?.userId || payment.enrollment?.user?.id || null
  const phone = payment.user?.phone || payment.enrollment?.user?.phone || payment.admission?.phone || ''
  return { email: email && email.includes('@') ? email : '', name, userId, phone, invoiceNo: payment.invoiceNo, description: payment.description }
}

function addMonths(date: Date, months: number) {
  const next = new Date(date)
  next.setMonth(next.getMonth() + months)
  return next
}

async function resolveAdmissionTuitionCents(app: any) {
  const program = app.programId
    ? await db.program.findUnique({ where: { id: app.programId }, select: { price: true, category: true } })
    : await db.program.findFirst({ where: { titleAr: { contains: String(app.program || '').split(' — ')[0] } }, select: { price: true, category: true } })
  if (program?.category === 'SERVICE') return 0
  let tuition = Number(program?.price || 0)
  if (!tuition) {
    const settings = await getSettings()
    if (String(app.program || '').includes('دكتوراة') || String(app.program || '').includes('دكتوراه')) tuition = parseFloat(settings.FEE_DOCTORATE || '1300')
    else if (app.education === 'MASTER') tuition = parseFloat(settings.FEE_MASTERS || '700')
    else tuition = parseFloat(settings.FEE_DIPLOMAS_MAX || '350')
  }
  return dollarsToCents(tuition || 0)
}

async function ensureTuitionInvoiceWithWaiverCredit(params: {
  app: any
  creditCents: number
  fullScholarship: boolean
  waiverType: PaymentWaiverType
  reason: string
  actor: { id?: string | null; name: string }
}) {
  const tuitionCents = await resolveAdmissionTuitionCents(params.app)
  if (tuitionCents <= 0) return null

  const existing = await db.payment.findFirst({ where: { admissionId: params.app.id, purpose: 'TUITION' }, orderBy: { createdAt: 'asc' } })
  const existingOriginalCents = existing?.originalAmountCents || existing?.amountCents || tuitionCents
  const originalCents = Math.max(existingOriginalCents, tuitionCents)
  const alreadyWaivedCents = existing?.waivedAmountCents || 0
  const currentRemainingCents = existing ? paymentAmountCents(existing) : originalCents
  const creditCents = params.fullScholarship ? currentRemainingCents : Math.max(0, Math.min(params.creditCents, currentRemainingCents))
  const nextWaivedCents = alreadyWaivedCents + creditCents
  const nextRemainingCents = Math.max(0, currentRemainingCents - creditCents)

  const data = {
    userId: params.app.userId || null,
    purpose: 'TUITION',
    description: `الرسوم الدراسية الكاملة للدخول للبرنامج — ${params.app.program}`,
    amount: centsToDollars(nextRemainingCents),
    amountCents: nextRemainingCents,
    status: nextRemainingCents === 0 ? 'WAIVED' : 'UNPAID',
    waiverType: params.waiverType,
    waiverStatus: 'APPROVED',
    waiverReason: params.reason,
    waivedAmount: centsToDollars(nextWaivedCents),
    waivedAmountCents: nextWaivedCents,
    originalAmount: centsToDollars(originalCents),
    originalAmountCents: originalCents,
    waiverApprovedById: params.actor.id || null,
    waiverApprovedAt: new Date(),
    payerName: params.app.fullName,
    payerEmail: params.app.email,
    payerCountry: params.app.country,
  }

  if (existing) {
    return db.payment.update({ where: { id: existing.id }, data })
  }
  const newInvoiceData = await applyScholarshipToNewInvoiceData(db, {
    admissionId: params.app.id,
    invoiceNo: await nextInvoiceNo(),
    ...data,
  })
  return db.payment.create({
    data: newInvoiceData,
  })
}

async function moveAdmissionToTuitionStage(app: any, actor: { id?: string | null; name: string }) {
  if (!app.approvedAt) {
    const settings = await getSettings()
    await db.admissionApplication.update({
      where: { id: app.id },
      data: {
        status: 'AWAITING_TUITION',
        approvedAt: new Date(),
        thesisDeadline: addMonths(new Date(), parseInt(settings.THESIS_MAX_MONTHS || '6')),
      },
    })
  } else if (!['AWAITING_TUITION', 'SUPERVISOR_ASSIGNED', 'THESIS', 'SCHEDULED', 'RESULT_APPROVED', 'CERTIFIED'].includes(String(app.status || ''))) {
    await db.admissionApplication.update({ where: { id: app.id }, data: { status: 'AWAITING_TUITION' } })
  }
  await audit(actor, 'ADMISSION_TUITION_STAGE_BY_WAIVER', 'AdmissionApplication', app.id, `${app.reference} — أُتيحت متابعة الرسوم بعد الإعفاء`)
}

export class ActivePaymentWaiverExistsError extends Error {
  status = 409
  code = 'ACTIVE_WAIVER_EXISTS'

  constructor(codePreviewValue: string) {
    super(`يوجد كود إعفاء نشط لهذه الفاتورة (${codePreviewValue}). استخدمه أو اعتمده قبل توليد كود جديد.`)
  }
}

export class PaymentWaiverRateLimitError extends Error {
  status = 429
  code = 'WAIVER_CODE_RATE_LIMITED'

  constructor() {
    super('تم تجاوز عدد محاولات إدخال كود الإعفاء لهذه الفاتورة. حاول مرة أخرى بعد ساعة.')
  }
}

export class UsedPaymentWaiverCodeError extends Error {
  status = 409
  code = 'WAIVER_CODE_ALREADY_USED'

  constructor() {
    super('الكود مستخدم أو لم يعد صالحاً لهذه الفاتورة')
  }
}

async function deliverWaiverCode(params: { payment: any; waiverType: string; reason: string; code: string; isResend: boolean }) {
  const recipient = await resolveWaiverEmailRecipient(params.payment.id).catch((error) => { console.warn('Failed to resolve waiver code recipient.', error); return null })
  const waiverLink = `/?view=dashboard&tab=payments&invoice=${encodeURIComponent(params.payment.invoiceNo)}&waiver=1`
  const emailConfigured = await isEmailDeliveryConfigured().catch(() => false)
  let emailStatus: 'SENT' | 'FAILED' | 'SKIPPED' = recipient?.email && emailConfigured ? 'FAILED' : 'SKIPPED'
  if (recipient?.email && emailConfigured) {
    try {
      const sent = await emailPaymentWaiverCode(recipient.email, {
        name: recipient.name,
        invoiceNo: recipient.invoiceNo,
        description: recipient.description,
        code: params.code,
        waiverLabel: waiverTypeLabel(params.waiverType),
        reason: params.reason,
        link: waiverLink,
      })
      emailStatus = sent ? 'SENT' : 'FAILED'
    } catch (error) {
      emailStatus = 'FAILED'
      console.warn('Failed to send payment waiver code email.', error)
    }
  }
  await notify(
    recipient?.userId || null,
    'PAYMENT',
    params.isResend ? 'لديك كود إعفاء جديد من الإدارة' : 'لديك كود إعفاء من الإدارة',
    `${waiverTypeLabel(params.waiverType)} مرتبط بالفاتورة ${params.payment.invoiceNo}. افتح الدفعات وأدخل الكود المرسل إلى بريدك أو الذي زودتك به الإدارة.`,
    waiverLink
  )
  return { emailStatus, waiverLink, recipient }
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
  if (params.waiverType === 'PARTIAL_TUITION' && !['APPLICATION_FEE', 'TUITION', 'TUITION_INSTALLMENT'].includes(purpose)) {
    throw new Error('الإعفاء الجزئي مسموح لفواتير رسوم التقديم أو الرسوم الدراسية فقط')
  }
  if (params.waiverType === 'FULL_SCHOLARSHIP' && !['APPLICATION_FEE', 'TUITION', 'TUITION_INSTALLMENT'].includes(purpose)) {
    throw new Error('المنحة الكاملة مسموحة لفواتير التقديم أو الرسوم الدراسية فقط')
  }

  const reason = cleanReason(params.reason)
  if (reason.length < 6) throw new Error('سبب الإعفاء مطلوب ولا يقل عن 6 أحرف')

  const currentCents = paymentAmountCents(payment)
  let requestedAmountCents: number | null = null
  if (params.waiverType === 'PARTIAL_TUITION') {
    requestedAmountCents = dollarsToCents(params.requestedAmount ?? 0)
    if (requestedAmountCents <= 0) throw new Error('مبلغ الإعفاء الجزئي يجب أن يكون أكبر من صفر')
    if (purpose === 'APPLICATION_FEE' && requestedAmountCents <= currentCents) throw new Error('للإعفاء الجزئي من فاتورة التقديم أدخل مبلغاً أكبر من رسوم التقديم حتى يخصم الباقي من الرسوم الدراسية.')
  }

  const code = generateWaiverCode()
  const expiresDays = Number(params.expiresDays || 7)
  const expiresAt = new Date(Date.now() + Math.max(1, Math.min(60, expiresDays)) * 24 * 60 * 60 * 1000)

  const waiver = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${params.paymentId} FOR UPDATE`
    const activeWaiver = await tx.paymentWaiverCode.findFirst({
      where: { paymentId: params.paymentId, status: { in: ['ISSUED', 'VERIFIED'] } },
      orderBy: { createdAt: 'desc' },
    })
    if (activeWaiver) throw new ActivePaymentWaiverExistsError(activeWaiver.codePreview)

    return tx.paymentWaiverCode.create({
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
  const { emailStatus } = await deliverWaiverCode({ payment, waiverType: params.waiverType, reason, code, isResend: false })
  const savedWaiver = await db.paymentWaiverCode.update({
    where: { id: waiver.id },
    data: { emailStatus, emailSentAt: emailStatus === 'SENT' ? new Date() : null },
  })
  return { code, waiver: savedWaiver, emailStatus }
}

export type WaiverWhatsAppOutcome = 'sent' | 'template_pending' | 'skipped' | 'failed'

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000

function waiverWhatsAppDigits(phone: unknown) {
  const digits = String(phone || '').replace(/\D/g, '')
  return digits.length >= 8 && digits.length <= 15 ? digits : ''
}

async function sendWaiverCodeWhatsApp(params: {
  digits: string
  name: string
  code: string
  invoiceNo: string
  waiverLink: string
  actor: { id?: string | null; name: string }
}): Promise<WaiverWhatsAppOutcome> {
  if (!params.digits) return 'skipped'
  const conversation = await db.whatsAppConversation.findUnique({
    where: { waIdHash: hashWhatsAppId(params.digits) },
    select: { lastInboundAt: true },
  }).catch(() => null)
  const lastInboundAt = conversation?.lastInboundAt?.getTime() || 0
  const windowOpen = Boolean(lastInboundAt && Date.now() - lastInboundAt >= 0 && Date.now() - lastInboundAt < WHATSAPP_WINDOW_MS)
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://aactacademy.com').replace(/\/$/, '')
  const fullLink = params.waiverLink.startsWith('http') ? params.waiverLink : `${appUrl}${params.waiverLink}`
  try {
    if (windowOpen) {
      const text = `مرحباً ${params.name}، كود الإعفاء الجديد الخاص بك في أكاديمية AACT: ${params.code} — أدخله من بوابة الطالب ضمن بطاقة الفاتورة ${params.invoiceNo}: ${fullLink} — الكود صالح لمدة 7 أيام.`
      const result = await sendOfficialWhatsAppText(params.digits, text)
      await recordWhatsAppOutboundMessage({
        waId: params.digits,
        phoneNumberId: null,
        text,
        sender: 'HUMAN',
        whatsappMessageId: (result as any)?.messages?.[0]?.id || null,
        sentById: params.actor.id || null,
        sentByName: params.actor.name,
      }).catch(() => null)
      return 'sent'
    }
    const result = await sendOfficialWhatsAppHumanFollowup(params.digits, params.name)
    await recordWhatsAppOutboundMessage({
      waId: params.digits,
      phoneNumberId: null,
      text: `تم إرسال قالب المتابعة المعتمد human_followup_ar إلى ${params.name}. كود الإعفاء الجديد يُرسل عبر واتساب بعد أن يرد الطالب.`,
      sender: 'HUMAN',
      whatsappMessageId: (result as any)?.messages?.[0]?.id || null,
      sentById: params.actor.id || null,
      sentByName: params.actor.name,
    }).catch(() => null)
    return 'template_pending'
  } catch (error) {
    console.warn('Failed to send payment waiver code over WhatsApp.', error)
    return 'failed'
  }
}

export async function resendPaymentWaiverCode(params: {
  paymentId: string
  actor?: { id?: string | null; name: string } | null
}) {
  const payment = await db.payment.findUnique({ where: { id: params.paymentId } })
  if (!payment) throw new Error('الفاتورة غير موجودة')
  if (payment.status === 'PAID') throw new Error('لا يمكن إعادة إرسال إعفاء لفاتورة مسددة فعلياً')
  if (payment.status === 'WAIVED') throw new Error('هذه الفاتورة معفاة مسبقاً')

  const { oldWaiver, waiver, code } = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${params.paymentId} FOR UPDATE`
    const verified = await tx.paymentWaiverCode.findFirst({ where: { paymentId: params.paymentId, status: 'VERIFIED' } })
    if (verified) throw new Error('الكود مدخل من الطالب وبانتظار الاعتماد — لا يمكن إعادة إرساله')
    const issued = await tx.paymentWaiverCode.findFirst({ where: { paymentId: params.paymentId, status: 'ISSUED' }, orderBy: { createdAt: 'desc' } })
    if (!issued) throw new Error('لا يوجد كود إعفاء نشط بانتظار إدخال الطالب لهذه الفاتورة')
    const cancelled = await tx.paymentWaiverCode.updateMany({ where: { id: issued.id, status: 'ISSUED' }, data: { status: 'CANCELLED' } })
    if (cancelled.count === 0) throw new Error('تغيرت حالة الكود أثناء المعالجة — حاول مرة أخرى')
    const nextCode = generateWaiverCode()
    const created = await tx.paymentWaiverCode.create({
      data: {
        paymentId: payment.id,
        codeHash: hashWaiverCode(nextCode),
        codePreview: codePreview(nextCode),
        waiverType: issued.waiverType,
        requestedAmount: issued.requestedAmount ?? null,
        requestedAmountCents: issued.requestedAmountCents ?? null,
        reason: issued.reason,
        issuedById: params.actor?.id || null,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    })
    return { oldWaiver: issued, waiver: created, code: nextCode }
  })

  await db.payment.update({
    where: { id: payment.id },
    data: { waiverType: waiver.waiverType, waiverStatus: 'REQUESTED', waiverReason: waiver.reason },
  })
  await audit(params.actor || { name: 'Admin' }, 'PAYMENT_WAIVER_CODE_RESENT', 'Payment', payment.id, `${payment.invoiceNo} — ${oldWaiver.codePreview} → ${waiver.codePreview}`)
  const { emailStatus, waiverLink, recipient } = await deliverWaiverCode({ payment, waiverType: waiver.waiverType, reason: waiver.reason, code, isResend: true })
  const whatsapp = await sendWaiverCodeWhatsApp({
    digits: waiverWhatsAppDigits(recipient?.phone),
    name: recipient?.name || 'الطالب',
    code,
    invoiceNo: payment.invoiceNo,
    waiverLink,
    actor: params.actor || { name: 'Admin' },
  })
  const savedWaiver = await db.paymentWaiverCode.update({
    where: { id: waiver.id },
    data: { emailStatus, emailSentAt: emailStatus === 'SENT' ? new Date() : null },
  })
  return { code, waiver: savedWaiver, emailStatus, whatsapp }
}

type VerifyPaymentWaiverFailureReason = 'INVALID' | 'USED' | 'EXPIRED' | 'RATE_LIMIT'

type VerifyPaymentWaiverResult =
  | { ok: true; payment: any; updated: any }
  | { ok: false; reason: VerifyPaymentWaiverFailureReason; paymentId: string; userId: string }

function waiverVerificationError(reason: VerifyPaymentWaiverFailureReason) {
  if (reason === 'RATE_LIMIT') return new PaymentWaiverRateLimitError()
  if (reason === 'USED') return new UsedPaymentWaiverCodeError()
  if (reason === 'EXPIRED') return new Error('انتهت صلاحية كود الإعفاء')
  return new Error('كود الإعفاء غير صحيح')
}

export async function verifyPaymentWaiverCode(params: { paymentId: string; code: string; user: { id: string; email?: string | null; name?: string | null; emailVerifiedAt?: Date | string | null } }) {
  const result = await db.$transaction(async (tx): Promise<VerifyPaymentWaiverResult> => {
    const payment = await tx.payment.findUnique({
      where: { id: params.paymentId },
      include: { admission: { select: { id: true, userId: true, email: true, fullName: true, reference: true } }, enrollment: { select: { userId: true } } },
    })
    if (!payment) throw new Error('الفاتورة غير موجودة')
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${payment.id} FOR UPDATE`

    const ownsPayment = payment.userId === params.user.id
      || payment.enrollment?.userId === params.user.id
      || payment.admission?.userId === params.user.id
      || (!!params.user.emailVerifiedAt && !!payment.admission?.email && payment.admission.email.trim().toLowerCase() === String(params.user.email || '').trim().toLowerCase())
    if (!ownsPayment) throw new Error('هذا الكود لا يخص هذه الفاتورة')
    if (payment.status === 'PAID') throw new Error('الفاتورة مسددة مسبقاً')
    if (payment.status === 'WAIVED') throw new Error('الفاتورة معفاة مسبقاً')

    const failedResult = (reason: VerifyPaymentWaiverFailureReason): VerifyPaymentWaiverResult => ({
      ok: false,
      reason,
      paymentId: payment.id,
      userId: params.user.id,
    })
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const failedAttempts = await tx.paymentWaiverAttempt.count({
      where: { paymentId: payment.id, userId: params.user.id, success: false, createdAt: { gte: hourAgo } },
    })
    if (failedAttempts >= 5) return failedResult('RATE_LIMIT')

    const codeHash = hashWaiverCode(params.code)
    const waiver = await tx.paymentWaiverCode.findFirst({ where: { paymentId: payment.id, codeHash } })
    if (!waiver || waiver.status !== 'ISSUED') {
      return failedResult(waiver ? 'USED' : 'INVALID')
    }
    if (waiver.expiresAt && waiver.expiresAt < new Date()) {
      await tx.paymentWaiverCode.update({ where: { id: waiver.id }, data: { status: 'EXPIRED' } })
      return failedResult('EXPIRED')
    }

    const verifiedAt = new Date()
    const atomic = await tx.paymentWaiverCode.updateMany({
      where: { id: waiver.id, status: 'ISSUED' },
      data: { status: 'VERIFIED', verifiedById: params.user.id, verifiedAt },
    })
    if (atomic.count === 0) return failedResult('USED')
    await tx.paymentWaiverAttempt.create({ data: { paymentId: payment.id, userId: params.user.id, success: true } }).catch(() => null)
    const updated = await tx.paymentWaiverCode.findUniqueOrThrow({ where: { id: waiver.id } })
    await tx.payment.update({ where: { id: payment.id }, data: { waiverStatus: 'VERIFIED', waiverType: waiver.waiverType, waiverReason: waiver.reason } })
    return { ok: true, payment, updated }
  })

  if (!result.ok) {
    if (result.reason !== 'RATE_LIMIT') {
      await db.paymentWaiverAttempt.create({ data: { paymentId: result.paymentId, userId: result.userId, success: false } }).catch(() => null)
    }
    throw waiverVerificationError(result.reason)
  }

  const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
  for (const admin of admins) {
    await notify(admin.id, 'PAYMENT', 'كود إعفاء بانتظار الاعتماد', `${result.payment.invoiceNo} — أدخل الطالب كود إعفاء صحيحاً (${result.updated.codePreview}). راجع الفاتورة واعتمد الإعفاء إن كان القرار صحيحاً.`, 'admin')
  }

  await audit({ id: params.user.id, name: params.user.name || params.user.email || 'Student' }, 'PAYMENT_WAIVER_CODE_VERIFIED', 'Payment', result.payment.id, `${result.payment.invoiceNo} — ${result.updated.codePreview}`)
  return result.updated
}

async function waiveAllAdmissionTuitionPayments(admissionId: string, waiver: any, actor: { id?: string | null; name: string }) {
  await db.admissionApplication.update({ where: { id: admissionId }, data: { scholarshipFull: true } })
  const payments = await db.payment.findMany({
    where: { admissionId, purpose: { in: ['TUITION', 'TUITION_INSTALLMENT'] }, status: { notIn: ['PAID', 'WAIVED'] } },
  })
  for (const item of payments) {
    const remainingCents = paymentAmountCents(item)
    const originalCents = Math.max(Number(item.originalAmountCents || 0), remainingCents + Number(item.waivedAmountCents || 0), remainingCents)
    const waivedCents = Math.max(Number(item.waivedAmountCents || 0) + remainingCents, originalCents)
    await db.payment.update({
      where: { id: item.id },
      data: {
        status: 'WAIVED',
        waiverType: waiver.waiverType,
        waiverStatus: 'APPROVED',
        waiverReason: waiver.reason,
        originalAmount: centsToDollars(originalCents),
        originalAmountCents: originalCents,
        waivedAmount: centsToDollars(waivedCents),
        waivedAmountCents: waivedCents,
        amount: 0,
        amountCents: 0,
        waiverApprovedById: actor.id || null,
        waiverApprovedAt: new Date(),
      },
    })
  }
}

export async function approvePaymentWaiver(params: { waiverId: string; actor: { id?: string | null; name: string } }) {
  const waiver = await db.$transaction(async (tx) => {
    const current = await tx.paymentWaiverCode.findUnique({ where: { id: params.waiverId }, include: { payment: true } })
    if (!current) throw new Error('كود الإعفاء غير موجود')
    if (current.status !== 'VERIFIED') throw new Error(current.status === 'APPROVED' ? 'تم اعتماد هذا الكود مسبقاً' : 'لا يمكن اعتماد الكود قبل أن يدخله الطالب ويتحقق منه')
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${current.paymentId} FOR UPDATE`
    const approved = await tx.paymentWaiverCode.updateMany({
      where: { id: current.id, status: 'VERIFIED' },
      data: { status: 'APPROVED', approvedById: params.actor.id || null, approvedAt: new Date() },
    })
    if (approved.count === 0) throw new Error('تم اعتماد هذا الكود مسبقاً أو تغيرت حالته أثناء المعالجة')
    return tx.paymentWaiverCode.findUniqueOrThrow({ where: { id: params.waiverId }, include: { payment: true } })
  })
  const payment = waiver.payment
  const purpose = String(payment.purpose || '').toUpperCase()
  if (payment.status === 'PAID') throw new Error('لا يمكن إعفاء فاتورة مسددة فعلياً')
  if (payment.status === 'WAIVED' && purpose !== 'APPLICATION_FEE') throw new Error('الفاتورة معفاة مسبقاً')

  const currentCents = paymentAmountCents(payment)
  const originalCents = payment.originalAmountCents ?? currentCents

  if (purpose === 'APPLICATION_FEE') {
    const applicationFeeCents = Math.max(originalCents, currentCents)
    const requestedCents = waiver.waiverType === 'PARTIAL_TUITION'
      ? Number(waiver.requestedAmountCents || 0)
      : applicationFeeCents
    const waiveApplicationCents = applicationFeeCents
    const tuitionCreditCents = waiver.waiverType === 'PARTIAL_TUITION' ? Math.max(0, requestedCents - applicationFeeCents) : 0
    const fullScholarship = waiver.waiverType === 'FULL_SCHOLARSHIP'
    const updatedPayment = await db.payment.update({
      where: { id: payment.id },
      data: {
        status: 'WAIVED',
        waiverType: waiver.waiverType,
        waiverStatus: 'PROGRAM_APPLIED',
        waiverReason: waiver.reason,
        waivedAmount: centsToDollars(Math.max(payment.waivedAmountCents || 0, waiveApplicationCents)),
        waivedAmountCents: Math.max(payment.waivedAmountCents || 0, waiveApplicationCents),
        originalAmount: payment.originalAmount ?? payment.amount,
        originalAmountCents: originalCents,
        amount: 0,
        amountCents: 0,
        waiverApprovedById: params.actor.id || null,
        waiverApprovedAt: new Date(),
      },
    })

    await db.paymentWaiverCode.update({ where: { id: waiver.id }, data: { status: 'APPROVED', approvedById: params.actor.id || null, approvedAt: new Date() } })

    if (payment.admissionId) {
      const app = await db.admissionApplication.findUnique({ where: { id: payment.admissionId } })
      if (app) {
        await ensureTuitionInvoiceWithWaiverCredit({
          app,
          creditCents: tuitionCreditCents,
          fullScholarship,
          waiverType: waiver.waiverType as PaymentWaiverType,
          reason: waiver.reason,
          actor: params.actor,
        })
        if (fullScholarship) await waiveAllAdmissionTuitionPayments(app.id, waiver, params.actor)
        await moveAdmissionToTuitionStage(app, params.actor)
      }
    }

    if (updatedPayment.admissionId) await finalizeAdmissionAfterSettlement(db, updatedPayment.admissionId, { source: 'WAIVER', actor: params.actor })
    const auditedCents = waiver.waiverType === 'PARTIAL_TUITION' ? Math.max(requestedCents, waiveApplicationCents) : waiveApplicationCents
    await audit(params.actor, 'PAYMENT_WAIVER_APPROVED', 'Payment', payment.id, `${payment.invoiceNo} — ${waiver.waiverType} — ${centsToDollars(auditedCents).toFixed(2)}$`)
    return updatedPayment
  }

  const waiveCents = waiver.waiverType === 'PARTIAL_TUITION'
    ? Math.min(Number(waiver.requestedAmountCents || 0), currentCents)
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

  if (waiver.waiverType === 'FULL_SCHOLARSHIP' && payment.admissionId) {
    await waiveAllAdmissionTuitionPayments(payment.admissionId, waiver, params.actor)
  }
  if ((isFull || waiver.waiverType === 'FULL_SCHOLARSHIP') && updatedPayment.admissionId) await finalizeAdmissionAfterSettlement(db, updatedPayment.admissionId, { source: 'WAIVER', actor: params.actor })
  await audit(params.actor, 'PAYMENT_WAIVER_APPROVED', 'Payment', payment.id, `${payment.invoiceNo} — ${waiver.waiverType} — ${centsToDollars(waiveCents).toFixed(2)}$`)
  return updatedPayment
}
