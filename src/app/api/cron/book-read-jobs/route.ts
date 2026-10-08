import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { runExtractStep } from '@/lib/book-reader'
import { runAnalyzeStep } from '@/lib/book-chunk-analyzer'
import { claimBookReadLock, BOOK_READ_RETRY_MS } from '@/lib/book-read-job-control'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  const token = request.headers.get('authorization') || ''
  if (!secret || !token.startsWith('Bearer ')) return false
  const received = Buffer.from(token.slice(7))
  const expected = Buffer.from(secret)
  return received.length === expected.length && timingSafeEqual(received, expected)
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  const deadlineMs = Date.now() + 250_000
  const outcomes: { jobId: string; status: string; error?: string }[] = []
  while (Date.now() < deadlineMs - 48_000) {
    const now = new Date()
    const jobs = await db.bookReadJob.findMany({
      where: {
        OR: [
          { status: { in: ['QUEUED', 'RUNNING'] } },
          { status: 'PAUSED', OR: [{ retryAt: null }, { retryAt: { lte: now } }] },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
    })
    const attempted = new Set(outcomes.map((item) => item.jobId))
    const next = jobs.find((job) => !attempted.has(job.id) && (!job.lockedUntil || job.lockedUntil < now))
    if (!next) break
    if (!(await claimBookReadLock(db, next.id, now))) {
      outcomes.push({ jobId: next.id, status: 'LOCKED' })
      continue
    }
    try {
      const stepDeadline = Math.min(deadlineMs, Date.now() + 45_000)
      const extracted = next.phase === 'EXTRACT' ? await runExtractStep(next.id, stepDeadline) : null
      if (next.phase === 'ANALYZE' || (extracted?.phase === 'ANALYZE' && Date.now() < stepDeadline - 1500)) {
        await runAnalyzeStep(next.id, stepDeadline)
      }
      const current = await db.bookReadJob.findUnique({ where: { id: next.id }, select: { status: true } })
      if (current?.status !== 'COMPLETED') {
        await db.bookReadJob.update({ where: { id: next.id }, data: { status: 'QUEUED', lockedUntil: null, retryAt: null, lastError: null } })
      }
      outcomes.push({ jobId: next.id, status: current?.status === 'COMPLETED' ? 'COMPLETED' : 'QUEUED' })
    } catch (error: any) {
      const message = String(error?.message || error)
      const unavailable = message.includes('AI_ACADEMIC_PROVIDER_UNAVAILABLE')
      await db.bookReadJob.update({ where: { id: next.id }, data: {
        status: unavailable ? 'PAUSED' : 'FAILED',
        retryAt: unavailable ? new Date(Date.now() + BOOK_READ_RETRY_MS) : null,
        lockedUntil: null,
        lastError: message.slice(0, 2000),
      } })
      outcomes.push({ jobId: next.id, status: unavailable ? 'PAUSED' : 'FAILED', error: message.slice(0, 200) })
    }
  }
  return NextResponse.json({ ok: true, processed: outcomes.length, outcomes }, { headers: { 'Cache-Control': 'no-store' } })
}
