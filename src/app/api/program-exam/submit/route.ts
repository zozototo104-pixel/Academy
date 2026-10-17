import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { generateOverallFeedback } from '@/lib/ai'
import { gradeEssayWithRubric } from '@/lib/essay-grading'
import { buildSupervisorContext, mergeContext, updateStudentAcademicMemory } from '@/lib/supervisor-ai'
import { calculateSemesterReadiness } from '@/lib/semester-readiness'
import { enforceSemesterTuitionGate } from '@/lib/tuition-installments'
import { completeEnrollmentIfEligible } from '@/lib/enrollment-completion'
import { EXAM_ATTEMPT_POLICY_SINCE, getExamMaxAttempts, shouldRevealCorrectAnswers } from '@/lib/exam-attempt-policy'

const COMPLETED_PROGRAM_ATTEMPT_STATUSES = ['GRADED', 'EXPIRED', 'NEEDS_REVIEW']
const HIDDEN_CORRECT_ANSWER_FEEDBACK = 'إجابة غير صحيحة — راجع هذا المفهوم في الوحدة'

interface SubmitAnswer {
  questionId: string
  answerText?: string
  selectedOption?: number
}

interface ProgramAnswerData {
  questionId: string
  answerText?: string | null
  selectedOption?: number | null
  isCorrect?: boolean | null
  points?: number | null
  maxPoints?: number | null
  aiFeedback?: string | null
}

function parseJsonArray(value: string | null): any[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const SKILL_AR: Record<string, string> = { UNDERSTAND: 'فهم', APPLY: 'تطبيق', ANALYZE: 'تحليل', EVALUATE: 'تقييم' }
const DIFFICULTY_AR: Record<string, string> = { EASY: 'سهل', MEDIUM: 'متوسط', ADVANCED: 'متقدم' }

function selectedOptionRationale(q: { distractorRationales?: string | null }, selected?: number): string | null {
  if (selected == null) return null
  const rationales = parseJsonArray(q.distractorRationales || null)
  const match = rationales.find((r) => Number(r?.optionIndex) === selected)
  return match?.reason ? String(match.reason).slice(0, 800) : null
}

function buildObjectiveFeedback(q: any, isCorrect: boolean, options: string[], selected?: number): string {
  const correctText = options[Number(q.correctAnswer)] ?? q.correctAnswer
  const sourceBits = [
    q.sourceBookTitle ? `المصدر: ${q.sourceBookTitle}` : null,
    q.sourceLocator ? `الموضع: ${q.sourceLocator}` : null,
    q.cognitiveSkill ? `المهارة: ${SKILL_AR[q.cognitiveSkill] || q.cognitiveSkill}` : null,
    q.difficulty ? `الصعوبة: ${DIFFICULTY_AR[q.difficulty] || q.difficulty}` : null,
  ].filter(Boolean).join(' — ')
  const correctWhy = q.correctRationale ? ` سبب الصحة: ${q.correctRationale}` : ''
  const wrongWhy = !isCorrect ? selectedOptionRationale(q, selected) : null
  if (isCorrect) return `إجابة صحيحة. ${correctWhy}${sourceBits ? ` ${sourceBits}.` : ''}`.trim()
  return `إجابة غير صحيحة. الإجابة الصحيحة: «${correctText}».${correctWhy}${wrongWhy ? ` سبب خطأ اختيارك: ${wrongWhy}` : ''}${sourceBits ? ` ${sourceBits}.` : ''}`.trim()
}

function sanitizeProgramResultsForHiddenAnswers<T extends { isCorrect: boolean | null; aiFeedback: string; correctAnswerText?: string; correctRationale?: string | null; wrongOptionRationale?: string | null }>(items: T[]): T[] {
  return items.map((item) => {
    const { correctAnswerText: _correctAnswerText, correctRationale: _correctRationale, wrongOptionRationale: _wrongOptionRationale, ...rest } = item
    return {
      ...rest,
      aiFeedback: item.isCorrect === true ? item.aiFeedback : HIDDEN_CORRECT_ANSWER_FEEDBACK,
    } as T
  })
}

async function hidePersistedProgramAnswerFeedback(attemptId: string) {
  await db.programAnswer.updateMany({
    where: { attemptId, OR: [{ isCorrect: false }, { isCorrect: null }] },
    data: { aiFeedback: HIDDEN_CORRECT_ANSWER_FEEDBACK },
  })
}

function resultMetadata(q: any) {
  return {
    sourceBookTitle: q.sourceBookTitle || null,
    sourceChapter: q.sourceChapter || null,
    sourceLocator: q.sourceLocator || null,
    cognitiveSkill: q.cognitiveSkill || null,
    difficulty: q.difficulty || null,
    correctRationale: q.correctRationale || null,
  }
}

function programAnswerData(attemptId: string, prepared: ProgramAnswerData) {
  return {
    attemptId,
    questionId: prepared.questionId,
    selectedOption: prepared.selectedOption ?? null,
    answerText: prepared.answerText ?? null,
    isCorrect: prepared.isCorrect ?? null,
    points: prepared.points ?? null,
    maxPoints: prepared.maxPoints == null ? null : Math.max(0, Math.round(Number(prepared.maxPoints) || 0)),
    aiFeedback: prepared.aiFeedback ?? null,
  }
}

async function persistProgramAnswer(client: any, attemptId: string, prepared: ProgramAnswerData, updateExisting = false) {
  const data = programAnswerData(attemptId, prepared)
  if (updateExisting) {
    const updated = await client.programAnswer.updateMany({ where: { attemptId, questionId: prepared.questionId }, data })
    if (updated.count > 0) return
  }
  await client.programAnswer.create({ data })
}

/** تنفيذ مهام بشكل متوازٍ على دفعات (لتسريع التصحيح الآلي دون إغراق النموذج) */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      results[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return results
}

// POST /api/program-exam/submit — تسليم الاختبار الشامل والتصحيح الآلي
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const maxPayloadBytes = 512 * 1024
    const declaredLength = req.headers.get('content-length')
    if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxPayloadBytes)) {
      return NextResponse.json({ error: 'حجم طلب التسليم كبير جدًا' }, { status: 413 })
    }
    const rawPayload = await req.text()
    if (Buffer.byteLength(rawPayload, 'utf8') > maxPayloadBytes) {
      return NextResponse.json({ error: 'حجم طلب التسليم كبير جدًا' }, { status: 413 })
    }
    let parsedPayload: { examId?: string; answers?: SubmitAnswer[]; durationUsedMin?: number; proctoring?: { enabled?: boolean; log?: { t: number; type: string }[]; snapshot?: string } }
    try {
      parsedPayload = JSON.parse(rawPayload)
    } catch {
      return NextResponse.json({ error: 'JSON غير صالح في طلب التسليم' }, { status: 400 })
    }
    const { examId, answers, proctoring } = parsedPayload
    if (typeof examId !== 'string' || !examId || examId.length > 128 || !Array.isArray(answers)) {
      return NextResponse.json({ error: 'بيانات الاختبار غير مكتملة' }, { status: 400 })
    }
    if (answers.length > 150 || answers.some((a) => !a || typeof a.questionId !== 'string' || a.questionId.length > 128 ||
      (a.answerText !== undefined && (typeof a.answerText !== 'string' || a.answerText.length > 12000)) ||
      (a.selectedOption !== undefined && (!Number.isInteger(a.selectedOption) || a.selectedOption < 0 || a.selectedOption > 30))) ||
      new Set(answers.map((a) => a.questionId)).size !== answers.length) {
      return NextResponse.json({ error: 'الإجابات تجاوزت الحدود المسموحة أو تضمنت تكرارًا' }, { status: 400 })
    }

    const exam = await db.programExam.findUnique({
      where: { id: examId },
      include: {
        program: { select: { id: true, titleAr: true } },
        questions: { where: { status: 'PUBLISHED' }, orderBy: { order: 'asc' } },
      },
    })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود' }, { status: 404 })
    if (exam.status !== 'READY') return NextResponse.json({ error: 'الاختبار غير متاح' }, { status: 400 })
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

    const readiness = await calculateSemesterReadiness(user.id, exam.programId, exam.semester)
    if (!readiness.readyMarked) {
      return NextResponse.json({ error: 'اضغط أولاً زر «جاهز للامتحان» من بوابة الطالب قبل بدء الامتحان النهائي للفصل', code: 'EXAM_NOT_READY_MARKED' }, { status: 403 })
    }

    const maxAttempts = await getExamMaxAttempts('PROGRAM')
    const completedAttemptsBeforeSubmit = typeof db.programExamAttempt.count === 'function'
      ? await db.programExamAttempt.count({ where: { userId: user.id, examId, status: { in: COMPLETED_PROGRAM_ATTEMPT_STATUSES }, createdAt: { gte: EXAM_ATTEMPT_POLICY_SINCE } } })
      : 0

    const ragContext = await buildSupervisorContext(user.id).catch(() => '')
    const examAcademicContext = mergeContext(
      ragContext,
      `وضع المشرف الحالي: خبير قياس وتقويم.\nالبرنامج: ${exam.program.titleAr}.\nالامتحان: ${exam.title}.\nدرجة النجاح: ${exam.passScore}%.\nاستخدم السياق لفهم مستوى الطالب ونقاط ضعفه، لكن لا تمنحه نقاطاً إلا بناءً على إجابته والدليل الأكاديمي.`
    )

    const answerMap = new Map(answers.map((a) => [a.questionId, a]))
    const knowledgeIds = [...new Set(exam.questions.map((q) => q.knowledgeItemId).filter((id): id is string => Boolean(id)))]
    const knowledgeItems = knowledgeIds.length ? await db.bookKnowledgeItem.findMany({ where: { id: { in: knowledgeIds } }, select: { id: true, excerpt: true } }) : []
    const excerptByKnowledgeId = new Map(knowledgeItems.map((item) => [item.id, item.excerpt || ''] as const))

    // 12.2: بيانات المراقبة الإلكترونية الاختيارية
    const procEnabled = !!proctoring?.enabled
    const procLog = procEnabled && Array.isArray(proctoring?.log) ? JSON.stringify(proctoring!.log!.slice(0, 200)) : null
    const procSnapshot = procEnabled && typeof proctoring?.snapshot === 'string' ? proctoring!.snapshot!.slice(0, 300000) : null

    const expiredAttempt = await db.programExamAttempt.findFirst({
      where: { userId: user.id, examId, status: 'EXPIRED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    const startedAttempt = await db.programExamAttempt.findFirst({
      where: { userId: user.id, examId, status: 'STARTED' },
      orderBy: { createdAt: 'desc' },
    })
    if (!startedAttempt && completedAttemptsBeforeSubmit >= maxAttempts) {
      return NextResponse.json({ error: 'استنفدت عدد محاولات هذا الاختبار', code: 'MAX_ATTEMPTS_REACHED', maxAttempts, attemptsUsed: completedAttemptsBeforeSubmit }, { status: 403 })
    }
    if (!startedAttempt && expiredAttempt) return NextResponse.json({ error: 'انتهت المحاولة وحُسبت صفر — انتهى وقت هذه المحاولة', code: 'ATTEMPT_EXPIRED' }, { status: 409 })
    if (!startedAttempt?.startedAt) return NextResponse.json({ error: 'يجب فتح الاختبار أولاً قبل التسليم' }, { status: 400 })
    if (completedAttemptsBeforeSubmit >= maxAttempts) {
      return NextResponse.json({ error: 'استنفدت عدد محاولات هذا الاختبار', code: 'MAX_ATTEMPTS_REACHED', maxAttempts, attemptsUsed: completedAttemptsBeforeSubmit }, { status: 403 })
    }
    const elapsedMs = Date.now() - startedAttempt.startedAt.getTime()
    const allowedMs = (exam.durationMin + 2) * 60 * 1000
    if (elapsedMs > allowedMs) {
      // An already-submitted attempt must never be overwritten as expired.
      await db.programExamAttempt.updateMany({
        where: { id: startedAttempt.id, userId: user.id, examId, status: 'STARTED' },
        data: { status: 'EXPIRED', score: 0, finalScore: 0, passed: false, durationUsedMin: exam.durationMin + 2, submittedAt: new Date() },
      })
      return NextResponse.json({ error: 'انتهت المحاولة وحُسبت صفر — انتهى وقت هذه المحاولة', code: 'ATTEMPT_EXPIRED' }, { status: 409 })
    }
    const serverDurationUsedMin = Math.max(0, Math.ceil(elapsedMs / 60000))

    // Atomic compare-and-set: exactly one request can claim a STARTED attempt.
    // Other concurrent submissions are rejected before writing answers or grading.
    const claimed = await db.programExamAttempt.updateMany({
      where: { id: startedAttempt.id, userId: user.id, examId, status: 'STARTED' },
      data: {
        status: 'SUBMITTED',
        durationUsedMin: serverDurationUsedMin,
        proctoringEnabled: procEnabled,
        proctoringLog: procLog,
        proctoringSnapshot: procSnapshot,
      },
    })
    if (claimed.count !== 1) {
      return NextResponse.json({ error: 'تم تسليم هذه المحاولة أو يجري تصحيحها بالفعل', code: 'ATTEMPT_ALREADY_CLAIMED' }, { status: 409 })
    }
    const attempt = startedAttempt
    const prePersistedEssayQuestionIds = new Set<string>()
    const essayQuestions = exam.questions.filter((q) => q.type !== 'MCQ' && q.type !== 'TF')
    if (essayQuestions.length) {
      await db.$transaction(async (tx) => {
        for (const q of essayQuestions) {
          const submit = answerMap.get(q.id)
          await persistProgramAnswer(tx, attempt.id, {
            questionId: q.id,
            answerText: submit?.answerText || '',
            isCorrect: null,
            points: null,
            maxPoints: q.points,
            aiFeedback: JSON.stringify({ status: 'PENDING_AI_GRADING' }),
          })
          prePersistedEssayQuestionIds.add(q.id)
        }
      })
    }

    try {
    let totalScore = 0
    let maxTotal = 0
    const weakPoints: string[] = []

    type GradedResult = {
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
      sourceBookTitle?: string | null
      sourceChapter?: string | null
      sourceLocator?: string | null
      cognitiveSkill?: string | null
      difficulty?: string | null
      correctRationale?: string | null
      wrongOptionRationale?: string | null
    }

    const essayResults: GradedResult[] = []

    // 1) التصحيح الفوري لأسئلة الاختيار وصح/خطأ + تجهيز المقالية
    const objectiveResults: GradedResult[] = []
    const essayTasks: { q: (typeof exam.questions)[number]; text: string }[] = []

    for (const q of exam.questions) {
      maxTotal += q.points
      const submit = answerMap.get(q.id)

      if (q.type === 'MCQ' || q.type === 'TF') {
        const selected = submit?.selectedOption
        const isCorrect = selected !== undefined && String(selected) === (q.correctAnswer ?? '')
        const pts = isCorrect ? q.points : 0
        totalScore += pts
        const options = q.options ? JSON.parse(q.options) : []
        const feedback = buildObjectiveFeedback(q, isCorrect, options, selected)
        const wrongOptionRationale = isCorrect ? null : selectedOptionRationale(q, selected)
        if (!isCorrect) weakPoints.push(`سؤال ${q.type === 'TF' ? 'صح/خطأ' : 'اختيار'}: ${q.text.slice(0, 60)}...`)
        await db.programAnswer.create({
          data: {
            attemptId: attempt.id,
            questionId: q.id,
            selectedOption: selected ?? null,
            answerText: submit?.answerText || null,
            isCorrect,
            points: pts,
            maxPoints: q.points,
            aiFeedback: feedback,
          },
        })
        objectiveResults.push({
          questionId: q.id,
          order: q.order,
          type: q.type,
          text: q.text,
          isCorrect,
          points: pts,
          maxPoints: q.points,
          aiFeedback: feedback,
          studentAnswer: selected !== undefined ? options[selected] || '' : '(لم يجب)',
          correctAnswerText: options[Number(q.correctAnswer)],
          wrongOptionRationale,
          ...resultMetadata(q),
        })
      } else {
        essayTasks.push({ q, text: submit?.answerText || '' })
      }
    }

    // 2) التصحيح بالذكاء الاصطناعي للأسئلة القصيرة والمقالية (بالتوازي المحدود)
    // الأسئلة بدون إجابة فعلية تُقيَّم صفراً فوراً دون استدعاء النموذج
    const realEssayTasks = essayTasks.filter(({ text }) => text.trim().length >= 3)
    const emptyEssayTasks = essayTasks.filter(({ text }) => text.trim().length < 3)

    for (const { q, text } of emptyEssayTasks) {
      await persistProgramAnswer(db, attempt.id, {
        questionId: q.id,
        answerText: text,
        isCorrect: false,
        points: 0,
        maxPoints: q.points,
        aiFeedback: 'لم يجب على هذا السؤال — هذه فرصة لمراجعة المفهوم في الكتب المقررة.',
      }, prePersistedEssayQuestionIds.has(q.id))
      weakPoints.push(`سؤال بدون إجابة: ${q.text.slice(0, 60)}...`)
      essayResults.push({
        questionId: q.id,
        order: q.order,
        type: q.type,
        text: q.text,
        isCorrect: false,
        points: 0,
        maxPoints: q.points,
        aiFeedback: q.correctRationale
          ? `لم يجب على هذا السؤال — معيار التصحيح: ${q.correctRationale}`
          : 'لم يجب على هذا السؤال — هذه فرصة لمراجعة المفهوم في الكتب المقررة.',
        studentAnswer: '(لم يجب)',
        ...resultMetadata(q),
      })
    }

    let gradedEssayResults: GradedResult[]
    try {
      gradedEssayResults = await mapLimited(realEssayTasks, 2, async ({ q, text }) => {
      const graded = await gradeEssayWithRubric({
        question: q.text,
        modelAnswer: q.modelAnswer || '',
        rubric: q.rubric,
        sourceExcerpt: (q.knowledgeItemId ? excerptByKnowledgeId.get(q.knowledgeItemId) : '') || q.sourceEvidence,
        studentAnswer: text,
        maxPoints: q.points,
        deadlineMs: Date.now() + 45_000,
      })
      const clampedPoints = Math.max(0, Math.min(q.points, Number(graded.points) || 0))
      await persistProgramAnswer(db, attempt.id, {
        questionId: q.id,
        answerText: text,
        isCorrect: clampedPoints >= q.points * 0.6 ? true : clampedPoints > 0 ? null : false,
        points: clampedPoints,
        maxPoints: q.points,
        aiFeedback: graded.feedback,
      }, prePersistedEssayQuestionIds.has(q.id))
      if (clampedPoints < q.points * 0.6) weakPoints.push(`سؤال تحليلي: ${q.text.slice(0, 60)}...`)
      const r: GradedResult = {
        questionId: q.id,
        order: q.order,
        type: q.type,
        text: q.text,
        isCorrect: clampedPoints >= q.points * 0.6,
        points: clampedPoints,
        maxPoints: q.points,
        aiFeedback: q.correctRationale ? `${graded.feedback}\nمعيار التصحيح: ${q.correctRationale}` : graded.feedback,
        studentAnswer: text || '(لم يجب)',
        ...resultMetadata(q),
      }
      totalScore += clampedPoints
      return r
      })
    } catch (e: any) {
      const reviewState = { code: e?.code || 'AI_ACADEMIC_PROVIDER_UNAVAILABLE', reason: String(e?.message || e).slice(0, 500), retryAt: e?.retryAt || null }
      await db.programExamAttempt.update({
        where: { id: attempt.id },
        data: { status: 'NEEDS_REVIEW', score: null, passed: null, feedback: JSON.stringify(reviewState), submittedAt: new Date() },
      })
      return NextResponse.json({ ok: true, status: 'NEEDS_REVIEW', attemptId: attempt.id, message: 'تم حفظ المحاولة كاملة للمراجعة دون اعتماد نتيجة جزئية.', ...reviewState }, { status: 202 })
    }

    const rawPercentage = maxTotal > 0 ? (totalScore / maxTotal) * 100 : 0
    const percentage = Math.min(rawPercentage, readiness.maxExamScore)
    const passed = percentage >= exam.passScore
    if (readiness.maxExamScore < 100) {
      weakPoints.push(`خصم سقف الدرجة بسبب عدم استكمال اختبارات/واجبات فصلية: أعلى نتيجة ممكنة ${readiness.maxExamScore}%`)
    }

    const overall = await generateOverallFeedback(exam.program.titleAr, percentage, passed, weakPoints, examAcademicContext)

    const roundedScore = Math.round(percentage * 10) / 10
    const roundedRawScore = Math.round(rawPercentage * 10) / 10

    await db.programExamAttempt.update({
      where: { id: attempt.id },
      data: {
        score: roundedScore,
        finalScore: roundedScore,
        passed,
        status: 'GRADED',
        feedback: JSON.stringify({ ...overall, rawScoreBeforeCourseworkCap: roundedRawScore, maxExamScore: readiness.maxExamScore, readiness }),
        submittedAt: new Date(),
      },
    })

    await updateStudentAcademicMemory(user.id, {
      kind: 'EXAM',
      persona: 'EXAM',
      programTitle: exam.program.titleAr,
      examTitle: exam.title,
      score: roundedScore,
      passed,
      weakPoints: weakPoints.slice(0, 8),
      strengths: overall.strengths,
      weaknesses: overall.improvements,
      concepts: weakPoints.slice(0, 8),
      nextActions: passed
        ? ['مراجعة التغذية الراجعة وتحويل المفاهيم الصحيحة إلى تطبيق عملي قصير']
        : ['حل تدريب علاجي على نقاط الضعف قبل إعادة المحاولة أو مراجعة المشرف'],
    }).catch(() => {})

    await db.examDraft.deleteMany({ where: { userId: user.id, examId, examType: 'PROGRAM' } }).catch(() => {})

    const completion = passed ? await completeEnrollmentIfEligible({ enrollmentId: enrollment.id }) : null
    const completedAttempts = completedAttemptsBeforeSubmit + 1
    const revealCorrectAnswers = shouldRevealCorrectAnswers({ passed, completedAttempts, maxAttempts })
    const sortedResults = [...objectiveResults, ...essayResults, ...gradedEssayResults].sort((a, b) => a.order - b.order)
    const results = revealCorrectAnswers
      ? sortedResults
      : sortedResults.map(({ correctAnswerText, correctRationale, wrongOptionRationale, ...result }) => result)

    return NextResponse.json({
      ok: true,
      attemptId: attempt.id,
      score: roundedScore,
      rawScore: totalScore,
      maxTotal,
      passScore: exam.passScore,
      passed,
      rawScoreBeforeCourseworkCap: roundedRawScore,
      maxExamScore: readiness.maxExamScore,
      courseworkCapApplied: readiness.maxExamScore < 100,
      overall,
      certificateNo: completion?.ok ? completion.certificate?.serial || null : null,
      maxAttempts,
      attemptsUsed: completedAttempts,
      results,
    })
    } catch (postCreateError: any) {
      const reviewState = { code: 'POST_SUBMIT_FAILURE', reason: String(postCreateError?.message || postCreateError).slice(0, 500) }
      await db.programExamAttempt.update({
        where: { id: attempt.id },
        data: { status: 'NEEDS_REVIEW', feedback: JSON.stringify(reviewState), submittedAt: new Date() },
      }).catch(() => {})
      return NextResponse.json({ ok: true, status: 'NEEDS_REVIEW', attemptId: attempt.id, message: 'تم حفظ المحاولة للمراجعة بسبب خطأ أثناء التصحيح.', ...reviewState }, { status: 202 })
    }
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('program-exam submit error:', e)
    return NextResponse.json({ error: 'حدث خطأ أثناء تصحيح الاختبار — حاول مرة أخرى' }, { status: 500 })
  }
}
