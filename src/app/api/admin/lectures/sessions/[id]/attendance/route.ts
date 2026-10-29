import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { auditLecture, canManageSession, getProgramStudentIds, requireLectureManager } from '@/lib/lectures/manage'
import { isLecturesEnabled } from '@/lib/lectures/config'

async function loadManagedSession(actor: { id: string; name: string; role: string }, id: string) {
  const session = await db.lectureSession.findUnique({
    where: { id },
    include: { series: { select: { supervisorId: true, programId: true } } },
  })
  if (!session) return { error: NextResponse.json({ error: 'اللقاء غير موجود' }, { status: 404 }) }
  if (!canManageSession(actor, session, session.series)) {
    return { error: NextResponse.json({ error: 'لا تملك صلاحية إدارة هذا اللقاء' }, { status: 403 }) }
  }
  return { session }
}

// GET /api/admin/lectures/sessions/[id]/attendance — محاولات الدخول
// المسجلة وقائمة طلاب البرنامج الملتحقين، لمراجعة المشرف وتأكيده.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const { id } = await params
    const { session, error } = await loadManagedSession(actor, id)
    if (error) return error
    const attendances = await db.lectureAttendance.findMany({
      where: { sessionId: id },
      orderBy: { joinedAt: 'asc' },
      include: { user: { select: { id: true, name: true, email: true } } },
    })
    const studentIds = await getProgramStudentIds(session.series.programId)
    const students = studentIds.length
      ? await db.user.findMany({ where: { id: { in: studentIds } }, select: { id: true, name: true, email: true } })
      : []
    return NextResponse.json({ attendances, enrolledStudents: students })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تحميل الحضور' }, { status: 500 })
  }
}

const confirmSchema = z.object({
  userId: z.string().min(1),
  status: z.enum(['PRESENT', 'ABSENT']),
})

// PATCH /api/admin/lectures/sessions/[id]/attendance — تأكيد المشرف
// للحضور الفعلي أو الغياب. محاولة الدخول JOINED وحدها لا تكفي.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const { id } = await params
    const { session, error } = await loadManagedSession(actor, id)
    if (error) return error
    const parsed = confirmSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const studentIds = await getProgramStudentIds(session.series.programId)
    if (!studentIds.includes(parsed.data.userId)) {
      return NextResponse.json({ error: 'الطالب غير مسجّل في برنامج هذا اللقاء' }, { status: 400 })
    }
    const now = new Date()
    const attendance = await db.lectureAttendance.upsert({
      where: { sessionId_userId: { sessionId: id, userId: parsed.data.userId } },
      create: {
        sessionId: id,
        userId: parsed.data.userId,
        status: parsed.data.status,
        confirmedById: actor.id,
        confirmedAt: now,
      },
      update: { status: parsed.data.status, confirmedById: actor.id, confirmedAt: now },
    })
    await auditLecture(actor, 'LECTURE_ATTENDANCE_CONFIRMED', 'LectureSession', id, {
      userId: parsed.data.userId,
      status: parsed.data.status,
    })
    return NextResponse.json({ attendance })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تأكيد الحضور' }, { status: 500 })
  }
}
