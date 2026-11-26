import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import {
  ComprehensiveExamPhase2Error,
  qualifyComprehensiveExamCandidate,
} from '@/lib/comprehensive-exam-phase2'

export const runtime = 'nodejs'

function phase2ErrorResponse(e: unknown, fallback: string) {
  if (e instanceof ComprehensiveExamPhase2Error) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
  }
  console.error('comprehensive exam candidate review error:', e)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

function cleanText(value: unknown, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

async function loadCandidate(examId: string, candidateId: string) {
  return db.comprehensiveExamCandidate.findFirst({
    where: { id: candidateId, examId },
    include: { exam: { select: { id: true, programId: true, specializationProgramId: true, title: true, status: true } } },
  })
}

// PATCH — اعتماد مرشح أو رفضه (الرفض يتطلب سبباً)
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; candidateId: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id, candidateId } = await ctx.params
    const candidate = await loadCandidate(id, candidateId)
    if (!candidate) return NextResponse.json({ error: 'المرشح غير موجود' }, { status: 404 })
    if (candidate.status !== 'PENDING_REVIEW') {
      return NextResponse.json({ error: 'هذا المرشح رُوجع سابقاً — لا يمكن إعادة مراجعته' }, { status: 409 })
    }
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    const action = String(body?.action || '')
    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json({ error: 'الإجراء غير معروف — المسموح: approve أو reject' }, { status: 400 })
    }
    const rejectedReason = action === 'reject' ? cleanText(body?.rejectedReason, 300) : ''
    if (action === 'reject' && !rejectedReason) {
      return NextResponse.json({ error: 'رفض المرشح يتطلب سبباً' }, { status: 400 })
    }
    const updated = await db.comprehensiveExamCandidate.update({
      // Conditional unique update: the first review wins even if both
      // browser tabs read PENDING_REVIEW before either submits.
      where: { id: candidate.id, status: 'PENDING_REVIEW' },
      data: {
        status: action === 'approve' ? 'APPROVED' : 'REJECTED',
        rejectedReason: action === 'reject' ? rejectedReason : null,
        reviewedById: admin.id,
        reviewedAt: new Date(),
      },
    })
    await audit(
      { id: admin.id, name: admin.name },
      action === 'approve' ? 'APPROVE_COMPREHENSIVE_EXAM_CANDIDATE' : 'REJECT_COMPREHENSIVE_EXAM_CANDIDATE',
      'ComprehensiveExamCandidate',
      candidate.id,
      `${action === 'approve' ? 'اعتماد' : 'رفض'} مرشح الامتحان الشامل «${candidate.exam.title}»: ${candidate.fullName} — ${candidate.email}${rejectedReason ? ` — السبب: ${rejectedReason}` : ''}`,
    )
    return NextResponse.json({ ok: true, candidate: { id: updated.id, status: updated.status, rejectedReason: updated.rejectedReason } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (e?.code === 'P2025') return NextResponse.json({ error: 'رُوجع المرشح بالتزامن — حدّث القائمة', code: 'CANDIDATE_ALREADY_REVIEWED' }, { status: 409 })
    return phase2ErrorResponse(e, 'تعذر مراجعة المرشح')
  }
}

// POST {action: 'qualify'} — إعادة محاولة التأهيل لمحاولة ناجحة لم
// تُصدَر شهادتها (مثال: التأهيل الأول توقف على تكرار حله المدير بعدها).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; candidateId: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id, candidateId } = await ctx.params
    const candidate = await loadCandidate(id, candidateId)
    if (!candidate) return NextResponse.json({ error: 'المرشح غير موجود' }, { status: 404 })
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    if (String(body?.action || '') !== 'qualify') {
      return NextResponse.json({ error: 'الإجراء غير معروف — المسموح: qualify' }, { status: 400 })
    }
    const attempt = await db.comprehensiveExamAttempt.findFirst({
      where: { candidateId: candidate.id, status: 'GRADED', passed: true },
      orderBy: { createdAt: 'desc' },
    })
    if (!attempt || attempt.score === null || attempt.score === undefined) {
      return NextResponse.json({ error: 'لا توجد محاولة ناجحة لهذا المرشح ليعاد تأهيلها' }, { status: 409 })
    }
    const program = await db.program.findUnique({
      where: { id: candidate.exam.programId },
      select: { id: true, titleAr: true, titleEn: true },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    if (!candidate.exam.specializationProgramId) {
      return NextResponse.json({ error: 'الامتحان بلا تخصص — حدّد تخصص الامتحان قبل إعادة التأهيل' }, { status: 409 })
    }
    const specialization = await db.program.findUnique({
      where: { id: candidate.exam.specializationProgramId },
      select: { id: true, titleAr: true, titleEn: true },
    })
    if (!specialization) return NextResponse.json({ error: 'برنامج التخصص غير موجود' }, { status: 404 })
    const result = await db.$transaction(async (tx) =>
      qualifyComprehensiveExamCandidate(tx, {
        candidate: { id: candidate.id, userId: candidate.userId, fullName: candidate.fullName, nationalId: candidate.nationalId, email: candidate.email, phone: candidate.phone },
        exam: { id: candidate.exam.id, programId: candidate.exam.programId },
        program,
        specialization,
        attempt: { id: attempt.id, score: attempt.score as number },
        admin: { id: admin.id, name: admin.name },
      }),
      { isolationLevel: 'Serializable' },
    )
    return NextResponse.json({ ok: true, certificate: { id: result.certificate.id, serial: result.certificate.serial, qrToken: result.certificate.qrToken } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return phase2ErrorResponse(e, 'تعذر إعادة التأهيل')
  }
}
