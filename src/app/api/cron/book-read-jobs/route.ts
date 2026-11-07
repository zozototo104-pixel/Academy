import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { claimAiHealthRun } from '@/lib/ai-health'
import { runExtractStep } from '@/lib/book-reader'
import { runAnalyzeStep, runEnrichStep } from '@/lib/book-chunk-analyzer'
import { BOOK_READ_RETRY_MS, BOOK_READ_TRANSIENT_RETRY_MS, claimBookReadLock, classifyBookReadFailure, preserveBookPageReadIssues } from '@/lib/book-read-job-control'
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

  if (Date.now() < endAt - 90_000 && await claimAiHealthRun()) {
    const health = await textAiCheckAllModelHealth({ maxMs: 40_000 }).catch((error) => ({ checked: 0, results: [], error: String((error as any)?.message || error) }))
    outcomes.push({ jobId: 'AI_MODEL_HEALTH', outcome: `CHECKED_${health.checked}` })
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
      if (current?.status !== 'COMPLETED') await db.bookReadJob.update({ where: { id: job.id }, data: { status: 'QUEUED', lockedUntil: null, retryAt: null } })
      outcomes.push({ jobId: job.id, outcome: current?.status === 'COMPLETED' ? 'COMPLETED' : 'PROGRESSED' })
    } catch (error: any) {
      const message = String(error?.message || error)
      const providerUnavailable = message.includes('AI_ACADEMIC_PROVIDER_UNAVAILABLE')
      // Four-way handling, identical to the manual read-step driver
      // (Haris's taxonomy): pressure pauses and auto-retries; proven
      // billing exhaustion and missing configuration stop the job with
      // a clear operator message instead of futile retries; the rest
      // fails. The cron must not diverge from the button's behavior.
      const kind = classifyBookReadFailure(message)
      const transient = kind === 'TRANSIENT'
      const adminMessage = kind === 'BILLING'
        ? `نفد رصيد جميع المزودين المتاحين — عبّئ الرصيد أو فعّل مزوّدًا بديلًا ثم أعد بدء القراءة. التفاصيل: ${message}`
        : kind === 'CONFIG'
          ? `خطأ إعدادات: لا يوجد مزوّد ذكاء مُعدّ بمفتاح صالح — راجع إعدادات النظام ومفاتيح المزودين ثم أعد بدء القراءة. التفاصيل: ${message}`
          : message
      const previous = await db.bookReadJob.findUnique({ where: { id: job.id }, select: { lastError: true } })
      await db.bookReadJob.update({ where: { id: job.id }, data: {
        status: transient ? 'PAUSED' : 'FAILED',
        retryAt: transient ? new Date(Date.now() + (providerUnavailable ? BOOK_READ_RETRY_MS : BOOK_READ_TRANSIENT_RETRY_MS)) : null,
        lockedUntil: null,
        // Keep the per-page issue ledger alongside the operator message,
        // exactly as the read-step path does.
        lastError: preserveBookPageReadIssues(previous?.lastError, adminMessage),
      } })
      outcomes.push({ jobId: job.id, outcome: transient ? 'PAUSED' : 'FAILED' })
    }
  }
  return NextResponse.json({ ok: true, processed: outcomes.length, outcomes }, { headers: { 'Cache-Control': 'no-store' } })
}
