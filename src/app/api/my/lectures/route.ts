import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { isLecturesEnabled } from '@/lib/lectures/config'
import { LECTURE_SESSION_INCLUDE, getActiveLectureProgramIds } from '@/lib/lectures/access'
import { toPublicSession } from '@/lib/lectures/student'

// GET /api/my/lectures — محاضرات الطالب في برامجه ذات التسجيل النشط فقط.
// لا تتضمن الاستجابة روابط الاجتماعات أو رموز الدخول أبدًا.
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    let programIds = await getActiveLectureProgramIds(user.id)
    const programId = req.nextUrl.searchParams.get('programId')
    if (programId) programIds = programIds.filter((id) => id === programId)
    if (!programIds.length) return NextResponse.json({ sessions: [] })

    const sessions = await db.lectureSession.findMany({
      where: { series: { programId: { in: programIds } } },
      include: LECTURE_SESSION_INCLUDE,
      orderBy: { startsAt: 'asc' },
    })
    const now = new Date()
    return NextResponse.json({ sessions: sessions.map((s: never) => toPublicSession(s, now)) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تحميل المحاضرات' }, { status: 500 })
  }
}
