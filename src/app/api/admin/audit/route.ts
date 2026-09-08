import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

// GET /api/admin/audit — سجل التدقيق (للإدارة)
export async function GET() {
  try {
    await requireAdmin()
    const logs = await db.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 150,
    })
    return NextResponse.json({ logs })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin audit GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل السجل' }, { status: 500 })
  }
}
