import assert from 'node:assert/strict'
import { nextExtractionPage, pagesNeedingOcr, planBookChunks, extractPdfBatch, extractNumberedPdfPages } from '../src/lib/book-reader'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { isRepeatedBookConcept, validateBookKnowledgeCandidate } from '../src/lib/book-chunk-analyzer'

const pages = [{ page: 1, text: `${'هذه جملة طويلة عن المعرفة. '.repeat(120)}`, textProvenance: 'NATIVE_TEXT' as const }, { page: 2, text: `${'هذه جملة ثانية عن العلم. '.repeat(120)}`, textProvenance: 'NATIVE_TEXT' as const }]
const chunks = planBookChunks(pages)
assert.ok(chunks.length >= 2)
assert.equal(chunks[0].pageStart, 1)
assert.ok(chunks.every((chunk) => chunk.pageStart <= chunk.pageEnd))
assert.ok(chunks.every((chunk) => chunk.text.endsWith('.')))
assert.equal(nextExtractionPage(4, 10), 5)
assert.equal(nextExtractionPage(10, 10), null)
const ocr = pagesNeedingOcr(Array.from({ length: 19 }, (_, index) => ({ page: index + 1, text: '' })))
assert.deepEqual(ocr.map((batch) => batch.length), [8, 8, 3])
const source = 'تعتمد النظرية العلمية على الملاحظة الدقيقة والتجريب المنهجي والتحقق المستمر من النتائج وتوثيق جميع الخطوات بصورة واضحة ومحددة.'
const candidate = { category: 'THEORY', title: 'المنهج العلمي', summary: 'تفسير منهجي للتجريب والملاحظة', excerpt: source, importance: 80 }
assert.ok(validateBookKnowledgeCandidate(candidate, source))
assert.equal(validateBookKnowledgeCandidate({ ...candidate, excerpt: 'عبارة غير موجودة في النص الأصلي '.repeat(3) }, source), null)
assert.equal(validateBookKnowledgeCandidate({ ...candidate, excerpt: `${source.slice(0, -1)}؟` }, source), null)
assert.ok(isRepeatedBookConcept(candidate, [{ title: 'المنهج العلمي', summary: 'تفسير منهجي للتجريب والملاحظة' }]))
async function pdfExtractionRegression() {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let page = 1; page <= 3; page++) {
    const sheet = pdf.addPage([595, 842])
    sheet.drawText(`Page ${page}: ` + 'Academic evidence sentence. '.repeat(8), { x: 35, y: 780, size: 10, font, maxWidth: 530 })
  }
  const buffer = Buffer.from(await pdf.save())
  const extracted = await extractNumberedPdfPages(buffer, [1, 2, 3])
  assert.equal(extracted.length, 3)
  assert.ok(extracted[0].text.includes('Page 1:'))
  assert.ok(extracted[1].text.includes('Page 2:'))
  assert.ok(extracted[2].text.includes('Page 3:'))
  const saved = new Map<number, { pageStart: number; pageEnd: number; text: string }>()
  const progress: number[] = []
  const store = {
    upsertChunk: async (chunk: { index: number; pageStart: number; pageEnd: number; text: string }) => { saved.set(chunk.index, chunk) },
    saveProgress: async (_jobId: string, pagesDone: number) => { progress.push(pagesDone) },
  }
  const first = await extractPdfBatch({ buffer, bookId: 'book', programId: 'program', jobId: 'job', pagesDone: 0, totalPages: 1, existingChunks: 0, store, deadlineMs: Date.now() + 30000 })
  assert.equal(first.pagesDone, 1)
  const firstChunkText = [...saved.values()].map((chunk) => chunk.text).join(' ')
  const resumed = await extractPdfBatch({ buffer, bookId: 'book', programId: 'program', jobId: 'job', pagesDone: 1, totalPages: 3, existingChunks: first.totalChunks, store, deadlineMs: Date.now() + 30000 })
  assert.equal(resumed.pagesDone, 3)
  assert.deepEqual(progress, [1, 3])
  assert.ok([...saved.values()].some((chunk) => chunk.text.includes('Page 2:')))
  assert.ok(![...saved.entries()].filter(([index]) => index >= first.totalChunks).some(([, chunk]) => chunk.text.includes('Page 1:')))
  assert.ok(firstChunkText.includes('Page 1:'))
}

pdfExtractionRegression().then(() => console.log('book-reading regression checks passed')).catch((error) => { console.error(error); process.exitCode = 1 })
