import { db } from '@/lib/db'
import { geminiCompleteJson } from '@/lib/gemini'
import { PDFDocument } from 'pdf-lib'
import { getFileBufferFromStorageOrBase64 } from '@/lib/storage'
import { extractNumberedPdfPages, pagesNeedingOcr, transcribeScannedDocumentWithVision, type ExtractedBookPage } from '@/lib/book-reader'
import { fixArabicPdfText } from '@/lib/arabic-pdf-text'

type Chunk = { index: number; headingPath: string | null; text: string; pageStart: number; pageEnd: number }
type Item = { chunkId: string | null; title: string; summary: string }
export type OutlineSectionDraft = { order: number; title: string; level: number; semester: number | null; chunkStartIndex: number; chunkEndIndex: number; pageStart: number | null; pageEnd: number | null; itemsCount: number; startCharOffset?: number | null }
type Boundary = { at: number; title: string; startCharOffset?: number | null; detectedChunkIndex?: number; detectedCharOffset?: number; note?: string; verifiedHeading?: boolean }
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
const ordinalAlternatives = '(?:الحادي\\s+عشر|الثاني\\s+عشر|الاول|اول|الثاني|ثاني|الثالث|ثالث|الرابع|رابع|الخامس|خامس|السادس|سادس|السابع|سابع|الثامن|ثامن|التاسع|تاسع|العاشر|عاشر|\\d{1,3})'
const chapterWordAlternatives = '(?:ال?ف\\s*صل|ال?باب|ال?وحده|chapter|part|unit)'
const normalChapterPattern = new RegExp(`(?:^|\\s)(${chapterWordAlternatives})\\s+(${ordinalAlternatives})(?=\\s|[:：.\\-–]|$)`, 'iu')
const reversedChapterPattern = new RegExp(`(?:^|\\s)(${ordinalAlternatives})\\s+(${chapterWordAlternatives})(?=\\s|[:：.\\-–]|$)`, 'iu')
const rawNormalLabelPattern = /(?:ال?ف\\s*صل|ال?باب|ال?وحدة|chapter|part|unit)\s+(?:الحادي\\s+عشر|الثاني\\s+عشر|[\p{L}\d\u0660-\u0669\u06f0-\u06f9]+)\s*[:：.\-–]?\s*/iu
const rawReversedLabelPattern = /(?:الحادي\\s+عشر|الثاني\\s+عشر|[\p{L}\d\u0660-\u0669\u06f0-\u06f9]+)\s+(?:ال?ف\\s*صل|ال?باب|ال?وحدة|chapter|part|unit)\s*[:：.\-–]?\s*/iu
const debugKeywordPattern = /(?:ال?ف\\s*صل|ال?باب)/iu

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
  if (!/[\p{L}\p{N}]/u.test(value)) return true
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
  const index = hit.lineIndex
  const forward = Array.from({ length: 7 }, (_, i) => index + i + 1).filter((i) => i < lines.length)
  const backward = Array.from({ length: 7 }, (_, i) => index - i - 1).filter((i) => i >= 0)
  // In Arabic PDF extraction the heading can arrive as "الأول الفصل"; in that
  // layout the semantic chapter title is usually the line immediately before it.
  if (hit.reversed) {
    const previousTitle = firstUsableNeighbor(lines, backward, bookTitle)
    if (previousTitle) return `${hit.label}: ${previousTitle}`
  }
  const sameLine = sameLineChapterName(hit.line.raw, hit, bookTitle)
  if (sameLine) return `${hit.label}: ${sameLine}`
  const neighbor = hit.reversed
    ? firstUsableNeighbor(lines, forward, bookTitle)
    : firstUsableNeighbor(lines, forward, bookTitle) || firstUsableNeighbor(lines, backward, bookTitle)
  if (neighbor) return `${hit.label}: ${neighbor}`
  if (tocTitle && normalizeHeading(tocTitle) !== normalizeHeading(hit.label)) return clean(tocTitle)
  return hit.label
}

function chapterHitsForChunk(chunk: Chunk, bookTitle: string, tocNames: ReadonlyMap<number, string>): Boundary[] {
  const lines = splitLinesWithOffsets(chunk.text)
  const found: Boundary[] = []
  const seenOffsets = new Set<number>()
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]
    const matched = matchChapterLine(line.raw)
    if (!matched || seenOffsets.has(line.start)) continue
    if (normalizeHeading(matched.label) === normalizeHeading(bookTitle)) continue
    seenOffsets.add(line.start)
    const hit: ChapterHit = { ...matched, line, lineIndex }
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
    return { start, end, title: boundary.title, startCharOffset: boundary.startCharOffset ?? null, verifiedHeading: boundary.verifiedHeading ?? false }
  }).filter((range) => range.end >= range.start)
  // Real chapter boundaries and same-chunk splits must not be merged away.
  // Only unlabeled one-chunk fragments may be absorbed into neighboring sections.
  for (let i = ranges.length - 1; i >= 0; i--) {
    if (ranges.length <= 1 || ranges[i].verifiedHeading || chapterNumber(ranges[i].title) !== null) continue
    if (ranges[i].end !== ranges[i].start) continue
    const sharesChunkWithNeighbor = (i > 0 && ranges[i - 1].start === ranges[i].start) || (i + 1 < ranges.length && ranges[i + 1].start === ranges[i].start)
    if (sharesChunkWithNeighbor || ranges[i].startCharOffset !== null) continue
    if (i > 0) { ranges[i - 1].end = ranges[i].end; ranges.splice(i, 1) }
    else { ranges[1].start = ranges[0].start; ranges.shift() }
  }
  while (ranges.length > 16) {
    // Merge the adjacent pair whose COMBINED PAGE SPAN is smallest. Merging by
    // chunk count alone can fold a short final range into a huge predecessor
    // and silently re-form an oversized tail section; page span is the unit
    // the coverage guard judges, so it is the unit merging must minimize.
    let best = 1
    let bestSpan = Infinity
    for (let i = 1; i < ranges.length; i++) {
      const span = sorted[ranges[i].end].pageEnd - sorted[ranges[i - 1].start].pageStart
      if (span < bestSpan) { bestSpan = span; best = i }
    }
    ranges[best - 1].end = ranges[best].end
    ranges.splice(best, 1)
  }
  // Never undo tiny-section merging by splitting real heading/TOC sections again.
  // Only create synthetic sections when no reliable boundaries were supplied.
  while (boundaries.length === 0 && ranges.length < Math.min(4, sorted.length)) {
    let largest = 0
    for (let i = 1; i < ranges.length; i++) if (ranges[i].end - ranges[i].start > ranges[largest].end - ranges[largest].start) largest = i
    const range = ranges[largest]
    if (range.end <= range.start) break
    const mid = Math.floor((range.start + range.end) / 2)
    ranges.splice(largest + 1, 0, { start: mid + 1, end: range.end, title: `${range.title} — تابع`, startCharOffset: null, verifiedHeading: false })
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

function usableOutlineTitle(title: string, bookTitle: string): boolean {
  const normalized = normalizeHeading(title)
  if (!normalized || normalized === normalizeHeading(bookTitle)) return false
  // A cover, repeated header, or generic intro is not evidence of a chapter.
  if (/^(?:مقدمه(?: الكتاب)?|تمهيد|تابع|الفهرس|المحتويات|خاتمه|مراجع|references|introduction|contents)$/u.test(normalized)) return false
  if (/^(?:مقدمه الكتاب|تمهيد)(?: تابع)+$/u.test(normalized)) return false
  return true
}

export function planBookOutline(chunks: readonly Chunk[], items: readonly Item[], chunkIds: ReadonlyMap<number, string>, semester: number | null, aiBoundaries: readonly Boundary[] = [], bookTitle = '', preferSourceBoundaries = false) {
  const headings = headingsFromChunks(chunks, bookTitle)
  const toc = tocFromChunks(chunks)
  const tocNames = tocNameMap(chunks)
  const fromText = textChapters(chunks, bookTitle, tocNames)
  const distinct = new Set(headings.map((heading) => normalizeHeading(heading.title))).size
  const sourceHeadings = aiBoundaries.filter((entry) => usableOutlineTitle(entry.title, bookTitle))
  const distinctSource = new Set(sourceHeadings.map((entry) => normalizeHeading(entry.title))).size
  const reliableSource = (sourceHeadings.length >= 2 && distinctSource >= 2) || (chunks.length === 1 && sourceHeadings.length === 1)
  // Keep the legacy chapter/TOC/text precedence. Prefer PDF headings only when
  // at least two different, substantive source titles are actually detected.
  const source = preferSourceBoundaries && reliableSource ? 'SOURCE_HEADINGS' : headings.length >= 2 && distinct / headings.length >= 0.6 ? 'HEADINGS' : toc.length >= 2 ? 'TOC' : fromText.length > 0 ? 'HEADINGS' : reliableSource ? 'SOURCE_HEADINGS' : 'AI_SEGMENTED'
  const primary = source === 'HEADINGS' ? (headings.length >= 2 ? headings : fromText) : source === 'TOC' ? toc : source === 'SOURCE_HEADINGS' ? sourceHeadings : []
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

// ---------------------------------------------------------------------------
// Outline coverage audit + approval guard.
//
// Sections tile the book's chunks by construction, so "coverage" is judged by
// page span: a section spanning too many pages means later boundaries were
// never detected inside it, and any unit built from it would swallow that
// whole range. Bands (owner-approved 2026-10-31): up to REVIEW pages passes,
// up to BLOCK pages needs a heading re-check, above BLOCK pages approval is
// refused unless a supervisor records an explicit override (a genuine long
// chapter is flagged and passed by decision, never shredded automatically).
// ---------------------------------------------------------------------------
export const OUTLINE_SECTION_REVIEW_PAGES = 40
export const OUTLINE_SECTION_BLOCK_PAGES = 80

export type OutlineSectionCoverage = { order: number; title: string; pageStart: number | null; pageEnd: number | null; pages: number | null; band: 'OK' | 'REVIEW' | 'BLOCKED' }
export type OutlineCoverageReport = { totalPages: number | null; maxSectionPages: number | null; sections: OutlineSectionCoverage[]; review: OutlineSectionCoverage[]; blocked: OutlineSectionCoverage[]; gaps: Array<{ pageStart: number; pageEnd: number }> }

export function sectionPageSpan(section: Pick<OutlineSectionDraft, 'pageStart' | 'pageEnd'>): number | null {
  if (section.pageStart == null || section.pageEnd == null || section.pageEnd < section.pageStart) return null
  return section.pageEnd - section.pageStart + 1
}

export function auditOutlineCoverage(sections: readonly OutlineSectionDraft[]): OutlineCoverageReport {
  const audited = sections.map((section) => {
    const pages = sectionPageSpan(section)
    // Unknown page ends need review; they must never silently pass as OK.
    const band: OutlineSectionCoverage['band'] = pages === null ? 'REVIEW' : pages <= OUTLINE_SECTION_REVIEW_PAGES ? 'OK' : pages <= OUTLINE_SECTION_BLOCK_PAGES ? 'REVIEW' : 'BLOCKED'
    return { order: section.order, title: section.title, pageStart: section.pageStart, pageEnd: section.pageEnd, pages, band }
  })
  const starts = sections.map((section) => section.pageStart).filter((page): page is number => page != null)
  const ends = sections.map((section) => section.pageEnd).filter((page): page is number => page != null)
  const validRanges = audited.filter((section) => section.pages !== null && section.pageStart !== null && section.pageEnd !== null)
    .sort((a, b) => Number(a.pageStart) - Number(b.pageStart))
  const gaps: Array<{ pageStart: number; pageEnd: number }> = []
  let coveredUntil: number | null = null
  for (const section of validRanges) {
    const start = section.pageStart!
    const end = section.pageEnd!
    if (coveredUntil !== null && start > coveredUntil + 1) {
      // Same-chunk chapter splits can have a null pageEnd; do not assert a
      // missing-page gap while an unknown-length section starts inside it.
      // The unknown section is already marked REVIEW, not silently approved.
      const unknownBridge = audited.some((candidate) => candidate.pages === null && candidate.pageStart !== null && candidate.pageStart >= coveredUntil! && candidate.pageStart <= start)
      if (!unknownBridge) gaps.push({ pageStart: coveredUntil + 1, pageEnd: start - 1 })
    }
    coveredUntil = Math.max(coveredUntil ?? end, end)
  }
  return {
    totalPages: starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) + 1 : null,
    maxSectionPages: audited.reduce<number | null>((max, section) => (section.pages === null ? max : Math.max(max ?? 0, section.pages)), null),
    sections: audited,
    review: audited.filter((section) => section.band === 'REVIEW'),
    blocked: audited.filter((section) => section.band === 'BLOCKED'),
    gaps,
  }
}

export function outlineApprovalGuard(sections: readonly OutlineSectionDraft[]): { decision: 'ALLOW' | 'ALLOW_WITH_REVIEW' | 'BLOCK'; report: OutlineCoverageReport } {
  const report = auditOutlineCoverage(sections)
  return { decision: report.blocked.length || report.gaps.length ? 'BLOCK' : report.review.length ? 'ALLOW_WITH_REVIEW' : 'ALLOW', report }
}

function parseAiRangeBoundaries(raw: string, rangeChunks: readonly Chunk[], bookTitle: string): Boundary[] {
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim())
  const first = rangeChunks[0]?.index
  const last = rangeChunks[rangeChunks.length - 1]?.index
  if (first === undefined || last === undefined) return []
  const existing = new Set(rangeChunks.map((chunk) => chunk.index))
  const seen = new Set<number>()
  const boundaries: Boundary[] = []
  for (const entry of Array.isArray(parsed?.sections) ? parsed.sections : []) {
    const at = entry?.at
    const title = clean(entry?.title, 140)
    if (!Number.isInteger(at) || !existing.has(at) || at <= first || at > last || seen.has(at) || !usableOutlineTitle(title, bookTitle)) continue
    seen.add(at)
    boundaries.push({ at, title, startCharOffset: null })
    if (boundaries.length >= 8) break
  }
  return boundaries.sort((a, b) => a.at - b.at)
}

// Collect grounded interior boundaries for ONE oversized section range from
// the book's own deterministic evidence: chunk heading paths, chapter lines
// in the stored text, and source boundaries the global source precedence
// dropped. Returns interior boundaries only (the caller anchors the range
// start with the section's own title, so no fabricated «مقدمة الكتاب»/«تابع»
// title can appear mid-book). The caller falls back to an AI range pass
// when this returns nothing.
function rangeInteriorBoundaries(rangeChunks: readonly Chunk[], sourceBoundaries: readonly Boundary[], bookTitle: string): Boundary[] {
  const first = rangeChunks[0].index
  const last = rangeChunks[rangeChunks.length - 1].index
  const interior = new Map<string, Boundary>()
  const add = (boundary: Boundary) => {
    if (boundary.at <= first || boundary.at > last || !usableOutlineTitle(boundary.title, bookTitle)) return
    interior.set(boundary.at + ':' + (boundary.startCharOffset ?? 0), boundary)
  }
  for (const boundary of headingsFromChunks(rangeChunks, bookTitle)) add(boundary)
  for (const boundary of textChapters(rangeChunks, bookTitle, new Map())) add(boundary)
  for (const boundary of sourceBoundaries) add(boundary)
  return [...interior.values()].sort((a, b) => a.at - b.at || offsetForSort(a.startCharOffset) - offsetForSort(b.startCharOffset))
}

// Split every section above the REVIEW band using evidence found inside its
// own range. Runs AFTER the global plan, so the global section cap and the
// small-section merging can never re-collapse a split range afterwards.
// Sections that yield no grounded interior boundary stay whole and are left
// for the coverage audit + approval guard to judge.
export async function refineOversizedSections(params: {
  sections: readonly OutlineSectionDraft[]
  chunks: readonly Chunk[]
  items: readonly Item[]
  chunkIds: ReadonlyMap<number, string>
  semester: number | null
  sourceBoundaries?: readonly Boundary[]
  bookTitle: string
  allowAi?: boolean
  maxRanges?: number
}): Promise<{ sections: OutlineSectionDraft[]; warnings: string[]; refinedRanges: number }> {
  const allowAi = params.allowAi !== false
  const maxRanges = params.maxRanges ?? 3
  const warnings: string[] = []
  let sections: OutlineSectionDraft[] = [...params.sections]
  let refinedRanges = 0
  const targets = params.sections.filter((section) => {
    const span = sectionPageSpan(section)
    return span !== null && span > OUTLINE_SECTION_REVIEW_PAGES && section.chunkEndIndex > section.chunkStartIndex
  })
  for (const target of targets) {
    const at = sections.findIndex((section) => section.order === target.order && section.chunkStartIndex === target.chunkStartIndex && section.chunkEndIndex === target.chunkEndIndex)
    if (at < 0) continue
    const section = sections[at]
    if (refinedRanges >= maxRanges) {
      warnings.push(`لم تُعاد فحوص تقسيم القسم «${section.title}» (${sectionPageSpan(section)} صفحة) في هذه الجولة؛ حدّ الجولات ${maxRanges}. أعد بناء الفهرس لإعادة المحاولة.`)
      continue
    }
    const rangeChunks = params.chunks.filter((chunk) => chunk.index >= section.chunkStartIndex && chunk.index <= section.chunkEndIndex)
    if (rangeChunks.length < 2) continue
    let interior = rangeInteriorBoundaries(rangeChunks, params.sourceBoundaries || [], params.bookTitle)
    if (!interior.length && allowAi) {
      const byChunk = new Map<string, Item[]>()
      for (const item of params.items) if (item.chunkId) byChunk.set(item.chunkId, [...(byChunk.get(item.chunkId) || []), item])
      const evidence = rangeChunks.map((chunk) => ({
        index: chunk.index,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        excerpt: chunk.text.slice(0, 350),
        items: (byChunk.get(params.chunkIds.get(chunk.index) || '') || []).slice(0, 8).map((item) => ({ title: item.title.slice(0, 100), summary: item.summary.slice(0, 180) })),
      }))
      try {
        const raw = await geminiCompleteJson({ system: 'قسّم هذا النطاق فقط من الكتاب إلى أقسام موضوعية متتابعة اعتماداً حصراً على مقتطفات النص وعناوين وملخصات المعرفة. لا تخترع عناوين غير مستندة إلى الأدلة، وامنع العناوين العامة مثل مقدمة الكتاب أو تابع. أرجع JSON فقط.', history: [{ role: 'user', text: `اقترح من 1 إلى 8 بدايات أقسام فرعية داخل النطاق (لا تشمل بداية النطاق نفسه)، بعناوين موضوعية، بصيغة {"sections":[{"at":0,"title":"عنوان موضوعي"}]}. استخدم index من البيانات فقط. البيانات: ${JSON.stringify(evidence)}` }], taskLevel: 'ACADEMIC_DRAFT', temperature: 0.1, maxOutputTokens: 2000, deadlineMs: Date.now() + 120_000 })
        interior = parseAiRangeBoundaries(raw, rangeChunks, params.bookTitle)
      } catch { interior = [] }
    }
    if (!interior.length) continue
    const anchor: Boundary = { at: section.chunkStartIndex, title: section.title, startCharOffset: section.startCharOffset ?? null, verifiedHeading: true }
    const subSections = normalizeBoundaries(rangeChunks, [anchor, ...interior], params.items, params.chunkIds, params.semester)
    if (subSections.length < 2) continue
    sections = [...sections.slice(0, at), ...subSections, ...sections.slice(at + 1)]
    warnings.push(`قُسّم القسم الكبير «${section.title}» (${sectionPageSpan(section)} صفحة، صفحات ${section.pageStart}–${section.pageEnd}) إلى ${subSections.length} أقسام فرعية بناءً على أدلة داخل نطاقه؛ راجع الحدود قبل الاعتماد.`)
    refinedRanges++
  }
  return { sections: sections.map((section, index) => ({ ...section, order: index + 1 })), warnings, refinedRanges }
}

type SourceHeading = { page: number; title: string; rawLine: string }

const articlePrefix = /^(?:المقال\s*[:：]\s*)(.{5,110})$/iu
const subordinateHeading = /^(?:اسئله?\s*واجوبه?|أسئلة\s*وأجوبة|خلاصه|الخلاصة|تطبيقات\s*عمليه|المراجع|تمارين|مناقشه|أهداف\s*التعلم)\s*[:：]?\s*$/iu
const numberedOrQuestion = /^(?:[•●▪*]|[-–—]\s|\d{1,3}\s*[.):\-–]|[٠-٩]{1,3}\s*[.):\-–]|[سج]\s*\d+\s*[:：]|(?:سؤال|س)\s*[:：]|[؟?])/iu
const commonTopicStart = /^(?:مقدمه|مقدمة|دور|اهميه|أهمية|مفهوم|الإدارة|ادارة|إدارة|التخطيط|القيادة|التحليل|الاقتصاد|التسويق|الابتكار|الموارد|الرقابة|الجودة|مهارات|التنظيم|الاتصال|المخاطر|المنافسة)(?=\s|[:：]|$)/iu

export function detectOriginalSourceHeadings(pages: readonly ExtractedBookPage[], bookTitle: string): SourceHeading[] {
  const normalizedPages = pages.map((page) => ({ page: page.page, lines: page.text.split(/\r?\n|\r/) }))
  const pagesPerLine = new Map<string, Set<number>>()
  for (const page of normalizedPages) {
    for (const line of page.lines) {
      const key = normalizeHeading(line)
      if (!key || key.length > 110) continue
      if (!pagesPerLine.has(key)) pagesPerLine.set(key, new Set())
      pagesPerLine.get(key)!.add(page.page)
    }
  }
  const output: SourceHeading[] = []
  for (const page of normalizedPages) {
    for (let i = 0; i < page.lines.length; i++) {
      const rawLine = page.lines[i].trim()
      const key = normalizeHeading(rawLine)
      if (rawLine.length < 7 || rawLine.length > 115 || !key) continue
      if ((pagesPerLine.get(key)?.size || 0) >= 3 || key === normalizeHeading(bookTitle)) continue
      if (subordinateHeading.test(normalizeOutlineText(rawLine)) || numberedOrQuestion.test(rawLine)) continue
      if (/[؟?،,؛;.!]$/.test(rawLine) || /^\s*(?:https?:\/\/|www\.)/i.test(rawLine)) continue
      if (matchChapterLine(rawLine)) {
        output.push({ page: page.page, title: rawLine, rawLine })
        continue
      }
      const prefixed = rawLine.match(articlePrefix)
      const previousBlank = i === 0 || page.lines[i - 1].trim() === ''
      const following = page.lines.slice(i + 1, i + 6).map((line) => line.trim()).filter(Boolean).join(' ')
      const hasBody = following.length >= 95
      if (!hasBody) continue
      if (prefixed) output.push({ page: page.page, title: clean(prefixed[1]), rawLine })
      else if (previousBlank && commonTopicStart.test(rawLine) && rawLine.length <= 85 && rawLine.split(/\s+/).length <= 11) {
        output.push({ page: page.page, title: rawLine, rawLine })
      }
    }
  }
  return output
}

function projectSourceHeadings(headings: readonly SourceHeading[], chunks: readonly Chunk[]): Boundary[] {
  const projected: Boundary[] = []
  const used = new Set<string>()
  for (const heading of headings) {
    const overlaps = chunks.filter((chunk) => chunk.pageStart <= heading.page && chunk.pageEnd >= heading.page)
    let candidate: Boundary | null = null
    for (const chunk of overlaps) {
      // Existing chunks retain their IDs and hashes. Match source evidence to text,
      // never rewrite the stored chunks or fabricate an offset.
      const rawOffset = chunk.text.indexOf(heading.rawLine)
      const titleOffset = chunk.text.indexOf(heading.title)
      const offset = rawOffset >= 0 ? rawOffset : titleOffset
      if (offset >= 0) {
        candidate = { at: chunk.index, title: heading.title, startCharOffset: offset || null }
        break
      }
    }
    if (!candidate && overlaps.length) {
      candidate = { at: overlaps[0].index, title: heading.title, startCharOffset: null, note: 'عنوان من الملف الأصلي بلا موضع حرفي مطابق في المقاطع القديمة؛ راجع حد القسم قبل الاعتماد' }
    }
    if (!candidate) continue
    const positionKey = candidate.at + ':' + (candidate.startCharOffset ?? 0)
    if (used.has(positionKey)) continue
    used.add(positionKey)
    projected.push({ ...candidate, verifiedHeading: true })
  }
  return projected.slice(0, 100)
}

export type OutlineSubheadingMarker = { sectionOrder: number; title: string; page: number; chunkIndex: number; charOffset: number | null }

export function outlineSubheadingMarkers(pages: readonly ExtractedBookPage[], chunks: readonly Chunk[], sections: readonly OutlineSectionDraft[]): OutlineSubheadingMarker[] {
  const markers: OutlineSubheadingMarker[] = []
  const seen = new Set<string>()
  for (const page of pages) {
    for (const line of page.text.split(/\r?\n|\r/)) {
      const title = line.trim()
      if (!subordinateHeading.test(normalizeOutlineText(title))) continue
      const possibleChunks = chunks.filter((chunk) => chunk.pageStart <= page.page && chunk.pageEnd >= page.page)
      const found = possibleChunks.map((chunk) => ({ chunk, offset: chunk.text.indexOf(title) })).find((entry) => entry.offset >= 0)
      const candidates = sections.filter((section) => section.chunkStartIndex <= (found?.chunk.index ?? possibleChunks[0]?.index ?? Number.MAX_SAFE_INTEGER)
        && section.chunkEndIndex >= (found?.chunk.index ?? possibleChunks[0]?.index ?? -1)
        && (!found || section.chunkStartIndex !== found.chunk.index || (section.startCharOffset ?? 0) <= found.offset))
      const section = candidates.sort((a, b) => b.chunkStartIndex - a.chunkStartIndex || (b.startCharOffset ?? 0) - (a.startCharOffset ?? 0))[0]
      if (!section) continue
      const key = section.order + ':' + page.page + ':' + normalizeHeading(title)
      if (seen.has(key)) continue
      seen.add(key)
      markers.push({ sectionOrder: section.order, title, page: page.page, chunkIndex: found?.chunk.index ?? possibleChunks[0]?.index ?? section.chunkStartIndex, charOffset: found?.offset ?? null })
    }
  }
  return markers.slice(0, 250)
}

async function originalBookPages(bookId: string): Promise<ExtractedBookPage[]> {
  const book = await db.book.findUnique({ where: { id: bookId }, select: { data: true, storageProvider: true, storageKey: true, fileUrl: true, mimeType: true } })
  if (!book) throw new Error('BOOK_NOT_FOUND')
  const stored = await getFileBufferFromStorageOrBase64({ provider: book.storageProvider, key: book.storageKey, url: book.fileUrl, data: book.data, mimeType: book.mimeType })
  if (!stored?.buffer?.length || stored.buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('BOOK_ORIGINAL_PDF_REQUIRED')
  const pdf = await PDFDocument.load(stored.buffer)
  const count = pdf.getPageCount()
  if (count > 500) throw new Error('BOOK_REINDEX_MAX_500_PAGES')
  const pages: ExtractedBookPage[] = []
  for (let start = 1; start <= count; start += 16) {
    const numbers = Array.from({ length: Math.min(16, count - start + 1) }, (_, i) => start + i)
    const extracted = await extractNumberedPdfPages(stored.buffer, numbers)
    pages.push(...extracted.map((page) => ({ ...page, text: fixArabicPdfText(page.text) })))
  }
  const ocrBatches = pagesNeedingOcr(pages)
  const ocrCount = ocrBatches.reduce((total, batch) => total + batch.length, 0)
  // A synchronous Vercel request cannot safely run large-book OCR. Do not
  // persist an incomplete outline while claiming the scanned pages were read.
  if (ocrCount > 8) throw new Error('BOOK_OUTLINE_OCR_TOO_MANY_PAGES: الكتاب يحتوي ' + ocrCount + ' صفحة ممسوحة ضوئياً تحتاج OCR. لا يمكن إتمامها بأمان في طلب واحد؛ استخدم مهمة قراءة الكتاب المرحلية قبل إعادة الفهرسة. لم يُحفظ أي فهرس ناقص.')
  for (const batch of ocrBatches) {
    const scanned = await transcribeScannedDocumentWithVision(stored.buffer, batch, Date.now() + 100_000)
    for (const page of scanned) {
      const at = pages.findIndex((existing) => existing.page === page.page)
      if (at < 0 || !page.text.trim()) throw new Error('BOOK_OUTLINE_OCR_EMPTY_PAGE_' + page.page)
      pages[at] = page
    }
  }
  return pages
}

export function sourceBoundariesFromReadChunks(chunks: readonly Chunk[], bookTitle: string): Boundary[] {
  // Reading has already extracted/OCRed this content. Never open the PDF again.
  // Use one synthetic page per chunk only to apply the existing document-wide
  // repeated-header and conservative article title filters.
  const pages: ExtractedBookPage[] = chunks.map((chunk) => ({ page: chunk.index + 1, text: chunk.text, textProvenance: 'NATIVE_TEXT' }))
  const headings = detectOriginalSourceHeadings(pages, bookTitle)
  const results: Boundary[] = []
  const seen = new Set<string>()
  for (const heading of headings) {
    const chunk = chunks[heading.page - 1]
    if (!chunk) continue
    const offset = chunk.text.indexOf(heading.rawLine)
    if (offset < 0) continue
    const key = chunk.index + ':' + offset
    if (seen.has(key)) continue
    seen.add(key)
    results.push({ at: chunk.index, title: heading.title, startCharOffset: offset || null, verifiedHeading: true })
  }
  return results.slice(0, 100)
}

export function parseAiOutlineBoundaries(raw: string, chunks: readonly Chunk[], bookTitle: string): Boundary[] {
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim())
  const existing = new Set(chunks.map((chunk) => chunk.index))
  const seen = new Set<number>()
  const boundaries: Boundary[] = []
  for (const entry of Array.isArray(parsed?.sections) ? parsed.sections : []) {
    const at = entry?.at
    const title = clean(entry?.title, 140)
    if (!Number.isInteger(at) || !existing.has(at) || seen.has(at) || !usableOutlineTitle(title, bookTitle)) continue
    seen.add(at)
    boundaries.push({ at, title, startCharOffset: null })
    if (boundaries.length >= 16) break
  }
  // Reject a synthetic/generic outline; keep the previous saved draft unchanged.
  if (boundaries.length < Math.min(2, chunks.length)) throw new Error('BOOK_OUTLINE_INSUFFICIENT_GROUNDED_SECTIONS')
  return boundaries.sort((a, b) => a.at - b.at)
}

export async function buildBookOutline(bookId: string, options: { reuseReadChunks?: boolean; deterministicOnly?: boolean } = {}) {
  const book = await db.book.findUnique({ where: { id: bookId }, select: { id: true, semester: true, title: true } })
  if (!book) throw new Error('BOOK_NOT_FOUND')
  const [chunks, items] = await Promise.all([
    db.bookChunk.findMany({ where: { bookId }, orderBy: { index: 'asc' }, select: { id: true, index: true, headingPath: true, text: true, pageStart: true, pageEnd: true } }),
    db.bookKnowledgeItem.findMany({ where: { bookId, kbVersion: 2, chunkId: { not: null } }, select: { chunkId: true, title: true, summary: true } }),
  ])
  if (!chunks.length) throw new Error('BOOK_CHUNKS_REQUIRED')
  if (!items.length) throw new Error('BOOK_V2_KNOWLEDGE_REQUIRED')
  const chunkIds = new Map(chunks.map((chunk) => [chunk.index, chunk.id]))
  // Prefer original PDF line boundaries, but keep the old chunks/AI outline
  // path available for books whose original PDF is no longer stored.
  let sourceBoundaries: Boundary[] = []
  let sourcePages: ExtractedBookPage[] = []
  let missingOriginalPdf = false
  if (options.reuseReadChunks) {
    sourceBoundaries = sourceBoundariesFromReadChunks(chunks, book.title)
    // OCR text already lives in the stored chunks; do not read the PDF a second time.
    sourcePages = chunks.map((chunk) => ({ page: chunk.pageStart, text: chunk.text, textProvenance: 'NATIVE_TEXT' as const }))
  } else {
    try {
      sourcePages = await originalBookPages(bookId)
      sourceBoundaries = projectSourceHeadings(detectOriginalSourceHeadings(sourcePages, book.title), chunks)
    } catch (error: unknown) {
      if (!(error instanceof Error) || error.message !== 'BOOK_ORIGINAL_PDF_REQUIRED') throw error
      missingOriginalPdf = true
    }
  }
  let draft = planBookOutline(chunks, items, chunkIds, book.semester, sourceBoundaries, book.title, options.reuseReadChunks === true)
  if (draft.source === 'AI_SEGMENTED' && !options.deterministicOnly) {
    const byChunk = new Map<string, Item[]>()
    for (const item of items) if (item.chunkId) byChunk.set(item.chunkId, [...(byChunk.get(item.chunkId) || []), item])
    const evidence = chunks.map((chunk) => ({
      index: chunk.index,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      excerpt: chunk.text.slice(0, 350),
      items: (byChunk.get(chunk.id) || []).slice(0, 8).map((item) => ({ title: item.title.slice(0, 100), summary: item.summary.slice(0, 180) })),
    }))
    const raw = await geminiCompleteJson({ system: 'قسّم الكتاب إلى أقسام موضوعية متتابعة اعتماداً حصراً على مقتطفات النص المحفوظ وعناوين وملخصات المعرفة. احترم ترتيب الصفحات، ولا تخترع فصولاً لم تظهر في الأدلة. امنع العناوين العامة مثل مقدمة الكتاب أو تابع أو عنوان الكتاب المكرر. أرجع JSON فقط.', history: [{ role: 'user', text: `اقترح من 2 إلى 16 بداية قسم (أو قسماً واحداً إذا كان هناك مقطع واحد) بعناوين موضوعية محددة مستندة إلى الأدلة، بصيغة {"sections":[{"at":0,"title":"عنوان موضوعي"}]}. استخدم index من البيانات فقط، ورتّب الأقسام وفق ظهورها في النص. البيانات: ${JSON.stringify(evidence)}` }], taskLevel: 'ACADEMIC_DRAFT', temperature: 0.1, maxOutputTokens: 3000, deadlineMs: Date.now() + 180_000 })
    const boundaries = parseAiOutlineBoundaries(raw, chunks, book.title)
    draft = { ...planBookOutline(chunks, items, chunkIds, book.semester, boundaries, book.title), source: 'AI_SEGMENTED' }
    draft.warnings.push('هذه عناوين موضوعية مقترحة من نص الكتاب والمعرفة المستخرجة؛ راجعها قبل الاعتماد.')
  }
  if (draft.source === 'AI_SEGMENTED' && options.deterministicOnly) {
    // Never persist synthetic "intro — continued" sections as a real outline.
    throw new Error('BOOK_OUTLINE_INSUFFICIENT_GROUNDED_SECTIONS')
  }
  if (options.reuseReadChunks && options.deterministicOnly) {
    draft.warnings.push('أُنشئت المسودة من المقاطع المحفوظة بعد القراءة وOCR دون إعادة فتح ملف الكتاب.')
  }
  // Re-segment oversized ranges from their own evidence before judging the
  // draft; then audit coverage so any section that is still too large is
  // visibly flagged for the approval guard instead of passing silently.
  const refined = await refineOversizedSections({ sections: draft.sections, chunks, items, chunkIds, semester: book.semester, sourceBoundaries, bookTitle: book.title, allowAi: !options.deterministicOnly })
  draft = { ...draft, sections: refined.sections, warnings: [...draft.warnings, ...refined.warnings] }
  const coverage = auditOutlineCoverage(draft.sections)
  for (const section of coverage.review) draft.warnings.push(section.pages === null ? `تنبيه تغطية: حدود صفحات القسم «${section.title}» غير مكتملة؛ راجعها قبل الاعتماد.` : `تنبيه تغطية: القسم «${section.title}» يغطي ${section.pages} صفحة (صفحات ${section.pageStart}–${section.pageEnd}) — فوق حد المراجعة ${OUTLINE_SECTION_REVIEW_PAGES} صفحة؛ أعد فحص عناوين هذا النطاق قبل الاعتماد.`)
  for (const gap of coverage.gaps) draft.warnings.push(`تنبيه تغطية: هناك فجوة غير مغطاة من الصفحة ${gap.pageStart} إلى ${gap.pageEnd}؛ لن يُعتمد الفهرس قبل تصحيحها.`)
  for (const section of coverage.blocked) draft.warnings.push(`تنبيه تغطية: القسم «${section.title}» يغطي ${section.pages} صفحة (صفحات ${section.pageStart}–${section.pageEnd}) — يتجاوز حد ${OUTLINE_SECTION_BLOCK_PAGES} صفحة؛ لن يُعتمد الفهرس حتى يُقسَّم هذا النطاق أو يُسجَّل تجاوز مشرف موثّق.`)
  draft.warnings.push('OUTLINE_COVERAGE:' + JSON.stringify({ maxSectionPages: coverage.maxSectionPages, review: coverage.review.map((section) => section.order), blocked: coverage.blocked.map((section) => section.order) }))
  if (missingOriginalPdf) draft.warnings.push('ملف PDF الأصلي غير متاح؛ استُخدمت المقاطع المحفوظة لفهرسة هذا الكتاب. راجع حدود الأقسام قبل الاعتماد.')
  for (const marker of outlineSubheadingMarkers(sourcePages, chunks, draft.sections)) {
    draft.warnings.push('OUTLINE_SUBHEADING:' + JSON.stringify(marker))
  }
  const latest = await db.bookOutline.findFirst({ where: { bookId }, orderBy: { version: 'desc' }, select: { version: true } })
  return db.bookOutline.create({ data: { bookId, version: (latest?.version || 0) + 1, status: 'DRAFT', source: draft.source, warnings: JSON.stringify(draft.warnings), sections: { create: draft.sections } }, include: { sections: { orderBy: { order: 'asc' } } } })
}
