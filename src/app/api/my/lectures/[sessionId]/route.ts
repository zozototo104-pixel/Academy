import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { LECTURE_SESSION_INCLUDE, canStudentAccessProgram } from '@/lib/lectures/access'
import { toPublicSession } from '@/lib/lectures/student'

// GET /api/my/lectures/[sessionId] — تفاصيل محاضرة واحدة دون كشف أي أسرار.
// غياب التسجيل النشط يُعامل كعدم وجود حتى لا يتسرب وجود المحاضرة.
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
    return NextResponse.json({ session: toPublicSession(session) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تحميل المحاضرة' }, { status: 500 })
  }
}
