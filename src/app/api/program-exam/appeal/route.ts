import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin, requireUser } from '@/lib/auth'
import { completeEnrollmentIfEligible } from '@/lib/enrollment-completion'

// ===== 12.2 الاعتراض على نتيجة الامتحان (Appeal) — يُحوَّل للمراجعة اليدوية =====

// POST /api/program-exam/appeal — الطالب يقدم اعتراضاً على نتيجته
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const { attemptId, reason } = await req.json()
    if (!attemptId || !reason?.trim()) {
      return NextResponse.json({ error: 'اكتب سبب الاعتراض بوضوح ليقيمه المشرف البشري' }, { status: 400 })
    }

    const attempt = await db.programExamAttempt.findUnique({
      where: { id: attemptId },
      include: { exam: { select: { title: true } } },
    })
    if (!attempt || attempt.userId !== user.id) {
      return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
    }
    if (attempt.status !== 'GRADED') {
      return NextResponse.json({ error: 'لا يمكن تقديم اعتراض إلا على محاولة مصححة ومعتمدة', code: 'APPEAL_REQUIRES_GRADED_ATTEMPT' }, { status: 409 })
    }
    if (attempt.appealStatus === 'PENDING') {
      return NextResponse.json({ error: 'اعتراضك قيد المراجعة بالفعل' }, { status: 409 })
    }
    if (attempt.appealStatus === 'REVIEWED') {
      return NextResponse.json({ error: 'تمت مراجعة اعتراضك مسبقاً — اطّلع على الرد' }, { status: 409 })
    }

    await db.programExamAttempt.update({
      where: { id: attemptId },
      data: {
        appealStatus: 'PENDING',
        appealReason: String(reason).trim().slice(0, 2000),
        appealedAt: new Date(),
      },
    })

    // إشعار المشرفين والإدارة بوجود اعتراض يحتاج مراجعة يدوية
    const reviewers = await db.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPERVISOR'] } },
      select: { id: true },
    })
    for (const r of reviewers) {
      await db.notification.create({
        data: {
          userId: r.id,
          type: 'GENERAL',
          title: 'اعتراض جديد على نتيجة امتحان',
          body: `الطالب ${user.name} اعترض على نتيجته في «${attempt.exam.title}» — يتطلب المراجعة اليدوية من المشرف/الإدارة.`,
          link: 'admin',
        },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    console.error('appeal POST error:', e)
    return NextResponse.json({ error: 'تعذر تقديم الاعتراض' }, { status: 500 })
  }
}

// GET /api/program-exam/appeal?attemptId=xxx — حالة الاعتراض
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const attemptId = req.nextUrl.searchParams.get('attemptId')
    if (!attemptId) return NextResponse.json({ error: 'معرف المحاولة مطلوب' }, { status: 400 })
    const attempt = await db.programExamAttempt.findUnique({
      where: { id: attemptId },
      select: {
        id: true, userId: true, score: true, finalScore: true, passed: true,
        appealStatus: true, appealReason: true, appealResponse: true, appealedAt: true,
      },
    })
    if (!attempt || attempt.userId !== user.id) return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
    return NextResponse.json({ appeal: attempt })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    return NextResponse.json({ error: 'خطأ في تحميل حالة الاعتراض' }, { status: 500 })
  }
}

// PATCH /api/program-exam/appeal — قرار الإدارة على الاعتراض
export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const attemptId = String(body?.attemptId || '').trim()
    const action = String(body?.action || '').trim().toUpperCase()
    const response = String(body?.response || body?.appealResponse || '').trim().slice(0, 2000)
    const finalScoreInput = body?.finalScore
    if (!attemptId) return NextResponse.json({ error: 'معرف المحاولة مطلوب' }, { status: 400 })
    if (!['APPROVE', 'ACCEPT', 'REJECT'].includes(action)) return NextResponse.json({ error: 'قرار الاعتراض غير صالح' }, { status: 400 })

    const attempt = await db.programExamAttempt.findUnique({
      where: { id: attemptId },
      select: { id: true, userId: true, status: true, appealStatus: true, score: true, finalScore: true, exam: { select: { passScore: true, programId: true } } },
    })
    if (!attempt) return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
    if (attempt.status !== 'GRADED') return NextResponse.json({ error: 'لا يمكن البت في اعتراض إلا على محاولة مصححة', code: 'APPEAL_REQUIRES_GRADED_ATTEMPT' }, { status: 409 })
    if (attempt.appealStatus !== 'PENDING') return NextResponse.json({ error: 'لا يوجد اعتراض قيد المراجعة لهذه المحاولة' }, { status: 409 })

    let completion: Awaited<ReturnType<typeof completeEnrollmentIfEligible>> | null = null
    if (action === 'APPROVE' || action === 'ACCEPT') {
      const finalScore = Number(finalScoreInput)
      if (!Number.isFinite(finalScore)) return NextResponse.json({ error: 'اعتماد الاعتراض يحتاج درجة نهائية رقمية' }, { status: 400 })
      const clamped = Math.max(0, Math.min(100, Math.round(finalScore * 10) / 10))
      const passed = clamped >= attempt.exam.passScore
      await db.programExamAttempt.update({
        where: { id: attempt.id },
        data: { finalScore: clamped, passed, appealStatus: 'REVIEWED', appealResponse: response || 'تم قبول الاعتراض واعتماد الدرجة النهائية بعد المراجعة.' },
      })
      if (passed) {
        const enrollment = await db.enrollment.findUnique({ where: { userId_programId: { userId: attempt.userId, programId: attempt.exam.programId } }, select: { id: true } })
        completion = enrollment ? await completeEnrollmentIfEligible({ enrollmentId: enrollment.id }) : null
      }
      return NextResponse.json({ ok: true, finalScore: clamped, passed, certificateNo: completion?.ok ? completion.certificate?.serial || null : null })
    }

    await db.programExamAttempt.update({
      where: { id: attempt.id },
      data: { appealStatus: 'REVIEWED', appealResponse: response || 'تم رفض الاعتراض بعد المراجعة.' },
    })
    return NextResponse.json({ ok: true, finalScore: attempt.finalScore ?? attempt.score, passed: attempt.score != null ? attempt.score >= attempt.exam.passScore : attempt.finalScore != null ? attempt.finalScore >= attempt.exam.passScore : null })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('appeal PATCH error:', e)
    return NextResponse.json({ error: 'تعذر اعتماد قرار الاعتراض' }, { status: 500 })
  }
}
