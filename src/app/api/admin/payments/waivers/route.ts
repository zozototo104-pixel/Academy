import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ActivePaymentWaiverExistsError, approvePaymentWaiver, createPaymentWaiverCode, isPaymentWaiverType, resendPaymentWaiverCode } from '@/lib/payment-waivers'
import { audit } from '@/lib/notify'

// Administrative grant organization metadata is separate from the established
// waiver ledger. A dedicated schema migration is intentionally NOT attempted here:
// the connected GitHub writer cannot create new migration files.
const GRANT_POLICY_PREFIX = 'GRANT_ORGANIZATION_POLICY_V1_'
const GRANT_LINK_PREFIX = 'GRANT_ORGANIZATION_LINK_V1_'
type GrantPolicy = {
  id: string; title: string; scope: 'GENERAL' | 'PROGRAM' | 'INDIVIDUAL'
  programIds: string[]; admissionId: string | null
  coverage: 'REGISTRATION' | 'TUITION' | 'BOTH'
  valueMode: 'FULL' | 'PERCENT' | 'AMOUNT'
  value: number; reason: string; active: boolean; createdAt: string
}
type GrantQuote = {
  policy: GrantPolicy; paymentId: string; admissionId: string; programId: string
  waiverType: 'APPLICATION_FEE' | 'PARTIAL_TUITION' | 'FULL_SCHOLARSHIP'
  requestedAmount: number | null; grantCents: number; baseCents: number
  paymentIds: string[]; signature: string; summary: string
}
function grantError(message: string, status = 409) {
  return Object.assign(new Error(message), { status, code: 'GRANT_NOT_ELIGIBLE' })
}
async function loadGrantPolicies(): Promise<GrantPolicy[]> {
  const rows = await db.setting.findMany({ where: { key: { startsWith: GRANT_POLICY_PREFIX } }, orderBy: { updatedAt: 'desc' } })
  return rows.flatMap((row) => {
    try {
      const policy = JSON.parse(row.value) as GrantPolicy
      return policy?.id && row.key === GRANT_POLICY_PREFIX + policy.id ? [policy] : []
    } catch { return [] }
  })
}
async function loadGrantPolicy(id: string): Promise<GrantPolicy> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw grantError('معرف المنحة غير صالح', 400)
  const record = await db.setting.findUnique({ where: { key: GRANT_POLICY_PREFIX + id } })
  if (!record) throw grantError('تعريف المنحة غير موجود')
  try { return JSON.parse(record.value) as GrantPolicy } catch { throw grantError('تعريف المنحة غير قابل للقراءة') }
}
function amountCents(row: { amountCents?: number | null; amount: number }) {
  const cents = row.amountCents == null ? Math.round(row.amount * 100) : row.amountCents
  if (!Number.isSafeInteger(cents) || cents < 0) throw grantError('قيمة الفاتورة غير قابلة للحساب')
  return cents
}
async function grantQuote(paymentId: string, policyId: string): Promise<GrantQuote> {
  const policy = await loadGrantPolicy(policyId)
  if (!policy.active) throw grantError('هذه المنحة موقوفة عن الإصدار')
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: { admission: { select: { id: true, programId: true, fullName: true } } },
  })
  if (!payment || !payment.admission || !payment.admission.programId) {
    throw grantError('الفاتورة ليست مرتبطة بطلب قبول وتخصص محدد')
  }
  if (payment.status !== 'UNPAID') throw grantError('لا يمكن إعفاء فاتورة مدفوعة أو معفاة')
  const admissionId = payment.admission.id
  const programId = payment.admission.programId
  if (policy.scope === 'INDIVIDUAL' && policy.admissionId !== admissionId) {
    throw grantError('هذه منحة فردية لطالب آخر')
  }
  if (policy.scope === 'PROGRAM' && !policy.programIds.includes(programId)) {
    throw grantError('تخصص هذا الطالب غير مشمول بالمنحة المختارة')
  }
  const purpose = payment.purpose
  if (policy.coverage === 'REGISTRATION' && purpose !== 'APPLICATION_FEE') throw grantError('هذه المنحة لرسوم التسجيل فقط')
  if (policy.coverage === 'BOTH' && purpose !== 'APPLICATION_FEE') throw grantError('منحة الرسوم معًا يجب إصدارها من فاتورة التسجيل')
  if (policy.coverage === 'TUITION' && !['TUITION', 'TUITION_INSTALLMENT'].includes(purpose)) throw grantError('هذه المنحة للرسوم الدراسية فقط')
  if (policy.valueMode === 'FULL' && purpose === 'TUITION_INSTALLMENT') {
    throw grantError('المنحة الدراسية الكاملة تُصدر من فاتورة الرسوم الكاملة، وليس من قسط منفرد')
  }
  if (policy.coverage === 'REGISTRATION' && policy.valueMode !== 'FULL') {
    throw grantError('المنظومة المالية الحالية لا تدعم إعفاءً جزئيًا من رسوم التسجيل وحدها')
  }
  const basePaymentCents = amountCents(payment)
  let baseCents = basePaymentCents
  let relatedTuition: { id: string; amountCents: number; status: string } | null = null
  const paymentIds = [payment.id]
  if (policy.coverage === 'BOTH') {
    const tuition = await db.payment.findMany({
      where: { admissionId, purpose: { in: ['TUITION', 'TUITION_INSTALLMENT'] } },
      select: { id: true, purpose: true, status: true, amount: true, amountCents: true },
    })
    if (tuition.some((row) => row.status === 'PAID' || row.status === 'WAIVED')) {
      throw grantError('يوجد قسط دراسي مسدد أو معفى؛ لا يمكن احتساب منحة موحدة للفاتورتين')
    }
    relatedTuition = tuition.find((row) => row.purpose === 'TUITION')?.status === 'UNPAID'
      ? { id: tuition.find((row) => row.purpose === 'TUITION')!.id, amountCents: amountCents(tuition.find((row) => row.purpose === 'TUITION')!), status: 'UNPAID' }
      : null
    if (policy.valueMode !== 'FULL' && !relatedTuition) {
      throw grantError('المنحة الجزئية للتسجيل والدراسة معًا تتطلب فاتورة رسوم دراسية كاملة غير مسددة')
    }
    paymentIds.push(...tuition.map((row) => row.id))
    if (policy.valueMode !== 'FULL') baseCents = relatedTuition!.amountCents
  }
  if (baseCents <= 0) throw grantError('لا توجد رسوم متبقية قابلة للإعفاء')
  const pending = await db.paymentWaiverCode.count({
    where: { paymentId: { in: paymentIds }, status: { in: ['ISSUED', 'VERIFIED'] } },
  })
  if (pending) throw grantError('يوجد كود إعفاء نشط مرتبط بإحدى الفواتير؛ أوقف الإصدار حتى تُحسم الأكواد السابقة')

  let grantCents = policy.valueMode === 'FULL' ? baseCents
    : policy.valueMode === 'PERCENT' ? Math.round(baseCents * policy.value / 100)
    : Math.round(policy.value * 100)
  if (!Number.isSafeInteger(grantCents) || grantCents <= 0 || grantCents > baseCents) {
    throw grantError('قيمة المنحة أكبر من المستحق أو لا يمكن احتسابها')
  }
  if (policy.valueMode !== 'FULL' && grantCents === baseCents) {
    throw grantError('الإعفاء الجزئي يساوي كامل المتبقي؛ استخدم منحة كاملة')
  }
  const waiverType = policy.valueMode === 'FULL'
    ? (policy.coverage === 'REGISTRATION' ? 'APPLICATION_FEE' : 'FULL_SCHOLARSHIP')
    : 'PARTIAL_TUITION'
  const requestedAmount = policy.valueMode === 'FULL' ? null
    : (policy.coverage === 'BOTH' ? basePaymentCents + grantCents : grantCents) / 100
  const signature = [policy.id, payment.id, policy.coverage, policy.valueMode,
    policy.value, baseCents, grantCents, basePaymentCents, ...paymentIds.sort()].join(':')
  const summary = policy.coverage === 'BOTH'
    ? `إعفاء كامل من رسوم التسجيل ${(basePaymentCents / 100).toFixed(2)}$، و${policy.valueMode === 'FULL' ? 'منحة دراسية كاملة' : `خصم ${(grantCents / 100).toFixed(2)}$ من الرسوم الدراسية`}`
    : `${policy.coverage === 'REGISTRATION' ? 'رسوم التسجيل' : 'الرسوم الدراسية'}: أساس ${(baseCents / 100).toFixed(2)}$، إعفاء ${(grantCents / 100).toFixed(2)}import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ActivePaymentWaiverExistsError, approvePaymentWaiver, createPaymentWaiverCode, isPaymentWaiverType, resendPaymentWaiverCode } from '@/lib/payment-waivers'
import { audit } from '@/lib/notify'


  return { policy, paymentId, admissionId, programId, waiverType, requestedAmount, grantCents, baseCents, paymentIds, signature, summary }
}

function cleanText(value: unknown, max = 700) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

class WaiverCancelUnsafeError extends Error {
  status = 409
  code = 'WAIVER_CANCEL_UNSAFE'

  constructor() {
    super('تعذّر إلغاء هذا الإعفاء تلقائياً لأن تفعيل الطالب لم يعد قائماً على هذا الإعفاء وحده (توجد مبالغ مسددة فعلياً، أو إعفاء آخر مستقل، أو نشاط أكاديمي بدأ). راجع التحاق الطالب وعالج الإلغاء يدوياً من شاشة القبول والتسجيل ثم أعد المحاولة.')
  }
}

class WaiverDecisionConflictError extends Error {
  status = 409
  code = 'WAIVER_DECISION_CONFLICT'

  constructor() {
    super('تغيّرت حالة هذا الإعفاء بقرار متزامن أثناء المعالجة. أعد تحميل البيانات وراجع الحالة الحالية قبل إعادة المحاولة.')
  }
}

// عكس تفعيل الإعفاء عند إلغاء كود معتمد: اعتماد الإعفاء قد فعّل التحاق
// الطالب (حالة القبول + التحاق ACTIVE) عبر finalizeAdmissionAfterSettlement،
// فإعادة الفاتورة وحدها إلى UNPAID تترك المال والوصول على خلاف. نخطط العكس
// داخل نفس معاملة الإلغاء، ولا ننفذه إلا إذا كان آمناً بالكامل:
//  - لا فاتورة شقيقة مسددة فعلياً (PAID) لنفس القبول — التفعيل ليس من هذا
//    الإعفاء وحده.
//  - كل فاتورة شقيقة معفاة (WAIVED) صنعها هذا الإعفاء نفسه (نفس النوع والسبب
//    والمعتمِد: مسح المنحة الكاملة أو رصيد فاتورة التقديم) — إعفاء شقيق
//    مستقل يعني رفضاً.
//  - القبول لم يتجاوز مرحلتي التفعيل (THESIS/SUPERVISOR_ASSIGNED).
//  - لا بصمة أكاديمية: لا وحدات مكتملة، لا محاولات امتحانات، لا فصل مغلق
//    أو نتيجة معتمدة، لا طلب تخرج، لا درجة نهائية/شهادة، والتحاق غير مكتمل.
// عندها: الفواتير الشقيقة تُستعاد كما تُستعاد فاتورة الكود، والقبول يعود
// إلى AWAITING_TUITION، والالتحاق النشط يعود إلى PENDING_PAYMENT (حالته
// قبل التفعيل في مسار التسجيل المباشر). لقطة القواعد وحالات الفصول التي
// أنشأها التفعيل تبقى كما هي: إنشاؤها عند أي تفعيل لاحق محروس بـ
// create-once فلا تتكرر ولا تتعارض.
async function planWaiverCancelReversal(tx: any, waiver: any) {
  const plan: { siblings: any[]; admissionData: Record<string, any> | null; enrollmentUpdate: { id: string; data: Record<string, any> } | null } = {
    siblings: [],
    admissionData: null,
    enrollmentUpdate: null,
  }
  const admissionId = waiver.payment.admissionId
  const app = await tx.admissionApplication.findUnique({ where: { id: admissionId } })
  if (!app) return plan

  const payments = await tx.payment.findMany({ where: { admissionId } })
  const others = payments.filter((p: any) => p.id !== waiver.paymentId)
  if (others.some((p: any) => p.status === 'PAID')) throw new WaiverCancelUnsafeError()
  for (const p of others) {
    if (p.status !== 'WAIVED') continue
    const byThisWaiver = p.waiverType === waiver.waiverType
      && p.waiverReason === waiver.reason
      && (p.waiverApprovedById || null) === (waiver.approvedById || null)
    if (!byThisWaiver) throw new WaiverCancelUnsafeError()
    plan.siblings.push(p)
  }

  const appStatus = String(app.status || '')
  if (['SCHEDULED', 'RESULT_APPROVED', 'CERTIFIED'].includes(appStatus)) throw new WaiverCancelUnsafeError()

  const userId = app.userId || waiver.payment.userId || null
  if (app.programId && userId) {
    const enrollment = await tx.enrollment.findUnique({ where: { userId_programId: { userId, programId: app.programId } } })
    if (enrollment) {
      let completedUnits: unknown[] = []
      try {
        const parsed = JSON.parse(enrollment.completedUnits || '[]')
        if (Array.isArray(parsed)) completedUnits = parsed
      } catch { /* قيمة غير صالحة تُعامل كقائمة فارغة */ }
      const attempts = (await tx.examAttempt.count({ where: { userId } })) + (await tx.programExamAttempt.count({ where: { userId } }))
      const semesterProgress = await tx.enrollmentSemesterState.findFirst({
        where: { enrollmentId: enrollment.id, OR: [{ status: 'CLOSED' }, { result: { not: null } }, { approvedScore: { not: null } }] },
      })
      const graduation = await tx.graduationRequest.findUnique({ where: { enrollmentId: enrollment.id } })
      if (
        enrollment.status === 'COMPLETED'
        || completedUnits.length > 0
        || enrollment.finalScore != null
        || !!enrollment.certificateNo
        || attempts > 0
        || !!semesterProgress
        || !!graduation
      ) {
        throw new WaiverCancelUnsafeError()
      }
      if (enrollment.status === 'ACTIVE') {
        plan.enrollmentUpdate = { id: enrollment.id, data: { status: 'PENDING_PAYMENT' } }
      }
    }
  }

  const admissionData: Record<string, any> = {}
  if (['THESIS', 'SUPERVISOR_ASSIGNED'].includes(appStatus)) admissionData.status = 'AWAITING_TUITION'
  if (waiver.waiverType === 'FULL_SCHOLARSHIP') admissionData.scholarshipFull = false
  plan.admissionData = Object.keys(admissionData).length ? admissionData : null
  return plan
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
    // لا تعكس نص الخطأ الداخلي (Prisma/قاعدة بيانات) إلى المتصل: رسالة
    // عامة للواجهة، والخطأ الحقيقي كاملاً في سجل الخادم فقط.
    console.error('payment waiver code creation failed:', e)
    return NextResponse.json({ error: 'تعذر توليد كود الإعفاء' }, { status: 400 })
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
      let result: any
      let decidedStatus = waiver.status
      try {
        result = await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${waiver.paymentId} FOR UPDATE`
          // إعادة قراءة الكود والفاتورة داخل المعاملة بعد قفل صف الفاتورة:
          // اللقطة المقروءة قبل المعاملة قد تسبق اعتماداً متزامناً التزم
          // أثناء انتظار القفل، فبناء قرار الرفض/الإلغاء وخطة العكس عليها
          // يترك الكود «ملغياً» والفاتورة ما زالت معفاة والتفعيل قائماً.
          // كل القرارات أدناه تُبنى على القراءة الطازجة، والقلب نفسه مشروط
          // بالحالة المرصودة (CAS) فيُكشف أي تغيير لا يمر بقفل الفاتورة.
          const fresh = await tx.paymentWaiverCode.findUnique({ where: { id: waiverId }, include: { payment: true } })
          if (!fresh?.payment) throw new WaiverDecisionConflictError()
          decidedStatus = fresh.status
          // قرار مطابق اتُّخذ متزامناً وانتهى: نجاح بلا أي كتابة إضافية.
          if (fresh.status === status) {
            const settledWaiver = await tx.paymentWaiverCode.findUnique({ where: { id: waiverId } })
            return { waiver: settledWaiver, payment: fresh.payment }
          }
          if (action === 'REJECT' && fresh.status === 'APPROVED') throw new WaiverDecisionConflictError()
          // حارس إلغاء الإعفاء على فاتورته نفسها: مخطط أمان العكس يفحص
          // الفواتير الشقيقة المسددة ويستبعد فاتورة الإعفاء نفسها، وإعادة
          // الضبط أدناه تمسح حقول السداد — فلو دفع الطالب باقي فاتورة
          // إعفاء جزئي فصارت PAID بإيصال، كان الإلغاء يمحو سداداً حقيقياً
          // ويرجع 200. البصمة النقدية هنا: حالة PAID، أو ختم إيصال/دفع
          // على فاتورة غير معفاة ليس من صنع الإعفاء (إيصال الإعفاء نفسه
          // يُختم بطريقة WAIVER على فاتورة WAIVED، وهو مسار الإلغاء
          // الآمن القائم ولا يدخل هذا الحارس). الحارس في جسم مسار
          // الإلغاء نفسه فيعمل سواء ارتبطت الفاتورة بقبول أم لا.
          if (action === 'CANCEL' && fresh.status === 'APPROVED') {
            const own = fresh.payment
            const cashCollected = own.status === 'PAID'
              || (own.status !== 'WAIVED' && (!!own.receiptNo || !!own.paidAt) && own.method !== 'WAIVER')
            if (cashCollected) throw new WaiverCancelUnsafeError()
          }
          // إلغاء كود معتمد مرتبط بقبول: خطط عكس التفعيل أولاً — إن لم يكن
          // آمناً تُرفض العملية كلها (409) قبل أي كتابة.
          const reversal = action === 'CANCEL' && fresh.status === 'APPROVED' && fresh.payment.admissionId
            ? await planWaiverCancelReversal(tx, fresh)
            : null
          const flipped = await tx.paymentWaiverCode.updateMany({
            where: { id: waiverId, status: fresh.status },
            data: { status },
          })
          if (flipped.count === 0) throw new WaiverDecisionConflictError()
          const updatedWaiver = await tx.paymentWaiverCode.findUnique({ where: { id: waiverId } })
          let updatedPayment: any = null
          if (action === 'CANCEL' && fresh.status === 'APPROVED') {
            const originalCents = Math.max(Number(fresh.payment.originalAmountCents || 0), Number(fresh.payment.amountCents || 0) + Number(fresh.payment.waivedAmountCents || 0))
            const originalAmount = originalCents > 0 ? originalCents / 100 : Number(fresh.payment.originalAmount || fresh.payment.amount || 0)
            updatedPayment = await tx.payment.update({
              where: { id: fresh.paymentId },
              data: {
                status: 'UNPAID',
                amount: originalAmount,
                amountCents: Math.round(originalAmount * 100),
                waivedAmount: 0,
                waivedAmountCents: 0,
                waiverStatus: 'CANCELLED',
                waiverReason: fresh.payment.waiverReason ? `${fresh.payment.waiverReason} — تم إلغاء الإعفاء المعتمد` : 'تم إلغاء الإعفاء المعتمد',
                waiverApprovedById: null,
                waiverApprovedAt: null,
                paidAt: null,
                method: null,
                receiptNo: null,
              },
            })
            if (reversal) {
              for (const sibling of reversal.siblings) {
                const siblingOriginalCents = Math.max(Number(sibling.originalAmountCents || 0), Number(sibling.amountCents || 0) + Number(sibling.waivedAmountCents || 0))
                const siblingOriginalAmount = siblingOriginalCents > 0 ? siblingOriginalCents / 100 : Number(sibling.originalAmount || sibling.amount || 0)
                await tx.payment.update({
                  where: { id: sibling.id },
                  data: {
                    status: 'UNPAID',
                    amount: siblingOriginalAmount,
                    amountCents: Math.round(siblingOriginalAmount * 100),
                    waivedAmount: 0,
                    waivedAmountCents: 0,
                    waiverStatus: 'CANCELLED',
                    waiverReason: sibling.waiverReason ? `${sibling.waiverReason} — تم إلغاء الإعفاء المعتمد` : 'تم إلغاء الإعفاء المعتمد',
                    waiverApprovedById: null,
                    waiverApprovedAt: null,
                    paidAt: null,
                    method: null,
                    receiptNo: null,
                  },
                })
              }
              if (reversal.admissionData) {
                const admissionId = fresh.payment.admissionId
                if (!admissionId) throw new WaiverCancelUnsafeError()
                await tx.admissionApplication.update({ where: { id: admissionId }, data: reversal.admissionData })
              }
              if (reversal.enrollmentUpdate) {
                await tx.enrollment.update({ where: { id: reversal.enrollmentUpdate.id }, data: reversal.enrollmentUpdate.data })
              }
            } else if (fresh.waiverType === 'FULL_SCHOLARSHIP' && fresh.payment.admissionId) {
              await tx.admissionApplication.update({ where: { id: fresh.payment.admissionId }, data: { scholarshipFull: false } }).catch(() => null)
            }
          } else {
            updatedPayment = await tx.payment.updateMany({ where: { id: fresh.paymentId, waiverStatus: { in: ['REQUESTED', 'VERIFIED'] } }, data: { waiverStatus: status } })
          }
          return { waiver: updatedWaiver, payment: updatedPayment }
        })
      } catch (e: any) {
        if (e instanceof WaiverCancelUnsafeError || e?.code === 'WAIVER_CANCEL_UNSAFE') {
          return NextResponse.json({ error: e.message, code: 'WAIVER_CANCEL_UNSAFE' }, { status: 409 })
        }
        if (e instanceof WaiverDecisionConflictError || e?.code === 'WAIVER_DECISION_CONFLICT') {
          return NextResponse.json({ error: e.message, code: 'WAIVER_DECISION_CONFLICT' }, { status: 409 })
        }
        throw e
      }
      await audit({ id: admin.id, name: admin.name || admin.email || 'Admin' }, `PAYMENT_WAIVER_${status}`, 'Payment', waiver.paymentId, `${waiver.codePreview} — ${waiver.waiverType}${decidedStatus === 'APPROVED' ? ' — إعادة الفاتورة إلى UNPAID' : ''}`)
      return NextResponse.json(result)
    }

    return NextResponse.json({ error: 'إجراء غير مدعوم' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: e?.message || 'تعذر تحديث الإعفاء' }, { status: 400 })
  }
}
