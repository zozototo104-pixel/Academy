// Pure scan + repair helpers for garbled book knowledge items.
//
// No DB, no network, no AI: every correction is either a deterministic
// cleanAcademicOutput rule-repair or a verbatim span sliced from the
// caller-supplied corrected source text. Nothing is paraphrased and no new
// concept is introduced.
import {
  cleanAcademicOutput,
  looksLikeBrokenBookPageText,
  looksLikeBrokenGeneratedArabic,
  planKnowledgeItemCleanup,
} from '@/lib/academic-output-quality'
import { looksLikeBrokenAcademicOutput, looksLikeBrokenExcerpt } from '@/lib/knowledge-bank'
import { conceptTokens } from '@/lib/book-chunk-analyzer'
import { textContainsEvidenceAfterNormalization } from '@/lib/text-provenance'
import { cleanOutlineUnitText, firstSentence } from '@/lib/outline-units'

export type BookRepairChunk = { id: string; index: number; text: string }
export type BookRepairItem = {
  id: string
  chunkId: string
  title: string
  summary: string
  excerpt: string
}
export type CorrectKnowledgeItemInput = {
  id: string
  title: string
  summary: string
  excerpt: string
  pageStart?: number | null
  pageEnd?: number | null
}
export type GuideItemInput = {
  title: string
  summary: string
  excerpt: string
  pageStart?: number | null
  pageEnd?: number | null
}
export type CorrectKnowledgeItemResult =
  | { status: 'CORRECTED'; data: { title: string; summary: string; excerpt: string } }
  | {
      status: 'REVIEW'
      reason:
        | 'TITLE_UNPROVABLE'
        | 'SUMMARY_UNPROVABLE'
        | 'EXCERPT_NO_SUPPORTING_SPAN'
        | 'STILL_BROKEN_AFTER_CLEAN'
    }

// A chunk is distorted iff its non-empty text fails the page garble gate.
// Empty-text chunks are holes, handled elsewhere — never distortion.
export function scanBookDistortion(
  chunks: BookRepairChunk[],
  items: BookRepairItem[],
): {
  distortedChunkIds: string[]
  distortedItemIds: string[]
  healthyChunks: number
  healthyItems: number
} {
  const distortedChunkIds = chunks
    .filter((chunk) => chunk.text.trim() !== '' && looksLikeBrokenBookPageText(chunk.text))
    .map((chunk) => chunk.id)
  // The review-queue plan checks title AND summary AND excerpt, not the
  // excerpt alone: an item is distorted iff the plan says REVIEW.
  const distortedItemIds = items
    .filter(
      (item) =>
        planKnowledgeItemCleanup(item, looksLikeBrokenAcademicOutput, looksLikeBrokenExcerpt)
          .action === 'REVIEW',
    )
    .map((item) => item.id)
  return {
    distortedChunkIds,
    distortedItemIds,
    healthyChunks: chunks.length - distortedChunkIds.length,
    healthyItems: items.length - distortedItemIds.length,
  }
}

const EXCERPT_MIN_CHARS = 60
const EXCERPT_MAX_CHARS = 600
const MIN_EXCERPT_COVERAGE = 0.5
const MIN_EXCERPT_SHARED_TOKENS = 3

// Repair one generated field (title or summary) from the corrected source.
// A healthy field is kept as-is. A broken field is accepted only after a
// deterministic rule-repair that is no longer broken AND whose every content
// token (longer than 1 char, via conceptTokens) appears in the source text.
// Returns null when the field cannot be proven — the caller turns that into REVIEW.
function repairFieldFromSource(value: string, sourceTokens: Set<string>): string | null {
  if (!looksLikeBrokenGeneratedArabic(value)) return value
  const candidate = cleanAcademicOutput(value)
  if (!candidate || looksLikeBrokenGeneratedArabic(candidate)) return null
  const tokens = conceptTokens(candidate)
  if (tokens.size === 0) return null
  for (const token of tokens) if (!sourceTokens.has(token)) return null
  return candidate
}

// Best verbatim span of the corrected text supporting the item's concepts.
// Sentences only (60–600 chars, garble-free); scored by concept-token
// coverage against the item's title + summary. Null unless the best span
// clears the coverage floor, shares at least 3 tokens, and is provably
// verbatim in the corrected text.
function bestSupportingSpan(correctedChunkText: string, concepts: Set<string>): string | null {
  if (concepts.size === 0) return null
  let best: { span: string; coverage: number; shared: number } | null = null
  for (const rawSpan of correctedChunkText.split(/[.!؟\r\n]+/)) {
    const span = rawSpan.trim()
    if (span.length < EXCERPT_MIN_CHARS || span.length > EXCERPT_MAX_CHARS) continue
    if (looksLikeBrokenBookPageText(span) || looksLikeBrokenGeneratedArabic(span)) continue
    const spanTokens = conceptTokens(span)
    let shared = 0
    for (const token of spanTokens) if (concepts.has(token)) shared++
    const coverage = shared / concepts.size
    if (
      !best ||
      coverage > best.coverage ||
      (coverage === best.coverage && shared > best.shared)
    ) {
      best = { span, coverage, shared }
    }
  }
  if (!best || best.coverage < MIN_EXCERPT_COVERAGE || best.shared < MIN_EXCERPT_SHARED_TOKENS) {
    return null
  }
  if (!textContainsEvidenceAfterNormalization(correctedChunkText, best.span)) return null
  return best.span
}

// Correct one knowledge item from its chunk's re-read (corrected) text.
// All-or-nothing: if ANY field cannot be proven, nothing changes and the
// item goes to REVIEW with a short reason code.
export function correctKnowledgeItemFromSource(
  item: CorrectKnowledgeItemInput,
  correctedChunkText: string,
): CorrectKnowledgeItemResult {
  const sourceTokens = conceptTokens(correctedChunkText)
  const title = repairFieldFromSource(item.title, sourceTokens)
  if (title === null) return { status: 'REVIEW', reason: 'TITLE_UNPROVABLE' }
  const summary = repairFieldFromSource(item.summary, sourceTokens)
  if (summary === null) return { status: 'REVIEW', reason: 'SUMMARY_UNPROVABLE' }
  let excerpt = item.excerpt ?? ''
  const excerptUsable =
    excerpt.trim() !== '' &&
    !looksLikeBrokenExcerpt(excerpt) &&
    textContainsEvidenceAfterNormalization(correctedChunkText, excerpt)
  if (!excerptUsable) {
    const span = bestSupportingSpan(correctedChunkText, conceptTokens(`${title} ${summary}`))
    if (span === null) return { status: 'REVIEW', reason: 'EXCERPT_NO_SUPPORTING_SPAN' }
    excerpt = span
  }
  const data = { title, summary, excerpt }
  if (
    planKnowledgeItemCleanup(data, looksLikeBrokenAcademicOutput, looksLikeBrokenExcerpt)
      .action !== 'KEEP'
  ) {
    return { status: 'REVIEW', reason: 'STILL_BROKEN_AFTER_CLEAN' }
  }
  return { status: 'CORRECTED', data }
}

// Mirrors the private pageRef in outline-units.ts (not exported there):
// no pages -> '', different pages -> 'صفحات X–Y', otherwise 'صفحة X'.
function pageRef(pageStart?: number | null, pageEnd?: number | null): string {
  if (!pageStart && !pageEnd) return ''
  if (pageStart && pageEnd && pageStart !== pageEnd) return `صفحات ${pageStart}–${pageEnd}`
  return `صفحة ${pageStart || pageEnd}`
}

// Exactly the guide keyTerm formula (buildUnitStudyGuideDraft).
export function buildKeyTermForItem(item: GuideItemInput): string {
  const definition = firstSentence(item.excerpt || item.summary, 220)
  const pages = pageRef(item.pageStart, item.pageEnd)
  return `${cleanOutlineUnitText(item.title, 90)}: ${definition}${pages ? ` (${pages})` : ''}`
}

// Exactly the guide section-summary formula (buildUnitStudyGuideDraft).
export function buildSectionSummaryForItem(item: GuideItemInput): string {
  const pages = pageRef(item.pageStart, item.pageEnd)
  return `${cleanOutlineUnitText(item.summary || item.excerpt, 900)}${pages ? ` — مرجع الصفحات: ${pages}.` : ''}`
}

// Replace the quoted excerpt inside a larger text (a guide or a question),
// touching nothing else. Full verbatim match first; otherwise the first
// sentence of the old excerpt (when it is at least 60 chars, the way the
// guide quotes it). The replacement mirrors the matched form: full new
// excerpt for a full match, its first sentence (same 60-char rule, falling
// back to the full text) for a first-sentence match. Only the first
// occurrence is replaced.
export function replaceQuotedExcerpt(
  text: string,
  oldExcerpt: string,
  newExcerpt: string,
): { text: string; replaced: boolean } {
  if (oldExcerpt && text.includes(oldExcerpt)) {
    const at = text.indexOf(oldExcerpt)
    return {
      text: text.slice(0, at) + newExcerpt + text.slice(at + oldExcerpt.length),
      replaced: true,
    }
  }
  const oldFirst = firstSentence(oldExcerpt, 220)
  if (oldFirst.length >= 60 && text.includes(oldFirst)) {
    const newFirst = firstSentence(newExcerpt, 220)
    const replacement = newFirst.length >= 60 ? newFirst : newExcerpt
    const at = text.indexOf(oldFirst)
    return {
      text: text.slice(0, at) + replacement + text.slice(at + oldFirst.length),
      replaced: true,
    }
  }
  return { text, replaced: false }
}
