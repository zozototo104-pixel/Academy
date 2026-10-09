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
        const chunks = await tx.bookChunk.updateMany({ where: { bookId: id, status: 'FAILED' }, data: { status: 'PENDING', attempts: 0, lastError: null } })
        const active = await tx.bookReadJob.findFirst({ where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
        const job = active
          ? await tx.bookReadJob.update({ where: { id: active.id }, data: { phase: 'ANALYZE', status: 'QUEUED', lastError: null, retryAt: null, lockedUntil: null, finishedAt: null } })
          : await tx.bookReadJob.create({ data: { bookId: id, programId: book.programId, phase: 'ANALYZE', status: 'QUEUED' } })
        return { chunksReset: chunks.count, jobId: job.id }
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
