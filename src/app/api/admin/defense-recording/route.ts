import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

// GET /api/admin/defense-recording?thesisId=xxx — تشغيل تسجيل جلسة المناقشة المؤرشف
// متاح للإدارة والمشرفين ولباحث البحث نفسه
export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const thesisId = req.nextUrl.searchParams.get('thesisId')
    if (!thesisId) return NextResponse.json({ error: 'معرف البحث مطلوب' }, { status: 400 })

    const thesis = await db.thesisSubmission.findUnique({ where: { id: thesisId } })
    if (!thesis) return NextResponse.json({ error: 'البحث غير موجود' }, { status: 404 })

    const allowed = ['ADMIN', 'SUPERVISOR'].includes(user.role) || thesis.userId === user.id
    if (!allowed) return NextResponse.json({ error: 'لا تملك صلاحية الوصول لهذا التسجيل' }, { status: 403 })

    if (!thesis.recordingData) return NextResponse.json({ error: 'لا يوجد تسجيل مؤرشف لهذه الجلسة' }, { status: 404 })

    const buf = Buffer.from(thesis.recordingData, 'base64')
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': thesis.recordingMime || 'video/webm',
        'Content-Length': String(buf.length),
        'Content-Disposition': `inline; filename="defense-${thesisId}.webm"`,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('defense recording GET error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل التسجيل' }, { status: 500 })
  }
}
