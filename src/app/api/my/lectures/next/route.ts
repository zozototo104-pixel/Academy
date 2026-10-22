import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { isLecturesEnabled } from '@/lib/lectures/config'
import { LECTURE_SESSION_INCLUDE, getActiveLectureProgramIds } from '@/lib/lectures/access'
import { toPublicSession } from '@/lib/lectures/student'

// GET /api/my/lectures/next — أقرب محاضرة قادمة أو جارية الآن لبرامج الطالب.
export async function GET() {
  try {
    const user = await requireUser()
    if (!isLecturesEnabled()) {
      return NextResponse.json({ error: 'المحاضرات غير مفعّلة حاليًا' }, { status: 404 })
    }
    const programIds = await getActiveLectureProgramIds(user.id)
    if (!programIds.length) return NextResponse.json({ session: null })

    const now = new Date()
    const session = await db.lectureSession.findFirst({
      where: {
        series: { programId: { in: programIds } },
        endsAt: { gte: now },
        status: { notIn: ['CANCELLED', 'RESCHEDULED'] },
      },
      include: LECTURE_SESSION_INCLUDE,
      orderBy: { startsAt: 'asc' },
    })
    return NextResponse.json({ session: session ? toPublicSession(session, now) : null })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تحميل المحاضرة القادمة' }, { status: 500 })
  }
}
