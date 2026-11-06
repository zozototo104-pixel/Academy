import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { adminInviteShape, deriveMeetingStatus, validateMeetingVideo } from '@/lib/admin-meetings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const patchSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  agenda: z.string().trim().max(8000).nullable().optional(),
  startsAt: z.string().min(1).optional(),
  endsAt: z.string().min(1).optional(),
  timezone: z.string().trim().max(64).optional(),
  provider: z.enum(['ZOOM', 'MEET', 'TEAMS', 'OTHER', 'PLATFORM']).optional(),
  meetingUrl: z.string().trim().max(1000).nullable().optional(),
  meetingPasscode: z.string().trim().max(120).nullable().optional(),
  hostName: z.string().trim().max(160).nullable().optional(),
  aiAssistantEnabled: z.boolean().optional(),
  minutesEnabled: z.boolean().optional(),
  cancel: z.boolean().optional(),
})

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
    const { id } = await params
    const meeting = await (db as any).adminMeeting.findUnique({
      where: { id },
      include: {
        invites: { orderBy: { createdAt: 'asc' } },
        attendance: { orderBy: { joinedAt: 'asc' } },
      },
    })
    if (!meeting) return NextResponse.json({ error: 'الاجتماع غير موجود' }, { status: 404 })
    const userIds = [...new Set([
      ...(meeting.attendance as any[]).map((a) => a.userId),
      ...(meeting.invites as any[]).map((i) => i.claimedByUserId).filter(Boolean),
    ])]
    const users = userIds.length
      ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true, role: true } })
      : []
    const userById = new Map((users as any[]).map((u) => [u.id, u]))
    const now = new Date()
    return NextResponse.json({
      ok: true,
      meeting: {
        id: meeting.id,
        title: meeting.title,
        description: meeting.description,
        agenda: meeting.agenda,
        startsAt: meeting.startsAt,
        endsAt: meeting.endsAt,
        timezone: meeting.timezone,
        provider: meeting.provider,
        meetingUrl: meeting.meetingUrl,
        meetingPasscode: meeting.meetingPasscode,
        hostName: meeting.hostName,
        status: meeting.status,
        effectiveStatus: deriveMeetingStatus(meeting, now),
        aiAssistantEnabled: meeting.aiAssistantEnabled,
        minutesEnabled: meeting.minutesEnabled,
        createdById: meeting.createdById,
        createdAt: meeting.createdAt,
      },
      // روابط الدعوات الكاملة (من النسخ المشفّرة) — هذا المسار خلف
      // بوابة الإدارة حصرًا؛ لا تصل الروابط لأي مسار ضيف أو طالب.
      invites: (meeting.invites as any[]).map((i) =>
        adminInviteShape(i, i.claimedByUserId ? userById.get(i.claimedByUserId)?.name || null : null, now),
      ),
      attendance: (meeting.attendance as any[]).map((a) => ({
        userId: a.userId,
        userName: userById.get(a.userId)?.name || null,
        userEmail: userById.get(a.userId)?.email || null,
        status: a.status,
        joinedAt: a.joinedAt,
        confirmedAt: a.confirmedAt,
      })),
    })
  } catch {
    return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
  }
}

// حذف نهائي — بخلاف الإلغاء الذي يُبقي السجل ويمنع الدخول فقط.
// يزيل صف الاجتماع، وقاعدة البيانات تزيل معه كل ما يتفرع عنه
// (الدعوات والحضور والإشارات والملاحظات والمحضر وأحداث المساعد)
// عبر onDelete: Cascade في المخطط. لا تراجع عنه وبلا قيد على حالة
// الاجتماع؛ الحارس الوحيد هو نافذة التأكيد في الواجهة.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await params
    const meeting = await (db as any).adminMeeting.findUnique({ where: { id } })
    if (!meeting) return NextResponse.json({ error: 'الاجتماع غير موجود' }, { status: 404 })
    await (db as any).adminMeeting.delete({ where: { id } })
    await audit({ id: admin.id, name: admin.name || 'مسؤول' }, 'ADMIN_MEETING_DELETED', 'AdminMeeting', id, `title=${meeting.title}`).catch(() => {})
    return NextResponse.json({ ok: true, deleted: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
    console.error('admin meeting DELETE error:', e)
    return NextResponse.json({ error: 'تعذر حذف الاجتماع' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await params
    const parsed = patchSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    const data = parsed.data
    const meeting = await (db as any).adminMeeting.findUnique({ where: { id } })
    if (!meeting) return NextResponse.json({ error: 'الاجتماع غير موجود' }, { status: 404 })
    if (data.cancel) {
      if (meeting.status === 'CANCELLED') return NextResponse.json({ ok: true, meeting })
      const updated = await (db as any).adminMeeting.update({ where: { id }, data: { status: 'CANCELLED' } })
      await audit({ id: admin.id, name: admin.name || 'مسؤول' }, 'ADMIN_MEETING_CANCELLED', 'AdminMeeting', id, `title=${meeting.title}`).catch(() => {})
      return NextResponse.json({ ok: true, meeting: updated })
    }
    if (meeting.status === 'CANCELLED') return NextResponse.json({ error: 'لا يمكن تعديل اجتماع ملغى', code: 'MEETING_CANCELLED' }, { status: 409 })
    const started = Date.now() >= new Date(meeting.startsAt).getTime()
    const touchesTime = data.startsAt !== undefined || data.endsAt !== undefined
    if (started && (touchesTime || data.provider !== undefined || data.meetingUrl !== undefined)) {
      return NextResponse.json({ error: 'بدأ الاجتماع — لا يمكن تغيير موعده أو مزوده أو رابطه', code: 'MEETING_STARTED' }, { status: 409 })
    }
    const next: Record<string, unknown> = {}
    for (const k of ['title', 'description', 'agenda', 'timezone', 'hostName', 'meetingPasscode', 'aiAssistantEnabled', 'minutesEnabled'] as const) {
      if (data[k] !== undefined) next[k] = data[k] === '' ? null : data[k]
    }
    let startsAt = new Date(meeting.startsAt)
    let endsAt = new Date(meeting.endsAt)
    if (data.startsAt !== undefined) startsAt = new Date(data.startsAt)
    if (data.endsAt !== undefined) endsAt = new Date(data.endsAt)
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= startsAt.getTime()) {
      return NextResponse.json({ error: 'موعدا البداية والنهاية غير صالحين', code: 'INVALID_TIMES' }, { status: 400 })
    }
    if (touchesTime) {
      next.startsAt = startsAt
      next.endsAt = endsAt
    }
    const provider = data.provider ?? meeting.provider
    const meetingUrl = data.meetingUrl !== undefined ? data.meetingUrl : meeting.meetingUrl
    if (data.provider !== undefined || data.meetingUrl !== undefined) {
      const video = validateMeetingVideo({ provider, meetingUrl })
      if (!video.ok) return NextResponse.json({ error: 'رابط الفيديو غير صالح لهذا المزود', code: video.code }, { status: 400 })
      next.provider = provider
      next.meetingUrl = provider === 'PLATFORM' ? null : meetingUrl
    }
    const updated = await (db as any).adminMeeting.update({ where: { id }, data: next })
    await audit({ id: admin.id, name: admin.name || 'مسؤول' }, 'ADMIN_MEETING_UPDATED', 'AdminMeeting', id, `title=${updated.title}`).catch(() => {})
    return NextResponse.json({ ok: true, meeting: updated })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
    console.error('admin meeting PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تحديث الاجتماع' }, { status: 500 })
  }
}
