import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { generateMeetingToken, hashMeetingToken, meetingInviteUrl } from '@/lib/admin-meetings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const addSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
})

// إضافة مدعو لاجتماع قائم — الرابط الكامل يُعرض في هذا الرد مرة واحدة.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await params
    const parsed = addSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'بيانات المدعو غير صالحة' }, { status: 400 })
    const meeting = await (db as any).adminMeeting.findUnique({ where: { id } })
    if (!meeting) return NextResponse.json({ error: 'الاجتماع غير موجود' }, { status: 404 })
    if (meeting.status === 'CANCELLED') return NextResponse.json({ error: 'الاجتماع ملغى', code: 'MEETING_CANCELLED' }, { status: 409 })
    const token = generateMeetingToken()
    await (db as any).adminMeetingInvite.create({
      data: {
        meetingId: id,
        inviteeName: parsed.data.name,
        inviteeEmail: parsed.data.email || null,
        tokenHash: hashMeetingToken(token),
        expiresAt: new Date(new Date(meeting.endsAt).getTime() + 24 * 60 * 60 * 1000),
      },
    })
    await audit({ id: admin.id, name: admin.name || 'مسؤول' }, 'ADMIN_MEETING_INVITE_ADDED', 'AdminMeeting', id, `invitee=${parsed.data.name}`).catch(() => {})
    return NextResponse.json({ ok: true, url: meetingInviteUrl(token) })
  } catch {
    return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
  }
}
