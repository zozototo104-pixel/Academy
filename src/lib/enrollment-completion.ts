import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { certificateGradeLabel, certificateGradeLabelEn, evaluateProgramCertificateEligibility, type ProgramCertificateEligibility } from '@/lib/certificate-eligibility'
import { createCertificateQrToken, nextCertificateSerial } from '@/lib/certificate-identity'
import { notifyAdmins } from '@/lib/notify'
import { TUITION_PURPOSES, inferTotalTuition, roundMoney, tuitionPaidTotal } from '@/lib/tuition-installments'

type Tx = Prisma.TransactionClient

type PaymentRow = {
  purpose: string
  status: string
  amount: number
  amountCents?: number | null
  waiverType?: string | null
  waiverStatus?: string | null
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
    waiverStatus: p.waiverStatus,
    waivedAmount: p.waivedAmount,
    waivedAmountCents: p.waivedAmountCents,
    originalAmount: p.originalAmount,
    originalAmountCents: p.originalAmountCents,
  }))
}

function financialFailure(payments: PaymentRow[], programPrice: number | null | undefined, scholarshipFull?: boolean | null) {
  if (scholarshipFull === true) return null
  const rows = paymentRows(payments)
  const tuitionRows = rows.filter((p) => TUITION_PURPOSES.includes(p.purpose))
  const nonTuitionUnpaid = rows.filter((p) => !TUITION_PURPOSES.includes(p.purpose) && !isSettled(p.status))
  if (nonTuitionUnpaid.length > 0) {
    return 'لا يمكن إكمال التسجيل أو إصدار الشهادة قبل سداد جميع فواتير الطلب غير الدراسية.'
  }
  if (tuitionRows.length === 0) return null
  const total = roundMoney(inferTotalTuition(rows, Number(programPrice || 0)))
  const paid = roundMoney(tuitionPaidTotal(rows))
  if (total > 0 && paid < total) {
    return `لا يمكن إكمال التسجيل أو إصدار الشهادة قبل استكمال الرسوم الدراسية. المسدد ${paid}$ من ${total}$.`
  }
  return null
}

async function resolveCompletionContext(tx: Tx, input: CompleteEnrollmentInput) {
  const admission = input.admissionId
    ? await tx.admissionApplication.findUnique({ where: { id: input.admissionId }, select: { id: true, userId: true, programId: true, fullName: true, fullNameEn: true, program: true, country: true, email: true, status: true, scholarshipFull: true } })
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
    select: { id: true, userId: true, programId: true, fullName: true, fullNameEn: true, program: true, country: true, email: true, status: true, scholarshipFull: true },
  })

  const program = await tx.program.findUnique({
    where: { id: enrollment.programId },
    select: { id: true, titleAr: true, titleEn: true, price: true },
  })

  return { admission, enrollment, userId: enrollment.userId, programId: enrollment.programId, program, matchedAdmission }
}

/**
 * The single definition of graduation readiness: tuition/finance settled
 * AND the academic eligibility gates fulfilled. Used by the issuance
 * transaction (fresh re-check) and by graduation-request registration
 * (stored snapshot) so the two can never drift apart.
 */
async function assessGraduationReadiness(
  tx: Tx,
  enrollment: { id: string; userId: string; programId: string },
  program: { price: number | null },
  matchedAdmission: { id: string; scholarshipFull?: boolean | null } | null,
): Promise<{ financeError: string | null; eligibility: ProgramCertificateEligibility | null }> {
  const payments = await tx.payment.findMany({
    where: {
      OR: [
        { enrollmentId: enrollment.id },
        ...(matchedAdmission?.id ? [{ admissionId: matchedAdmission.id }] : []),
      ],
    },
    select: { purpose: true, status: true, amount: true, amountCents: true, waiverType: true, waiverStatus: true, waivedAmount: true, waivedAmountCents: true, originalAmount: true, originalAmountCents: true },
  })
  const financeError = financialFailure(payments, program.price, matchedAdmission?.scholarshipFull)
  if (financeError) return { financeError, eligibility: null }
  const eligibility = await evaluateProgramCertificateEligibility({
    userId: enrollment.userId,
    programId: enrollment.programId,
    admissionId: matchedAdmission?.id || null,
    client: tx,
  })
  return { financeError: null, eligibility }
}

/**
 * The stored administrative approval for an enrollment, if one exists.
 * Defensive about the table being absent (older test doubles): absence
 * means NO approval, so issuance stays refused — never the reverse.
 */
async function storedGraduationRequest(tx: Tx, enrollmentId: string): Promise<any | null> {
  try {
    const table = (tx as any).graduationRequest
    if (typeof table?.findUnique !== 'function') return null
    return await table.findUnique({ where: { enrollmentId } })
  } catch {
    return null
  }
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

  // Previously issued certificates remain valid and unchanged, and are
  // returned as-is for administrative retrieval and resend. Creating a
  // NEW certificate further below requires a stored APPROVED graduation
  // request — never an automatic academic event on its own.
  if (enrollment.status === 'COMPLETED' && enrollment.certificateNo) {
    // Preserve historical certificates and return the actual record for
    // administrative retrieval and resend, without changing any stored grade.
    const certificate = await tx.certificate.findFirst({
      where: { enrollmentId: enrollment.id, type: 'PROGRAM_COMPLETION' },
    })
    if (!certificate || certificate.serial !== enrollment.certificateNo) {
      return {
        ok: false,
        completed: false,
        certificateIssued: false,
        status: 'NOT_ELIGIBLE',
        httpStatus: 409,
        code: 'ISSUED_CERTIFICATE_RECORD_MISSING',
        error: 'سجل الشهادة الصادرة غير متطابق؛ يلزم تدقيق إداري دون إعادة إصدار تلقائي.',
        enrollmentId: enrollment.id,
        admissionId: matchedAdmission?.id || null,
      }
    }
    return {
      ok: true,
      completed: true,
      certificateIssued: false,
      status: 'COMPLETED',
      enrollmentId: enrollment.id,
      admissionId: matchedAdmission?.id || null,
      certificate,
    }
  }
  // Fresh re-check at issuance time: finance and academic gates are
  // evaluated now, inside this transaction — not trusted from any older
  // snapshot — before the stored-approval gate below.
  const { financeError, eligibility } = await assessGraduationReadiness(tx, enrollment, program, matchedAdmission)
  if (financeError) {
    return { ok: false, completed: false, certificateIssued: false, status: 'NOT_ELIGIBLE', httpStatus: 422, code: 'PAYMENT_REQUIRED', error: financeError, enrollmentId: enrollment.id, admissionId: matchedAdmission?.id || null }
  }
  if (!eligibility || !eligibility.ok) {
    return { ok: false, completed: false, certificateIssued: false, status: 'NOT_ELIGIBLE', httpStatus: 422, code: 'ACADEMIC_REQUIREMENTS_INCOMPLETE', error: eligibility?.error || 'لا يمكن إصدار الشهادة قبل اكتمال شروط النجاح الأكاديمي.', missing: eligibility?.missing, enrollmentId: enrollment.id, admissionId: matchedAdmission?.id || null, eligibility: eligibility || undefined }
  }

  const existing = await tx.certificate.findFirst({ where: { enrollmentId: enrollment.id, type: 'PROGRAM_COMPLETION' } })
  const holderName = (input.holderName || matchedAdmission?.fullName || '').trim()
  const programTitle = (input.programTitle || matchedAdmission?.program || program.titleAr || program.titleEn || '').trim()
  if (!holderName || !programTitle) {
    return { ok: false, completed: false, certificateIssued: false, status: 'NOT_ELIGIBLE', httpStatus: 422, code: 'CERTIFICATE_IDENTITY_REQUIRED', error: 'اسم صاحب الشهادة واسم البرنامج مطلوبان لإصدار الشهادة.', enrollmentId: enrollment.id, admissionId: matchedAdmission?.id || null, eligibility }
  }

  // Stored-approval law: retrieving an already-issued certificate needs
  // no approval, but CREATING a new one requires an APPROVED graduation
  // request stored in the database. This check is what refuses direct
  // API calls that bypass the administration's approval screen.
  const graduationRequest = await storedGraduationRequest(tx, enrollment.id)
  if (!existing && graduationRequest?.status !== 'APPROVED') {
    return { ok: false, completed: false, certificateIssued: false, status: 'NOT_ELIGIBLE', httpStatus: 409, code: 'ADMIN_GRADUATION_APPROVAL_REQUIRED', error: 'إصدار شهادة التخرج يتطلب مصادقة إدارية محفوظة على طلب التخرج.', enrollmentId: enrollment.id, admissionId: matchedAdmission?.id || null, eligibility }
  }

  const grade = eligibility.gradeLabel || (typeof eligibility.score === 'number' ? certificateGradeLabel(eligibility.score) : null)
  const holderNameEn = matchedAdmission?.fullNameEn?.trim() || (/^[A-Za-z .'-]+$/.test(holderName) ? holderName : null)
  const gradeEn = typeof eligibility.score === 'number' ? certificateGradeLabelEn(eligibility.score) : null
  const certificate = existing || await createProgramCompletionCertificate(tx, {
    qrToken: createCertificateQrToken(),
    type: 'PROGRAM_COMPLETION',
    holderName,
    holderNameEn,
    program: programTitle,
    programEn: program.titleEn || null,
    grade,
    gradeEn,
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
  if (graduationRequest) {
    await (tx as any).graduationRequest.update({
      where: { enrollmentId: enrollment.id },
      data: { status: 'ISSUED', ready: true, certificateId: certificate.id, issuedAt: new Date() },
    })
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

export interface RegisterGraduationResult {
  registered: boolean
  requestId?: string | null
  status?: string | null
  ready?: boolean
  certificateNo?: string | null
}

/**
 * What academic events (exam submissions, review resolutions, appeal
 * resolutions, assignment grading) call instead of issuing: evaluate
 * readiness now, then create or refresh the student's living graduation
 * transaction with a stored snapshot of the outcome. Creating the
 * transaction notifies the administration once; refreshes stay silent.
 * A decision already recorded (APPROVED / REJECTED) is never rewritten
 * here — only the snapshot moves, so a rejected student who completes
 * the missing requirements reappears with current facts, and issuance
 * still re-checks everything fresh before creating any certificate.
 * Never throws: a registration failure must not undo a saved grade.
 */
export async function registerGraduationRequest(input: CompleteEnrollmentInput): Promise<RegisterGraduationResult> {
  try {
    const outcome = await db.$transaction(async (tx) => {
      const context = await resolveCompletionContext(tx, input)
      const { enrollment, program, matchedAdmission } = context
      if (!enrollment || !program) return null
      if (enrollment.status === 'COMPLETED') {
        return { registered: false, status: 'ISSUED' as string | null, certificateNo: enrollment.certificateNo || null, created: false, studentName: null as string | null, programTitle: null as string | null, ready: true, missing: [] as string[] }
      }
      const table = (tx as any).graduationRequest
      if (typeof table?.findUnique !== 'function' || typeof table?.create !== 'function' || typeof table?.update !== 'function') {
        return { registered: false, status: null, certificateNo: null, created: false, studentName: null, programTitle: null, ready: false, missing: [] as string[] }
      }
      const { financeError, eligibility } = await assessGraduationReadiness(tx, enrollment, program, matchedAdmission)
      const ready = !financeError && !!eligibility?.ok
      const missing: string[] = []
      if (financeError) missing.push(financeError)
      if (eligibility && !eligibility.ok) missing.push(...eligibility.missing)
      const snapshot = {
        ready,
        score: eligibility?.score ?? null,
        gradeLabel: eligibility?.gradeLabel ?? null,
        missing,
        financeError: financeError || null,
        academicError: eligibility && !eligibility.ok ? eligibility.error || null : null,
        checkedAt: new Date().toISOString(),
      }
      const existing = await table.findUnique({ where: { enrollmentId: enrollment.id } })
      if (existing) {
        if (existing.status === 'ISSUED') {
          return { registered: false, status: 'ISSUED' as string | null, certificateNo: enrollment.certificateNo || null, created: false, studentName: null, programTitle: null, ready: true, missing: [] as string[] }
        }
        const updated = await table.update({
          where: { enrollmentId: enrollment.id },
          data: { userId: enrollment.userId, programId: enrollment.programId, admissionId: matchedAdmission?.id || null, ready, score: snapshot.score, snapshot },
        })
        return { registered: true, requestId: updated.id as string, status: updated.status as string, certificateNo: null, created: false, studentName: null, programTitle: null, ready, missing }
      }
      const created = await table.create({
        data: { enrollmentId: enrollment.id, userId: enrollment.userId, programId: enrollment.programId, admissionId: matchedAdmission?.id || null, status: 'PENDING', ready, score: snapshot.score, snapshot },
      })
      return {
        registered: true,
        requestId: created.id as string,
        status: created.status as string,
        certificateNo: null,
        created: true,
        studentName: matchedAdmission?.fullName || null,
        programTitle: program.titleAr || program.titleEn || null,
        ready,
        missing,
      }
    })
    if (!outcome) return { registered: false, certificateNo: null }
    if (outcome.created) {
      try {
        const readinessLine = outcome.ready
          ? 'الطالب مستوفٍ لشروط التخرج الحالية وبانتظار مصادقتكم على الدرجة والإصدار.'
          : `أسباب عدم الاستحقاق الحالية: ${outcome.missing.slice(0, 4).join('؛ ') || 'غير مكتمل بعد'}`
        await notifyAdmins(
          'GENERAL',
          'طلب تخرج بانتظار المصادقة',
          `أُنشئت معاملة تخرج للطالب ${outcome.studentName || ''} في برنامج «${outcome.programTitle || ''}». ${readinessLine}`,
          'admin',
        )
      } catch {
        // إشعار الإدارة لا يعطّل تسجيل المعاملة أبدًا.
      }
    }
    return { registered: outcome.registered, requestId: (outcome as any).requestId ?? null, status: outcome.status, ready: outcome.ready, certificateNo: outcome.certificateNo }
  } catch {
    return { registered: false, certificateNo: null }
  }
}
