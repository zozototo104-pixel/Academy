import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runExtractStep } from '@/lib/book-reader'
import { runAnalyzeStep, runEnrichStep } from '@/lib/book-chunk-analyzer'
import { BOOK_READ_RETRY_MS, claimBookReadLock } from '@/lib/book-read-job-control'
import { runNextQuestionBankGenerationJobStep } from '@/lib/question-bank-job'
import { textAiCheckAllModelHealth } from '@/lib/text-ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  const endAt = Date.now() + 240_000
  const outcomes: { jobId: string; outcome: string }[] = []
  while (Date.now() < endAt - 48_000) {
    const questionJob = await runNextQuestionBankGenerationJobStep()
    if (!questionJob) break
    outcomes.push({ jobId: questionJob.id, outcome: `QUESTION_BANK_${questionJob.status}` })
    if (questionJob.status === 'RUNNING') break
    if (!['QUEUED'].includes(questionJob.status)) break
  }
  // Select only eligible jobs; the atomic lock still decides which worker owns each job.
  const jobs = await db.bookReadJob.findMany({
    where: { OR: [
      { status: { in: ['QUEUED', 'RUNNING'] } },
      { status: 'PAUSED', retryAt: { lte: new Date() } },
    ] },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: { id: true, phase: true },
  })
  for (const job of jobs) {
    if (Date.now() >= endAt - 48_000) break
    if (!(await claimBookReadLock(db, job.id))) {
      outcomes.push({ jobId: job.id, outcome: 'LOCKED' })
      continue
    }
    try {
      const deadline = Math.min(Date.now() + 240_000, endAt)
      if (job.phase === 'EXTRACT') {
        const extraction = await runExtractStep(job.id, deadline)
        if (extraction.phase === 'ANALYZE' && Date.now() < deadline - 1500) await runAnalyzeStep(job.id, deadline)
      } else if (job.phase === 'ANALYZE') {
        await runAnalyzeStep(job.id, deadline)
      } else if (job.phase === 'ENRICH') {
        await runEnrichStep(job.id, deadline)
      }
      const current = await db.bookReadJob.findUnique({ where: { id: job.id }, select: { status: true } })
      if (current?.status !== 'COMPLETED') await db.bookReadJob.update({ where: { id: job.id }, data: { status: 'QUEUED', lockedUntil: null, retryAt: null, lastError: null } })
      outcomes.push({ jobId: job.id, outcome: current?.status === 'COMPLETED' ? 'COMPLETED' : 'PROGRESSED' })
    } catch (error: any) {
      const message = String(error?.message || error)
      const paused = message.includes('AI_ACADEMIC_PROVIDER_UNAVAILABLE')
      await db.bookReadJob.update({ where: { id: job.id }, data: {
        status: paused ? 'PAUSED' : 'FAILED',
        retryAt: paused ? new Date(Date.now() + BOOK_READ_RETRY_MS) : null,
        lockedUntil: null,
        lastError: message.slice(0, 2000),
      } })
      outcomes.push({ jobId: job.id, outcome: paused ? 'PAUSED' : 'FAILED' })
    }
  }
  return NextResponse.json({ ok: true, processed: outcomes.length, outcomes }, { headers: { 'Cache-Control': 'no-store' } })
}
