import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// اقتراحات المشرفين على الوحدات — جهة الإدارة: عرض الكل (المعلّق أولًا)
// والبتّ (قبول/رفض + ملاحظة تصل المشرف).

export async function GET() {
  try {
    await requireAdmin()
    const rows = await (db as any).supervisorUnitProposal.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 200 })
    const supervisorIds: string[] = [...new Set<string>(rows.map((r: any) => r.supervisorId as string))]
    const programIds: string[] = [...new Set<string>(rows.map((r: any) => r.programId as string))]
    const unitIds: string[] = [...new Set<string>(rows.map((r: any) => r.unitId as string).filter(Boolean))]
    const [supervisors, programs, units] = await Promise.all([
      supervisorIds.length ? db.user.findMany({ where: { id: { in: supervisorIds } }, select: { id: true, name: true } }) : [],
      programIds.length ? db.program.findMany({ where: { id: { in: programIds } }, select: { id: true, titleAr: true } }) : [],
      unitIds.length ? db.unit.findMany({ where: { id: { in: unitIds as string[] } }, select: { id: true, title: true } }) : [],
    ])
    const supById = new Map(supervisors.map((u) => [u.id, u.name] as const))
    const progById = new Map(programs.map((p) => [p.id, p.titleAr] as const))
    const unitById = new Map(units.map((u) => [u.id, u.title] as const))
    return NextResponse.json({
      proposals: rows.map((r: any) => ({
        ...r,
        supervisorName: supById.get(r.supervisorId) || '',
        programTitle: progById.get(r.programId) || '',
        unitTitle: r.unitId ? unitById.get(r.unitId) || '' : '',
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin supervisor-proposals GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الاقتراحات' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const id = String(body?.id || '').trim()
    const status = String(body?.status || '').trim().toUpperCase()
    const adminNote = String(body?.adminNote || '').trim().slice(0, 1000)
    if (!id) return NextResponse.json({ error: 'معرف الاقتراح مطلوب' }, { status: 400 })
    if (status !== 'APPROVED' && status !== 'REJECTED') return NextResponse.json({ error: 'قرار غير صالح' }, { status: 400 })
    const existing = await (db as any).supervisorUnitProposal.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: 'الاقتراح غير موجود' }, { status: 404 })
    if (existing.status !== 'PENDING') return NextResponse.json({ error: 'هذا الاقتراح بُتّ فيه مسبقًا' }, { status: 409 })

    const updated = await (db as any).supervisorUnitProposal.update({
      where: { id },
      data: { status, adminNote: adminNote || null, resolvedById: admin.id, resolvedAt: new Date() },
    })
    await notify(
      existing.supervisorId,
      'GENERAL',
      status === 'APPROVED' ? 'قُبل اقتراحك على الوحدات' : 'رُفض اقتراحك على الوحدات',
      `اقتراحك «${existing.title}» ${status === 'APPROVED' ? 'قُبل من الإدارة' : 'رُفض من الإدارة'}.${adminNote ? ` ملاحظة الإدارة: ${adminNote}` : ''}`,
      '/?view=supervisor',
    )
    await audit({ id: admin.id, name: admin.name }, status === 'APPROVED' ? 'APPROVE_UNIT_PROPOSAL' : 'REJECT_UNIT_PROPOSAL', 'SupervisorUnitProposal', id, existing.title)
    return NextResponse.json({ ok: true, proposal: updated })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('admin supervisor-proposals PATCH error:', e)
    return NextResponse.json({ error: 'تعذر البت في الاقتراح' }, { status: 500 })
  }
}
