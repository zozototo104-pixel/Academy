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
    if (exam.status !== 'READY') return NextResponse.json({ error: 'اختبار الوحدة غير منشور لأنه يحتوي أسئلة تحتاج مراجعة.' }, { status: 403 })

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
    const totalQuestionPoints = questions.reduce((sum, question) => sum + Math.max(0, Number(question.points || 0)), 0)
    if (!questions.length || totalQuestionPoints <= 0) {
      return NextResponse.json({ error: 'الاختبار لا يحتوي أسئلة منشورة صالحة بعد', code: 'EXAM_HAS_NO_QUESTIONS' }, { status: 409 })
    }

    // بداية رسمية من الخادم. قفل صف الطالب يمنع طلبين متزامنين من إنشاء محاولتين نشطتين.
    // لا نحتسب الوقت القادم من المتصفح؛ createdAt محفوظ من قاعدة البيانات.
    const attemptState = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`
      const passedAttempt = await tx.examAttempt.findFirst({
        where: { userId: user.id, examId, status: 'GRADED', passed: true },
        select: { id: true },
      })
      if (passedAttempt) return { blocked: true as const, reason: 'PASSED_ALREADY' as const }
      const grading = await tx.examAttempt.findFirst({
        where: { userId: user.id, examId, status: 'SUBMITTED' },
        select: { id: true },
      })
      if (grading) return { blocked: true as const, reason: 'SUBMITTED' as const }
      const existing = await tx.examAttempt.findFirst({
        where: { userId: user.id, examId, status: 'STARTED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true },
      })
      const attempt = existing ?? await tx.examAttempt.create({
        data: { userId: user.id, examId, status: 'STARTED' },
        select: { id: true, createdAt: true },
      })
      return { blocked: false as const, attempt }
    })
    if (attemptState.blocked) {
      return NextResponse.json(
        { error: attemptState.reason === 'PASSED_ALREADY' ? 'لقد اجتزت هذا الاختبار بالفعل ولا يمكن بدء محاولة جديدة.' : 'هذه المحاولة قيد التصحيح بالفعل', code: attemptState.reason },
        { status: 409 }
      )
    }

    // المحاولات السابقة: لا نعرض محاولة جارية كأنها نتيجة سابقة.
    const attempts = await db.examAttempt.findMany({
      where: { userId: user.id, examId, status: { notIn: ['STARTED', 'SUBMITTED'] } },
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
        status: a.status,
        statusLabel: a.status === 'NEEDS_REVIEW' ? 'قيد التصحيح' : a.status,
        score: a.status === 'NEEDS_REVIEW' ? null : a.score,
        passed: a.status === 'NEEDS_REVIEW' ? null : a.passed,
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
