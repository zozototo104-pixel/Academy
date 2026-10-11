import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function audit(actorId: string, action: string, entityId: string, details: string) {
  await db.auditLog.create({
    data: { actorId, actorName: 'إدارة النظام', action, entity: 'AcademyRepresentative', entityId, details: details.slice(0, 3900) },
  }).catch(() => {})
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const user = await requireAdmin()
  const { id, fileId } = await params
  const representative = await db.academyRepresentative.findFirst({ where: { id, deletedAt: null } })
  if (!representative) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const body = await req.json().catch(() => ({}))
  const action = String(body.action || '').toUpperCase()
  if (!['APPROVE', 'REJECT'].includes(action)) return NextResponse.json({ error: 'INVALID_ACTION' }, { status: 400 })
  const reviewStatus = action === 'APPROVE' ? 'APPROVED' : 'REJECTED'
  const file = await db.academyRepresentativeFile.update({
    where: { id: fileId },
    data: { reviewStatus, reviewedAt: new Date(), reviewNote: String(body.note || '').slice(0, 500) || null },
  }).catch(() => null)
  if (!file || file.representativeId !== id) return NextResponse.json({ error: 'FILE_NOT_FOUND' }, { status: 404 })
  await audit(user.id, `${action}_REPRESENTATIVE_FILE`, id, `${representative.fullName} — ${file.title}`)
  return NextResponse.json({ ok: true, file })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const user = await requireAdmin()
  const { id, fileId } = await params
  const representative = await db.academyRepresentative.findFirst({ where: { id, deletedAt: null } })
  if (!representative) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const file = await db.academyRepresentativeFile.findFirst({ where: { id: fileId, representativeId: id } })
  if (!file) return NextResponse.json({ error: 'FILE_NOT_FOUND' }, { status: 404 })
  await db.academyRepresentativeFile.delete({ where: { id: fileId } })
  await audit(user.id, 'DELETE_REPRESENTATIVE_FILE', id, `${representative.fullName} — ${file.title}`)
  return NextResponse.json({ ok: true })
}
