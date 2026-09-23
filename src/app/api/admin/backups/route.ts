import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { db } from '@/lib/db'
import { backupConfigurationStatus, backupErrorMessage, createDatabaseBackup } from '@/lib/backups'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET() {
  try {
    await requireAdmin()
    const recent = await db.auditLog.findMany({
      where: { action: { in: ['DB_BACKUP_SUCCESS', 'DB_BACKUP_PARTIAL', 'DB_BACKUP_FAILED'] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, action: true, entityId: true, details: true, createdAt: true },
    })
    return NextResponse.json({
      configured: backupConfigurationStatus(),
      recent,
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('admin backups GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل حالة النسخ الاحتياطي' }, { status: 500 })
  }
}

export async function POST() {
  try {
    await requireAdmin()
    const result = await createDatabaseBackup('manual-admin')
    return NextResponse.json(result, {
      status: result.ok ? 200 : 207,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    })
  } catch (e: any) {
    console.error('admin backup POST error:', e)
    await db.auditLog.create({
      data: {
        actorName: 'Backup Worker',
        action: 'DB_BACKUP_FAILED',
        entity: 'Backup',
        details: backupErrorMessage(e),
      },
    }).catch(() => {})
    return NextResponse.json({ error: backupErrorMessage(e) }, { status: 500 })
  }
}
