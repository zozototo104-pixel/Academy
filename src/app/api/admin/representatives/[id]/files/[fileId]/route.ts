import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { readStoredFile } from '@/lib/storage'
import { hashRepresentativeVerifier } from '@/lib/academy-representatives'

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

const pendingProfileFieldMap: Record<string, string> = {
  'الاسم الكامل بالعربي': 'fullName',
  'البريد الإلكتروني': 'email',
  'الهاتف': 'phone',
  'واتساب': 'whatsapp',
  'الدرجة العلمية': 'degreeTitle',
  'الرتبة العلمية': 'academicRank',
  'الدولة': 'country',
  'المدينة': 'city',
  'التخصص': 'specialization',
  'السيرة الخام': 'rawBio',
  'الأعمال والخبرات': 'worksSummary',
  'الإنجازات': 'achievements',
  'ملاحظة التواصل العامة': 'publicContactNote',
  'الموقع الإلكتروني': 'website',
}

function parsePendingProfileData(file: any) {
  if (!['PROFILE_CHANGE', 'PROFILE_UPDATE'].includes(String(file?.kind || '').toUpperCase())) return {}
  let raw: Record<string, unknown> = {}
  try { raw = JSON.parse(String(file.description || '{}')) } catch { return {} }
  const data: Record<string, string> = {}
  for (const [label, value] of Object.entries(raw)) {
    const field = pendingProfileFieldMap[label]
    if (!field) continue
    const next = String(value ?? '').trim()
    if (next) data[field] = next.slice(0, field === 'rawBio' ? 12000 : 6000)
  }
  if (data.phone) data.verifyPhoneLast4Hash = hashRepresentativeVerifier(data.phone) as any
  return data
}

function pendingAssetData(file: any) {
  const kind = String(file?.kind || '').toUpperCase()
  if (kind === 'PROFILE_PHOTO') {
    return {
      profilePhotoUrl: file.fileUrl,
      profilePhotoName: file.fileName,
      profilePhotoMime: file.mimeType,
      profilePhotoSize: file.size,
      profilePhotoStorageProvider: file.storageProvider,
      profilePhotoStorageKey: file.storageKey,
    }
  }
  if (kind === 'OFFICIAL_CARD') {
    return {
      officialCardUrl: file.fileUrl,
      officialCardName: file.fileName,
      officialCardMime: file.mimeType,
      officialCardSize: file.size,
      officialCardStorageProvider: file.storageProvider,
      officialCardStorageKey: file.storageKey,
    }
  }
  return {}
}

function pendingRepresentativeData(file: any) {
  return { ...parsePendingProfileData(file), ...pendingAssetData(file) }
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
  const reviewNote = String(body.note || body.reason || '').slice(0, 500) || null
  const existing = await db.academyRepresentativeFile.findFirst({ where: { id: fileId, representativeId: id } })
  if (!existing) return NextResponse.json({ error: 'FILE_NOT_FOUND' }, { status: 404 })
  const result = await db.$transaction(async (tx) => {
    const representativeUpdate = action === 'APPROVE' ? pendingRepresentativeData(existing) : {}
    let updatedRepresentative = null
    if (Object.keys(representativeUpdate).length > 0) {
      updatedRepresentative = await tx.academyRepresentative.update({
        where: { id },
        data: { ...representativeUpdate, updatedById: user.id },
      })
    }
    const file = await tx.academyRepresentativeFile.update({
      where: { id: fileId },
      data: { reviewStatus, reviewedAt: new Date(), reviewNote },
    })
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        actorName: 'إدارة النظام',
        action: `${action}_REPRESENTATIVE_FILE`,
        entity: 'AcademyRepresentative',
        entityId: id,
        details: `${representative.fullName} — ${file.title}`.slice(0, 3900),
      },
    }).catch(() => {})
    return { file, representative: updatedRepresentative }
  })
  return NextResponse.json({ ok: true, file: result.file, representative: result.representative })
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
