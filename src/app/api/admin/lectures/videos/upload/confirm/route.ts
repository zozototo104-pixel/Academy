import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { auditLecture, canManageProgram, requireLectureManager } from '@/lib/lectures/manage'
import { headLectureObject, lectureVideoMaxBytes } from '@/lib/lectures/video-storage'

const confirmSchema = z.object({ videoId: z.string().min(1) })

// POST /api/admin/lectures/videos/upload/confirm — يتحقق السيرفر بنفسه
// (طلب HEAD موقّع) أن الملف وصل إلى التخزين، ويسجّل حجمه ونوعه
// الحقيقيين. بدون هذا التأكيد يبقى الصف غير قابل للنشر والمشاهدة.
export async function POST(req: NextRequest) {
  try {
    const actor = await requireLectureManager()
    const parsed = confirmSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const video = await db.lectureVideoResource.findUnique({ where: { id: parsed.data.videoId } })
    if (!video || video.source !== 'S3' || !video.storageKey) {
      return NextResponse.json({ error: 'الفيديو غير موجود' }, { status: 404 })
    }
    if (!(await canManageProgram(actor, video.programId))) {
      return NextResponse.json({ error: 'لا تملك صلاحية إدارة فيديوهات هذا البرنامج' }, { status: 403 })
    }
    const head = await headLectureObject(video.storageKey)
    if (!head) {
      return NextResponse.json(
        { error: 'لم يصل الملف إلى التخزين بعد — أكمل الرفع ثم أعد التأكيد' },
        { status: 409 },
      )
    }
    if (head.sizeBytes > lectureVideoMaxBytes()) {
      return NextResponse.json({ error: 'حجم الملف الفعلي يتجاوز الحد الأقصى المسموح' }, { status: 422 })
    }
    const updated = await db.lectureVideoResource.update({
      where: { id: video.id },
      data: {
        sizeBytes: BigInt(head.sizeBytes),
        mimeType: head.contentType ?? video.mimeType,
      },
    })
    await auditLecture(actor, 'LECTURE_VIDEO_UPLOAD_CONFIRMED', 'LectureVideoResource', video.id, {
      programId: video.programId,
      sizeBytes: head.sizeBytes,
    })
    return NextResponse.json({
      video: { ...updated, sizeBytes: Number(updated.sizeBytes) },
      confirmed: true,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تأكيد الرفع' }, { status: 500 })
  }
}
