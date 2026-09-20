import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

function cleanText(value: unknown, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function parseObjectives(value: unknown) {
  if (Array.isArray(value)) return value.map((x) => cleanText(x, 240)).filter((x) => x.length > 3).slice(0, 12)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.map((x) => cleanText(x, 240)).filter((x) => x.length > 3).slice(0, 12)
    } catch {}
    return value.split(/\n|،|,/).map((x) => cleanText(x, 240)).filter((x) => x.length > 3).slice(0, 12)
  }
  return []
}

function parseContent(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((x: any) => ({ heading: cleanText(x?.heading, 160) || 'محور', body: cleanText(x?.body, 1000) })).filter((x) => x.body).slice(0, 10)
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parseContent(parsed)
    } catch {}
    return [{ heading: 'محتوى الوحدة', body: cleanText(value, 1200) }]
  }
  return []
}

async function listProgramUnits(programId: string) {
  const units = await db.unit.findMany({
    where: { programId },
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    include: { bookLinks: { include: { book: { select: { id: true, title: true, semester: true } } } } },
  })
  return units.map((u) => ({
    id: u.id,
    title: u.title,
    summary: u.summary,
    objectives: parseObjectives(u.objectives),
    content: parseContent(u.content),
    order: u.order,
    createdAt: u.createdAt,
    books: u.bookLinks.map((l) => l.book),
  }))
}

// GET /api/admin/program-units?programId=...
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = cleanText(req.nextUrl.searchParams.get('programId'), 80)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const program = await db.program.findUnique({
      where: { id: programId },
      select: { id: true, titleAr: true, semestersCount: true, academicReadinessStatus: true },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    return NextResponse.json({ program, units: await listProgramUnits(programId) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program units GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل وحدات البرنامج' }, { status: 500 })
  }
}

// POST /api/admin/program-units — إضافة وحدة بشرية أثناء المراجعة
export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json()
    const programId = cleanText(body?.programId, 80)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const count = await db.unit.count({ where: { programId } })
    const unit = await db.unit.create({
      data: {
        programId,
        order: Number(body?.order || count + 1),
        title: cleanText(body?.title, 220) || 'وحدة جديدة',
        summary: cleanText(body?.summary, 2000) || 'ملخص الوحدة',
        objectives: JSON.stringify(parseObjectives(body?.objectives).length ? parseObjectives(body?.objectives) : ['هدف تعلم قابل للقياس']),
        content: JSON.stringify(parseContent(body?.content).length ? parseContent(body?.content) : [{ heading: 'محتوى الوحدة', body: cleanText(body?.summary, 1000) || 'محتوى قابل للمراجعة البشرية.' }]),
      },
    })
    await db.program.update({ where: { id: programId }, data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null } })
    return NextResponse.json({ ok: true, unit, units: await listProgramUnits(programId) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program units POST error:', e)
    return NextResponse.json({ error: 'تعذر إضافة الوحدة' }, { status: 500 })
  }
}

// PATCH /api/admin/program-units — تعديل وحدة أو إعادة ترتيب الوحدات
export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json()
    const unitId = cleanText(body?.unitId, 80)
    const programId = cleanText(body?.programId, 80)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    if (Array.isArray(body?.orders)) {
      for (const item of body.orders) {
        const id = cleanText(item?.id, 80)
        if (!id) continue
        await db.unit.updateMany({ where: { id, programId }, data: { order: Number(item.order || 0) } })
      }
    } else {
      if (!unitId) return NextResponse.json({ error: 'معرف الوحدة مطلوب' }, { status: 400 })
      const data: any = {}
      if (body?.title !== undefined) data.title = cleanText(body.title, 220) || 'وحدة بلا عنوان'
      if (body?.summary !== undefined) data.summary = cleanText(body.summary, 2500) || null
      if (body?.objectives !== undefined) data.objectives = JSON.stringify(parseObjectives(body.objectives))
      if (body?.content !== undefined) data.content = JSON.stringify(parseContent(body.content))
      if (body?.order !== undefined) data.order = Number(body.order || 0)
      await db.unit.updateMany({ where: { id: unitId, programId }, data })
    }

    await db.program.update({ where: { id: programId }, data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null } })
    return NextResponse.json({ ok: true, units: await listProgramUnits(programId) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program units PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تعديل وحدات البرنامج' }, { status: 500 })
  }
}

// DELETE /api/admin/program-units?programId=...&unitId=...
export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = cleanText(req.nextUrl.searchParams.get('programId'), 80)
    const unitId = cleanText(req.nextUrl.searchParams.get('unitId'), 80)
    if (!programId || !unitId) return NextResponse.json({ error: 'معرف البرنامج والوحدة مطلوبان' }, { status: 400 })
    await db.unit.deleteMany({ where: { id: unitId, programId } })
    await db.program.update({ where: { id: programId }, data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null } })
    return NextResponse.json({ ok: true, units: await listProgramUnits(programId) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program units DELETE error:', e)
    return NextResponse.json({ error: 'تعذر حذف الوحدة' }, { status: 500 })
  }
}
