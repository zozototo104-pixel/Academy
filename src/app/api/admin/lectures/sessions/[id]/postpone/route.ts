import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { auditLecture, canManageSeries, notifyProgramStudents, requireLectureManager } from '@/lib/lectures/manage'

const postponeSchema = z.object({
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(),
})

function formatWhen(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(date)
  } catch {
    return date.toISOString()
  }
}

// POST /api/admin/lectures/sessions/[id]/postpone — التأجيل يبقي اللقاء
// الأصلي بحالة RESCHEDULED بسجلّه التاريخي، ويولّد لقاء بديلًا بالموعد
// الجديد، ويُعلم طلاب البرنامج بالموعدين.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireLectureManager()
    const { id } = await params
    const parsed = postponeSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const session = await db.lectureSession.findUnique({
      where: { id },
      include: { series: { select: { supervisorId: true, programId: true, timezone: true } } },
    })
    if (!session) return NextResponse.json({ error: 'اللقاء غير موجود' }, { status: 404 })
    if (!canManageSeries(actor, session.series)) {
      return NextResponse.json({ error: 'لا تملك صلاحية إدارة هذا اللقاء' }, { status: 403 })
    }
    if (session.status === 'CANCELLED') {
      return NextResponse.json({ error: 'لا يمكن تأجيل لقاء ملغي' }, { status: 400 })
    }
    if (session.status === 'RESCHEDULED') {
      return NextResponse.json({ error: 'هذا اللقاء مؤجل أصلًا؛ أجّل اللقاء البديل' }, { status: 400 })
    }

    const newStartsAt = new Date(parsed.data.startsAt)
    const durationMs = session.endsAt.getTime() - session.startsAt.getTime()
    const newEndsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt) : new Date(newStartsAt.getTime() + durationMs)
    if (newEndsAt.getTime() <= newStartsAt.getTime()) {
      return NextResponse.json({ error: 'وقت النهاية يجب أن يكون بعد وقت البداية' }, { status: 400 })
    }

    // R-07: إنشاء البديل ووسم الأصل في معاملة واحدة — لا لقاء مؤجل
    // بلا بديل، ولا بديل مكرر عند فشل جزئي.
    const replacement = await db.$transaction(async (tx) => {
      const created = await tx.lectureSession.create({
        data: {
          seriesId: session.seriesId,
          title: session.title,
          description: session.description,
          startsAt: newStartsAt,
          endsAt: newEndsAt,
          deliveryMode: session.deliveryMode,
          provider: session.provider,
          meetingUrl: session.meetingUrl,
          meetingPasscode: session.meetingPasscode,
          status: 'SCHEDULED',
        },
      })
      await tx.lectureSession.update({
        where: { id },
        data: { status: 'RESCHEDULED', updatedById: actor.id },
      })
      return created
    })

    const tz = session.series.timezone
    await notifyProgramStudents(session.series.programId, {
      type: 'LECTURE_POSTPONED',
      title: 'تأجيل محاضرة',
      body: `تأجلت محاضرة «${session.title}» من ${formatWhen(session.startsAt, tz)} إلى ${formatWhen(newStartsAt, tz)}.`,
      emailSubject: 'تأجيل محاضرة في برنامجك',
    })
    await auditLecture(actor, 'LECTURE_SESSION_POSTPONED', 'LectureSession', id, {
      from: session.startsAt.toISOString(),
      to: newStartsAt.toISOString(),
      replacementId: replacement.id,
    })
    return NextResponse.json({ postponedFromId: id, session: replacement })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تأجيل اللقاء' }, { status: 500 })
  }
}
