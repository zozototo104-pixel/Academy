import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { deleteLegacyCertificateZipImport } from '@/lib/legacy-certificate-files'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/admin/legacy-graduates/import-files/sessions — جلسات استيراد ZIP
// الأخيرة مع نتائجها، حتى يظهر الاستكمال من أي جهاز وبعد أي تحديث للصفحة.
export async function GET() {
  try {
    await requireAdmin()
    const sessions = await db.legacyCertificateZipImport.findMany({
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        fileName: true,
        sizeBytes: true,
        storageKey: true,
        totalFiles: true,
        successful: true,
        notFound: true,
        rejected: true,
        failed: true,
        results: true,
        createdAt: true,
        updatedAt: true,
      },
    })
    return NextResponse.json({ sessions })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin legacy-graduates zip sessions list error:', error)
    return NextResponse.json({ error: 'تعذر تحميل جلسات الاستيراد' }, { status: 500 })
  }
}

// DELETE /api/admin/legacy-graduates/import-files/sessions?id=... — يحذف
// الجلسة وملف الأرشيف من التخزين نهائيًا.
export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin()
    const id = req.nextUrl.searchParams.get('id') || ''
    if (!id) return NextResponse.json({ error: 'معرّف الجلسة مطلوب' }, { status: 400 })
    const session = await db.legacyCertificateZipImport.findUnique({ where: { id }, select: { id: true, storageKey: true } })
    if (!session) return NextResponse.json({ error: 'الجلسة غير موجودة' }, { status: 404 })
    await deleteLegacyCertificateZipImport(session.storageKey).catch(() => {})
    await db.legacyCertificateZipImport.delete({ where: { id: session.id } })
    return NextResponse.json({ ok: true })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin legacy-graduates zip sessions delete error:', error)
    return NextResponse.json({ error: 'تعذر حذف الجلسة' }, { status: 500 })
  }
}
