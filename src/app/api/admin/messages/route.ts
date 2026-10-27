import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { adminPaginationMeta, cleanAdminQuery, parseAdminPagination } from '@/lib/admin-query'

// GET /api/admin/messages — قائمة محادثات رسائل الإدارة (مراسلة الادارة).
// Audience: admissions only (any status), excluding legacy userId-null rows, which
// have no account to message in-platform. Threads are admin scope only.
export async function GET(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const sp = req.nextUrl.searchParams
    const { page, pageSize, skip, take } = parseAdminPagination(sp, { pageSize: 25, maxPageSize: 100 })
    const search = cleanAdminQuery(sp.get('search'))
    const where: any = {
      userId: { not: null },
      ...(search
        ? {
            OR: [
              { fullName: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { reference: { contains: search, mode: 'insensitive' } },
              { program: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    }
    const [admissions, total] = await Promise.all([
      db.admissionApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: { id: true, reference: true, fullName: true, email: true, program: true, status: true, createdAt: true },
      }),
      db.admissionApplication.count({ where }),
    ])
    const ids = admissions.map((a: any) => a.id)
    const [lastMessages, unreadNotes] = await Promise.all([
      Promise.all(ids.map((admissionId: string) =>
        db.supervisorChannelMessage.findFirst({
          where: { admissionId, scope: 'ADMIN' },
          orderBy: { createdAt: 'desc' },
          select: { id: true, senderRole: true, content: true, createdAt: true },
        })
      )),
      ids.length
        ? db.notification.findMany({
            where: { userId: admin.id, type: 'ADMIN_MESSAGE', read: false, link: { in: ids.map((id: string) => `admin-messages:${id}`) } },
            select: { link: true },
          })
        : [],
    ])
    const unreadByAdmission = new Map<string, number>()
    for (const n of unreadNotes as any[]) {
      const admissionId = String(n.link || '').replace('admin-messages:', '')
      if (admissionId) unreadByAdmission.set(admissionId, (unreadByAdmission.get(admissionId) || 0) + 1)
    }
    const conversations = admissions.map((app: any, i: number) => ({
      admission: app,
      lastMessage: lastMessages[i] || null,
      unread: unreadByAdmission.get(app.id) || 0,
    }))
    // Page-local sort: most recent admin message first, threads without any message last.
    conversations.sort((a: any, b: any) => {
      const at = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0
      const bt = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0
      if (bt !== at) return bt - at
      return new Date(b.admission.createdAt).getTime() - new Date(a.admission.createdAt).getTime()
    })
    return NextResponse.json({ conversations, total, pagination: adminPaginationMeta(page, pageSize, total) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('admin messages GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل محادثات الإدارة' }, { status: 500 })
  }
}
