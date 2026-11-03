import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import {
  LEGACY_CERTIFICATE_ZIP_MAX_BYTES,
  createLegacyCertificateZipUploadUrl,
  newLegacyCertificateZipImportKey,
} from '@/lib/legacy-certificate-files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/admin/legacy-graduates/import-files/presign — يجهّز رفعًا مباشرًا
// من المتصفح إلى التخزين لملف ZIP كبير: يعيد رابط PUT موقّعًا ومفتاح التخزين،
// ثم يُستدعى مسار الاستيراد نفسه بالمفتاح فقط. هيك الأرشيف ما بيمرّ بجسم طلب
// الدالة (سقفه 4.5MB على Vercel) مهما كان حجمه ضمن الحد الأقصى.
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = (await req.json().catch(() => null)) as { size?: unknown; fileName?: unknown } | null
    const size = typeof body?.size === 'number' ? Math.floor(body.size) : 0
    if (!Number.isFinite(size) || size <= 0) return NextResponse.json({ error: 'حجم الملف مطلوب' }, { status: 400 })
    if (size > LEGACY_CERTIFICATE_ZIP_MAX_BYTES) return NextResponse.json({ error: 'حجم ملف ZIP كبير جداً' }, { status: 413 })

    const key = newLegacyCertificateZipImportKey()
    const uploadUrl = createLegacyCertificateZipUploadUrl(key)
    if (!uploadUrl) return NextResponse.json({ error: 'الرفع المباشر غير متاح على هذا الخادم' }, { status: 422 })

    // Record the import session up front: the archive stays in storage and
    // the session row is what a later resume (from any device, after any
    // refresh) re-processes and updates.
    const fileName = typeof body?.fileName === 'string' && body.fileName.trim() ? body.fileName.trim().slice(0, 200) : 'legacy-certificates.zip'
    const session = await db.legacyCertificateZipImport.create({
      data: { adminId: admin.id, fileName, sizeBytes: size, storageKey: key },
    })

    return NextResponse.json({ uploadUrl, key, importId: session.id, maxBytes: LEGACY_CERTIFICATE_ZIP_MAX_BYTES })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin legacy-graduates import-files presign error:', error)
    return NextResponse.json({ error: 'تعذر تجهيز رابط الرفع' }, { status: 500 })
  }
}
