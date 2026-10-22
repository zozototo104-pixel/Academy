import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { isLecturesEnabled } from '@/lib/lectures/config'
import { auditLecture, canManageProgram, programLecturesEnabled, requireLectureManager } from '@/lib/lectures/manage'
import {
  createLectureUploadUrl,
  isLectureStorageConfigured,
  lectureVideoMaxBytes,
  LECTURE_UPLOAD_TYPES,
  newLectureUploadKey,
} from '@/lib/lectures/video-storage'

const initSchema = z.object({
  programId: z.string().min(1),
  unitId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  title: z.string().min(1).max(200),
  mimeType: z.string().max(100),
  sizeBytes: z.number().int().min(1).optional(),
})

// POST /api/admin/lectures/videos/upload/init — يبدأ رفعًا مباشرًا من
// المتصفح إلى التخزين الخاص: ينشئ صف فيديو مسودة بمفتاح تحت
// lectures/videos/ دون حجم مؤكد، ويعيد رابط رفع موقّعًا. الملف لا يمر
// عبر السيرفر، ولا يُنشر الصف قبل تأكيد وصول الملف فعليًا.
export async function POST(req: NextRequest) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    if (!isLectureStorageConfigured()) {
      return NextResponse.json(
        { error: 'التخزين الخاص غير مهيأ على السيرفر، فالرفع المباشر غير متاح. أضف روابط الفيديو بدلًا من رفعها.' },
        { status: 422 },
      )
    }
    const parsed = initSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const input = parsed.data
    if (!(input.mimeType in LECTURE_UPLOAD_TYPES)) {
      return NextResponse.json({ error: 'نوع الملف غير مدعوم — المسموح: MP4 و WebM و MOV' }, { status: 400 })
    }
    const maxBytes = lectureVideoMaxBytes()
    if (input.sizeBytes !== undefined && input.sizeBytes > maxBytes) {
      return NextResponse.json(
        { error: `حجم الملف يتجاوز الحد الأقصى (${Math.floor(maxBytes / (1024 * 1024))} ميغابايت)` },
        { status: 400 },
      )
    }
    if (!programLecturesEnabled(input.programId)) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة لهذا البرنامج' }, { status: 403 })
    }
    if (!(await canManageProgram(actor, input.programId))) {
      return NextResponse.json({ error: 'لا تملك صلاحية إدارة فيديوهات هذا البرنامج' }, { status: 403 })
    }
    const key = newLectureUploadKey(input.mimeType)
    if (!key) return NextResponse.json({ error: 'نوع الملف غير مدعوم' }, { status: 400 })
    const uploadUrl = createLectureUploadUrl(key)
    if (!uploadUrl) {
      return NextResponse.json({ error: 'تعذر تجهيز رابط الرفع' }, { status: 422 })
    }
    const video = await db.lectureVideoResource.create({
      data: {
        programId: input.programId,
        unitId: input.unitId ?? null,
        sessionId: input.sessionId ?? null,
        title: input.title,
        source: 'S3',
        storageKey: key,
        mimeType: input.mimeType,
        sizeBytes: null, // يُملأ عند التأكيد بعد التحقق من وصول الملف
        status: 'DRAFT',
      },
    })
    await auditLecture(actor, 'LECTURE_VIDEO_UPLOAD_STARTED', 'LectureVideoResource', video.id, {
      programId: input.programId,
    })
    return NextResponse.json(
      { video: { ...video, sizeBytes: null }, uploadUrl, maxBytes },
      { status: 201 },
    )
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في بدء الرفع' }, { status: 500 })
  }
}
