import { db } from '@/lib/db'
import { paymentAmountDollars } from '@/lib/money'

export const TUITION_PURPOSES = ['TUITION', 'TUITION_INSTALLMENT']

type TuitionPayment = { purpose: string; status: string; amount: number; amountCents?: number | null; waiverType?: string | null; waivedAmount?: number | null; waivedAmountCents?: number | null; originalAmount?: number | null; originalAmountCents?: number | null }

function amountOf(payment: TuitionPayment): number {
  return paymentAmountDollars(payment)
}

function originalAmountOf(payment: TuitionPayment): number {
  const originalCents = Number(payment.originalAmountCents || 0)
  if (originalCents > 0) return roundMoney(originalCents / 100)
  const original = Number(payment.originalAmount || 0)
  if (original > 0) return roundMoney(original)
  return roundMoney(amountOf(payment) + waivedAmountOf(payment))
}

function waivedAmountOf(payment: TuitionPayment): number {
  const waivedCents = Number(payment.waivedAmountCents || 0)
  if (waivedCents > 0) return roundMoney(waivedCents / 100)
  return roundMoney(Number(payment.waivedAmount || 0))
}

function settledAmountOf(payment: TuitionPayment): number {
  if (payment.status === 'PAID') return amountOf(payment)
  if (payment.waiverType === 'PARTIAL_TUITION') return waivedAmountOf(payment)
  if (payment.status === 'WAIVED') return originalAmountOf(payment)
  return waivedAmountOf(payment)
}

export interface TuitionPlanSummary {
  admissionId: string
  reference: string
  program: string
  totalTuition: number
  paidTuition: number
  remainingTuition: number
  halfRequired: number
  finalRequired: number
  firstSemesterAllowed: boolean
  secondSemesterAllowed: boolean
  appealStatus: string | null
  appealId: string | null
  approvedInitialAmount: number | null
  firstSemesterRequiredAmount: number | null
  finalRequiredAmount: number | null
  admissionStatus: string
  applicationFeePaid: boolean
  canRequestInstallmentAppeal: boolean
  installmentAppealBlockedReason: string | null
}

export function roundMoney(n: number): number {
  return Math.max(0, Math.round((Number(n) || 0) * 100) / 100)
}

const INSTALLMENT_APPEAL_ALLOWED_STATUSES = new Set(['AWAITING_TUITION', 'SUPERVISOR_ASSIGNED', 'THESIS'])

function applicationFeePaid(payments: TuitionPayment[]): boolean {
  return payments.some((p) => p.purpose === 'APPLICATION_FEE' && (p.status === 'PAID' || p.status === 'WAIVED'))
}

function installmentAppealEligibility(args: {
  admissionStatus: string
  applicationFeePaid: boolean
  remainingTuition: number
  appealStatus: string | null
}) {
  if (!args.applicationFeePaid) return { ok: false, reason: 'يتاح طلب تقسيط الرسوم بعد سداد رسوم التقديم وحجز المقعد أولاً.' }
  if (!INSTALLMENT_APPEAL_ALLOWED_STATUSES.has(args.admissionStatus)) return { ok: false, reason: 'يتاح طلب تقسيط الرسوم بعد موافقة الإدارة على الطلب وظهور فاتورة الرسوم الدراسية.' }
  if (args.remainingTuition <= 0) return { ok: false, reason: 'لا يوجد متبقٍ من الرسوم الدراسية لطلب تقسيطه.' }
  if (args.appealStatus === 'PENDING') return { ok: false, reason: 'يوجد طلب تقسيط قيد الدراسة بالفعل.' }
  if (args.appealStatus === 'APPROVED') return { ok: false, reason: 'يوجد طلب تقسيط معتمد بالفعل.' }
  return { ok: true, reason: null }
}

export function tuitionPaidTotal(payments: TuitionPayment[]): number {
  const settledFullTuition = Math.max(
    0,
    ...payments
      .filter((p) => p.purpose === 'TUITION' && (p.status === 'PAID' || p.status === 'WAIVED'))
      .map(settledAmountOf)
  )
  const settledInstallments = payments
    .filter((p) => p.purpose === 'TUITION_INSTALLMENT')
    .reduce((sum, p) => sum + settledAmountOf(p), 0)
  const settledOtherTuition = payments
    .filter((p) => !['TUITION', 'TUITION_INSTALLMENT'].includes(p.purpose) && TUITION_PURPOSES.includes(p.purpose))
    .reduce((sum, p) => sum + settledAmountOf(p), 0)

  // إذا وُجدت فاتورة رسوم كاملة مسددة أو معفاة فلا نضيف فوقها أقساطاً لنفس الرسوم.
  return roundMoney(Math.max(settledFullTuition, settledInstallments + settledOtherTuition))
}

export function inferTotalTuition(payments: TuitionPayment[], fallback = 0): number {
  const fallbackTuition = Number(fallback) || 0
  const fullTuition = payments.filter((p) => p.purpose === 'TUITION').map(originalAmountOf)
  const maxFull = Math.max(0, ...fullTuition)

  // لا نجمع فاتورة الرسوم الكاملة مع فواتير التقسيط، لأن التقسيط يمثل
  // دفعات على نفس الرسوم وليس رسوماً إضافية. إذا توفر سعر البرنامج أو
  // فاتورة TUITION كاملة فهما مصدر إجمالي الرسوم. نستخدم مجموع التقسيط
  // فقط كخطة احتياطية للبيانات القديمة التي لا تحتوي فاتورة TUITION/سعر برنامج.
  if (fallbackTuition > 0 || maxFull > 0) {
    return roundMoney(Math.max(fallbackTuition, maxFull))
  }

  const installmentsOnly = payments
    .filter((p) => p.purpose === 'TUITION_INSTALLMENT')
    .reduce((sum, p) => sum + amountOf(p), 0)
  return roundMoney(installmentsOnly)
}

async function findActiveAppeal(admissionId: string) {
  try {
    return await db.tuitionInstallmentAppeal.findFirst({
      where: { admissionId, status: { in: ['PENDING', 'APPROVED'] } },
      orderBy: { createdAt: 'desc' },
    })
  } catch (e) {
    // يحافظ على عمل لوحة الإدارة والطالب إذا لم يتم تشغيل db push بعد إضافة جدول التقسيط.
    console.warn('tuition installment appeal table is not ready yet:', e)
    return null
  }
}

export async function getAdmissionTuitionPlan(admissionId: string): Promise<TuitionPlanSummary | null> {
  const app = await db.admissionApplication.findUnique({
    where: { id: admissionId },
    include: {
      payments: { select: { purpose: true, status: true, amount: true, amountCents: true, waivedAmount: true, waivedAmountCents: true, originalAmount: true, originalAmountCents: true } },
      programRef: { select: { price: true } },
    },
  })
  if (!app) return null
  const appeal = await findActiveAppeal(app.id)
  const fallbackTuition = Number(app.programRef?.price || 0)
  const totalTuition = inferTotalTuition(app.payments, fallbackTuition)
  const paidTuition = tuitionPaidTotal(app.payments)
  const remainingTuition = roundMoney(Math.max(0, totalTuition - paidTuition))
  const halfRequired = roundMoney(Math.max(totalTuition / 2, Number(appeal?.firstSemesterRequiredAmount ?? 0)))
  const finalRequired = roundMoney(Math.max(totalTuition, Number(appeal?.finalRequiredAmount ?? 0)))
  const feePaid = applicationFeePaid(app.payments)
  const eligibility = installmentAppealEligibility({
    admissionStatus: app.status,
    applicationFeePaid: feePaid,
    remainingTuition,
    appealStatus: appeal?.status || null,
  })
  return {
    admissionId: app.id,
    reference: app.reference,
    program: app.program,
    totalTuition,
    paidTuition,
    remainingTuition,
    halfRequired,
    finalRequired,
    firstSemesterAllowed: totalTuition <= 0 || paidTuition >= halfRequired,
    secondSemesterAllowed: totalTuition <= 0 || paidTuition >= finalRequired,
    appealStatus: appeal?.status || null,
    appealId: appeal?.id || null,
    approvedInitialAmount: appeal?.approvedInitialAmount ?? null,
    firstSemesterRequiredAmount: appeal?.firstSemesterRequiredAmount ?? null,
    finalRequiredAmount: appeal?.finalRequiredAmount ?? null,
    admissionStatus: app.status,
    applicationFeePaid: feePaid,
    canRequestInstallmentAppeal: eligibility.ok,
    installmentAppealBlockedReason: eligibility.reason,
  }
}

export async function getStudentTuitionPlan(userId: string, programId: string): Promise<TuitionPlanSummary | null> {
  const app = await db.admissionApplication.findFirst({
    where: { userId, programId },
    orderBy: { createdAt: 'desc' },
    include: {
      payments: { select: { purpose: true, status: true, amount: true, amountCents: true, waivedAmount: true, waivedAmountCents: true, originalAmount: true, originalAmountCents: true } },
      programRef: { select: { price: true } },
    },
  })
  if (!app) return null
  const appeal = await findActiveAppeal(app.id)
  const fallbackTuition = Number(app.programRef?.price || 0)
  const totalTuition = inferTotalTuition(app.payments, fallbackTuition)
  const paidTuition = tuitionPaidTotal(app.payments)
  const remainingTuition = roundMoney(Math.max(0, totalTuition - paidTuition))
  const halfRequired = roundMoney(Math.max(totalTuition / 2, Number(appeal?.firstSemesterRequiredAmount ?? 0)))
  const finalRequired = roundMoney(Math.max(totalTuition, Number(appeal?.finalRequiredAmount ?? 0)))
  const feePaid = applicationFeePaid(app.payments)
  const eligibility = installmentAppealEligibility({
    admissionStatus: app.status,
    applicationFeePaid: feePaid,
    remainingTuition,
    appealStatus: appeal?.status || null,
  })
  return {
    admissionId: app.id,
    reference: app.reference,
    program: app.program,
    totalTuition,
    paidTuition,
    remainingTuition,
    halfRequired,
    finalRequired,
    firstSemesterAllowed: totalTuition <= 0 || paidTuition >= halfRequired,
    secondSemesterAllowed: totalTuition <= 0 || paidTuition >= finalRequired,
    appealStatus: appeal?.status || null,
    appealId: appeal?.id || null,
    approvedInitialAmount: appeal?.approvedInitialAmount ?? null,
    firstSemesterRequiredAmount: appeal?.firstSemesterRequiredAmount ?? null,
    finalRequiredAmount: appeal?.finalRequiredAmount ?? null,
    admissionStatus: app.status,
    applicationFeePaid: feePaid,
    canRequestInstallmentAppeal: eligibility.ok,
    installmentAppealBlockedReason: eligibility.reason,
  }
}

export async function enforceSemesterTuitionGate(userId: string, programId: string, semester: number) {
  const plan = await getStudentTuitionPlan(userId, programId)
  if (!plan) return { ok: true as const, plan: null }
  if (semester === 1 && !plan.firstSemesterAllowed) {
    return {
      ok: false as const,
      code: 'TUITION_HALF_REQUIRED',
      totalTuition: plan.totalTuition,
      paidTuition: plan.paidTuition,
      requiredAmount: plan.halfRequired,
      remainingTuition: plan.remainingTuition,
      plan,
      error: `لا يمكن فتح امتحان الفصل الأول قبل سداد نصف الرسوم الدراسية على الأقل. المسدد حالياً ${plan.paidTuition}$ والمطلوب ${plan.halfRequired}$.`,
    }
  }
  if (semester >= 2 && !plan.secondSemesterAllowed) {
    return {
      ok: false as const,
      code: 'TUITION_FULL_REQUIRED',
      totalTuition: plan.totalTuition,
      paidTuition: plan.paidTuition,
      requiredAmount: plan.finalRequired,
      remainingTuition: plan.remainingTuition,
      plan,
      error: `لا يمكن فتح امتحان الفصل الثاني قبل سداد بقية الرسوم الدراسية كاملة. المسدد حالياً ${plan.paidTuition}$ والمطلوب ${plan.finalRequired}$.`,
    }
  }
  return {
    ok: true as const,
    totalTuition: plan.totalTuition,
    paidTuition: plan.paidTuition,
    requiredAmount: semester >= 2 ? plan.finalRequired : plan.halfRequired,
    remainingTuition: plan.remainingTuition,
    plan,
  }
}
