import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { createLegacyGraduatesTemplateBuffer } from '@/lib/legacy-graduates-import'

// GET /api/admin/legacy-graduates/template — نموذج Excel للاستيراد
export async function GET(_req: NextRequest) {
  try {
    await requireAdmin()
    const buffer = createLegacyGraduatesTemplateBuffer()
    const body = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="legacy-graduates-template.xlsx"',
        'Cache-Control': 'no-store',
      },
    })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin legacy-graduates template error:', error)
    return NextResponse.json({ error: 'تعذر إنشاء نموذج الاستيراد' }, { status: 500 })
  }
}
