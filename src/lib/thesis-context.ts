import { db } from '@/lib/db'

export type ThesisChunkForPrompt = {
  id?: string
  index: number
  pageStart?: number | null
  pageEnd?: number | null
  text: string
  summary?: string | null
}

function normalizeArabic(value: string) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
}

function words(value: string) {
  return normalizeArabic(value).split(/[^\u0621-\u064A\w]+/u).filter((word) => word.length >= 2)
}

function compact(value: unknown, max = 900) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function digestRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function sectionMapOf(digest: unknown): Array<{ title: string; chunkFrom?: number; chunkTo?: number }> {
  const map = digestRecord(digest).sectionMap
  if (!Array.isArray(map)) return []
  return map.map((item) => ({
    title: String(item?.title || '').trim(),
    chunkFrom: Number.isFinite(Number(item?.chunkFrom)) ? Number(item.chunkFrom) : undefined,
    chunkTo: Number.isFinite(Number(item?.chunkTo)) ? Number(item.chunkTo) : undefined,
  })).filter((item) => item.title || item.chunkFrom || item.chunkTo)
}

function pageLabel(chunk: ThesisChunkForPrompt) {
  if (chunk.pageStart && chunk.pageEnd && chunk.pageEnd !== chunk.pageStart) return `صفحات ${chunk.pageStart}-${chunk.pageEnd}`
  if (chunk.pageStart) return `صفحة ${chunk.pageStart}`
  return 'صفحات غير محددة'
}

function formatChunkForPrompt(chunk: ThesisChunkForPrompt, max = 950) {
  const body = compact(chunk.summary || chunk.text, max)
  return `مقطع ${chunk.index} (${pageLabel(chunk)}): ${body}`
}

function scoreChunk(chunk: ThesisChunkForPrompt, queryWords: string[]) {
  if (!queryWords.length) return 0
  const haystack = normalizeArabic(`${chunk.summary || ''} ${chunk.text || ''}`)
  return queryWords.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0)
}

function nearestChunk(chunks: ThesisChunkForPrompt[], index?: number) {
  if (!chunks.length || !Number.isFinite(Number(index))) return null
  const target = Number(index)
  return chunks.reduce((best, chunk) => Math.abs(chunk.index - target) < Math.abs(best.index - target) ? chunk : best, chunks[0])
}

function pickDefenseChunks(chunks: ThesisChunkForPrompt[], digest: unknown, focusQuery = '', maxChunks = 14) {
  const selected = new Map<number, ThesisChunkForPrompt>()
  const sorted = [...chunks].sort((a, b) => a.index - b.index)
  const add = (chunk?: ThesisChunkForPrompt | null) => { if (chunk) selected.set(chunk.index, chunk) }
  add(sorted[0])
  add(sorted[sorted.length - 1])

  // خذ ممثلاً من كل قسم في خريطة البحث حتى لا يبقى السياق محصوراً بأول الصفحات.
  for (const section of sectionMapOf(digest)) {
    add(nearestChunk(sorted, section.chunkFrom))
    add(nearestChunk(sorted, section.chunkTo))
  }

  // خذ عينة موزعة على كامل البحث مثل المناقش البشري الذي يراجع البداية والوسط والنهاية.
  if (sorted.length > 2) {
    const samples = Math.min(6, sorted.length)
    for (let i = 0; i < samples; i += 1) {
      const pos = Math.round((i * (sorted.length - 1)) / Math.max(1, samples - 1))
      add(sorted[pos])
    }
  }

  // ثم أضف المقاطع الأشد صلة بالسؤال أو معيار التقييم الحالي.
  const queryWords = words(focusQuery)
  if (queryWords.length) {
    sorted
      .map((chunk) => ({ chunk, score: scoreChunk(chunk, queryWords) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index)
      .slice(0, 6)
      .forEach((item) => add(item.chunk))
  }

  return Array.from(selected.values()).sort((a, b) => a.index - b.index).slice(0, maxChunks)
}

function wholeThesisSummaryMap(chunks: ThesisChunkForPrompt[], maxChars = 6500) {
  let out = ''
  for (const chunk of chunks.sort((a, b) => a.index - b.index)) {
    const line = `- مقطع ${chunk.index} (${pageLabel(chunk)}): ${compact(chunk.summary || chunk.text, 220)}\n`
    if (out.length + line.length > maxChars) {
      out += `- ... تم اختصار بقية خريطة المقاطع بسبب حد السياق، وعدد المقاطع الكلي ${chunks.length}.\n`
      break
    }
    out += line
  }
  return out.trim()
}

function focusPointsFromDigest(digest: unknown) {
  const d = digestRecord(digest)
  const lines = [
    d.problem ? `مشكلة البحث: ${compact(d.problem, 500)}` : '',
    Array.isArray(d.objectives) && d.objectives.length ? `الأهداف: ${d.objectives.map((x: unknown) => compact(x, 180)).join('؛ ')}` : '',
    d.methodology ? `المنهجية: ${compact(d.methodology, 650)}` : '',
    d.sample ? `العينة/الحالة: ${compact(d.sample, 400)}` : '',
    Array.isArray(d.tools) && d.tools.length ? `الأدوات: ${d.tools.map((x: unknown) => compact(x, 120)).join('، ')}` : '',
    Array.isArray(d.keyFindings) && d.keyFindings.length ? `أهم النتائج: ${d.keyFindings.map((x: unknown) => compact(x, 220)).join('؛ ')}` : '',
    Array.isArray(d.contributions) && d.contributions.length ? `الإسهامات: ${d.contributions.map((x: unknown) => compact(x, 180)).join('؛ ')}` : '',
    d.literatureCoverage ? `تغطية الأدبيات: ${compact(d.literatureCoverage, 500)}` : '',
    Array.isArray(d.weaknesses) && d.weaknesses.length ? `نقاط ضعف محتملة يركز عليها المناقش: ${d.weaknesses.map((x: unknown) => compact(x, 180)).join('؛ ')}` : '',
  ].filter(Boolean)
  return lines.join('\n')
}

export function buildThesisDefenseContextFromParts(input: {
  thesisTitle: string
  digest?: unknown
  chunks: ThesisChunkForPrompt[]
  programTitle?: string | null
  focusQuery?: string
  maxChars?: number
}) {
  const sortedChunks = [...(input.chunks || [])].sort((a, b) => a.index - b.index)
  const selectedChunks = pickDefenseChunks(sortedChunks, input.digest, input.focusQuery || input.thesisTitle)
  const sections = sectionMapOf(input.digest)
  const sectionText = sections.length
    ? sections.map((section) => `- ${section.title || 'قسم غير مسمى'}: المقاطع ${section.chunkFrom ?? '?'}-${section.chunkTo ?? section.chunkFrom ?? '?'}`).join('\n')
    : 'خريطة الأقسام غير متوفرة في digest؛ استخدم خريطة المقاطع والملخصات.'
  const body = [
    '<<<THESIS_WHOLE_READING_CONTEXT>>>',
    'هذا سياق مبني من قراءة البحث كاملًا على مراحل: digest عام + خريطة الأقسام + ملخصات كل المقاطع + مقاطع أدلة مختارة من كامل البحث. لا تعتبره كتالوج برامج ولا ذاكرة عامة.',
    `عنوان البحث: ${compact(input.thesisTitle, 400)}`,
    input.programTitle ? `البرنامج: ${compact(input.programTitle, 240)}` : '',
    `عدد مقاطع البحث المقروءة: ${sortedChunks.length}`,
    `مدى الصفحات: ${sortedChunks.find((c) => c.pageStart)?.pageStart ?? 'غير محدد'}-${[...sortedChunks].reverse().find((c) => c.pageEnd || c.pageStart)?.pageEnd ?? [...sortedChunks].reverse().find((c) => c.pageStart)?.pageStart ?? 'غير محدد'}`,
    focusPointsFromDigest(input.digest) ? `بطاقة المناقش — ما يجب التركيز عليه:\n${focusPointsFromDigest(input.digest)}` : '',
    input.digest ? `Digest البحث الكامل JSON:\n${summarizeDigestForPrompt(input.digest, 6500)}` : '',
    `خريطة الأقسام:\n${sectionText}`,
    `خريطة ملخصات كل المقاطع المقروءة:\n${wholeThesisSummaryMap(sortedChunks)}`,
    `مقاطع أدلة مختارة من كامل البحث حسب خريطة الأقسام والسؤال الحالي:\n${selectedChunks.map((chunk) => formatChunkForPrompt(chunk)).join('\n')}`,
    'تعليمات استخدام السياق: اسأل مثل مناقش بشري قرأ البحث كله. ركّز على المنهجية والنتائج والإسهام والأدبيات والعرض ونقاط الضعف. إذا لم تجد معلومة في هذا السياق فقل إنها غير ظاهرة في ملف البحث ولا تخمّن.',
    '<<<END_THESIS_WHOLE_READING_CONTEXT>>>',
  ].filter(Boolean).join('\n\n')
  return body.slice(0, input.maxChars || 18000)
}

export async function buildThesisDefenseContextFromDb(thesisId: string, input: { thesisTitle: string; programTitle?: string | null; focusQuery?: string; maxChars?: number }) {
  const [thesis, chunks] = await Promise.all([
    db.thesisSubmission.findUnique({ where: { id: thesisId }, select: { digest: true } }),
    db.thesisChunk.findMany({
      where: { thesisId, status: { not: 'FAILED' } },
      orderBy: { index: 'asc' },
      select: { id: true, index: true, pageStart: true, pageEnd: true, text: true, summary: true },
    }),
  ])
  return buildThesisDefenseContextFromParts({
    thesisTitle: input.thesisTitle,
    digest: thesis?.digest,
    chunks,
    programTitle: input.programTitle,
    focusQuery: input.focusQuery,
    maxChars: input.maxChars,
  })
}

export async function getThesisDigest(thesisId: string) {
  const thesis = await db.thesisSubmission.findUnique({ where: { id: thesisId }, select: { digest: true } })
  return thesis?.digest || null
}

export async function findRelevantThesisChunks(thesisId: string, query: string, limit = 3) {
  const queryWords = words(query)
  const chunks = await db.thesisChunk.findMany({
    where: { thesisId, status: { in: ['EXTRACTED', 'ANALYZED'] } },
    orderBy: { index: 'asc' },
    select: { id: true, index: true, pageStart: true, pageEnd: true, text: true, summary: true },
  })
  if (!queryWords.length) return chunks.slice(0, limit)
  return chunks
    .map((chunk) => {
      const haystack = normalizeArabic(`${chunk.summary || ''} ${chunk.text}`)
      const score = queryWords.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0)
      return { chunk, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index)
    .slice(0, Math.max(1, limit))
    .map((item) => item.chunk)
}

export function summarizeDigestForPrompt(digest: unknown, max = 6000) {
  return JSON.stringify(digest || {}, null, 2).slice(0, max)
}
