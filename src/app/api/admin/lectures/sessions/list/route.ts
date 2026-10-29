import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isLecturesEnabled } from '@/lib/lectures/config'
import { isAdmin, requireLectureManager } from '@/lib/lectures/manage'

// GET /api/admin/lectures/sessions/list — قائمة اللقاءات لشاشة الإدارة.
// الأدمن يرى الكل، والمشرف يرى اللقاءات التي هو محاضرها الفعلي فقط:
// محاضرها الخاص هو، أو بلا محاضر خاص وهو مشرف سلسلتها. الفلاتر:
// programId و status و from/to على وقت البداية.
export async function GET(req: NextRequest) {
  try {
    const actor = await requireLectureManager()
    // R-03: القوائم تحترم مفتاح الميزة مثل مسارات الإنشاء تمامًا.
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const q = req.nextUrl.searchParams
    const programId = q.get('programId') ?? undefined
    const status = q.get('status') ?? undefined
    const from = q.get('from') ?? undefined
    const to = q.get('to') ?? undefined

    const sessions = await db.lectureSession.findMany({
      where: {
        ...(status ? { status: status as never } : {}),
        ...(from || to
          ? {
              startsAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(to) } : {}),
              },
            }
          : {}),
        series: {
          ...(programId ? { programId } : {}),
        },
        ...(isAdmin(actor)
          ? {}
          : {
              OR: [
                { lecturerId: actor.id },
                { lecturerId: null, series: { supervisorId: actor.id } },
              ],
            }),
      },
      orderBy: { startsAt: 'asc' },
      take: 200,
      include: {
        lecturer: { select: { name: true } },
        series: {
          select: {
            title: true,
            programId: true,
            timezone: true,
            supervisorId: true,
            supervisor: { select: { name: true } },
            program: { select: { titleAr: true } },
          },
        },
        _count: { select: { attendances: true } },
      },
    })
    return NextResponse.json({ sessions })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'غير مصرّح' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تحميل اللقاءات' }, { status: 500 })
  }
}
