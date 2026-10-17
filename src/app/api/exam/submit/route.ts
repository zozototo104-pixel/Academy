import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { generateOverallFeedback } from '@/lib/ai'
import { gradeEssayWithRubric } from '@/lib/essay-grading'
import { completeEnrollmentIfEligible } from '@/lib/enrollment-completion'
import { EXAM_ATTEMPT_POLICY_SINCE, getExamMaxAttempts, shouldRevealCorrectAnswers } from '@/lib/exam-attempt-policy'

const UNIT_EXAM_DURATION_MIN = Math.max(1, Number(process.env.AACT_UNIT_EXAM_DURATION_MIN || 60))
const UNIT_EXAM_SUBMIT_GRACE_MS = 2 * 60 * 1000
const COMPLETED_UNIT_ATTEMPT_STATUSES = ['GRADED', 'EXPIRED', 'NEEDS_REVIEW']
const HIDDEN_CORRECT_ANSWER_FEEDBACK = 'إجابة غير صحيحة — راجع هذا المفهوم في الوحدة'

interface SubmitAnswer {
  questionId: string
  answerText?: string
  selectedOption?: number | string | null
}

type PreparedAnswer = {
  questionId: string
  selectedOption?: number | null
  answerText?: string | null
  isCorrect: boolean | null
  points: number | null
  maxPoints: number
  aiFeedback: string
}

function parseQuestionOptions(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

function parseOptionIndex(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

function unitAttemptDeadline(createdAt: Date) {
  return createdAt.getTime() + UNIT_EXAM_DURATION_MIN * 60 * 1000 + UNIT_EXAM_SUBMIT_GRACE_MS
}

function buildAnswerKeyFeedback(programTitle: string, percentage: number, passed: boolean, weakPoints: string[]) {
  return {
    summary: passed
      ? `تم تصحيح اختبار ${programTitle} وفق مفتاح الإجابة المعتمد، وحققت نتيجة ${Math.round(percentage)}%.`
      : `تم تصحيح اختبار ${programTitle} وفق مفتاح الإجابة المعتمد، وحققت نتيجة ${Math.round(percentage)}%. راجع الأسئلة التي ظهرت في الملاحظات قبل إعادة المحاولة.`,
    strengths: passed
      ? ['إجابات صحيحة في الأسئلة المطابقة لمفتاح التصحيح', 'إكمال الاختبار وفق الآلية المعتمدة']
      : ['إكمال محاولة الاختبار', 'ظهور نقاط مراجعة واضحة من نتيجة التصحيح'],
    improvements: weakPoints.length
      ? weakPoints.slice(0, 3).map((point) => point.replace(/\.\.\.$/, ''))
      : ['مراجعة محتوى الوحدة وتثبيت المفاهيم الأساسية'],
  }
}

function sanitizeUnitFeedbackForHiddenAnswers<T extends { isCorrect: boolean | null; aiFeedback: string; correctAnswerText?: string }>(items: T[]): T[] {
  return items.map((item) => {
    const { correctAnswerText: _correctAnswerText, ...rest } = item
    return {
      ...rest,
      aiFeedback: item.isCorrect === true ? item.aiFeedback : HIDDEN_CORRECT_ANSWER_FEEDBACK,
    } as T
  })
}

function sanitizePreparedAnswersForHiddenAnswers(items: PreparedAnswer[]): PreparedAnswer[] {
  return items.map((item) => ({
    ...item,
    aiFeedback: item.isCorrect === true ? item.aiFeedback : HIDDEN_CORRECT_ANSWER_FEEDBACK,
  }))
}

function answerData(attemptId: string, prepared: PreparedAnswer) {
  return {
    attemptId,
    questionId: prepared.questionId,
    selectedOption: prepared.selectedOption ?? null,
    answerText: prepared.answerText ?? null,
    isCorrect: prepared.isCorrect,
    points: prepared.points,
    maxPoints: prepared.maxPoints,
    aiFeedback: prepared.aiFeedback,
  }
}

async function persistPreparedAnswer(tx: any, attemptId: string, prepared: PreparedAnswer, updateExisting = false) {
  const data = answerData(attemptId, prepared)
  if (updateExisting) {
    const updated = await tx.answer.updateMany({ where: { attemptId, questionId: prepared.questionId }, data })
    if (updated.count > 0) return
  }
  await tx.answer.create({ data })
}

// POST /api/exam/submit — تسليم الاختبار والتصحيح الآلي وفق مفتاح الإجابة، وبالذكاء للأسئلة المقالية فقط
export async function POST(req: NextRequest) {
  let claimedUnitAttemptId: string | null = null
  try {
    const user = await requireUser()
    const declaredLength = req.headers.get('content-length')
    const maxPayloadBytes = 512 * 1024
    if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxPayloadBytes)) {
      return NextResponse.json({ error: 'حجم طلب الاختبار كبير جدًا' }, { status: 413 })
    }
    const payload = await req.text()
    if (Buffer.byteLength(payload, 'utf8') > maxPayloadBytes) {
      return NextResponse.json({ error: 'حجم طلب الاختبار كبير جدًا' }, { status: 413 })
    }
    let parsedPayload: { examId?: string; answers?: SubmitAnswer[] }
    try {
      parsedPayload = JSON.parse(payload)
    } catch {
      return NextResponse.json({ error: 'JSON غير صالح في طلب التسليم' }, { status: 400 })
    }
    const { examId, answers } = parsedPayload
    if (typeof examId !== 'string' || !examId || examId.length > 128 || !Array.isArray(answers)) {
      return NextResponse.json({ error: 'بيانات الاختبار غير مكتملة' }, { status: 400 })
    }
    if (answers.length > 150 || answers.some((a) => !a || typeof a.questionId !== 'string' || a.questionId.length > 128 || (a.answerText !== undefined && (typeof a.answerText !== 'string' || a.answerText.length > 12000)) || (a.selectedOption != null && !['string', 'number'].includes(typeof a.selectedOption))) || new Set(answers.map((a) => a.questionId)).size !== answers.length) {
      return NextResponse.json({ error: 'الإجابات تجاوزت الحدود المسموحة أو احتوت أسئلة مكررة' }, { status: 400 })
    }

    const exam = await db.exam.findUnique({
      where: { id: examId },
      include: {
        unit: { include: { program: { select: { id: true, titleAr: true, slug: true } } } },
        questions: { orderBy: { order: 'asc' } },
      },
    })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود' }, { status: 404 })
    if (exam.status !== 'READY') return NextResponse.json({ error: 'لا يمكن تسليم اختبار وحدة غير منشور لأنه يحتوي أسئلة تحتاج مراجعة.' }, { status: 403 })
    const publishedPoints = exam.questions.reduce((sum, question) => sum + Math.max(0, Number(question.points || 0)), 0)
    if (!exam.questions.length || publishedPoints <= 0) {
      return NextResponse.json({ error: 'الاختبار لا يحتوي أسئلة منشورة صالحة بعد', code: 'EXAM_HAS_NO_QUESTIONS' }, { status: 409 })
    }

    const enrollment = await db.enrollment.findUnique({
      where: { userId_programId: { userId: user.id, programId: exam.unit.programId } },
    })
    if (!enrollment) return NextResponse.json({ error: 'يجب التسجيل في البرنامج أولاً' }, { status: 403 })
    if (!['ACTIVE', 'COMPLETED'].includes(enrollment.status)) {
      return NextResponse.json(
        { error: 'تسجيلك غير مفعل بعد — يجب أن تكون حالة التسجيل ACTIVE أو COMPLETED لتسليم الاختبارات', code: 'ENROLLMENT_NOT_ACTIVE' },
        { status: 403 }
      )
    }

    const maxAttempts = await getExamMaxAttempts('UNIT')
    const completedAttemptsBeforeSubmit = typeof db.examAttempt.count === 'function'
      ? await db.examAttempt.count({ where: { userId: user.id, examId, status: { in: COMPLETED_UNIT_ATTEMPT_STATUSES }, createdAt: { gte: EXAM_ATTEMPT_POLICY_SINCE } } })
      : 0

    const allowedQuestionIds = new Set(exam.questions.map((q) => q.id))
    if (answers.some((a) => !allowedQuestionIds.has(a.questionId))) {
      return NextResponse.json({ error: 'توجد إجابات لأسئلة لا تنتمي لهذا الاختبار' }, { status: 400 })
    }
    // Verify the published correction key before claiming an attempt.
    // Invalid administrative question data must not lock the student out of a retry.
    for (const question of exam.questions) {
      if (question.type === 'MCQ' || question.type === 'TF') {
        const options = parseQuestionOptions(question.options)
        const correctIndex = parseOptionIndex(question.correctAnswer)
        if (correctIndex === null || !options[correctIndex]) {
          return NextResponse.json({ error: `مفتاح التصحيح غير مكتمل للسؤال رقم ${question.order}`, code: 'ANSWER_KEY_MISSING' }, { status: 422 })
        }
      } else if (!question.modelAnswer) {
        return NextResponse.json({ error: `الإجابة النموذجية غير مكتملة للسؤال رقم ${question.order}`, code: 'MODEL_ANSWER_MISSING' }, { status: 422 })
      }
    }
    // Atomic claim before AI grading: only the first submission can grade this attempt.
    const activeAttempt = await db.examAttempt.findFirst({
      where: { userId: user.id, examId, status: 'STARTED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    })
    if (!activeAttempt) {
      if (completedAttemptsBeforeSubmit >= maxAttempts) {
        return NextResponse.json({ error: 'استنفدت عدد محاولات هذا الاختبار', code: 'MAX_ATTEMPTS_REACHED', maxAttempts, attemptsUsed: completedAttemptsBeforeSubmit }, { status: 403 })
      }
      return NextResponse.json({ error: 'يجب بدء الاختبار من صفحة الأسئلة قبل التسليم' }, { status: 409 })
    }
    if (completedAttemptsBeforeSubmit >= maxAttempts) {
      return NextResponse.json({ error: 'استنفدت عدد محاولات هذا الاختبار', code: 'MAX_ATTEMPTS_REACHED', maxAttempts, attemptsUsed: completedAttemptsBeforeSubmit }, { status: 403 })
    }
    if (Date.now() > unitAttemptDeadline(activeAttempt.createdAt)) {
      await db.$transaction(async (tx) => {
        await tx.examAttempt.updateMany({
          where: { id: activeAttempt.id, userId: user.id, examId, status: 'STARTED' },
          data: { status: 'EXPIRED', submittedAt: new Date(), feedback: JSON.stringify({ summary: 'انتهت مدة اختبار الوحدة قبل التسليم.' }) },
        })
        await tx.examDraft.deleteMany({ where: { userId: user.id, examId, examType: 'UNIT' } })
      })
      return NextResponse.json({ error: 'انتهت مدة الاختبار ولا يمكن قبول التسليم بعد الهامش المسموح.', code: 'UNIT_EXAM_EXPIRED' }, { status: 409 })
    }
    const claim = await db.examAttempt.updateMany({
      where: { id: activeAttempt.id, userId: user.id, examId, status: 'STARTED' },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    })
    if (claim.count !== 1) {
      return NextResponse.json({ error: 'تم تسليم المحاولة أو يجري تصحيحها بالفعل' }, { status: 409 })
    }
    claimedUnitAttemptId = activeAttempt.id

    const answerMap = new Map(answers.map((a) => [a.questionId, a]))
    const prePersistedEssayQuestionIds = new Set<string>()
    const essayQuestions = exam.questions.filter((q) => q.type !== 'MCQ' && q.type !== 'TF')
    if (essayQuestions.length) {
      await db.$transaction(async (tx) => {
        for (const q of essayQuestions) {
          const submit = answerMap.get(q.id)
          const essayText = submit?.answerText || ''
          await persistPreparedAnswer(tx, activeAttempt.id, {
            questionId: q.id,
            answerText: essayText,
            isCorrect: null,
            points: null,
            maxPoints: q.points,
            aiFeedback: JSON.stringify({ status: 'PENDING_AI_GRADING' }),
          })
          prePersistedEssayQuestionIds.add(q.id)
        }
      })
    }
    const knowledgeIds = [...new Set(exam.questions.map((q) => q.knowledgeItemId).filter((id): id is string => Boolean(id)))]
    const knowledgeItems = knowledgeIds.length ? await db.bookKnowledgeItem.findMany({ where: { id: { in: knowledgeIds } }, select: { id: true, excerpt: true } }) : []
    const excerptByKnowledgeId = new Map(knowledgeItems.map((item) => [item.id, item.excerpt || ''] as const))

    let totalScore = 0
    let maxTotal = 0
    const answersToPersist: PreparedAnswer[] = []
    const gradedResults: {
      questionId: string
      order: number
      type: string
      text: string
      isCorrect: boolean | null
      points: number
      maxPoints: number
      aiFeedback: string
      studentAnswer: string
      correctAnswerText?: string
    }[] = []
    const weakPoints: string[] = []
    let needsReview = false

    for (const q of exam.questions) {
      maxTotal += q.points
      const submit = answerMap.get(q.id)

      if (q.type === 'MCQ' || q.type === 'TF') {
        const options = parseQuestionOptions(q.options)
        const selected = parseOptionIndex(submit?.selectedOption)
        const correctIndex = parseOptionIndex(q.correctAnswer)

        if (correctIndex === null || !options[correctIndex]) {
          return NextResponse.json(
            { error: `مفتاح التصحيح غير مكتمل للسؤال رقم ${q.order}. يرجى مراجعة الاختبار من لوحة الإدارة قبل استقبال محاولات الطلاب.`, code: 'ANSWER_KEY_MISSING' },
            { status: 422 }
          )
        }

        const isCorrect = selected !== null && selected === correctIndex
        const pts = isCorrect ? q.points : 0
        totalScore += pts
        const feedback = isCorrect
          ? 'إجابة صحيحة وفق مفتاح التصحيح المعتمد.'
          : `إجابة غير صحيحة. الإجابة الصحيحة المعتمدة: «${options[correctIndex]}». راجع هذا المفهوم في محتوى الوحدة.`

        if (!isCorrect) weakPoints.push(`سؤال ${q.order}: ${q.text.slice(0, 90)}...`)

        answersToPersist.push({
          questionId: q.id,
          selectedOption: selected,
          answerText: submit?.answerText || null,
          isCorrect,
          points: pts,
          maxPoints: q.points,
          aiFeedback: feedback,
        })
        gradedResults.push({
          questionId: q.id,
          order: q.order,
          type: q.type,
          text: q.text,
          isCorrect,
          points: pts,
          maxPoints: q.points,
          aiFeedback: feedback,
          studentAnswer: selected !== null ? options[selected] || '(اختيار غير صالح)' : '(لم يجب)',
          correctAnswerText: options[correctIndex],
        })
      } else {
        const essayText = submit?.answerText || ''
        if (!q.modelAnswer) {
          return NextResponse.json(
            { error: `الإجابة النموذجية غير مكتملة للسؤال رقم ${q.order}. لا يمكن تصحيح سؤال مقالي بلا مرجع معتمد.`, code: 'MODEL_ANSWER_MISSING' },
            { status: 422 }
          )
        }

        let graded: { points: number; feedback: string; confidence?: string; criteria?: unknown }
        try {
          graded = await gradeEssayWithRubric({
            question: q.text,
            modelAnswer: q.modelAnswer,
            rubric: q.rubric,
            sourceExcerpt: (q.knowledgeItemId ? excerptByKnowledgeId.get(q.knowledgeItemId) : '') || q.sourceEvidence,
            studentAnswer: essayText,
            maxPoints: q.points,
            deadlineMs: Date.now() + 45_000,
          })
        } catch (e: any) {
          console.error('Essay grading failed; saving for manual review:', String(e?.message || e).slice(0, 300))
          needsReview = true
          answersToPersist.push({
            questionId: q.id,
            answerText: essayText,
            isCorrect: null,
            points: null,
            maxPoints: q.points,
            aiFeedback: JSON.stringify({ status: 'NEEDS_REVIEW', reason: String(e?.message || e).slice(0, 300) }),
          })
          gradedResults.push({
            questionId: q.id,
            order: q.order,
            type: q.type,
            text: q.text,
            isCorrect: null,
            points: 0,
            maxPoints: q.points,
            aiFeedback: 'تم حفظ الإجابة للمراجعة اليدوية لأن التصحيح الآلي لم يكتمل.',
            studentAnswer: essayText || '(لم يجب)',
          })
          continue
        }

        const pts = Math.max(0, Math.min(q.points, Number(graded.points) || 0))
        totalScore += pts
        if (pts < q.points * 0.6) weakPoints.push(`سؤال مقالي ${q.order}: ${q.text.slice(0, 90)}...`)

        answersToPersist.push({
          questionId: q.id,
          answerText: essayText,
          isCorrect: pts >= q.points * 0.6 ? true : pts > 0 ? null : false,
          points: pts,
          maxPoints: q.points,
          aiFeedback: graded.feedback || 'تم تصحيح الإجابة وفق الإجابة النموذجية.',
        })
        gradedResults.push({
          questionId: q.id,
          order: q.order,
          type: q.type,
          text: q.text,
          isCorrect: pts >= q.points * 0.6,
          points: pts,
          maxPoints: q.points,
          aiFeedback: graded.feedback || 'تم تصحيح الإجابة وفق الإجابة النموذجية.',
          studentAnswer: essayText || '(لم يجب)',
        })
      }
    }

    if (needsReview) {
      const revealCorrectAnswers = shouldRevealCorrectAnswers({ passed: false, completedAttempts: completedAttemptsBeforeSubmit + 1, maxAttempts })
      const persistedAnswers = revealCorrectAnswers ? answersToPersist : sanitizePreparedAnswersForHiddenAnswers(answersToPersist)
      const responseResults = revealCorrectAnswers ? gradedResults : sanitizeUnitFeedbackForHiddenAnswers(gradedResults)
      const attempt = await db.$transaction(async (tx) => {
        const created = await tx.examAttempt.update({ where: { id: activeAttempt.id }, data: { status: 'NEEDS_REVIEW', feedback: JSON.stringify({ summary: 'تم حفظ الإجابات، التصحيح قيد المراجعة.' }) } })
        for (const prepared of persistedAnswers) {
          await persistPreparedAnswer(tx, created.id, prepared, prePersistedEssayQuestionIds.has(prepared.questionId))
        }
        await tx.examDraft.deleteMany({ where: { userId: user.id, examId, examType: 'UNIT' } })
        return created
      })
      claimedUnitAttemptId = null
      const reviewResults = responseResults.sort((a, b) => a.order - b.order)
      return NextResponse.json({ ok: true, status: 'NEEDS_REVIEW', attemptId: attempt.id, message: 'تم حفظ إجاباتك، التصحيح قيد المراجعة', maxAttempts, attemptsUsed: completedAttemptsBeforeSubmit + 1, results: reviewResults }, { status: 202 })
    }

    const percentage = maxTotal > 0 ? (totalScore / maxTotal) * 100 : 0
    const passed = percentage >= exam.passScore

    let overall: { summary: string; strengths: string[]; improvements: string[] }
    try {
      overall = await generateOverallFeedback(exam.unit.program.titleAr, percentage, passed, weakPoints)
    } catch (e: any) {
      console.error('Overall feedback failed; using answer-key feedback:', String(e?.message || e).slice(0, 300))
      overall = buildAnswerKeyFeedback(exam.unit.program.titleAr, percentage, passed, weakPoints)
    }
    const feedbackJson = JSON.stringify(overall)
    const completedAttempts = completedAttemptsBeforeSubmit + 1
    const revealCorrectAnswers = shouldRevealCorrectAnswers({ passed, completedAttempts, maxAttempts })
    const persistedAnswers = revealCorrectAnswers ? answersToPersist : sanitizePreparedAnswersForHiddenAnswers(answersToPersist)
    const responseResults = revealCorrectAnswers ? gradedResults : sanitizeUnitFeedbackForHiddenAnswers(gradedResults)

    const attempt = await db.$transaction(async (tx) => {
      const created = activeAttempt

      for (const prepared of persistedAnswers) {
        await persistPreparedAnswer(tx, created.id, prepared, prePersistedEssayQuestionIds.has(prepared.questionId))
      }

      await tx.examAttempt.update({
        where: { id: created.id },
        data: {
          score: Math.round(percentage * 10) / 10,
          passed,
          status: 'GRADED',
          aiGraded: true,
          feedback: feedbackJson,
        },
      })

      await tx.examDraft.deleteMany({ where: { userId: user.id, examId, examType: 'UNIT' } })
      return created
    })
    claimedUnitAttemptId = null

    const completion = passed
      ? await completeEnrollmentIfEligible({ enrollmentId: enrollment.id })
      : null
    const certificateNo = completion?.ok ? completion.certificate?.serial || null : null
    const completedAttempts = completedAttemptsBeforeSubmit + 1
    const revealCorrectAnswers = shouldRevealCorrectAnswers({ passed, completedAttempts, maxAttempts })
    const results = revealCorrectAnswers
      ? gradedResults.sort((a, b) => a.order - b.order)
      : gradedResults.sort((a, b) => a.order - b.order).map(({ correctAnswerText, ...result }) => result)

    return NextResponse.json({
      ok: true,
      attemptId: attempt.id,
      score: Math.round(percentage * 10) / 10,
      rawScore: totalScore,
      maxTotal,
      passScore: exam.passScore,
      passed,
      overall,
      certificateNo,
      maxAttempts,
      attemptsUsed: completedAttempts,
      results,
    })
  } catch (e: any) {
    if (claimedUnitAttemptId) {
      try {
        // A failed grading operation must not strand a student in SUBMITTED.
        // Only the request that claimed this attempt may release an unpersisted claim.
        await db.examAttempt.updateMany({
          where: { id: claimedUnitAttemptId, status: 'SUBMITTED' },
          data: { status: 'STARTED' },
        })
      } catch (recoveryError) {
        console.error('Failed to release unsuccessful unit exam claim:', recoveryError)
      }
    }
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('Exam submit error:', e)
    return NextResponse.json(
      { error: 'حدث خطأ أثناء تصحيح الاختبار — حاول مرة أخرى' },
      { status: 500 }
    )
  }
}
