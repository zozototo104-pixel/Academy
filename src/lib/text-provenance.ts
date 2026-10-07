export type TextProvenance = 'NATIVE_TEXT' | 'VISION_OCR' | 'VISION_DESCRIPTION'

export const TEXT_PROVENANCE_MARKER = 'textProvenance'

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
  if (quality === 'GEMINI_DOCUMENT') return 'VISION_DESCRIPTION'
  if (quality === 'METADATA_ONLY' || quality === 'NO_CONTENT') return 'VISION_DESCRIPTION'
  return 'NATIVE_TEXT'
}

export function isEvidenceAllowedByProvenance(provenance: TextProvenance): boolean {
  return provenance !== 'VISION_DESCRIPTION'
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
