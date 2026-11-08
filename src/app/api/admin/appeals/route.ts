import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { notify } from '@/lib/notify'
import { registerGraduationRequest } from '@/lib/enrollment-completion'
import { matureSemesterRaisesAfterGrading } from '@/lib/semester-raise-hooks'

// ===== 12.2 لوحة الاعتراضات — مراجعة يدوية من المشرف البشري/الإدارة =====

// GET /api/admin/appeals — كل الاعتراضات (المعلقة أولاً) مع تفاصيل الإجابات والتقييمات
export async function GET() {
  try {
    await requireAdmin()
    const attempts = await db.programExamAttempt.findMany({
      where: { appealStatus: { in: ['PENDING', 'REVIEWED'] } },
      orderBy: { appealedAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
        exam: {
          select: {
            id: true, title: true, semester: true, passScore: true,
            program: { select: { titleAr: true } },
          },
        },
        answers: {
          include: { question: { select: { id: true, order: true, type: true, text: true, points: true, modelAnswer: true, options: true, correctAnswer: true } } },
          orderBy: { id: 'asc' },
        },
      },
      take: 60,
    })

    const programAppeals = attempts.map((a) => ({
        kind: 'PROGRAM',
        id: a.id,
        student: { id: a.user.id, name: a.user.name, email: a.user.email },
        examTitle: a.exam.title,
        program: a.exam.program.titleAr,
        semester: a.exam.semester,
        passScore: a.exam.passScore,
        score: a.score,
        finalScore: a.finalScore,
        passed: a.passed,
        appealStatus: a.appealStatus,
        appealReason: a.appealReason,
        appealResponse: a.appealResponse,
        appealedAt: a.appealedAt,
        proctoring: {
          enabled: a.proctoringEnabled,
          violations: a.proctoringLog ? JSON.parse(a.proctoringLog).length : 0,
          log: a.proctoringLog ? JSON.parse(a.proctoringLog) : [],
          snapshot: a.proctoringSnapshot || null,
        },
        feedback: a.feedback ? JSON.parse(a.feedback) : null,
        answers: a.answers.map((ans) => ({
          id: ans.id,
          order: ans.question.order,
          type: ans.question.type,
          questionText: ans.question.text,
          points: ans.question.points,
          studentAnswer: ans.answerText ?? (ans.selectedOption != null ? (ans.question.options ? JSON.parse(ans.question.options)[ans.selectedOption] : '') : null),
          modelAnswer: ans.question.modelAnswer,
          correctAnswer: ans.question.correctAnswer,
          awarded: ans.points,
          maxPoints: ans.maxPoints,
          aiFeedback: ans.aiFeedback,
        })),
      }))

    // التماسات وحدات (امتحانات الوحدات الدراسية) المعلّقة: كانت غائبة عن
    // قائمة الإدارة تمامًا فيعتمد ظهورها على تذكّر المشرف المُبلَّغ.
    // تُعرض بنفس الشكل مع وسم kind يميّزها، والحسم أدناه يدعمها بنفس
    // الانضباط المشروط بالحالة.
    const unitAttempts = await db.examAttempt.findMany({
      where: { appealStatus: 'PENDING' },
      orderBy: { appealedAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, email: true } },
        exam: {
          select: {
            id: true, title: true, passScore: true,
            unit: { select: { title: true, semester: true, program: { select: { titleAr: true } } } },
          },
        },
        answers: {
          include: { question: { select: { id: true, order: true, type: true, text: true, points: true, modelAnswer: true, options: true, correctAnswer: true } } },
          orderBy: { id: 'asc' },
        },
      },
      take: 60,
    })
    const unitAppeals = unitAttempts.map((a) => ({
      kind: 'UNIT',
      id: a.id,
      student: { id: a.user.id, name: a.user.name, email: a.user.email },
      examTitle: a.exam.title,
      program: a.exam.unit.program.titleAr,
      semester: a.exam.unit.semester,
      passScore: a.exam.passScore,
      score: a.score,
      finalScore: a.score,
      passed: a.passed,
      appealStatus: a.appealStatus,
      appealReason: a.appealReason,
      appealResponse: a.appealResponse,
      appealedAt: a.appealedAt,
      proctoring: { enabled: false, violations: 0, log: [], snapshot: null },
      feedback: a.feedback ? JSON.parse(a.feedback) : null,
      answers: a.answers.map((ans) => ({
        id: ans.id,
        order: ans.question.order,
        type: ans.question.type,
        questionText: ans.question.text,
        points: ans.question.points,
        studentAnswer: ans.answerText ?? (ans.selectedOption != null ? (ans.question.options ? JSON.parse(ans.question.options)[ans.selectedOption] : '') : null),
        modelAnswer: ans.question.modelAnswer,
        correctAnswer: ans.question.correctAnswer,
        awarded: ans.points,
        maxPoints: ans.maxPoints,
        aiFeedback: ans.aiFeedback,
      })),
    }))

    const appeals = [...programAppeals, ...unitAppeals]
      .sort((x, y) => new Date(y.appealedAt ?? 0).getTime() - new Date(x.appealedAt ?? 0).getTime())
      .slice(0, 60)
    return NextResponse.json({ appeals })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin appeals GET error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الاعتراضات' }, { status: 500 })
  }
}

// PATCH /api/admin/appeals — حسم الاعتراض: درجة نهائية + رد للطالب
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { attemptId, finalScore, response } = await req.json()
    if (!attemptId || finalScore == null) {
      return NextResponse.json({ error: 'الدرجة النهائية والرد مطلوبان' }, { status: 400 })
    }

    const attempt = await db.programExamAttempt.findUnique({
      where: { id: attemptId },
      include: { exam: { select: { title: true, passScore: true, programId: true } } },
    })
    if (!attempt) {
      // ليست محاولة امتحان فصلي: جرّب التماس وحدة (يظهر في قائمة GET
      // أعلاه) واحسمه بنفس الانضباط — درجة نهائية على score (لا يوجد
      // finalScore لمحاولات الوحدات) وكتابة مشروطة بالحالة المعلّقة.
      const unitAttempt = await db.examAttempt.findUnique({
        where: { id: attemptId },
        include: { exam: { select: { title: true, passScore: true, unit: { select: { programId: true } } } } },
      })
      if (!unitAttempt) return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
      if (unitAttempt.appealStatus !== 'PENDING') {
        return NextResponse.json({ error: 'هذا الاعتراض محسوم مسبقاً' }, { status: 409 })
      }
      const unitFinalScore = Number(finalScore)
      if (!Number.isFinite(unitFinalScore)) return NextResponse.json({ error: 'الدرجة النهائية غير صالحة' }, { status: 400 })
      const unitScore = Math.max(0, Math.min(100, unitFinalScore))
      const unitPassed = unitScore >= unitAttempt.exam.passScore
      const resolvedUnit = await db.examAttempt.updateMany({
        where: { id: attemptId, appealStatus: 'PENDING' },
        data: {
          appealStatus: 'REVIEWED',
          score: unitScore,
          passed: unitPassed,
          appealResponse: String(response || '').slice(0, 3000),
          reviewedById: admin.id,
          reviewedAt: new Date(),
        },
      })
      if (resolvedUnit.count !== 1) {
        return NextResponse.json({ error: 'هذا الاعتراض حُسم من جلسة أخرى ولا يمكن الكتابة فوق القرار.' }, { status: 409 })
      }
      await registerGraduationRequest({ userId: unitAttempt.userId, programId: unitAttempt.exam.unit.programId }).catch((error) => {
        console.warn('Unit appeal resolved but the graduation request was not refreshed.', error)
        return null
      })
      await matureSemesterRaisesAfterGrading(db, { userId: unitAttempt.userId, programId: unitAttempt.exam.unit.programId })
      await audit(
        { id: admin.id, name: admin.name },
        'RESOLVE_APPEAL',
        'ExamAttempt',
        attemptId,
        `${unitAttempt.exam.title}: ${unitAttempt.score}% → ${unitScore}% (${unitPassed ? 'ناجح' : 'غير ناجح'})`
      )
      await notify(
        unitAttempt.userId,
        'GENERAL',
        'تمت مراجعة اعتراضك',
        `نتيجتك النهائية في «${unitAttempt.exam.title}» بعد المراجعة اليدوية: ${unitScore}% — ${unitPassed ? 'مبشرك اجتزت الامتحان' : 'لم تجتز هذه المرة، راجع الرد التفصيلي'}. رد المراجعة: ${String(response || '').slice(0, 200)}`,
        'dashboard'
      )
      return NextResponse.json({ ok: true })
    }
    if (attempt.appealStatus !== 'PENDING') {
      return NextResponse.json({ error: 'هذا الاعتراض محسوم مسبقاً' }, { status: 409 })
    }

    const numericFinalScore = Number(finalScore)
    if (!Number.isFinite(numericFinalScore)) return NextResponse.json({ error: 'الدرجة النهائية غير صالحة' }, { status: 400 })
    const score = Math.max(0, Math.min(100, numericFinalScore))
    const passed = score >= attempt.exam.passScore

    const resolved = await db.programExamAttempt.updateMany({
      where: { id: attemptId, appealStatus: 'PENDING' },
      data: {
        appealStatus: 'REVIEWED',
        finalScore: score,
        passed,
        appealResponse: String(response || '').slice(0, 3000),
      },
    })
    if (resolved.count !== 1) {
      return NextResponse.json({ error: 'هذا الاعتراض حُسم من جلسة أخرى ولا يمكن الكتابة فوق القرار.' }, { status: 409 })
    }

    await registerGraduationRequest({ userId: attempt.userId, programId: attempt.exam.programId }).catch((error) => {
      console.warn('Appeal resolved but the graduation request was not refreshed.', error)
      return null
    })
    await matureSemesterRaisesAfterGrading(db, { userId: attempt.userId, programId: attempt.exam.programId })

    await audit(
      { id: admin.id, name: admin.name },
      'RESOLVE_APPEAL',
      'ProgramExamAttempt',
      attemptId,
      `${attempt.exam.title}: ${attempt.score}% → ${score}% (${passed ? 'ناجح' : 'غير ناجح'})`
    )

    await notify(
      attempt.userId,
      'GENERAL',
      'تمت مراجعة اعتراضك',
      `نتيجتك النهائية في «${attempt.exam.title}» بعد المراجعة اليدوية: ${score}% — ${passed ? 'مبشرك اجتزت الامتحان' : 'لم تجتز هذه المرة، راجع الرد التفصيلي'}. رد المراجعة: ${String(response || '').slice(0, 200)}`,
      'dashboard'
    )

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin appeals PATCH error:', e)
    return NextResponse.json({ error: 'تعذر حسم الاعتراض' }, { status: 500 })
  }
}
