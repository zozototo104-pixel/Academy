import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string; sectionId: string }> }

export async function PATCH(request: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id, sectionId } = await context.params
    const body = await request.json()
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.trim().length > 180 || Object.keys(body).some((key) => key !== 'title')) {
      return NextResponse.json({ error: 'عنوان القسم مطلوب (180 حرفاً كحد أقصى)' }, { status: 400 })
    }
    const section = await db.bookOutlineSection.findFirst({ where: { id: sectionId, outline: { bookId: id, status: 'DRAFT' } }, select: { id: true } })
    if (!section) return NextResponse.json({ error: 'القسم غير موجود أو الفهرس معتمد' }, { status: 404 })
    const updated = await db.bookOutlineSection.update({ where: { id: section.id }, data: { title: body.title.trim() } })
    return NextResponse.json({ ok: true, section: updated })
  } catch (error: any) {
    return NextResponse.json({ error: String(error?.message || error) }, { status: error?.message === 'UNAUTHORIZED' ? 401 : 500 })
  }
}
