import { db } from '@/lib/db'
import { geminiCompleteJson } from '@/lib/gemini'

type Chunk = { index: number; headingPath: string | null; text: string; pageStart: number; pageEnd: number }
type Item = { chunkId: string | null; title: string; summary: string }
export type OutlineSectionDraft = { order: number; title: string; level: number; semester: number | null; chunkStartIndex: number; chunkEndIndex: number; pageStart: number | null; pageEnd: number | null; itemsCount: number; startCharOffset?: number | null }
type Boundary = { at: number; title: string; startCharOffset?: number | null; detectedChunkIndex?: number; detectedCharOffset?: number; note?: string }
type TocEntry = { title: string; page: number; targetIndex: number | null }
type LineWithOffset = { raw: string; start: number; lineNumber: number }
type ChapterHit = { label: string; number: number | null; reversed: boolean; line: LineWithOffset; lineIndex: number }

export type BookOutlineDebugLine = {
  lineNumber: number
  charOffset: number
  rawLine: string
  normalizedLine: string
  contextBefore: string
  contextAfter: string
}
export type BookOutlineDebugChunk = {
  index: number
  pageStart: number
  pageEnd: number
  headingPath: string | null
  preview: string
  matches: BookOutlineDebugLine[]
}

const tocPattern = /(?:المحتويات|الفهرس|contents|table of contents)/iu
const clean = (s: unknown, max = 180) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max)
const arabicOrdinalByNumber: Record<number, string> = { 1: 'الأول', 2: 'الثاني', 3: 'الثالث', 4: 'الرابع', 5: 'الخامس', 6: 'السادس', 7: 'السابع', 8: 'الثامن', 9: 'التاسع', 10: 'العاشر', 11: 'الحادي عشر', 12: 'الثاني عشر' }
const ordinals: Record<string, number> = {
  'الاول': 1, 'اول': 1,
  'الثاني': 2, 'ثاني': 2,
  'الثالث': 3, 'ثالث': 3,
  'الرابع': 4, 'رابع': 4,
  'الخامس': 5, 'خامس': 5,
  'السادس': 6, 'سادس': 6,
  'السابع': 7, 'سابع': 7,
  'الثامن': 8, 'ثامن': 8,
  'التاسع': 9, 'تاسع': 9,
  'العاشر': 10, 'عاشر': 10,
  'الحادي عشر': 11,
  'الثاني عشر': 12,
}
const ordinalAlternatives = '(?:الحادي\s+عشر|الثاني\s+عشر|الاول|اول|الثاني|ثاني|الثالث|ثالث|الرابع|رابع|الخامس|خامس|السادس|سادس|السابع|سابع|الثامن|ثامن|التاسع|تاسع|العاشر|عاشر|\\d{1,3})'
const chapterWordAlternatives = '(?:ال?ف\s*صل|ال?باب|ال?وحده|chapter|part|unit)'
const normalChapterPattern = new RegExp(`(?:^|\\s)(${chapterWordAlternatives})\\s+(${ordinalAlternatives})(?=\\s|[:：.\\-–]|$)`, 'iu')
const reversedChapterPattern = new RegExp(`(?:^|\\s)(${ordinalAlternatives})\\s+(${chapterWordAlternatives})(?=\\s|[:：.\\-–]|$)`, 'iu')
const rawNormalLabelPattern = /(?:ال?ف\s*صل|ال?باب|ال?وحدة|chapter|part|unit)\s+(?:الحادي\s+عشر|الثاني\s+عشر|[\p{L}\d\u0660-\u0669\u06f0-\u06f9]+)\s*[:：.\-–]?\s*/iu
const rawReversedLabelPattern = /(?:الحادي\s+عشر|الثاني\s+عشر|[\p{L}\d\u0660-\u0669\u06f0-\u06f9]+)\s+(?:ال?ف\s*صل|ال?باب|ال?وحدة|chapter|part|unit)\s*[:：.\-–]?\s*/iu
const debugKeywordPattern = /(?:ال?ف\s*صل|ال?باب)/iu

export function normalizeOutlineText(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/\u0640/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/[^\S\r\n]+/g, ' ')
    .trim()
}

const normalizeHeading = (value: unknown) => normalizeOutlineText(clean(value)).replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().trim()
const normalizeLineForMatch = (value: unknown) => normalizeOutlineText(value).toLowerCase()
const pageNumber = (value: string) => Number(normalizeOutlineText(value).replace(/[^0-9]/g, ''))
const offsetForSort = (value: number | null | undefined) => Math.max(0, value ?? 0)

function splitLinesWithOffsets(text: string): LineWithOffset[] {
  const lines: LineWithOffset[] = []
  const lineBreak = /\r\n|\n|\r/g
  let lineStart = 0
  let lineNumber = 1
  let match: RegExpExecArray | null
  while ((match = lineBreak.exec(text))) {
    lines.push({ raw: text.slice(lineStart, match.index), start: lineStart, lineNumber })
    lineStart = match.index + match[0].length
    lineNumber++
  }
  if (lineStart <= text.length) lines.push({ raw: text.slice(lineStart), start: lineStart, lineNumber })
  return lines
}

function ordinalNumber(value: string): number | null {
  const key = normalizeHeading(value)
  return ordinals[key] || (/^\d+$/.test(key) ? Number(key) : null)
}

function chapterWordLabel(value: string): string {
  const normalized = normalizeHeading(value)
  if (normalized.includes('باب')) return 'الباب'
  if (normalized.includes('وحده') || normalized === 'unit') return 'الوحدة'
  if (normalized === 'chapter') return 'chapter'
  if (normalized === 'part') return 'part'
  return 'الفصل'
}

function labelFor(word: string, ordinal: string): string {
  const number = ordinalNumber(ordinal)
  const display = number && arabicOrdinalByNumber[number] ? arabicOrdinalByNumber[number] : clean(ordinal)
  return `${chapterWordLabel(word)} ${display}`
}

function allowedChapterPrefix(normalizedLine: string, matchIndex: number): boolean {
  const prefix = normalizedLine.slice(0, Math.max(0, matchIndex)).trim()
  return !prefix || /^[\d.)\]:：\-–—]+$/.test(prefix)
}

function matchChapterLine(line: string): { label: string; number: number | null; reversed: boolean } | null {
  const normalized = normalizeLineForMatch(line)
  if (!normalized || normalized.length > 160 || /(?:\.{2,}|…+|\s{2,})\s*\d{1,4}\s*$/.test(normalized)) return null
  const normal = normalized.match(normalChapterPattern)
  if (normal && allowedChapterPrefix(normalized, normal.index || 0)) return { label: labelFor(normal[1], normal[2]), number: ordinalNumber(normal[2]), reversed: false }
  const reversed = normalized.match(reversedChapterPattern)
  if (reversed && allowedChapterPrefix(normalized, reversed.index || 0)) return { label: labelFor(reversed[2], reversed[1]), number: ordinalNumber(reversed[1]), reversed: true }
  return null
}

function chapterNumber(title: string): number | null {
  const normalized = normalizeHeading(title)
  const normal = normalized.match(normalChapterPattern)
  if (normal && allowedChapterPrefix(normalized, normal.index || 0)) return ordinalNumber(normal[2])
  const reversed = normalized.match(reversedChapterPattern)
  if (reversed && allowedChapterPrefix(normalized, reversed.index || 0)) return ordinalNumber(reversed[1])
  return null
}

function chapterLabel(title: string): string {
  const normalized = normalizeHeading(title)
  const normal = normalized.match(normalChapterPattern)
  if (normal && allowedChapterPrefix(normalized, normal.index || 0)) return clean(labelFor(normal[1], normal[2]))
  const reversed = normalized.match(reversedChapterPattern)
  if (reversed && allowedChapterPrefix(normalized, reversed.index || 0)) return clean(labelFor(reversed[2], reversed[1]))
  return clean(title)
}

function mainHeading(path: string | null, bookTitle: string): string | null {
  const bookKey = normalizeHeading(bookTitle)
  const parts = String(path || '').split(/\s*(?:>|\/|»|›|\||→|—|\s+-\s+)\s*/u).map(clean).filter(Boolean)
  for (const part of parts) {
    if (bookKey && normalizeHeading(part) === bookKey) continue
    if (chapterNumber(part) !== null) return clean(part)
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

function tocEntriesFromChunks(chunks: readonly Chunk[]): TocEntry[] {
  const first = chunks.slice(0, Math.min(8, chunks.length))
  const toc = first.filter((chunk) => tocPattern.test(chunk.text.slice(0, 2500)))
  const found: TocEntry[] = []
  for (const chunk of toc) {
    const lines = chunk.text.split(/\r?\n/).slice(0, 180)
    for (const line of lines) {
      const match = line.trim().match(/^(.{5,130}?)\s*(?:\.{2,}|…+|\s{2,})\s*([\d\u0660-\u0669\u06f0-\u06f9]{1,4})\s*$/u)
      if (!match) continue
      const title = clean(match[1], 130)
      if (chapterNumber(title) === null) continue
      const page = pageNumber(match[2])
      const target = chunks.find((entry) => entry.pageStart <= page && entry.pageEnd >= page)
      found.push({ title, page, targetIndex: target?.index ?? null })
    }
  }
  return found
}

export function tocFromChunks(chunks: readonly Chunk[]): Boundary[] {
  return tocEntriesFromChunks(chunks)
    .filter((entry): entry is TocEntry & { targetIndex: number } => entry.targetIndex !== null)
    .map((entry) => ({ at: entry.targetIndex, title: entry.title }))
}

function tocNameMap(chunks: readonly Chunk[]): Map<number, string> {
  const names = new Map<number, string>()
  for (const entry of tocEntriesFromChunks(chunks)) {
    const number = chapterNumber(entry.title)
    if (number !== null && !names.has(number)) names.set(number, entry.title)
  }
  return names
}

function rejectedChapterNameCandidate(line: string, bookTitle: string): boolean {
  const value = clean(line, 100)
  const normalized = normalizeHeading(value)
  if (value.length < 3 || value.length > 80) return true
  if (/^\d+$/.test(normalized)) return true
  if (/^(?:صفحه|صفحة|page)\s*\d+$/u.test(normalized)) return true
  if (normalizeHeading(bookTitle) && normalized === normalizeHeading(bookTitle)) return true
  if (tocPattern.test(value)) return true
  if (matchChapterLine(value)) return true
  if (/^(?:المبحث|المطلب|الفرع)\s/u.test(value)) return true
  if (/^[\W_]+$/u.test(value)) return true
  return false
}

function sameLineChapterName(rawLine: string, hit: ChapterHit, bookTitle: string): string | null {
  const pattern = hit.reversed ? rawReversedLabelPattern : rawNormalLabelPattern
  const candidate = clean(rawLine.replace(pattern, ''), 100).replace(/^[\s:：.\-–]+|[\s:：.\-–]+$/g, '')
  return rejectedChapterNameCandidate(candidate, bookTitle) ? null : candidate
}

function firstUsableNeighbor(lines: readonly LineWithOffset[], indexes: number[], bookTitle: string): string | null {
  for (const index of indexes) {
    const candidate = clean(lines[index]?.raw, 100)
    if (!rejectedChapterNameCandidate(candidate, bookTitle)) return candidate
  }
  return null
}

function chapterNameFromHit(lines: readonly LineWithOffset[], hit: ChapterHit, bookTitle: string, tocTitle?: string): string {
  const index = lines.indexOf(hit.line)
  const sameLine = sameLineChapterName(hit.line.raw, hit, bookTitle)
  if (sameLine) return `${hit.label}: ${sameLine}`
  const forward = Array.from({ length: 7 }, (_, i) => index + i + 1).filter((i) => i < lines.length)
  const backward = Array.from({ length: 7 }, (_, i) => index - i - 1).filter((i) => i >= 0)
  const neighbor = hit.reversed
    ? firstUsableNeighbor(lines, backward, bookTitle) || firstUsableNeighbor(lines, forward, bookTitle)
    : firstUsableNeighbor(lines, forward, bookTitle) || firstUsableNeighbor(lines, backward, bookTitle)
  if (neighbor) return `${hit.label}: ${neighbor}`
  if (tocTitle && normalizeHeading(tocTitle) !== normalizeHeading(hit.label)) return clean(tocTitle)
  return hit.label
}

function chapterHitsForChunk(chunk: Chunk, bookTitle: string, tocNames: ReadonlyMap<number, string>): Boundary[] {
  const lines = splitLinesWithOffsets(chunk.text)
  const found: Boundary[] = []
  const seenOffsets = new Set<number>()
  for (const line of lines) {
    const matched = matchChapterLine(line.raw)
    if (!matched || seenOffsets.has(line.start)) continue
    if (normalizeHeading(matched.label) === normalizeHeading(bookTitle)) continue
    seenOffsets.add(line.start)
    const hit: ChapterHit = { ...matched, line }
    found.push({
      at: chunk.index,
      title: chapterNameFromHit(lines, hit, bookTitle, matched.number === null ? undefined : tocNames.get(matched.number)),
      startCharOffset: line.start > 0 ? line.start : null,
      detectedChunkIndex: chunk.index,
      detectedCharOffset: line.start,
    })
  }
  return found
}

function textChapters(chunks: readonly Chunk[], bookTitle: string, tocNames: ReadonlyMap<number, string>): Boundary[] {
  const sorted = [...chunks].sort((a, b) => a.index - b.index)
  const found: Boundary[] = []
  for (let i = 0; i < sorted.length; i++) {
    const chunk = sorted[i]
    for (const boundary of chapterHitsForChunk(chunk, bookTitle, tocNames)) {
      if ((boundary.detectedCharOffset || 0) > 0 && (boundary.detectedCharOffset || 0) > chunk.text.length / 2 && sorted[i + 1]) {
        found.push({
          ...boundary,
          at: sorted[i + 1].index,
          startCharOffset: null,
          note: `${chapterLabel(boundary.title)} ظهر داخل المقطع ${chunk.index} عند الإزاحة ${boundary.detectedCharOffset} في النصف الثاني؛ بدأ القسم من المقطع التالي ${sorted[i + 1].index}`,
        })
      } else {
        found.push({
          ...boundary,
          note: (boundary.detectedCharOffset || 0) > 0 ? `${chapterLabel(boundary.title)} ظهر داخل المقطع ${chunk.index} عند الإزاحة ${boundary.detectedCharOffset}؛ بدأ القسم من نفس المقطع` : undefined,
        })
      }
    }
  }
  return found
}

function sameBoundary(a: Boundary, b: Boundary): boolean {
  return a.at === b.at && offsetForSort(a.startCharOffset) === offsetForSort(b.startCharOffset) && normalizeHeading(a.title) === normalizeHeading(b.title)
}

function normalizeBoundaries(chunks: readonly Chunk[], boundaries: readonly Boundary[], items: readonly Item[], chunkIds: ReadonlyMap<number, string>, semester: number | null): OutlineSectionDraft[] {
  const sorted = [...chunks].sort((a, b) => a.index - b.index)
  if (!sorted.length) return []
  const at = new Map(sorted.map((chunk, index) => [chunk.index, index]))
  const ordered: Boundary[] = []
  for (const boundary of boundaries.filter((b) => at.has(b.at)).sort((a, b) => at.get(a.at)! - at.get(b.at)! || offsetForSort(a.startCharOffset) - offsetForSort(b.startCharOffset))) {
    if (!ordered.some((entry) => sameBoundary(entry, boundary))) ordered.push({ ...boundary, title: clean(boundary.title) })
  }
  const firstBoundary = ordered[0]
  if (!firstBoundary || firstBoundary.at !== sorted[0].index || offsetForSort(firstBoundary.startCharOffset) > 0) {
    ordered.unshift({ at: sorted[0].index, title: clean(sorted[0].headingPath) || 'مقدمة الكتاب', startCharOffset: null })
  }
  let ranges = ordered.map((boundary, i) => {
    const start = at.get(boundary.at)!
    const next = ordered[i + 1]
    const nextStart = next ? at.get(next.at)! : null
    const end = nextStart === null ? sorted.length - 1 : nextStart === start ? start : nextStart - 1
    return { start, end, title: boundary.title, startCharOffset: boundary.startCharOffset ?? null }
  }).filter((range) => range.end >= range.start)
  // Real chapter boundaries and same-chunk splits must not be merged away.
  // Only unlabeled one-chunk fragments may be absorbed into neighboring sections.
  for (let i = ranges.length - 1; i >= 0; i--) {
    if (ranges.length <= 1 || chapterNumber(ranges[i].title) !== null) continue
    if (ranges[i].end !== ranges[i].start) continue
    const sharesChunkWithNeighbor = (i > 0 && ranges[i - 1].start === ranges[i].start) || (i + 1 < ranges.length && ranges[i + 1].start === ranges[i].start)
    if (sharesChunkWithNeighbor || ranges[i].startCharOffset !== null) continue
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
    ranges.splice(largest + 1, 0, { start: mid + 1, end: range.end, title: `${range.title} — تابع`, startCharOffset: null })
    range.end = mid
  }
  const itemCount = new Map<string, number>()
  for (const item of items) if (item.chunkId) itemCount.set(item.chunkId, (itemCount.get(item.chunkId) || 0) + 1)
  return ranges.map((range, order) => ({
    order: order + 1, title: range.title, level: 1, semester,
    chunkStartIndex: sorted[range.start].index, chunkEndIndex: sorted[range.end].index,
    startCharOffset: range.startCharOffset,
    pageStart: sorted[range.start].pageStart,
    pageEnd: order + 1 < ranges.length
      ? (sorted[ranges[order + 1].start].pageStart <= sorted[range.start].pageStart ? null : Math.min(sorted[range.end].pageEnd, sorted[ranges[order + 1].start].pageStart - 1))
      : sorted[range.end].pageEnd,
    itemsCount: sorted.slice(range.start, range.end + 1).reduce((sum, chunk) => sum + (itemCount.get(chunkIds.get(chunk.index) || '') || 0), 0),
  }))
}

export function debugBookOutlineChunks(chunks: readonly Chunk[]): BookOutlineDebugChunk[] {
  return [...chunks].sort((a, b) => a.index - b.index).map((chunk) => {
    const lines = splitLinesWithOffsets(chunk.text)
    const matches = lines.flatMap((line) => {
      const normalizedLine = normalizeLineForMatch(line.raw)
      if (!debugKeywordPattern.test(normalizedLine)) return []
      const lineEnd = line.start + line.raw.length
      return [{
        lineNumber: line.lineNumber,
        charOffset: line.start,
        rawLine: clean(line.raw, 220),
        normalizedLine: clean(normalizedLine, 220),
        contextBefore: chunk.text.slice(Math.max(0, line.start - 40), line.start),
        contextAfter: chunk.text.slice(lineEnd, Math.min(chunk.text.length, lineEnd + 40)),
      }]
    })
    return {
      index: chunk.index,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      headingPath: chunk.headingPath,
      preview: chunk.text.slice(0, 150),
      matches,
    }
  })
}

export function planBookOutline(chunks: readonly Chunk[], items: readonly Item[], chunkIds: ReadonlyMap<number, string>, semester: number | null, aiBoundaries: readonly Boundary[] = [], bookTitle = '') {
  const headings = headingsFromChunks(chunks, bookTitle)
  const toc = tocFromChunks(chunks)
  const tocNames = tocNameMap(chunks)
  const fromText = textChapters(chunks, bookTitle, tocNames)
  const distinct = new Set(headings.map((heading) => normalizeHeading(heading.title))).size
  const source = headings.length >= 2 && distinct / headings.length >= 0.6 ? 'HEADINGS' : toc.length >= 2 ? 'TOC' : fromText.length > 0 ? 'HEADINGS' : 'AI_SEGMENTED'
  const primary = source === 'HEADINGS' ? (headings.length >= 2 ? headings : fromText) : source === 'TOC' ? toc : aiBoundaries
  const byNumber = new Map<number, Boundary>()
  for (const boundary of primary) {
    const number = chapterNumber(boundary.title)
    if (number !== null && !byNumber.has(number)) byNumber.set(number, boundary)
  }
  const expected = [...tocNames.keys()].filter((n): n is number => n !== null)
  const maximum = expected.length ? Math.max(...expected) : byNumber.size ? Math.max(...byNumber.keys()) : 0
  for (const boundary of fromText) {
    const number = chapterNumber(boundary.title)
    if (number !== null && number <= Math.max(maximum, 12) && !byNumber.has(number)) byNumber.set(number, boundary)
  }
  const boundaries = [...primary.filter((entry) => chapterNumber(entry.title) === null), ...byNumber.values()]
    .sort((a, b) => a.at - b.at || offsetForSort(a.startCharOffset) - offsetForSort(b.startCharOffset))
    .map((entry) => {
      const number = chapterNumber(entry.title)
      if (number === null) return entry
      const label = chapterLabel(entry.title)
      const tocTitle = tocNames.get(number)
      return {
        ...entry,
        title: tocTitle && normalizeHeading(entry.title) === normalizeHeading(label) ? tocTitle : entry.title,
      }
    })
  const sections = normalizeBoundaries(chunks, boundaries, items, chunkIds, semester)
  const detected = new Set(sections.map((section) => chapterNumber(section.title)).filter((n) => n !== null))
  const warnings = [...new Set(boundaries.map((entry) => entry.note).filter((note): note is string => Boolean(note)))]
  if (expected.length && detected.size !== expected.length) warnings.push(`عدد الفصول المكتشفة ${detected.size} من ${expected.length} في فهرس الكتاب`)
  for (let n = 1; n <= maximum; n++) if (!detected.has(n)) warnings.push(`الفصل رقم ${n} غير مكتشف`)
  return { source, sections, warnings }
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
    const boundaries: Boundary[] = Array.isArray(parsed?.sections) ? parsed.sections.filter((entry: any) => Number.isInteger(entry.at) && clean(entry.title)).map((entry: any) => ({ at: entry.at, title: clean(entry.title), startCharOffset: null })) : []
    draft = planBookOutline(chunks, items, chunkIds, book.semester, boundaries, book.title)
  }
  const latest = await db.bookOutline.findFirst({ where: { bookId }, orderBy: { version: 'desc' }, select: { version: true } })
  return db.bookOutline.create({ data: { bookId, version: (latest?.version || 0) + 1, status: 'DRAFT', source: draft.source, warnings: JSON.stringify(draft.warnings), sections: { create: draft.sections } }, include: { sections: { orderBy: { order: 'asc' } } } })
}
