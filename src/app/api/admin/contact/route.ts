import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'

// GET /api/admin/contact — رسائل التواصل الواردة
export async function GET() {
  try {
    await requireAdmin()
    const messages = await db.contactMessage.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return NextResponse.json({ messages })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin contact GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الرسائل' }, { status: 500 })
  }
}

// PATCH /api/admin/contact — تعليم رسالة كمعالجة
export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const { id, handled } = await req.json()
    await db.contactMessage.update({ where: { id }, data: { handled: !!handled } })
    await audit(admin, 'RESOLVE_MESSAGE', 'ContactMessage', id, handled ? 'معالجة' : 'إعادة فتح')
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin contact PATCH error:', e)
    return NextResponse.json({ error: 'تعذر التحديث' }, { status: 500 })
  }
}
