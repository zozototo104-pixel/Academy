import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { auditLecture, canManageSeries, isAdmin, requireLectureManager } from '@/lib/lectures/manage'
import { isLecturesEnabled } from '@/lib/lectures/config'

const patchSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  deliveryMode: z.enum(['EXTERNAL_LINK', 'RECORDED_ONLY']).optional(),
  provider: z.enum(['ZOOM', 'MEET', 'TEAMS', 'OTHER']).optional(),
  meetingUrl: z.string().url().max(1000).nullable().optional(),
  meetingPasscode: z.string().max(100).nullable().optional(),
  // المشرف المحاضر يعيش على السلسلة لا على اللقاء: تمريره هنا يعيد تعيين
  // مشرف سلسلة اللقاء كاملة (إدارة فقط)، فيظهر اللقاء بصفحة المشرف الجديد.
  supervisorId: z.string().min(1).optional(),
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
    if (!canManageSeries(actor, session.series)) {
      return NextResponse.json({ error: 'لا تملك صلاحية إدارة هذا اللقاء' }, { status: 403 })
    }
    const parsed = patchSessionSchema.safeParse(raw)
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const { supervisorId, ...sessionData } = parsed.data
    let supervisorChanged = false
    if (supervisorId && supervisorId !== session.series.supervisorId) {
      if (!isAdmin(actor)) {
        return NextResponse.json({ error: 'تغيير المشرف المحاضر من صلاحيات الإدارة' }, { status: 403 })
      }
      // R-04 (نفس قاعدة إنشاء السلسلة): المسند يجب أن يكون مشرفًا أو أدمن فعليًا.
      const target = await db.user.findUnique({ where: { id: supervisorId }, select: { id: true, role: true } })
      if (!target) return NextResponse.json({ error: 'المشرف غير موجود' }, { status: 400 })
      if (target.role !== 'SUPERVISOR' && target.role !== 'ADMIN') {
        return NextResponse.json({ error: 'المستخدم المختار ليس مشرفًا' }, { status: 400 })
      }
      await db.lectureSeries.update({ where: { id: session.seriesId }, data: { supervisorId } })
      await auditLecture(actor, 'LECTURE_SERIES_SUPERVISOR_CHANGED', 'LectureSeries', session.seriesId, {
        fromSupervisorId: session.series.supervisorId,
        toSupervisorId: supervisorId,
        viaSessionId: id,
      })
      supervisorChanged = true
    }
    const updated = await db.lectureSession.update({
      where: { id },
      data: { ...sessionData, updatedById: actor.id },
    })
    await auditLecture(actor, 'LECTURE_SESSION_UPDATED', 'LectureSession', id, {
      fields: Object.keys(sessionData),
      ...(supervisorChanged ? { supervisorChanged: true } : {}),
    })
    return NextResponse.json({ session: updated })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تعديل اللقاء' }, { status: 500 })
  }
}
