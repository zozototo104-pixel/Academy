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
  // لا موعد من الذكاء أبدًا: الأدمن يحدد تاريخ التسليم الثابت قبل النشر.
  dueDays: number | null
  dueAt: null
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
  try { return arrayFromJson(JSON.parse(body)) } catch (error) { console.warn('Failed to parse assignments JSON directly:', error) }
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) { try { return arrayFromJson(JSON.parse(fenced)) } catch (error) { console.warn('Failed to parse fenced assignments JSON:', error) } }
  const arr = body.match(/\[[\s\S]*\]/)?.[0]
  if (arr) { try { return arrayFromJson(JSON.parse(arr)) } catch (error) { console.warn('Failed to parse assignment array JSON:', error) } }
  const obj = body.match(/\{[\s\S]*\}/)?.[0]
  if (obj) { try { return arrayFromJson(JSON.parse(obj)) } catch (error) { console.warn('Failed to parse assignment object JSON:', error) } }
  return []
}

function normalizeSuggestions(raw: any[], semester: number, allowedIds: Set<string>, titleById: Map<string, string>, unitById: Map<string, Set<string>>, fallbackUnitId?: string | null): AssignmentSuggestion[] {
  const seen = new Set<string>()
  const out: AssignmentSuggestion[] = []
  for (const item of raw) {
    const title = cleanAssignmentText(item?.title, '', 180, true)
    const description = cleanAssignmentText(item?.description, '', 5000)
    if (!title || !description || looksLikeBrokenAcademicOutput(`${title}. ${description}`)) continue
    const ids: string[] = Array.isArray(item?.sourceKnowledgeIds) ? item.sourceKnowledgeIds.map((id: unknown) => clean(id, 100)).filter((id: string): id is string => Boolean(id) && allowedIds.has(id)) : []
    if (!ids.length) continue
    // Infer the unit from trusted source-to-unit mappings, never from an AI-supplied ID alone.
    const matchingUnitIds = [...(unitById.get(ids[0]) || new Set<string>())]
      .filter((candidate) => ids.every((id) => unitById.get(id)?.has(candidate)))
    const requestedUnitId = clean(item?.unitId, 100) || fallbackUnitId || ''
    const proposedUnitId = matchingUnitIds.includes(requestedUnitId)
      ? requestedUnitId
      : matchingUnitIds.length === 1 ? matchingUnitIds[0] : ''
    if (!proposedUnitId) continue
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
      dueDays: null,
      dueAt: null,
      rubric: cleanAssignmentText(item?.rubric, '', 1600) || 'الاستناد إلى مصادر الوحدة 30%، جودة التحليل 30%، التطبيق المهني 25%، وضوح العرض 15%',
      sourceKnowledgeTitles: sourceTitles,
      sourceKnowledgeIds: Array.from(new Set<string>(ids)),
      unitId: proposedUnitId,
    })
  }
  // Select one proposal per unit before taking second proposals from any unit.
  // This makes semester-wide results representative without inventing assignments.
  const byUnit = new Map<string, AssignmentSuggestion[]>()
  for (const suggestion of out) {
    const group = byUnit.get(suggestion.unitId || '') || []
    group.push(suggestion)
    byUnit.set(suggestion.unitId || '', group)
  }
  const balanced: AssignmentSuggestion[] = []
  while (balanced.length < 6) {
    let added = false
    for (const group of byUnit.values()) {
      if (balanced.length >= 6) break
      const next = group.shift()
      if (next) {
        balanced.push(next)
        added = true
      }
    }
    if (!added) break
  }
  return balanced
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
    const titleById = new Map(knowledge.map((k) => [String(k.id), titleFromKnowledge(k)] as const))
    const allowedIds = new Set<string>(knowledge.map((k) => String(k.id)))
    const unitById = new Map<string, Set<string>>()
    for (const item of knowledge) {
      const id = String(item.id)
      const matchingUnits = unitById.get(id) || new Set<string>()
      matchingUnits.add(String(item.unitId))
      unitById.set(id, matchingUnits)
    }
    // Sample across all sourced units instead of letting the first 60 knowledge rows
    // (typically from the first units) monopolize the model context.
    const knowledgeByUnit = new Map<string, typeof knowledge>()
    for (const item of knowledge) {
      const key = String(item.unitId)
      const group = knowledgeByUnit.get(key) || []
      group.push(item)
      knowledgeByUnit.set(key, group)
    }
    // Generate independently for every sourced unit, rather than capping the
    // entire semester at six suggestions or losing successes on partial failure.
    const unitEntries = [...knowledgeByUnit.entries()]
    const suggestions: AssignmentSuggestion[] = []
    const failedUnits: { unitId: string; title: string; reason: string }[] = []
    const existingNormalized = new Set(existing.map((a) => clean(a.title, 180).toLowerCase()))

    async function suggestForUnit(id: string, items: typeof knowledge) {
      const unitTitle = String(items[0]?.unitTitle || id)
      const unitSources = items.slice(0, 12)
      const context = unitSources.map((k, i) => `${i + 1}. id=${k.id}\nالوحدة: ${unitTitle}\nالعنوان: ${titleFromKnowledge(k)}\nالصفحات: ${k.pageStart ?? '؟'}–${k.pageEnd ?? k.pageStart ?? '؟'}\nالملخص: ${cleanAssignmentText(k.summary, '', 380)}\nالمقتطف: ${cleanAssignmentText(k.excerpt, '', 380)}`).join('\n\n')
      const prompt = `اقترح واجباً أكاديمياً واحداً موثقاً لوحدة "${unitTitle}" من الفصل ${semester} في برنامج "${program.titleAr}".\nمعرف الوحدة الثابت: ${id}\nواجبات موجودة لتجنب التكرار: ${existingTitles || 'لا يوجد'}\nمصادر الوحدة المسموحة فقط:\n${context}\nأرجع JSON array فيه واجب واحد بالحقول title, description, type, semester, points, weight, rubric, unitId, sourceKnowledgeIds, sourceKnowledgeTitles. استخدم unitId=${id} ومعرفات المصادر الحرفية أعلاه فقط، واذكر صفحات المصادر في الوصف. لا تقترح موعد تسليم، ولا تستخدم قوالب عامة.`
      const localAllowedIds = new Set(unitSources.map((item) => String(item.id)))
      let lastReason = 'لم ينتج واجب موثق'
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const raw = await textAiCompleteJson({
            system: 'أنت مصمم تكليفات جامعية موثقة بالمصادر. أعد JSON array فقط.',
            history: [{ role: 'user', text: attempt ? prompt + '\nالمحاولة السابقة لم تجتز التوثيق. استخدم معرفات المصادر أعلاه حرفياً ولا تخلط بين الوحدات.' : prompt }],
            taskLevel: 'ACADEMIC_CRITICAL', routerPolicy: 'balanced',
            temperature: 0.1, maxOutputTokens: 1800,
            stickyScope: `ASSIGNMENTS:${programId}:${id}`,
          })
          const parsed = parseJsonArray(raw)
          const valid = normalizeSuggestions(parsed, semester, localAllowedIds, titleById, unitById, id)
            .find((item) => item.unitId === id && !existingNormalized.has(item.title.toLowerCase()))
          if (valid) return { suggestion: valid, unitId: id, title: unitTitle }
          lastReason = `النتائج غير موثقة أو مكررة (عدد المقترحات: ${parsed.length})`
        } catch (error: any) {
          lastReason = String(error?.message || error).slice(0, 180)
        }
      }
      return { unitId: id, title: unitTitle, reason: lastReason }
    }

    // Bound concurrency to avoid overwhelming the AI provider.
    for (let offset = 0; offset < unitEntries.length; offset += 3) {
      const batch = unitEntries.slice(offset, offset + 3)
      const results = await Promise.all(batch.map(([id, items]) => suggestForUnit(id, items)))
      for (const result of results) {
        if ('suggestion' in result && result.suggestion) suggestions.push(result.suggestion)
        else failedUnits.push({ unitId: result.unitId, title: result.title, reason: 'reason' in result ? result.reason : 'فشل غير معروف' })
      }
    }
    if (!suggestions.length) {
      console.warn('assignment suggestions: all sourced units failed', { programId, semester, failedUnits })
      return NextResponse.json({ error: 'لم يتم توليد واجبات موثقة لأي وحدة. راجع مصادر الوحدات وسجلات التوليد.', status: 'PAUSED', failedUnits }, { status: 503 })
    }
    return NextResponse.json({
      suggestions,
      coverage: { eligibleUnits: unitEntries.length, coveredUnits: suggestions.length, failedUnits },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('assignment suggestions error:', e)
    return NextResponse.json({ error: e?.message || 'تعذر اقتراح الواجبات' }, { status: 500 })
  }
}
