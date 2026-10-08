import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const body = await req.json().catch(() => ({}))
    const outlineId = String(body?.outlineId || '').trim()
    const book = await db.book.findUnique({ where: { id }, select: { id: true, programId: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const outline = outlineId
      ? await db.bookOutline.findFirst({ where: { id: outlineId, bookId: id }, include: { sections: { orderBy: { order: 'asc' } } } })
      : await db.bookOutline.findFirst({ where: { bookId: id }, orderBy: { version: 'desc' }, include: { sections: { orderBy: { order: 'asc' } } } })
    if (!outline) return NextResponse.json({ error: 'BOOK_OUTLINE_NOT_FOUND' }, { status: 404 })
    const updated = await db.bookOutline.update({
      where: { id: outline.id },
      data: { status: 'APPROVED' },
      include: { sections: { orderBy: { order: 'asc' } } },
    })
    return NextResponse.json({ ok: true, outline: updated })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: error?.message === 'UNAUTHORIZED' ? 401 : 500 })
  }
}
