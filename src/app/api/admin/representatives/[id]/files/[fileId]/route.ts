import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { readStoredFile } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Administrative review must be able to inspect a pending file without making it public.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  await requireAdmin()
  const { id, fileId } = await params
  const representative = await db.academyRepresentative.findFirst({ where: { id, deletedAt: null } })
  if (!representative) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const file = await db.academyRepresentativeFile.findFirst({ where: { id: fileId, representativeId: id } })
  if (!file) return NextResponse.json({ error: 'FILE_NOT_FOUND' }, { status: 404 })
  if ((!file.storageKey && !file.fileUrl) || file.storageProvider === 'external-url') {
    return NextResponse.json({ error: 'NO_STORED_FILE' }, { status: 404 })
  }

  const stored = await readStoredFile({
    provider: file.storageProvider,
    key: file.storageKey,
    url: file.fileUrl,
    mimeType: file.mimeType || 'application/octet-stream',
  })
  if (!stored) return NextResponse.json({ error: 'FILE_UNREADABLE' }, { status: 404 })

  // Serve potentially untrusted uploads from the authenticated route only.
  const mimeType = String(file.mimeType || 'application/octet-stream')
  const disposition = /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/i.test(mimeType) ? 'inline' : 'attachment'
  const fileName = String(file.fileName || file.title || 'representative-file')
    .trim().replace(/[\r\n"\\/]+/g, '-').slice(0, 160) || 'representative-file'
  return new NextResponse(new Uint8Array(stored.buffer), {
    headers: {
      'Content-Type': mimeType,
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    },
  })
}

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
  const existing = await db.academyRepresentativeFile.findFirst({ where: { id: fileId, representativeId: id } })
  if (!existing) return NextResponse.json({ error: 'FILE_NOT_FOUND' }, { status: 404 })
  const file = await db.academyRepresentativeFile.update({
    where: { id: fileId },
    data: { reviewStatus, reviewedAt: new Date(), reviewNote: String(body.note || '').slice(0, 500) || null },
  })
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
