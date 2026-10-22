import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { isLecturesEnabled } from '@/lib/lectures/config'
import { getActiveLectureProgramIds } from '@/lib/lectures/access'

// GET /api/my/lecture-videos — الفيديوهات المنشورة فقط ضمن برامج الطالب،
// مع تقدم مشاهدته. لا تتضمن الاستجابة روابط الملفات أو مفاتيح التخزين.
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    let programIds = await getActiveLectureProgramIds(user.id)
    const programId = req.nextUrl.searchParams.get('programId')
    if (programId) programIds = programIds.filter((id) => id === programId)
    if (!programIds.length) return NextResponse.json({ videos: [] })

    const videos = await db.lectureVideoResource.findMany({
      where: { programId: { in: programIds }, status: 'PUBLISHED' },
      orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
      include: {
        watchProgress: {
          where: { userId: user.id },
          select: { positionSec: true, watchedPercent: true, completedAt: true },
        },
      },
    })
    return NextResponse.json({
      videos: videos.map((v: any) => ({
        id: v.id,
        title: v.title,
        description: v.description,
        source: v.source,
        provider: v.provider,
        embedId: v.embedId,
        thumbnailUrl: v.thumbnailUrl,
        durationSec: v.durationSec,
        programId: v.programId,
        unitId: v.unitId,
        sessionId: v.sessionId,
        order: v.order,
        publishedAt: v.publishedAt,
        progress: v.watchProgress?.[0]
          ? {
              positionSec: v.watchProgress[0].positionSec,
              watchedPercent: v.watchProgress[0].watchedPercent,
              completedAt: v.watchProgress[0].completedAt,
            }
          : null,
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تحميل الفيديوهات' }, { status: 500 })
  }
}
