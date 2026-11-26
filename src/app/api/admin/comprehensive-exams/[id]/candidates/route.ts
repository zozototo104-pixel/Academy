import { randomBytes } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { hashPassword } from '@/lib/password'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { getStorageDownloadPathForKey } from '@/lib/storage'
import {
  checkComprehensiveCandidateDuplicate,
  checkComprehensiveDuplicateError,
  ComprehensiveExamPhase2Error,
  parseComprehensiveCandidateForm,
  sendComprehensiveCandidatePasswordSetup,
  storeComprehensiveCandidateFile,
  validateComprehensiveCandidateInput,
} from '@/lib/comprehensive-exam-phase2'

export const runtime = 'nodejs'

function phase2ErrorResponse(e: unknown, fallback: string) {
  if (e instanceof ComprehensiveExamPhase2Error) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
  }
  console.error('comprehensive exam candidates error:', e)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

function candidateShape(c: any) {
  const invitation = c.invitations?.[0] || null
  const attempt = c.attempts?.[0] || null
  return {
    id: c.id,
    examId: c.examId,
    userId: c.userId || null,
    admissionApplicationId: c.admissionApplicationId || null,
    fullName: c.fullName,
    nationalId: c.nationalId,
    email: c.email,
    phone: c.phone,
    externalCertificateFileKey: c.externalCertificateFileKey,
    externalCertificateFileName: c.externalCertificateFileName,
    externalCertificateDownloadUrl: getStorageDownloadPathForKey(c.externalCertificateFileKey),
    idDocumentFileKey: c.idDocumentFileKey,
    idDocumentFileName: c.idDocumentFileName,
    idDocumentDownloadUrl: getStorageDownloadPathForKey(c.idDocumentFileKey),
    status: c.status,
    rejectedReason: c.rejectedReason,
    submittedBy: c.submittedBy,
    reviewedById: c.reviewedById,
    reviewedAt: c.reviewedAt,
    createdAt: c.createdAt,
    invitation: invitation
      ? {
          id: invitation.id,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          emailStatus: invitation.emailStatus,
          emailError: invitation.emailError,
          whatsappStatus: invitation.whatsappStatus,
          whatsappError: invitation.whatsappError,
          lastSentAt: invitation.lastSentAt,
        }
      : null,
    attempt: attempt
      ? { id: attempt.id, status: attempt.status, score: attempt.score, passed: attempt.passed, startedAt: attempt.startedAt, submittedAt: attempt.submittedAt }
      : null,
  }
}

// GET /api/admin/comprehensive-exams/[id]/candidates — قائمة المرشحين مع آخر دعوة وآخر محاولة
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
    const { id } = await ctx.params
    const exam = await db.comprehensiveExam.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        specializationProgramId: true,
        specializationProgram: { select: { id: true, titleAr: true, titleEn: true, category: true } },
      },
    })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    const candidates = await db.comprehensiveExamCandidate.findMany({
      where: { examId: id },
      orderBy: { createdAt: 'desc' },
      include: {
        invitations: { orderBy: { createdAt: 'desc' }, take: 1 },
        attempts: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, score: true, passed: true, startedAt: true, submittedAt: true },
        },
      },
    })
    // شهادات المعادلة الصادرة لهؤلاء المرشحين (لإظهار زر «إعادة التأهيل» فقط لمن نجح ولم تُصدَر شهادته)
    const passedEmails = candidates
      .filter((c: any) => c.attempts?.[0]?.status === 'GRADED' && c.attempts[0].passed)
      .map((c: any) => c.email)
    const certificates =
      passedEmails.length > 0
        ? await db.certificate.findMany({
            where: { type: 'COMPREHENSIVE_EXAM', comprehensiveExamId: id, user: { email: { in: passedEmails } } },
            select: { id: true, serial: true, uploadedFileKey: true, stampedFileKey: true, user: { select: { email: true } } },
          })
        : []
    type ExamCertificateInfo = { serial: string; certificateId: string; uploadedFileKey: string | null; stampedFileKey: string | null }
    const certificateByEmail = new Map<string, ExamCertificateInfo>(
      certificates.map(
        (c: any): [string, ExamCertificateInfo] => [
          c.user.email,
          { serial: c.serial, certificateId: c.id, uploadedFileKey: c.uploadedFileKey || null, stampedFileKey: c.stampedFileKey || null },
        ],
      ),
    )
    const specialization = exam.specializationProgram
      ? { id: exam.specializationProgram.id, titleAr: exam.specializationProgram.titleAr, titleEn: exam.specializationProgram.titleEn, category: exam.specializationProgram.category }
      : null
    // رسوم الخدمة للمرشحين القادمين من طلبات: دفعة SERVICE_FEE مدفوعة
    // (أو معفاة) على الطلب المرتبط. المرشح اليدوي بلا طلب مرتبط — لا
    // بوابة دفع عليه. تُحسب هنا مرة واحدة لكل القائمة حتى يعرض التبويب
    // سبب المنع قبل أن يضغط المدير أي زر.
    const admissionIds = candidates
      .map((c: any) => c.admissionApplicationId)
      .filter((id): id is string => Boolean(id))
    const serviceFeePaidByAdmission = new Map<string, boolean>()
    if (admissionIds.length) {
      const feePayments = await db.payment.findMany({
        where: { admissionId: { in: admissionIds }, purpose: 'SERVICE_FEE', status: { in: ['PAID', 'WAIVED'] } },
        select: { admissionId: true },
      })
      for (const p of feePayments) {
        if (p.admissionId) serviceFeePaidByAdmission.set(p.admissionId, true)
      }
    }
    return NextResponse.json({
      ok: true,
      specialization,
      candidates: candidates.map((c: any) => {
        const shaped: any = candidateShape(c)
        shaped.specialization = specialization
        const serviceFeePaid = c.admissionApplicationId ? serviceFeePaidByAdmission.has(c.admissionApplicationId) : null
        shaped.serviceFeePaid = serviceFeePaid
        shaped.inviteBlockedReason =
          exam.status !== 'READY' ? 'EXAM_NOT_READY' : serviceFeePaid === false ? 'PAYMENT_REQUIRED' : null
        if (shaped.attempt) {
          const certInfo = certificateByEmail.get(c.email)
          shaped.attempt.certificateSerial = certInfo?.serial || null
          shaped.attempt.certificateId = certInfo?.certificateId || null
          shaped.attempt.certificateUploadedFileKey = certInfo?.uploadedFileKey || null
          shaped.attempt.certificateStampedFileKey = certInfo?.stampedFileKey || null
        }
        return shaped
      }),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return phase2ErrorResponse(e, 'تعذر تحميل المرشحين')
  }
}

// POST /api/admin/comprehensive-exams/[id]/candidates — إدخال مرشح من
// الإدارة (لمن لا يستطيع التقديم بنفسه ويرسل ملفاته للإدارة).
// نفس حقول التقديم الذاتي ونفس فحوصات التكرار ونفس مسار الموافقة
// والدعوة؛ الفرق الوحيد submittedBy = ADMIN.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await ctx.params
    const exam = await db.comprehensiveExam.findUnique({
      where: { id },
      select: { id: true, status: true, programId: true, specializationProgramId: true, title: true },
    })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (exam.status !== 'READY') {
      return NextResponse.json({ error: 'لا يمكن إضافة مرشحين إلا لامتحان منشور' }, { status: 409 })
    }

    const { fields, certificateFile, idDocumentFile } = await parseComprehensiveCandidateForm(req)
    const checked = validateComprehensiveCandidateInput({
      fullName: fields.fullName,
      nationalId: fields.nationalId,
      email: fields.email,
      phone: fields.phone,
    })
    if (!checked.ok) return NextResponse.json({ error: checked.errors.join('؛ '), code: 'INVALID_CANDIDATE' }, { status: 400 })

    // كما في الخريجين السابقين: إذا لم يوجد حساب ينشأ داخل نفس
    // معاملة المرشح، وتُرسل تعليمات اختيار كلمة المرور بعد الحفظ.
    const existingUser = await db.user.findUnique({ where: { email: checked.data.email }, select: { id: true, role: true } })
    if (existingUser && existingUser.role !== 'STUDENT') {
      return NextResponse.json({ error: 'هذا البريد مرتبط بحساب إداري ولا يمكن تسجيله كمرشح', code: 'NON_STUDENT_ACCOUNT' }, { status: 409 })
    }

    const duplicate = await checkComprehensiveCandidateDuplicate(db as any, {
      examId: exam.id,
      programId: exam.programId,
      specializationProgramId: exam.specializationProgramId,
      nationalId: checked.data.nationalId,
      email: checked.data.email,
    })
    const duplicateError = checkComprehensiveDuplicateError(duplicate)
    if (duplicateError) return NextResponse.json({ error: duplicateError.message, code: duplicateError.code }, { status: duplicateError.status })

    const certificate = await storeComprehensiveCandidateFile(certificateFile, 'الشهادة الخارجية')
    const idDocument = await storeComprehensiveCandidateFile(idDocumentFile, 'الهوية')
    // Repeat the duplicate/published checks inside a serializable
    // transaction. Two admins submitting at once cannot both pass the
    // earlier pre-upload check and create duplicate candidate records.
    const candidate = await db.$transaction(async (tx) => {
      const ready = await tx.comprehensiveExam.findFirst({
        where: { id: exam.id, status: 'READY' }, select: { id: true },
      })
      if (!ready) throw new ComprehensiveExamPhase2Error(409, 'EXAM_NOT_READY', 'أُلغي نشر الامتحان أثناء إدخال المرشح')
      const concurrentDuplicate = await checkComprehensiveCandidateDuplicate(tx, {
        examId: exam.id,
        programId: exam.programId,
        specializationProgramId: exam.specializationProgramId,
        nationalId: checked.data.nationalId,
        email: checked.data.email,
      })
      const conflict = checkComprehensiveDuplicateError(concurrentDuplicate)
      if (conflict) throw conflict
      return tx.comprehensiveExamCandidate.create({
        data: {
          examId: exam.id,
          userId: existingUser.id,
          fullName: checked.data.fullName,
          nationalId: checked.data.nationalId,
          email: checked.data.email,
          phone: checked.data.phone,
          externalCertificateFileKey: certificate.storageKey,
          externalCertificateFileName: certificate.fileName,
          idDocumentFileKey: idDocument.storageKey,
          idDocumentFileName: idDocument.fileName,
          status: 'PENDING_REVIEW',
          submittedBy: 'ADMIN',
          createdById: admin.id,
        },
      })
    }, { isolationLevel: 'Serializable' })
    await audit(
      { id: admin.id, name: admin.name },
      'CREATE_COMPREHENSIVE_EXAM_CANDIDATE',
      'ComprehensiveExamCandidate',
      candidate.id,
      `أدخلت الإدارة مرشحاً للامتحان الشامل «${exam.title}»: ${candidate.fullName} — ${candidate.email}`,
    )
    return NextResponse.json({ ok: true, candidate: candidateShape({ ...candidate, invitations: [], attempts: [] }) }, { status: 201 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (e?.code === 'P2034') return NextResponse.json({ error: 'أُنشئ مرشح مطابق بالتزامن — حدّث القائمة', code: 'CANDIDATE_CONFLICT' }, { status: 409 })
    return phase2ErrorResponse(e, 'تعذر إدخال المرشح')
  }
}
