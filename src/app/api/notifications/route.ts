import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

// GET /api/notifications — إشعارات المستخدم الحالية + عدد غير المقروء
// يدعم التصفح: ?take= (1..100، افتراضي 30) و?skip= — حتى لا يبقى الطالب أسير
// «أول كم إشعار» (إصلاح 2026-10-30). يعيد أيضاً total لعرض «عرض المزيد».
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const params = req.nextUrl.searchParams
    const takeRaw = Number(params.get('take') || 30)
    const skipRaw = Number(params.get('skip') || 0)
    const take = Number.isFinite(takeRaw) ? Math.min(100, Math.max(1, Math.floor(takeRaw))) : 30
    const skip = Number.isFinite(skipRaw) ? Math.max(0, Math.floor(skipRaw)) : 0
    const [notifications, unread, total] = await Promise.all([
      db.notification.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      db.notification.count({ where: { userId: user.id, read: false } }),
      db.notification.count({ where: { userId: user.id } }),
    ])
    return NextResponse.json({ notifications, unread, total })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ notifications: [], unread: 0, total: 0 })
    }
    console.error('notifications GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الإشعارات' }, { status: 500 })
  }
}

// PATCH /api/notifications — تحديد الكل كمقروء أو إشعار بعينه أو مجموعة معروضة
// ids: تعليم ما شاهده المستخدم فعلاً فقط («لما يشوفها تتعلم مقروءه») دون لمس ما لم يره.
export async function PATCH(req: NextRequest) {
  try {
    const user = await requireUser()
    const { id, ids, link } = await req.json().catch(() => ({ id: null, ids: null, link: null }))
    if (Array.isArray(ids)) {
      // وضع المعرّفات صريح: قائمة فارغة = لا عملية، ولا تنزلق أبداً لتعليم الكل.
      const clean = [...new Set(ids.map((v: unknown) => String(v || '')).filter(Boolean))].slice(0, 200)
      if (clean.length) {
        await db.notification.updateMany({ where: { id: { in: clean }, userId: user.id, read: false }, data: { read: true } })
      }
    } else if (id) {
      await db.notification.updateMany({ where: { id, userId: user.id }, data: { read: true } })
    } else if (link) {
      // Mark a whole thread's notifications read (used when opening an admin conversation).
      await db.notification.updateMany({ where: { userId: user.id, link, read: false }, data: { read: true } })
    } else {
      await db.notification.updateMany({ where: { userId: user.id, read: false }, data: { read: true } })
    }
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('notifications PATCH error:', e)
    return NextResponse.json({ error: 'تعذر التحديث' }, { status: 500 })
  }
}
