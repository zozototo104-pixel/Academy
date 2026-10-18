import { NextRequest, NextResponse } from 'next/server'
import { runNextQuestionBankGenerationJobStep } from '@/lib/question-bank-job'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  const endAt = Date.now() + 50_000
  const outcomes: { jobId: string; status: string; saved: number; requested: number }[] = []
  let reason: 'no-job' | 'no-progress' | 'not-queued' | 'time' = 'time'
  let previous: { jobId: string; status: string; saved: number } | null = null

  while (Date.now() < endAt - 5_000) {
    const job = await runNextQuestionBankGenerationJobStep(undefined, { queuedOnly: true })
    if (!job) { reason = 'no-job'; break }
    console.log('[question-bank-cron] step', { jobId: job.id, status: job.status, saved: job.saved, requested: job.requested, lockedUntil: job.lockedUntil, retryAt: job.retryAt, lastError: job.lastError })
    if (previous && previous.jobId === job.id && previous.saved === job.saved && previous.status === job.status) { reason = 'no-progress'; break }
    outcomes.push({ jobId: job.id, status: job.status, saved: job.saved, requested: job.requested })
    previous = { jobId: job.id, status: job.status, saved: job.saved }
    if (job.status !== 'QUEUED') { reason = 'not-queued'; break }
  }
  console.log('[question-bank-cron] done', { processed: outcomes.length, reason })

  return NextResponse.json({ ok: true, processed: outcomes.length, reason, outcomes }, { headers: { 'Cache-Control': 'no-store' } })
}
