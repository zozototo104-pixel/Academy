import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { runExtractStep } from '@/lib/book-reader'
import { runAnalyzeStep, runEnrichStep } from '@/lib/book-chunk-analyzer'
import { BOOK_READ_RETRY_MS, canRunBookReadJob, claimBookReadLock } from '@/lib/book-read-job-control'

export const runtime = 'nodejs'
export const maxDuration = 60
type Context = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const job = await db.bookReadJob.findFirst({ where: { bookId: id }, orderBy: { createdAt: 'desc' } })
    if (!job) return NextResponse.json({ error: 'BOOK_READ_JOB_NOT_FOUND' }, { status: 404 })
    return NextResponse.json({ ok: true, job })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: 401 })
  }
}

export async function POST(_request: NextRequest, context: Context) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
  const { id } = await context.params
  const job = await db.bookReadJob.findFirst({ where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
  if (!job) return NextResponse.json({ error: 'BOOK_READ_JOB_NOT_FOUND' }, { status: 404 })
  const now = new Date()
  if (!canRunBookReadJob(job, now)) return NextResponse.json({ ok: true, skipped: 'RETRY_NOT_DUE', job })
  const claimed = await claimBookReadLock(db, job.id, now)
  if (!claimed) return NextResponse.json({ ok: true, skipped: 'LOCKED_OR_NOT_DUE' })

  try {
    const deadlineMs = Date.now() + 45_000
    let result: unknown
    if (job.phase === 'EXTRACT') {
      result = await runExtractStep(job.id, deadlineMs)
      if ((result as { phase?: string }).phase === 'ANALYZE' && Date.now() < deadlineMs - 1500) {
        result = { extraction: result, analysis: await runAnalyzeStep(job.id, deadlineMs) }
      }
    } else if (job.phase === 'ANALYZE') {
      result = await runAnalyzeStep(job.id, deadlineMs)
    } else if (job.phase === 'ENRICH') {
      result = await runEnrichStep(job.id, deadlineMs)
    } else {
      result = { phase: job.phase }
    }
    const current = await db.bookReadJob.findUnique({ where: { id: job.id }, select: { status: true } })
    const updated = current?.status === 'COMPLETED'
      ? await db.bookReadJob.findUniqueOrThrow({ where: { id: job.id } })
      : await db.bookReadJob.update({ where: { id: job.id }, data: { status: 'QUEUED', lockedUntil: null, lastError: null, retryAt: null } })
    const enrichment = job.phase === 'ENRICH' ? {
      totalChunks: await db.bookChunk.count({ where: { bookId: id, status: 'ANALYZED' } }),
      saturatedChunks: await db.bookChunk.count({ where: { bookId: id, status: 'ANALYZED', OR: [{ saturatedAt: { not: null } }, { analysisPasses: { gte: 3 } }] } }),
      addedItems: await db.bookKnowledgeItem.count({ where: { bookId: id, kbVersion: 2, createdAt: { gte: job.createdAt } } }),
    } : undefined
    return NextResponse.json({ ok: true, result, job: updated, enrichment })
  } catch (error: any) {
    const message = String(error?.message || error)
    const providerUnavailable = message.includes('AI_ACADEMIC_PROVIDER_UNAVAILABLE')
    const updated = await db.bookReadJob.update({
      where: { id: job.id },
      data: {
        status: providerUnavailable ? 'PAUSED' : 'FAILED',
        retryAt: providerUnavailable ? new Date(Date.now() + BOOK_READ_RETRY_MS) : null,
        lastError: message.slice(0, 2000),
        lockedUntil: null,
      },
    })
    return NextResponse.json({ ok: false, error: message, job: updated }, { status: providerUnavailable ? 503 : 500 })
  }
}
