import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ unitId: string }> }

// POST /api/admin/program-units/[unitId]/regenerate/reject — discard a PENDING
// regeneration draft. Touches nothing else: the published unit content,
// the unit row and every student-side record stay exactly as they were.
export async function POST(req: NextRequest, context: Context) {
  try {
    const admin = await requireAdmin()
    const { unitId } = await context.params
    const draft = await db.unitRegenerationDraft.findFirst({
      where: { unitId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    })
    if (!draft) return NextResponse.json({ error: 'UNIT_REGENERATION_DRAFT_NOT_FOUND' }, { status: 404 })
    await db.unitRegenerationDraft.update({
      where: { id: draft.id },
      data: { status: 'REJECTED', decidedAt: new Date() },
    })
    await audit(admin, 'REJECT_UNIT_REGENERATION', 'Unit', unitId,
      'رفض معاينة إعادة توليد الوحدة المتضررة — بقي المحتوى المنشور كما هو'
    ).catch((auditError) => console.error('Unit regeneration reject audit failed after commit:', auditError))
    return NextResponse.json({ ok: true, draftId: draft.id, status: 'REJECTED' })
  } catch (error: any) {
    if (String(error?.message || error) === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('damaged unit regeneration reject error:', error)
    return NextResponse.json({ error: 'تعذر رفض معاينة إعادة التوليد' }, { status: 500 })
  }
}
