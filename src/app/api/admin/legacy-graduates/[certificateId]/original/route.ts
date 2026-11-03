import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { readLegacyCertificateStoredFile, sniffLegacyCertificateMime } from '@/lib/legacy-certificate-files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ certificateId: string }> | { certificateId: string } }

// GET — الملف الأصلي كما رُفع (قبل الختم)، حتى تعرضه نافذة الختم كخلفية
// للوحة ضبط المواضع فيُسحب الـQR والرقم فوق الشهادة الحقيقية لا فوق فراغ.
export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    await requireAdmin()
    const { certificateId } = await context.params
    const cert = await db.certificate.findUnique({ where: { id: certificateId } })
    if (!cert || !cert.legacy || !cert.uploadedFileKey) {
      return NextResponse.json({ error: 'لا يوجد ملف أصلي مخزّن لهذه الشهادة' }, { status: 404 })
    }
    const stored = await readLegacyCertificateStoredFile(cert.uploadedFileKey, cert.uploadedMime)
    if (!stored) return NextResponse.json({ error: 'تعذر قراءة الملف الأصلي المخزن' }, { status: 404 })
    const contentType = sniffLegacyCertificateMime(stored.buffer) || cert.uploadedMime || 'application/octet-stream'
    return new NextResponse(new Uint8Array(stored.buffer), {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
      },
    })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin legacy-graduates original file error:', error)
    return NextResponse.json({ error: 'تعذر تحميل الملف الأصلي' }, { status: 500 })
  }
}
