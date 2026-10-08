import { inferTextProvenance, isEvidenceAllowedByProvenance, textContainsEvidenceAfterNormalization, type TextProvenance } from '@/lib/text-provenance'

type EvidenceItem = { kbVersion?: number; chunkId?: string | null; bookId?: string | null; excerpt?: string | null; sourceNote?: string | null; textProvenance?: string | null }
type SourceBook = { id: string; textContent?: string | null; linkReadNote?: string | null; linkReadStatus?: string | null }
type SourceChunk = { id: string; bookId: string; text: string }

export function resolveQuestionBankEvidence<T extends EvidenceItem>(items: T[], books: SourceBook[], chunks: SourceChunk[], evidenceText: (item: T) => string) {
  const bookById = new Map(books.map((book) => [book.id, book]))
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  const provenance = (item: T): TextProvenance => {
    if (item.kbVersion === 2 && item.chunkId) {
      return item.textProvenance === 'NATIVE_TEXT' || item.textProvenance === 'VISION_OCR'
        ? item.textProvenance : 'VISION_DESCRIPTION'
    }
    const book = item.bookId ? bookById.get(item.bookId) : null
    return inferTextProvenance({ sourceNote: item.sourceNote, linkReadNote: book?.linkReadNote, linkReadStatus: book?.linkReadStatus, textContent: book?.textContent })
  }
  const accepted = items.filter((item) => {
    const excerpt = evidenceText(item).trim()
    if (excerpt.length < 40 || !isEvidenceAllowedByProvenance(provenance(item))) return false
    if (item.kbVersion === 2 && item.chunkId) {
      const chunk = chunkById.get(item.chunkId)
      return !!chunk && chunk.bookId === item.bookId && textContainsEvidenceAfterNormalization(chunk.text, excerpt)
    }
    const book = item.bookId ? bookById.get(item.bookId) : null
    if (!book?.textContent) return false
    const bookProvenance = inferTextProvenance({ linkReadNote: book.linkReadNote, linkReadStatus: book.linkReadStatus, textContent: book.textContent })
    return (bookProvenance === 'NATIVE_TEXT' || bookProvenance === 'VISION_OCR') && textContainsEvidenceAfterNormalization(book.textContent, excerpt)
  })
  return { evidenceKnowledge: accepted, evidenceSources: accepted.map((item) => ({ text: evidenceText(item), textProvenance: provenance(item) })) }
}
