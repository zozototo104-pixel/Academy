import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { isLecturesEnabled } from '@/lib/lectures/config'
import {
  auditLecture,
  canManageProgram,
  isAdmin,
  notifyProgramStudents,
  programLecturesEnabled,
  requireLectureManager,
} from '@/lib/lectures/manage'
import {
  generateWeeklyOccurrences,
  isValidDateYmd,
  isValidTimeHm,
  isValidTimeZone,
  weekdayOf,
  zonedTimeToUtc,
} from '@/lib/lectures/recurrence'

const createSeriesSchema = z.object({
  programId: z.string().min(1),
  unitId: z.string().min(1).optional(),
  supervisorId: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  timezone: z.string().refine(isValidTimeZone, 'منطقة زمنية غير صالحة'),
  durationMin: z.number().int().min(5).max(600),
  deliveryMode: z.enum(['EXTERNAL_LINK', 'RECORDED_ONLY']).default('EXTERNAL_LINK'),
  provider: z.enum(['ZOOM', 'MEET', 'TEAMS', 'OTHER']).default('OTHER'),
  meetingUrl: z.string().url().max(1000).optional(),
  meetingPasscode: z.string().max(100).optional(),
  recurring: z.boolean().default(false),
  startDate: z.string().refine(isValidDateYmd, 'تاريخ غير صالح'),
  timeOfDay: z.string().refine(isValidTimeHm, 'وقت غير صالح'),
  endDate: z.string().refine(isValidDateYmd, 'تاريخ غير صالح').optional(),
  occurrenceCount: z.number().int().min(1).max(52).optional(),
})

// POST /api/admin/lectures/series — إنشاء سلسلة (أو محاضرة منفردة) وتوليد
// لقاءاتها أسبوعيًا بالمنطقة الزمنية للسلسلة عند التكرار.
export async function POST(req: NextRequest) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const parsed = createSeriesSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const input = parsed.data

    const program = await db.program.findUnique({ where: { id: input.programId }, select: { id: true, titleAr: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    if (!programLecturesEnabled(input.programId)) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة لهذا البرنامج' }, { status: 403 })
    }

    const supervisorId = input.supervisorId ?? actor.id
    if (!isAdmin(actor) && supervisorId !== actor.id) {
      return NextResponse.json({ error: 'المشرف يستطيع إنشاء سلاسل لنفسه فقط' }, { status: 403 })
    }
    // R-01: المشرف لا يمنح نفسه نطاقًا جديدًا — إنشاء سلسلة في برنامج
    // يشترط صلاحية قائمة عليه أصلًا (أول سلسلة في أي برنامج ينشئها
    // الأدمن ويعيّن المشرف عليها)، وإلا صار إنشاء سلسلة بوابة لتصعيد
    // الصلاحيات لأن نطاق الإدارة يُشتق من ملكية السلاسل.
    if (!isAdmin(actor) && !(await canManageProgram(actor, input.programId))) {
      return NextResponse.json(
        { error: 'لا تملك صلاحية إدارة محاضرات هذا البرنامج — إنشاء أول سلسلة في برنامج من صلاحيات الإدارة' },
        { status: 403 },
      )
    }
    // R-04: المشرف المسند يجب أن يكون دوره فعليًا مشرفًا أو أدمن.
    const supervisor = await db.user.findUnique({ where: { id: supervisorId }, select: { id: true, role: true } })
    if (!supervisor) return NextResponse.json({ error: 'المشرف غير موجود' }, { status: 400 })
    if (supervisor.role !== 'SUPERVISOR' && supervisor.role !== 'ADMIN') {
      return NextResponse.json({ error: 'المستخدم المختار ليس مشرفًا' }, { status: 400 })
    }

    if (input.unitId) {
      const unit = await db.unit.findFirst({ where: { id: input.unitId, programId: input.programId }, select: { id: true } })
      if (!unit) return NextResponse.json({ error: 'الوحدة لا تنتمي لهذا البرنامج' }, { status: 400 })
    }

    const startsList = input.recurring
      ? generateWeeklyOccurrences({
          startDate: input.startDate,
          timeOfDay: input.timeOfDay,
          timeZone: input.timezone,
          endDate: input.endDate,
          count: input.occurrenceCount,
        })
      : [zonedTimeToUtc(input.startDate, input.timeOfDay, input.timezone)]
    if (!startsList.length) {
      return NextResponse.json({ error: 'لا توجد لقاءات ضمن النطاق المحدد' }, { status: 400 })
    }

    // R-07: إنشاء السلسلة ولقاءاتها في معاملة واحدة — لا سلسلة يتيمة
    // بلا لقاءات عند فشل جزئي.
    const series = await db.$transaction(async (tx) => {
      const created = await tx.lectureSeries.create({
        data: {
          programId: input.programId,
          unitId: input.unitId ?? null,
          supervisorId,
          createdById: actor.id,
          title: input.title,
          description: input.description ?? null,
          weekday: input.recurring ? weekdayOf(input.startDate) : null,
          timeOfDay: input.timeOfDay,
          timezone: input.timezone,
          durationMin: input.durationMin,
          recurring: input.recurring,
          active: true,
        },
      })
      await tx.lectureSession.createMany({
        data: startsList.map((startsAt) => ({
          seriesId: created.id,
          title: input.title,
          description: input.description ?? null,
          startsAt,
          endsAt: new Date(startsAt.getTime() + input.durationMin * 60_000),
          deliveryMode: input.deliveryMode,
          provider: input.provider,
          meetingUrl: input.meetingUrl ?? null,
          meetingPasscode: input.meetingPasscode ?? null,
          status: 'SCHEDULED' as const,
        })),
      })
      return created
    })

    const first = startsList[0]
    await notifyProgramStudents(input.programId, {
      type: input.recurring ? 'LECTURE_SERIES_CREATED' : 'LECTURE_CREATED',
      title: input.recurring ? 'سلسلة محاضرات جديدة' : 'محاضرة جديدة',
      body: `أُضيفت «${input.title}» إلى برنامج «${program.titleAr}». أول لقاء: ${first.toISOString()}${input.recurring ? `، وعدد اللقاءات ${startsList.length}` : ''}.`,
      emailSubject: input.recurring ? 'سلسلة محاضرات جديدة في برنامجك' : 'محاضرة جديدة في برنامجك',
    })
    await auditLecture(actor, 'LECTURE_SERIES_CREATED', 'LectureSeries', series.id, {
      programId: input.programId,
      recurring: input.recurring,
      sessions: startsList.length,
    })

    return NextResponse.json({ series, sessionsCreated: startsList.length }, { status: 201 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في إنشاء السلسلة' }, { status: 500 })
  }
}

// GET /api/admin/lectures/series — الأدمن يرى الكل، والمشرف يرى سلاسله فقط.
export async function GET(req: NextRequest) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const programId = req.nextUrl.searchParams.get('programId') ?? undefined
    const series = await db.lectureSeries.findMany({
      where: {
        ...(programId ? { programId } : {}),
        ...(isAdmin(actor) ? {} : { supervisorId: actor.id }),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        program: { select: { titleAr: true } },
        supervisor: { select: { name: true } },
        _count: { select: { sessions: true } },
      },
    })
    return NextResponse.json({ series })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تحميل السلاسل' }, { status: 500 })
  }
}
