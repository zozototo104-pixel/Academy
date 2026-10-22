import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { auditLecture, canManageSeries, notifyProgramStudents, requireLectureManager } from '@/lib/lectures/manage'
import { isLecturesEnabled } from '@/lib/lectures/config'
import { isValidDateYmd, isValidTimeHm, zonedTimeToUtc } from '@/lib/lectures/recurrence'

const createSessionSchema = z.object({
  seriesId: z.string().min(1),
  startDate: z.string().refine(isValidDateYmd, 'تاريخ غير صالح'),
  timeOfDay: z.string().refine(isValidTimeHm, 'وقت غير صالح'),
  durationMin: z.number().int().min(5).max(600).optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  deliveryMode: z.enum(['EXTERNAL_LINK', 'RECORDED_ONLY']).optional(),
  provider: z.enum(['ZOOM', 'MEET', 'TEAMS', 'OTHER']).optional(),
  meetingUrl: z.string().url().max(1000).optional(),
  meetingPasscode: z.string().max(100).optional(),
})

// POST /api/admin/lectures/sessions — لقاء إضافي داخل سلسلة قائمة، بموعد
// يُحسب بمنطقة السلسلة الزمنية. يُرفض إذا وُجد لقاء قائم بنفس الموعد.
export async function POST(req: NextRequest) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const parsed = createSessionSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const input = parsed.data
    const series = await db.lectureSeries.findUnique({ where: { id: input.seriesId } })
    if (!series) return NextResponse.json({ error: 'السلسلة غير موجودة' }, { status: 404 })
    if (!canManageSeries(actor, series)) {
      return NextResponse.json({ error: 'لا تملك صلاحية إدارة هذه السلسلة' }, { status: 403 })
    }

    const startsAt = zonedTimeToUtc(input.startDate, input.timeOfDay, series.timezone)
    const clash = await db.lectureSession.findFirst({
      where: { seriesId: series.id, startsAt, status: { not: 'CANCELLED' } },
      select: { id: true },
    })
    if (clash) return NextResponse.json({ error: 'يوجد لقاء قائم في هذا الموعد ضمن السلسلة' }, { status: 409 })

    const durationMin = input.durationMin ?? series.durationMin
    const session = await db.lectureSession.create({
      data: {
        seriesId: series.id,
        title: input.title ?? series.title,
        description: input.description ?? series.description,
        startsAt,
        endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
        deliveryMode: input.deliveryMode ?? 'EXTERNAL_LINK',
        provider: input.provider ?? 'OTHER',
        meetingUrl: input.meetingUrl ?? null,
        meetingPasscode: input.meetingPasscode ?? null,
        status: 'SCHEDULED',
      },
    })
    await notifyProgramStudents(series.programId, {
      type: 'LECTURE_CREATED',
      title: 'محاضرة جديدة',
      body: `أُضيفت محاضرة «${session.title}» إلى برنامجك. الموعد: ${startsAt.toISOString()}.`,
      emailSubject: 'محاضرة جديدة في برنامجك',
    })
    await auditLecture(actor, 'LECTURE_SESSION_CREATED', 'LectureSession', session.id, {
      seriesId: series.id,
      programId: series.programId,
    })
    return NextResponse.json({ session }, { status: 201 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في إنشاء اللقاء' }, { status: 500 })
  }
}
