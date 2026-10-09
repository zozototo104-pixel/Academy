import { after, NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { questionBankJobCanRunStep, questionBankJobHasActiveLock, readQuestionBankJobTrace, runQuestionBankGenerationJobStep } from '@/lib/question-bank-job'
import { selectUnitExamQuestionsApprovedFirst, unitExamRequiredQuestions } from '@/lib/unit-exam-policy'

export const runtime = 'nodejs'
export const maxDuration = 300
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
    let job = await db.questionBankGenerationJob.findUnique({ where: { id: jobId } })
    if (!job) return NextResponse.json({ error: 'وظيفة بنك الأسئلة غير موجودة' }, { status: 404 })
    const candidates = job.unitId
      ? await db.questionBankItem.findMany({
          where: { programId: job.programId, unitId: job.unitId, qualityFlags: { contains: 'SOURCE_GROUNDED' }, status: { in: ['APPROVED', 'PENDING_REVIEW'] } },
          select: { id: true, status: true, qualityFlags: true },
          orderBy: [{ status: 'asc' }, { usageCount: 'asc' }, { createdAt: 'desc' }],
        })
      : []
    const selection = selectUnitExamQuestionsApprovedFirst(candidates, job.requested)
    const activeLock = questionBankJobHasActiveLock(job)
    if (job.unitId && selection.readyToBuild && !activeLock && job.status !== 'COMPLETED') {
      await db.questionBankGenerationJob.updateMany({ where: { id: job.id, status: { not: 'COMPLETED' } }, data: { status: 'COMPLETED', lockedUntil: null, retryAt: null, lastError: null, finishedAt: new Date(), saved: Math.max(job.saved, selection.currentEligibleCount) } })
      job = await db.questionBankGenerationJob.findUnique({ where: { id: jobId } }) || job
    } else if (!selection.readyToBuild && questionBankJobCanRunStep(job)) {
      after(() => runQuestionBankGenerationJobStep(job.id).catch((error) => console.error('question bank job status after() step failed:', error)))
    }
    const trace = await readQuestionBankJobTrace(job.id)
    const approvedQuestions = candidates.filter((row) => row.status === 'APPROVED').length
    const pendingReviewQuestions = candidates.filter((row) => row.status === 'PENDING_REVIEW').length
    return NextResponse.json({
      job: {
        id: job.id,
        programId: job.programId,
        unitId: job.unitId,
        status: job.status,
        requested: job.requested,
        saved: job.saved,
        currentQuestions: selection.currentEligibleCount,
        readyToBuild: selection.readyToBuild,
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
