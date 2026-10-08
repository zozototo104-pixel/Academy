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

export async function POST(_request: NextRequest, context: Context) {
  try {
    await authorize()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { id: true, programId: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const existing = await db.bookReadJob.findFirst({ where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
    if (existing) return NextResponse.json({ ok: true, job: existing, resumed: true })
    const job = await db.bookReadJob.create({ data: { bookId: id, programId: book.programId, phase: 'EXTRACT', status: 'QUEUED' } })
    return NextResponse.json({ ok: true, job, resumed: false })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || 'UNAUTHORIZED') }, { status: 401 })
  }
}
