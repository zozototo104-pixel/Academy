import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { getStorageDownloadPathForKey } from '@/lib/storage'
import {
  checkComprehensiveCandidateDuplicate,
  checkComprehensiveDuplicateError,
  ComprehensiveExamPhase2Error,
  parseComprehensiveCandidateForm,
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
    const exam = await db.comprehensiveExam.findUnique({ where: { id }, select: { id: true } })
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
    const certificateByEmail = new Map(
      certificates.map((c: any) => [
        c.user.email,
        { serial: c.serial, certificateId: c.id, uploadedFileKey: c.uploadedFileKey || null, stampedFileKey: c.stampedFileKey || null },
      ]),
    )
    return NextResponse.json({
      ok: true,
      candidates: candidates.map((c: any) => {
        const shaped: any = candidateShape(c)
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
      select: { id: true, status: true, programId: true, title: true },
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

    const duplicate = await checkComprehensiveCandidateDuplicate(db as any, {
      examId: exam.id,
      programId: exam.programId,
      nationalId: checked.data.nationalId,
      email: checked.data.email,
    })
    const duplicateError = checkComprehensiveDuplicateError(duplicate)
    if (duplicateError) return NextResponse.json({ error: duplicateError.message, code: duplicateError.code }, { status: duplicateError.status })

    const certificate = await storeComprehensiveCandidateFile(certificateFile, 'الشهادة الخارجية')
    const idDocument = await storeComprehensiveCandidateFile(idDocumentFile, 'الهوية')
    const candidate = await db.comprehensiveExamCandidate.create({
      data: {
        examId: exam.id,
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
    return phase2ErrorResponse(e, 'تعذر إدخال المرشح')
  }
}
