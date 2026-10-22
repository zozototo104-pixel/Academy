import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { LECTURE_SESSION_INCLUDE, canStudentAccessProgram } from '@/lib/lectures/access'
import { buildLectureIcs } from '@/lib/lectures/ics'

// GET /api/my/lectures/[sessionId]/ics — ملف تقويم للمحاضرة (دون رابط الاجتماع).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const user = await requireUser()
    const { sessionId } = await params
    const session = await db.lectureSession.findUnique({
      where: { id: sessionId },
      include: LECTURE_SESSION_INCLUDE,
    })
    if (!session) return NextResponse.json({ error: 'المحاضرة غير موجودة' }, { status: 404 })
    if (!(await canStudentAccessProgram(user.id, session.series.programId))) {
      return NextResponse.json({ error: 'المحاضرة غير موجودة' }, { status: 404 })
    }
    const ics = buildLectureIcs({
      sessionId: session.id,
      title: session.title,
      description: session.description,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
    })
    return new Response(ics, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="lecture-${session.id}.ics"`,
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في إنشاء ملف التقويم' }, { status: 500 })
  }
}
