import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { claimAiHealthRun } from '@/lib/ai-health'
import { runExtractStep } from '@/lib/book-reader'
import { runAnalyzeStep, runEnrichStep } from '@/lib/book-chunk-analyzer'
import { BOOK_READ_RETRY_MS, BOOK_READ_TRANSIENT_RETRY_MS, claimBookReadLock, releaseBookReadLock, classifyBookReadFailure, preserveBookPageReadIssues } from '@/lib/book-read-job-control'
import { hasActiveBookRepairJob, runBookRepairScanStep } from '@/lib/book-repair-job'
import { loadReadableBookPdfBuffer, resumePendingUnitRegenerations } from '@/lib/unit-regeneration-link'
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
    select: { id: true, bookId: true, phase: true },
  })
  for (const job of jobs) {
    if (Date.now() >= endAt - 48_000) break
    // Criterion 4 (second direction): skip a job while a scan repair is
    // active on its book, without taking its lock — the repair owns the
    // chunks until it finishes or is stopped; the next cron run picks the
    // job up again.
    if (await hasActiveBookRepairJob(job.bookId)) {
      outcomes.push({ jobId: job.id, outcome: 'SKIPPED_REPAIR_ACTIVE' })
      continue
    }
    const claimedAt = new Date()
    if (!(await claimBookReadLock(db, job.id, claimedAt))) {
      outcomes.push({ jobId: job.id, outcome: 'LOCKED' })
      continue
    }
    try {
      const deadline = Math.min(Date.now() + 240_000, endAt)
      if (job.phase === 'EXTRACT') {
        const extraction = await runExtractStep(job.id, deadline, claimedAt)
        if (extraction.phase === 'ANALYZE' && Date.now() < deadline - 1500) await runAnalyzeStep(job.id, deadline, claimedAt)
      } else if (job.phase === 'ANALYZE') {
        await runAnalyzeStep(job.id, deadline, claimedAt)
      } else if (job.phase === 'ENRICH') {
        await runEnrichStep(job.id, deadline, claimedAt)
      }
      // Release only this invocation's lock. The shared helper preserves
      // manual STOP and the historical auto-requeue behavior for other jobs.
      await releaseBookReadLock(db, job.id, claimedAt, true)
      const current = await db.bookReadJob.findUnique({ where: { id: job.id }, select: { status: true, retryAt: true } })
      const manuallyStopped = current?.status === 'PAUSED' && current.retryAt?.getUTCFullYear() === 9999
      outcomes.push({ jobId: job.id, outcome: current?.status === 'COMPLETED' ? 'COMPLETED' : manuallyStopped ? 'PAUSED_BY_ADMIN' : 'PROGRESSED' })
    } catch (error: any) {
      const message = String(error?.message || error)
      if (message === 'BOOK_READ_LEASE_LOST') {
        // An expired/overwritten lease is not a content failure. Requeue
        // only the old owner's still-RUNNING job; CAS preserves a newer
        // worker's lease and the admin's manual PAUSED sentinel.
        await releaseBookReadLock(db, job.id, claimedAt, true)
        outcomes.push({ jobId: job.id, outcome: 'LEASE_LOST' })
        continue
      }
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
      const saved = await db.bookReadJob.updateMany({ where: { id: job.id, status: 'RUNNING', startedAt: claimedAt }, data: {
        status: transient ? 'PAUSED' : 'FAILED',
        retryAt: transient ? new Date(Date.now() + (providerUnavailable ? BOOK_READ_RETRY_MS : BOOK_READ_TRANSIENT_RETRY_MS)) : null,
        lockedUntil: null,
        // Preserve a manual stop and its long-lived retry guard, even when
        // an in-flight provider call fails after the stop request.
        lastError: preserveBookPageReadIssues(previous?.lastError, adminMessage),
      } })
      if (!saved.count) await releaseBookReadLock(db, job.id, claimedAt, true)
      outcomes.push({ jobId: job.id, outcome: saved.count ? (transient ? 'PAUSED' : 'FAILED') : 'STOPPED_OR_COMPLETED' })
    }
  }

  // Repair-first driver (PR #212): an auto-enqueued repair job would sit
  // QUEUED forever — no cron drove repair jobs before this — so the cron
  // advances QUEUED/RUNNING BookRepairJobs one bounded step each, with the
  // same PDF preflight as the SCAN route and the same endAt budget guard.
  // A book is skipped while a read job is active on it (the mirror of the
  // mutual exclusion above: the read job owns the chunks until it
  // finishes or is stopped). A repair step never fails the cron run, and
  // neither does this whole driver section: a driver-level failure is
  // logged and the read-job outcomes above are still returned.
  try {
    const repairJobs = await db.bookRepairJob.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { id: true, bookId: true },
    })
    for (const repairJob of repairJobs) {
      if (Date.now() >= endAt - 48_000) break
      const latestRead = await db.bookReadJob.findFirst({ where: { bookId: repairJob.bookId }, orderBy: { createdAt: 'desc' } })
      const readActive = latestRead && ['QUEUED', 'RUNNING', 'PAUSED'].includes(latestRead.status)
      const readStopped = readActive && latestRead.status === 'PAUSED' &&
        latestRead.retryAt?.getUTCFullYear() === 9999 &&
        (!latestRead.lockedUntil || latestRead.lockedUntil <= new Date())
      if (readActive && !readStopped) {
        outcomes.push({ jobId: repairJob.id, outcome: 'SKIPPED_READ_JOB_ACTIVE' })
        continue
      }
      const book = await db.book.findUnique({
        where: { id: repairJob.bookId },
        select: { id: true, storageProvider: true, storageKey: true, fileUrl: true, data: true, mimeType: true },
      })
      const buffer = book ? await loadReadableBookPdfBuffer(book) : null
      if (!buffer) {
        outcomes.push({ jobId: repairJob.id, outcome: 'SKIPPED_SOURCE_UNREADABLE' })
        continue
      }
      try {
        const step = await runBookRepairScanStep(repairJob.id, buffer, Math.min(Date.now() + 240_000, endAt))
        outcomes.push({ jobId: repairJob.id, outcome: step.done ? 'REPAIR_COMPLETED' : 'REPAIR_PROGRESSED' })
      } catch (error: any) {
        outcomes.push({ jobId: repairJob.id, outcome: 'REPAIR_STEP_FAILED' })
      }
    }
  } catch (error) {
    console.warn('Book repair cron driver failed (read-job outcomes unaffected):', error)
  }

  // Resume backstop: intents whose repair is already COMPLETED get their
  // generation resumed here — this also heals a resume skipped for budget
  // in the SCAN route or in an earlier cron run. One book at a time,
  // under the same budget guard. A backstop-level failure is logged and
  // never fails the cron run.
  if (Date.now() < endAt - 48_000) {
    try {
      const pendingIntents = await db.unitRegenerationIntent.findMany({
        where: { status: 'PENDING' },
        select: { bookId: true },
        distinct: ['bookId'],
      })
      for (const { bookId } of pendingIntents) {
        if (Date.now() >= endAt - 48_000) break
        try {
          const resumed = await resumePendingUnitRegenerations(bookId, { deadlineMs: endAt })
          outcomes.push({ jobId: `RESUME:${bookId}`, outcome: `RESUMED_${resumed.resolved}_OF_${resumed.results.length}` })
        } catch (error) {
          outcomes.push({ jobId: `RESUME:${bookId}`, outcome: 'RESUME_FAILED' })
        }
      }
    } catch (error) {
      console.warn('Unit regeneration resume backstop failed (read-job outcomes unaffected):', error)
    }
  }

  return NextResponse.json({ ok: true, processed: outcomes.length, outcomes }, { headers: { 'Cache-Control': 'no-store' } })
}
