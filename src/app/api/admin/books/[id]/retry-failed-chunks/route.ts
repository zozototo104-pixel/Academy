import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

type Context = { params: Promise<{ id: string }> }

async function activeJobForBook(bookId: string) {
  return db.bookReadJob.findFirst({
    where: { bookId, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
    orderBy: { createdAt: 'desc' },
  })
}

export async function POST(_request: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { id: true, programId: true } })
    if (!book) return NextResponse.json({ error: 'الكتاب غير موجود' }, { status: 404 })
    try {
      const result = await db.$transaction(async (tx) => {
        const active = await tx.bookReadJob.findFirst({ where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
        // Never clear an in-flight worker's lease or undo a manual STOP.
        if (active) return { chunksReset: 0, jobId: active.id, resumed: true }
        const latest = await tx.bookReadJob.findFirst({ where: { bookId: id }, orderBy: { createdAt: 'desc' } })
        // A direct request must not skip unread PDF pages by creating an
        // ANALYZE job after an EXTRACT failure. The read-job endpoint already
        // resumes this same extraction job from its saved pagesDone cursor.
        // Check before resetting any failed chunks: rejection is read-only.
        if (latest?.status === 'FAILED' && latest.phase === 'EXTRACT') {
          return { blockedByExtraction: true, jobId: latest.id, chunksReset: 0 }
        }
        const chunks = await tx.bookChunk.updateMany({ where: { bookId: id, status: 'FAILED' }, data: { status: 'PENDING', attempts: 0, lastError: null } })
        if (latest?.status === 'FAILED' && latest.phase === 'ANALYZE') {
          // Keep the same job, its completed page/chunk counters and saved
          // knowledge; only failed chunks go back to PENDING for another try.
          const changed = await tx.bookReadJob.updateMany({
            where: { id: latest.id, status: 'FAILED' },
            data: { status: 'QUEUED', chunksFailed: 0, retryAt: null, lockedUntil: null, finishedAt: null },
          })
          if (changed.count) return { chunksReset: chunks.count, jobId: latest.id, resumed: true }
        }
        const job = await tx.bookReadJob.create({ data: { bookId: id, programId: book.programId, phase: 'ANALYZE', status: 'QUEUED' } })
        return { chunksReset: chunks.count, jobId: job.id, resumed: false }
      })
      return NextResponse.json({ ok: true, ...result })
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const job = await activeJobForBook(id)
        if (job) return NextResponse.json({ ok: true, chunksReset: 0, jobId: job.id, resumed: true })
      }
      throw error
    }
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('retry failed book chunks error:', error)
    return NextResponse.json({ error: 'تعذر إعادة محاولة المقاطع الفاشلة' }, { status: 500 })
  }
}
