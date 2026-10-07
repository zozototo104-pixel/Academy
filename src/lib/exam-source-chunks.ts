import { inferTextProvenance, isEvidenceAllowedByProvenance, type TextProvenance } from './text-provenance'

export type ExamSourceText = {
  bookId: string
  bookTitle: string
  text: string
  contentQuality: string
  sourceNote?: string | null
  linkReadStatus?: string | null
  textProvenance?: TextProvenance | null
}

export type ExamSourceChunk = {
  sourceIndex: number
  bookId: string
  bookTitle: string
  text: string
  textProvenance: TextProvenance
}

function sourceProvenance(source: ExamSourceText): TextProvenance {
  return inferTextProvenance({
    explicit: source.textProvenance,
    sourceNote: source.sourceNote,
    linkReadStatus: source.linkReadStatus,
    contentQuality: source.contentQuality,
  })
}

function isOriginalSource(source: ExamSourceText): boolean {
  const provenance = sourceProvenance(source)
  if (!isEvidenceAllowedByProvenance(provenance)) return false
  if (source.contentQuality === 'UPLOADED_FILE' || source.contentQuality === 'LINK_TEXT') return true
  if (source.contentQuality !== 'STORED_TEXT') return false
  return ['TEXT_EXTRACTED', 'FILE_EXTRACTED'].includes(String(source.linkReadStatus || '').toUpperCase()) || provenance === 'VISION_OCR'
}

function findSafeCut(text: string, maxChars: number): number {
  if (text.length <= maxChars) return text.length
  const window = text.slice(0, maxChars + 1)
  const sentence = Math.max(
    window.lastIndexOf('.'), window.lastIndexOf('؟'), window.lastIndexOf('!'),
    window.lastIndexOf('؛'), window.lastIndexOf('\n')
  )
  if (sentence >= 40) return sentence + 1
  const space = window.lastIndexOf(' ')
  if (space >= 40) return space
  const nextSpace = text.indexOf(' ', maxChars)
  return nextSpace > 0 ? nextSpace : text.length
}

function splitLongText(text: string, maxChars: number): string[] {
  const chunks: string[] = []
  let remaining = text.trim()
  while (remaining.length > maxChars) {
    const cut = findSafeCut(remaining, maxChars)
    const part = remaining.slice(0, cut).trim()
    if (part.length >= 40) chunks.push(part)
    remaining = remaining.slice(cut).trim()
  }
  if (remaining.length >= 40) chunks.push(remaining)
  return chunks
}

function splitSourceText(text: string, maxChars: number): string[] {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''

  const flush = () => {
    const value = current.trim()
    if (value.length >= 40) chunks.push(...splitLongText(value, maxChars))
    current = ''
  }

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length > maxChars && current) flush()
    if (paragraph.length > maxChars) {
      flush()
      chunks.push(...splitLongText(paragraph, maxChars))
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph
    }
  }
  flush()
  return chunks
}

export function buildExamSourceChunks(sources: readonly ExamSourceText[], maxChars = 1800): ExamSourceChunk[] {
  const chunks: Omit<ExamSourceChunk, 'sourceIndex'>[] = []
  for (const source of sources) {
    if (!isOriginalSource(source)) continue
    for (const text of splitSourceText(source.text, maxChars)) {
      chunks.push({ bookId: source.bookId, bookTitle: source.bookTitle, text })
    }
  }
  return chunks.map((chunk, index) => ({ sourceIndex: index + 1, ...chunk }))
}

export function selectExamSourceChunks(
  chunks: readonly ExamSourceChunk[],
  options: { maxChunks?: number; maxTotalChars?: number } = {}
): ExamSourceChunk[] {
  const maxChunks = Math.max(1, options.maxChunks ?? 12)
  const maxTotalChars = Math.max(40, options.maxTotalChars ?? 18000)
  if (!chunks.length) return []

  const targetCount = Math.min(maxChunks, chunks.length)
  const candidateIndexes = Array.from({ length: targetCount }, (_, i) =>
    targetCount === 1 ? 0 : Math.round(i * (chunks.length - 1) / (targetCount - 1))
  )
  const selected: ExamSourceChunk[] = []
  let totalChars = 0
  for (const index of candidateIndexes) {
    const chunk = chunks[index]
    if (!chunk || totalChars + chunk.text.length > maxTotalChars) continue
    selected.push(chunk)
    totalChars += chunk.text.length
  }
  return selected.map((chunk, index) => ({ ...chunk, sourceIndex: index + 1 }))
}
