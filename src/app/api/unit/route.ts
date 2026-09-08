import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

// GET /api/unit?id=xxx — محتوى الوحدة التدريبية للمسجلين فقط
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const unitId = req.nextUrl.searchParams.get('id')
    if (!unitId) return NextResponse.json({ error: 'معرف الوحدة مطلوب' }, { status: 400 })

    const unit = await db.unit.findUnique({
      where: { id: unitId },
      include: {
        program: { select: { id: true, titleAr: true, slug: true } },
        exam: { select: { id: true, title: true, passScore: true } },
      },
    })
    if (!unit) return NextResponse.json({ error: 'الوحدة غير موجودة' }, { status: 404 })

    const enrollment = await db.enrollment.findUnique({
      where: { userId_programId: { userId: user.id, programId: unit.programId } },
    })
    if (!enrollment) {
      return NextResponse.json({ error: 'يجب التسجيل في البرنامج أولاً' }, { status: 403 })
    }
    if (enrollment.status === 'PENDING_PAYMENT') {
      return NextResponse.json(
        { error: 'تسجيلك بانتظار سداد الفاتورة — أكمل الدفع لفتح محتوى الوحدات', code: 'PENDING_PAYMENT' },
        { status: 402 }
      )
    }

    // الكتب المقررة للبرنامج + امتحانات الفصول المبنية عليها (منشورة فقط)
    const [books, readyExams] = await Promise.all([
      db.book.findMany({
        where: { programId: unit.programId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, title: true, author: true, year: true, fileName: true, link: true, source: true },
      }),
      db.programExam.findMany({
        where: { programId: unit.programId, status: 'READY' },
        orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }],
        select: { id: true, title: true, semester: true, durationMin: true, passScore: true },
      }),
    ])
    const semesterExams = await Promise.all(
      readyExams.map(async (e) => ({
        id: e.id,
        title: e.title,
        semester: e.semester,
        durationMin: e.durationMin,
        passScore: e.passScore,
        questionCount: await db.programQuestion.count({ where: { examId: e.id, status: 'PUBLISHED' } }),
      }))
    )
    const finalExam = semesterExams.filter((e) => e.questionCount > 0)[0] || null

    return NextResponse.json({
      unit: {
        id: unit.id,
        order: unit.order,
        title: unit.title,
        summary: unit.summary,
        content: JSON.parse(unit.content || '[]'),
        objectives: JSON.parse(unit.objectives || '[]'),
        exam: unit.exam,
      },
      program: unit.program,
      books: books.map((b) => ({ id: b.id, title: b.title, author: b.author, year: b.year, hasFile: !!b.fileName, link: b.link, source: b.source })),
      finalExam,
      semesterExams: semesterExams.filter((e) => e.questionCount > 0),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    console.error('Unit error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الوحدة' }, { status: 500 })
  }
}
