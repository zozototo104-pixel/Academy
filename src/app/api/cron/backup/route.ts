import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { backupConfigurationStatus, backupErrorMessage, createDatabaseBackup, isBackupRequestAuthorized } from '@/lib/backups'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  try {
    const configured = backupConfigurationStatus()
    if (!configured.secretConfigured || !isBackupRequestAuthorized(req)) {
      return NextResponse.json({ error: 'غير مصرح بتشغيل النسخ الاحتياطي' }, { status: 401 })
    }
    const result = await createDatabaseBackup('cron')
    return NextResponse.json(result, {
      status: result.ok ? 200 : 207,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    })
  } catch (e: any) {
    console.error('cron backup error:', e)
    await db.auditLog.create({
      data: {
        actorName: 'Backup Cron',
        action: 'DB_BACKUP_FAILED',
        entity: 'Backup',
        details: backupErrorMessage(e),
      },
    }).catch(() => {})
    return NextResponse.json({ error: backupErrorMessage(e) }, { status: 500 })
  }
}
