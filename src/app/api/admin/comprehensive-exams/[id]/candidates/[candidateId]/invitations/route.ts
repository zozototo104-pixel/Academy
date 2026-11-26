import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import {
  buildComprehensiveExamInviteUrl,
  checkComprehensiveCandidateDuplicate,
  checkComprehensiveDuplicateError,
  checkComprehensiveInviteGateError,
  checkComprehensiveInviteGates,
  comprehensiveExamInviteExpiresAt,
  createComprehensiveExamInviteToken,
  ComprehensiveExamPhase2Error,
  sendComprehensiveExamInvite,
} from '@/lib/comprehensive-exam-phase2'

export const runtime = 'nodejs'

function phase2ErrorResponse(e: unknown, fallback: string) {
  if (e instanceof ComprehensiveExamPhase2Error) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
  }
  console.error('comprehensive exam invitations error:', e)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

function invitationShape(inv: any, inviteUrl?: string) {
  return {
    id: inv.id,
    candidateId: inv.candidateId,
    status: inv.status,
    expiresAt: inv.expiresAt,
    emailStatus: inv.emailStatus,
    emailError: inv.emailError,
    whatsappStatus: inv.whatsappStatus,
    whatsappError: inv.whatsappError,
    lastSentAt: inv.lastSentAt,
    createdAt: inv.createdAt,
    ...(inviteUrl ? { inviteUrl } : {}),
  }
}

async function loadExamAndCandidate(examId: string, candidateId: string) {
  const exam = await db.comprehensiveExam.findUnique({
    where: { id: examId },
    select: { id: true, status: true, programId: true, specializationProgramId: true, title: true, durationMin: true, passScore: true },
  })
  if (!exam) return { exam: null, candidate: null, program: null }
  const candidate = await db.comprehensiveExamCandidate.findFirst({
    where: { id: candidateId, examId },
  })
  if (!candidate) return { exam, candidate: null, program: null }
  const program = await db.program.findUnique({
    where: { id: exam.programId },
    select: { id: true, titleAr: true, titleEn: true },
  })
  return { exam, candidate, program }
}

// GET — دعوات المرشح (مع حالة التسليم لكل قناة)
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string; candidateId: string }> }) {
  try {
    await requireAdmin()
    const { id, candidateId } = await ctx.params
    const { exam, candidate } = await loadExamAndCandidate(id, candidateId)
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (!candidate) return NextResponse.json({ error: 'المرشح غير موجود' }, { status: 404 })
    const invitations = await db.comprehensiveExamInvitation.findMany({
      where: { candidateId: candidate.id },
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json({
      ok: true,
      invitations: invitations.map((inv: any) => invitationShape(inv, buildComprehensiveExamInviteUrl(inv.token))),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return phase2ErrorResponse(e, 'تعذر تحميل الدعوات')
  }
}

// POST — إصدار دعوة: يتحقق من الاعتماد والامتحان المنشور والتكرار،
/// ثم ينشئ الرمز ويرسل بالبريد وواتساب معاً. فشل قناة لا يمنع الأخرى،
// وحالة كل قناة تُحفظ على الدعوة وتظهر في التبويب.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string; candidateId: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id, candidateId } = await ctx.params
    const { exam, candidate, program } = await loadExamAndCandidate(id, candidateId)
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (!candidate) return NextResponse.json({ error: 'المرشح غير موجود' }, { status: 404 })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    if (candidate.status !== 'APPROVED') {
      return NextResponse.json({ error: 'الدعوة تتطلب مرشحاً معتمداً — راجع الطلب أولاً' }, { status: 409 })
    }
    // بوابتا الدعوة: امتحان منشور + (لمرشحي الطلبات) رسوم خدمة مسددة.
    const gate = await checkComprehensiveInviteGates(db as any, { candidate, exam })
    const gateError = checkComprehensiveInviteGateError(gate)
    if (gateError) return NextResponse.json({ error: gateError.message, code: gateError.code }, { status: gateError.status })
    const passedAttempt = await db.comprehensiveExamAttempt.findFirst({
      where: { candidateId: candidate.id, status: 'GRADED', passed: true },
      select: { id: true },
    })
    if (passedAttempt) {
      return NextResponse.json({ error: 'هذا المرشح نجح بالامتحان — أهلّه من زر التأهيل بدلاً من دعوة جديدة' }, { status: 409 })
    }
    const duplicate = await checkComprehensiveCandidateDuplicate(db as any, {
      examId: exam.id,
      programId: exam.programId,
      specializationProgramId: exam.specializationProgramId,
      nationalId: candidate.nationalId,
      email: candidate.email,
      excludeCandidateId: candidate.id,
    })
    const duplicateError = checkComprehensiveDuplicateError(duplicate)
    if (duplicateError) return NextResponse.json({ error: duplicateError.message, code: duplicateError.code }, { status: duplicateError.status })

    const token = createComprehensiveExamInviteToken()
    const expiresAt = comprehensiveExamInviteExpiresAt()
    const result = await db.$transaction(async (tx) => {
      const live = await tx.comprehensiveExamInvitation.findFirst({
        where: { candidateId: candidate.id, status: 'PENDING' },
        select: { id: true },
      })
      if (live) return { live, invitation: null }
      const invitation = await tx.comprehensiveExamInvitation.create({
        data: { candidateId: candidate.id, token, expiresAt, status: 'PENDING', createdById: admin.id },
      })
      return { live: null, invitation }
    }, { isolationLevel: 'Serializable' })
    if (result.live) {
      return NextResponse.json({ error: 'توجد دعوة سارية لهذا المرشح — جددها أو ألغِها أولاً', code: 'LIVE_INVITATION_EXISTS' }, { status: 409 })
    }
    const invitation = result.invitation!
    const inviteUrl = buildComprehensiveExamInviteUrl(token)
    const delivery = await sendComprehensiveExamInvite({
      fullName: candidate.fullName,
      email: candidate.email,
      phone: candidate.phone || '',
      examTitle: exam.title,
      programTitle: String(program.titleAr || program.titleEn || program.id),
      durationMin: exam.durationMin,
      inviteUrl,
      expiresAt,
    })
    const updated = await db.comprehensiveExamInvitation.update({
      where: { id: invitation.id },
      data: {
        emailStatus: delivery.email.status,
        emailError: delivery.email.error || null,
        whatsappStatus: delivery.whatsapp.status,
        whatsappError: delivery.whatsapp.error || null,
        lastSentAt: new Date(),
      },
    })
    await audit(
      { id: admin.id, name: admin.name },
      'ISSUE_COMPREHENSIVE_EXAM_INVITATION',
      'ComprehensiveExamInvitation',
      invitation.id,
      `إصدار دعوة للامتحان الشامل «${exam.title}»: ${candidate.fullName} — بريد ${delivery.email.status}، واتساب ${delivery.whatsapp.status}`,
    )
    return NextResponse.json(
      { ok: true, invitation: invitationShape(updated, inviteUrl), delivery },
      { status: 201 },
    )
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return phase2ErrorResponse(e, 'تعذر إصدار الدعوة')
  }
}
