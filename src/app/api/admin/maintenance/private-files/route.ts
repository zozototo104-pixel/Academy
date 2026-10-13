import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { runPrivateFilesMaintenanceBatch, type PrivateFilesMode, type RunPrivateFilesMaintenanceBatchInput } from '@/lib/private-files-maintenance'

export const maxDuration = 60

type HandlerDeps = {
  db?: RunPrivateFilesMaintenanceBatchInput['db']
  requireAdmin?: typeof requireAdmin
  storage?: RunPrivateFilesMaintenanceBatchInput['storage']
}

function parseMode(value: unknown): PrivateFilesMode | null {
  return value === 'dry-run' || value === 'execute' ? value : null
}

async function handlePost(req: NextRequest, deps: HandlerDeps = {}) {
  try {
    const admin = await (deps.requireAdmin || requireAdmin)()
    const body = await req.json().catch(() => null)
    const mode = parseMode(body?.mode)
    if (!mode) return NextResponse.json({ error: 'وضع التشغيل غير صالح', code: 'INVALID_MODE' }, { status: 400 })
    const cursor = typeof body?.cursor === 'string' && body.cursor ? body.cursor : null
    const confirm = typeof body?.confirm === 'string' ? body.confirm : ''
    const report = await runPrivateFilesMaintenanceBatch({
      db: deps.db || db,
      mode,
      confirm,
      cursor,
      batchSize: 50,
      actor: { id: admin.id, name: admin.name || admin.email || 'Admin' },
      storage: deps.storage,
    })
    return NextResponse.json(report)
  } catch (error: any) {
    const message = String(error?.message || error || 'UNKNOWN')
    if (message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة', code: 'UNAUTHORIZED' }, { status: 403 })
    if (message === 'PRIVATE_FILES_CONFIRM_REQUIRED') return NextResponse.json({ error: 'تأكيد التنفيذ مطلوب: نعم انقل', code: message }, { status: 400 })
    if (message === 'PRIVATE_FILES_MAINTENANCE_LOCKED') return NextResponse.json({ error: 'هناك عملية نقل ملفات قيد التشغيل حالياً', code: message }, { status: 409 })
    if (message === 'INVALID_CURSOR' || message === 'INVALID_MODE') return NextResponse.json({ error: 'طلب غير صالح', code: message }, { status: 400 })
    console.error('private files maintenance error:', error)
    return NextResponse.json({ error: 'تعذر تشغيل صيانة نقل الملفات', code: 'PRIVATE_FILES_MAINTENANCE_FAILED' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  return handlePost(req)
}

export async function __privateFilesMaintenancePostForTests(req: NextRequest, deps: HandlerDeps) {
  return handlePost(req, deps)
}
