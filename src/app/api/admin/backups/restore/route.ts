import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { backupErrorMessage, inspectStoredDatabaseBackup, restoreStoredDatabaseBackup } from '@/lib/backups'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type RestoreAction = 'inspect' | 'restore'

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const action = String(body.action || 'inspect') as RestoreAction
    const key = String(body.key || '').trim()
    const provider = String(body.provider || 's3').trim() || 's3'

    if (!key) {
      return NextResponse.json({ error: 'أدخل storage.key للنسخة المشفرة أولاً.' }, { status: 400 })
    }
    if (!key.startsWith('backups/db/')) {
      return NextResponse.json({ error: 'مفتاح النسخة يجب أن يكون من مسار backups/db فقط.' }, { status: 400 })
    }

    if (action === 'inspect') {
      const result = await inspectStoredDatabaseBackup({ provider, key })
      return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
    }

    if (action === 'restore') {
      const result = await restoreStoredDatabaseBackup({ provider, key, confirm: String(body.confirm || '') })
      return NextResponse.json(result, {
        status: result.ok ? 200 : 207,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      })
    }

    return NextResponse.json({ error: 'إجراء غير معروف.' }, { status: 400 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('admin backup restore error:', e)
    return NextResponse.json({ error: backupErrorMessage(e) }, { status: 500 })
  }
}
