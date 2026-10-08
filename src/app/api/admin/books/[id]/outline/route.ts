import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { buildBookOutline } from '@/lib/book-outline'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

async function programDraft(programId: string) {
  const books = await db.book.findMany({ where: { programId }, orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, semester: true } })
  const outlines = await db.bookOutline.findMany({ where: { bookId: { in: books.map((book) => book.id) } }, orderBy: { version: 'desc' }, include: { sections: { orderBy: { order: 'asc' } } } })
  const latest = new Map<string, typeof outlines[number]>()
  for (const outline of outlines) if (!latest.has(outline.bookId)) latest.set(outline.bookId, outline)
  return books.flatMap((book) => (latest.get(book.id)?.sections || []).map((section) => ({ ...section, bookId: book.id, bookTitle: book.title, semester: section.semester ?? book.semester, semesterNeedsReview: section.semester == null })))
    .sort((a, b) => (a.semester ?? 999) - (b.semester ?? 999) || books.findIndex((book) => book.id === a.bookId) - books.findIndex((book) => book.id === b.bookId) || a.order - b.order)
}

export async function GET(_req: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { programId: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const outline = await db.bookOutline.findFirst({ where: { bookId: id }, orderBy: { version: 'desc' }, include: { sections: { orderBy: { order: 'asc' } } } })
    return NextResponse.json({ outline, programDraft: await programDraft(book.programId) })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: error?.message === 'UNAUTHORIZED' ? 401 : 500 })
  }
}

export async function POST(_req: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { programId: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const outline = await buildBookOutline(id)
    return NextResponse.json({ ok: true, outline, programDraft: await programDraft(book.programId) })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: error?.message === 'UNAUTHORIZED' ? 401 : 500 })
  }
}
