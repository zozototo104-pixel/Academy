import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { generateExamQuestionBatch, EXAM_BATCH_COUNT, EXAM_BATCH_SPECS } from '@/lib/books-ai'
import { hydrateBookContentForExam } from '@/lib/book-content'

// ===== التوليد الخلفي لامتحان الفصل الدراسي من الكتب =====
// 12.2: كل برنامج له امتحانان (فصل أول + فصل ثانٍ) — الأسئلة تولد بحالة "بانتظار مراجعة الإدارة"
// (Human-in-the-loop) ولا تُنشر للطلاب إلا بعد اعتماد الإدارة.

async function runGeneration(examId: string) {
  try {
    const exam = await db.programExam.findUnique({
      where: { id: examId },
      include: { program: { select: { id: true, titleAr: true, titleEn: true, category: true, description: true } } },
    })
    if (!exam) return

    const semester = exam.semester
    const books = await db.book.findMany({
      where: { programId: exam.programId, OR: [{ semester: null }, { semester }] },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        title: true,
        titleEn: true,
        author: true,
        year: true,
        description: true,
        link: true,
        fileName: true,
        mimeType: true,
        size: true,
        data: true,
        textContent: true,
      },
    })
    if (books.length === 0) throw new Error(`لا توجد كتب مقررة للفصل ${semester === 2 ? 'الثاني' : 'الأول'}`)

    const hydratedBooks = []
    for (const book of books) {
      const hydrated = await hydrateBookContentForExam(book)
      hydratedBooks.push(hydrated)
      if (hydrated.shouldPersistText && hydrated.id && hydrated.textContent.length >= 160) {
        await db.book.update({
          where: { id: hydrated.id },
          data: { textContent: hydrated.textContent.slice(0, 40000), updatedAt: new Date() },
        }).catch(() => {})
      }
    }

    let order = 0

    for (let i = 0; i < EXAM_BATCH_COUNT; i++) {
      const spec = EXAM_BATCH_SPECS[i]
      let batch = await generateExamQuestionBatch(exam.program, hydratedBooks, i)
      if (batch.length === 0) {
        // إعادة محاولة واحدة عند فشل الدفعة
        batch = await generateExamQuestionBatch(exam.program, hydratedBooks, i)
      }
      if (batch.length === 0) throw new Error(`فشل توليد الدفعة ${i + 1} من الأسئلة`)

      await db.programQuestion.createMany({
        data: batch.map((q) => ({
          examId,
          order: ++order,
          type: q.type,
          text: q.text,
          options: q.options ? JSON.stringify(q.options) : null,
          correctAnswer: q.correct ?? null,
          modelAnswer: q.modelAnswer ?? null,
          points: q.points || 2,
          status: 'PENDING_REVIEW', // 12.2: مراجعة بشرية قبل النشر
        })),
      })
      const totalNow = await db.programQuestion.count({ where: { examId } })
      await db.programExam.update({
        where: { id: examId },
        data: {
          durationMin: Math.max(120, Math.min(240, Math.round(totalNow * 2))),
          booksUsed: hydratedBooks.map((b) => `«${b.title}» (${b.sourceNote})`).join('، ').slice(0, 2000),
        },
      })
    }

    const allQuestions = await db.programQuestion.findMany({ where: { examId }, select: { points: true } })
    const totalPoints = allQuestions.reduce((s, q) => s + q.points, 0)
    const totalQ = allQuestions.length

    await db.programExam.update({
      where: { id: examId },
      data: {
        // بانتظار مراجعة الإدارة واعتماد الأسئلة قبل النشر للطلاب
        status: 'REVIEW',
        durationMin: Math.max(120, Math.min(240, Math.round(totalQ * 2))),
        totalPoints,
        errorNote: null,
      },
    })
  } catch (e: any) {
    console.error('exam generation error:', e)
    await db.programExam
      .update({
        where: { id: examId },
        data: { status: 'FAILED', errorNote: String(e?.message || 'خطأ غير متوقع أثناء التوليد').slice(0, 500) },
      })
      .catch(() => {})
  }
}

// POST /api/admin/program-exams/generate — بدء توليد امتحان فصل دراسي من الكتب المقررة
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { programId, semester } = await req.json()
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const sem = Number(semester) === 2 ? 2 : 1

    const program = await db.program.findUnique({
      where: { id: programId },
      select: { id: true, titleAr: true, category: true },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const booksCount = await db.book.count({ where: { programId, OR: [{ semester: null }, { semester: sem }] } })
    if (booksCount === 0) {
      return NextResponse.json(
        { error: `لا توجد كتب مقررة للفصل ${sem === 2 ? 'الثاني' : 'الأول'} — أضف كتباً لهذا الفصل أو اجعل بعض الكتب «عامة للبرنامج»` },
        { status: 400 }
      )
    }

    const generating = await db.programExam.findFirst({ where: { programId, status: 'GENERATING' } })
    if (generating) {
      return NextResponse.json({ error: 'هناك اختبار قيد التوليد حالياً — انتظر اكتماله', examId: generating.id }, { status: 409 })
    }

    const existingSemExam = await db.programExam.findFirst({ where: { programId, semester: sem, status: { in: ['REVIEW', 'READY'] } } })
    if (existingSemExam) {
      return NextResponse.json(
        { error: `يوجد امتحان معتمد أو بانتظار المراجعة للفصل ${sem === 2 ? 'الثاني' : 'الأول'} — احذفه أولاً لإعادة التوليد` },
        { status: 409 }
      )
    }

    const semLabel = sem === 2 ? 'الثاني' : 'الأول'
    const exam = await db.programExam.create({
      data: {
        programId,
        semester: sem,
        title: `امتحان الفصل الدراسي ${semLabel} — ${program.titleAr}`,
        status: 'GENERATING',
        durationMin: 120,
        generatedBy: 'AI',
      },
    })

    await audit(
      { id: admin.id, name: admin.name },
      'GENERATE_PROGRAM_EXAM',
      'ProgramExam',
      exam.id,
      `توليد امتحان الفصل ${semLabel} من ${booksCount} كتاب مقرر لبرنامج ${program.titleAr}`
    )

    // التوليد خلفياً — الاستجابة فورية والإدارة تتابع الحالة عبر polling
    runGeneration(exam.id).catch(() => {})

    return NextResponse.json({ ok: true, examId: exam.id, booksCount, semester: sem })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program-exam generate error:', e)
    return NextResponse.json({ error: 'تعذر بدء التوليد' }, { status: 500 })
  }
}
