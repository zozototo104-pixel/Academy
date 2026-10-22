import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { auditLecture, canManageSeries, isAdmin, requireLectureManager } from '@/lib/lectures/manage'
import { isLecturesEnabled } from '@/lib/lectures/config'

const patchSeriesSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  supervisorId: z.string().min(1).optional(),
  unitId: z.string().min(1).nullable().optional(),
  active: z.boolean().optional(),
})

// PATCH /api/admin/lectures/series/[id] — تعديل بيانات السلسلة نفسها.
// مواعيد اللقاءات لا تُعدّل من هنا؛ كل لقاء يُعدّل أو يُؤجّل على حدة.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const { id } = await params
    const series = await db.lectureSeries.findUnique({ where: { id } })
    if (!series) return NextResponse.json({ error: 'السلسلة غير موجودة' }, { status: 404 })
    if (!canManageSeries(actor, series)) {
      return NextResponse.json({ error: 'لا تملك صلاحية إدارة هذه السلسلة' }, { status: 403 })
    }
    const parsed = patchSeriesSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const input = parsed.data

    if (input.supervisorId && input.supervisorId !== series.supervisorId) {
      if (!isAdmin(actor)) {
        return NextResponse.json({ error: 'إعادة تعيين المشرف صلاحية الأدمن فقط' }, { status: 403 })
      }
      // نفس فحص الإنشاء (R-04): المشرف المسند يجب أن يكون دوره فعليًا مشرفًا أو أدمن.
      const supervisor = await db.user.findUnique({ where: { id: input.supervisorId }, select: { id: true, role: true } })
      if (!supervisor) return NextResponse.json({ error: 'المشرف غير موجود' }, { status: 400 })
      if (supervisor.role !== 'SUPERVISOR' && supervisor.role !== 'ADMIN') {
        return NextResponse.json({ error: 'المستخدم المختار ليس مشرفًا' }, { status: 400 })
      }
    }
    if (input.unitId) {
      const unit = await db.unit.findFirst({
        where: { id: input.unitId, programId: series.programId },
        select: { id: true },
      })
      if (!unit) return NextResponse.json({ error: 'الوحدة لا تنتمي لبرنامج السلسلة' }, { status: 400 })
    }

    const updated = await db.lectureSeries.update({ where: { id }, data: input })
    await auditLecture(actor, 'LECTURE_SERIES_UPDATED', 'LectureSeries', id, { fields: Object.keys(input) })
    return NextResponse.json({ series: updated })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تعديل السلسلة' }, { status: 500 })
  }
}
