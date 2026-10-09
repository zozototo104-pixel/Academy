import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

type Context = { params: Promise<{ id: string }> }

export async function POST(_request: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { id: true } })
    if (!book) return NextResponse.json({ error: 'الكتاب غير موجود' }, { status: 404 })
    const result = await db.$transaction(async (tx) => {
      const chunks = await tx.bookChunk.updateMany({ where: { bookId: id, status: 'FAILED' }, data: { status: 'PENDING', attempts: 0, lastError: null } })
      const job = await tx.bookReadJob.findFirst({ where: { bookId: id }, orderBy: { createdAt: 'desc' } })
      if (job) await tx.bookReadJob.update({ where: { id: job.id }, data: { phase: 'ANALYZE', status: 'QUEUED', lastError: null, retryAt: null, lockedUntil: null, finishedAt: null } })
      return { chunksReset: chunks.count, jobId: job?.id || null }
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('retry failed book chunks error:', error)
    return NextResponse.json({ error: 'تعذر إعادة محاولة المقاطع الفاشلة' }, { status: 500 })
  }
}
