import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

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
