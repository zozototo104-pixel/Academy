export type AdmissionDocumentReplacementRequest = {
  note: string
  docTypes: string[]
  previousStatus: string
  requestedAt: string
  requestedById?: string | null
  requestedByName?: string | null
}

const START_MARKER = '---AACT_DOCUMENT_REPLACEMENT_REQUEST---'
const END_MARKER = '---END_AACT_DOCUMENT_REPLACEMENT_REQUEST---'
const BLOCK_RE = /\n*---AACT_DOCUMENT_REPLACEMENT_REQUEST---\n([\s\S]*?)\n---END_AACT_DOCUMENT_REPLACEMENT_REQUEST---\n*/g

function cleanDocTypes(docTypes: unknown): string[] {
  if (!Array.isArray(docTypes)) return []
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const item of docTypes) {
    const value = String(item || '').trim().replace(/^doc_/, '').toUpperCase().slice(0, 40)
    if (!value || seen.has(value)) continue
    seen.add(value)
    cleaned.push(value)
  }
  return cleaned
}

export function extractAdmissionDocumentReplacement(notes?: string | null): AdmissionDocumentReplacementRequest | null {
  if (!notes) return null
  const re = new RegExp(BLOCK_RE.source, 'g')
  let match: RegExpExecArray | null = null
  let last: RegExpExecArray | null = null
  while ((match = re.exec(notes))) last = match
  if (!last) return null
  try {
    const parsed = JSON.parse(last[1]) as Partial<AdmissionDocumentReplacementRequest>
    const note = String(parsed.note || '').trim()
    const previousStatus = String(parsed.previousStatus || 'UNDER_REVIEW').trim() || 'UNDER_REVIEW'
    const requestedAt = String(parsed.requestedAt || new Date().toISOString())
    return {
      note,
      docTypes: cleanDocTypes(parsed.docTypes),
      previousStatus,
      requestedAt,
      requestedById: parsed.requestedById ? String(parsed.requestedById) : null,
      requestedByName: parsed.requestedByName ? String(parsed.requestedByName) : null,
    }
  } catch {
    return null
  }
}

export function stripAdmissionDocumentReplacement(notes?: string | null): string | null {
  if (!notes) return null
  const cleaned = notes.replace(BLOCK_RE, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return cleaned || null
}

export function appendAdmissionDocumentReplacement(
  notes: string | null | undefined,
  request: Omit<AdmissionDocumentReplacementRequest, 'docTypes' | 'requestedAt'> & { docTypes?: unknown[]; requestedAt?: string }
): string {
  const base = stripAdmissionDocumentReplacement(notes)
  const payload: AdmissionDocumentReplacementRequest = {
    note: String(request.note || '').trim(),
    docTypes: cleanDocTypes(request.docTypes || []),
    previousStatus: String(request.previousStatus || 'UNDER_REVIEW'),
    requestedAt: request.requestedAt || new Date().toISOString(),
    requestedById: request.requestedById || null,
    requestedByName: request.requestedByName || null,
  }
  const block = `${START_MARKER}\n${JSON.stringify(payload)}\n${END_MARKER}`
  return [base, block].filter(Boolean).join('\n\n')
}
