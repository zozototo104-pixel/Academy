import type { Prisma } from '@prisma/client'
import { geminiCompleteJson } from '@/lib/gemini'

export type OutlineUnitSectionInput = {
  id: string
  title: string
  level?: number | null
  semester?: number | null
  chunkStartIndex: number
  chunkEndIndex: number
  pageStart?: number | null
  pageEnd?: number | null
}

export type ExistingOutlineUnitInput = {
  id: string
  outlineSectionId: string | null
  status: string
  order: number
  semester: number
  generationVersion?: number | null
}

export type OutlineUnitPlanAction =
  | { action: 'create'; section: OutlineUnitSectionInput; semester: number; order: number }
  | { action: 'update-draft'; unitId: string; section: OutlineUnitSectionInput; semester: number; generationVersion: number }
  | { action: 'skip-approved'; unitId: string; section: OutlineUnitSectionInput }
  | { action: 'skip-draft'; unitId: string; section: OutlineUnitSectionInput }
  | { action: 'skip-intro'; section: OutlineUnitSectionInput }

export type UnitSourceChunk = {
  id: string
  index: number
  pageStart: number
  pageEnd: number
  headingPath?: string | null
  text: string
}

export type UnitSourceKnowledge = {
  id: string
  category: string
  title: string
  summary: string
  excerpt?: string | null
  pageStart?: number | null
  pageEnd?: number | null
  chunkId?: string | null
}

export type UnitContentSection = {
  heading: string
  body: string
  pageRefs?: string[]
  sourceKnowledgeIds?: string[]
  sourceChunkIndexes?: number[]
}

export type GeneratedUnitContent = {
  summary: string
  objectives: string[]
  content: UnitContentSection[]
}

export type UnitStudyGuideDraft = {
  title: string
  overview: string
  objectives: string[]
  keyTerms: string[]
  sections: Array<{ title: string; summary: string; outcomes: string[]; sourceTitles: string[]; sourceKnowledgeIds: string[]; pageRefs: string[] }>
  activities: string[]
  discussionQuestions: string[]
  sourceKnowledgeIds: string[]
}

export type ReplaceUnitProtectionInput = {
  status?: string | null
  outlineSectionId?: string | null
  exam?: { attemptsCount?: number | null; _count?: { attempts?: number | null } } | null
}

export function hasUnitExamAttempts(unit: ReplaceUnitProtectionInput) {
  return Number(unit.exam?.attemptsCount ?? unit.exam?._count?.attempts ?? 0) > 0
}

export function canReplaceDeleteUnit(unit: ReplaceUnitProtectionInput) {
  return String(unit.status || '').toUpperCase() === 'DRAFT' && !unit.outlineSectionId && !hasUnitExamAttempts(unit)
}

export function summarizeReplaceUnitProtection(units: ReplaceUnitProtectionInput[]) {
  return units.reduce((acc, unit) => {
    if (canReplaceDeleteUnit(unit)) acc.deleted++
    if (String(unit.status || '').toUpperCase() === 'APPROVED') acc.keptApproved++
    if (unit.outlineSectionId) acc.keptOutline++
    if (hasUnitExamAttempts(unit)) acc.keptWithAttempts++
    return acc
  }, { deleted: 0, keptApproved: 0, keptOutline: 0, keptWithAttempts: 0 })
}

export function safeReplaceDraftUnitWhere(programId: string): Prisma.UnitWhereInput {
  return {
    programId,
    status: 'DRAFT',
    outlineSectionId: null,
    OR: [
      { exam: { is: null } },
      { exam: { is: { attempts: { none: {} } } } },
    ],
  }
}

export function cleanOutlineUnitText(value: unknown, max = 1200) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

function normalizeArabic(value: unknown) {
  return cleanOutlineUnitText(value, 400)
    .normalize('NFKC')
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function parseOutlineUnitJson(raw: string): any {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try { return JSON.parse(text) } catch (error) { console.warn('Failed to parse outline unit JSON directly; trying fenced extraction.', error) }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
  throw new Error('INVALID_JSON')
}

function wordCount(value: string) {
  return cleanOutlineUnitText(value, 4000).split(/\s+/).filter(Boolean).length
}

function pageRef(pageStart?: number | null, pageEnd?: number | null) {
  if (!pageStart && !pageEnd) return ''
  if (pageStart && pageEnd && pageStart !== pageEnd) return `صفحات ${pageStart}–${pageEnd}`
  return `صفحة ${pageStart || pageEnd}`
}

function chunkCount(section: Pick<OutlineUnitSectionInput, 'chunkStartIndex' | 'chunkEndIndex'>) {
  return Math.max(0, Number(section.chunkEndIndex || 0) - Number(section.chunkStartIndex || 0) + 1)
}

export function isSmallIntroOutlineSection(section: OutlineUnitSectionInput) {
  const title = normalizeArabic(section.title)
  return /(مقدمه|تمهيد|تقديم)(?:\s+الكتاب)?/.test(title) && chunkCount(section) < 3
}

export function planOutlineUnitsFromSections(params: {
  sections: OutlineUnitSectionInput[]
  existingUnits: ExistingOutlineUnitInput[]
  currentMaxOrderBySemester: Record<number, number>
  bookSemester?: number | null
  regenerateDrafts?: boolean
}) {
  const existingBySection = new Map(params.existingUnits.filter((unit) => unit.outlineSectionId).map((unit) => [unit.outlineSectionId!, unit]))
  const maxOrder = new Map<number, number>(Object.entries(params.currentMaxOrderBySemester || {}).map(([semester, order]) => [Number(semester), Number(order || 0)]))
  const actions: OutlineUnitPlanAction[] = []
  for (const section of params.sections.filter((entry) => Number(entry.level || 1) === 1).sort((a, b) => a.chunkStartIndex - b.chunkStartIndex || a.chunkEndIndex - b.chunkEndIndex)) {
    if (isSmallIntroOutlineSection(section)) {
      actions.push({ action: 'skip-intro', section })
      continue
    }
    const semester = Math.max(1, Math.min(12, Number(section.semester || params.bookSemester || 1)))
    const existing = existingBySection.get(section.id)
    if (existing) {
      if (String(existing.status).toUpperCase() === 'APPROVED') {
        actions.push({ action: 'skip-approved', unitId: existing.id, section })
      } else if (params.regenerateDrafts) {
        actions.push({ action: 'update-draft', unitId: existing.id, section, semester, generationVersion: Number(existing.generationVersion || 0) + 1 })
      } else {
        actions.push({ action: 'skip-draft', unitId: existing.id, section })
      }
      continue
    }
    const order = Number(maxOrder.get(semester) || 0) + 1
    maxOrder.set(semester, order)
    actions.push({ action: 'create', section, semester, order })
  }
  return actions
}

export function validateUnitContentReferences(content: unknown, allowedKnowledgeIds: Iterable<string>, allowedChunkIndexes: Iterable<number>): UnitContentSection[] {
  const allowedKnowledge = new Set([...allowedKnowledgeIds])
  const allowedChunks = new Set([...allowedChunkIndexes].map(Number))
  const raw = Array.isArray(content) ? content : []
  const sections = raw.map((entry: any) => {
    const heading = cleanOutlineUnitText(entry?.heading, 180)
    const body = cleanOutlineUnitText(entry?.body, 1800)
    const requestedKnowledgeIds = Array.isArray(entry?.sourceKnowledgeIds)
      ? entry.sourceKnowledgeIds.map((id: any) => cleanOutlineUnitText(id, 100)).filter(Boolean)
      : []
    const requestedChunkIndexes = Array.isArray(entry?.sourceChunkIndexes)
      ? entry.sourceChunkIndexes.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n))
      : []
    if (requestedKnowledgeIds.some((id: string) => !allowedKnowledge.has(id))) throw new Error('UNIT_CONTENT_SECTION_OUT_OF_RANGE_SOURCE')
    if (requestedChunkIndexes.some((n: number) => !allowedChunks.has(n))) throw new Error('UNIT_CONTENT_SECTION_OUT_OF_RANGE_CHUNK')
    const sourceKnowledgeIds = requestedKnowledgeIds.slice(0, 12)
    const sourceChunkIndexes = requestedChunkIndexes.slice(0, 12)
    const pageRefs = Array.isArray(entry?.pageRefs)
      ? entry.pageRefs.map((x: any) => cleanOutlineUnitText(x, 80)).filter(Boolean).slice(0, 8)
      : []
    return { heading, body, pageRefs, sourceKnowledgeIds, sourceChunkIndexes }
  }).filter((entry) => entry.heading.length >= 3 && entry.body.length >= 40)

  if (!sections.length) throw new Error('UNIT_CONTENT_REQUIRES_REFERENCED_SECTIONS')
  for (const section of sections) {
    if (!section.sourceKnowledgeIds?.length && !section.sourceChunkIndexes?.length) {
      throw new Error('UNIT_CONTENT_SECTION_MISSING_SOURCE_REFERENCE')
    }
    if (!section.pageRefs?.length && !/(?:صفحات?|page)\s*[\d٠-٩]/iu.test(section.body)) {
      throw new Error('UNIT_CONTENT_SECTION_MISSING_PAGE_REFERENCE')
    }
  }
  return sections.slice(0, 10)
}

export function validateStudyGuideSources(sourceKnowledgeIds: unknown, allowedKnowledgeIds: Iterable<string>): string[] {
  const allowed = new Set([...allowedKnowledgeIds])
  const requested = Array.isArray(sourceKnowledgeIds)
    ? sourceKnowledgeIds.map((id) => cleanOutlineUnitText(id, 100)).filter(Boolean)
    : []
  if (!requested.length) throw new Error('STUDY_GUIDE_REQUIRES_SOURCE_KNOWLEDGE_IDS')
  if (requested.some((id) => !allowed.has(id))) throw new Error('STUDY_GUIDE_SOURCE_KNOWLEDGE_OUT_OF_RANGE')
  return [...new Set(requested)].slice(0, 80)
}

function sourceKnowledgeLines(items: UnitSourceKnowledge[]) {
  return items.map((item, index) => [
    `${index + 1}. id=${item.id}`,
    `الفئة: ${item.category}`,
    `العنوان: ${cleanOutlineUnitText(item.title, 180)}`,
    `الملخص: ${cleanOutlineUnitText(item.summary, 520)}`,
    item.excerpt ? `الدليل/المقتطف: ${cleanOutlineUnitText(item.excerpt, 380)}` : '',
    pageRef(item.pageStart, item.pageEnd) ? `الصفحات: ${pageRef(item.pageStart, item.pageEnd)}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
}

function sourceChunkLines(chunks: UnitSourceChunk[]) {
  return chunks.map((chunk) => [
    `chunkIndex=${chunk.index}`,
    `الصفحات: ${pageRef(chunk.pageStart, chunk.pageEnd) || 'غير محددة'}`,
    chunk.headingPath ? `مسار العنوان: ${cleanOutlineUnitText(chunk.headingPath, 240)}` : '',
    `النص: ${cleanOutlineUnitText(chunk.text, 2600)}`,
  ].filter(Boolean).join('\n')).join('\n\n---\n\n')
}

export async function generateUnitContentWithAi(params: {
  programTitle: string
  unitTitle: string
  unitPages: string
  chunks: UnitSourceChunk[]
  knowledge: UnitSourceKnowledge[]
  deadlineMs?: number
}): Promise<GeneratedUnitContent> {
  const allowedKnowledgeIds = params.knowledge.map((item) => item.id)
  const allowedChunkIndexes = params.chunks.map((chunk) => chunk.index)
  const prompt = `
أنت مصمم وحدة دراسية داخل منصة أكاديمية. ابنِ محتوى وحدة واحد فقط من المصادر المحددة أدناه.

البرنامج: ${params.programTitle}
عنوان الوحدة: ${params.unitTitle}
نطاق صفحات الوحدة: ${params.unitPages || 'غير محدد'}

عناصر المعرفة v2 داخل نطاق الوحدة فقط:
${sourceKnowledgeLines(params.knowledge) || 'لا توجد عناصر معرفة v2 كافية داخل النطاق.'}

نصوص BookChunk داخل نطاق الوحدة فقط:
${sourceChunkLines(params.chunks)}

أرجع JSON object فقط بالشكل:
{
  "summary": "ملخص بين 80 و150 كلمة للوحدة من النطاق فقط",
  "objectives": ["4 إلى 7 أهداف قابلة للقياس"],
  "content": [
    {
      "heading": "عنوان محور مستند إلى ترتيب المقاطع",
      "body": "شرح تعليمي واضح يذكر الصفحات المرجعية داخل النص",
      "pageRefs": ["صفحات 1–3"],
      "sourceKnowledgeIds": ["id من القائمة أعلاه عند استخدام عنصر معرفة"],
      "sourceChunkIndexes": [0]
    }
  ]
}

قواعد إلزامية:
- ممنوع استخدام أي نص خارج عناصر المعرفة والمقاطع المعروضة أعلاه.
- كل content item يجب أن يملك sourceKnowledgeIds أو sourceChunkIndexes صحيحة من القوائم أعلاه؛ لا تكتب فقرة بلا مرجع.
- رتّب content حسب ترتيب chunkIndex.
- كل body يجب أن يذكر الصفحات المرجعية بوضوح.
- الأهداف يجب أن تكون قابلة للقياس مثل: يشرح، يميز، يطبق، يحلل، يقارن، يصمم.
- لا تكتب أسئلة امتحانية ولا واجبات هنا.
- لا تستخدم Markdown ولا نصاً خارج JSON.`

  const raw = await geminiCompleteJson({
    system: 'أنت مصمم وحدات أكاديمية مصدرية. أعد JSON صالحاً فقط ولا تستخدم أي مصدر خارج النطاق.',
    history: [{ role: 'user', text: prompt }],
    taskLevel: 'ACADEMIC_DRAFT',
    temperature: 0.12,
    maxOutputTokens: 6000,
    deadlineMs: params.deadlineMs,
  })
  const parsed = parseOutlineUnitJson(raw)
  const summary = cleanOutlineUnitText(parsed?.summary, 1600)
  const wc = wordCount(summary)
  if (wc < 80 || wc > 150) throw new Error('UNIT_SUMMARY_OUT_OF_RANGE')
  const objectives = Array.isArray(parsed?.objectives)
    ? parsed.objectives.map((x: any) => cleanOutlineUnitText(x, 240)).filter((x: string) => x.length >= 12).slice(0, 7)
    : []
  if (objectives.length < 4 || objectives.length > 7) throw new Error('UNIT_OBJECTIVES_OUT_OF_RANGE')
  const content = validateUnitContentReferences(parsed?.content, allowedKnowledgeIds, allowedChunkIndexes)
  return { summary, objectives, content }
}

function firstSentence(value: unknown, max = 240) {
  return cleanOutlineUnitText(value, max).split(/[.!؟]/)[0]?.trim() || cleanOutlineUnitText(value, max)
}

export function buildUnitStudyGuideDraft(params: {
  programTitle: string
  unitTitle: string
  unitSummary?: string | null
  semester: number
  knowledge: UnitSourceKnowledge[]
  unitContent?: UnitContentSection[]
}): UnitStudyGuideDraft {
  const knowledge = params.knowledge.filter((item) => item.id)
  const sourceKnowledgeIds = validateStudyGuideSources(knowledge.map((item) => item.id), knowledge.map((item) => item.id))
  const definitions = knowledge.filter((item) => String(item.category || '').toUpperCase() === 'DEFINITION')
  const concepts = knowledge.filter((item) => String(item.category || '').toUpperCase() !== 'QUESTION_SEED')
  const pageRefs = (item: UnitSourceKnowledge) => [pageRef(item.pageStart, item.pageEnd)].filter(Boolean)
  const keyTerms = (definitions.length ? definitions : knowledge).slice(0, 12).map((item) => {
    const definition = firstSentence(item.excerpt || item.summary, 220)
    const pages = pageRef(item.pageStart, item.pageEnd)
    return `${cleanOutlineUnitText(item.title, 90)}: ${definition}${pages ? ` (${pages})` : ''}`
  })
  const sections = concepts.slice(0, 8).map((item) => ({
    title: cleanOutlineUnitText(item.title, 120),
    summary: `${cleanOutlineUnitText(item.summary || item.excerpt, 900)}${pageRef(item.pageStart, item.pageEnd) ? ` — مرجع الصفحات: ${pageRef(item.pageStart, item.pageEnd)}.` : ''}`,
    outcomes: [
      `شرح ${cleanOutlineUnitText(item.title, 80)} بلغة دقيقة`,
      `ربط ${cleanOutlineUnitText(item.title, 80)} بمحتوى الوحدة ومراجع صفحاتها`,
    ],
    sourceTitles: [`${params.unitTitle}${pageRef(item.pageStart, item.pageEnd) ? ` — ${pageRef(item.pageStart, item.pageEnd)}` : ''}`],
    sourceKnowledgeIds: [item.id],
    pageRefs: pageRefs(item),
  })).filter((section) => section.title && section.summary.length >= 30)
  const questions = concepts.slice(0, 8).map((item) => `راجع ذاتياً: كيف تشرح «${cleanOutlineUnitText(item.title, 90)}» اعتماداً على ${pageRef(item.pageStart, item.pageEnd) || 'مصدر الوحدة'} دون تحويله إلى سؤال امتحاني؟`)
  const contentRefs = (params.unitContent || []).flatMap((section) => section.pageRefs || []).filter(Boolean)
  return {
    title: `دليل دراسة الوحدة — ${params.unitTitle}`,
    overview: cleanOutlineUnitText(`يركز هذا الدليل على وحدة «${params.unitTitle}» ضمن ${params.programTitle}. يعتمد الدليل على عناصر المعرفة المحددة للوحدة ومقاطعها فقط، ويجمع النقاط الرئيسة والمصطلحات وأسئلة المراجعة الذاتية ومراجع الصفحات للمذاكرة قبل الاعتماد. ${params.unitSummary || ''}`, 2200),
    objectives: [
      `تلخيص النقاط الرئيسة في وحدة «${params.unitTitle}» من مصادرها`,
      'تمييز المصطلحات والتعريفات المرتبطة بالوحدة',
      'استخدام مراجع الصفحات لمراجعة المفاهيم قبل النقاش أو الاختبار',
      'صياغة إجابات ذاتية غير امتحانية للتحقق من الفهم',
    ],
    keyTerms,
    sections,
    activities: [
      `اقرأ الوحدة حسب مراجع الصفحات التالية: ${[...new Set([...contentRefs, ...knowledge.flatMap(pageRefs)])].slice(0, 12).join('، ') || 'راجع صفحات الوحدة المحددة في الفهرس'}.`,
      'اكتب بطاقة مراجعة لكل مصطلح: التعريف، الصفحة، ومثال تطبيقي قصير من سياق الوحدة.',
      'راجع الأسئلة الذاتية بوصفها تدريباً على الفهم لا نموذجاً لأسئلة الامتحان.',
    ],
    discussionQuestions: questions.length ? questions : ['راجع ذاتياً: ما الفكرة المركزية في هذه الوحدة؟ وما الصفحة التي تستند إليها؟'],
    sourceKnowledgeIds,
  }
}

export function providerUnavailableStatus(error: unknown) {
  const message = String((error as any)?.message || error || '')
  return /MISSING|NO_|UNAVAILABLE|TIMEOUT|QUOTA|RATE|KEY|provider|AI|Gemini|ZAI|OpenAI/i.test(message)
}
