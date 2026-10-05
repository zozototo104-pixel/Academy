import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { storeFileBuffer, storageErrorMessage } from '@/lib/storage'

function serializeTemplate(t: any) {
  return {
    id: t.id,
    name: t.name,
    certificateType: t.certificateType,
    active: t.active,
    fileName: t.fileName,
    mimeType: t.mimeType,
    fileSize: t.fileSize,
    imageUrl: `/api/certificates/templates/${t.id}/image`,
    createdAt: t.createdAt,
  }
}

function validateTemplateImage(buffer: Buffer, fileName: string, mimeType: string) {
  const lower = fileName.toLowerCase()
  const isPng = buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (!isPng && !isJpeg) return { ok: false, error: 'قالب الشهادة يجب أن يكون صورة PNG أو JPG.' }
  if (isPng && !['image/png', 'application/octet-stream', ''].includes(mimeType || '')) return { ok: false, error: 'امتداد ومحتوى الصورة غير متوافقين.' }
  if (isJpeg && !['image/jpeg', 'image/jpg', 'application/octet-stream', ''].includes(mimeType || '')) return { ok: false, error: 'امتداد ومحتوى الصورة غير متوافقين.' }
  if (isPng && !lower.endsWith('.png')) return { ok: false, error: 'صورة PNG يجب أن تنتهي بامتداد .png' }
  if (isJpeg && !(/\.jpe?g$/i.test(lower))) return { ok: false, error: 'صورة JPG يجب أن تنتهي بامتداد .jpg أو .jpeg' }
  return { ok: true, mimeType: isPng ? 'image/png' : 'image/jpeg' }
}

export async function GET() {
  try {
    await requireAdmin()
    const templates = await db.certificateTemplate.findMany({ orderBy: [{ active: 'desc' }, { createdAt: 'desc' }] })
    return NextResponse.json({ templates: templates.map(serializeTemplate) }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: 'تعذر تحميل قوالب الشهادات' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'اختر صورة قالب الشهادة أولاً' }, { status: 400 })
    const name = String(form.get('name') || '').trim()
    const certificateType = String(form.get('certificateType') || 'PROGRAM_COMPLETION').trim() || 'PROGRAM_COMPLETION'
    if (name.length < 2) return NextResponse.json({ error: 'اسم القالب مطلوب' }, { status: 400 })
    const buffer = Buffer.from(await file.arrayBuffer())
    if (buffer.byteLength > 8 * 1024 * 1024) return NextResponse.json({ error: 'حجم قالب الشهادة يجب ألا يتجاوز 8MB' }, { status: 400 })
    const validation = validateTemplateImage(buffer, file.name, file.type)
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 })

    const stored = await storeFileBuffer({ buffer, fileName: file.name, mimeType: validation.mimeType!, namespace: 'certificate-templates' })
    const template = await db.certificateTemplate.create({
      data: {
        name,
        certificateType,
        active: true,
        fileName: file.name,
        mimeType: stored.mimeType || validation.mimeType!,
        fileSize: stored.size,
        storageProvider: stored.provider,
        storageKey: stored.key,
        fileUrl: stored.url,
      },
    })
    await audit(admin, 'UPLOAD_CERTIFICATE_TEMPLATE', 'CertificateTemplate', template.id, `${name} — ${certificateType}`)
    return NextResponse.json({ ok: true, template: serializeTemplate(template) }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: storageErrorMessage(e) || e?.message || 'تعذر رفع قالب الشهادة' }, { status: 400 })
  }
}
