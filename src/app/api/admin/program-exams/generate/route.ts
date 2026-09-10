import { NextRequest, NextResponse, after } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { fallbackExamQuestionBatch, generateExamQuestionBatch, EXAM_BATCH_COUNT, EXAM_BATCH_SPECS } from '@/lib/books-ai'
import { hydrateBookContentForExam } from '@/lib/book-content'

export const runtime = 'nodejs'
export const maxDuration = 300

function totalRequiredQuestions(): number {
  return EXAM_BATCH_SPECS.reduce((sum, b) => sum + b.count, 0)
}

function firstMissingBatchIndex(existingCount: number): number {
  let cumulative = 0
  for (let i = 0; i < EXAM_BATCH_SPECS.length; i++) {
    cumulative += EXAM_BATCH_SPECS[i].count
    if (existingCount < cumulative) return i
  }
  return EXAM_BATCH_COUNT
}

async function isExamStillGenerating(examId: string): Promise<boolean> {
  const row = await db.programExam.findUnique({ where: { id: examId }, select: { status: true } })
  return row?.status === 'GENERATING'
}

async function stopGenerationAndExposeReview(examId: string, admin: { id: string; name: string }) {
  const exam = await db.programExam.findUnique({
    where: { id: examId },
    include: { program: { select: { titleAr: true } } },
  })
  if (!exam) return { error: 'الامتحان غير موجود', statusCode: 404 }
  if (exam.status === 'READY') return { error: 'الامتحان منشور بالفعل ولا يمكن إيقاف توليده', statusCode: 409 }

  const questions = await db.programQuestion.findMany({ where: { examId }, select: { points: true } })
  const questionCount = questions.length
  const totalPoints = questions.reduce((sum, q) => sum + q.points, 0)
  const nextStatus = questionCount > 0 ? 'REVIEW' : 'FAILED'
  const errorNote = questionCount > 0
    ? `تم إيقاف التوليد يدوياً بعد حفظ ${questionCount} سؤالاً — الأسئلة جاهزة للمراجعة والتعديل قبل النشر`
    : 'تم إيقاف التوليد يدوياً قبل توليد أي سؤال'

  await db.programExam.update({
    where: { id: examId },
    data: {
      status: nextStatus,
      errorNote,
      totalPoints,
      durationMin: questionCount > 0 ? Math.max(120, Math.min(240, Math.round(questionCount * 2))) : exam.durationMin,
    },
  })

  await audit(
    { id: admin.id, name: admin.name },
    'STOP_PROGRAM_EXAM_GENERATION',
    'ProgramExam',
    examId,
    `إيقاف توليد امتحان ${exam.program.titleAr} بعد ${questionCount} سؤال`
  )

  return { ok: true, examId, status: nextStatus, questionCount, totalPoints }
}

function scheduleGeneration(examId: string) {
  after(() => {
    runGeneration(examId).catch((e) => console.error('scheduled program exam generation failed:', e))
  })
}

async function ensureStarterQuestions(examId: string): Promise<{ inserted: number; questionCount: number }> {
  const exam = await db.programExam.findUnique({
    where: { id: examId },
    include: { program: { select: { id: true, titleAr: true, titleEn: true, category: true, description: true } } },
  })
  if (!exam || exam.status === 'READY') return { inserted: 0, questionCount: 0 }

  const existingCount = await db.programQuestion.count({ where: { examId } })
  if (existingCount > 0) return { inserted: 0, questionCount: existingCount }

  const books = await db.book.findMany({
    where: { programId: exam.programId, OR: [{ semester: null }, { semester: exam.semester }] },
    orderBy: { createdAt: 'asc' },
    select: { title: true, titleEn: true, author: true, year: true, description: true, link: true, textContent: true },
  })
  if (books.length === 0) return { inserted: 0, questionCount: 0 }

  const batchIndex = firstMissingBatchIndex(existingCount)
  if (batchIndex >= EXAM_BATCH_COUNT) return { inserted: 0, questionCount: existingCount }

  const batch = fallbackExamQuestionBatch(exam.program, books, batchIndex)
  if (batch.length === 0) return { inserted: 0, questionCount: existingCount }

  await db.programQuestion.createMany({
    data: batch.map((q, index) => ({
      examId,
      order: index + 1,
      type: q.type,
      text: q.text,
      options: q.options ? JSON.stringify(q.options) : null,
      correctAnswer: q.correct ?? null,
      modelAnswer: q.modelAnswer ?? null,
      points: q.points || 2,
      status: 'PENDING_REVIEW',
    })),
  })

  const totalPoints = batch.reduce((sum, q) => sum + (q.points || 2), 0)
  await db.programExam.update({
    where: { id: examId },
    data: {
      status: 'GENERATING',
      durationMin: Math.max(120, Math.min(240, Math.round(batch.length * 2))),
      totalPoints,
      errorNote: 'تم إنشاء دفعة أولية فوراً حتى لا يبقى الامتحان على صفر أسئلة — ويستمر الذكاء بمحاولة استكمال باقي الدفعات',
      booksUsed: books.map((b) => `«${b.title}»`).join('، ').slice(0, 2000),
    },
  })

  return { inserted: batch.length, questionCount: batch.length }
}

// ===== التوليد الخلفي لامتحان الفصل الدراسي من الكتب =====
// 12.2: كل برنامج له امتحانان (فصل أول + فصل ثانٍ) — الأسئلة تولد بحالة "بانتظار مراجعة الإدارة"
// (Human-in-the-loop) ولا تُنشر للطلاب إلا بعد اعتماد الإدارة.

async function runGeneration(examId: string) {
  try {
    const exam = await db.programExam.findUnique({
      where: { id: examId },
      include: { program: { select: { id: true, titleAr: true, titleEn: true, category: true, description: true } } },
    })
    if (!exam || exam.status !== 'GENERATING') return

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
      if (!(await isExamStillGenerating(examId))) return
      const hydrated = await hydrateBookContentForExam(book)
      hydratedBooks.push(hydrated)
      if (hydrated.shouldPersistText && hydrated.id && hydrated.textContent.length >= 160) {
        await db.book.update({
          where: { id: hydrated.id },
          data: { textContent: hydrated.textContent.slice(0, 40000) },
        }).catch(() => {})
      }
    }

    const existingCount = await db.programQuestion.count({ where: { examId } })
    const maxOrder = await db.programQuestion.aggregate({ where: { examId }, _max: { order: true } })
    let order = maxOrder._max.order || existingCount || 0
    const startBatch = firstMissingBatchIndex(existingCount)

    for (let i = startBatch; i < EXAM_BATCH_COUNT; i++) {
      if (!(await isExamStillGenerating(examId))) return
      const spec = EXAM_BATCH_SPECS[i]
      let batch = await generateExamQuestionBatch(exam.program, hydratedBooks, i)
      if (batch.length === 0) {
        // إعادة محاولة واحدة عند فشل الدفعة
        batch = await generateExamQuestionBatch(exam.program, hydratedBooks, i)
      }
      if (batch.length === 0) throw new Error(`فشل توليد الدفعة ${i + 1} من الأسئلة`)
      if (!(await isExamStillGenerating(examId))) return

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

    await db.programExam.updateMany({
      where: { id: examId, status: 'GENERATING' },
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
      .updateMany({
        where: { id: examId, status: 'GENERATING' },
        data: { status: 'FAILED', errorNote: String(e?.message || 'خطأ غير متوقع أثناء التوليد').slice(0, 500) },
      })
      .catch(() => {})
  }
}

// POST /api/admin/program-exams/generate — بدء أو استكمال توليد امتحان فصل دراسي من الكتب المقررة
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const examId = String(body?.examId || '').trim()
    const programId = String(body?.programId || '').trim()
    const sem = Number(body?.semester) === 2 ? 2 : 1

    if (body?.action === 'stop') {
      if (!examId) return NextResponse.json({ error: 'معرف الامتحان مطلوب لإيقاف التوليد' }, { status: 400 })
      const stopped = await stopGenerationAndExposeReview(examId, { id: admin.id, name: admin.name })
      if ('error' in stopped) return NextResponse.json({ error: stopped.error }, { status: stopped.statusCode || 400 })
      return NextResponse.json(stopped)
    }

    if (body?.action === 'kick') {
      if (!examId) return NextResponse.json({ error: 'معرف الامتحان مطلوب لتحريك التوليد' }, { status: 400 })
      const existing = await db.programExam.findUnique({ where: { id: examId }, select: { id: true, status: true } })
      if (!existing) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
      if (existing.status === 'READY') return NextResponse.json({ error: 'الامتحان منشور بالفعل' }, { status: 409 })
      if (existing.status !== 'GENERATING') {
        await db.programExam.update({ where: { id: examId }, data: { status: 'GENERATING', errorNote: null } })
      }
      const starter = await ensureStarterQuestions(examId)
      scheduleGeneration(examId)
      return NextResponse.json({ ok: true, examId, kicked: true, ...starter, requiredQuestions: totalRequiredQuestions() })
    }

    if (examId) {
      const existing = await db.programExam.findUnique({
        where: { id: examId },
        include: {
          program: { select: { id: true, titleAr: true, category: true } },
          _count: { select: { questions: true } },
        },
      })
      if (!existing) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
      if (existing.status === 'GENERATING') {
        const starter = await ensureStarterQuestions(existing.id)
        scheduleGeneration(existing.id)
        return NextResponse.json({
          ok: true,
          examId: existing.id,
          resumed: true,
          kicked: true,
          existingQuestions: starter.questionCount,
          inserted: starter.inserted,
          requiredQuestions: totalRequiredQuestions(),
        })
      }
      if (existing.status === 'READY') {
        return NextResponse.json({ error: 'الامتحان منشور للطلاب — استخدم زر الحذف إذا أردت إنشاء امتحان جديد بالكامل' }, { status: 409 })
      }

      const booksCount = await db.book.count({
        where: { programId: existing.programId, OR: [{ semester: null }, { semester: existing.semester }] },
      })
      if (booksCount === 0) {
        return NextResponse.json(
          { error: `لا توجد كتب مقررة للفصل ${existing.semester === 2 ? 'الثاني' : 'الأول'} — أضف كتباً لهذا الفصل أو اجعل بعض الكتب «عامة للبرنامج»` },
          { status: 400 }
        )
      }

      await db.programExam.update({
        where: { id: existing.id },
        data: { status: 'GENERATING', errorNote: null },
      })

      await audit(
        { id: admin.id, name: admin.name },
        'RESUME_PROGRAM_EXAM_GENERATION',
        'ProgramExam',
        existing.id,
        `استكمال توليد امتحان الفصل ${existing.semester === 2 ? 'الثاني' : 'الأول'} من السؤال ${existing._count.questions + 1} لبرنامج ${existing.program.titleAr}`
      )

      scheduleGeneration(existing.id)

      return NextResponse.json({
        ok: true,
        examId: existing.id,
        booksCount,
        semester: existing.semester,
        resumed: true,
        existingQuestions: existing._count.questions,
        requiredQuestions: totalRequiredQuestions(),
      })
    }

    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

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
      const starter = await ensureStarterQuestions(generating.id)
      scheduleGeneration(generating.id)
      return NextResponse.json({
        ok: true,
        examId: generating.id,
        booksCount,
        semester: generating.semester,
        resumed: true,
        kicked: true,
        existingQuestions: starter.questionCount,
        inserted: starter.inserted,
        requiredQuestions: totalRequiredQuestions(),
      })
    }

    const existingSemExam = await db.programExam.findFirst({ where: { programId, semester: sem, status: { in: ['REVIEW', 'READY'] } } })
    if (existingSemExam) {
      return NextResponse.json(
        { error: `يوجد امتحان معتمد أو بانتظار المراجعة للفصل ${sem === 2 ? 'الثاني' : 'الأول'} — استخدم زر حذف الامتحان إذا أردت توليد نسخة جديدة بالكامل` },
        { status: 409 }
      )
    }

    const failedSemExam = await db.programExam.findFirst({
      where: { programId, semester: sem, status: 'FAILED' },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { questions: true } } },
    })
    if (failedSemExam) {
      await db.programExam.update({ where: { id: failedSemExam.id }, data: { status: 'GENERATING', errorNote: null } })
      await audit(
        { id: admin.id, name: admin.name },
        'RESUME_PROGRAM_EXAM_GENERATION',
        'ProgramExam',
        failedSemExam.id,
        `استكمال توليد امتحان فاشل سابقاً للفصل ${sem === 2 ? 'الثاني' : 'الأول'} من السؤال ${failedSemExam._count.questions + 1} لبرنامج ${program.titleAr}`
      )
      const starter = await ensureStarterQuestions(failedSemExam.id)
      scheduleGeneration(failedSemExam.id)
      return NextResponse.json({
        ok: true,
        examId: failedSemExam.id,
        booksCount,
        semester: sem,
        resumed: true,
        existingQuestions: starter.questionCount || failedSemExam._count.questions,
        inserted: starter.inserted,
        requiredQuestions: totalRequiredQuestions(),
      })
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
    scheduleGeneration(exam.id)

    return NextResponse.json({ ok: true, examId: exam.id, booksCount, semester: sem, resumed: false, requiredQuestions: totalRequiredQuestions() })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program-exam generate error:', e)
    return NextResponse.json({ error: 'تعذر بدء التوليد' }, { status: 500 })
  }
}
