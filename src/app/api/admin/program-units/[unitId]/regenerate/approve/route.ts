import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { buildUnitRegenerationApproveData } from '@/lib/outline-units'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ unitId: string }> }

// POST /api/admin/program-units/[unitId]/regenerate/approve — apply a PENDING
// regeneration draft to the published unit. The update writes ONLY the
// content fields (summary / objectives / content + generationVersion bump,
// via buildUnitRegenerationApproveData). Unit id, order, semester, status,
// program, source book, chunk range, outline link, exam, assignments and
// all student records, grades, attempts and submissions are never touched.
export async function POST(req: NextRequest, context: Context) {
  try {
    const admin = await requireAdmin()
    const { unitId } = await context.params
    const draft = await db.unitRegenerationDraft.findFirst({
      where: { unitId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    })
    if (!draft) return NextResponse.json({ error: 'UNIT_REGENERATION_DRAFT_NOT_FOUND' }, { status: 404 })
    const unit = await db.unit.findUnique({ where: { id: unitId }, select: { id: true, title: true } })
    if (!unit) return NextResponse.json({ error: 'UNIT_NOT_FOUND' }, { status: 404 })
    const updatedUnit = await db.$transaction(async (tx) => {
      const applied = await tx.unit.update({
        where: { id: unitId },
        data: buildUnitRegenerationApproveData(draft),
      })
      await tx.unitRegenerationDraft.update({
        where: { id: draft.id },
        data: { status: 'APPROVED', decidedAt: new Date() },
      })
      return applied
    }, { maxWait: 20000, timeout: 30000 })
    await audit(admin, 'APPROVE_UNIT_REGENERATION', 'Unit', unitId,
      `اعتماد معاينة إعادة توليد الوحدة المتضررة: ${unit.title}`
    ).catch((auditError) => console.error('Unit regeneration approve audit failed after commit:', auditError))
    return NextResponse.json({
      ok: true,
      unit: { id: updatedUnit.id, title: updatedUnit.title, order: updatedUnit.order, semester: updatedUnit.semester, status: updatedUnit.status, generationVersion: updatedUnit.generationVersion },
    })
  } catch (error: any) {
    if (String(error?.message || error) === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('damaged unit regeneration approve error:', error)
    return NextResponse.json({ error: 'تعذر اعتماد معاينة إعادة التوليد' }, { status: 500 })
  }
}
