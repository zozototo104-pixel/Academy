import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

// GET /api/exam/detail?examId=xxx — أسئلة الاختبار (بدون الإجابات الصحيحة)
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const examId = req.nextUrl.searchParams.get('examId')
    if (!examId) return NextResponse.json({ error: 'معرف الاختبار مطلوب' }, { status: 400 })

    const exam = await db.exam.findUnique({
      where: { id: examId },
      include: {
        unit: {
          include: {
            program: { select: { id: true, titleAr: true } },
          },
        },
      },
    })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود' }, { status: 404 })

    const enrollment = await db.enrollment.findUnique({
      where: { userId_programId: { userId: user.id, programId: exam.unit.programId } },
    })
    if (!enrollment) return NextResponse.json({ error: 'يجب التسجيل في البرنامج أولاً' }, { status: 403 })
    if (enrollment.status === 'PENDING_PAYMENT') {
      return NextResponse.json(
        { error: 'تسجيلك بانتظار سداد الفاتورة — أكمل الدفع لتفعيل الوصول للاختبارات', code: 'PENDING_PAYMENT' },
        { status: 402 }
      )
    }

    const questions = await db.question.findMany({
      where: { examId },
      orderBy: { order: 'asc' },
    })

    // المحاولات السابقة
    const attempts = await db.examAttempt.findMany({
      where: { userId: user.id, examId },
      orderBy: { submittedAt: 'desc' },
      take: 5,
    })

    return NextResponse.json({
      exam: {
        id: exam.id,
        title: exam.title,
        passScore: exam.passScore,
        unitTitle: exam.unit.title,
        programId: exam.unit.programId,
        programTitle: exam.unit.program.titleAr,
        totalPoints: questions.reduce((s, q) => s + q.points, 0),
      },
      questions: questions.map((q) => ({
        id: q.id,
        order: q.order,
        type: q.type,
        text: q.text,
        options: q.options ? JSON.parse(q.options) : null,
        points: q.points,
      })),
      previousAttempts: attempts.map((a) => ({
        id: a.id,
        score: a.score,
        passed: a.passed,
        submittedAt: a.submittedAt,
        feedback: a.feedback ? JSON.parse(a.feedback) : null,
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('Exam detail error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الاختبار' }, { status: 500 })
  }
}
