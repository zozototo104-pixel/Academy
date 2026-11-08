import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { auditLecture, canManageSession, isAdmin, notifyProgramStudents, requireLectureManager } from '@/lib/lectures/manage'
import { isLecturesEnabled } from '@/lib/lectures/config'

const patchSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  deliveryMode: z.enum(['EXTERNAL_LINK', 'RECORDED_ONLY']).optional(),
  provider: z.enum(['ZOOM', 'MEET', 'TEAMS', 'OTHER']).optional(),
  meetingUrl: z.string().url().max(1000).nullable().optional(),
  meetingPasscode: z.string().max(100).nullable().optional(),
  // المشرف المحاضر لهذا اللقاء وحده (إدارة فقط): قيمة = محاضر خاص،
  // و null = إرجاعه لمشرف السلسلة. تغييره ينقل اللقاء فورًا لصفحة محاضره.
  supervisorId: z.string().min(1).nullable().optional(),
})

// PATCH /api/admin/lectures/sessions/[id] — تعديل بيانات لقاء واحد.
// تغيير الموعد لا يتم من هنا: التأجيل مسار مستقل لأنه يولّد لقاء بديلًا
// ويُعلم الطلاب، حتى لا يتغير موعد بصمت.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const { id } = await params
    const raw = await req.json().catch(() => null)
    if (raw && ('startsAt' in raw || 'endsAt' in raw)) {
      return NextResponse.json({ error: 'تغيير الموعد يتم عبر مسار التأجيل' }, { status: 400 })
    }
    const session = await db.lectureSession.findUnique({
      where: { id },
      include: { series: { select: { supervisorId: true, programId: true } } },
    })
    if (!session) return NextResponse.json({ error: 'اللقاء غير موجود' }, { status: 404 })
    if (!canManageSession(actor, session, session.series)) {
      return NextResponse.json({ error: 'لا تملك صلاحية إدارة هذا اللقاء' }, { status: 403 })
    }
    const parsed = patchSessionSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const { supervisorId, ...sessionData } = parsed.data
    let lecturerChanged = false
    let lecturerId = session.lecturerId ?? null
    if (supervisorId !== undefined && supervisorId !== (session.lecturerId ?? null)) {
      if (!isAdmin(actor)) {
        return NextResponse.json({ error: 'تغيير المشرف المحاضر من صلاحيات الإدارة' }, { status: 403 })
      }
      if (supervisorId) {
        // R-04 (نفس قاعدة إنشاء السلسلة): المسند يجب أن يكون مشرفًا أو أدمن فعليًا.
        const target = await db.user.findUnique({ where: { id: supervisorId }, select: { id: true, role: true } })
        if (!target) return NextResponse.json({ error: 'المشرف غير موجود' }, { status: 400 })
        if (target.role !== 'SUPERVISOR' && target.role !== 'ADMIN') {
          return NextResponse.json({ error: 'المستخدم المختار ليس مشرفًا' }, { status: 400 })
        }
      }
      lecturerId = supervisorId
      lecturerChanged = true
    }
    const updated = await db.lectureSession.update({
      where: { id },
      data: { ...sessionData, lecturerId, updatedById: actor.id },
    })
    if (lecturerChanged) {
      await auditLecture(actor, 'LECTURE_SESSION_LECTURER_CHANGED', 'LectureSession', id, {
        fromLecturerId: session.lecturerId ?? session.series.supervisorId,
        toLecturerId: lecturerId ?? session.series.supervisorId,
      })
    }
    await auditLecture(actor, 'LECTURE_SESSION_UPDATED', 'LectureSession', id, {
      fields: Object.keys(sessionData),
      ...(lecturerChanged ? { lecturerChanged: true } : {}),
    })
    return NextResponse.json({ session: updated })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تعديل اللقاء' }, { status: 500 })
  }
}

// DELETE /api/admin/lectures/sessions/[id] — حذف نهائي للأدمن فقط.
// حضور الطلاب سجل أكاديمي لا يُمحى؛ عند وجوده يُستخدم الإلغاء بدل الحذف.
// الفيديوهات محفوظة في البرنامج ويرجع ربطها باللقاء إلى null (SetNull).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    if (!isAdmin(actor)) {
      return NextResponse.json({ error: 'حذف اللقاء صلاحية الإدارة فقط' }, { status: 403 })
    }
    const { id } = await params
    const session = await db.lectureSession.findUnique({
      where: { id },
      include: {
        series: { select: { programId: true } },
        _count: { select: { attendances: true, videos: true } },
      },
    })
    if (!session) return NextResponse.json({ error: 'اللقاء غير موجود' }, { status: 404 })
    if (session._count.attendances > 0) {
      return NextResponse.json({
        error: 'لا يمكن حذف لقاء لديه سجل حضور؛ استخدم الإلغاء للحفاظ على سجل الطلاب',
      }, { status: 409 })
    }
    // Conditional delete additionally protects against attendance being recorded
    // between the initial lookup and the delete request.
    const deleted = await db.lectureSession.deleteMany({
      where: { id, attendances: { none: {} } },
    })
    if (deleted.count === 0) {
      return NextResponse.json({ error: 'تعذر الحذف لأن حضورًا سُجل لهذا اللقاء؛ استخدم الإلغاء' }, { status: 409 })
    }
    await auditLecture(actor, 'LECTURE_SESSION_DELETED', 'LectureSession', id, {
      title: session.title,
      programId: session.series.programId,
      status: session.status,
      detachedVideos: session._count.videos,
    })
    if (new Date(session.startsAt).getTime() > Date.now() && session.status !== 'CANCELLED') {
      // Students were notified of the original schedule: clarify its removal.
      await notifyProgramStudents(session.series.programId, {
        type: 'LECTURE_CANCELLED',
        title: 'إزالة لقاء من جدول المحاضرات',
        body: `أُزيل اللقاء «${session.title}» من جدول المحاضرات. يرجى مراجعة جدول التخصص المحدّث.`,
        emailSubject: 'تحديث جدول محاضرات البرنامج',
      }).catch((error) => console.error('lecture delete notification error:', error))
    }
    return NextResponse.json({ deleted: true, detachedVideos: session._count.videos })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    console.error('lecture session DELETE error:', error)
    return NextResponse.json({ error: 'تعذر حذف اللقاء' }, { status: 500 })
  }
}
