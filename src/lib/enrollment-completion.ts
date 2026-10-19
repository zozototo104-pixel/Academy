import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { certificateGradeLabel, evaluateProgramCertificateEligibility, type ProgramCertificateEligibility } from '@/lib/certificate-eligibility'
import { createCertificateQrToken, nextCertificateSerial } from '@/lib/certificate-identity'
import { inferTotalTuition, roundMoney, tuitionPaidTotal } from '@/lib/tuition-installments'

type Tx = Prisma.TransactionClient

type PaymentRow = {
  purpose: string
  status: string
  amount: number
  amountCents?: number | null
  waiverType?: string | null
  waivedAmount?: number | null
  waivedAmountCents?: number | null
  originalAmount?: number | null
  originalAmountCents?: number | null
}

export interface CompleteEnrollmentInput {
  enrollmentId?: string | null
  userId?: string | null
  programId?: string | null
  admissionId?: string | null
  holderName?: string | null
  programTitle?: string | null
  country?: string | null
  requireEligible?: boolean
}

export interface CompleteEnrollmentResult {
  ok: boolean
  completed: boolean
  certificateIssued: boolean
  status: 'COMPLETED' | 'NOT_ELIGIBLE'
  httpStatus?: number
  code?: string
  error?: string
  missing?: string[]
  enrollmentId?: string | null
  admissionId?: string | null
  certificate?: any
  eligibility?: ProgramCertificateEligibility
}

function isSettled(status: string) {
  return status === 'PAID' || status === 'WAIVED'
}

function paymentRows(payments: PaymentRow[]) {
  return payments.map((p) => ({
    purpose: p.purpose,
    status: p.status,
    amount: p.amount,
    amountCents: p.amountCents,
    waiverType: p.waiverType,
    waivedAmount: p.waivedAmount,
    waivedAmountCents: p.waivedAmountCents,
    originalAmount: p.originalAmount,
    originalAmountCents: p.originalAmountCents,
  }))
}

function financialFailure(payments: PaymentRow[], programPrice: number | null | undefined) {
  const rows = paymentRows(payments)
  const nonTuitionUnpaid = rows.filter((p) => !['TUITION', 'TUITION_INSTALLMENT'].includes(p.purpose) && !isSettled(p.status))
  if (nonTuitionUnpaid.length > 0) {
    return 'لا يمكن إكمال التسجيل أو إصدار الشهادة قبل سداد جميع فواتير الطلب غير الدراسية.'
  }
  const total = roundMoney(inferTotalTuition(rows, Number(programPrice || 0)))
  const paid = roundMoney(tuitionPaidTotal(rows))
  if (total > 0 && paid < total) {
    return `لا يمكن إكمال التسجيل أو إصدار الشهادة قبل استكمال الرسوم الدراسية. المسدد ${paid}$ من ${total}$.`
  }
  return null
}

async function resolveCompletionContext(tx: Tx, input: CompleteEnrollmentInput) {
  const admission = input.admissionId
    ? await tx.admissionApplication.findUnique({ where: { id: input.admissionId }, select: { id: true, userId: true, programId: true, fullName: true, program: true, country: true, email: true, status: true } })
    : null

  let enrollment = input.enrollmentId
    ? await tx.enrollment.findUnique({
        where: { id: input.enrollmentId },
        select: { id: true, userId: true, programId: true, status: true, certificateNo: true },
      })
    : null

  const userId = input.userId || admission?.userId || enrollment?.userId || null
  const programId = input.programId || admission?.programId || enrollment?.programId || null

  if (!enrollment && userId && programId) {
    enrollment = await tx.enrollment.findUnique({
      where: { userId_programId: { userId, programId } },
      select: { id: true, userId: true, programId: true, status: true, certificateNo: true },
    })
  }

  if (!enrollment || !userId || !programId) return { admission, enrollment: null, userId, programId, program: null, matchedAdmission: null }

  if ((admission?.userId && admission.userId !== enrollment.userId) || (admission?.programId && admission.programId !== enrollment.programId)) {
    return { admission, enrollment: null, userId, programId, program: null, matchedAdmission: null, mismatch: true }
  }

  const matchedAdmission = admission || await tx.admissionApplication.findFirst({
    where: { userId: enrollment.userId, programId: enrollment.programId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, userId: true, programId: true, fullName: true, program: true, country: true, email: true, status: true },
  })

  const program = await tx.program.findUnique({
    where: { id: enrollment.programId },
    select: { id: true, titleAr: true, titleEn: true, price: true },
  })

  return { admission, enrollment, userId: enrollment.userId, programId: enrollment.programId, program, matchedAdmission }
}

type ProgramCompletionCertificateCreateData = Omit<Prisma.CertificateUncheckedCreateInput, 'serial'>

function isCertificateSerialUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2002'
    && String(error.meta?.target || '').includes('serial')
}

async function createProgramCompletionCertificate(tx: Tx, data: ProgramCompletionCertificateCreateData) {
  return tx.certificate.create({ data: { ...data, serial: await nextCertificateSerial(tx) } })
}

export async function completeEnrollmentIfEligible(input: CompleteEnrollmentInput): Promise<CompleteEnrollmentResult> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await db.$transaction(async (tx) => completeEnrollmentIfEligibleInTransaction(tx, input))
    } catch (error) {
      lastError = error
      if (!isCertificateSerialUniqueConflict(error)) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('CERTIFICATE_SERIAL_UNIQUE_RETRY_EXHAUSTED')
}

export async function completeEnrollmentIfEligibleInTransaction(tx: Tx, input: CompleteEnrollmentInput): Promise<CompleteEnrollmentResult> {
  const context = await resolveCompletionContext(tx, input)
  if (context.mismatch) {
    return { ok: false, completed: false, certificateIssued: false, status: 'NOT_ELIGIBLE', httpStatus: 422, code: 'REGISTRATION_MISMATCH', error: 'طلب الالتحاق لا يطابق التسجيل المرتبط بالطالب والبرنامج.' }
  }
  const { enrollment, program, matchedAdmission } = context
  if (!enrollment || !program) {
    return { ok: false, completed: false, certificateIssued: false, status: 'NOT_ELIGIBLE', httpStatus: 422, code: 'ENROLLMENT_REQUIRED', error: 'لا يمكن إصدار شهادة برنامج دون تسجيل مطابق للطالب في البرنامج.' }
  }

  const payments = await tx.payment.findMany({
    where: {
      OR: [
        { enrollmentId: enrollment.id },
        ...(matchedAdmission?.id ? [{ admissionId: matchedAdmission.id }] : []),
      ],
    },
    select: { purpose: true, status: true, amount: true, amountCents: true, waiverType: true, waivedAmount: true, waivedAmountCents: true, originalAmount: true, originalAmountCents: true },
  })
  const financeError = financialFailure(payments, program.price)
  if (financeError) {
    return { ok: false, completed: false, certificateIssued: false, status: 'NOT_ELIGIBLE', httpStatus: 422, code: 'PAYMENT_REQUIRED', error: financeError, enrollmentId: enrollment.id, admissionId: matchedAdmission?.id || null }
  }

  const eligibility = await evaluateProgramCertificateEligibility({
    userId: enrollment.userId,
    programId: enrollment.programId,
    admissionId: matchedAdmission?.id || null,
    client: tx,
  })
  if (!eligibility.ok) {
    return { ok: false, completed: false, certificateIssued: false, status: 'NOT_ELIGIBLE', httpStatus: 422, code: 'ACADEMIC_REQUIREMENTS_INCOMPLETE', error: eligibility.error || 'لا يمكن إصدار الشهادة قبل اكتمال شروط النجاح الأكاديمي.', missing: eligibility.missing, enrollmentId: enrollment.id, admissionId: matchedAdmission?.id || null, eligibility }
  }

  const existing = await tx.certificate.findFirst({ where: { enrollmentId: enrollment.id, type: 'PROGRAM_COMPLETION' } })
  const holderName = (input.holderName || matchedAdmission?.fullName || '').trim()
  const programTitle = (input.programTitle || matchedAdmission?.program || program.titleAr || program.titleEn || '').trim()
  if (!holderName || !programTitle) {
    return { ok: false, completed: false, certificateIssued: false, status: 'NOT_ELIGIBLE', httpStatus: 422, code: 'CERTIFICATE_IDENTITY_REQUIRED', error: 'اسم صاحب الشهادة واسم البرنامج مطلوبان لإصدار الشهادة.', enrollmentId: enrollment.id, admissionId: matchedAdmission?.id || null, eligibility }
  }

  const certificate = existing || await createProgramCompletionCertificate(tx, {
    qrToken: createCertificateQrToken(),
    type: 'PROGRAM_COMPLETION',
    holderName,
    program: programTitle,
    grade: eligibility.gradeLabel || (typeof eligibility.score === 'number' ? certificateGradeLabel(eligibility.score) : null),
    country: (input.country || matchedAdmission?.country || '').trim() || null,
    userId: enrollment.userId,
    enrollmentId: enrollment.id,
    admissionId: matchedAdmission?.id || null,
  })

  await tx.enrollment.update({
    where: { id: enrollment.id },
    data: { status: 'COMPLETED', certificateNo: certificate.serial, ...(eligibility.score !== null ? { finalScore: eligibility.score } : {}) },
  })
  if (matchedAdmission?.id) {
    await tx.admissionApplication.update({ where: { id: matchedAdmission.id }, data: { status: 'CERTIFIED' } })
  }

  return {
    ok: true,
    completed: true,
    certificateIssued: !existing,
    status: 'COMPLETED',
    enrollmentId: enrollment.id,
    admissionId: matchedAdmission?.id || null,
    certificate,
    eligibility,
  }
}
