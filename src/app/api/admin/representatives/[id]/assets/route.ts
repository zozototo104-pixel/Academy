import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { extractDocumentText } from '@/lib/document-extract'
import { storeFileBuffer, storageErrorMessage } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function text(value: unknown, max = 1000) {
  return String(value ?? '').trim().slice(0, max) || null
}

async function audit(actorId: string, action: string, entityId: string, details: string) {
  await db.auditLog.create({
    data: { actorId, actorName: 'إدارة النظام', action, entity: 'AcademyRepresentative', entityId, details: details.slice(0, 3900) },
  }).catch(() => {})
}

async function fileFromForm(form: FormData) {
  const file = form.get('file')
  if (!(file instanceof File)) return null
  const buffer = Buffer.from(await file.arrayBuffer())
  return { file, buffer, name: file.name || 'file', mimeType: file.type || 'application/octet-stream' }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireAdmin()
  const { id } = await params
  const representative = await db.academyRepresentative.findFirst({ where: { id, deletedAt: null } })
  if (!representative) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const form = await req.formData()
  const assetType = String(form.get('assetType') || 'file')
  const kind = String(form.get('kind') || 'OTHER').slice(0, 40)
  const title = text(form.get('title'), 220) || 'ملف ممثل الأكاديمية'
  const description = text(form.get('description'), 1200)
  const externalUrl = text(form.get('externalUrl'), 800)

  if (externalUrl && assetType === 'file') {
    const created = await db.academyRepresentativeFile.create({
      data: { representativeId: id, kind: kind || 'LINK', title, description, externalUrl, fileUrl: externalUrl, storageProvider: 'external-url', storageKey: externalUrl },
    })
    await audit(user.id, 'ADD_REPRESENTATIVE_LINK', id, `${representative.fullName} — ${title}`)
    return NextResponse.json({ file: created })
  }

  const uploaded = await fileFromForm(form)
  if (!uploaded) return NextResponse.json({ error: 'NO_FILE', message: 'يرجى رفع ملف أو وضع رابط خارجي.' }, { status: 400 })

  try {
    const stored = await storeFileBuffer({
      buffer: uploaded.buffer,
      fileName: uploaded.name,
      mimeType: uploaded.mimeType,
      namespace: `representatives/${id}`,
    })

    if (assetType === 'profilePhoto') {
      const updated = await db.academyRepresentative.update({
        where: { id },
        data: {
          profilePhotoUrl: stored.url,
          profilePhotoName: uploaded.name,
          profilePhotoMime: stored.mimeType,
          profilePhotoSize: stored.size,
          profilePhotoStorageProvider: stored.provider,
          profilePhotoStorageKey: stored.key,
          updatedById: user.id,
        },
      })
      await audit(user.id, 'UPLOAD_REPRESENTATIVE_PHOTO', id, `${updated.fullName} — ${uploaded.name}`)
      return NextResponse.json({ representative: updated })
    }

    if (assetType === 'officialCard') {
      const updated = await db.academyRepresentative.update({
        where: { id },
        data: {
          officialCardUrl: stored.url,
          officialCardName: uploaded.name,
          officialCardMime: stored.mimeType,
          officialCardSize: stored.size,
          officialCardStorageProvider: stored.provider,
          officialCardStorageKey: stored.key,
          updatedById: user.id,
        },
      })
      await audit(user.id, 'UPLOAD_REPRESENTATIVE_CARD', id, `${updated.fullName} — ${uploaded.name}`)
      return NextResponse.json({ representative: updated })
    }

    const extracted = await extractDocumentText(uploaded.buffer, uploaded.mimeType, uploaded.name, 50000).catch(() => null)
    const created = await db.academyRepresentativeFile.create({
      data: {
        representativeId: id,
        kind,
        title,
        description,
        fileName: uploaded.name,
        mimeType: stored.mimeType,
        size: stored.size,
        storageProvider: stored.provider,
        storageKey: stored.key,
        fileUrl: stored.url,
        extractedText: extracted?.readable ? extracted.text : null,
      },
    })
    let updatedRepresentative: typeof representative | null = null
    if (extracted?.readable && kind.toUpperCase() === 'CV') {
      const rawText = extracted.text.trim().slice(0, 12000)
      if (rawText) {
        updatedRepresentative = await db.academyRepresentative.update({
          where: { id },
          data: { rawBio: rawText, aiRewriteNote: 'تم استخراج نص السيرة الذاتية من الملف المرفوع.', updatedById: user.id },
          include: { files: true },
        })
      }
    }
    await audit(user.id, 'UPLOAD_REPRESENTATIVE_FILE', id, `${representative.fullName} — ${title} — ${uploaded.name}`)
    return NextResponse.json({ file: created, representative: updatedRepresentative, extraction: extracted ? { readable: extracted.readable, reader: extracted.reader, note: extracted.note } : null })
  } catch (error) {
    return NextResponse.json({ error: 'UPLOAD_FAILED', message: storageErrorMessage(error) }, { status: 500 })
  }
}
