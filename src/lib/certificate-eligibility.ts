import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { calculateFinalGrade, type FinalGradeResult } from '@/lib/final-grade'
import { TUITION_PURPOSES, inferTotalTuition, roundMoney, tuitionPaidTotal } from '@/lib/tuition-installments'

export type CertificateEligibilityDbClient = typeof db | Prisma.TransactionClient

/** Academic graduation is based on the cumulative earned mark, strictly above 50%. */
export const CERTIFICATE_PASS_SCORE = 50

/** Unit quizzes and assignments affect the weighted mean only.
 * Semester exams, and research/defense where applicable, are graduation gates.
 */
export function requiredGraduationComponents(
  category: string,
  components: FinalGradeResult['components'],
): string[] {
  if (category === 'MASTERS') {
    return ['semester1_exam', 'semester2_exam', 'thesis', 'defense']
  }
  if (category === 'DOCTORATE') {
    return ['reading_exam', 'analysis_exam', 'thesis', 'defense']
  }
  return ['final_exam', ...(components.some((item) => item.key === 'thesis' && item.weight > 0) ? ['thesis'] : [])]
}


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
  if (score > CERTIFICATE_PASS_SCORE) return `${p}% — ناجح`
  return `${p}% — غير مجتاز`
}

export function certificateGradeLabelEn(score: number) {
  const p = percent(score)
  if (score >= 90) return `${p}% — Excellent`
  if (score >= 80) return `${p}% — Very Good`
  if (score >= 70) return `${p}% — Good`
  if (score > CERTIFICATE_PASS_SCORE) return `${p}% — Pass`
  return `${p}% — Not Passed`
}

/**
 * Graduation requirements and grade-weight approval are different contracts:
 * a legacy rules profile may declare graduation research before its text-based
 * formula has been mapped and signed. Never let that pending mapping bypass
 * an explicitly declared research requirement.
 */
function declaresGraduationResearch(admissionRules: unknown): boolean {
  if (!admissionRules || typeof admissionRules !== 'object') return false
  const profile = (admissionRules as Record<string, any>).academicProfile
  const rows = profile?.finalEvaluationFormula
  if (!Array.isArray(rows)) return false
  return rows.some((row) => {
    if (row?.key === 'thesis') return true
    const label = String(row?.label || '').replace(/\s+/g, ' ').trim()
    return label.includes('بحث التخرج') || label.includes('بحث تخرج') ||
      label.includes('الأطروحة') || label.includes('أطروحة')
  })
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
  // Missing/failed components earn zero weighted credit; none is an independent
  // graduation veto. Use the exact unrounded cumulative mark, not the display value.
  // For archived graduations, preserve the already approved official mark.
  const academicScore = finalGrade.score ?? finalGrade.earnedScore
  if (!Number.isFinite(academicScore) || academicScore <= CERTIFICATE_PASS_SCORE) {
    return {
      ok: false,
      score: Number.isFinite(academicScore) ? academicScore : null,
      gradeLabel: Number.isFinite(academicScore) ? certificateGradeLabel(academicScore) : null,
      missing: [`المعدل التراكمي لا يتجاوز ${CERTIFICATE_PASS_SCORE}%`],
      components: finalGrade.components,
      error: `لا يمكن إصدار الشهادة لأن المعدل التراكمي المكتسب ${percent(Number.isFinite(academicScore) ? academicScore : 0)}% يجب أن يكون أعلى من ${CERTIFICATE_PASS_SCORE}%.`,
    }
  }

  const program = await client.program.findUnique({
    where: { id: resolvedProgramId },
    select: { category: true, price: true, admissionRules: true },
  })

  const enrollment = await client.enrollment.findUnique({
    where: { userId_programId: { userId: resolvedUserId, programId: resolvedProgramId } },
    select: { id: true, status: true, certificateNo: true, finalScore: true },
  })
  const admission = admissionId
    ? await client.admissionApplication.findUnique({ where: { id: admissionId }, select: { scholarshipFull: true } })
    : await client.admissionApplication.findFirst({ where: { userId: resolvedUserId, programId: resolvedProgramId }, orderBy: { createdAt: 'desc' }, select: { scholarshipFull: true } })
  const paymentFilters = [
    ...(enrollment?.id ? [{ enrollmentId: enrollment.id }] : []),
    ...(admissionId ? [{ admissionId }] : []),
  ]
  const payments = paymentFilters.length
    ? await client.payment.findMany({
        where: { OR: paymentFilters },
        select: { purpose: true, status: true, amount: true, amountCents: true, waiverType: true, waiverStatus: true, waivedAmount: true, waivedAmountCents: true, originalAmount: true, originalAmountCents: true },
      })
    : []
  const financeError = paymentEligibilityError(payments, program?.price, admission?.scholarshipFull)
  if (financeError) {
    return {
      ok: false,
      score: academicScore,
      gradeLabel: certificateGradeLabel(academicScore),
      missing: ['الرسوم المدفوعة'],
      components: finalGrade.components,
      error: financeError,
    }
  }

  // A previously issued, officially completed certificate retains its historical decision.
  // New certificates require the mandatory programme assessments even if earnedScore > 50.
  const alreadyCertified = enrollment?.status === 'COMPLETED' &&
    !!enrollment.certificateNo && typeof enrollment.finalScore === 'number'
  if (!alreadyCertified) {
    const requiredKeys = requiredGraduationComponents(program?.category || 'DIPLOMA', finalGrade.components)
    const unfulfilled = requiredKeys.filter((key) => {
      const item = finalGrade.components.find((component) => component.key === key)
      // A missing/exempt required semester exam or research must never be waived silently.
      return !item || !item.ready || item.exempt || item.score === null
    })
    if (program?.category === 'DIPLOMA' && declaresGraduationResearch(program.admissionRules) &&
        !requiredKeys.includes('thesis')) {
      const thesis = await client.thesisSubmission.findFirst({
        where: admissionId ? { admissionId } : { userId: resolvedUserId },
        orderBy: { updatedAt: 'desc' },
        select: { status: true, passed: true, resultScore: true },
      })
      if (thesis?.status !== 'RESULT_APPROVED' || thesis.passed !== true ||
          typeof thesis.resultScore !== 'number') {
        unfulfilled.push('thesis')
      }
    }
    if (unfulfilled.length > 0) {
      const missing = unfulfilled.map((key) =>
        finalGrade.components.find((component) => component.key === key)?.label ||
          (key === 'thesis' ? 'بحث التخرج' : key),
      )
      return {
        ok: false,
        score: academicScore,
        gradeLabel: certificateGradeLabel(academicScore),
        missing,
        components: finalGrade.components,
        error: `لا يمكن إصدار الشهادة قبل اجتياز الامتحانات الفصلية واعتماد بحث التخرج/المناقشة المطلوبة: ${missing.join('، ')}.`,
      }
    }
  }

  return {
    ok: true,
    score: academicScore,
    gradeLabel: certificateGradeLabel(academicScore),
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
