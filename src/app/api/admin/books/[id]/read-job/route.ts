import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string }> }

async function authorize() {
  await requireAdmin()
}

export async function GET(_request: NextRequest, context: Context) {
  try {
    await authorize()
    const { id } = await context.params
    const job = await db.bookReadJob.findFirst({ where: { bookId: id }, orderBy: { createdAt: 'desc' } })
    const enrichment = {
      totalChunks: await db.bookChunk.count({ where: { bookId: id, status: 'ANALYZED' } }),
      saturatedChunks: await db.bookChunk.count({ where: { bookId: id, status: 'ANALYZED', OR: [{ saturatedAt: { not: null } }, { analysisPasses: { gte: 3 } }] } }),
      addedItems: job?.phase === 'ENRICH' || (job?.phase === 'DONE' && job.totalChunks === 0)
        ? await db.bookKnowledgeItem.count({ where: { bookId: id, kbVersion: 2, createdAt: { gte: job.createdAt } } }) : 0,
    }
    return NextResponse.json({ ok: true, job, enrichment })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || 'UNAUTHORIZED') }, { status: 401 })
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    await authorize()
    const { id } = await context.params
    const body = await request.json().catch(() => ({}))
    const mode = body?.mode === 'ENRICH' ? 'ENRICH' : 'EXTRACT'
    const reread = body?.reread === true && mode === 'EXTRACT'
    const book = await db.book.findUnique({ where: { id }, select: { id: true, programId: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    if (mode === 'ENRICH') {
      const readable = await db.bookChunk.count({ where: { bookId: id, status: 'ANALYZED' } })
      if (!readable) return NextResponse.json({ error: 'شغّل القراءة الكاملة أولاً' }, { status: 400 })
    }
    const existing = await db.bookReadJob.findFirst({ where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
    if (existing) return NextResponse.json({ ok: true, job: existing, resumed: true })
    if (reread) await db.bookChunk.deleteMany({ where: { bookId: id } })
    try {
      const job = await db.bookReadJob.create({ data: { bookId: id, programId: book.programId, phase: mode, status: 'QUEUED' } })
      return NextResponse.json({ ok: true, job, resumed: false })
    } catch (error: any) {
      // PostgreSQL partial unique index protects the create itself; a competing
      // request may have won between findFirst and create.
      if (error?.code !== 'P2002' && error?.code !== '23505') throw error
      const winner = await db.bookReadJob.findFirst({ where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
      if (!winner) throw error
      return NextResponse.json({ ok: true, job: winner, resumed: true })
    }
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || 'UNAUTHORIZED') }, { status: 401 })
  }
}
