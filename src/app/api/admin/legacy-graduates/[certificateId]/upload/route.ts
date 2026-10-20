import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import {
  LEGACY_CERTIFICATE_UPLOAD_MAX_BYTES,
  normalizeQrSize,
  normalizeStampLayout,
  readLegacyCertificateStoredFile,
  serializeStampLayout,
  sniffLegacyCertificateMime,
  stampLegacyCertificatePdf,
  storeLegacyCertificateOriginal,
  storeLegacyCertificateStamped,
} from '@/lib/legacy-certificate-files'

function isPreview(value: unknown) {
  return String(value || '').toLowerCase() === 'true'
}

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ certificateId: string }> | { certificateId: string } }

function stampedFileName(serial: string) {
  return `${String(serial || 'certificate').replace(/[^a-zA-Z0-9._-]+/g, '-')}-stamped.pdf`
}

export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdmin()
    const { certificateId } = await context.params
    const cert = await db.certificate.findUnique({ where: { id: certificateId } })
    if (!cert || !cert.legacy) return NextResponse.json({ error: 'شهادة الخريج السابق غير موجودة' }, { status: 404 })

    const form = await req.formData()
    const file = form.get('file')
    const preview = isPreview(req.nextUrl.searchParams.get('preview')) || isPreview(form.get('preview'))
    const qrSize = normalizeQrSize(form.get('qrSize') || cert.qrSize || 'M')
    const stampLayout = normalizeStampLayout(form.get('stampLayout') || form.get('qrPosition') || cert.qrPosition || 'BOTTOM_LEFT', qrSize)
    const serializedStampLayout = serializeStampLayout(stampLayout)

    let originalBuffer: Buffer | null = null
    let originalFileName = cert.uploadedFileName || stampedFileName(cert.serial)
    let originalMime = sniffLegacyCertificateMime(Buffer.alloc(0))
    let hasNewFile = false

    if (file instanceof File) {
      if (file.size <= 0) return NextResponse.json({ error: 'الملف فارغ' }, { status: 400 })
      if (file.size > LEGACY_CERTIFICATE_UPLOAD_MAX_BYTES) return NextResponse.json({ error: 'حجم الملف يتجاوز 10MB' }, { status: 413 })
      originalBuffer = Buffer.from(await file.arrayBuffer())
      originalFileName = file.name || originalFileName
      originalMime = sniffLegacyCertificateMime(originalBuffer)
      hasNewFile = true
      if (!originalMime) return NextResponse.json({ error: 'الصيغة مرفوضة. ارفع PDF أو JPG أو PNG فقط' }, { status: 400 })
    } else if (cert.uploadedFileKey) {
      const stored = await readLegacyCertificateStoredFile(cert.uploadedFileKey, cert.uploadedMime)
      if (!stored) return NextResponse.json({ error: 'تعذر قراءة الملف الأصلي المخزن' }, { status: 404 })
      originalBuffer = stored.buffer
      originalMime = sniffLegacyCertificateMime(stored.buffer)
      if (!originalMime) return NextResponse.json({ error: 'الملف الأصلي المخزن غير مدعوم' }, { status: 400 })
    } else {
      return NextResponse.json({ error: 'ارفع ملف شهادة أولاً' }, { status: 400 })
    }

    if (!originalBuffer || !originalMime) {
      return NextResponse.json({ error: 'تعذر تجهيز الملف الأصلي للختم' }, { status: 400 })
    }

    const stampedBuffer = await stampLegacyCertificatePdf({
      buffer: originalBuffer,
      mime: originalMime,
      serial: cert.serial,
      qrToken: cert.qrToken,
      stampLayout,
      qrSize,
    })

    if (preview) {
      return new NextResponse(stampedBuffer, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${stampedFileName(cert.serial)}"`,
          'Cache-Control': 'no-store',
        },
      })
    }

    const originalStored = hasNewFile
      ? await storeLegacyCertificateOriginal(originalBuffer, originalFileName, originalMime)
      : null
    const stampedStored = await storeLegacyCertificateStamped(stampedBuffer, stampedFileName(cert.serial))
    const updated = await db.certificate.update({
      where: { id: cert.id },
      data: {
        ...(originalStored ? {
          uploadedFileKey: originalStored.key,
          uploadedFileName: originalFileName,
          uploadedMime: originalMime,
        } : {}),
        stampedFileKey: stampedStored.key,
        qrPosition: serializedStampLayout,
        qrSize: 'CUSTOM',
      },
    })

    await db.auditLog.create({
      data: {
        actorId: admin.id,
        actorName: admin.name || 'Admin',
        action: hasNewFile ? 'UPLOAD_LEGACY_CERTIFICATE_FILE' : 'RESTAMP_LEGACY_CERTIFICATE_FILE',
        entity: 'Certificate',
        entityId: cert.id,
        details: `${cert.serial} — ${cert.holderName} — ${qrPosition}/${qrSize}`,
      },
    })

    return NextResponse.json({ ok: true, certificate: updated, stampedFileKey: stampedStored.key })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin legacy-graduates upload error:', error)
    return NextResponse.json({ error: 'تعذر رفع وختم الشهادة' }, { status: 500 })
  }
}
