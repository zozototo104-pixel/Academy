import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

// GET /api/admin/program-exams?programId=xxx — قائمة الاختبارات الشاملة المولدة
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = req.nextUrl.searchParams.get('programId')
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

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
