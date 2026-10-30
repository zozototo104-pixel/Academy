import { db } from '@/lib/db'
import { notify } from '@/lib/notify'
import { calculateSemesterReadiness } from '@/lib/semester-readiness'
import { completeEnrollmentIfEligible } from '@/lib/enrollment-completion'
import type { SupervisorActor } from '@/lib/supervisor-scope'

// مراجعة المشرف البشري لنتائج طلابه بعد تصحيح الذكاء + البتّ في
// التماسات المراجعة. النتيجة الأصلية تصل الطالب فور تصحيح الذكاء كما
// هي اليوم — هذه الطبقة لاحقة: المشرف يرى كيف صحّح الذكاء سؤالًا
// سؤالًا (المقالي خاصة)، يعدّل الدرجات، فتتحدث نتيجة الطالب وتُوثَّق
// المراجعة (من راجع ومتى وما الذي تغيّر) داخل المحاولة نفسها.

export type AttemptKind = 'UNIT' | 'PROGRAM'

function clampPoints(value: unknown, max: number): number | null {
  if (value == null || String(value).trim() === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(Math.max(0, max), n))
}

export async function reviewAttemptDetail(type: AttemptKind, id: string) {
  if (type === 'UNIT') {
    const attempt: any = await (db as any).examAttempt.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        exam: { include: { unit: { include: { program: { select: { id: true, titleAr: true } } } } } },
        answers: { include: { question: true }, orderBy: { question: { order: 'asc' } } },
      },
    })
    if (!attempt) return null
    return {
      type,
      id: attempt.id,
      status: attempt.status,
      score: attempt.score,
      finalScore: null as number | null,
      passed: attempt.passed,
      aiGraded: attempt.aiGraded,
      appealStatus: attempt.appealStatus ?? 'NONE',
      appealReason: attempt.appealReason ?? null,
      appealResponse: attempt.appealResponse ?? null,
      reviewedById: attempt.reviewedById ?? null,
      reviewedAt: attempt.reviewedAt ?? null,
      student: attempt.user,
      exam: { id: attempt.exam.id, title: attempt.exam.title, unitTitle: attempt.exam.unit.title, programId: attempt.exam.unit.programId, programTitle: attempt.exam.unit.program.titleAr, passScore: attempt.exam.passScore },
      answers: attempt.answers.map((a: any) => ({
        answerId: a.id,
        questionId: a.questionId,
        order: a.question.order,
        questionType: a.question.type,
        question: a.question.text,
        options: a.question.options,
        correctAnswer: a.question.correctAnswer,
        modelAnswer: a.question.modelAnswer || '',
        rubric: a.question.rubric || null,
        studentAnswer: a.answerText || '',
        selectedOption: a.selectedOption,
        isCorrect: a.isCorrect,
        points: a.points,
        maxPoints: a.maxPoints || a.question.points,
        aiFeedback: a.aiFeedback,
      })),
    }
  }
  const attempt: any = await (db as any).programExamAttempt.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true } },
      exam: { include: { program: { select: { id: true, titleAr: true } } } },
      answers: { include: { question: true }, orderBy: { question: { order: 'asc' } } },
    },
  })
  if (!attempt) return null
  return {
    type,
    id: attempt.id,
    status: attempt.status,
    score: attempt.score,
    finalScore: attempt.finalScore ?? null,
    passed: attempt.passed,
    aiGraded: true,
    appealStatus: attempt.appealStatus ?? 'NONE',
    appealReason: attempt.appealReason ?? null,
    appealResponse: attempt.appealResponse ?? null,
    reviewedById: attempt.reviewedById ?? null,
    reviewedAt: attempt.reviewedAt ?? null,
    student: attempt.user,
    exam: { id: attempt.exam.id, title: attempt.exam.title, unitTitle: null as string | null, programId: attempt.exam.programId, programTitle: attempt.exam.program.titleAr, passScore: attempt.exam.passScore },
    answers: attempt.answers.map((a: any) => ({
      answerId: a.id,
      questionId: a.questionId,
      order: a.question.order,
      questionType: a.question.type,
      question: a.question.text,
      options: a.question.options,
      correctAnswer: a.question.correctAnswer,
      modelAnswer: a.question.modelAnswer || '',
      rubric: a.question.rubric || null,
      studentAnswer: a.answerText || '',
      selectedOption: a.selectedOption,
      isCorrect: a.isCorrect,
      points: a.points,
      maxPoints: a.maxPoints || a.question.points,
      aiFeedback: a.aiFeedback,
    })),
  }
}

async function completeIfEligible(userId: string, programId: string | null | undefined) {
  if (!userId || !programId) return null
  const enrollment = await db.enrollment.findUnique({ where: { userId_programId: { userId, programId } }, select: { id: true } })
  return enrollment ? completeEnrollmentIfEligible({ enrollmentId: enrollment.id }) : null
}

// تعديل درجات إجابات محاولة (GRADED أو NEEDS_REVIEW) وإعادة احتساب
// النتيجة. يعيد الدرجة الجديدة وحالة النجاح. يوثّق التغييرات داخل
// حقل feedback بصيغة JSON ويُشعر الطالب.
export async function applyScoreAdjustments(
  actor: SupervisorActor,
  type: AttemptKind,
  attemptId: string,
  scores: Record<string, unknown>,
): Promise<{ score: number; passed: boolean }> {
  const answerIds = Object.keys(scores || {})
  if (!answerIds.length) throw Object.assign(new Error('NO_SCORES'), { userMessage: 'لا توجد درجات معدّلة' })

  const result = await db.$transaction(async (tx) => {
    const txAny = tx as any
    const attempt: any = type === 'UNIT'
      ? await txAny.examAttempt.findUnique({ where: { id: attemptId }, include: { exam: { include: { questions: true, unit: { select: { programId: true } } } }, answers: { include: { question: { select: { points: true } } } } } })
      : await txAny.programExamAttempt.findUnique({ where: { id: attemptId }, include: { exam: { include: { questions: true } }, answers: { include: { question: { select: { points: true } } } } } })
    if (!attempt) throw Object.assign(new Error('NOT_FOUND'), { userMessage: 'المحاولة غير موجودة' })
    if (!['GRADED', 'NEEDS_REVIEW'].includes(attempt.status)) {
      throw Object.assign(new Error('NOT_REVIEWABLE'), { userMessage: 'هذه المحاولة ليست مصححة بعد' })
    }
    const answerById = new Map<string, any>(attempt.answers.map((a: any) => [a.id, a]))
    for (const answerId of answerIds) {
      if (!answerById.has(answerId)) throw Object.assign(new Error('ANSWER_NOT_IN_ATTEMPT'), { userMessage: 'يوجد إجابة لا تتبع هذه المحاولة' })
    }
    const changes: Array<{ answerId: string; from: number | null; to: number | null }> = []
    for (const [answerId, raw] of Object.entries(scores)) {
      const answer = answerById.get(answerId)
      const points = clampPoints(raw, answer.maxPoints || answer.question?.points || 0)
      changes.push({ answerId, from: answer.points ?? null, to: points })
      const data = { points, isCorrect: points == null ? answer.isCorrect : points > 0 ? answer.isCorrect : false }
      if (type === 'UNIT') await txAny.answer.update({ where: { id: answerId }, data })
      else await txAny.programAnswer.update({ where: { id: answerId }, data })
      answer.points = points
    }

    // المقام هو مجموع نقاط الأسئلة كما دخلت تصحيح هذه المحاولة فعلياً
    // (maxPoints المحفوظة على كل إجابة)، لا مجموع أسئلة الامتحان الحالية:
    // أسئلة الامتحان الفصلي غير المنشورة (مسودة/مرفوضة) لم تُصحَّح أصلاً —
    // التصحيح الأصلي يحمّل المنشورة فقط — وضمّها هنا كان يخفّض نسبة الطالب
    // عند أي تعديل من المشرف حتى لو لم يغيّر أي درجة.
    const maxTotal = attempt.answers.reduce((s: number, a: any) => s + Number(a.maxPoints || a.question?.points || 0), 0)
    const total = attempt.answers.reduce((s: number, a: any) => s + Number(a.points || 0), 0)
    const rawScore = maxTotal > 0 ? (total / maxTotal) * 100 : 0

    const feedback = JSON.stringify({
      summary: 'تمت مراجعة النتيجة وتعديل الدرجات من المشرف البشري.',
      supervisorReview: { by: actor.id, byName: actor.name, at: new Date().toISOString(), changes },
    })

    if (type === 'UNIT') {
      const score = Math.round(rawScore * 10) / 10
      const passed = score >= attempt.exam.passScore
      await txAny.examAttempt.update({
        where: { id: attemptId },
        data: {
          score, passed, status: 'GRADED', feedback,
          reviewedById: actor.id, reviewedAt: new Date(),
          ...(attempt.appealStatus === 'PENDING' ? { appealStatus: 'REVIEWED', appealResponse: 'تمت مراجعة نتيجتك وتعديل الدرجة من مشرفك البشري.' } : {}),
        },
      })
      return { score, passed, userId: attempt.userId, examTitle: attempt.exam.title, programId: attempt.exam.unit?.programId as string | undefined }
    }

    const readiness = await calculateSemesterReadiness(attempt.userId, attempt.exam.programId, attempt.exam.semester)
    const capped = Math.min(rawScore, readiness?.maxExamScore ?? 100)
    const score = Math.round(capped * 10) / 10
    const passed = score >= attempt.exam.passScore
    await txAny.programExamAttempt.update({
      where: { id: attemptId },
      data: {
        score, finalScore: score, passed, status: 'GRADED', feedback,
        reviewedById: actor.id, reviewedAt: new Date(),
        ...(attempt.appealStatus === 'PENDING' ? { appealStatus: 'REVIEWED', appealResponse: 'تمت مراجعة نتيجتك وتعديل الدرجة من مشرفك البشري.' } : {}),
      },
    })
    return { score, passed, userId: attempt.userId, examTitle: attempt.exam.title, programId: attempt.exam.programId as string | undefined }
  }, { timeout: 120000, maxWait: 10000 })

  if (result.passed) await completeIfEligible(result.userId, result.programId).catch(() => null)
  await notify(result.userId, 'GENERAL', 'تمت مراجعة نتيجتك من مشرفك', `راجع ${actor.name} تصحيح «${result.examTitle}» وحدّث نتيجتك — نتيجتك الحالية: ${result.score}%.`, '/?view=dashboard')
  return { score: result.score, passed: result.passed }
}

// البتّ في التماس مراجعة — يستخدمه المشرف المعيّن (قائمته) ومسار
// الامتحان الفصلي القائم (أدمن أو المشرف المعيّن للطالب).
export async function resolveExamAppeal(
  actor: SupervisorActor,
  type: AttemptKind,
  attemptId: string,
  action: 'APPROVE' | 'REJECT',
  response: string,
  finalScoreInput: unknown,
): Promise<{ finalScore: number | null; passed: boolean | null }> {
  const dbAny = db as any
  const attempt: any = type === 'UNIT'
    ? await dbAny.examAttempt.findUnique({ where: { id: attemptId }, select: { id: true, userId: true, status: true, appealStatus: true, score: true, exam: { select: { title: true, passScore: true, unit: { select: { programId: true } } } } } })
    : await dbAny.programExamAttempt.findUnique({ where: { id: attemptId }, select: { id: true, userId: true, status: true, appealStatus: true, score: true, finalScore: true, exam: { select: { title: true, passScore: true, programId: true } } } })
  if (!attempt) throw Object.assign(new Error('NOT_FOUND'), { userMessage: 'المحاولة غير موجودة', status: 404 })
  if (attempt.status !== 'GRADED') throw Object.assign(new Error('APPEAL_REQUIRES_GRADED_ATTEMPT'), { userMessage: 'لا يمكن البت في التماس إلا على محاولة مصححة', status: 409 })
  if ((attempt.appealStatus ?? 'NONE') !== 'PENDING') throw Object.assign(new Error('NO_PENDING_APPEAL'), { userMessage: 'لا يوجد التماس قيد المراجعة لهذه المحاولة', status: 409 })

  const programId = type === 'UNIT' ? attempt.exam.unit?.programId : attempt.exam.programId
  const responseText = String(response || '').trim().slice(0, 2000)

  if (action === 'APPROVE') {
    const finalScore = Number(finalScoreInput)
    if (!Number.isFinite(finalScore)) throw Object.assign(new Error('FINAL_SCORE_REQUIRED'), { userMessage: 'قبول الالتماس يحتاج درجة نهائية رقمية', status: 400 })
    const clamped = Math.max(0, Math.min(100, Math.round(finalScore * 10) / 10))
    const passed = clamped >= attempt.exam.passScore
    if (type === 'UNIT') {
      await dbAny.examAttempt.update({
        where: { id: attempt.id },
        data: { score: clamped, passed, appealStatus: 'REVIEWED', appealResponse: responseText || 'تم قبول الالتماس واعتماد الدرجة النهائية بعد مراجعة مشرفك.', reviewedById: actor.id, reviewedAt: new Date() },
      })
    } else {
      await dbAny.programExamAttempt.update({
        where: { id: attempt.id },
        data: { finalScore: clamped, passed, appealStatus: 'REVIEWED', appealResponse: responseText || 'تم قبول الالتماس واعتماد الدرجة النهائية بعد المراجعة.', reviewedById: actor.id, reviewedAt: new Date() },
      })
    }
    if (passed) await completeIfEligible(attempt.userId, programId).catch(() => null)
    await notify(attempt.userId, 'GENERAL', 'تم البت في التماس مراجعة نتيجتك', `راجع مشرفك التماسك على «${attempt.exam.title}» واعتمد درجتك النهائية: ${clamped}%.`, '/?view=dashboard')
    return { finalScore: clamped, passed }
  }

  const data = { appealStatus: 'REVIEWED', appealResponse: responseText || 'تمت مراجعة الالتماس وبقيت النتيجة كما هي.', reviewedById: actor.id, reviewedAt: new Date() }
  if (type === 'UNIT') await dbAny.examAttempt.update({ where: { id: attempt.id }, data })
  else await dbAny.programExamAttempt.update({ where: { id: attempt.id }, data })
  await notify(attempt.userId, 'GENERAL', 'تم البت في التماس مراجعة نتيجتك', `راجع مشرفك التماسك على «${attempt.exam.title}»: ${data.appealResponse}`, '/?view=dashboard')
  const current = type === 'UNIT' ? attempt.score : (attempt.finalScore ?? attempt.score)
  return { finalScore: current ?? null, passed: current != null ? current >= attempt.exam.passScore : null }
}
