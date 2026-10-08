import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { debugBookOutlineChunks } from '@/lib/book-outline'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

export async function GET(_req: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { id: true, title: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const chunks = await db.bookChunk.findMany({
      where: { bookId: id },
      orderBy: { index: 'asc' },
      select: { index: true, pageStart: true, pageEnd: true, headingPath: true, text: true },
    })
    return NextResponse.json({ book: { id: book.id, title: book.title }, chunks: debugBookOutlineChunks(chunks) })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: error?.message === 'UNAUTHORIZED' ? 401 : 500 })
  }
}
