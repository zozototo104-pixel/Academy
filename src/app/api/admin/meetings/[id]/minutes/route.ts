import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { generateMinutesDraft } from '@/lib/meeting-minutes'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// إدارة المحضر من الإدارة: توليد مسودة من المدخلات الحقيقية،
// تحرير بشري، تقديم للمراجعة، اعتماد موثق — لا اعتماد تلقائي أبدًا.

const postSchema = z.object({
  action: z.enum(['generate', 'save', 'submit', 'approve']),
  title: z.string().trim().max(300).optional(),
  summary: z.string().max(20000).nullable().optional(),
  decisions: z.string().max(20000).nullable().optional(),
  actionItems: z.string().max(20000).nullable().optional(),
  deferred: z.string().max(20000).nullable().optional(),
})

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
    const { id } = await params
    const minutes = await (db as any).adminMeetingMinutes.findUnique({ where: { meetingId: id } }).catch(() => null)
    const notes = await (db as any).adminMeetingNote.findMany({
      where: { meetingId: id },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: { id: true, authorName: true, text: true, createdAt: true },
    }).catch(() => [])
    return NextResponse.json({ ok: true, minutes, notes })
  } catch {
    return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await params
    const parsed = postSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 })
    const { action } = parsed.data
    const meeting = await (db as any).adminMeeting.findUnique({ where: { id } })
    if (!meeting) return NextResponse.json({ error: 'الاجتماع غير موجود' }, { status: 404 })
    if (!meeting.minutesEnabled && action === 'generate') {
      return NextResponse.json({ error: 'المحضر غير مفعّل لهذا الاجتماع', code: 'MINUTES_DISABLED' }, { status: 409 })
    }

    if (action === 'generate') {
      const result = await generateMinutesDraft(db as any, meeting, admin.id)
      if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: 409 })
      await audit({ id: admin.id, name: admin.name || 'مسؤول' }, 'ADMIN_MEETING_MINUTES_GENERATED', 'AdminMeeting', id, `from=${result.minutes.generatedFrom}`).catch(() => {})
      return NextResponse.json({ ok: true, minutes: result.minutes, sources: { notes: result.sources.notes.length, attendees: result.sources.attendees.length } })
    }

    const minutes = await (db as any).adminMeetingMinutes.findUnique({ where: { meetingId: id } }).catch(() => null)
    if (!minutes) return NextResponse.json({ error: 'لا يوجد محضر بعد — ولّد المسودة أولًا', code: 'NO_MINUTES' }, { status: 404 })

    if (action === 'save') {
      if (minutes.status === 'APPROVED') return NextResponse.json({ error: 'المحضر معتمد ومقفل', code: 'MINUTES_APPROVED_LOCKED' }, { status: 409 })
      const data: Record<string, unknown> = {}
      for (const k of ['title', 'summary', 'decisions', 'actionItems', 'deferred'] as const) {
        if (parsed.data[k] !== undefined) data[k] = parsed.data[k] === '' ? null : parsed.data[k]
      }
      const updated = await (db as any).adminMeetingMinutes.update({ where: { meetingId: id }, data })
      return NextResponse.json({ ok: true, minutes: updated })
    }

    if (action === 'submit') {
      if (minutes.status !== 'DRAFT') return NextResponse.json({ error: 'المسودة فقط تُقدَّم للمراجعة', code: 'INVALID_STATE' }, { status: 409 })
      const updated = await (db as any).adminMeetingMinutes.update({ where: { meetingId: id }, data: { status: 'PENDING_REVIEW' } })
      return NextResponse.json({ ok: true, minutes: updated })
    }

    // approve — من PENDING_REVIEW فقط، وبقرار بشري موثق
    if (minutes.status !== 'PENDING_REVIEW') {
      return NextResponse.json({ error: 'لا يُعتمد المحضر إلا بعد تقديمه للمراجعة', code: 'INVALID_STATE' }, { status: 409 })
    }
    const updated = await (db as any).adminMeetingMinutes.update({
      where: { meetingId: id },
      data: { status: 'APPROVED', approvedById: admin.id, approvedAt: new Date() },
    })
    await audit({ id: admin.id, name: admin.name || 'مسؤول' }, 'ADMIN_MEETING_MINUTES_APPROVED', 'AdminMeeting', id, `title=${minutes.title}`).catch(() => {})
    return NextResponse.json({ ok: true, minutes: updated })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED' || e?.message === 'FORBIDDEN') return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
    console.error('admin minutes POST error:', e)
    return NextResponse.json({ error: 'تعذر تنفيذ إجراء المحضر' }, { status: 500 })
  }
}
