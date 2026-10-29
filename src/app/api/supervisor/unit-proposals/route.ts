import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { audit, notifyAdmins } from '@/lib/notify'
import { canAccessProgram, isSupervisorAdmin, requireSupervisor } from '@/lib/supervisor-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const KINDS = ['ADD', 'EDIT', 'REMOVE', 'NOTE'] as const
const KIND_LABEL: Record<string, string> = { ADD: 'إضافة وحدة', EDIT: 'تعديل وحدة', REMOVE: 'حذف وحدة', NOTE: 'ملاحظة على وحدة' }

function clean(value: unknown, max = 300) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// GET /api/supervisor/unit-proposals — اقتراحات المشرف نفسه (الأدمن: الكل)
export async function GET() {
  try {
    const actor = await requireSupervisor()
    const rows = await (db as any).supervisorUnitProposal.findMany({
      where: isSupervisorAdmin(actor) ? {} : { supervisorId: actor.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    const programIds: string[] = [...new Set<string>(rows.map((r: any) => r.programId as string))]
    const programs = programIds.length
      ? await db.program.findMany({ where: { id: { in: programIds } }, select: { id: true, titleAr: true } })
      : []
    const titleById = new Map(programs.map((p) => [p.id, p.titleAr] as const))
    return NextResponse.json({
      proposals: rows.map((r: any) => ({ ...r, programTitle: titleById.get(r.programId) || '' })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    console.error('supervisor unit-proposals GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الاقتراحات' }, { status: 500 })
  }
}

// POST /api/supervisor/unit-proposals — اقتراح فقط: لا تغيير مباشر على
// الوحدات؛ يصل الإدارة إشعار وسجل تدقيق، والقرار لها.
export async function POST(req: NextRequest) {
  try {
    const actor = await requireSupervisor()
    const body = await req.json().catch(() => ({}))
    const programId = clean(body?.programId, 100)
    const unitId = clean(body?.unitId, 100) || null
    const kind = clean(body?.kind, 20).toUpperCase()
    const title = clean(body?.title, 300)
    const details = clean(body?.details, 3000)
    if (!programId || !title || !details) return NextResponse.json({ error: 'البرنامج وعنوان الاقتراح وتفاصيله مطلوبة' }, { status: 400 })
    if (!KINDS.includes(kind as any)) return NextResponse.json({ error: 'نوع الاقتراح غير صالح' }, { status: 400 })
    if (!(await canAccessProgram(actor, programId))) {
      return NextResponse.json({ error: 'هذا البرنامج ليس ضمن برامجك' }, { status: 403 })
    }
    let unitTitle = ''
    if (unitId) {
      const unit = await db.unit.findUnique({ where: { id: unitId }, select: { id: true, title: true, programId: true } })
      if (!unit || unit.programId !== programId) return NextResponse.json({ error: 'الوحدة غير موجودة في هذا البرنامج' }, { status: 404 })
      unitTitle = unit.title
    }
    const program = await db.program.findUnique({ where: { id: programId }, select: { titleAr: true } })

    const proposal = await (db as any).supervisorUnitProposal.create({
      data: { supervisorId: actor.id, programId, unitId, kind, title, details, status: 'PENDING' },
    })

    await notifyAdmins(
      'GENERAL',
      'اقتراح مشرف على الوحدات',
      `${actor.name} اقترح «${KIND_LABEL[kind] || kind}» في برنامج «${program?.titleAr || ''}»${unitTitle ? ` — الوحدة: ${unitTitle}` : ''}: ${title}`,
      'admin',
    )
    await audit({ id: actor.id, name: actor.name }, 'SUPERVISOR_UNIT_PROPOSAL', 'Program', programId, `${KIND_LABEL[kind] || kind}: ${title}`)

    return NextResponse.json({ ok: true, proposal })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    console.error('supervisor unit-proposals POST error:', e)
    return NextResponse.json({ error: 'تعذر إرسال الاقتراح' }, { status: 500 })
  }
}
