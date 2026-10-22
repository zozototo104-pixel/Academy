import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { checkDatabaseRateLimit } from '@/lib/rate-limit'
import { canStudentAccessProgram } from '@/lib/lectures/access'
import { isJoinWindowOpen, joinOpensAt } from '@/lib/lectures/student'

// POST /api/my/lectures/[sessionId]/join — يكشف رابط الاجتماع فقط داخل
// النافذة المسموحة (من 15 دقيقة قبل البداية حتى نهاية المحاضرة)، ويسجّل
// محاولة الدخول بحالة JOINED فقط؛ تأكيد الحضور PRESENT صلاحية المشرف.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  try {
    const user = await requireUser()
    const { sessionId } = await params

    const limit = await checkDatabaseRateLimit(`lectures:join:${user.id}:${sessionId}`, 10, 10 * 60 * 1000)
    if (!limit.ok) {
      return NextResponse.json(
        { error: 'محاولات كثيرة، انتظر قليلًا ثم أعد المحاولة' },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } },
      )
    }

    const session = await db.lectureSession.findUnique({
      where: { id: sessionId },
      include: { series: { select: { programId: true } } },
    })
    if (!session) return NextResponse.json({ error: 'المحاضرة غير موجودة' }, { status: 404 })
    if (!(await canStudentAccessProgram(user.id, session.series.programId))) {
      return NextResponse.json({ error: 'المحاضرة غير موجودة' }, { status: 404 })
    }
    if (session.deliveryMode !== 'EXTERNAL_LINK' || !session.meetingUrl) {
      return NextResponse.json({ error: 'لا يوجد رابط اجتماع لهذه المحاضرة' }, { status: 400 })
    }
    if (!isJoinWindowOpen(session)) {
      return NextResponse.json(
        {
          error: 'رابط الانضمام يظهر قبل بدء المحاضرة بـ 15 دقيقة ويبقى متاحًا حتى نهايتها',
          joinOpensAt: joinOpensAt(session).toISOString(),
        },
        { status: 403 },
      )
    }

    // تسجيل محاولة الدخول دون المساس بأي تأكيد حضور سابق من المشرف.
    await db.lectureAttendance.upsert({
      where: { sessionId_userId: { sessionId, userId: user.id } },
      create: { sessionId, userId: user.id, status: 'JOINED' },
      update: {},
    })

    return NextResponse.json({
      meetingUrl: session.meetingUrl,
      meetingPasscode: session.meetingPasscode,
      provider: session.provider,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في الانضمام إلى المحاضرة' }, { status: 500 })
  }
}
