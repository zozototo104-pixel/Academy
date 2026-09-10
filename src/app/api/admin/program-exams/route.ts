import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { fallbackExamQuestionBatch } from '@/lib/books-ai'

async function seedStarterForZeroQuestionGeneratingExams(programId: string) {
  const stuck = await db.programExam.findMany({
    where: { programId, status: 'GENERATING', questions: { none: {} } },
    include: { program: { select: { id: true, titleAr: true, titleEn: true, category: true, description: true } } },
  })

  for (const exam of stuck) {
    const books = await db.book.findMany({
      where: { programId: exam.programId, OR: [{ semester: null }, { semester: exam.semester }] },
      orderBy: { createdAt: 'asc' },
      select: { title: true, titleEn: true, author: true, year: true, description: true, link: true, textContent: true },
    })
    if (books.length === 0) continue

    const batch = fallbackExamQuestionBatch(exam.program, books, 0)
    if (batch.length === 0) continue

    await db.programQuestion.createMany({
      data: batch.map((q, index) => ({
        examId: exam.id,
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
      where: { id: exam.id },
      data: {
        durationMin: Math.max(120, Math.min(240, Math.round(batch.length * 2))),
        totalPoints,
        errorNote: 'تم إنشاء دفعة أولية تلقائياً لأن التوليد بقي على صفر أسئلة — يمكنك الإيقاف للمراجعة أو التحريك للاستكمال',
        booksUsed: books.map((b) => `«${b.title}»`).join('، ').slice(0, 2000),
      },
    })
  }
}

// GET /api/admin/program-exams?programId=xxx — قائمة الاختبارات الشاملة المولدة
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = req.nextUrl.searchParams.get('programId')
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    await seedStarterForZeroQuestionGeneratingExams(programId)

    const exams = await db.programExam.findMany({
      where: { programId },
      orderBy: { createdAt: 'desc' },
      include: {
        questions: { select: { type: true, points: true, status: true } },
        _count: { select: { attempts: true } },
      },
    })

    return NextResponse.json({
      exams: exams.map((e) => {
        const byType: Record<string, number> = {}
        let totalPoints = 0
        let pending = 0
        let rejected = 0
        for (const q of e.questions) {
          byType[q.type] = (byType[q.type] || 0) + 1
          totalPoints += q.points
          if (q.status === 'PENDING_REVIEW') pending++
          if (q.status === 'REJECTED') rejected++
        }
        return {
          id: e.id,
          title: e.title,
          status: e.status,
          semester: e.semester,
          errorNote: e.errorNote,
          durationMin: e.durationMin,
          passScore: e.passScore,
          booksUsed: e.booksUsed,
          questionCount: e.questions.length,
          byType,
          totalPoints,
          pendingReview: pending,
          rejectedCount: rejected,
          attemptsCount: e._count.attempts,
          createdAt: e.createdAt,
        }
      }),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin program-exams GET error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الاختبارات' }, { status: 500 })
  }
}

// DELETE /api/admin/program-exams?id=xxx — حذف اختبار شامل
export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin()
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'معرف الاختبار مطلوب' }, { status: 400 })
    await db.programExam.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin program-exams DELETE error:', e)
    return NextResponse.json({ error: 'تعذر حذف الاختبار' }, { status: 500 })
  }
}
