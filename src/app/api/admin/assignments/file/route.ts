import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'معرف التسليم مطلوب' }, { status: 400 })
    const submission = await db.assignmentSubmission.findUnique({ where: { id }, select: { fileName: true, mimeType: true, data: true } })
    if (!submission?.data) return NextResponse.json({ error: 'لا يوجد ملف مرفق لهذا التسليم' }, { status: 404 })
    const buffer = Buffer.from(submission.data, 'base64')
    const name = encodeURIComponent(submission.fileName || 'assignment-submission')
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'content-type': submission.mimeType || 'application/octet-stream',
        'content-disposition': `inline; filename*=UTF-8''${name}`,
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('assignment submission file error:', e)
    return NextResponse.json({ error: 'تعذر فتح ملف الواجب' }, { status: 500 })
  }
}
