import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import {
  buildComprehensiveExamInviteUrl,
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
  console.error('comprehensive exam invitation action error:', e)
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

// POST {action: 'renew'|'revoke'}
// renew: الرابط القديم يتوقف فوراً (PENDING → REVOKED؛ المنتهي يبقى
// EXPIRED)، ورمز جديد بصلاحية 7 أيام جديدة ويُرسَل بالقناتين.
// revoke: PENDING → REVOKED. لا تجديد تلقائي.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; candidateId: string; invitationId: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id, candidateId, invitationId } = await ctx.params
    const invitation = await db.comprehensiveExamInvitation.findFirst({
      where: { id: invitationId, candidateId },
      include: {
        candidate: {
          select: { id: true, fullName: true, email: true, phone: true, examId: true, admissionApplicationId: true },
        },
      },
    })
    if (!invitation || invitation.candidate.examId !== id) {
      return NextResponse.json({ error: 'الدعوة غير موجودة' }, { status: 404 })
    }
    let body: any = {}
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    const action = String(body?.action || '')
    if (action !== 'renew' && action !== 'revoke') {
      return NextResponse.json({ error: 'الإجراء غير معروف — المسموح: renew أو revoke' }, { status: 400 })
    }

    if (action === 'revoke') {
      if (invitation.status !== 'PENDING') {
        return NextResponse.json({ error: 'لا يمكن إلغاء دعوة ليست سارية' }, { status: 409 })
      }
      const claim = await db.comprehensiveExamInvitation.updateMany({
        where: { id: invitation.id, status: 'PENDING' },
        data: { status: 'REVOKED' },
      })
      if (claim.count !== 1) {
        return NextResponse.json({ error: 'تغيرت حالة الدعوة أثناء الإلغاء — حدّث القائمة', code: 'INVITATION_CHANGED' }, { status: 409 })
      }
      const revoked = { ...invitation, status: 'REVOKED' }
      await audit(
        { id: admin.id, name: admin.name },
        'REVOKE_COMPREHENSIVE_EXAM_INVITATION',
        'ComprehensiveExamInvitation',
        invitation.id,
        `إلغاء دعوة الامتحان الشامل للمرشح ${invitation.candidate.fullName}`,
      )
      return NextResponse.json({ ok: true, invitation: invitationShape(revoked) })
    }

    // renew
    if (invitation.status === 'USED') {
      return NextResponse.json({ error: 'هذه الدعوة استُخدمت بالفعل — لا يمكن تجديدها' }, { status: 409 })
    }
    if (invitation.status === 'REVOKED') {
      return NextResponse.json({ error: 'هذه الدعوة ملغاة — أصدر دعوة جديدة بدلاً من تجديدها' }, { status: 409 })
    }
    const exam = await db.comprehensiveExam.findUnique({
      where: { id },
      select: { id: true, status: true, title: true, durationMin: true, programId: true },
    })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    // التجديد يعيد الإرسال، فيخضع لنفس بوابتي الإصدار.
    const gate = await checkComprehensiveInviteGates(db as any, { candidate: invitation.candidate, exam })
    const gateError = checkComprehensiveInviteGateError(gate)
    if (gateError) return NextResponse.json({ error: gateError.message, code: gateError.code }, { status: gateError.status })
    const program = await db.program.findUnique({
      where: { id: exam.programId },
      select: { id: true, titleAr: true, titleEn: true },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    const newToken = createComprehensiveExamInviteToken()
    const newExpiresAt = comprehensiveExamInviteExpiresAt()
    const next = await db.$transaction(async (tx) => {
      if (invitation.status === 'PENDING') {
        await tx.comprehensiveExamInvitation.update({
          where: { id: invitation.id },
          data: { status: 'REVOKED' },
        })
      }
      return tx.comprehensiveExamInvitation.create({
        data: { candidateId: invitation.candidateId, token: newToken, expiresAt: newExpiresAt, status: 'PENDING', createdById: admin.id },
      })
    })
    const inviteUrl = buildComprehensiveExamInviteUrl(newToken)
    const delivery = await sendComprehensiveExamInvite({
      fullName: invitation.candidate.fullName,
      email: invitation.candidate.email,
      phone: invitation.candidate.phone || '',
      examTitle: exam.title,
      programTitle: String(program.titleAr || program.titleEn || program.id),
      durationMin: exam.durationMin,
      inviteUrl,
      expiresAt: newExpiresAt,
    })
    const updated = await db.comprehensiveExamInvitation.update({
      where: { id: next.id },
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
      'RENEW_COMPREHENSIVE_EXAM_INVITATION',
      'ComprehensiveExamInvitation',
      next.id,
      `تجديد دعوة الامتحان الشامل «${exam.title}» للمرشح ${invitation.candidate.fullName} — بريد ${delivery.email.status}، واتساب ${delivery.whatsapp.status}`,
    )
    return NextResponse.json(
      { ok: true, invitation: invitationShape(updated, inviteUrl), oldInvitationId: invitation.id, delivery },
      { status: 201 },
    )
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return phase2ErrorResponse(e, 'تعذر تنفيذ الإجراء على الدعوة')
  }
}
