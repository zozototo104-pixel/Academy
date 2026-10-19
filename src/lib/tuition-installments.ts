import { db } from '@/lib/db'
import { paymentAmountDollars } from '@/lib/money'

export const TUITION_PURPOSES = ['TUITION', 'TUITION_INSTALLMENT']

type TuitionPayment = { id?: string; purpose: string; status: string; amount: number; amountCents?: number | null; waiverType?: string | null; waiverStatus?: string | null; waivedAmount?: number | null; waivedAmountCents?: number | null; originalAmount?: number | null; originalAmountCents?: number | null }

const TUITION_PAYMENT_SELECT = {
  id: true,
  purpose: true,
  status: true,
  amount: true,
  amountCents: true,
  waiverType: true,
  waiverStatus: true,
  waivedAmount: true,
  waivedAmountCents: true,
  originalAmount: true,
  originalAmountCents: true,
}

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

function isTuitionPayment(payment: TuitionPayment): boolean {
  return TUITION_PURPOSES.includes(payment.purpose)
}

function actualPaidAmountOf(payment: TuitionPayment): number {
  return payment.status === 'PAID' ? amountOf(payment) : 0
}

function approvedWaiverCreditOf(payment: TuitionPayment): number {
  if (payment.waiverStatus !== 'APPROVED') return 0
  if (!['PARTIAL_TUITION', 'FULL_SCHOLARSHIP'].includes(String(payment.waiverType || ''))) return 0
  const waived = waivedAmountOf(payment)
  if (waived > 0) return waived
  return payment.status === 'WAIVED' ? originalAmountOf(payment) : 0
}

function settledAmountOf(payment: TuitionPayment): number {
  return roundMoney(actualPaidAmountOf(payment) + approvedWaiverCreditOf(payment))
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

export interface TuitionCoverage {
  due: number
  covered: number
  ratio: number
}

export function roundMoney(n: number): number {
  return Math.max(0, Math.round((Number(n) || 0) * 100) / 100)
}

function clampMoney(value: number, min: number, max: number) {
  const normalizedMax = Math.max(min, max)
  return roundMoney(Math.min(normalizedMax, Math.max(min, Number(value) || 0)))
}

function installmentThresholds(totalTuition: number, appeal?: { firstSemesterRequiredAmount?: number | null; finalRequiredAmount?: number | null } | null) {
  if (totalTuition <= 0) return { halfRequired: 0, finalRequired: 0 }
  const first = clampMoney(Math.max(totalTuition / 2, Number(appeal?.firstSemesterRequiredAmount ?? 0)), 0, totalTuition)
  const second = clampMoney(Math.max(first, Number(appeal?.finalRequiredAmount ?? totalTuition)), first, totalTuition)
  return { halfRequired: first, finalRequired: second }
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
  return roundMoney(payments.filter(isTuitionPayment).reduce((sum, payment) => sum + settledAmountOf(payment), 0))
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
    .reduce((sum, p) => sum + originalAmountOf(p), 0)
  return roundMoney(installmentsOnly)
}

function uniquePayments(payments: TuitionPayment[]): TuitionPayment[] {
  const seen = new Set<string>()
  const result: TuitionPayment[] = []
  for (const payment of payments) {
    const key = payment.id || `${payment.purpose}:${payment.status}:${payment.amount}:${payment.originalAmount}:${payment.waivedAmount}:${result.length}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(payment)
  }
  return result
}

export async function computeTuitionCoverage(userId: string, programId: string): Promise<TuitionCoverage> {
  const [program, app, enrollmentPayments] = await Promise.all([
    db.program.findUnique({ where: { id: programId }, select: { price: true } }),
    db.admissionApplication.findFirst({
      where: { userId, programId },
      include: { payments: { select: TUITION_PAYMENT_SELECT } },
      orderBy: { createdAt: 'desc' },
    }),
    db.payment.findMany({
      where: { enrollment: { is: { userId, programId } } },
      select: TUITION_PAYMENT_SELECT,
    }),
  ])
  const payments = uniquePayments([
    ...(Array.isArray((app as any)?.payments) ? (app as any).payments : []),
    ...enrollmentPayments,
  ])
  const due = inferTotalTuition(payments, Number(program?.price || 0))
  const rawCovered = tuitionPaidTotal(payments)
  const covered = due > 0 ? roundMoney(Math.min(due, rawCovered)) : rawCovered
  const ratio = due <= 0 ? 1 : Math.max(0, Math.min(1, covered / due))
  return { due, covered, ratio }
}

function requiredCoverageRatioForSemester(semester: number, semestersCount?: number | null): number {
  const normalizedSemester = Math.max(1, Number(semester) || 1)
  const totalSemesters = Math.max(2, Number(semestersCount || 2) || 2)
  if (totalSemesters > 2) return Math.min(1, Math.max(0.5, normalizedSemester / totalSemesters))
  return normalizedSemester <= 1 ? 0.5 : 1
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
      payments: { select: TUITION_PAYMENT_SELECT },
      programRef: { select: { price: true } },
    },
  })
  if (!app) return null
  const appeal = await findActiveAppeal(app.id)
  const localTotalTuition = inferTotalTuition(app.payments, Number(app.programRef?.price || 0))
  const coverage = app.userId && app.programId
    ? await computeTuitionCoverage(app.userId, app.programId)
    : null
  const totalTuition = coverage?.due ?? localTotalTuition
  const paidTuition = coverage?.covered ?? tuitionPaidTotal(app.payments)
  const remainingTuition = roundMoney(Math.max(0, totalTuition - paidTuition))
  const { halfRequired, finalRequired } = installmentThresholds(totalTuition, appeal)
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
      payments: { select: TUITION_PAYMENT_SELECT },
      programRef: { select: { price: true } },
    },
  })
  if (!app) return null
  const appeal = await findActiveAppeal(app.id)
  const coverage = await computeTuitionCoverage(userId, programId)
  const fallbackTuition = Number(app.programRef?.price || 0)
  const totalTuition = coverage?.due ?? inferTotalTuition(app.payments, fallbackTuition)
  const paidTuition = coverage?.covered ?? tuitionPaidTotal(app.payments)
  const remainingTuition = roundMoney(Math.max(0, totalTuition - paidTuition))
  const { halfRequired, finalRequired } = installmentThresholds(totalTuition, appeal)
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
  const [plan, program] = await Promise.all([
    getStudentTuitionPlan(userId, programId),
    db.program.findUnique({ where: { id: programId }, select: { semestersCount: true } }),
  ])
  const coverage = plan
    ? { due: plan.totalTuition, covered: plan.paidTuition, ratio: plan.totalTuition <= 0 ? 1 : Math.max(0, Math.min(1, plan.paidTuition / plan.totalTuition)) }
    : await computeTuitionCoverage(userId, programId)
  if (coverage.due <= 0) return { ok: true as const, plan }

  const requiredRatio = requiredCoverageRatioForSemester(semester, program?.semestersCount)
  const requiredAmount = roundMoney(coverage.due * requiredRatio)
  const gatePlan = plan
    ? {
        ...plan,
        totalTuition: coverage.due,
        paidTuition: coverage.covered,
        remainingTuition: roundMoney(Math.max(0, coverage.due - coverage.covered)),
        halfRequired: roundMoney(coverage.due * 0.5),
        finalRequired: coverage.due,
        firstSemesterAllowed: coverage.ratio >= 0.5,
        secondSemesterAllowed: coverage.ratio >= 1,
      }
    : plan

  if (coverage.ratio + 0.000001 < requiredRatio) {
    if (semester === 1) {
      return {
        ok: false as const,
        code: 'TUITION_HALF_REQUIRED',
        totalTuition: coverage.due,
        paidTuition: coverage.covered,
        requiredAmount,
        remainingTuition: roundMoney(Math.max(0, coverage.due - coverage.covered)),
        plan: gatePlan,
        error: `لا يمكن فتح امتحان الفصل الأول قبل سداد نصف الرسوم الدراسية على الأقل. المسدد حالياً ${coverage.covered}$ والمطلوب ${requiredAmount}$.`,
      }
    }
    return {
      ok: false as const,
      code: 'TUITION_FULL_REQUIRED',
      totalTuition: coverage.due,
      paidTuition: coverage.covered,
      requiredAmount,
      remainingTuition: roundMoney(Math.max(0, coverage.due - coverage.covered)),
      plan: gatePlan,
      error: `لا يمكن فتح امتحان الفصل الثاني قبل سداد بقية الرسوم الدراسية كاملة. المسدد حالياً ${coverage.covered}$ والمطلوب ${requiredAmount}$.`,
    }
  }
  return {
    ok: true as const,
    totalTuition: coverage.due,
    paidTuition: coverage.covered,
    requiredAmount,
    remainingTuition: roundMoney(Math.max(0, coverage.due - coverage.covered)),
    plan: gatePlan,
  }
}
