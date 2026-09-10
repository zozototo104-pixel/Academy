import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { notify } from '@/lib/notify'
import { emailExamPublished } from '@/lib/mailer'

// ===== 12.2 المراجعة البشرية للأسئلة المولدة بالذكاء الاصطناعي (Human-in-the-loop) =====
// GET ?examId= → كل الأسئلة مع إجاباتها النموذجية (للإدارة فقط)
// PATCH → تعديل سؤال / اعتماد / رفض / حذف سؤال
// POST { examId, action: 'APPROVE_ALL' } → اعتماد الكل ونشر الامتحان للطلاب

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const examId = req.nextUrl.searchParams.get('examId')
    if (!examId) return NextResponse.json({ error: 'معرف الاختبار مطلوب' }, { status: 400 })

    const exam = await db.programExam.findUnique({
      where: { id: examId },
      include: { questions: { orderBy: { order: 'asc' } } },
    })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود' }, { status: 404 })

    return NextResponse.json({
      exam: { id: exam.id, title: exam.title, status: exam.status, semester: exam.semester },
      questions: exam.questions.map((q) => ({
        id: q.id,
        order: q.order,
        type: q.type,
        text: q.text,
        options: q.options ? JSON.parse(q.options) : null,
        correctAnswer: q.correctAnswer,
        modelAnswer: q.modelAnswer,
        points: q.points,
        status: q.status,
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin exam questions GET error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الأسئلة' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { questionId, action, text, options, correctAnswer, modelAnswer, points } = await req.json()
    if (!questionId || !action) return NextResponse.json({ error: 'بيانات غير مكتملة' }, { status: 400 })

    const existing = await db.programQuestion.findUnique({ where: { id: questionId }, include: { exam: { select: { id: true, title: true } } } })
    if (!existing) return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 })

    if (action === 'EDIT') {
      const data: any = {}
      if (text != null && String(text).trim()) data.text = String(text).trim().slice(0, 3000)
      if (options != null) {
        const opts = (Array.isArray(options) ? options : []).map((o: any) => String(o).trim()).filter(Boolean)
        if (opts.length >= 2) data.options = JSON.stringify(opts)
      }
      if (correctAnswer != null) data.correctAnswer = String(correctAnswer)
      if (modelAnswer != null) data.modelAnswer = String(modelAnswer).slice(0, 4000)
      if (points != null && Number(points) > 0) data.points = Math.max(1, Math.min(50, Math.round(Number(points))))
      await db.programQuestion.update({ where: { id: questionId }, data })
      await audit({ id: admin.id, name: admin.name }, 'EDIT_EXAM_QUESTION', 'ProgramQuestion', questionId, existing.exam.title)
      return NextResponse.json({ ok: true })
    }

    if (action === 'APPROVE' || action === 'REJECT') {
      await db.programQuestion.update({
        where: { id: questionId },
        data: { status: action === 'APPROVE' ? 'PUBLISHED' : 'REJECTED' },
      })
      await audit(
        { id: admin.id, name: admin.name },
        action === 'APPROVE' ? 'APPROVE_EXAM_QUESTION' : 'REJECT_EXAM_QUESTION',
        'ProgramQuestion',
        questionId,
        existing.exam.title
      )
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin exam questions PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تنفيذ الإجراء' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { examId, action } = await req.json()
    if (!examId || action !== 'APPROVE_ALL') return NextResponse.json({ error: 'بيانات غير مكتملة' }, { status: 400 })

    const exam = await db.programExam.findUnique({
      where: { id: examId },
      include: { questions: { select: { id: true, status: true } } },
    })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود' }, { status: 404 })

    // اعتماد كل الأسئلة المعلقة + إعادة تفعيل المرفوض تلقائياً غير موجود — المرفوض يبقى خارج الامتحان
    const result = await db.programQuestion.updateMany({
      where: { examId, status: 'PENDING_REVIEW' },
      data: { status: 'PUBLISHED' },
    })

    const published = await db.programQuestion.count({ where: { examId, status: 'PUBLISHED' } })
    if (published < 10) {
      return NextResponse.json(
        { error: `عدد الأسئلة المعتمدة (${published}) لا يكفي لنشر الامتحان — الحد الأدنى 10 أسئلة معتمدة` },
        { status: 400 }
      )
    }

    // إعادة حساب مجموع النقاط والمدة بعد الاعتماد
    const publishedQuestions = await db.programQuestion.findMany({ where: { examId, status: 'PUBLISHED' }, select: { points: true } })
    const totalPoints = publishedQuestions.reduce((s, q) => s + q.points, 0)
    const totalQ = publishedQuestions.length

    await db.programExam.update({
      where: { id: examId },
      data: {
        status: 'READY',
        totalPoints,
        durationMin: Math.max(120, Math.min(240, Math.round(totalQ * 2))),
      },
    })

    await audit(
      { id: admin.id, name: admin.name },
      'PUBLISH_PROGRAM_EXAM',
      'ProgramExam',
      examId,
      `اعتماد ونشر ${totalQ} سؤالاً (${result.count} سؤالاً اعتمدت الآن)`
    )

    // إشعار كل الطلاب المسجلين والمفعّل تسجيلهم — الامتحان صار متاحاً
    const enrolled = await db.enrollment.findMany({
      where: { programId: exam.programId, status: { in: ['ACTIVE', 'COMPLETED'] } },
      select: { userId: true },
      include: { user: { select: { email: true, name: true } } },
    })
    const semesterLabel = exam.semester === 2 ? 'الفصل الثاني' : 'الفصل الأول'
    const examDuration = Math.max(120, Math.min(240, Math.round(totalQ * 2)))
    for (const en of enrolled) {
      await notify(
        en.userId,
        'GENERAL',
        `امتحان ${semesterLabel} متاح الآن`,
        `اعتمدت الإدارة أسئلة «${exam.title}» ونشرتها: ${totalQ} سؤالاً متنوعاً ومدة ${examDuration} دقيقة. راجع الكتب المقررة ثم ابدأ من بوابة الطالب.`,
        'dashboard'
      )
      // إشعار بريدي للطالب بجاهزية الامتحان
      if (en.user?.email) {
        emailExamPublished(en.user.email, en.user.name, exam.title, totalQ, examDuration).catch(() => {})
      }
    }

    return NextResponse.json({ ok: true, published: totalQ, approvedNow: result.count })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin exam questions POST error:', e)
    return NextResponse.json({ error: 'تعذر اعتماد الأسئلة' }, { status: 500 })
  }
}
