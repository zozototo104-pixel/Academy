import { normalizeArabic } from './arabic-normalize'

export type LiteralEvidenceResult =
  | { ok: true; matchedAt: number }
  | { ok: false; reason: 'TOO_SHORT' | 'NOT_FOUND' | 'EMPTY' }

export function validateLiteralEvidence({
  evidence,
  sourceText,
  minChars = 40,
}: {
  evidence: unknown
  sourceText: unknown
  minChars?: number
}): LiteralEvidenceResult {
  const normalizedEvidence = normalizeArabic(evidence)
  const normalizedSource = normalizeArabic(sourceText)

  if (!normalizedEvidence || !normalizedSource) return { ok: false, reason: 'EMPTY' }
  if (normalizedEvidence.length < minChars) return { ok: false, reason: 'TOO_SHORT' }

  const matchedAt = normalizedSource.indexOf(normalizedEvidence)
  return matchedAt >= 0 ? { ok: true, matchedAt } : { ok: false, reason: 'NOT_FOUND' }
}

export function sourceTextAtOneBasedIndex<T>(
  sources: readonly T[],
  sourceIndex: number | string,
  getText: (source: T) => unknown
): string | null {
  const n = typeof sourceIndex === 'string' ? Number(sourceIndex.trim()) : sourceIndex
  if (!Number.isInteger(n) || n < 1 || n > sources.length) return null
  return String(getText(sources[n - 1]) ?? '')
}
