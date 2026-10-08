import { db } from '@/lib/db'
import { geminiCompleteJson } from '@/lib/gemini'

type Chunk = { index: number; headingPath: string | null; text: string; pageStart: number; pageEnd: number }
type Item = { chunkId: string | null; title: string; summary: string }
export type OutlineSectionDraft = { order: number; title: string; level: number; semester: number | null; chunkStartIndex: number; chunkEndIndex: number; pageStart: number; pageEnd: number; itemsCount: number }
type Boundary = { at: number; title: string }

const headingPattern = /^(?:الفصل|الباب|المبحث|الوحدة|chapter|part|unit)\s+(?:[\d\u0660-\u0669]+|[\p{L}]+)/iu
const tocPattern = /(?:المحتويات|الفهرس|contents|table of contents)/iu
const clean = (s: unknown) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 180)

const normalizeHeading = (value: unknown) => clean(value).normalize('NFKC').replace(/[\u064b-\u065f\u0670\u0640]/g, '').replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim()
const chapterPattern = /(?:^|\s)((?:الفصل|الباب|الوحدة|chapter|part|unit)\s+(?:[\d\u0660-\u0669]+|[\p{L}]+))/iu
function mainHeading(path: string | null, bookTitle: string): string | null {
  const bookKey = normalizeHeading(bookTitle)
  const parts = String(path || '').split(/\s*(?:>|\/|»|›|\||→|—|\s+-\s+)\s*/u).map(clean).filter(Boolean)
  for (const part of parts) {
    if (bookKey && normalizeHeading(part) === bookKey) continue
    const chapter = part.match(chapterPattern)
    if (chapter) return clean(chapter[1])
    if (/^[\d\u0660-\u0669]+[.)]\s+\S/u.test(part) && !/المبحث|المطلب|الفرع/u.test(part)) return part
  }
  return null
}

export function headingsFromChunks(chunks: readonly Chunk[], bookTitle = ''): Boundary[] {
  const sorted = [...chunks].sort((a, b) => a.index - b.index)
  const titles = sorted.map((chunk) => mainHeading(chunk.headingPath, bookTitle))
  const seen = new Set<string>()
  const boundaries: Boundary[] = []
  let current = ''
  for (let i = 0; i < sorted.length; i++) {
    const title = titles[i]
    if (!title) continue
    const key = normalizeHeading(title)
    if (!key || key === normalizeHeading(bookTitle) || key === current || seen.has(key)) continue
    current = key
    seen.add(key)
    boundaries.push({ at: sorted[i].index, title })
  }
  return boundaries
}

export function tocFromChunks(chunks: readonly Chunk[]): Boundary[] {
  const first = chunks.slice(0, Math.min(6, chunks.length))
  const toc = first.filter((chunk) => tocPattern.test(chunk.text.slice(0, 2000)))
  const found: Boundary[] = []
  for (const chunk of toc) {
    const lines = chunk.text.split(/\r?\n/).slice(0, 130)
    for (const line of lines) {
      const match = line.trim().match(/^(.{5,110}?)\s*(?:\.{2,}|…+|\s{2,})\s*([\d\u0660-\u0669]{1,4})\s*$/u)
      if (!match || !headingPattern.test(match[1].trim())) continue
      const page = Number(match[2].replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660)))
      const target = chunks.find((entry) => entry.pageStart <= page && entry.pageEnd >= page)
      if (target) found.push({ at: target.index, title: clean(match[1]) })
    }
  }
  return found
}

const ordinals: Record<string, number> = { 'الاول': 1, 'الثاني': 2, 'الثالث': 3, 'الرابع': 4, 'الخامس': 5, 'السادس': 6, 'السابع': 7, 'الثامن': 8, 'التاسع': 9, 'العاشر': 10, 'الحادي عشر': 11, 'الثاني عشر': 12 }
const chapterLine = /^\s*((?:الفصل|الباب|الوحدة)\s+(?:الحادي عشر|الثاني عشر|[\p{L}]+|[\d\u0660-\u0669]+))\s*[:：.\-–]?\s*$/iu
function chapterNumber(title: string): number | null {
  const match = normalizeHeading(title).match(/^(?:الفصل|الباب|الوحده)\s+(الحادي عشر|الثاني عشر|\S+)/u)
  if (!match) return null
  return ordinals[match[1]] || (/^\d+$/.test(match[1]) ? Number(match[1]) : null)
}
function chapterLabel(title: string): string {
  return clean(title.match(/(?:الفصل|الباب|الوحدة)\s+(?:الحادي عشر|الثاني عشر|[\p{L}]+|[\d\u0660-\u0669]+)/iu)?.[0] || title)
}
function chapterName(chunk: Chunk, label: string, bookTitle: string): string {
  const lines = chunk.text.split(/\r?\n/).map(clean)
  const start = lines.findIndex((line) => normalizeHeading(line) === normalizeHeading(label))
  if (start < 0) return label
  for (const line of lines.slice(start + 1, start + 7)) {
    if (line.length < 3 || line.length > 80 || /^\d+$/.test(line) || normalizeHeading(line) === normalizeHeading(bookTitle) || chapterLine.test(line) || /^(?:المبحث|المطلب|الفرع)\s/u.test(line)) continue
    return `${label}: ${line}`
  }
  return label
}
function textChapters(chunks: readonly Chunk[], bookTitle: string): Boundary[] {
  const found: Boundary[] = []
  for (const chunk of chunks) {
    const line = chunk.text.split(/\r?\n/).slice(0, 160).map(clean).find((value) => chapterLine.test(value))
    if (line && normalizeHeading(line) !== normalizeHeading(bookTitle)) found.push({ at: chunk.index, title: chapterName(chunk, chapterLabel(line), bookTitle) })
  }
  return found
}

function normalizeBoundaries(chunks: readonly Chunk[], boundaries: readonly Boundary[], items: readonly Item[], chunkIds: ReadonlyMap<number, string>, semester: number | null): OutlineSectionDraft[] {
  const sorted = [...chunks].sort((a, b) => a.index - b.index)
  if (!sorted.length) return []
  const at = new Map(sorted.map((chunk, index) => [chunk.index, index]))
  const unique = [...new Map(boundaries.filter((b) => at.has(b.at)).map((b) => [b.at, clean(b.title)])).entries()]
    .sort((a, b) => a[0] - b[0])
  if (!unique.length || unique[0][0] !== sorted[0].index) unique.unshift([sorted[0].index, clean(sorted[0].headingPath) || 'مقدمة الكتاب'])
  let ranges = unique.map(([start, title], i) => ({ start: at.get(start)!, end: i + 1 < unique.length ? at.get(unique[i + 1][0])! - 1 : sorted.length - 1, title }))
    .filter((range) => range.end >= range.start)
  // Real chapter boundaries are never merged, even if they have one chunk or one v2 item.
  // Only unlabeled fragments may be absorbed into a neighboring chapter.
  for (let i = ranges.length - 1; i >= 0; i--) {
    if (ranges.length <= 1 || chapterNumber(ranges[i].title) !== null) continue
    if (ranges[i].end !== ranges[i].start) continue
    if (i > 0) { ranges[i - 1].end = ranges[i].end; ranges.splice(i, 1) }
    else { ranges[1].start = ranges[0].start; ranges.shift() }
  }
  while (ranges.length > 16) {
    let smallest = 1
    for (let i = 2; i < ranges.length; i++) if (ranges[i].end - ranges[i].start < ranges[smallest].end - ranges[smallest].start) smallest = i
    ranges[smallest - 1].end = ranges[smallest].end
    ranges.splice(smallest, 1)
  }
  // Never undo tiny-section merging by splitting real heading/TOC sections again.
  // Only create synthetic sections when no reliable boundaries were supplied.
  while (boundaries.length === 0 && ranges.length < Math.min(4, sorted.length)) {
    let largest = 0
    for (let i = 1; i < ranges.length; i++) if (ranges[i].end - ranges[i].start > ranges[largest].end - ranges[largest].start) largest = i
    const range = ranges[largest]
    if (range.end <= range.start) break
    const mid = Math.floor((range.start + range.end) / 2)
    ranges.splice(largest + 1, 0, { start: mid + 1, end: range.end, title: `${range.title} — تابع` })
    range.end = mid
  }
  const itemCount = new Map<string, number>()
  for (const item of items) if (item.chunkId) itemCount.set(item.chunkId, (itemCount.get(item.chunkId) || 0) + 1)
  return ranges.map((range, order) => ({
    order: order + 1, title: range.title, level: 1, semester,
    chunkStartIndex: sorted[range.start].index, chunkEndIndex: sorted[range.end].index,
    pageStart: sorted[range.start].pageStart, pageEnd: sorted[range.end].pageEnd,
    itemsCount: sorted.slice(range.start, range.end + 1).reduce((sum, chunk) => sum + (itemCount.get(chunkIds.get(chunk.index) || '') || 0), 0),
  }))
}

export function planBookOutline(chunks: readonly Chunk[], items: readonly Item[], chunkIds: ReadonlyMap<number, string>, semester: number | null, aiBoundaries: readonly Boundary[] = [], bookTitle = '') {
  const headings = headingsFromChunks(chunks, bookTitle)
  const toc = tocFromChunks(chunks)
  const distinct = new Set(headings.map((heading) => normalizeHeading(heading.title))).size
  const source = headings.length >= 2 && distinct / headings.length >= 0.6 ? 'HEADINGS' : toc.length >= 2 ? 'TOC' : 'AI_SEGMENTED'
  const boundaries = source === 'HEADINGS' ? headings : source === 'TOC' ? toc : aiBoundaries
  return { source, sections: normalizeBoundaries(chunks, boundaries, items, chunkIds, semester) }
}

export async function buildBookOutline(bookId: string) {
  const book = await db.book.findUnique({ where: { id: bookId }, select: { id: true, semester: true, title: true } })
  if (!book) throw new Error('BOOK_NOT_FOUND')
  const [chunks, items] = await Promise.all([
    db.bookChunk.findMany({ where: { bookId }, orderBy: { index: 'asc' }, select: { id: true, index: true, headingPath: true, text: true, pageStart: true, pageEnd: true } }),
    db.bookKnowledgeItem.findMany({ where: { bookId, kbVersion: 2, chunkId: { not: null } }, select: { chunkId: true, title: true, summary: true } }),
  ])
  if (!chunks.length) throw new Error('BOOK_CHUNKS_REQUIRED')
  if (!items.length) throw new Error('BOOK_V2_KNOWLEDGE_REQUIRED')
  const chunkIds = new Map(chunks.map((chunk) => [chunk.index, chunk.id]))
  let draft = planBookOutline(chunks, items, chunkIds, book.semester, [], book.title)
  if (draft.source === 'AI_SEGMENTED') {
    const byChunk = new Map<string, Item[]>()
    for (const item of items) if (item.chunkId) byChunk.set(item.chunkId, [...(byChunk.get(item.chunkId) || []), item])
    const evidence = chunks.map((chunk) => ({ index: chunk.index, items: (byChunk.get(chunk.id) || []).slice(0, 8).map((item) => ({ title: item.title.slice(0, 100), summary: item.summary.slice(0, 180) })) }))
    const raw = await geminiCompleteJson({ system: 'قسّم الكتاب إلى أقسام متتابعة اعتماداً على عناوين وملخصات عناصر المعرفة فقط. أرجع JSON فقط.', history: [{ role: 'user', text: `حدد 4 إلى 16 بداية قسم مع عنوان، بصيغة {"sections":[{"at":0,"title":"..."}]}. يجب استخدام index موجود فقط. البيانات: ${JSON.stringify(evidence)}` }], taskLevel: 'ACADEMIC_DRAFT', temperature: 0.1, maxOutputTokens: 3000, deadlineMs: Date.now() + 180_000 })
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim())
    const boundaries: Boundary[] = Array.isArray(parsed?.sections) ? parsed.sections.filter((entry: any) => Number.isInteger(entry.at) && clean(entry.title)).map((entry: any) => ({ at: entry.at, title: clean(entry.title) })) : []
    draft = planBookOutline(chunks, items, chunkIds, book.semester, boundaries, book.title)
  }
  const latest = await db.bookOutline.findFirst({ where: { bookId }, orderBy: { version: 'desc' }, select: { version: true } })
  return db.bookOutline.create({ data: { bookId, version: (latest?.version || 0) + 1, status: 'DRAFT', source: draft.source, sections: { create: draft.sections } }, include: { sections: { orderBy: { order: 'asc' } } } })
}
