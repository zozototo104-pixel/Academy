import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { isLecturesEnabled } from '@/lib/lectures/config'
import { auditLecture, canManageProgram, programLecturesEnabled, requireLectureManager } from '@/lib/lectures/manage'

const VIDEO_SOURCES = [
  'YOUTUBE',
  'VIMEO',
  'DRIVE',
  'FACEBOOK',
  'DAILYMOTION',
  'LOOM',
  'BUNNY',
  'CLOUDFLARE',
  'MP4',
  'HLS',
  'S3',
  'EXTERNAL',
] as const

const createVideoSchema = z
  .object({
    programId: z.string().min(1),
    unitId: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    source: z.enum(VIDEO_SOURCES),
    url: z.string().url().max(2000).optional(),
    storageKey: z.string().min(1).max(500).optional(),
    provider: z.string().max(50).optional(),
    embedId: z.string().max(200).optional(),
    thumbnailUrl: z.string().url().max(2000).optional(),
    originalUrl: z.string().url().max(2000).optional(),
    mimeType: z.string().max(100).optional(),
    sizeBytes: z.number().int().min(0).optional(),
    durationSec: z.number().int().min(0).optional(),
    order: z.number().int().min(0).optional(),
  })
  .refine((v) => Boolean(v.url || v.storageKey), { message: 'يلزم رابط أو مفتاح تخزين للفيديو' })

// POST /api/admin/lectures/videos — إنشاء مورد فيديو كمسودة. التحليل
// المتقدم للروابط والرفع المباشر مرحلة لاحقة (L6)؛ هنا يُحفظ ما يُدخله
// الأدمن كما هو، ولا يظهر للطلاب قبل النشر.
export async function POST(req: NextRequest) {
  try {
    const actor = await requireLectureManager()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const parsed = createVideoSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة', issues: parsed.error.issues }, { status: 400 })
    }
    const input = parsed.data
    const program = await db.program.findUnique({ where: { id: input.programId }, select: { id: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    if (!programLecturesEnabled(input.programId)) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة لهذا البرنامج' }, { status: 403 })
    }
    if (!(await canManageProgram(actor, input.programId))) {
      return NextResponse.json({ error: 'لا تملك صلاحية إدارة فيديوهات هذا البرنامج' }, { status: 403 })
    }
    if (input.unitId) {
      const unit = await db.unit.findFirst({ where: { id: input.unitId, programId: input.programId }, select: { id: true } })
      if (!unit) return NextResponse.json({ error: 'الوحدة لا تنتمي لهذا البرنامج' }, { status: 400 })
    }
    if (input.sessionId) {
      const session = await db.lectureSession.findFirst({
        where: { id: input.sessionId, series: { programId: input.programId } },
        select: { id: true },
      })
      if (!session) return NextResponse.json({ error: 'اللقاء لا ينتمي لهذا البرنامج' }, { status: 400 })
    }
    const video = await db.lectureVideoResource.create({
      data: {
        programId: input.programId,
        unitId: input.unitId ?? null,
        sessionId: input.sessionId ?? null,
        title: input.title,
        description: input.description ?? null,
        source: input.source,
        url: input.url ?? null,
        storageKey: input.storageKey ?? null,
        provider: input.provider ?? null,
        embedId: input.embedId ?? null,
        thumbnailUrl: input.thumbnailUrl ?? null,
        originalUrl: input.originalUrl ?? null,
        mimeType: input.mimeType ?? null,
        sizeBytes: input.sizeBytes !== undefined ? BigInt(input.sizeBytes) : null,
        durationSec: input.durationSec ?? null,
        order: input.order ?? 0,
        status: 'DRAFT',
      },
    })
    await auditLecture(actor, 'LECTURE_VIDEO_CREATED', 'LectureVideoResource', video.id, {
      programId: input.programId,
      source: input.source,
    })
    return NextResponse.json(
      { video: { ...video, sizeBytes: video.sizeBytes === null ? null : Number(video.sizeBytes) } },
      { status: 201 },
    )
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في إنشاء الفيديو' }, { status: 500 })
  }
}
