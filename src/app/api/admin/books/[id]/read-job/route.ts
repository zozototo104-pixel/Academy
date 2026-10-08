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
    return NextResponse.json({ ok: true, job })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || 'UNAUTHORIZED') }, { status: 401 })
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    await authorize()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { id: true, programId: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const existing = await db.bookReadJob.findFirst({ where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
    if (existing) return NextResponse.json({ ok: true, job: existing, resumed: true })
    try {
      const job = await db.bookReadJob.create({ data: { bookId: id, programId: book.programId, phase: 'EXTRACT', status: 'QUEUED' } })
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
