import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { defenseGuestInviteProblem, findInviteByToken } from '@/lib/defense-invites'

// تحقق علني من رابط دعوة مناقش خارجي — الرابط نفسه هو الاعتماد.
// الدعوة غير الصالحة لا تكشف أي تفاصيل عن المناقشة.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params
    const invite = await findInviteByToken(db as any, token)
    const problem = defenseGuestInviteProblem(invite)
    if (problem) {
      return NextResponse.json({ status: problem }, { status: problem === 'NOT_FOUND' ? 404 : 410 })
    }
    const thesis = await db.thesisSubmission.findUnique({
      where: { id: invite.thesisId },
      select: {
        id: true,
        title: true,
        abstract: true,
        defenseDate: true,
        committee: true,
        agentMember: true,
        defenseStatus: true,
        defenseMeetingUrl: true,
        user: { select: { name: true } },
      },
    })
    if (!thesis) return NextResponse.json({ status: 'NOT_FOUND' }, { status: 404 })
    return NextResponse.json({
      status: 'VALID',
      inviteeName: invite.name,
      role: invite.role,
      expiresAt: invite.expiresAt,
      thesis: {
        id: thesis.id,
        title: thesis.title,
        abstract: thesis.abstract,
        defenseDate: thesis.defenseDate,
        committee: thesis.committee,
        agentMember: thesis.agentMember,
        defenseStatus: thesis.defenseStatus,
        defenseMeetingUrl: thesis.defenseMeetingUrl,
      },
      studentName: thesis.user?.name || 'الطالب',
    })
  } catch (e) {
    console.error('defense guest validate error:', e)
    return NextResponse.json({ status: 'ERROR' }, { status: 500 })
  }
}
