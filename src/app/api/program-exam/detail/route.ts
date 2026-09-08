import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

// GET /api/program-exam/detail?examId=xxx — امتحان الفصل للمسجلين المفعّلين فقط
// 12.2: الأسئلة المعتمدة من الإدارة فقط (PUBLISHED) + امتحان الفصل الثاني يتطلب اجتياز الفصل الأول
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const examId = req.nextUrl.searchParams.get('examId')
    if (!examId) return NextResponse.json({ error: 'معرف الاختبار مطلوب' }, { status: 400 })

    const exam = await db.programExam.findUnique({
      where: { id: examId },
      include: {
        program: { select: { id: true, titleAr: true, slug: true, category: true } },
        questions: { where: { status: 'PUBLISHED' }, orderBy: { order: 'asc' } },
      },
    })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود' }, { status: 404 })
    if (exam.status !== 'READY') {
      const note =
        exam.status === 'REVIEW'
          ? 'الاختبار مولّد ويقرأه المشرف الذكي — بانتظار مراجعة الإدارة واعتماد الأسئلة قبل نشره لك'
          : exam.status === 'GENERATING'
          ? 'الاختبار غير متاح بعد — خبير الذكاء الاصطناعي ما زال يقرأ الكتب ويولّد الأسئلة'
          : 'الاختبار غير متاح حالياً'
      return NextResponse.json({ error: note }, { status: 400 })
    }

    const enrollment = await db.enrollment.findUnique({
      where: { userId_programId: { userId: user.id, programId: exam.programId } },
    })
    if (!enrollment) return NextResponse.json({ error: 'يجب التسجيل في البرنامج أولاً' }, { status: 403 })
    if (enrollment.status === 'PENDING_PAYMENT') {
      return NextResponse.json(
        { error: 'تسجيلك بانتظار سداد الفاتورة — أكمل الدفع لفتح الاختبارات', code: 'PENDING_PAYMENT' },
        { status: 402 }
      )
    }

    // 12.2: الامتحانان متسلسلان وفق آلة الحالات — اجتياز امتحان الفصل الأول شرط لفتح الفصل الثاني
    if (exam.semester === 2) {
      const sem1 = await db.programExam.findFirst({
        where: { programId: exam.programId, semester: 1, status: 'READY' },
        include: { _count: { select: { questions: true } } },
      })
      if (sem1 && sem1._count.questions > 0) {
        const passedSem1 = await db.programExamAttempt.findFirst({
          where: { userId: user.id, examId: sem1.id, passed: true, appealStatus: { not: 'PENDING' } },
        })
        if (!passedSem1) {
          return NextResponse.json(
            { error: 'يجب اجتياز امتحان الفصل الدراسي الأول أولاً قبل فتح امتحان الفصل الثاني', code: 'SEM1_REQUIRED' },
            { status: 403 }
          )
        }
      }
    }

    const books = await db.book.findMany({
      where: { programId: exam.programId, OR: [{ semester: null }, { semester: exam.semester }] },
      select: { id: true, title: true, author: true },
      orderBy: { createdAt: 'asc' },
    })

    const previousAttempts = await db.programExamAttempt.findMany({
      where: { userId: user.id, examId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, score: true, finalScore: true, passed: true, durationUsedMin: true, submittedAt: true,
        appealStatus: true, appealResponse: true,
      },
      take: 10,
    })

    return NextResponse.json({
      exam: {
        id: exam.id,
        title: exam.title,
        semester: exam.semester,
        passScore: exam.passScore,
        durationMin: exam.durationMin,
        totalPoints: exam.totalPoints,
        programId: exam.program.id,
        programTitle: exam.program.titleAr,
        programCategory: exam.program.category,
        booksCount: books.length,
        books: books.map((b) => ({ id: b.id, title: b.title, author: b.author })),
      },
      questions: exam.questions.map((q) => ({
        id: q.id,
        order: q.order,
        type: q.type,
        text: q.text,
        options: q.options ? JSON.parse(q.options) : null,
        points: q.points,
      })),
      previousAttempts,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('program-exam detail error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الاختبار' }, { status: 500 })
  }
}
