import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { runExtractStep } from '@/lib/book-reader'
import { runAnalyzeStep } from '@/lib/book-chunk-analyzer'
import { BOOK_READ_RETRY_MS, claimBookReadLock } from '@/lib/book-read-job-control'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  const deadline = Date.now() + 250_000
  const processed: Array<{ id: string; outcome: string }> = []
  try {
    const now = new Date()
    const jobs = await db.bookReadJob.findMany({
      where: { OR: [
        { status: { in: ['QUEUED', 'RUNNING'] } },
        { status: 'PAUSED', retryAt: { lte: now } },
      ] },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, phase: true },
    })
    for (const job of jobs) {
      if (Date.now() >= deadline - 48_000) break
      if (!(await claimBookReadLock(db, job.id))) {
        processed.push({ id: job.id, outcome: 'LOCKED_OR_NOT_DUE' })
        continue
      }
      try {
        const stepDeadline = Math.min(deadline, Date.now() + 45_000)
        if (job.phase === 'EXTRACT') {
          const extraction = await runExtractStep(job.id, stepDeadline)
          if (extraction.phase === 'ANALYZE' && Date.now() < stepDeadline - 1500) await runAnalyzeStep(job.id, stepDeadline)
        } else if (job.phase === 'ANALYZE') {
          await runAnalyzeStep(job.id, stepDeadline)
        }
        const current = await db.bookReadJob.findUnique({ where: { id: job.id }, select: { status: true } })
        if (current?.status !== 'COMPLETED') await db.bookReadJob.update({ where: { id: job.id }, data: { status: 'QUEUED', lockedUntil: null, retryAt: null, lastError: null } })
        processed.push({ id: job.id, outcome: current?.status === 'COMPLETED' ? 'COMPLETED' : 'QUEUED' })
      } catch (error: any) {
        const message = String(error?.message || error)
        const paused = message.includes('AI_ACADEMIC_PROVIDER_UNAVAILABLE')
        await db.bookReadJob.update({ where: { id: job.id }, data: {
          status: paused ? 'PAUSED' : 'FAILED',
          retryAt: paused ? new Date(Date.now() + BOOK_READ_RETRY_MS) : null,
          lockedUntil: null,
          lastError: message.slice(0, 2000),
        } })
        processed.push({ id: job.id, outcome: paused ? 'PAUSED' : 'FAILED' })
      }
    }
    return NextResponse.json({ ok: true, processed, remainingBudgetMs: Math.max(0, deadline - Date.now()) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: 500 })
  }
}
