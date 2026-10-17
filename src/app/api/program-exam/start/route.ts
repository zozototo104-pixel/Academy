import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { calculateSemesterReadiness } from '@/lib/semester-readiness'
import { enforceSemesterTuitionGate } from '@/lib/tuition-installments'
import { EXAM_ATTEMPT_POLICY_SINCE, getExamMaxAttempts } from '@/lib/exam-attempt-policy'

const COMPLETED_PROGRAM_ATTEMPT_STATUSES = ['GRADED', 'EXPIRED', 'NEEDS_REVIEW']

// POST /api/program-exam/start — يبدأ أو يستعيد محاولة STARTED بعد ضغط الطالب زر البدء
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const body = await req.json().catch(() => null)
    const examId = String(body?.examId || '').trim()
    if (!examId) return NextResponse.json({ error: 'معرف الاختبار مطلوب' }, { status: 400 })

    const exam = await db.programExam.findUnique({
      where: { id: examId },
      include: {
        program: { select: { id: true, titleAr: true, slug: true, category: true } },
        questions: { where: { status: 'PUBLISHED' }, select: { id: true, points: true }, orderBy: { order: 'asc' } },
      },
    })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود' }, { status: 404 })
    if (exam.status !== 'READY') return NextResponse.json({ error: 'الاختبار غير متاح حالياً' }, { status: 400 })
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

    const now = new Date()
    const allowedMs = (exam.durationMin + 2) * 60 * 1000
    const startState = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`
      const maxAttempts = await getExamMaxAttempts('PROGRAM', tx)
      const completedAttempts = await tx.programExamAttempt.count({
        where: { userId: user.id, examId, status: { in: COMPLETED_PROGRAM_ATTEMPT_STATUSES } },
      })
      if (completedAttempts >= maxAttempts) {
        return { blocked: 'MAX_ATTEMPTS' as const, attempt: null, maxAttempts, completedAttempts }
      }

      let startedAttempt = await tx.programExamAttempt.findFirst({
        where: { userId: user.id, examId, status: 'STARTED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, startedAt: true, createdAt: true },
      })
      if (startedAttempt) {
        const effectiveStartedAt = startedAttempt.startedAt || startedAttempt.createdAt
        if (!startedAttempt.startedAt) {
          startedAttempt = await tx.programExamAttempt.update({ where: { id: startedAttempt.id }, data: { startedAt: effectiveStartedAt }, select: { id: true, startedAt: true, createdAt: true } })
        }
        if (effectiveStartedAt.getTime() + allowedMs < now.getTime()) {
          const expired = await tx.programExamAttempt.updateMany({
            where: { id: startedAttempt.id, status: 'STARTED' },
            data: { status: 'EXPIRED', score: 0, finalScore: 0, passed: false, durationUsedMin: exam.durationMin + 2, submittedAt: now },
          })
          if (expired.count !== 1) return { blocked: 'GRADING' as const, attempt: null, maxAttempts, completedAttempts }
          return { blocked: 'EXPIRED' as const, attempt: null, maxAttempts, completedAttempts: completedAttempts + 1 }
        }
      }
      if (!startedAttempt) {
        const submitted = await tx.programExamAttempt.findFirst({
          where: { userId: user.id, examId, status: 'SUBMITTED' }, select: { id: true },
        })
        if (submitted) return { blocked: 'GRADING' as const, attempt: null, maxAttempts, completedAttempts }
        const passedAttempt = await tx.programExamAttempt.findFirst({
          where: { userId: user.id, examId, passed: true, OR: [{ appealStatus: null }, { appealStatus: { not: 'PENDING' } }] },
          select: { id: true },
        })
        if (passedAttempt) return { blocked: 'PASSED' as const, attempt: null, maxAttempts, completedAttempts }
        startedAttempt = await tx.programExamAttempt.create({
          data: { userId: user.id, examId, status: 'STARTED', startedAt: now },
          select: { id: true, startedAt: true, createdAt: true },
        })
      }
      return { blocked: null, attempt: startedAttempt, maxAttempts, completedAttempts }
    })

    if (startState.blocked === 'MAX_ATTEMPTS') {
      return NextResponse.json({ error: 'استنفدت عدد محاولات هذا الاختبار', code: 'MAX_ATTEMPTS_REACHED', maxAttempts: startState.maxAttempts, attemptsUsed: startState.completedAttempts }, { status: 403 })
    }
    if (startState.blocked === 'GRADING') return NextResponse.json({ error: 'هذه المحاولة قيد التصحيح', code: 'SUBMITTED' }, { status: 409 })
    if (startState.blocked === 'EXPIRED') return NextResponse.json({ error: 'انتهت المحاولة وحُسبت صفر', code: 'ATTEMPT_EXPIRED', maxAttempts: startState.maxAttempts, attemptsUsed: startState.completedAttempts }, { status: 409 })
    if (startState.blocked === 'PASSED') return NextResponse.json({ error: 'لقد اجتزت هذا الاختبار سابقاً، لا يمكن بدء محاولة جديدة', code: 'ALREADY_PASSED' }, { status: 403 })
    if (!startState.attempt) return NextResponse.json({ error: 'تعذر بدء الاختبار' }, { status: 409 })

    return NextResponse.json({
      ok: true,
      attempt: {
        id: startState.attempt.id,
        startedAt: startState.attempt.startedAt || startState.attempt.createdAt,
      },
      durationMin: exam.durationMin,
      serverNow: new Date().toISOString(),
      maxAttempts: startState.maxAttempts,
      attemptsUsed: startState.completedAttempts,
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('program-exam start error:', e)
    return NextResponse.json({ error: 'خطأ في بدء الاختبار' }, { status: 500 })
  }
}
