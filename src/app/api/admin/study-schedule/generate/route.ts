import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { textAiCompleteJson } from '@/lib/text-ai'

export const runtime = 'nodejs'
export const maxDuration = 60

const TYPES = ['READING', 'UNIT', 'STUDY_GUIDE', 'ASSIGNMENT', 'EXAM', 'REVIEW'] as const

const requestSchema = z.object({
  programId: z.string().min(1).max(120),
  semester: z.coerce.number().int().min(1).max(12),
})

const generatedItemSchema = z.object({
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
})

const generatedSchema = z.object({ items: z.array(generatedItemSchema).max(40) })

function compactItem(row: any) {
  return {
    id: row.id,
    title: row.title,
    semester: row.semester,
    order: row.order,
    status: row.status,
  }
}

function parseAiJson(text: string) {
  const raw = String(text || '').trim()
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  return JSON.parse(cleaned)
}

function assertKnownReferences(items: z.infer<typeof generatedItemSchema>[], sets: { units: Set<string>; guides: Set<string>; assignments: Set<string>; exams: Set<string> }) {
  for (const item of items) {
    if (item.unitId && !sets.units.has(item.unitId)) throw new Error(`INVALID_UNIT:${item.unitId}`)
    if (item.studyGuideId && !sets.guides.has(item.studyGuideId)) throw new Error(`INVALID_STUDY_GUIDE:${item.studyGuideId}`)
    if (item.assignmentId && !sets.assignments.has(item.assignmentId)) throw new Error(`INVALID_ASSIGNMENT:${item.assignmentId}`)
    if (item.examId && !sets.exams.has(item.examId)) throw new Error(`INVALID_EXAM:${item.examId}`)
  }
}

function isAdminAuthError(error: any) {
  return ['UNAUTHORIZED', 'FORBIDDEN'].includes(String(error?.message || error || '').toUpperCase())
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const parsed = requestSchema.parse(await req.json().catch(() => ({})))
    const [program, units, guides, assignments, exams] = await Promise.all([
      db.program.findUnique({ where: { id: parsed.programId }, select: { id: true, titleAr: true, titleEn: true, hours: true } }),
      db.unit.findMany({ where: { programId: parsed.programId, semester: parsed.semester, status: 'APPROVED' }, orderBy: { order: 'asc' }, select: { id: true, title: true, semester: true, order: true, status: true } }),
      db.programStudyGuide.findMany({ where: { programId: parsed.programId, semester: parsed.semester, status: 'PUBLISHED' }, orderBy: { createdAt: 'asc' }, select: { id: true, title: true, semester: true, status: true } }),
      db.programAssignment.findMany({ where: { programId: parsed.programId, semester: parsed.semester, status: 'PUBLISHED' }, orderBy: { createdAt: 'asc' }, select: { id: true, title: true, semester: true, status: true } }),
      db.programExam.findMany({ where: { programId: parsed.programId, semester: parsed.semester, status: 'READY' }, orderBy: { createdAt: 'asc' }, select: { id: true, title: true, semester: true, status: true } }),
    ])
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    if (!units.length && !guides.length && !assignments.length && !exams.length) {
      return NextResponse.json({ error: 'لا توجد وحدات أو أدلة أو واجبات أو امتحانات منشورة لهذا الفصل' }, { status: 400 })
    }

    const source = {
      program: { id: program.id, title: program.titleAr || program.titleEn || program.id, hours: program.hours },
      semester: parsed.semester,
      units: units.map(compactItem),
      studyGuides: guides.map(compactItem),
      assignments: assignments.map(compactItem),
      exams: exams.map(compactItem),
    }

    const text = await textAiCompleteJson({
      system: 'أنت مساعد تخطيط أكاديمي. أعد JSON صالحاً فقط بالشكل {"items":[]} بحد أقصى 40 عنصر. ابنِ جدول دراسة أسبوعي عربي واضح للبرنامج والفصل من المصادر المرسلة فقط. لا تستخدم أي unitId أو studyGuideId أو assignmentId أو examId غير موجود في المصادر. الحقول المسموحة لكل عنصر: week, dayOffset, title, description, type, unitId, studyGuideId, assignmentId, examId, durationMin, order. الأنواع المسموحة: READING, UNIT, STUDY_GUIDE, ASSIGNMENT, EXAM, REVIEW.',
      history: [{ role: 'user', text: JSON.stringify(source) }],
      temperature: 0.2,
      maxOutputTokens: 4096,
      taskLevel: 'ACADEMIC_CRITICAL',
      purpose: 'GENERATION',
      timeoutMs: 50_000,
      deadlineMs: Date.now() + 50_000,
    })

    const ai = generatedSchema.parse(parseAiJson(text))
    assertKnownReferences(ai.items, {
      units: new Set(units.map((item) => item.id)),
      guides: new Set(guides.map((item) => item.id)),
      assignments: new Set(assignments.map((item) => item.id)),
      exams: new Set(exams.map((item) => item.id)),
    })

    const data = ai.items.map((item, index) => ({
      programId: parsed.programId,
      semester: parsed.semester,
      week: item.week,
      dayOffset: item.dayOffset ?? null,
      title: item.title,
      description: item.description || null,
      type: item.type,
      unitId: item.unitId || null,
      studyGuideId: item.studyGuideId || null,
      assignmentId: item.assignmentId || null,
      examId: item.examId || null,
      durationMin: item.durationMin ?? null,
      order: item.order ?? index,
      status: 'DRAFT' as const,
      source: 'AI' as const,
    }))

    await db.$transaction([
      db.studyScheduleItem.deleteMany({ where: { programId: parsed.programId, semester: parsed.semester, status: 'DRAFT', source: 'AI' } }),
      ...(data.length ? [db.studyScheduleItem.createMany({ data })] : []),
    ])
    const items = await db.studyScheduleItem.findMany({
      where: { programId: parsed.programId, semester: parsed.semester },
      orderBy: [{ week: 'asc' }, { dayOffset: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
    })
    return NextResponse.json({ items, generated: data.length })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (error?.name === 'ZodError') return NextResponse.json({ error: 'استجابة جدول الدراسة غير صالحة' }, { status: 400 })
    if (String(error?.message || '').startsWith('INVALID_')) return NextResponse.json({ error: 'استجابة الذكاء تحتوي معرفاً غير موجود في مصادر الفصل' }, { status: 400 })
    return NextResponse.json({ error: 'تعذر توليد جدول الدراسة' }, { status: 500 })
  }
}
