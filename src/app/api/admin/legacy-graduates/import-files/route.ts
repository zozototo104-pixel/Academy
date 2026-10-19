import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { isValidLegacyGraduateEmail, normalizeLegacyGraduateEmail } from '@/lib/legacy-graduates'
import {
  LEGACY_CERTIFICATE_ZIP_MAX_BYTES,
  parseZipEntries,
  sniffLegacyCertificateMime,
  stampLegacyCertificatePdf,
  storeLegacyCertificateOriginal,
  storeLegacyCertificateStamped,
} from '@/lib/legacy-certificate-files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function looksLikeZip(buffer: Buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
}

function baseIdentifier(fileName: string) {
  const leaf = String(fileName || '').split(/[\\/]/).pop() || ''
  return leaf.replace(/\.(pdf|png|jpe?g)$/i, '').trim()
}

function stampedFileName(serial: string) {
  return `${String(serial || 'certificate').replace(/[^a-zA-Z0-9._-]+/g, '-')}-stamped.pdf`
}

async function findCertificateByFileIdentifier(identifier: string) {
  const bySerial = await db.certificate.findFirst({ where: { legacy: true, legacySerial: identifier } })
  if (bySerial) return { certificate: bySerial, status: 'FOUND' as const }

  const email = normalizeLegacyGraduateEmail(identifier)
  if (!isValidLegacyGraduateEmail(email)) return { certificate: null, status: 'NOT_FOUND' as const }
  const user = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (!user) return { certificate: null, status: 'NOT_FOUND' as const }
  const matches = await db.certificate.findMany({ where: { legacy: true, userId: user.id }, orderBy: { issuedAt: 'desc' } })
  if (matches.length === 1) return { certificate: matches[0], status: 'FOUND' as const }
  if (matches.length > 1) return { certificate: null, status: 'AMBIGUOUS' as const }
  return { certificate: null, status: 'NOT_FOUND' as const }
}

type LegacyCertificateZipImportResult = {
  fileName: string
  ok: boolean
  status: 'SUCCESS' | 'NOT_FOUND' | 'AMBIGUOUS' | 'REJECTED_FORMAT' | 'FAILED'
  error?: string
  certificateId?: string
  serial?: string
}

// POST /api/admin/legacy-graduates/import-files — ربط وختم شهادات جاهزة من ZIP
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'ملف ZIP مطلوب' }, { status: 400 })
    if (file.size <= 0) return NextResponse.json({ error: 'الملف فارغ' }, { status: 400 })
    if (file.size > LEGACY_CERTIFICATE_ZIP_MAX_BYTES) return NextResponse.json({ error: 'حجم ملف ZIP كبير جداً' }, { status: 413 })

    const zipBuffer = Buffer.from(await file.arrayBuffer())
    if (!looksLikeZip(zipBuffer)) return NextResponse.json({ error: 'الملف ليس ZIP صالحاً' }, { status: 400 })

    let entries
    try {
      entries = parseZipEntries(zipBuffer)
    } catch (error) {
      console.error('legacy certificate ZIP parse error:', error)
      return NextResponse.json({ error: 'تعذر قراءة ملف ZIP' }, { status: 400 })
    }

    const results = []
    for (const entry of entries) {
      const identifier = baseIdentifier(entry.fileName)
      const mime = sniffLegacyCertificateMime(entry.buffer)
      if (!mime) {
        results.push({ fileName: entry.fileName, ok: false, status: 'REJECTED_FORMAT', error: 'صيغة مرفوضة' })
        continue
      }
      if (!identifier) {
        results.push({ fileName: entry.fileName, ok: false, status: 'NOT_FOUND', error: 'اسم الملف لا يحتوي إيميل أو رقم شهادة' })
        continue
      }

      try {
        const found = await findCertificateByFileIdentifier(identifier)
        if (!found.certificate) {
          results.push({
            fileName: entry.fileName,
            ok: false,
            status: found.status,
            error: found.status === 'AMBIGUOUS' ? 'أكثر من شهادة لهذا الإيميل؛ استخدم legacySerial كاسم الملف' : 'ما لقى صاحبه',
          })
          continue
        }

        const cert = found.certificate
        const stamped = await stampLegacyCertificatePdf({
          buffer: entry.buffer,
          mime,
          serial: cert.serial,
          qrToken: cert.qrToken,
          qrPosition: 'BOTTOM_LEFT',
          qrSize: 'M',
        })
        const originalStored = await storeLegacyCertificateOriginal(entry.buffer, entry.fileName, mime)
        const stampedStored = await storeLegacyCertificateStamped(stamped, stampedFileName(cert.serial))
        await db.certificate.update({
          where: { id: cert.id },
          data: {
            uploadedFileKey: originalStored.key,
            uploadedFileName: entry.fileName,
            uploadedMime: mime,
            stampedFileKey: stampedStored.key,
            qrPosition: 'BOTTOM_LEFT',
            qrSize: 'M',
          },
        })
        await db.auditLog.create({
          data: {
            actorId: admin.id,
            actorName: admin.name || 'Admin',
            action: 'IMPORT_LEGACY_CERTIFICATE_FILE',
            entity: 'Certificate',
            entityId: cert.id,
            details: `${cert.serial} — ${cert.holderName} — ${entry.fileName}`,
          },
        })
        results.push({ fileName: entry.fileName, ok: true, status: 'SUCCESS', certificateId: cert.id, serial: cert.serial })
      } catch (error: any) {
        results.push({ fileName: entry.fileName, ok: false, status: 'FAILED', error: String(error?.message || error || 'تعذر ختم الملف').slice(0, 240) })
      }
    }

    return NextResponse.json({
      ok: true,
      totalFiles: entries.length,
      successful: results.filter((row) => row.ok).length,
      notFound: results.filter((row) => row.status === 'NOT_FOUND' || row.status === 'AMBIGUOUS').length,
      rejected: results.filter((row) => row.status === 'REJECTED_FORMAT').length,
      failed: results.filter((row) => row.status === 'FAILED').length,
      results,
    })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin legacy-graduates import-files error:', error)
    return NextResponse.json({ error: 'تعذر استيراد ملفات الشهادات' }, { status: 500 })
  }
}
