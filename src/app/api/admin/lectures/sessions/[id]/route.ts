import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { auditLecture, canManageSession, isAdmin, notifyProgramStudents, requireLectureManager } from '@/lib/lectures/manage'
import { isLecturesEnabled } from '@/lib/lectures/config'
import { safeAuditDetails } from '@/lib/lectures/audit'

const deleteSessionSchema = z.object({ reason: z.string().trim().min(10).max(500) })

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
// الإدارة وحدها تستطيع حذف اللقاء حتى مع وجود حضور، بعد سبب وتأكيد صريح.
// نسخة الحضور تحفظ في سجل التدقيق الذرّي قبل حذف سجلاته المرتبطة.
// الفيديوهات محفوظة في البرنامج ويرجع ربطها باللقاء إلى null (SetNull).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    if (!isAdmin(actor)) {
      return NextResponse.json({ error: 'حذف اللقاء صلاحية الإدارة فقط' }, { status: 403 })
    }
    const parsed = deleteSessionSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'سبب الحذف مطلوب (10 أحرف على الأقل)' }, { status: 400 })
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
    // Admin explicitly confirmed that linked attendance records will be
    // removed. Archive their academic details and the deletion reason in the
    // SAME transaction so a failed audit always rolls back the entire delete.
    // Serializable isolation prevents unrecorded concurrent attendance inserts.
    const deleted = await db.$transaction(async (tx) => {
      const attendanceSnapshot = await tx.lectureAttendance.findMany({
        where: { sessionId: id },
        select: {
          userId: true,
          status: true,
          joinedAt: true,
          confirmedAt: true,
          confirmedById: true,
        },
        orderBy: { joinedAt: 'asc' },
      })
      const removedAttendances = await tx.lectureAttendance.deleteMany({
        where: { sessionId: id },
      })
      if (removedAttendances.count !== attendanceSnapshot.length) {
        throw new Error('LECTURE_DELETE_CONFLICT')
      }
      // Keep the conditional guard against an attendance row arriving during
      // deletion. A failed delete aborts the transaction, restoring attendance.
      const result = await tx.lectureSession.deleteMany({
        where: { id, attendances: { none: {} } },
      })
      if (result.count !== 1) throw new Error('LECTURE_DELETE_CONFLICT')
      await tx.auditLog.create({
        data: {
          actorId: actor.id,
          actorName: actor.name,
          action: 'LECTURE_SESSION_DELETED',
          entity: 'LectureSession',
          entityId: id,
          details: safeAuditDetails({
            title: session.title,
            programId: session.series.programId,
            status: session.status,
            reason: parsed.data.reason,
            deletedAttendanceCount: attendanceSnapshot.length,
            deletedAttendance: attendanceSnapshot,
            detachedVideos: session._count.videos,
          }),
        },
      })
      return { attendanceCount: attendanceSnapshot.length }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    let notificationWarning = false
    if (new Date(session.startsAt).getTime() > Date.now() && session.status !== 'CANCELLED') {
      // Students were notified of the original schedule: clarify its removal.
      await notifyProgramStudents(session.series.programId, {
        type: 'LECTURE_CANCELLED',
        title: 'إزالة لقاء من جدول المحاضرات',
        body: `أُزيل اللقاء «${session.title}» من جدول المحاضرات. يرجى مراجعة جدول التخصص المحدّث.`,
        emailSubject: 'تحديث جدول محاضرات البرنامج',
      }).catch(() => { notificationWarning = true })
    }
    return NextResponse.json({ deleted: true, deletedAttendances: deleted.attendanceCount, detachedVideos: session._count.videos, notificationWarning })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    if (error?.message === 'LECTURE_DELETE_CONFLICT' || error?.code === 'P2034') {
      return NextResponse.json({ error: 'تغيرت سجلات اللقاء أثناء الحذف. أعد المحاولة بعد تحديث الصفحة.' }, { status: 409 })
    }
    return NextResponse.json({ error: 'تعذر حذف اللقاء أو حفظ سبب الحذف في سجل التدقيق؛ لم يُحذف شيء' }, { status: 500 })
  }
}
