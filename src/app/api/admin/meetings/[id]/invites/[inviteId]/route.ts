import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { rotateMeetingInviteToken } from '@/lib/admin-meetings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// إجراءات على دعوة واحدة: إلغاء (revoke) — بعدها يرفض رابطها فورًا
// في كل مسارات الدخول؛ أو إعادة إصدار الرابط (rotate) لدعوة قديمة
// بلا نسخة مشفّرة — رمز جديد يبطل القديم، ويُرفض للمستلَمة.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; inviteId: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id, inviteId } = await params
    const body = await req.json().catch(() => null)
    if (body?.action !== 'revoke' && body?.action !== 'rotate') {
      return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
    }
    const invite = await (db as any).adminMeetingInvite.findFirst({ where: { id: inviteId, meetingId: id } })
    if (!invite) return NextResponse.json({ error: 'الدعوة غير موجودة' }, { status: 404 })
    if (body.action === 'rotate') {
      const rotated = await rotateMeetingInviteToken(db as any, invite)
      if (!rotated.ok) {
        const messages: Record<string, string> = {
          ALREADY_CLAIMED: 'هذه الدعوة استلمها صاحبها بحسابه — لا يمكن تغيير رابطها الآن',
          INVITE_REVOKED: 'هذه الدعوة ملغاة — أضف دعوة جديدة بدلًا منها',
        }
        return NextResponse.json({ error: messages[rotated.code] || 'تعذر إعادة إصدار الرابط', code: rotated.code }, { status: 409 })
      }
      await audit({ id: admin.id, name: admin.name || 'مسؤول' }, 'ADMIN_MEETING_INVITE_ROTATED', 'AdminMeeting', id, `invitee=${invite.inviteeName}`).catch(() => {})
      return NextResponse.json({ ok: true, url: rotated.url })
    }
    if (!invite.revokedAt) {
      await (db as any).adminMeetingInvite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } })
      await audit({ id: admin.id, name: admin.name || 'مسؤول' }, 'ADMIN_MEETING_INVITE_REVOKED', 'AdminMeeting', id, `invitee=${invite.inviteeName}`).catch(() => {})
    }
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
  }
}
