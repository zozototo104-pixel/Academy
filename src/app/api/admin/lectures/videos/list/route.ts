import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isLecturesEnabled } from '@/lib/lectures/config'
import { isAdmin, requireLectureManager } from '@/lib/lectures/manage'
import { isLectureStorageConfigured, lectureVideoMaxBytes } from '@/lib/lectures/video-storage'
import { supervisorProgramIds } from '@/lib/supervisor-scope'

// GET /api/admin/lectures/videos/list — فيديوهات الإدارة بكل حالاتها
// (مسودة ومنشورة). المشرف يرى فيديوهات برامج طلابه وسلاسله — بما فيها
// فيديوهات الإدارة المنشورة لطلابه (قراءة؛ الإدارة والتعديل بملكية السلسلة).
export async function GET(req: NextRequest) {
  try {
    const actor = await requireLectureManager()
    // R-03: القوائم تحترم مفتاح الميزة مثل مسارات الإنشاء تمامًا.
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const programId = req.nextUrl.searchParams.get('programId') ?? undefined

    let programScope: string[] | undefined
    if (!isAdmin(actor)) {
      programScope = await supervisorProgramIds(actor)
    }

    // S-03L: تقاطع صريح بين فلتر البرنامج ونطاق المشرف — كتابة المفتاح
    // نفسه مرتين كانت تجعل النطاق يطغى على الفلتر المطلوب.
    let programFilter: { programId?: string | { in: string[] } } = {}
    if (programScope) {
      if (programId) {
        if (!programScope.includes(programId)) {
          return NextResponse.json({
            storageConfigured: isLectureStorageConfigured(),
            uploadMaxBytes: lectureVideoMaxBytes(),
            videos: [],
          })
        }
        programFilter = { programId }
      } else {
        programFilter = { programId: { in: programScope } }
      }
    } else if (programId) {
      programFilter = { programId }
    }

    const videos = await db.lectureVideoResource.findMany({
      where: { ...programFilter },
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
