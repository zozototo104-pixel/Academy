import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { calculateSemesterReadiness } from '@/lib/semester-readiness'
import { enforceSemesterTuitionGate } from '@/lib/tuition-installments'
import { EXAM_ATTEMPT_POLICY_SINCE, getExamMaxAttempts } from '@/lib/exam-attempt-policy'

const COMPLETED_PROGRAM_ATTEMPT_STATUSES = ['GRADED', 'EXPIRED', 'NEEDS_REVIEW']

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
    const publishedPoints = exam.questions.reduce((sum, question) => sum + Math.max(0, Number(question.points || 0)), 0)
    if (!exam.questions.length || publishedPoints <= 0) {
      return NextResponse.json({ error: 'الاختبار لا يحتوي أسئلة منشورة صالحة بعد', code: 'EXAM_HAS_NO_QUESTIONS' }, { status: 409 })
    }

    const enrollment = await db.enrollment.findUnique({
      where: { userId_programId: { userId: user.id, programId: exam.programId } },
    })
    if (!enrollment) return NextResponse.json({ error: 'يجب التسجيل في البرنامج أولاً' }, { status: 403 })
    if (!['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
      return NextResponse.json(
        { error: 'تسجيلك غير مفعّل — افتح بوابة الدفعات لاستكمال السداد أو اعتماد الإعفاء', code: 'ENROLLMENT_NOT_ACTIVE' },
        { status: 403 }
      )
    }

    const tuitionGate = await enforceSemesterTuitionGate(user.id, exam.programId, exam.semester)
    if (!tuitionGate.ok) {
      return NextResponse.json({ error: tuitionGate.error, code: tuitionGate.code, tuitionPlan: tuitionGate.plan }, { status: 402 })
    }

    // 12.2: الامتحانان متسلسلان وفق آلة الحالات — اجتياز امتحان الفصل الأول شرط لفتح الفصل الثاني
    if (exam.semester === 2) {
      const sem1 = await db.programExam.findFirst({
        where: { programId: exam.programId, semester: 1, status: 'READY' },
        include: { _count: { select: { questions: true } } },
      })
      if (sem1 && sem1._count.questions > 0) {
        const passedSem1 = await db.programExamAttempt.findFirst({
          where: { userId: user.id, examId: sem1.id, passed: true, OR: [{ appealStatus: null }, { appealStatus: { not: 'PENDING' } }] },
        })
        if (!passedSem1) {
          return NextResponse.json(
            { error: 'يجب اجتياز امتحان الفصل الدراسي الأول أولاً قبل فتح امتحان الفصل الثاني', code: 'SEM1_REQUIRED' },
            { status: 403 }
          )
        }
      }
    }

    const readiness = await calculateSemesterReadiness(user.id, exam.programId, exam.semester)
    if (!readiness.readyMarked) {
      return NextResponse.json(
        { error: 'اضغط أولاً زر «جاهز للامتحان» من بوابة الطالب لتأكيد اطلاعك على حالة الاختبارات والواجبات الفصلية.', code: 'EXAM_NOT_READY_MARKED', readiness },
        { status: 403 }
      )
    }

    const [passedAttempt, submittedAttempt, activeAttempt] = await Promise.all([
      db.programExamAttempt.findFirst({
        where: { userId: user.id, examId, passed: true, OR: [{ appealStatus: null }, { appealStatus: { not: 'PENDING' } }] },
        select: { id: true },
      }),
      db.programExamAttempt.findFirst({
        where: { userId: user.id, examId, status: 'SUBMITTED' },
        select: { id: true },
      }),
      db.programExamAttempt.findFirst({
        where: { userId: user.id, examId, status: 'STARTED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, startedAt: true, createdAt: true },
      }),
    ])
    if (passedAttempt) return NextResponse.json({ error: 'لقد اجتزت هذا الاختبار سابقاً، لا يمكن بدء محاولة جديدة', code: 'ALREADY_PASSED' }, { status: 403 })
    if (submittedAttempt) return NextResponse.json({ error: 'هذه المحاولة قيد التصحيح', code: 'SUBMITTED' }, { status: 409 })
    let currentActiveAttempt = activeAttempt
    const activeStartedAt = activeAttempt?.startedAt || activeAttempt?.createdAt || null
    if (activeAttempt && activeStartedAt && activeStartedAt.getTime() + (exam.durationMin + 2) * 60 * 1000 < Date.now()) {
      await db.programExamAttempt.updateMany({
        where: { id: activeAttempt.id, userId: user.id, examId, status: 'STARTED' },
        data: { status: 'EXPIRED', score: 0, finalScore: 0, passed: false, durationUsedMin: exam.durationMin + 2, submittedAt: new Date() },
      })
      currentActiveAttempt = null
    }

    const [books, previousAttempts, maxAttempts, completedAttempts] = await Promise.all([
      db.book.findMany({
        where: { programId: exam.programId, OR: [{ semester: null }, { semester: exam.semester }] },
        select: { id: true, title: true, author: true },
        orderBy: { createdAt: 'asc' },
      }),
      db.programExamAttempt.findMany({
        where: { userId: user.id, examId, status: { not: 'STARTED' } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, status: true, score: true, finalScore: true, passed: true, durationUsedMin: true, submittedAt: true,
          appealStatus: true, appealResponse: true,
        },
        take: 10,
      }),
      getExamMaxAttempts('PROGRAM'),
      db.programExamAttempt.count({
        where: { userId: user.id, examId, status: { in: COMPLETED_PROGRAM_ATTEMPT_STATUSES }, createdAt: { gte: EXAM_ATTEMPT_POLICY_SINCE } },
      }),
    ])

    return NextResponse.json({
      serverNow: new Date().toISOString(),
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
        readiness,
        maxAttempts,
        attemptsUsed: completedAttempts,
        hasActiveAttempt: !!activeAttempt,
      },
      questions: exam.questions.map((q) => ({
        id: q.id,
        order: q.order,
        type: q.type,
        text: q.text,
        options: q.options ? JSON.parse(q.options) : null,
        points: q.points,
      })),
      previousAttempts: previousAttempts.map((attempt) => ({
        ...attempt,
        score: attempt.status === 'NEEDS_REVIEW' ? null : attempt.score,
        finalScore: attempt.status === 'NEEDS_REVIEW' ? null : attempt.finalScore,
        passed: attempt.status === 'NEEDS_REVIEW' ? null : attempt.passed,
        statusLabel: attempt.status === 'NEEDS_REVIEW' ? 'قيد التصحيح' : attempt.status === 'EXPIRED' ? 'انتهى الوقت دون تسليم' : attempt.status,
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('program-exam detail error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الاختبار' }, { status: 500 })
  }
}
