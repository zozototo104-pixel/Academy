import { db } from '@/lib/db'

export const TUITION_PURPOSES = ['TUITION', 'TUITION_INSTALLMENT']

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
}

export function roundMoney(n: number): number {
  return Math.max(0, Math.round((Number(n) || 0) * 100) / 100)
}

export function tuitionPaidTotal(payments: Array<{ purpose: string; status: string; amount: number }>): number {
  return roundMoney(payments.filter((p) => TUITION_PURPOSES.includes(p.purpose) && p.status === 'PAID').reduce((sum, p) => sum + (Number(p.amount) || 0), 0))
}

export function inferTotalTuition(payments: Array<{ purpose: string; status: string; amount: number }>, fallback = 0): number {
  const fullTuition = payments.filter((p) => p.purpose === 'TUITION').map((p) => Number(p.amount) || 0)
  const maxFull = Math.max(0, ...fullTuition)
  if (maxFull > 0) return roundMoney(maxFull)
  const installments = payments.filter((p) => TUITION_PURPOSES.includes(p.purpose)).reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
  return roundMoney(Math.max(fallback, installments))
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
      payments: { select: { purpose: true, status: true, amount: true } },
    },
  })
  if (!app) return null
  const appeal = await findActiveAppeal(app.id)
  const totalTuition = inferTotalTuition(app.payments)
  const paidTuition = tuitionPaidTotal(app.payments)
  const halfRequired = roundMoney(Math.max(totalTuition / 2, Number(appeal?.firstSemesterRequiredAmount ?? 0)))
  const finalRequired = roundMoney(Math.max(totalTuition, Number(appeal?.finalRequiredAmount ?? 0)))
  return {
    admissionId: app.id,
    reference: app.reference,
    program: app.program,
    totalTuition,
    paidTuition,
    remainingTuition: roundMoney(Math.max(0, totalTuition - paidTuition)),
    halfRequired,
    finalRequired,
    firstSemesterAllowed: totalTuition <= 0 || paidTuition >= halfRequired,
    secondSemesterAllowed: totalTuition <= 0 || paidTuition >= finalRequired,
    appealStatus: appeal?.status || null,
    appealId: appeal?.id || null,
    approvedInitialAmount: appeal?.approvedInitialAmount ?? null,
    firstSemesterRequiredAmount: appeal?.firstSemesterRequiredAmount ?? null,
    finalRequiredAmount: appeal?.finalRequiredAmount ?? null,
  }
}

export async function getStudentTuitionPlan(userId: string, programId: string): Promise<TuitionPlanSummary | null> {
  const app = await db.admissionApplication.findFirst({
    where: { userId, programId },
    orderBy: { createdAt: 'desc' },
    include: { payments: { select: { purpose: true, status: true, amount: true } } },
  })
  if (!app) return null
  const appeal = await findActiveAppeal(app.id)
  const totalTuition = inferTotalTuition(app.payments)
  const paidTuition = tuitionPaidTotal(app.payments)
  const halfRequired = roundMoney(Math.max(totalTuition / 2, Number(appeal?.firstSemesterRequiredAmount ?? 0)))
  const finalRequired = roundMoney(Math.max(totalTuition, Number(appeal?.finalRequiredAmount ?? 0)))
  return {
    admissionId: app.id,
    reference: app.reference,
    program: app.program,
    totalTuition,
    paidTuition,
    remainingTuition: roundMoney(Math.max(0, totalTuition - paidTuition)),
    halfRequired,
    finalRequired,
    firstSemesterAllowed: !appeal || appeal.status !== 'APPROVED' || totalTuition <= 0 || paidTuition >= halfRequired,
    secondSemesterAllowed: !appeal || appeal.status !== 'APPROVED' || totalTuition <= 0 || paidTuition >= finalRequired,
    appealStatus: appeal?.status || null,
    appealId: appeal?.id || null,
    approvedInitialAmount: appeal?.approvedInitialAmount ?? null,
    firstSemesterRequiredAmount: appeal?.firstSemesterRequiredAmount ?? null,
    finalRequiredAmount: appeal?.finalRequiredAmount ?? null,
  }
}

export async function enforceSemesterTuitionGate(userId: string, programId: string, semester: number) {
  const plan = await getStudentTuitionPlan(userId, programId)
  if (!plan || plan.appealStatus !== 'APPROVED') return { ok: true as const, plan: null }
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
  return { ok: true as const, plan }
}
