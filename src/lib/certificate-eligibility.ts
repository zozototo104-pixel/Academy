import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { calculateFinalGrade, type FinalGradeResult } from '@/lib/final-grade'
import { TUITION_PURPOSES, inferTotalTuition, roundMoney, tuitionPaidTotal } from '@/lib/tuition-installments'

export type CertificateEligibilityDbClient = typeof db | Prisma.TransactionClient

export const CERTIFICATE_PASS_SCORE = 51

export interface ProgramCertificateEligibility {
  ok: boolean
  score: number | null
  gradeLabel: string | null
  missing: string[]
  components: FinalGradeResult['components']
  error?: string
}

function round1(n: number) {
  return Math.round(n * 10) / 10
}

function percent(score: number) {
  const rounded = round1(score)
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

export function certificateGradeLabel(score: number) {
  const p = percent(score)
  if (score >= 90) return `${p}% — امتياز`
  if (score >= 80) return `${p}% — جيد جداً`
  if (score >= 70) return `${p}% — جيد`
  if (score >= CERTIFICATE_PASS_SCORE) return `${p}% — ناجح`
  return `${p}% — غير مجتاز`
}

export function certificateGradeLabelEn(score: number) {
  const p = percent(score)
  if (score >= 90) return `${p}% — Excellent`
  if (score >= 80) return `${p}% — Very Good`
  if (score >= 70) return `${p}% — Good`
  if (score >= CERTIFICATE_PASS_SCORE) return `${p}% — Pass`
  return `${p}% — Not Passed`
}

function missingError(missing: string[]) {
  return `لا يمكن إصدار شهادة البرنامج قبل اكتمال عناصر الدرجة النهائية: ${missing.length ? missing.join('، ') : 'عناصر التقييم غير مكتملة'}.`
}

function failedComponentLabels(finalGrade: FinalGradeResult) {
  return finalGrade.components
    .filter((component) => component.ready && typeof component.score === 'number' && component.score < CERTIFICATE_PASS_SCORE)
    .map((component) => `${component.label} (${percent(component.score || 0)}%)`)
}

function isSettledPayment(status: string) {
  return status === 'PAID' || status === 'WAIVED'
}

function paymentEligibilityError(payments: Array<{ purpose: string; status: string; amount: number; amountCents?: number | null; waiverType?: string | null; waiverStatus?: string | null; waivedAmount?: number | null; waivedAmountCents?: number | null; originalAmount?: number | null; originalAmountCents?: number | null }>, programPrice?: number | null, scholarshipFull?: boolean | null) {
  if (scholarshipFull === true) return null
  const tuitionRows = payments.filter((p) => TUITION_PURPOSES.includes(p.purpose))
  const nonTuitionUnpaid = payments.filter((p) => !TUITION_PURPOSES.includes(p.purpose) && !isSettledPayment(p.status))
  if (nonTuitionUnpaid.length) return 'لا يمكن إصدار الشهادة قبل سداد جميع فواتير الطلب غير الدراسية.'
  if (tuitionRows.length === 0) return null
  const total = roundMoney(inferTotalTuition(payments, Number(programPrice || 0)))
  const paid = roundMoney(tuitionPaidTotal(payments))
  if (total > 0 && paid < total) return `لا يمكن إصدار الشهادة قبل استكمال الرسوم الدراسية. المسدد ${paid}$ من ${total}$.`
  return null
}

export async function evaluateProgramCertificateEligibility(input: {
  userId?: string | null
  programId?: string | null
  admissionId?: string | null
  client?: CertificateEligibilityDbClient
}): Promise<ProgramCertificateEligibility> {
  const client = input.client || db
  const userId = input.userId || null
  const programId = input.programId || null
  if (!userId || !programId) {
    const identityMissing = [
      !userId ? 'حساب الطالب' : null,
      !programId ? 'البرنامج الدراسي' : null,
    ].filter(Boolean) as string[]
    return {
      ok: false,
      score: null,
      gradeLabel: null,
      missing: identityMissing,
      components: [],
      error: `لا يمكن إصدار شهادة برنامج دون ربطها بسجل طالب وبرنامج دراسي للتحقق من الاستحقاق: ${identityMissing.join('، ')}.`,
    }
  }

  const resolvedUserId = userId
  const resolvedProgramId = programId
  const admissionId = input.admissionId || null
  const finalGrade = await calculateFinalGrade({ userId: resolvedUserId, programId: resolvedProgramId, admissionId, client })
  if (finalGrade.score === null) {
    return {
      ok: false,
      score: null,
      gradeLabel: null,
      missing: finalGrade.missing,
      components: finalGrade.components,
      error: missingError(finalGrade.missing),
    }
  }

  const failedComponents = failedComponentLabels(finalGrade)
  if (failedComponents.length) {
    return {
      ok: false,
      score: finalGrade.score,
      gradeLabel: certificateGradeLabel(finalGrade.score),
      missing: failedComponents,
      components: finalGrade.components,
      error: `لا يمكن إصدار الشهادة قبل النجاح في كل عناصر التقييم. العناصر دون ${CERTIFICATE_PASS_SCORE}%: ${failedComponents.join('، ')}.`,
    }
  }

  const program = await client.program.findUnique({
    where: { id: resolvedProgramId },
    select: { category: true, price: true },
  })

  const enrollment = await client.enrollment.findUnique({
    where: { userId_programId: { userId: resolvedUserId, programId: resolvedProgramId } },
    select: { id: true },
  })
  const paymentFilters = [
    ...(enrollment?.id ? [{ enrollmentId: enrollment.id }] : []),
    ...(admissionId ? [{ admissionId }] : []),
  ]
  const payments = paymentFilters.length
    ? await client.payment.findMany({
        where: { OR: paymentFilters },
        select: { purpose: true, status: true, amount: true, amountCents: true, waiverType: true, waivedAmount: true, waivedAmountCents: true, originalAmount: true, originalAmountCents: true },
      })
    : []
  const financeError = paymentEligibilityError(payments, program?.price)
  if (financeError) {
    return {
      ok: false,
      score: finalGrade.score,
      gradeLabel: certificateGradeLabel(finalGrade.score),
      missing: ['الرسوم المدفوعة'],
      components: finalGrade.components,
      error: financeError,
    }
  }

  const requiresThesis = ['MASTERS', 'DOCTORATE'].includes(program?.category || '')

  if (requiresThesis) {
    const thesis = await client.thesisSubmission.findFirst({
      where: admissionId ? { admissionId } : { userId: resolvedUserId },
      orderBy: { updatedAt: 'desc' },
      select: { status: true, resultScore: true, passed: true },
    })
    const thesisPassed =
      thesis?.status === 'RESULT_APPROVED' &&
      thesis.passed === true &&
      typeof thesis.resultScore === 'number' &&
      thesis.resultScore >= CERTIFICATE_PASS_SCORE

    if (!thesisPassed) {
      return {
        ok: false,
        score: finalGrade.score,
        gradeLabel: certificateGradeLabel(finalGrade.score),
        missing: ['بحث التخرج/المناقشة النهائية المعتمدة بدرجة نجاح'],
        components: finalGrade.components,
        error: `لا يمكن إصدار شهادة هذا المسار قبل اعتماد نتيجة بحث التخرج/المناقشة النهائية ونجاحها بدرجة لا تقل عن ${CERTIFICATE_PASS_SCORE}%.`,
      }
    }
  }

  if (finalGrade.score < CERTIFICATE_PASS_SCORE) {
    return {
      ok: false,
      score: finalGrade.score,
      gradeLabel: certificateGradeLabel(finalGrade.score),
      missing: [`الدرجة النهائية أقل من ${CERTIFICATE_PASS_SCORE}%`],
      components: finalGrade.components,
      error: `لا يمكن إصدار الشهادة لأن الدرجة النهائية ${percent(finalGrade.score)}% أقل من حد النجاح ${CERTIFICATE_PASS_SCORE}%.`,
    }
  }

  return {
    ok: true,
    score: finalGrade.score,
    gradeLabel: certificateGradeLabel(finalGrade.score),
    missing: [],
    components: finalGrade.components,
  }
}

export async function evaluateCertificateRecordEligibility(cert: {
  type?: string | null
  userId?: string | null
  admissionId?: string | null
  enrollmentId?: string | null
  serial?: string | null
  program?: string | null
  grade?: string | null
  legacy?: boolean | null
}): Promise<ProgramCertificateEligibility> {
  if (cert.type && cert.type !== 'PROGRAM_COMPLETION') {
    return { ok: true, score: null, gradeLabel: null, missing: [], components: [] }
  }
  if (cert.legacy) {
    return { ok: true, score: null, gradeLabel: cert.grade || null, missing: [], components: [] }
  }

  let userId = cert.userId || null
  let programId: string | null = null
  let admissionId = cert.admissionId || null

  if (admissionId) {
    const admission = await db.admissionApplication.findUnique({
      where: { id: admissionId },
      select: { userId: true, programId: true },
    })
    userId = userId || admission?.userId || null
    programId = admission?.programId || null
  }

  if ((!userId || !programId) && cert.enrollmentId) {
    const enrollment = await db.enrollment.findUnique({
      where: { id: cert.enrollmentId },
      select: { userId: true, programId: true },
    })
    userId = userId || enrollment?.userId || null
    programId = programId || enrollment?.programId || null
  }

  if ((!userId || !programId) && cert.serial) {
    const enrollment = await db.enrollment.findFirst({
      where: { certificateNo: cert.serial, ...(userId ? { userId } : {}) },
      select: { userId: true, programId: true },
    })
    userId = userId || enrollment?.userId || null
    programId = programId || enrollment?.programId || null
  }

  if (!programId && cert.program) {
    const title = cert.program.trim()
    const program = await db.program.findFirst({
      where: {
        OR: [
          { titleAr: title },
          { titleAr: { contains: title, mode: 'insensitive' } },
          { titleEn: { contains: title, mode: 'insensitive' } },
        ],
      },
      select: { id: true },
    })
    programId = program?.id || null
  }

  return evaluateProgramCertificateEligibility({ userId, programId, admissionId })
}
