import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { auditLecture, canManageProgram, isAdmin, requireLectureManager } from '@/lib/lectures/manage'
import { isLecturesEnabled } from '@/lib/lectures/config'
import { isUnconfirmedLectureUpload } from '@/lib/lectures/video-storage'
import { deleteStoredFile } from '@/lib/storage'

const patchVideoSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
  order: z.number().int().min(0).optional(),
  unitId: z.string().min(1).nullable().optional(),
  sessionId: z.string().min(1).nullable().optional(),
  thumbnailUrl: z.string().url().max(2000).nullable().optional(),
  durationSec: z.number().int().min(0).nullable().optional(),
})

// PATCH /api/admin/lectures/videos/[id] — تعديل فيديو أو نشره أو إعادته
// مسودة أو إعادة ترتيبه. النشر يختم publishedAt، والمسودة تمسحه.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const { id } = await params
    const video = await db.lectureVideoResource.findUnique({ where: { id } })
    if (!video) return NextResponse.json({ error: 'الفيديو غير موجود' }, { status: 404 })
    if (!(await canManageProgram(actor, video.programId))) {
      return NextResponse.json({ error: 'لا تملك صلاحية إدارة فيديوهات هذا البرنامج' }, { status: 403 })
    }
    const parsed = patchVideoSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const input = parsed.data
    if (input.unitId) {
      const unit = await db.unit.findFirst({ where: { id: input.unitId, programId: video.programId }, select: { id: true } })
      if (!unit) return NextResponse.json({ error: 'الوحدة لا تنتمي لبرنامج الفيديو' }, { status: 400 })
    }
    if (input.sessionId) {
      const session = await db.lectureSession.findFirst({
        where: { id: input.sessionId, series: { programId: video.programId } },
        select: { id: true },
      })
      if (!session) return NextResponse.json({ error: 'اللقاء لا ينتمي لبرنامج الفيديو' }, { status: 400 })
    }

    // ملف رُفع ولم يؤكّد السيرفر وصوله لا يُنشر أبدًا.
    if (input.status === 'PUBLISHED' && isUnconfirmedLectureUpload(video)) {
      return NextResponse.json(
        { error: 'لا يمكن نشر ملف لم يكتمل رفعه وتأكيده بعد' },
        { status: 422 },
      )
    }
    const data: Record<string, unknown> = { ...input }
    if (input.status === 'PUBLISHED') data.publishedAt = video.publishedAt ?? new Date()
    if (input.status === 'DRAFT') data.publishedAt = null

    const updated = await db.lectureVideoResource.update({ where: { id }, data })
    await auditLecture(
      actor,
      input.status === 'PUBLISHED' ? 'LECTURE_VIDEO_PUBLISHED' : 'LECTURE_VIDEO_UPDATED',
      'LectureVideoResource',
      id,
      { fields: Object.keys(input) },
    )
    return NextResponse.json({
      video: { ...updated, sizeBytes: updated.sizeBytes === null ? null : Number(updated.sizeBytes) },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تعديل الفيديو' }, { status: 500 })
  }
}

// DELETE /api/admin/lectures/videos/[id] — حذف فيديو، للأدمن فقط.
// سجل تقدم المشاهدة المرتبط بالفيديو يُحذف معه تلقائيًا (Cascade في المخطط).
// ملف التخزين الخاص (S3/محلي) يُحذف بأفضل جهد؛ فشل حذف الملف لا يمنع حذف
// السجل، لكنه يُسجَّل في التدقيق. روابط يوتيوب/خارجية لا تُمسّ أصلًا.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    if (!isAdmin(actor)) {
      return NextResponse.json({ error: 'حذف الفيديو صلاحية الأدمن فقط' }, { status: 403 })
    }
    const { id } = await params
    const video = await db.lectureVideoResource.findUnique({ where: { id } })
    if (!video) return NextResponse.json({ error: 'الفيديو غير موجود' }, { status: 404 })
    let storageDeleted: boolean | null = null
    if (video.storageKey) {
      storageDeleted = await deleteStoredFile(video.storageKey)
    }
    await db.lectureVideoResource.delete({ where: { id } })
    await auditLecture(actor, 'LECTURE_VIDEO_DELETED', 'LectureVideoResource', id, {
      title: video.title,
      source: video.source,
      status: video.status,
      storageDeleted,
    })
    return NextResponse.json({ deleted: true, storageDeleted })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في حذف الفيديو' }, { status: 500 })
  }
}
