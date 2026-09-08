import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

// GET /api/notifications — إشعارات المستخدم الحالية + عدد غير المقروء
export async function GET() {
  try {
    const user = await requireUser()
    const notifications = await db.notification.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })
    const unread = await db.notification.count({ where: { userId: user.id, read: false } })
    return NextResponse.json({ notifications, unread })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ notifications: [], unread: 0 })
    }
    console.error('notifications GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الإشعارات' }, { status: 500 })
  }
}

// PATCH /api/notifications — تحديد الكل كمقروء أو إشعار بعينه
export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser()
    const { id } = await req.json().catch(() => ({ id: null }))
    if (id) {
      await db.notification.updateMany({ where: { id, userId: user.id }, data: { read: true } })
    } else {
      await db.notification.updateMany({ where: { userId: user.id, read: false }, data: { read: true } })
    }
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('notifications PATCH error:', e)
    return NextResponse.json({ error: 'تعذر التحديث' }, { status: 500 })
  }
}
