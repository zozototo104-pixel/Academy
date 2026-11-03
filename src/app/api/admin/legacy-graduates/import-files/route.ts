import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { isValidLegacyGraduateEmail, normalizeLegacyGraduateEmail } from '@/lib/legacy-graduates'
import {
  LEGACY_CERTIFICATE_ZIP_MAX_BYTES,
  deleteLegacyCertificateZipImport,
  isLegacyCertificateZipImportKey,
  parseZipEntries,
  readLegacyCertificateZipImport,
  sniffLegacyCertificateMime,
  stampLegacyCertificatePdf,
  storeLegacyCertificateOriginal,
  storeLegacyCertificateStamped,
} from '@/lib/legacy-certificate-files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Bulk ZIP imports stamp and store every file in one request; Haris's paid
// Vercel plan allows up to 800s, so give the route the full window instead
// of the old 60s cap that killed large imports mid-way.
export const maxDuration = 800

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

// Parses one bulk ZIP and stamps/stores every matched certificate file.
// Shared by the classic multipart upload and the direct-to-storage flow
// (JSON body with a storage key), so both paths behave identically.
async function processLegacyCertificateZip(zipBuffer: Buffer, admin: { id: string; name?: string | null }) {
    const entries = parseZipEntries(zipBuffer)

    const results: LegacyCertificateZipImportResult[] = []
    for (const entry of entries) {
      if (entry.error) {
        const error = entry.error === 'FILE_TOO_LARGE'
          ? 'حجم الملف بعد فك الضغط يتجاوز 10MB'
          : entry.error === 'ZIP_TOTAL_TOO_LARGE'
            ? 'تجاوز مجموع الملفات بعد فك الضغط 200MB'
            : entry.error === 'ZIP_TOO_MANY_FILES'
              ? 'تجاوز ملف ZIP الحد الأقصى 300 ملف'
              : 'تعذر قبول الملف داخل ZIP'
        results.push({ fileName: entry.fileName, ok: false, status: 'REJECTED_FORMAT', error })
        continue
      }
      const entryBuffer = entry.buffer
      if (!entryBuffer) {
        results.push({ fileName: entry.fileName, ok: false, status: 'REJECTED_FORMAT', error: 'تعذر قبول الملف داخل ZIP' })
        continue
      }
      const identifier = baseIdentifier(entry.fileName)
      const mime = sniffLegacyCertificateMime(entryBuffer)
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
          buffer: entryBuffer,
          mime,
          serial: cert.serial,
          qrToken: cert.qrToken,
          qrPosition: 'BOTTOM_LEFT',
          qrSize: 'M',
        })
        const originalStored = await storeLegacyCertificateOriginal(entryBuffer, entry.fileName, mime)
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

    return {
      ok: true,
      totalFiles: entries.length,
      successful: results.filter((row) => row.ok).length,
      notFound: results.filter((row) => row.status === 'NOT_FOUND' || row.status === 'AMBIGUOUS').length,
      rejected: results.filter((row) => row.status === 'REJECTED_FORMAT').length,
      failed: results.filter((row) => row.status === 'FAILED').length,
      results,
    }
}

// Runs the shared ZIP processing; a structurally invalid archive maps to
// null (the caller answers 400), anything else keeps propagating to the
// route's 500 handler, exactly like the original inline flow.
async function runZipImport(zipBuffer: Buffer, admin: { id: string; name?: string | null }) {
  try {
    return await processLegacyCertificateZip(zipBuffer, admin)
  } catch (error: any) {
    if (String(error?.message || '').startsWith('INVALID_ZIP')) {
      console.error('legacy certificate ZIP parse error:', error)
      return null
    }
    throw error
  }
}

// POST /api/admin/legacy-graduates/import-files — ربط وختم شهادات جاهزة من ZIP
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const contentType = req.headers?.get?.('content-type') || ''

    // Direct-to-storage flow: the browser already uploaded the archive to
    // storage with a presigned URL (see import-files/presign), so the body
    // here is only the storage key — archives far beyond the 4.5MB function
    // request-body cap work through this path.
    if (contentType.includes('application/json')) {
      const body = (await req.json().catch(() => null)) as { key?: unknown; size?: unknown } | null
      const key = body?.key
      if (!isLegacyCertificateZipImportKey(key)) return NextResponse.json({ error: 'مفتاح ملف غير صالح' }, { status: 400 })
      const zipBuffer = await readLegacyCertificateZipImport(key)
      if (!zipBuffer) return NextResponse.json({ error: 'الملف المرفوع غير موجود في التخزين' }, { status: 404 })
      try {
        if (typeof body?.size === 'number' && body.size !== zipBuffer.length) return NextResponse.json({ error: 'حجم الملف المرفوع لا يطابق الحجم المعلن' }, { status: 400 })
        if (zipBuffer.length > LEGACY_CERTIFICATE_ZIP_MAX_BYTES) return NextResponse.json({ error: 'حجم ملف ZIP كبير جداً' }, { status: 413 })
        if (!looksLikeZip(zipBuffer)) return NextResponse.json({ error: 'الملف ليس ZIP صالحاً' }, { status: 400 })
        const payload = await runZipImport(zipBuffer, admin)
        if (!payload) return NextResponse.json({ error: 'تعذر قراءة ملف ZIP' }, { status: 400 })
        return NextResponse.json(payload)
      } finally {
        await deleteLegacyCertificateZipImport(key).catch(() => {})
      }
    }

    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) return NextResponse.json({ error: 'ملف ZIP مطلوب' }, { status: 400 })
    if (file.size <= 0) return NextResponse.json({ error: 'الملف فارغ' }, { status: 400 })
    if (file.size > LEGACY_CERTIFICATE_ZIP_MAX_BYTES) return NextResponse.json({ error: 'حجم ملف ZIP كبير جداً' }, { status: 413 })

    const zipBuffer = Buffer.from(await file.arrayBuffer())
    if (!looksLikeZip(zipBuffer)) return NextResponse.json({ error: 'الملف ليس ZIP صالحاً' }, { status: 400 })

    const payload = await runZipImport(zipBuffer, admin)
    if (!payload) return NextResponse.json({ error: 'تعذر قراءة ملف ZIP' }, { status: 400 })
    return NextResponse.json(payload)
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin legacy-graduates import-files error:', error)
    return NextResponse.json({ error: 'تعذر استيراد ملفات الشهادات' }, { status: 500 })
  }
}
