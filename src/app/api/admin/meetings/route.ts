import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import {
  deriveMeetingStatus,
  generateMeetingToken,
  hashMeetingToken,
  meetingInviteUrl,
  validateMeetingVideo,
} from '@/lib/admin-meetings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// قاعة الاجتماعات — قائمة اجتماعات الإدارة وإنشاؤها. الإنشاء يولّد
// دعوة شخصية لكل مدعو (هاش الرمز فقط يُحفظ؛ الرابط الكامل يُعرض في
// رد الإنشاء مرة واحدة). صلاحية الدعوة: حتى يوم بعد نهاية الاجتماع.

const inviteeSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
})

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional().or(z.literal('')),
  agenda: z.string().trim().max(8000).optional().or(z.literal('')),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  timezone: z.string().trim().max(64).optional(),
  provider: z.enum(['ZOOM', 'MEET', 'TEAMS', 'OTHER', 'PLATFORM']),
  meetingUrl: z.string().trim().max(1000).optional().or(z.literal('')),
  meetingPasscode: z.string().trim().max(120).optional().or(z.literal('')),
  hostName: z.string().trim().max(160).optional().or(z.literal('')),
  aiAssistantEnabled: z.boolean().optional(),
  minutesEnabled: z.boolean().optional(),
  invitees: z.array(inviteeSchema).max(50).optional(),
})

function validTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export async function GET() {
  try {
    await requireAdmin()
    const meetings = await (db as any).adminMeeting.findMany({
      orderBy: { startsAt: 'desc' },
      take: 200,
      include: { _count: { select: { invites: true, attendance: true } } },
    })
    const now = new Date()
    return NextResponse.json({
      ok: true,
      meetings: (meetings as any[]).map((m) => ({
        ...m,
        effectiveStatus: deriveMeetingStatus(m, now),
        inviteCount: m._count?.invites ?? 0,
        attendanceCount: m._count?.attendance ?? 0,
        _count: undefined,
      })),
    })
  } catch {
    return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const parsed = createSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات الاجتماع غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const data = parsed.data
    const startsAt = new Date(data.startsAt)
    const endsAt = new Date(data.endsAt)
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= startsAt.getTime()) {
      return NextResponse.json({ error: 'موعدا البداية والنهاية غير صالحين — النهاية يجب أن تكون بعد البداية', code: 'INVALID_TIMES' }, { status: 400 })
    }
    if (startsAt.getTime() < Date.now() - 60_000) {
      return NextResponse.json({ error: 'لا يمكن إنشاء اجتماع في الماضي', code: 'START_IN_PAST' }, { status: 400 })
    }
    const timezone = data.timezone || 'UTC'
    if (!validTimezone(timezone)) {
      return NextResponse.json({ error: 'المنطقة الزمنية غير صالحة', code: 'INVALID_TIMEZONE' }, { status: 400 })
    }
    const video = validateMeetingVideo({ provider: data.provider, meetingUrl: data.meetingUrl })
    if (!video.ok) {
      const messages: Record<string, string> = {
        URL_REQUIRED: 'رابط الاجتماع مطلوب لهذا المزود',
        URL_UNSAFE: 'رابط الاجتماع غير آمن — يجب أن يكون رابط HTTPS صالحًا',
        URL_HOST_MISMATCH: 'رابط الاجتماع لا يطابق المزود المختار',
        PROVIDER_INVALID: 'مزود الفيديو غير معروف',
      }
      return NextResponse.json({ error: messages[video.code] || 'رابط غير صالح', code: video.code }, { status: 400 })
    }
    const invitees = (data.invitees || []).filter((i) => i.name)
    const expiresBase = endsAt.getTime() + 24 * 60 * 60 * 1000
    const created = await db.$transaction(async (tx: any) => {
      const meeting = await tx.adminMeeting.create({
        data: {
          title: data.title,
          description: data.description || null,
          agenda: data.agenda || null,
          startsAt,
          endsAt,
          timezone,
          provider: data.provider,
          meetingUrl: data.provider === 'PLATFORM' ? null : data.meetingUrl || null,
          meetingPasscode: data.meetingPasscode || null,
          hostName: data.hostName || null,
          aiAssistantEnabled: Boolean(data.aiAssistantEnabled),
          minutesEnabled: Boolean(data.minutesEnabled),
          createdById: admin.id,
        },
      })
      const links: { inviteeName: string; url: string }[] = []
      for (const invitee of invitees) {
        const token = generateMeetingToken()
        await tx.adminMeetingInvite.create({
          data: {
            meetingId: meeting.id,
            inviteeName: invitee.name,
            inviteeEmail: invitee.email || null,
            tokenHash: hashMeetingToken(token),
            expiresAt: new Date(expiresBase),
          },
        })
        links.push({ inviteeName: invitee.name, url: meetingInviteUrl(token) })
      }
      return { meeting, links }
    })
    await audit({ id: admin.id, name: admin.name || 'مسؤول' }, 'ADMIN_MEETING_CREATED', 'AdminMeeting', created.meeting.id, `title=${data.title} invitees=${invitees.length}`).catch(() => {})
    return NextResponse.json({ ok: true, meeting: created.meeting, inviteLinks: created.links })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
    console.error('admin meetings POST error:', e)
    return NextResponse.json({ error: 'تعذر إنشاء الاجتماع' }, { status: 500 })
  }
}
