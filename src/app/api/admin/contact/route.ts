import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { adminPaginationMeta, cleanAdminQuery, parseAdminPagination } from '@/lib/admin-query'

// GET /api/admin/contact — رسائل التواصل الواردة
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const sp = req.nextUrl.searchParams
    const { page, pageSize, skip, take } = parseAdminPagination(sp, { pageSize: 25, maxPageSize: 100 })
    const search = cleanAdminQuery(sp.get('search'))
    const status = cleanAdminQuery(sp.get('status'))
    const where: any = {
      ...(status === 'OPEN' ? { handled: false } : status === 'HANDLED' ? { handled: true } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
              { subject: { contains: search, mode: 'insensitive' } },
              { message: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    }

    const [messages, total] = await Promise.all([
      db.contactMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      db.contactMessage.count({ where }),
    ])
    return NextResponse.json({ messages, total, pagination: adminPaginationMeta(page, pageSize, total) })
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
    const message = await db.contactMessage.update({ where: { id }, data: { handled: !!handled } })
    await db.humanHandoffRequest.updateMany({
      where: { contactMessageId: id },
      data: handled
        ? { status: 'CONTACTED', assignedToId: admin.id, assignedAt: new Date(), contactedAt: new Date() }
        : { status: 'NEW', assignedToId: null, assignedAt: null, contactedAt: null, closedAt: null },
    }).catch(() => {})
    if (!handled && message.subject === 'طلب تواصل بشري من الوكيل الذكي') {
      await db.humanHandoffRequest.updateMany({
        where: { contactMessageId: null, subject: message.subject, message: { contains: message.message.slice(-200) } },
        data: { status: 'NEW', assignedToId: null, assignedAt: null, contactedAt: null, closedAt: null },
      }).catch(() => {})
    }
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
