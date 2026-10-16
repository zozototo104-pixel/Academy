import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
    const { id } = await ctx.params
    const item = await db.questionBankItem.findUnique({ where: { id } })
    if (!item) return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 })
    return NextResponse.json({ item: { ...item, verifierReason: item.reviewNotes || null } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('question bank detail GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل تفاصيل السؤال' }, { status: 500 })
  }
}
