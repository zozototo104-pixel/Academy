import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

const ACTIVE_STATUSES = new Set(['GENERATING', 'RUNNING', 'QUEUED', 'PENDING'])

// GET /api/admin/program-exams/progress?programId=xxx — lightweight polling payload
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = req.nextUrl.searchParams.get('programId')?.trim()
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const [exams, bankCounts] = await Promise.all([
      db.programExam.findMany({
        where: { programId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          errorNote: true,
          durationMin: true,
          passScore: true,
          booksUsed: true,
          createdAt: true,
          questions: { select: { type: true, points: true, status: true } },
        },
      }),
      db.questionBankItem.groupBy({ by: ['status'], where: { programId }, _count: { _all: true } }),
    ])
    const bankApproved = bankCounts.find((row) => row.status === 'APPROVED')?._count._all || 0
    const bankPendingReview = bankCounts.find((row) => row.status === 'PENDING_REVIEW')?._count._all || 0

    const progress = exams.map((exam) => {
      const byType: Record<string, number> = {}
      let totalPoints = 0
      let pendingReview = 0
      let rejectedCount = 0
      for (const q of exam.questions) {
        const type = q.type || 'UNKNOWN'
        byType[type] = (byType[type] || 0) + 1
        totalPoints += Number(q.points || 0)
        if (q.status === 'PENDING_REVIEW') pendingReview++
        if (q.status === 'REJECTED') rejectedCount++
      }
      return {
        id: exam.id,
        status: exam.status,
        errorNote: exam.errorNote,
        durationMin: exam.durationMin,
        passScore: exam.passScore,
        booksUsed: exam.booksUsed,
        questionCount: exam.questions.length,
        byType,
        totalPoints,
        pendingReview,
        rejectedCount,
        createdAt: exam.createdAt,
      }
    })

    return NextResponse.json({
      exams: progress,
      active: progress.some((exam) => ACTIVE_STATUSES.has(exam.status)),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin program-exams progress GET error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل تقدم الاختبارات' }, { status: 500 })
  }
}
