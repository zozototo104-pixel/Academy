import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { checkRateLimit, clientIpFromHeaders } from '@/lib/rate-limit'
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
  console.error('comprehensive exam apply error:', e)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

// POST /api/comprehensive-exams/apply — التقديم الذاتي: المرشح يختار
// برنامجاً له امتحان منشور، ويرفق الشهادة الخارجية والهوية.
// نفس فحوصات التكرار والإدخال كإدخال الإدارة، لكن submittedBy = CANDIDATE.
export async function POST(req: NextRequest) {
  try {
    const ip = clientIpFromHeaders(req.headers)
    const limit = await checkRateLimit(`comprehensive-exam-apply:${ip}`, 5, 600_000)
    if (!limit.allowed) {
      return NextResponse.json({ error: 'محاولات كثيرة — انتظر 10 دقائق وحاول مجدداً' }, { status: 429 })
    }
    const { fields, certificateFile, idDocumentFile } = await parseComprehensiveCandidateForm(req)
    const programId = String(fields.programId || '').trim()
    if (!programId) {
      return NextResponse.json({ error: 'اختر البرنامج أولاً' }, { status: 400 })
    }
    const exam = await db.comprehensiveExam.findFirst({
      where: { programId, status: 'READY' },
      select: { id: true, status: true, programId: true, title: true },
    })
    if (!exam) {
      return NextResponse.json({ error: 'لا يوجد امتحان شامل منشور لهذا البرنامج بعد' }, { status: 404 })
    }
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
        submittedBy: 'CANDIDATE',
      },
    })
    return NextResponse.json(
      { ok: true, candidateId: candidate.id, message: 'استلمنا طلبك — سنراجعه ونرسل لك دعوة الامتحان بالبريد وواتساب عند الموافقة' },
      { status: 201 },
    )
  } catch (e) {
    return phase2ErrorResponse(e, 'تعذر إرسال الطلب')
  }
}
