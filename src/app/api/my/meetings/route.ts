import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { deriveMeetingStatus, isMeetingJoinOpen, meetingInviteProblem } from '@/lib/admin-meetings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// اجتماعاتي: الاجتماعات التي استلمتُ دعواتها بهذا الحساب. الدخول من
// هنا بالحساب (صفحة claimed) — لا حاجة لحفظ الرمز الخام بعد الاستلام.
export async function GET() {
  try {
    const user = await requireUser()
    const invites = await (db as any).adminMeetingInvite.findMany({
      where: { claimedByUserId: user.id },
      include: { meeting: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    const now = new Date()
    const meetings = (invites as any[])
      .filter((i) => !meetingInviteProblem(i, now))
      .map((i) => ({
        inviteId: i.id,
        inviteeName: i.inviteeName,
        meeting: {
          id: i.meeting.id,
          title: i.meeting.title,
          startsAt: i.meeting.startsAt,
          endsAt: i.meeting.endsAt,
          timezone: i.meeting.timezone,
          provider: i.meeting.provider,
          hostName: i.meeting.hostName,
          status: i.meeting.status,
          effectiveStatus: deriveMeetingStatus(i.meeting, now),
          joinOpen: isMeetingJoinOpen(i.meeting, now),
        },
      }))
    return NextResponse.json({ ok: true, meetings })
  } catch {
    return NextResponse.json({ error: 'سجّل الدخول أولًا' }, { status: 401 })
  }
}
