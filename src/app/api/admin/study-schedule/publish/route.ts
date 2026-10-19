import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'

const requestSchema = z.object({
  programId: z.string().min(1).max(120),
  semester: z.coerce.number().int().min(1).max(12),
})

function isAdminAuthError(error: any) {
  return ['UNAUTHORIZED', 'FORBIDDEN'].includes(String(error?.message || error || '').toUpperCase())
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const parsed = requestSchema.parse(await req.json().catch(() => ({})))
    const result = await db.studyScheduleItem.updateMany({
      where: { programId: parsed.programId, semester: parsed.semester },
      data: { status: 'PUBLISHED' },
    })
    return NextResponse.json({ published: result.count })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (error?.name === 'ZodError') return NextResponse.json({ error: 'بيانات النشر غير صالحة' }, { status: 400 })
    return NextResponse.json({ error: 'تعذر نشر جدول الدراسة' }, { status: 500 })
  }
}
