import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { notify } from '@/lib/notify'

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

    return NextResponse.json({
      appeals: attempts.map((a) => ({
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
      })),
    })
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
      include: { exam: { select: { title: true, passScore: true } } },
    })
    if (!attempt) return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
    if (attempt.appealStatus !== 'PENDING') {
      return NextResponse.json({ error: 'هذا الاعتراض محسوم مسبقاً' }, { status: 409 })
    }

    const score = Math.max(0, Math.min(100, Number(finalScore)))
    const passed = score >= attempt.exam.passScore

    await db.programExamAttempt.update({
      where: { id: attemptId },
      data: {
        appealStatus: 'REVIEWED',
        finalScore: score,
        passed,
        appealResponse: String(response || '').slice(0, 3000),
      },
    })

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
