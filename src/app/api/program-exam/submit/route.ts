import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { gradeEssayAnswer, generateOverallFeedback } from '@/lib/ai'
import { updateStudentAcademicMemory } from '@/lib/supervisor-ai'

interface SubmitAnswer {
  questionId: string
  answerText?: string
  selectedOption?: number
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
    const { examId, answers, durationUsedMin, proctoring } = (await req.json()) as {
      examId: string
      answers: SubmitAnswer[]
      durationUsedMin?: number
      proctoring?: { enabled?: boolean; log?: { t: number; type: string }[]; snapshot?: string }
    }
    if (!examId || !Array.isArray(answers)) {
      return NextResponse.json({ error: 'بيانات الاختبار غير مكتملة' }, { status: 400 })
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

    const answerMap = new Map(answers.map((a) => [a.questionId, a]))

    // 12.2: بيانات المراقبة الإلكترونية الاختيارية
    const procEnabled = !!proctoring?.enabled
    const procLog = procEnabled && Array.isArray(proctoring?.log) ? JSON.stringify(proctoring!.log!.slice(0, 200)) : null
    const procSnapshot = procEnabled && typeof proctoring?.snapshot === 'string' ? proctoring!.snapshot!.slice(0, 300000) : null

    const attempt = await db.programExamAttempt.create({
      data: {
        userId: user.id,
        examId,
        status: 'SUBMITTED',
        durationUsedMin: durationUsedMin ?? null,
        proctoringEnabled: procEnabled,
        proctoringLog: procLog,
        proctoringSnapshot: procSnapshot,
      },
    })

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
      await db.programAnswer.create({
        data: {
          attemptId: attempt.id,
          questionId: q.id,
          answerText: text,
          isCorrect: false,
          points: 0,
          maxPoints: q.points,
          aiFeedback: 'لم يجب على هذا السؤال — هذه فرصة لمراجعة المفهوم في الكتب المقررة.',
        },
      })
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

    const gradedEssayResults = await mapLimited(realEssayTasks, 2, async ({ q, text }) => {
      const graded = await gradeEssayAnswer(q.text, q.modelAnswer || '', text, q.points)
      await db.programAnswer.create({
        data: {
          attemptId: attempt.id,
          questionId: q.id,
          answerText: text,
          isCorrect: graded.points >= q.points * 0.6 ? true : graded.points > 0 ? null : false,
          points: graded.points,
          maxPoints: q.points,
          aiFeedback: graded.feedback,
        },
      })
      if (graded.points < q.points * 0.6) weakPoints.push(`سؤال تحليلي: ${q.text.slice(0, 60)}...`)
      const r: GradedResult = {
        questionId: q.id,
        order: q.order,
        type: q.type,
        text: q.text,
        isCorrect: graded.points >= q.points * 0.6,
        points: graded.points,
        maxPoints: q.points,
        aiFeedback: graded.feedback,
        studentAnswer: text || '(لم يجب)',
      }
      totalScore += graded.points
      return r
    })

    const percentage = maxTotal > 0 ? (totalScore / maxTotal) * 100 : 0
    const passed = percentage >= exam.passScore

    const overall = await generateOverallFeedback(exam.program.titleAr, percentage, passed, weakPoints)

    const roundedScore = Math.round(percentage * 10) / 10

    await db.programExamAttempt.update({
      where: { id: attempt.id },
      data: {
        score: roundedScore,
        passed,
        status: 'GRADED',
        feedback: JSON.stringify(overall),
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

    return NextResponse.json({
      ok: true,
      attemptId: attempt.id,
      score: roundedScore,
      rawScore: totalScore,
      maxTotal,
      passScore: exam.passScore,
      passed,
      overall,
      results: [...objectiveResults, ...essayResults, ...gradedEssayResults].sort((a, b) => a.order - b.order),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('program-exam submit error:', e)
    return NextResponse.json({ error: 'حدث خطأ أثناء تصحيح الاختبار — حاول مرة أخرى' }, { status: 500 })
  }
}
