import { NextRequest, NextResponse } from 'next/server'
import { createHmac } from 'node:crypto'
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
      include: { series: { select: { programId: true, unitId: true } } },
    })
    if (!session) return NextResponse.json({ error: 'المحاضرة غير موجودة' }, { status: 404 })
    if (!(await canStudentAccessProgram(user.id, session.series.programId))) {
      return NextResponse.json({ error: 'المحاضرة غير موجودة' }, { status: 404 })
    }
    // بوابة الانتقال (المرحلة 5): محاضرة مربوطة بوحدة من فصل ٢+ لا
    // تُفتح قبل نجاح الفصول السابقة بنتائج معتمدة (نفس حجب المحتوى).
    if ((session.series as any).unitId) {
      const unit = await db.unit.findUnique({
        where: { id: (session.series as any).unitId },
        select: { semester: true, program: { select: { category: true } } },
      })
      if (!unit) {
        return NextResponse.json({ error: 'تعذر التحقق من الفصل المرتبط بالمحاضرة', code: 'UNIT_SCOPE_UNAVAILABLE' }, { status: 503 })
      }
      const unitSemester = Number((unit as any)?.semester || 1)
      if (unitSemester > 1) {
        const enrollment = await db.enrollment.findUnique({
          where: { userId_programId: { userId: user.id, programId: session.series.programId } },
          select: { id: true },
        }).catch(() => null)
        if (enrollment) {
          const { progressionGate } = await import('@/lib/progression')
          const gate = await progressionGate(
            db as any,
            { id: enrollment.id, userId: user.id, programId: session.series.programId },
            unitSemester,
            (unit as any)?.program?.category,
          ).catch(() => null)
          if (gate && !gate.open) {
            return NextResponse.json({ error: 'هذه المحاضرة من فصل غير مفتوح بعد — يُفتح بعد اعتماد نجاح الفصل السابق', code: 'PROGRESSION_LOCKED' }, { status: 403 })
          }
        }
      }
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

    // The student was authenticated and authorized above; no invitation token is required.
    // The Zoom SDK secret remains server-side.
    let zoomSdk: Record<string, string> | undefined
    if (session.provider === 'ZOOM') {
      const match = String(session.meetingUrl).match(/^https:\/\/[a-z0-9.-]*zoom\.us\/j\/(\d{9,11})(?:[/?#]|$)/i)
      const sdkKey = process.env.ZOOM_MEETING_SDK_CLIENT_ID
      const sdkSecret = process.env.ZOOM_MEETING_SDK_CLIENT_SECRET
      if (match && sdkKey && sdkSecret) {
        const now = Math.floor(Date.now() / 1000)
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
        const unsigned = encode({ alg: 'HS256', typ: 'JWT' }) + '.' + encode({
          sdkKey, appKey: sdkKey, mn: match[1], role: 0,
          iat: now - 30, exp: now + 3600, tokenExp: now + 3600,
        })
        const signature = createHmac('sha256', sdkSecret).update(unsigned).digest('base64url')
        zoomSdk = {
          signature: unsigned + '.' + signature,
          sdkKey,
          meetingNumber: match[1],
          userName: user.name || 'طالب الأكاديمية',
          password: session.meetingPasscode || '',
        }
      }
    }
    return NextResponse.json({
      meetingUrl: session.meetingUrl,
      meetingPasscode: session.meetingPasscode,
      provider: session.provider,
      ...(zoomSdk ? { zoomSdk } : {}),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في الانضمام إلى المحاضرة' }, { status: 500 })
  }
}
