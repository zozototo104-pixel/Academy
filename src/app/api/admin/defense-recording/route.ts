import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { readStoredFile } from '@/lib/storage'

const MAX_DEFENSE_RECORDING_BYTES = 350 * 1024 * 1024

// GET /api/admin/defense-recording?thesisId=xxx — تشغيل تسجيل جلسة المناقشة المؤرشف
// متاح للإدارة فقط لأن تسجيلات المناقشة تحتوي بيانات أكاديمية وشخصية حساسة.
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const thesisId = req.nextUrl.searchParams.get('thesisId')
    if (!thesisId) return NextResponse.json({ error: 'معرف البحث مطلوب' }, { status: 400 })

    const thesis = await db.thesisSubmission.findUnique({ where: { id: thesisId } })
    if (!thesis) return NextResponse.json({ error: 'البحث غير موجود' }, { status: 404 })

    const stored = await readStoredFile({
      provider: thesis.recordingStorageProvider,
      key: thesis.recordingStorageKey,
      url: thesis.recordingUrl,
      mimeType: thesis.recordingMime || 'video/webm',
      maxBytes: MAX_DEFENSE_RECORDING_BYTES,
      timeoutMs: 25_000,
    })

    const fallback = !stored && thesis.recordingData
      ? { buffer: Buffer.from(thesis.recordingData, 'base64'), mimeType: thesis.recordingMime || 'video/webm' }
      : null
    const recording = stored || fallback
    if (!recording) return NextResponse.json({ error: 'لا يوجد تسجيل مؤرشف لهذه الجلسة' }, { status: 404 })

    return new NextResponse(new Uint8Array(recording.buffer), {
      headers: {
        'Content-Type': recording.mimeType || thesis.recordingMime || 'video/webm',
        'Content-Length': String(recording.buffer.length),
        'Content-Disposition': `inline; filename="defense-${thesisId}.webm"`,
        'Cache-Control': 'private, no-store, max-age=0',
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (String(e?.message || e) === 'STORAGE_FILE_TOO_LARGE') return NextResponse.json({ error: 'حجم التسجيل أكبر من الحد المسموح للعرض المباشر' }, { status: 413 })
    console.error('defense recording GET error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل التسجيل' }, { status: 500 })
  }
}
