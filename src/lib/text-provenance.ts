export type TextProvenance = 'NATIVE_TEXT' | 'VISION_OCR' | 'VISION_DESCRIPTION'

export const TEXT_PROVENANCE_MARKER = 'textProvenance'

function normalized(value: unknown): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function looksLikeGeneratedStudyScaffold(text: unknown): boolean {
  const n = normalized(String(text || '').slice(0, 12000))
  const markers = [
    'خريطه امتحانيه', 'خريطه معرفيه', 'ملخص معرفي طويل', 'بناء الامتحان والمشرف الذكي',
    'صالح لبناء الامتحان', 'بذور اسئله', 'نقاط قابله للسؤال', 'خطة معرفة منهجية', 'خطة معرفه منهجيه',
    'لا تعامل كاقتباس حرفي', 'لا تعامل كاقتباس', 'توصيف الكتاب والبرنامج', 'عند غياب النص المباشر',
    'محور دراسي منظم', 'محور اكاديمي منظم', 'خريطة اولية لاستخدام كتاب', 'الفكرة المحورية هي تحويل موضوع الكتاب',
  ].map(normalized)
  return markers.filter((marker) => n.includes(marker)).length >= 2
}

function upper(value: unknown): string {
  return String(value || '').trim().toUpperCase()
}

export function provenanceMarker(provenance: TextProvenance): string {
  return `[${TEXT_PROVENANCE_MARKER}:${provenance}]`
}

export function parseTextProvenance(value: unknown): TextProvenance | null {
  const text = String(value || '')
  const marker = text.match(/\[textProvenance:(NATIVE_TEXT|VISION_OCR|VISION_DESCRIPTION)\]/i)?.[1]
  if (marker) return marker.toUpperCase() as TextProvenance
  try {
    const parsed = JSON.parse(text)
    const raw = parsed?.textProvenance || parsed?.provenance?.textProvenance || parsed?.source?.textProvenance
    const normalized = upper(raw)
    if (normalized === 'NATIVE_TEXT' || normalized === 'VISION_OCR' || normalized === 'VISION_DESCRIPTION') return normalized
  } catch {
    // Non-JSON notes are allowed; fall back to marker/status inference.
  }
  return null
}

export function appendTextProvenanceNote(note: unknown, provenance: TextProvenance): string {
  const base = String(note || '').trim()
  const withoutOld = base.replace(/\s*\[textProvenance:(?:NATIVE_TEXT|VISION_OCR|VISION_DESCRIPTION)\]/ig, '').trim()
  return `${withoutOld}${withoutOld ? ' ' : ''}${provenanceMarker(provenance)}`.trim()
}

export function inferTextProvenance(input: {
  explicit?: unknown
  sourceNote?: unknown
  linkReadNote?: unknown
  linkReadStatus?: unknown
  contentQuality?: unknown
  reader?: unknown
  textContent?: unknown
} = {}): TextProvenance {
  const explicit = parseTextProvenance(input.explicit) || parseTextProvenance(input.sourceNote) || parseTextProvenance(input.linkReadNote)
  if (explicit) return explicit

  const status = upper(input.linkReadStatus)
  const quality = upper(input.contentQuality)
  const reader = upper(input.reader)

  // Legacy rule: old records whose status names clearly indicate Vision/OCR are OCR-derived,
  // otherwise previously extracted stored text remains native unless explicitly marked.
  if (/VISION|OCR|SCANNED|IMAGE/.test(status)) return 'VISION_OCR'
  if (/VISION|OCR|SCANNED|IMAGE/.test(reader)) return 'VISION_OCR'
  const note = normalized(`${input.linkReadNote || ''} ${input.sourceNote || ''}`)
  if (quality === 'STORED_TEXT' && /(gemini|تلخيص|خريطه|خريطة|ملخص|vision)/i.test(note)) return 'VISION_DESCRIPTION'
  if (quality === 'GEMINI_DOCUMENT') return 'VISION_DESCRIPTION'
  if (quality === 'METADATA_ONLY' || quality === 'NO_CONTENT') return 'VISION_DESCRIPTION'
  if (looksLikeGeneratedStudyScaffold(input.textContent)) return 'VISION_DESCRIPTION'
  return 'NATIVE_TEXT'
}

export function isEvidenceAllowedByProvenance(provenance: TextProvenance): boolean {
  return provenance !== 'VISION_DESCRIPTION'
}

export function textContainsEvidenceAfterNormalization(text: unknown, evidence: unknown): boolean {
  const source = normalized(text)
  const quote = normalized(evidence)
  return quote.length >= 40 && source.includes(quote)
}

export function applyOcrDerivedFlags(flags: readonly string[] = [], provenance?: TextProvenance): string[] {
  const out = new Set<string>()
  const source = flags.length ? flags : ['SOURCE_LINKED', 'NEEDS_HUMAN_REVIEW']
  for (const flag of source) {
    const value = String(flag || '').trim()
    if (!value || (provenance === 'VISION_OCR' && value === 'SOURCE_GROUNDED')) continue
    out.add(value)
  }
  if (provenance === 'VISION_OCR') {
    out.add('SOURCE_LINKED')
    out.add('OCR_DERIVED_SOURCE')
    out.add('NEEDS_HUMAN_REVIEW')
  }
  return Array.from(out)
}

/**
 * Evidence is chosen by line numbers, then copied verbatim from the saved chunk.
 * This module intentionally has no database or AI dependencies.
 */
export const MAX_BOOK_EVIDENCE_LINES = 6

export type BookLineEvidenceResult =
  | { ok: true; excerpt: string }
  | { ok: false; reason: 'INVALID_LINE_RANGE' | 'EVIDENCE_TOO_SHORT' }

export function formatNumberedBookLines(chunkText: string): string {
  return String(chunkText || '').split('\n').map((line, index) => `${index + 1} | ${line}`).join('\n')
}

function lineNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return NaN
}

export function resolveBookLineEvidence(chunkText: string, lineStart: unknown, lineEnd: unknown): BookLineEvidenceResult {
  const lines = String(chunkText || '').split('\n')
  const first = lineNumber(lineStart)
  const last = lineNumber(lineEnd)
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first ||
      last > lines.length || last - first + 1 > MAX_BOOK_EVIDENCE_LINES) {
    return { ok: false, reason: 'INVALID_LINE_RANGE' }
  }
  const excerpt = lines.slice(first - 1, last).join('\n')
  if (excerpt.trim().length < 60) return { ok: false, reason: 'EVIDENCE_TOO_SHORT' }
  return { ok: true, excerpt }
}
