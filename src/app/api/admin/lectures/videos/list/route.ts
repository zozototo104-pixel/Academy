import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isAdmin, requireLectureManager } from '@/lib/lectures/manage'
import { isLectureStorageConfigured, lectureVideoMaxBytes } from '@/lib/lectures/video-storage'

// GET /api/admin/lectures/videos/list — فيديوهات الإدارة بكل حالاتها
// (مسودة ومنشورة). المشرف يرى فيديوهات البرامج التي يدير سلاسل فيها.
export async function GET(req: NextRequest) {
  try {
    const actor = await requireLectureManager()
    const programId = req.nextUrl.searchParams.get('programId') ?? undefined

    let programScope: string[] | undefined
    if (!isAdmin(actor)) {
      const owned = (await db.lectureSeries.findMany({
        where: { supervisorId: actor.id },
        select: { programId: true },
      })) as unknown as { programId: string }[]
      programScope = [...new Set(owned.map((s) => s.programId))]
    }

    const videos = await db.lectureVideoResource.findMany({
      where: {
        ...(programId ? { programId } : {}),
        ...(programScope ? { programId: { in: programScope } } : {}),
      },
      orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
      take: 200,
      include: {
        program: { select: { titleAr: true } },
        session: { select: { title: true, startsAt: true } },
      },
    })
    return NextResponse.json({
      storageConfigured: isLectureStorageConfigured(),
      uploadMaxBytes: lectureVideoMaxBytes(),
      videos: videos.map((v: (typeof videos)[number]) => ({
        ...v,
        sizeBytes: v.sizeBytes === null ? null : Number(v.sizeBytes),
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تحميل الفيديوهات' }, { status: 500 })
  }
}
