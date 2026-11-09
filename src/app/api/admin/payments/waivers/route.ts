import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ActivePaymentWaiverExistsError, approvePaymentWaiver, createPaymentWaiverCode, isPaymentWaiverType, resendPaymentWaiverCode } from '@/lib/payment-waivers'
import { audit } from '@/lib/notify'

// Administrative scholarship metadata has its own additive Prisma migration.
// The legacy waiver ledger remains the only source of financial settlement.
// Organization issuance is gated until seat reservations, linked-code
// approvals and rollout tests are complete. Historical codes remain valid.
function grantOrganizationReady(): boolean {
  // Off by default: only enable after the deployment migration, ledger
  // checks and end-to-end financial regressions pass.
  return process.env.SCHOLARSHIP_ORGANIZATION_ENABLED === '1'
}
function grantOrganizationUnavailable() {
  return NextResponse.json({
    error: 'تنظيم المنح قيد الاستكمال: يلزم ترحيل الجداول المستقلة والتحقق من سلامة المقاعد قبل الإصدار.',
    code: 'GRANT_ORGANIZATION_NOT_READY',
  }, { status: 503 })
}
type GrantPolicy = {
  id: string; title: string; scope: 'GENERAL' | 'PROGRAM' | 'INDIVIDUAL'
  programIds: string[]; admissionId: string | null
  coverage: 'REGISTRATION' | 'TUITION' | 'BOTH'
  valueMode: 'FULL' | 'PERCENT' | 'AMOUNT'
  value: number; reason: string; active: boolean; createdAt: string
  targetUserId?: string | null
  startsAt?: string | null; endsAt?: string | null
  programAvailability?: Array<{
    programId: string; seats: number | null; occupied: number; remaining: number | null
  }>
}
type GrantQuote = {
  policy: GrantPolicy; paymentId: string; admissionId: string; programId: string; userId: string
  waiverType: 'APPLICATION_FEE' | 'PARTIAL_TUITION' | 'FULL_SCHOLARSHIP'
  requestedAmount: number | null; grantCents: number; baseCents: number; invoiceBaseCents: number
  paymentIds: string[]; signature: string; summary: string
}
function grantError(message: string, status = 409) {
  return Object.assign(new Error(message), { status, code: 'GRANT_NOT_ELIGIBLE' })
}
type StoredGrantDefinition = {
  id: string
  title: string
  scope: string
  coverage: string
  valueMode: string
  value: number
  reason: string
  active: boolean
  startsAt: Date | null
  endsAt: Date | null
  createdAt: Date
  programs: Array<{ programId: string; seats?: number | null }>
  operations: Array<{ admissionId: string; userId: string; status: string }>
}
function toGrantPolicy(row: StoredGrantDefinition): GrantPolicy {
  if (!['GENERAL', 'PROGRAM', 'INDIVIDUAL'].includes(row.scope)
    || !['REGISTRATION', 'TUITION', 'BOTH'].includes(row.coverage)
    || !['FULL', 'PERCENT', 'AMOUNT'].includes(row.valueMode)) {
    throw grantError('تعريف منحة في قاعدة البيانات يحتوي نوعاً غير معروف؛ أوقف الإصدار')
  }
  if (!Number.isSafeInteger(row.value) || row.value < 0) {
    throw grantError('قيمة المنحة في قاعدة البيانات غير صالحة')
  }
  const targets = row.operations.filter((operation) => operation.status === 'TARGETED')
  if (row.scope === 'INDIVIDUAL' && (targets.length !== 1 || !targets[0].admissionId || !targets[0].userId)) {
    throw grantError('منحة فردية بلا مستفيد واحد موثق؛ لا يجوز إصدارها')
  }
  return {
    id: row.id,
    title: row.title,
    scope: row.scope as GrantPolicy['scope'],
    coverage: row.coverage as GrantPolicy['coverage'],
    valueMode: row.valueMode as GrantPolicy['valueMode'],
    value: row.valueMode === 'FULL' ? 0 : row.value / 100,
    reason: row.reason,
    active: row.active,
    programIds: row.programs.map((program) => program.programId),
    // A TARGETED operation is an immutable recipient assignment (not an
    // issued code): it consumes no seat and does not affect financial state.
    admissionId: row.scope === 'INDIVIDUAL' ? targets[0].admissionId : null,
    targetUserId: row.scope === 'INDIVIDUAL' ? targets[0].userId : null,
    createdAt: row.createdAt.toISOString(),
    startsAt: row.startsAt?.toISOString() || null,
    endsAt: row.endsAt?.toISOString() || null,
  }
}
async function loadGrantPolicies(): Promise<GrantPolicy[]> {
  const rows = await db.scholarshipDefinition.findMany({
    include: {
      programs: { select: { programId: true, seats: true } },
      operations: { where: { status: 'TARGETED' }, select: { userId: true, admissionId: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
  })
  if (!rows.length) return []
  // An issued or incomplete operation still occupies a campaign seat.
  // Terminal cancelled operations release it. This is a read-only live count;
  // the issuer uses its own serialized lock before reserving a seat.
  const counts = await db.scholarshipGrantOperation.groupBy({
    by: ['definitionId', 'programId'],
    where: {
      definitionId: { in: rows.map((row) => row.id) },
      status: { in: ['ISSUING', 'ISSUED', 'APPROVED', 'INCOMPLETE'] },
    },
    _count: { _all: true },
  })
  const occupied = new Map(counts.map((item) => [
    item.definitionId + ':' + item.programId, item._count._all,
  ]))
  return rows.map((row) => {
    const policy = toGrantPolicy(row)
    policy.programAvailability = row.programs.map((program) => {
      const seats = program.seats ?? null
      const used = occupied.get(row.id + ':' + program.programId) || 0
      return {
        programId: program.programId,
        seats,
        occupied: used,
        remaining: seats == null ? null : Math.max(0, seats - used),
      }
    })
    return policy
  })
}
async function loadGrantPolicy(id: string): Promise<GrantPolicy> {
  if (!id || id.length > 80 || !/^[a-zA-Z0-9_-]+$/.test(id)) throw grantError('معرف المنحة غير صالح', 400)
  const record = await db.scholarshipDefinition.findUnique({
    where: { id },
    include: {
      programs: { select: { programId: true } },
      operations: { where: { status: 'TARGETED' }, select: { userId: true, admissionId: true, status: true } },
    },
  })
  if (!record) throw grantError('تعريف المنحة غير موجود')
  return toGrantPolicy(record)
}
function amountCents(row: { amountCents?: number | null; amount: number }) {
  const cents = row.amountCents == null ? Math.round(row.amount * 100) : row.amountCents
  if (!Number.isSafeInteger(cents) || cents < 0) throw grantError('قيمة الفاتورة غير قابلة للحساب')
  return cents
}
function percentageGrantCents(baseCents: number, percentage: number): number {
  const rawBasisPoints = percentage * 100
  const basisPoints = Math.round(rawBasisPoints)
  if (!Number.isSafeInteger(baseCents) || baseCents <= 0
    || !Number.isFinite(rawBasisPoints) || basisPoints <= 0 || basisPoints >= 10000
    || Math.abs(rawBasisPoints - basisPoints) > 0.00000001) {
    throw grantError('نسبة المنحة الجزئية يجب أن تكون أكبر من صفر وأقل من 100، بدقة منزلتين عشريتين كحد أقصى')
  }
  // A half-up integer division avoids floating-point rounding of money.
  const result = Number(
    (BigInt(baseCents) * BigInt(basisPoints) + BigInt(5000)) / BigInt(10000),
  )
  if (!Number.isSafeInteger(result)) throw grantError('قيمة المنحة خارج حدود السنتات المدعومة')
  return result
}
async function grantQuote(paymentId: string, policyId: string): Promise<GrantQuote> {
  const policy = await loadGrantPolicy(policyId)
  if (!policy.active) throw grantError('هذه المنحة موقوفة عن الإصدار')
  const payment = await db.payment.findUnique({
    where: { id: paymentId },
    include: { admission: { select: { id: true, programId: true, fullName: true, userId: true } } },
  })
  if (!payment || !payment.admission || !payment.admission.programId) {
    throw grantError('الفاتورة ليست مرتبطة بطلب قبول وتخصص محدد')
  }
  if (payment.status !== 'UNPAID') throw grantError('لا يمكن إعفاء فاتورة مدفوعة أو معفاة')
  const admissionId = payment.admission.id
  const programId = payment.admission.programId
  const admissionUserId = payment.admission.userId || null
  const paymentUserId = payment.userId || null
  if (admissionUserId && paymentUserId && admissionUserId !== paymentUserId) {
    throw grantError('هوية طالب الفاتورة مختلفة عن صاحب طلب القبول')
  }
  const studentUserId = admissionUserId || paymentUserId
  if (!studentUserId) throw grantError('هوية الطالب غير مربوطة بحساب موثق؛ لا يجوز إصدار منحة دراسية قبل المطابقة')
  const priorScholarships = await db.paymentWaiverCode.findMany({
    where: {
      // An expired unapproved code cannot be verified or approved by the
      // existing engine. It must not block a later eligible scholarship.
      OR: [
        { status: 'APPROVED' },
        { status: { in: ['ISSUED', 'VERIFIED'] }, expiresAt: { gt: new Date() } },
      ],
      waiverType: { in: ['FULL_SCHOLARSHIP', 'PARTIAL_TUITION'] },
      payment: { is: {
        OR: [{ userId: studentUserId }, { admission: { is: { userId: studentUserId } } }],
      } },
    },
    select: { id: true },
    take: 1,
  })
  if (priorScholarships.length) {
    throw grantError('لدى هذا الطالب منحة دراسية نشطة أو معتمدة على تسجيل آخر؛ لا يجوز إصدار منحة دراسية ثانية')
  }
  if (policy.scope === 'INDIVIDUAL'
    && (policy.admissionId !== admissionId || policy.targetUserId !== studentUserId)) {
    throw grantError('هذه منحة فردية لطالب أو طلب قبول آخر')
  }
  const now = Date.now()
  if (policy.startsAt && now < Date.parse(policy.startsAt)) throw grantError('لم تبدأ فترة إصدار المنحة بعد')
  if (policy.endsAt && now > Date.parse(policy.endsAt)) throw grantError('انتهت فترة إصدار هذه المنحة')
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
    if (policy.valueMode !== 'FULL' && tuition.some((row) => row.purpose === 'TUITION_INSTALLMENT')) {
      throw grantError('لا يمكن جمع منحة التسجيل والدراسة الجزئية مع خطة تقسيط موجودة؛ اختر إعفاءً متوافقًا مع الفواتير الحالية')
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
    : policy.valueMode === 'PERCENT' ? percentageGrantCents(baseCents, policy.value)
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
    ? 'إعفاء التسجيل ' + (basePaymentCents / 100).toFixed(2) + ' دولار، و'
      + (policy.valueMode === 'FULL' ? 'منحة دراسية كاملة' : 'خصم ' + (grantCents / 100).toFixed(2) + ' دولار من الرسوم الدراسية')
    : (policy.coverage === 'REGISTRATION' ? 'رسوم التسجيل' : 'الرسوم الدراسية')
      + ': أساس ' + (baseCents / 100).toFixed(2) + ' دولار، إعفاء ' + (grantCents / 100).toFixed(2) + ' دولار'

  return { policy, paymentId, admissionId, programId, userId: studentUserId, waiverType, requestedAmount, grantCents, baseCents, invoiceBaseCents: basePaymentCents, paymentIds, signature, summary }
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
  // A separately paid application fee does not finance tuition. Preserve its
  // paid invoice/receipt, and revoke tuition access if this grant alone covered
  // tuition. Any other real cash settlement still prevents automatic reversal.
  if (others.some((p: any) => p.status === 'PAID' && p.purpose !== 'APPLICATION_FEE')) {
    throw new WaiverCancelUnsafeError()
  }
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
      // Only academic attempts in the affected program make reversal unsafe.
      // An exam the student took in another program must not block revoking
      // this unrelated scholarship.
      const attempts = (await tx.examAttempt.count({
        where: { userId, exam: { is: { unit: { is: { programId: app.programId } } } } },
      })) + (await tx.programExamAttempt.count({
        where: { userId, exam: { is: { programId: app.programId } } },
      }))
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

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const mode = req.nextUrl.searchParams.get('mode')
    if (mode === 'policies') {
      return NextResponse.json({ policies: await loadGrantPolicies(), ready: grantOrganizationReady() }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (mode === 'quote') {
      const policyId = cleanText(req.nextUrl.searchParams.get('policyId'), 60)
      const paymentId = cleanText(req.nextUrl.searchParams.get('paymentId'), 80)
      const quote = await grantQuote(paymentId, policyId)
      return NextResponse.json({ quote }, { headers: { 'Cache-Control': 'no-store' } })
    }
    return NextResponse.json({ error: 'طلب غير مدعوم' }, { status: 400 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.code === 'GRANT_NOT_ELIGIBLE' ? e.message : 'تعذر فحص المنح', code: e?.code }, { status: e?.status || 400 })
  }
}

async function createOrganizedPolicy(body: any, admin: { id: string; name?: string | null; email?: string | null }) {
  const title = cleanText(body.title, 100)
  const reason = cleanText(body.reason, 500)
  const scope = String(body.scope || '')
  const coverage = String(body.coverage || '')
  const valueMode = String(body.valueMode || '')
  const value = Number(body.value || 0)
  if (title.length < 3 || reason.length < 6) throw grantError('اسم المنحة وسببها مطلوبان', 400)
  if (!['GENERAL', 'PROGRAM', 'INDIVIDUAL'].includes(scope)) throw grantError('نوع المنحة غير صحيح', 400)
  if (!['REGISTRATION', 'TUITION', 'BOTH'].includes(coverage)) throw grantError('نطاق الرسوم غير صحيح', 400)
  if (!['FULL', 'PERCENT', 'AMOUNT'].includes(valueMode)) throw grantError('قيمة المنحة غير صحيحة', 400)
  if (coverage === 'REGISTRATION' && valueMode !== 'FULL') {
    throw grantError('إعفاء التسجيل الجزئي غير مدعوم ماليًا في النظام الحالي؛ لا يمكن إصدار وعد غير قابل للتطبيق', 400)
  }
  if (valueMode === 'PERCENT' && (!Number.isFinite(value) || value <= 0 || value >= 100)) {
    throw grantError('النسبة الجزئية يجب أن تكون أكبر من صفر وأقل من 100%', 400)
  }
  if (valueMode === 'AMOUNT' && (!Number.isFinite(value) || value <= 0 || value > 100000 || Math.round(value * 100) / 100 !== value)) {
    throw grantError('المبلغ الجزئي يجب أن يكون موجبًا ودقيقًا بالسنت', 400)
  }
  const programIds: string[] = scope === 'PROGRAM'
    ? Array.from(new Set<string>((Array.isArray(body.programIds) ? body.programIds : []).filter((id: unknown): id is string => typeof id === 'string' && id.length <= 80)))
    : []
  if (scope === 'PROGRAM') {
    if (!programIds.length || programIds.length > 100) throw grantError('اختر تخصصًا واحدًا على الأقل', 400)
    const count = await db.program.count({ where: { id: { in: programIds } } })
    if (count !== programIds.length) throw grantError('بعض التخصصات المختارة غير موجودة', 400)
  }
  const seatLimits: Record<string, number | null> = {}
  if (scope === 'PROGRAM') {
    const requestedLimits = body.seatLimits
    if (requestedLimits != null && (typeof requestedLimits !== 'object' || Array.isArray(requestedLimits))) {
      throw grantError('بيانات المقاعد لكل تخصص غير صالحة', 400)
    }
    for (const programId of programIds) {
      const raw = requestedLimits?.[programId]
      if (raw === undefined || raw === null || raw === '') {
        seatLimits[programId] = null
        continue
      }
      const seats = Number(raw)
      if (!Number.isSafeInteger(seats) || seats < 1 || seats > 100000) {
        throw grantError('عدد مقاعد كل تخصص يجب أن يكون عددًا صحيحًا بين 1 و100000', 400)
      }
      seatLimits[programId] = seats
    }
  }
  const admissionId = scope === 'INDIVIDUAL' ? cleanText(body.admissionId, 80) : null
  const admission = scope === 'INDIVIDUAL' && admissionId
    ? await db.admissionApplication.findUnique({
      where: { id: admissionId },
      select: { id: true, userId: true, programId: true },
    })
    : null
  if (scope === 'INDIVIDUAL' && (!admission?.userId || !admission.programId)) {
    throw grantError('المنحة الفردية تتطلب طلب قبول مرتبطًا بهوية طالب وبرنامج موثّقين', 400)
  }
  const integerValue = valueMode === 'FULL' ? 0 : Math.round(value * 100)
  if (!Number.isSafeInteger(integerValue)
    || (valueMode !== 'FULL' && Math.abs(value * 100 - integerValue) > 0.00000001)) {
    throw grantError('قيمة المنحة يجب أن تكون دقيقة للسنت أو لنقطتين عشريتين في النسبة', 400)
  }
  const startsAt = body.startsAt ? new Date(body.startsAt) : null
  const endsAt = body.endsAt ? new Date(body.endsAt) : null
  if ((startsAt && Number.isNaN(startsAt.getTime()))
    || (endsAt && Number.isNaN(endsAt.getTime()))
    || (startsAt && endsAt && endsAt <= startsAt)) {
    throw grantError('تاريخ بداية أو نهاية المنحة غير صالح', 400)
  }
  const record = await db.scholarshipDefinition.create({
    data: {
      title, scope, coverage, valueMode, value: integerValue, reason,
      // New scholarship definitions are drafts until an admin explicitly activates them.
      active: false, createdById: admin.id, startsAt, endsAt,
      ...(scope === 'PROGRAM' ? { programs: { create: programIds.map((programId) => ({ programId, seats: seatLimits[programId] })) } } : {}),
      ...(scope === 'INDIVIDUAL' && admission ? {
        operations: {
          create: {
            userId: admission.userId as string,
            admissionId: admission.id,
            programId: admission.programId as string,
            status: 'TARGETED',
            expectedCodes: 0,
            expectedCents: 0,
            createdById: admin.id,
          },
        },
      } : {}),
    },
    include: {
      programs: { select: { programId: true } },
      operations: { where: { status: 'TARGETED' }, select: { userId: true, admissionId: true, status: true } },
    },
  })
  const policy = toGrantPolicy(record)
  await audit({ id: admin.id, name: admin.name || admin.email || 'Admin' },
    'GRANT_POLICY_CREATED', 'ScholarshipDefinition', policy.id,
    title + ' — ' + scope + ' — ' + coverage + ' — ' + valueMode)
  return policy
}

// One engine-issued code per operation. The existing waiver engine may apply
// that code to multiple invoices; do not make extra codes for those effects.
async function reserveGrantOperation(quote: GrantQuote, adminId: string) {
  return db.$transaction(async (tx) => {
    // These row locks serialize separate admins racing for one student or the
    // final campaign seat. They do not change any existing student records.
    const userRows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE id = ${quote.userId} FOR UPDATE`
    if (userRows.length !== 1) throw grantError('تعذر تثبيت هوية الطالب وقت إصدار المنحة')
    const policyRows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "ScholarshipDefinition" WHERE id = ${quote.policy.id} FOR UPDATE`
    if (policyRows.length !== 1) throw grantError('تعذر تثبيت تعريف المنحة وقت الإصدار')
    const definition = await tx.scholarshipDefinition.findUnique({
      where: { id: quote.policy.id },
      include: { programs: { select: { programId: true, seats: true } } },
    })
    if (!definition?.active) throw grantError('تم إيقاف هذه المنحة')
    if ((definition.startsAt && new Date() < definition.startsAt)
      || (definition.endsAt && new Date() > definition.endsAt)) {
      throw grantError('المنحة خارج فترة الإصدار المسموحة')
    }
    if (definition.scope === 'PROGRAM'
      && !definition.programs.some((item) => item.programId === quote.programId)) {
      throw grantError('البرنامج غير مشمول بهذه المنحة')
    }
    if (definition.scope === 'INDIVIDUAL') {
      const target = await tx.scholarshipGrantOperation.findFirst({
        where: { definitionId: quote.policy.id, status: 'TARGETED' },
        select: { userId: true, admissionId: true },
      })
      if (!target || target.userId !== quote.userId || target.admissionId !== quote.admissionId) {
        throw grantError('مستفيد المنحة الفردية لا يطابق الطالب الحالي')
      }
    }
    const invoice = await tx.payment.findUnique({
      where: { id: quote.paymentId },
      include: { admission: { select: { id: true, userId: true, programId: true } } },
    })
    if (!invoice || invoice.status !== 'UNPAID'
      || invoice.admission?.id !== quote.admissionId
      || invoice.admission?.userId !== quote.userId
      || invoice.admission?.programId !== quote.programId
      || amountCents(invoice) !== quote.invoiceBaseCents) {
      throw grantError('تغيرت الفاتورة أو صاحبها؛ أعد معاينة المنحة قبل الإصدار')
    }
    const coveredInvoices = await tx.payment.findMany({
      where: { id: { in: quote.paymentIds } },
      select: { id: true, status: true, purpose: true, amount: true, amountCents: true },
    })
    if (coveredInvoices.length !== quote.paymentIds.length
      || coveredInvoices.some((item) => item.status !== 'UNPAID')) {
      throw grantError('تغيرت فواتير الرسوم المشمولة؛ لا يمكن إصدار المنحة الجزئية')
    }
    if (definition.coverage === 'BOTH' && definition.valueMode !== 'FULL') {
      const tuitionInvoices = coveredInvoices.filter((item) => item.purpose === 'TUITION')
      if (tuitionInvoices.length !== 1 || amountCents(tuitionInvoices[0]) !== quote.baseCents) {
        throw grantError('تغير أساس احتساب خصم الدراسة؛ أعد المعاينة')
      }
    }
    if (definition.coverage !== 'REGISTRATION') {
      const otherIssue = await tx.scholarshipGrantOperation.findFirst({
        where: {
          userId: quote.userId,
          status: { in: ['ISSUING', 'ISSUED', 'APPROVED', 'INCOMPLETE'] },
          definition: { is: { coverage: { in: ['TUITION', 'BOTH'] } } },
        },
        select: { id: true },
      })
      if (otherIssue) throw grantError('يوجد إصدار منحة دراسية قائم لهذا الطالب أو قيد المراجعة')
      const otherCode = await tx.paymentWaiverCode.findFirst({
        where: {
          status: { in: ['ISSUED', 'VERIFIED', 'APPROVED'] },
          waiverType: { in: ['PARTIAL_TUITION', 'FULL_SCHOLARSHIP'] },
          payment: { is: { OR: [{ userId: quote.userId }, { admission: { is: { userId: quote.userId } } }] } },
        },
        select: { id: true },
      })
      if (otherCode) throw grantError('لدى الطالب منحة دراسية قديمة سارية؛ يمنع إصدار منحة ثانية')
    }
    const seatRule = definition.programs.find((item) => item.programId === quote.programId)
    if (seatRule?.seats != null) {
      if (!Number.isSafeInteger(seatRule.seats) || seatRule.seats < 1) throw grantError('عدد مقاعد المنحة غير صالح')
      const occupied = await tx.scholarshipGrantOperation.count({
        where: {
          definitionId: definition.id, programId: quote.programId,
          status: { in: ['ISSUING', 'ISSUED', 'APPROVED', 'INCOMPLETE'] },
        },
      })
      if (occupied >= seatRule.seats) throw grantError('اكتملت المقاعد المتاحة لهذا البرنامج')
    }
    return tx.scholarshipGrantOperation.create({
      data: {
        definitionId: definition.id, userId: quote.userId,
        admissionId: quote.admissionId, programId: quote.programId,
        status: 'ISSUING', expectedCodes: 1,
        expectedCents: quote.grantCents, createdById: adminId,
      },
    })
  })
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    if ((body.action === 'CREATE_POLICY' || body.action === 'ISSUE_POLICY') && !grantOrganizationReady()) {
      return grantOrganizationUnavailable()
    }
    if (body.action === 'CREATE_POLICY') {
      const policy = await createOrganizedPolicy(body, admin)
      return NextResponse.json({ policy }, { status: 201 })
    }
    if (body.action === 'ISSUE_POLICY') {
      const quote = await grantQuote(cleanText(body.paymentId, 80), cleanText(body.policyId, 60))
      if (quote.signature !== String(body.signature || '')) {
        return NextResponse.json({ error: 'تغيّرت الفاتورة أو قيمة المنحة منذ المعاينة؛ أعد المعاينة قبل إصدار الكود', code: 'GRANT_QUOTE_CHANGED' }, { status: 409 })
      }
      const operation = await reserveGrantOperation(quote, admin.id)
      const reason = quote.policy.reason + ' [GRANT:' + quote.policy.id + ']'
      let result: Awaited<ReturnType<typeof createPaymentWaiverCode>>
      try {
        // Preserve the one established financial code issuer and its delivery.
        result = await createPaymentWaiverCode({
          paymentId: quote.paymentId,
          waiverType: quote.waiverType,
          requestedAmount: quote.requestedAmount,
          reason,
          actor: { id: admin.id, name: admin.name || admin.email || 'Admin' },
        })
      } catch (issueError) {
        // The existing engine can persist a code before a delivery failure.
        // Never free the reserved seat when an unlinked code may exist.
        const possiblyIssued = await db.paymentWaiverCode.findFirst({
          where: { paymentId: quote.paymentId, reason,
            createdAt: { gte: operation.createdAt } },
          select: { id: true },
        }).catch(() => null)
        await db.scholarshipGrantOperation.update({
          where: { id: operation.id },
          data: { status: possiblyIssued ? 'INCOMPLETE' : 'CANCELLED' },
        }).catch((error) => console.error('Failed to reconcile grant operation after issuance error:', error))
        throw issueError
      }
      try {
        await db.$transaction(async (tx) => {
          await tx.scholarshipGrantLink.create({
            data: {
              definitionId: quote.policy.id, operationId: operation.id,
              waiverCodeId: result.waiver.id, paymentId: quote.paymentId,
              userId: quote.userId, admissionId: quote.admissionId, programId: quote.programId,
              percentBps: quote.policy.valueMode === 'PERCENT' ? Math.round(quote.policy.value * 100) : null,
              baseCents: quote.baseCents, grantCents: quote.grantCents,
            },
          })
          await tx.scholarshipGrantOperation.update({
            where: { id: operation.id },
            data: { status: 'ISSUED' },
          })
        })
      } catch (linkError) {
        await db.scholarshipGrantOperation.update({
          where: { id: operation.id }, data: { status: 'INCOMPLETE' },
        }).catch((error) => console.error('Failed to quarantine unlinked grant:', error))
        console.error('Organized scholarship code issued but ledger linking failed:', linkError)
        throw grantError('صدر الكود ولكن ربط العملية لم يكتمل. تم منع الاعتماد ويجب أن تراجع الإدارة العملية قبل إعادة المحاولة')
      }
      await audit({ id: admin.id, name: admin.name || admin.email || 'Admin' },
        'GRANT_POLICY_ISSUED', 'ScholarshipGrantOperation', operation.id,
        quote.policy.title + ' — ' + quote.summary)
      return NextResponse.json({ ...result, quote, operationId: operation.id })
    }
    const paymentId = cleanText(body.paymentId, 80)
    const waiverType = cleanText(body.waiverType, 40)
    const reason = cleanText(body.reason)
    const requestedAmount = body.requestedAmount === undefined || body.requestedAmount === null || body.requestedAmount === '' ? null : Number(body.requestedAmount)
    if (!paymentId) return NextResponse.json({ error: 'معرّف الفاتورة مطلوب' }, { status: 400 })
    // During rollout the established waiver issuer remains unchanged. Once
    // organized grants are enabled, creation must pass the server-side grant
    // eligibility, seat and operation guards via ISSUE_POLICY. Lifecycle
    // actions (resend, verify, approve, cancel) remain available separately.
    if (grantOrganizationReady()) {
      return NextResponse.json({
        error: 'إصدار الإعفاءات أصبح عبر إدارة المنح بعد اختيار سياسة مستحقة ومعاينتها.',
        code: 'GRANT_POLICY_REQUIRED',
      }, { status: 409 })
    }
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
    if (e?.code === 'GRANT_NOT_ELIGIBLE') return NextResponse.json({ error: e.message, code: e.code }, { status: e.status || 409 })
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
    if (action === 'TOGGLE_POLICY' && !grantOrganizationReady()) {
      return grantOrganizationUnavailable()
    }
    if (action === 'TOGGLE_POLICY') {
      const id = cleanText(body.policyId, 80)
      const policy = await loadGrantPolicy(id)
      const record = await db.scholarshipDefinition.update({
        where: { id },
        data: { active: !policy.active },
        include: {
          programs: { select: { programId: true } },
          operations: { where: { status: 'TARGETED' }, select: { userId: true, admissionId: true, status: true } },
        },
      })
      const updated = toGrantPolicy(record)
      await audit({ id: admin.id, name: admin.name || admin.email || 'Admin' },
        'GRANT_POLICY_TOGGLED', 'ScholarshipDefinition', id,
        policy.title + ' — ' + (updated.active ? 'نشطة' : 'موقوفة'))
      return NextResponse.json({ policy: updated })
    }
    if (action === 'RESEND') {
      const paymentId = cleanText(body.paymentId, 80)
      if (!paymentId) return NextResponse.json({ error: 'معرّف الفاتورة مطلوب' }, { status: 400 })
      // Historical resends continue through the same engine without any extra
      // preflight reads. Only organized codes have post-resend ledger linking.
      const result = await resendPaymentWaiverCode({ paymentId, actor: { id: admin.id, name: admin.name || admin.email || 'Admin' } })
      const marker = result.waiver.reason?.match(/\[GRANT:([a-zA-Z0-9_-]{1,80})\]/)
      let organizationWarning: string | undefined
      if (marker) {
        try {
          const oldLink = await db.scholarshipGrantLink.findFirst({
            where: { definitionId: marker[1], paymentId },
            orderBy: { createdAt: 'desc' },
          })
          if (!oldLink?.operationId) throw new Error('NO_ORGANIZATION_LINK')
          await db.scholarshipGrantLink.create({
            data: {
              definitionId: oldLink.definitionId,
              operationId: oldLink.operationId,
              waiverCodeId: result.waiver.id,
              paymentId,
              userId: oldLink.userId,
              admissionId: oldLink.admissionId,
              programId: oldLink.programId,
              percentBps: oldLink.percentBps,
              baseCents: oldLink.baseCents,
              grantCents: oldLink.grantCents,
            },
          })
        } catch (error) {
          console.error('Waiver reissued, but organization ledger could not be linked:', error)
          organizationWarning = 'تم إنشاء كود جديد لكن ربط المنحة بحاجة لمراجعة الإدارة؛ يمنع الاعتماد حتى التصحيح'
        }
      }
      return NextResponse.json({
        code: result.code, waiver: result.waiver, emailStatus: result.emailStatus,
        whatsapp: result.whatsapp, organizationWarning,
      })
    }
    const waiverId = cleanText(body.waiverId, 80)
    if (!waiverId) return NextResponse.json({ error: 'معرّف كود الإعفاء مطلوب' }, { status: 400 })

    if (action === 'APPROVE') {
      let approvedOperationId: string | null = null
      const existing = await db.paymentWaiverCode.findUnique({
        where: { id: waiverId },
        include: { payment: { include: { admission: { select: { id: true, programId: true, userId: true } } } } },
      })
      // Only organized codes contain this marker. Historical waivers continue
      // through the same financial engine with no extra approval prerequisites.
      const marker = existing?.reason?.match(/\[GRANT:([a-zA-Z0-9_-]{1,80})\]/)
      if (marker) {
        const policy = await loadGrantPolicy(marker[1])
        const link = await db.scholarshipGrantLink.findUnique({
          where: { waiverCodeId: waiverId },
          include: { operation: true },
        })
        if (!link || !link.operation || link.operation.definitionId !== policy.id) {
          return NextResponse.json({
            error: 'ربط المنحة بعملية إصدار مكتملة مفقود. لا يمكن اعتماد كود غير موثق.',
            code: 'GRANT_LINK_MISSING',
          }, { status: 409 })
        }
        const operation = link.operation
        if (operation.status !== 'ISSUED' || operation.expectedCodes < 1) {
          return NextResponse.json({
            error: 'عملية إصدار المنحة لم تكتمل أو تحتاج مراجعة؛ لا يجوز اعتماد جزء منها.',
            code: 'GRANT_OPERATION_INCOMPLETE',
          }, { status: 409 })
        }
        const operationLinks = await db.scholarshipGrantLink.findMany({
          where: { operationId: operation.id },
          select: { waiverCodeId: true, grantCents: true },
        })
        const linkedCodes = await db.paymentWaiverCode.findMany({
          where: { id: { in: operationLinks.map((item) => item.waiverCodeId) },
            status: { in: ['ISSUED', 'VERIFIED', 'APPROVED'] } },
          select: { id: true },
        })
        const currentCodes = new Set(linkedCodes.map((item) => item.id))
        const validLinks = operationLinks.filter((item) => currentCodes.has(item.waiverCodeId))
        const grantedCents = validLinks.reduce((total, item) => total + item.grantCents, 0)
        if (validLinks.length !== operation.expectedCodes || grantedCents !== operation.expectedCents) {
          return NextResponse.json({
            error: 'مجموعة أكواد المنحة غير مكتملة أو مبالغها غير متطابقة؛ يمنع الاعتماد.',
            code: 'GRANT_OPERATION_MISMATCH',
          }, { status: 409 })
        }
        const paymentAdmission = existing?.payment.admission
        if (!paymentAdmission
          || link.paymentId !== existing?.paymentId
          || link.userId !== operation.userId
          || paymentAdmission.userId !== operation.userId
          || paymentAdmission.id !== link.admissionId
          || paymentAdmission.programId !== link.programId
          || operation.admissionId !== link.admissionId
          || operation.programId !== link.programId
          || (policy.scope === 'PROGRAM' && !policy.programIds.includes(link.programId))
          || (policy.scope === 'INDIVIDUAL'
            && (policy.admissionId !== link.admissionId || policy.targetUserId !== link.userId))) {
          return NextResponse.json({
            error: 'تغير مستفيد المنحة أو تخصصه؛ يلزم تصحيح إداري موثق قبل الاعتماد.',
            code: 'GRANT_PROGRAM_CHANGED',
          }, { status: 409 })
        }
        approvedOperationId = operation.id
      }
      const payment = await approvePaymentWaiver({
        waiverId, actor: { id: admin.id, name: admin.name || admin.email || 'Admin' },
      })
      // The financial engine commits independently. A later metadata sync
      // problem must never be reported as a failed financial approval.
      let organizationWarning: string | undefined
      if (approvedOperationId) {
        try {
          const synced = await db.scholarshipGrantOperation.updateMany({
            where: { id: approvedOperationId, status: 'ISSUED' },
            data: { status: 'APPROVED' },
          })
          if (synced.count !== 1) {
            organizationWarning = 'اعتمد الإعفاء ماليًا، لكن سجل المنحة يحتاج مراجعة إدارية'
          }
        } catch (error) {
          console.error('Financial waiver approved but grant operation sync failed:', error)
          organizationWarning = 'اعتمد الإعفاء ماليًا، لكن تحديث سجل المنحة تعذّر؛ المقعد لا يزال محجوزًا للمراجعة'
        }
      }
      return NextResponse.json({ payment, organizationWarning })
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
          // Release an organized campaign seat only when every code in its
          // operation is terminal. This runs in the SAME financial reversal
          // transaction, so a failed reversal cannot release a seat.
          const organized = fresh.reason?.match(/\[GRANT:([a-zA-Z0-9_-]{1,80})\]/)
          if (organized) {
            const link = await tx.scholarshipGrantLink.findUnique({
              where: { waiverCodeId: waiverId },
              select: { operationId: true },
            })
            if (link?.operationId) {
              const linked = await tx.scholarshipGrantLink.findMany({
                where: { operationId: link.operationId },
                select: { waiverCodeId: true },
              })
              if (linked.length) {
                const codes = await tx.paymentWaiverCode.findMany({
                  where: { id: { in: linked.map((item) => item.waiverCodeId) } },
                  select: { id: true, status: true },
                })
                if (codes.length === linked.length
                  && codes.every((code) => ['CANCELLED', 'REJECTED', 'EXPIRED'].includes(code.status))) {
                  await tx.scholarshipGrantOperation.updateMany({
                    where: {
                      id: link.operationId,
                      status: { in: ['ISSUING', 'ISSUED', 'APPROVED', 'INCOMPLETE'] },
                    },
                    data: { status: 'CANCELLED' },
                  })
                }
              }
            }
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
