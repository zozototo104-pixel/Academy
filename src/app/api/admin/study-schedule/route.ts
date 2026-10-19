import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'
export const maxDuration = 60

const TYPES = ['READING', 'UNIT', 'STUDY_GUIDE', 'ASSIGNMENT', 'EXAM', 'REVIEW'] as const
const STATUSES = ['DRAFT', 'PUBLISHED'] as const
const SOURCES = ['AI', 'MANUAL', 'IMPORT'] as const

const itemSchema = z.object({
  programId: z.string().min(1).max(120),
  semester: z.coerce.number().int().min(1).max(12),
  week: z.coerce.number().int().min(1).max(60),
  dayOffset: z.coerce.number().int().min(0).max(420).nullable().optional(),
  title: z.string().trim().min(1).max(220),
  description: z.string().trim().max(3000).nullable().optional(),
  type: z.enum(TYPES),
  unitId: z.string().trim().min(1).max(120).nullable().optional(),
  studyGuideId: z.string().trim().min(1).max(120).nullable().optional(),
  assignmentId: z.string().trim().min(1).max(120).nullable().optional(),
  examId: z.string().trim().min(1).max(120).nullable().optional(),
  durationMin: z.coerce.number().int().min(1).max(1440).nullable().optional(),
  order: z.coerce.number().int().min(0).max(10000).optional(),
  status: z.enum(STATUSES).optional(),
  source: z.enum(SOURCES).optional(),
})

const patchSchema = itemSchema.partial().extend({ id: z.string().min(1).max(120) })

function nullIfBlank(value: unknown) {
  const text = String(value || '').trim()
  return text ? text : null
}

function isAdminAuthError(error: any) {
  return ['UNAUTHORIZED', 'FORBIDDEN'].includes(String(error?.message || error || '').toUpperCase())
}

function mapItem(item: any) {
  return {
    id: item.id,
    programId: item.programId,
    semester: item.semester,
    week: item.week,
    dayOffset: item.dayOffset,
    title: item.title,
    description: item.description,
    type: item.type,
    unitId: item.unitId,
    studyGuideId: item.studyGuideId,
    assignmentId: item.assignmentId,
    examId: item.examId,
    durationMin: item.durationMin,
    order: item.order,
    status: item.status,
    source: item.source,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

async function validateReferences(input: { programId: string; semester?: number; unitId?: string | null; studyGuideId?: string | null; assignmentId?: string | null; examId?: string | null }) {
  const checks: Promise<any>[] = []
  if (input.unitId) checks.push(db.unit.findFirst({ where: { id: input.unitId, programId: input.programId }, select: { id: true } }).then((row) => row ? null : 'unitId'))
  if (input.studyGuideId) checks.push(db.programStudyGuide.findFirst({ where: { id: input.studyGuideId, programId: input.programId }, select: { id: true } }).then((row) => row ? null : 'studyGuideId'))
  if (input.assignmentId) checks.push(db.programAssignment.findFirst({ where: { id: input.assignmentId, programId: input.programId }, select: { id: true } }).then((row) => row ? null : 'assignmentId'))
  if (input.examId) checks.push(db.programExam.findFirst({ where: { id: input.examId, programId: input.programId }, select: { id: true } }).then((row) => row ? null : 'examId'))
  const failures = (await Promise.all(checks)).filter(Boolean)
  if (failures.length) throw new Error(`INVALID_REFERENCE:${failures.join(',')}`)
}

function dataForCreate(parsed: z.infer<typeof itemSchema>) {
  return {
    programId: parsed.programId,
    semester: parsed.semester,
    week: parsed.week,
    dayOffset: parsed.dayOffset ?? null,
    title: parsed.title,
    description: nullIfBlank(parsed.description),
    type: parsed.type,
    unitId: nullIfBlank(parsed.unitId),
    studyGuideId: nullIfBlank(parsed.studyGuideId),
    assignmentId: nullIfBlank(parsed.assignmentId),
    examId: nullIfBlank(parsed.examId),
    durationMin: parsed.durationMin ?? null,
    order: parsed.order ?? 0,
    status: parsed.status || 'DRAFT',
    source: parsed.source || 'MANUAL',
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = String(req.nextUrl.searchParams.get('programId') || '').trim()
    const semesterText = req.nextUrl.searchParams.get('semester')
    const semester = semesterText ? Number(semesterText) : undefined
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const items = await db.studyScheduleItem.findMany({
      where: { programId, ...(Number.isFinite(semester) ? { semester } : {}) },
      orderBy: [{ semester: 'asc' }, { week: 'asc' }, { dayOffset: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
    })
    return NextResponse.json({ items: items.map(mapItem) })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحميل جدول الدراسة' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const parsed = itemSchema.parse(body)
    const data = dataForCreate(parsed)
    await validateReferences(data)
    const item = await db.studyScheduleItem.create({ data })
    return NextResponse.json({ item: mapItem(item) })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (error?.name === 'ZodError') return NextResponse.json({ error: 'بيانات جدول الدراسة غير صالحة' }, { status: 400 })
    if (String(error?.message || '').startsWith('INVALID_REFERENCE')) return NextResponse.json({ error: 'يوجد ارتباط غير صحيح داخل عنصر الجدول' }, { status: 400 })
    return NextResponse.json({ error: 'تعذر إضافة عنصر جدول الدراسة' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const parsed = patchSchema.parse(body)
    const current = await db.studyScheduleItem.findUnique({ where: { id: parsed.id } })
    if (!current) return NextResponse.json({ error: 'العنصر غير موجود' }, { status: 404 })
    const data: any = {}
    for (const key of ['programId', 'semester', 'week', 'dayOffset', 'title', 'description', 'type', 'unitId', 'studyGuideId', 'assignmentId', 'examId', 'durationMin', 'order', 'status', 'source'] as const) {
      if (parsed[key] !== undefined) data[key] = ['description', 'unitId', 'studyGuideId', 'assignmentId', 'examId'].includes(key) ? nullIfBlank(parsed[key]) : parsed[key]
    }
    const next = { ...current, ...data }
    await validateReferences(next)
    const item = await db.studyScheduleItem.update({ where: { id: parsed.id }, data })
    return NextResponse.json({ item: mapItem(item) })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (error?.name === 'ZodError') return NextResponse.json({ error: 'بيانات جدول الدراسة غير صالحة' }, { status: 400 })
    if (String(error?.message || '').startsWith('INVALID_REFERENCE')) return NextResponse.json({ error: 'يوجد ارتباط غير صحيح داخل عنصر الجدول' }, { status: 400 })
    return NextResponse.json({ error: 'تعذر تحديث عنصر جدول الدراسة' }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin()
    const id = String(req.nextUrl.searchParams.get('id') || '').trim()
    if (!id) return NextResponse.json({ error: 'معرف العنصر مطلوب' }, { status: 400 })
    await db.studyScheduleItem.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر حذف عنصر جدول الدراسة' }, { status: 500 })
  }
}
