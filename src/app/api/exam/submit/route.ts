import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { gradeEssayAnswer, generateOverallFeedback } from '@/lib/ai'

interface SubmitAnswer {
  questionId: string
  answerText?: string
  selectedOption?: number
}

// POST /api/exam/submit — تسليم الاختبار والتصحيح الآلي بالذكاء الاصطناعي
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

    // إنشاء محاولة
    const attempt = await db.examAttempt.create({
      data: { userId: user.id, examId, status: 'SUBMITTED' },
    })

    let totalScore = 0
    let maxTotal = 0
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

      if (q.type === 'MCQ') {
        const selected = submit?.selectedOption
        const isCorrect = selected !== undefined && String(selected) === q.correctAnswer
        const pts = isCorrect ? q.points : 0
        totalScore += pts
        const options = q.options ? JSON.parse(q.options) : []
        const feedback = isCorrect
          ? 'إجابة صحيحة! أحسنت.'
          : `إجابة غير صحيحة. الإجابة الصحيحة: «${options[Number(q.correctAnswer)]}». راجع هذا المفهوم في محتوى الوحدة.`
        if (!isCorrect) weakPoints.push(`سؤال الاختيار: ${q.text.slice(0, 60)}...`)
        await db.answer.create({
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
        gradedResults.push({
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
        })
      } else {
        // ESSAY — تصحيح بالذكاء الاصطناعي
        const essayText = submit?.answerText || ''
        const graded = await gradeEssayAnswer(q.text, q.modelAnswer || '', essayText, q.points)
        totalScore += graded.points
        if (graded.points < q.points * 0.6) {
          weakPoints.push(`سؤال مقالي: ${q.text.slice(0, 60)}...`)
        }
        await db.answer.create({
          data: {
            attemptId: attempt.id,
            questionId: q.id,
            answerText: essayText,
            isCorrect: graded.points >= q.points * 0.6 ? true : graded.points > 0 ? null : false,
            points: graded.points,
            maxPoints: q.points,
            aiFeedback: graded.feedback,
          },
        })
        gradedResults.push({
          questionId: q.id,
          order: q.order,
          type: q.type,
          text: q.text,
          isCorrect: graded.points >= q.points * 0.6,
          points: graded.points,
          maxPoints: q.points,
          aiFeedback: graded.feedback,
          studentAnswer: essayText || '(لم يجب)',
        })
      }
    }

    const percentage = maxTotal > 0 ? (totalScore / maxTotal) * 100 : 0
    const passed = percentage >= exam.passScore

    // تقييم عام بالذكاء الاصطناعي
    const overall = await generateOverallFeedback(
      exam.unit.program.titleAr,
      percentage,
      passed,
      weakPoints
    )
    const feedbackJson = JSON.stringify(overall)

    await db.examAttempt.update({
      where: { id: attempt.id },
      data: {
        score: Math.round(percentage * 10) / 10,
        passed,
        status: 'GRADED',
        aiGraded: true,
        feedback: feedbackJson,
      },
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
