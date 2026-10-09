import { after, NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { questionBankJobCanRunStep, readQuestionBankJobTrace, runQuestionBankGenerationJobStep } from '@/lib/question-bank-job'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value: unknown, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
    const { id } = await ctx.params
    const jobId = clean(id, 120)
    if (!jobId) return NextResponse.json({ error: 'معرف وظيفة بنك الأسئلة مطلوب' }, { status: 400 })
    const job = await db.questionBankGenerationJob.findUnique({ where: { id: jobId } })
    if (!job) return NextResponse.json({ error: 'وظيفة بنك الأسئلة غير موجودة' }, { status: 404 })
    if (questionBankJobCanRunStep(job)) after(() => runQuestionBankGenerationJobStep(job.id).catch((error) => console.error('question bank job status after() step failed:', error)))
    const [trace, grouped] = await Promise.all([
      readQuestionBankJobTrace(job.id),
      job.unitId
        ? db.questionBankItem.groupBy({
            by: ['status'],
            where: { programId: job.programId, unitId: job.unitId, qualityFlags: { contains: 'SOURCE_GROUNDED' }, status: { in: ['APPROVED', 'PENDING_REVIEW'] } },
            _count: { _all: true },
          })
        : Promise.resolve([] as Array<{ status: string; _count: { _all: number } }>),
    ])
    const approvedQuestions = grouped.find((row) => row.status === 'APPROVED')?._count._all || 0
    const pendingReviewQuestions = grouped.find((row) => row.status === 'PENDING_REVIEW')?._count._all || 0
    return NextResponse.json({
      job: {
        id: job.id,
        programId: job.programId,
        unitId: job.unitId,
        status: job.status,
        requested: job.requested,
        saved: job.saved,
        currentQuestions: approvedQuestions + pendingReviewQuestions,
        approvedQuestions,
        pendingReviewQuestions,
        lastError: job.lastError,
        retryAt: job.retryAt,
        lockedUntil: job.lockedUntil,
        updatedAt: job.updatedAt,
        trace,
      },
    })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank job GET error:', error)
    return NextResponse.json({ error: 'تعذر تحميل حالة وظيفة بنك الأسئلة' }, { status: 500 })
  }
}
