import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { calculateSemesterReadiness } from '@/lib/semester-readiness'
import { progressionGate } from '@/lib/progression'
import { enforceSemesterTuitionGate } from '@/lib/tuition-installments'
import { EXAM_ATTEMPT_POLICY_SINCE, getExamMaxAttempts } from '@/lib/exam-attempt-policy'
import { submissionWindowCheck, windowContextFor } from '@/lib/semester-lifecycle'
import { notifyAttemptNeedsReview } from '@/lib/exam-attempt-notifications'

const COMPLETED_PROGRAM_ATTEMPT_STATUSES = ['GRADED', 'EXPIRED', 'NEEDS_REVIEW']
const STALE_SUBMITTED_REVIEW_MS = 2 * 60 * 60 * 1000 // Above the worst expected bounded essay grading window

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

    // دورة حياة الفصل (المرحلة 4): محاولة جديدة فقط داخل فترة الفصل —
    // استئناف محاولة بدأت أصلًا ليس محاولة جديدة.
    const hasStarted = await db.programExamAttempt.findFirst({
      where: { userId: user.id, examId, status: 'STARTED' },
      select: { id: true },
    })
    if (!hasStarted) {
      const ctx = await windowContextFor(db, user.id, exam.programId)
      if (ctx) {
        const verdict = await submissionWindowCheck(db, {
          enrollment: ctx.enrollment,
          program: ctx.program,
          semester: exam.semester,
        })
        if (!verdict.ok) return NextResponse.json({ error: verdict.message, code: verdict.code }, { status: 403 })
      }
    }

    if (exam.semester >= 2 && !(await hasPassedFirstSemesterExam(user.id, exam.programId))) {
      return NextResponse.json(
        { error: 'يجب اجتياز امتحان الفصل الدراسي الأول قبل فتح امتحان الفصل الثاني', code: 'SEM1_REQUIRED' },
        { status: 403 },
      )
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
        where: { userId: user.id, examId, status: { in: COMPLETED_PROGRAM_ATTEMPT_STATUSES }, createdAt: { gte: EXAM_ATTEMPT_POLICY_SINCE } },
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
          where: { userId: user.id, examId, status: 'SUBMITTED' },
          select: { id: true, submittedAt: true },
          orderBy: { createdAt: 'desc' },
        })
        if (submitted) {
          // Only claims with a trustworthy submittedAt timestamp can be recovered
          // automatically. Legacy claims with no timestamp require manual inspection.
          const staleBefore = new Date(now.getTime() - STALE_SUBMITTED_REVIEW_MS)
          if (submitted.submittedAt && submitted.submittedAt <= staleBefore) {
            const recovered = await tx.programExamAttempt.updateMany({
              where: { id: submitted.id, status: 'SUBMITTED', submittedAt: { lte: staleBefore } },
              data: {
                status: 'NEEDS_REVIEW',
                score: null,
                finalScore: null,
                passed: null,
                feedback: JSON.stringify({ code: 'STALE_GRADING_RECOVERED', summary: 'التصحيح تأخر؛ تم تحويل الإجابات المحفوظة للمراجعة اليدوية.' }),
              },
            })
            if (recovered.count === 1) return { blocked: 'REVIEW' as const, attempt: null, maxAttempts, completedAttempts: completedAttempts + 1 }
          }
          return { blocked: 'GRADING' as const, attempt: null, maxAttempts, completedAttempts }
        }
        const pendingReview = await tx.programExamAttempt.findFirst({
          where: { userId: user.id, examId, status: 'NEEDS_REVIEW' },
          select: { id: true },
        })
        if (pendingReview) return { blocked: 'REVIEW_PENDING' as const, attempt: null, maxAttempts, completedAttempts }
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
    if (startState.blocked === 'REVIEW') {
      // هذا الحظر يعني تحديدًا أن محاولة عالقة حُوّلت للتو إلى المراجعة
      // البشرية داخل المعاملة — نُشعر بها كما في مسار التسليم، بدل أن
      // يبقى التحويل صامتًا حتى يفتح أحدهم قائمة المراجعة.
      try {
        await notifyAttemptNeedsReview({ studentId: user.id, studentName: user.name || null, examTitle: exam.title })
      } catch { /* الإشعار لا يعطّل بدء الامتحان أبدًا */ }
      return NextResponse.json({
        error: 'تأخر التصحيح؛ تم نقل إجاباتك المحفوظة للمراجعة البشرية دون احتساب علامة ناقصة.',
        code: 'NEEDS_REVIEW',
      }, { status: 409 })
    }
    if (startState.blocked === 'REVIEW_PENDING') return NextResponse.json({
      error: 'نتيجة محاولتك السابقة بانتظار تأكيد المشرف — لا يمكنك بدء محاولة جديدة حتى تُعتمد النتيجة',
      code: 'NEEDS_REVIEW',
    }, { status: 409 })
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
