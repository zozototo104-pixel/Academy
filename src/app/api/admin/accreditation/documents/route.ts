import { NextRequest, NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { audit } from '@/lib/notify'
import { ensureAccreditationProfile, getAccreditationProfileForAdmin, serializeAccreditationDocument } from '@/lib/accreditation'
import { storeFileBuffer, storageErrorMessage } from '@/lib/storage'
import { validateAdmissionFileSignature } from '@/lib/file-signature'

const metaSchema = z.object({
  title: z.string().trim().min(1, 'عنوان الوثيقة مطلوب').max(220),
  kind: z.enum(['LICENSE', 'PARTNERSHIP', 'OTHER']).default('LICENSE'),
  description: z.string().trim().max(1200).optional().default(''),
  verifyUrl: z.string().trim().url().or(z.literal('')).optional().default(''),
  partnershipId: z.string().trim().optional().default(''),
  displayOrder: z.coerce.number().int().min(0).max(100000).optional().default(0),
})

function revalidateAccreditationSurfaces() {
  for (const path of ['/accreditation', '/', '/sitemap.xml']) {
    try { revalidatePath(path) } catch (error) { console.warn('accreditation document revalidate failed:', path, error) }
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'اختر ملف الوثيقة أولاً' }, { status: 400 })
    const payload = metaSchema.parse({
      title: form.get('title'),
      kind: form.get('kind') || 'LICENSE',
      description: form.get('description') || '',
      verifyUrl: form.get('verifyUrl') || '',
      partnershipId: form.get('partnershipId') || '',
      displayOrder: form.get('displayOrder') || 0,
    })

    const buffer = Buffer.from(await file.arrayBuffer())
    const maxBytes = 15 * 1024 * 1024
    if (buffer.byteLength > maxBytes) return NextResponse.json({ error: 'حجم الوثيقة يجب ألا يتجاوز 15MB' }, { status: 400 })
    const validation = validateAdmissionFileSignature({ buffer, fileName: file.name, mimeType: file.type })
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 })

    const profile = await ensureAccreditationProfile()
    let partnershipId: string | null = null
    if (payload.partnershipId) {
      const partner = await db.accreditationPartnership.findFirst({ where: { id: payload.partnershipId, profileId: profile.id }, select: { id: true } })
      if (!partner) return NextResponse.json({ error: 'الشراكة المحددة غير موجودة' }, { status: 400 })
      partnershipId = partner.id
    }

    const stored = await storeFileBuffer({
      buffer,
      fileName: file.name,
      mimeType: validation.mimeType,
      namespace: 'accreditation-documents',
    })

    const doc = await db.accreditationDocument.create({
      data: {
        profileId: profile.id,
        partnershipId,
        kind: payload.kind,
        title: payload.title,
        description: payload.description || null,
        verifyUrl: payload.verifyUrl || null,
        fileName: file.name,
        mimeType: stored.mimeType || validation.mimeType,
        fileSize: stored.size,
        storageProvider: stored.provider,
        storageKey: stored.key,
        fileUrl: stored.url,
        displayOrder: payload.displayOrder || 0,
        uploadedById: user.id,
      },
    })

    revalidateAccreditationSurfaces()
    await audit(user, 'UPLOAD_ACCREDITATION_DOCUMENT', 'AccreditationDocument', doc.id, `رفع وثيقة اعتماد: ${doc.title} — ${doc.fileName}`)
    return NextResponse.json({ ok: true, document: serializeAccreditationDocument(doc), profile: await getAccreditationProfileForAdmin() }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    console.error('accreditation document upload error:', e)
    return NextResponse.json({ error: storageErrorMessage(e) || e?.message || 'تعذر رفع الوثيقة' }, { status: 400 })
  }
}
