import { createHash } from 'node:crypto'

export type ExtractedBookPage = { page: number; text: string; textProvenance: 'NATIVE_TEXT' | 'VISION_OCR' }
export type PlannedBookChunk = { index: number; pageStart: number; pageEnd: number; headingPath: string | null; text: string; charCount: number; textProvenance: 'NATIVE_TEXT' | 'VISION_OCR'; contentHash: string }

export function pagesNeedingOcr(pages: readonly { page: number; text: string }[]): number[][] {
  const missing = pages.filter((page) => page.text.trim().length < 80).map((page) => page.page)
  const batches: number[][] = []
  for (let i = 0; i < missing.length; i += 8) batches.push(missing.slice(i, i + 8))
  return batches
}

export function nextExtractionPage(pagesDone: number, totalPages: number): number | null {
  return pagesDone < totalPages ? pagesDone + 1 : null
}

function heading(text: string): string | null {
  return text.split('\n').map((line) => line.trim()).find((line) => /^(?:الفصل|الباب|المبحث|المطلب|Chapter|Part)\s+\S+/i.test(line))?.slice(0, 240) || null
}

export function planBookChunks(pages: readonly ExtractedBookPage[], minChars = 2500, maxChars = 4000): PlannedBookChunk[] {
  const chunks: PlannedBookChunk[] = []
  let text = ''
  let start = 0
  let end = 0
  let provenance: 'NATIVE_TEXT' | 'VISION_OCR' = 'NATIVE_TEXT'
  let headingPath: string | null = null
  const flush = () => {
    if (!text.trim()) return
    const value = text.trim()
    chunks.push({ index: chunks.length, pageStart: start, pageEnd: end, headingPath, text: value, charCount: value.length, textProvenance: provenance, contentHash: createHash('sha256').update(value).digest('hex') })
    text = ''
  }
  for (const page of pages) {
    const sentences = page.text.match(/[^.!؟。\n]+(?:[.!؟。]+|$)/gu) || []
    for (const sentence of sentences) {
      const part = sentence.trim()
      if (!part) continue
      if (text && (text.length + part.length + 1 > maxChars || provenance !== page.textProvenance) && text.length >= minChars) flush()
      if (!text) { start = page.page; provenance = page.textProvenance; headingPath = heading(page.text) }
      end = page.page
      text += (text ? ' ' : '') + part
      if (text.length >= maxChars) flush()
    }
  }
  flush()
  return chunks
}
