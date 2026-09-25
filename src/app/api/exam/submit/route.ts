import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { gradeEssayAnswer, generateOverallFeedback } from '@/lib/ai'

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
  points: number
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

// POST /api/exam/submit — تسليم الاختبار والتصحيح الآلي وفق مفتاح الإجابة، وبالذكاء للأسئلة المقالية فقط
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const { examId, answers } = (await req.json()) as { examId: string; answers: SubmitAnswer[] }
    if (!examId || !Array.isArray(answers)) {
      return NextResponse.json({ error: 'بيانات الاختبار غير مكتملة' }, { status: 400 })
    }

    const exam = await db.exam.findUnique({
      where: { id: examId },
      include: {
        unit: { include: { program: { select: { id: true, titleAr: true, slug: true } } } },
        questions: { orderBy: { order: 'asc' } },
      },
    })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود' }, { status: 404 })

    const enrollment = await db.enrollment.findUnique({
      where: { userId_programId: { userId: user.id, programId: exam.unit.programId } },
    })
    if (!enrollment) return NextResponse.json({ error: 'يجب التسجيل في البرنامج أولاً' }, { status: 403 })
    if (enrollment.status === 'PENDING_PAYMENT') {
      return NextResponse.json(
        { error: 'تسجيلك بانتظار سداد الفاتورة — أكمل الدفع لفتح الاختبارات', code: 'PENDING_PAYMENT' },
        { status: 402 }
      )
    }

    const answerMap = new Map(answers.map((a) => [a.questionId, a]))

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

        let graded: { points: number; feedback: string }
        try {
          graded = await gradeEssayAnswer(q.text, q.modelAnswer, essayText, q.points)
        } catch (e: any) {
          console.error('Essay grading failed:', String(e?.message || e).slice(0, 300))
          return NextResponse.json(
            { error: 'تعذر التصحيح الذكي للسؤال المقالي الآن. لم يتم اعتماد المحاولة، حاول مرة أخرى بعد قليل.', code: 'AI_GRADING_UNAVAILABLE' },
            { status: 503 }
          )
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

    const attempt = await db.$transaction(async (tx) => {
      const created = await tx.examAttempt.create({
        data: { userId: user.id, examId, status: 'SUBMITTED' },
      })

      for (const prepared of answersToPersist) {
        await tx.answer.create({
          data: {
            attemptId: created.id,
            questionId: prepared.questionId,
            selectedOption: prepared.selectedOption ?? null,
            answerText: prepared.answerText ?? null,
            isCorrect: prepared.isCorrect,
            points: prepared.points,
            maxPoints: prepared.maxPoints,
            aiFeedback: prepared.aiFeedback,
          },
        })
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

    // إذا نجح في كل اختبارات البرنامج وحدد الوحدات → إصدار رقم شهادة
    let certificateNo: string | null = null
    const programUnits = await db.unit.count({ where: { programId: exam.unit.programId } })
    const completed: string[] = JSON.parse(enrollment.completedUnits || '[]')
    if (passed && programUnits > 0 && completed.length >= programUnits) {
      if (!enrollment.certificateNo) {
        certificateNo = `AACT-${new Date().getFullYear()}-${exam.unit.program.slug.toUpperCase().slice(0, 6)}-${attempt.id.slice(-6).toUpperCase()}`
        const programExams = await db.exam.findMany({
          where: { unit: { programId: exam.unit.programId } },
          select: { id: true },
        })
        const bestScores = await db.examAttempt.findMany({
          where: { userId: user.id, examId: { in: programExams.map((e) => e.id) }, passed: true },
          orderBy: { score: 'desc' },
        })
        // أفضل درجة لكل امتحان (لا مجموع المحاولات — يمنع تضخيم المتوسط بالتكرار)
        const bestByExam: Record<string, number> = {}
        for (const b of bestScores) {
          if (b.examId && b.score !== null && (!(b.examId in bestByExam) || b.score > bestByExam[b.examId])) {
            bestByExam[b.examId] = b.score
          }
        }
        const passedExams = new Set(Object.keys(bestByExam))
        const allPassed = programExams.every((e) => passedExams.has(e.id))
        if (allPassed) {
          const avg = Math.round(
            programExams.reduce((s, e) => s + (bestByExam[e.id] || 0), 0) / programExams.length
          )
          await db.enrollment.update({
            where: { id: enrollment.id },
            data: { status: 'COMPLETED', finalScore: avg, certificateNo },
          })
        } else {
          certificateNo = null
        }
      } else {
        certificateNo = enrollment.certificateNo
      }
    }

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
      results: gradedResults.sort((a, b) => a.order - b.order),
    })
  } catch (e: any) {
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
