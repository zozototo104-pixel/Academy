export type ExamSourceText = {
  bookId: string
  bookTitle: string
  text: string
  contentQuality: string
  sourceNote?: string | null
}

export type ExamSourceChunk = {
  sourceIndex: number
  bookId: string
  bookTitle: string
  text: string
}

function isOriginalSource(source: ExamSourceText): boolean {
  if (source.contentQuality === 'GEMINI_DOCUMENT' || source.contentQuality === 'METADATA_ONLY') return false
  if (source.contentQuality === 'STORED_TEXT' && /خريطة معرفة|knowledge map|generated|vision/i.test(String(source.sourceNote || ''))) return false
  return ['UPLOADED_FILE', 'LINK_TEXT', 'STORED_TEXT'].includes(source.contentQuality)
}

function splitSourceText(text: string, maxChars: number): string[] {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) return []
  const paragraphs = normalized.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
  const chunks: string[] = []
  let current = ''

  const flush = () => {
    const value = current.trim()
    if (value.length >= 40) chunks.push(value)
    current = ''
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush()
      for (let start = 0; start < paragraph.length; start += maxChars) {
        const part = paragraph.slice(start, start + maxChars).trim()
        if (part.length >= 40) chunks.push(part)
      }
      continue
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length > maxChars) flush()
    current = current ? `${current}\n\n${paragraph}` : paragraph
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
