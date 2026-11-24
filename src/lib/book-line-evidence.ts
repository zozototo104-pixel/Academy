/**
 * Numbered-line evidence for book knowledge: the model picks a line range,
 * the server copies the excerpt verbatim from the saved chunk text.
 * Pure module — no database, no AI, no Prisma.
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
