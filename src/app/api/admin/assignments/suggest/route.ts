import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { textAiCompleteJson } from '@/lib/text-ai'
import { cleanAcademicGeneratedText, looksLikeBrokenAcademicOutput } from '@/lib/knowledge-bank'
import { conciseAcademicLabel, sanitizeAcademicLabelList } from '@/lib/academic-output-quality'

export const runtime = 'nodejs'
export const maxDuration = 180

interface AssignmentSuggestion {
  title: string
  description: string
  type: string
  semester: number
  points: number
  weight: number
  dueDays: number
  rubric: string
  sourceKnowledgeTitles: string[]
  sourceKnowledgeIds: string[]
  unitId?: string | null
}

const TYPE_SET = new Set(['REPORT', 'CASE_STUDY', 'SUMMARY', 'PROJECT', 'REFLECTION'])

function clean(value: unknown, max = 2000) {
  return String(value || '').replace(/\u0000/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function cleanAssignmentText(value: unknown, fallback = '', max = 2000, allowShort = false) {
  const cleaned = cleanAcademicGeneratedText(value, max).replace(/\s+/g, ' ').trim()
  return cleaned && !looksLikeBrokenAcademicOutput(cleaned, { allowShort }) ? cleaned : fallback
}

function cleanAssignmentSourceTitles(values: unknown, fallback: string[] = [], maxItems = 6) {
  return sanitizeAcademicLabelList(values, fallback, maxItems, 72)
}

function titleFromKnowledge(item: any, fallback = 'محور معرفي') {
  return conciseAcademicLabel(item?.title || item?.summary || item, fallback, 80)
}

function asInt(value: unknown, fallback: number, min: number, max: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function arrayFromJson(value: any): any[] {
  if (Array.isArray(value)) return value
  for (const key of ['suggestions', 'items', 'data', 'assignments', 'results']) if (Array.isArray(value?.[key])) return value[key]
  return []
}

function parseJsonArray(raw: string): any[] {
  const body = clean(raw, 20000)
  try { return arrayFromJson(JSON.parse(body)) } catch {}
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) { try { return arrayFromJson(JSON.parse(fenced)) } catch {} }
  const arr = body.match(/\[[\s\S]*\]/)?.[0]
  if (arr) { try { return arrayFromJson(JSON.parse(arr)) } catch {} }
  const obj = body.match(/\{[\s\S]*\}/)?.[0]
  if (obj) { try { return arrayFromJson(JSON.parse(obj)) } catch {} }
  return []
}

function normalizeSuggestions(raw: any[], semester: number, allowedIds: Set<string>, titleById: Map<string, string>, fallbackUnitId?: string | null): AssignmentSuggestion[] {
  const seen = new Set<string>()
  const out: AssignmentSuggestion[] = []
  for (const item of raw) {
    const title = cleanAssignmentText(item?.title, '', 180, true)
    const description = cleanAssignmentText(item?.description, '', 5000)
    if (!title || !description || looksLikeBrokenAcademicOutput(`${title}. ${description}`)) continue
    const ids = Array.isArray(item?.sourceKnowledgeIds) ? item.sourceKnowledgeIds.map((id: any) => clean(id, 100)).filter((id: string) => allowedIds.has(id)) : []
    if (!ids.length) continue
    const key = title.toLowerCase().replace(/\s+/g, ' ')
    if (seen.has(key)) continue
    seen.add(key)
    const type = TYPE_SET.has(String(item?.type || '').toUpperCase()) ? String(item.type).toUpperCase() : 'CASE_STUDY'
    const sourceTitles = cleanAssignmentSourceTitles(item?.sourceKnowledgeTitles, ids.map((id: string) => titleById.get(id) || id), 6)
    out.push({
      title,
      description,
      type,
      semester: asInt(item?.semester, semester, 1, 3),
      points: asInt(item?.points, 15, 5, 100),
      weight: asInt(item?.weight, 0, 0, 100),
      dueDays: asInt(item?.dueDays, 14, 1, 365),
      rubric: cleanAssignmentText(item?.rubric, '', 1600) || 'الاستناد إلى مصادر الوحدة 30%، جودة التحليل 30%، التطبيق المهني 25%، وضوح العرض 15%',
      sourceKnowledgeTitles: sourceTitles,
      sourceKnowledgeIds: [...new Set(ids)],
      unitId: clean(item?.unitId, 100) || fallbackUnitId || null,
    })
    if (out.length >= 6) break
  }
  return out
}

async function unitKnowledge(programId: string, semester: number, unitId?: string | null) {
  const units = await db.unit.findMany({
    where: { programId, ...(unitId ? { id: unitId } : semester === 3 ? {} : { semester }) },
    orderBy: [{ semester: 'asc' }, { order: 'asc' }],
    select: { id: true, title: true, semester: true, sourceBookId: true, chunkStartIndex: true, chunkEndIndex: true },
  })
  const out: any[] = []
  for (const unit of units) {
    if (!unit.sourceBookId || unit.chunkStartIndex == null || unit.chunkEndIndex == null) continue
    const chunks = await db.bookChunk.findMany({ where: { bookId: unit.sourceBookId, index: { gte: unit.chunkStartIndex, lte: unit.chunkEndIndex } }, select: { id: true } })
    if (!chunks.length) continue
    const knowledge = await db.bookKnowledgeItem.findMany({ where: { programId, kbVersion: 2, chunkId: { in: chunks.map((chunk) => chunk.id) }, category: { notIn: ['QUESTION_SEED', 'LEGACY'] } }, orderBy: [{ importance: 'desc' }, { pageStart: 'asc' }], take: unitId ? 80 : 40 })
    for (const item of knowledge) out.push({ ...item, unitId: unit.id, unitTitle: unit.title, unitSemester: unit.semester })
  }
  return out
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const programId = clean(body.programId, 80)
    const semester = asInt(body.semester, 1, 1, 3)
    const unitId = clean(body.unitId, 80) || null
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    const program = await db.program.findUnique({ where: { id: programId }, select: { id: true, titleAr: true, titleEn: true, category: true, description: true } })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const knowledge = await unitKnowledge(programId, semester, unitId)
    if (!knowledge.length) return NextResponse.json({ error: unitId ? 'لا توجد عناصر معرفة v2 داخل نطاق هذه الوحدة. ولّد محتوى الوحدة أولاً.' : 'لا توجد وحدات ذات مصادر v2 لهذا الفصل. ولّد محتوى الوحدات أولاً.' }, { status: 400 })

    const existing = await db.programAssignment.findMany({ where: { programId }, select: { title: true } })
    const existingTitles = existing.map((a) => a.title).join('، ')
    const titleById = new Map(knowledge.map((k) => [k.id, titleFromKnowledge(k)]))
    const allowedIds = new Set(knowledge.map((k) => k.id))
    const knowledgeContext = knowledge.slice(0, 60).map((k, i) => `${i + 1}. id=${k.id}\nالوحدة: ${k.unitTitle}\nالعنوان: ${titleFromKnowledge(k)}\nالفئة: ${k.category}\nالصفحات: ${k.pageStart ?? '؟'}–${k.pageEnd ?? k.pageStart ?? '؟'}\nالملخص: ${cleanAssignmentText(k.summary, '', 520)}\nالمقتطف: ${cleanAssignmentText(k.excerpt, '', 520)}`).join('\n\n')

    const prompt = `صمم 4 إلى 6 واجبات أكاديمية من عناصر معرفة v2 داخل نطاق الوحدات فقط.\n\nالبرنامج: ${program.titleAr}\nالفصل: ${semester === 2 ? 'الثاني' : semester === 3 ? 'بحث/مشروع' : 'الأول'}\nالواجبات الموجودة لتجنب التكرار: ${existingTitles || 'لا يوجد'}\n\nمصادر الوحدة المسموحة:\n${knowledgeContext}\n\nأرجع JSON array فقط. كل واجب يجب أن يحتوي title, description, type, semester, points, weight, dueDays, rubric, unitId, sourceKnowledgeIds, sourceKnowledgeTitles.\nقواعد إلزامية: sourceKnowledgeIds من ids أعلاه فقط، والوصف يذكر مراجع الصفحات، ولا تكتب واجباً عاماً أو قالبياً.`

    let raw = ''
    try {
      raw = await textAiCompleteJson({ system: 'أنت مصمم تكليفات جامعية مصدرية. أعد JSON فقط.', history: [{ role: 'user', text: prompt }], taskLevel: 'ACADEMIC_CRITICAL', routerPolicy: 'balanced', temperature: 0.15, maxOutputTokens: 6000, stickyScope: `ASSIGNMENTS:${programId}:${unitId || semester}` })
    } catch (error: any) {
      return NextResponse.json({ error: `توقف اقتراح الواجبات مؤقتاً: ${String(error?.message || error)}`, status: 'PAUSED' }, { status: 503 })
    }
    const suggestions = normalizeSuggestions(parseJsonArray(raw), semester, allowedIds, titleById, unitId)
    if (!suggestions.length) return NextResponse.json({ error: 'لم ينتج الراوتر واجبات موثقة بالمصادر. لم تُنشأ قوالب بديلة.', status: 'PAUSED' }, { status: 503 })
    return NextResponse.json({ suggestions })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('assignment suggestions error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر اقتراح الواجبات' }, { status: 500 })
  }
}
