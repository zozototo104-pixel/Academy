import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'

const TYPES = ['READING', 'UNIT', 'STUDY_GUIDE', 'ASSIGNMENT', 'EXAM', 'REVIEW'] as const

const importItemSchema = z.object({
  semester: z.coerce.number().int().min(1).max(12),
  week: z.coerce.number().int().min(1).max(60),
  title: z.string().trim().min(1).max(220),
  type: z.enum(TYPES),
  description: z.string().trim().max(3000).optional().default(''),
  durationMin: z.coerce.number().int().min(1).max(1440).optional(),
})

const template = 'semester,week,title,type,description,durationMin\n1,1,قراءة تمهيدية,READING,قراءة المدخل العام,60\n'

function csvEscape(value: unknown) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"' && quoted && line[i + 1] === '"') {
      cell += '"'
      i += 1
    } else if (ch === '"') {
      quoted = !quoted
    } else if (ch === ',' && !quoted) {
      cells.push(cell)
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell)
  return cells.map((value) => value.trim())
}

function parseCsv(text: string) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) return []
  const headers = splitCsvLine(lines[0]).map((item) => item.trim())
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line)
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']))
  })
}

async function readImportRows(req: NextRequest) {
  const contentType = req.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const body = await req.json().catch(() => ({}))
    return Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : []
  }
  return parseCsv(await req.text())
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const action = String(req.nextUrl.searchParams.get('action') || 'template')
    if (action === 'template') {
      return new NextResponse(template, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="study-schedule-template.csv"' } })
    }
    const programId = String(req.nextUrl.searchParams.get('programId') || '').trim()
    const semester = Number(req.nextUrl.searchParams.get('semester') || NaN)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const items = await db.studyScheduleItem.findMany({
      where: { programId, ...(Number.isFinite(semester) ? { semester } : {}) },
      orderBy: [{ semester: 'asc' }, { week: 'asc' }, { order: 'asc' }],
    })
    const header = 'semester,week,title,type,description,durationMin\n'
    const rows = items.map((item) => [item.semester, item.week, item.title, item.type, item.description || '', item.durationMin || ''].map(csvEscape).join(',')).join('\n')
    return new NextResponse(`${header}${rows}${rows ? '\n' : ''}`, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="study-schedule.csv"' } })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تصدير جدول الدراسة' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = String(req.nextUrl.searchParams.get('programId') || '').trim()
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const rows = await readImportRows(req)
    const parsed = z.array(importItemSchema).max(200).parse(rows)
    const data = parsed.map((item, index) => ({
      programId,
      semester: item.semester,
      week: item.week,
      title: item.title,
      description: item.description || null,
      type: item.type,
      durationMin: item.durationMin ?? null,
      order: index,
      status: 'DRAFT' as const,
      source: 'IMPORT' as const,
    }))
    if (data.length) await db.studyScheduleItem.createMany({ data })
    return NextResponse.json({ imported: data.length })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (error?.name === 'ZodError') return NextResponse.json({ error: 'ملف الاستيراد غير صالح' }, { status: 400 })
    return NextResponse.json({ error: 'تعذر استيراد جدول الدراسة' }, { status: 500 })
  }
}
