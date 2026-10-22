import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { checkDatabaseRateLimit } from '@/lib/rate-limit'
import { canStudentAccessProgram } from '@/lib/lectures/access'
import { parseVideoUrl } from '@/lib/lectures/video-embed'
import { createLectureVideoSignedUrl, isUnconfirmedLectureUpload, LECTURE_VIDEO_URL_TTL_SEC } from '@/lib/lectures/video-storage'

const EMBED_SOURCES = new Set(['YOUTUBE', 'VIMEO', 'LOOM', 'BUNNY', 'CLOUDFLARE', 'DAILYMOTION', 'FACEBOOK', 'DRIVE'])

// POST /api/my/lecture-videos/[videoId]/watch — يصدر وسيلة المشاهدة بعد
// التحقق من النشر والتسجيل النشط. روابط التخزين توقّعها دالة المحاضرات
// المستقلة (ساعة كاملة، مع تجديد آمن من المشغّل) دون لمس دالة المنصة،
// ولا يخرج storageKey أو أي رابط دائم. الملفات المرفوعة التي لم يؤكّد
// السيرفر وصولها لا تُشاهد أبدًا.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ videoId: string }> }) {
  try {
    const user = await requireUser()
    const { videoId } = await params

    const limit = await checkDatabaseRateLimit(`lectures:watch:${user.id}:${videoId}`, 30, 10 * 60 * 1000)
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'محاولات كثيرة، انتظر قليلًا ثم أعد المحاولة' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
      )
    }

    const video = await db.lectureVideoResource.findUnique({
      where: { id: videoId },
      include: {
        watchProgress: { where: { userId: user.id }, select: { positionSec: true } },
      },
    })
    if (!video || video.status !== 'PUBLISHED') {
      return NextResponse.json({ error: 'الفيديو غير موجود' }, { status: 404 })
    }
    if (!(await canStudentAccessProgram(user.id, video.programId))) {
      return NextResponse.json({ error: 'الفيديو غير موجود' }, { status: 404 })
    }

    const resumePositionSec = video.watchProgress?.[0]?.positionSec ?? 0

    if (video.source === 'S3') {
      if (!video.storageKey) return NextResponse.json({ error: 'ملف الفيديو غير متاح' }, { status: 404 })
      if (isUnconfirmedLectureUpload(video)) {
        return NextResponse.json({ error: 'ملف الفيديو غير متاح' }, { status: 404 })
      }
      const url = createLectureVideoSignedUrl(video.storageKey)
      if (!url) return NextResponse.json({ error: 'رابط المشاهدة غير متاح حاليًا' }, { status: 404 })
      return NextResponse.json({
        kind: 'file',
        url,
        mimeType: video.mimeType,
        expiresInSec: LECTURE_VIDEO_URL_TTL_SEC,
        resumePositionSec,
      })
    }
    if (EMBED_SOURCES.has(video.source)) {
      const parsed = video.url ? parseVideoUrl(video.url) : null
      return NextResponse.json({
        kind: 'embed',
        source: video.source,
        provider: video.provider,
        embedId: video.embedId,
        embedUrl: parsed && parsed.source === video.source ? parsed.embedUrl : null,
        url: video.url,
        resumePositionSec,
      })
    }
    if (video.source === 'MP4' || video.source === 'WEBM' || video.source === 'HLS') {
      return NextResponse.json({ kind: 'file', url: video.url, mimeType: video.mimeType, source: video.source, resumePositionSec })
    }
    return NextResponse.json({ kind: 'external', url: video.url ?? video.originalUrl, resumePositionSec })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تجهيز المشاهدة' }, { status: 500 })
  }
}
