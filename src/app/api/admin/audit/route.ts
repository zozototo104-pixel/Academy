import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { adminPaginationMeta, cleanAdminQuery, parseAdminPagination } from '@/lib/admin-query'

// GET /api/admin/audit — سجل التدقيق (للإدارة)
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const sp = req.nextUrl.searchParams
    const { page, pageSize, skip, take } = parseAdminPagination(sp, { pageSize: 50, maxPageSize: 100 })
    const search = cleanAdminQuery(sp.get('search'))
    const action = cleanAdminQuery(sp.get('action'))
    const entity = cleanAdminQuery(sp.get('entity'))

    const where: any = {
      ...(action && action !== 'ALL' ? { action } : {}),
      ...(entity && entity !== 'ALL' ? { entity } : {}),
      ...(search
        ? {
            OR: [
              { actorName: { contains: search, mode: 'insensitive' } },
              { actorEmail: { contains: search, mode: 'insensitive' } },
              { action: { contains: search, mode: 'insensitive' } },
              { entity: { contains: search, mode: 'insensitive' } },
              { details: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    }

    const [logs, total, actionRows, entityRows] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      db.auditLog.count({ where }),
      db.auditLog.findMany({ select: { action: true }, distinct: ['action'], orderBy: { action: 'asc' } }),
      db.auditLog.findMany({ select: { entity: true }, distinct: ['entity'], orderBy: { entity: 'asc' } }),
    ])

    return NextResponse.json({
      logs,
      total,
      pagination: adminPaginationMeta(page, pageSize, total),
      actions: actionRows.map((r) => r.action).filter(Boolean),
      entities: entityRows.map((r) => r.entity).filter(Boolean),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin audit GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل السجل' }, { status: 500 })
  }
}
