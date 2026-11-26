import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { buildComprehensiveExamTemplateBuffer } from '@/lib/comprehensive-exam'

export const runtime = 'nodejs'

// GET /api/admin/comprehensive-exams/[id]/template — قالب Excel للاستيراد
export async function GET() {
  try {
    await requireAdmin()
    const buffer = buildComprehensiveExamTemplateBuffer()
    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="comprehensive-exam-questions-template.xlsx"',
        'Cache-Control': 'no-store',
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam template error:', e)
    return NextResponse.json({ error: 'تعذر تنزيل القالب' }, { status: 500 })
  }
}
