import assert from 'node:assert/strict'
import { nextExtractionPage, pagesNeedingOcr, planBookChunks, extractPdfBatch, extractNumberedPdfPages } from '../src/lib/book-reader'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { analyzeStepWithStore, isRepeatedBookConcept, validateBookKnowledgeCandidate } from '../src/lib/book-chunk-analyzer'

const pages = [{ page: 1, text: `${'هذه جملة طويلة عن المعرفة. '.repeat(120)}`, textProvenance: 'NATIVE_TEXT' as const }, { page: 2, text: `${'هذه جملة ثانية عن العلم. '.repeat(120)}`, textProvenance: 'NATIVE_TEXT' as const }]
const chunks = planBookChunks(pages)
const structured = planBookChunks([
  { page: 1, text: 'مقدمة قصيرة\nيتناول هذا الكتاب أصول الإدارة ومنهجها التطبيقي.', textProvenance: 'NATIVE_TEXT' },
  { page: 2, text: 'الفصل الثاني\nتعريفات وأمثلة\nيُبيّن هذا الفصل دور المدير في الإدارة.', textProvenance: 'NATIVE_TEXT' },
])
assert.ok(structured[0].text.includes('\n'), 'Book chunks must preserve original line boundaries')
assert.ok(structured[0].headingPath?.includes('الفصل الثاني'), 'Heading lookup must cover later pages within a chunk')
assert.ok(chunks.length >= 2)
assert.equal(chunks[0].pageStart, 1)
assert.ok(chunks.every((chunk) => chunk.pageStart <= chunk.pageEnd))
assert.ok(chunks.every((chunk) => chunk.text.endsWith('.')))
assert.equal(nextExtractionPage(4, 10), 5)
assert.equal(nextExtractionPage(10, 10), null)
const ocr = pagesNeedingOcr(Array.from({ length: 19 }, (_, index) => ({ page: index + 1, text: '' })))
assert.deepEqual(ocr.map((batch) => batch.length), [4, 4, 4, 4, 3])
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

async function analyzeResumeRegression() {
  // Resume proof (Haris's closing criterion, 2026-11-04): a job whose first
  // chunks were analyzed in an earlier run continues from the saved progress —
  // the already-analyzed chunks are never re-processed and the job completes.
  const baseText = 'الاستئناف من التقدم المحفوظ يعني أن النظام يكمل من حيث توقف تمامًا دون إعادة تحليل ما أُنجز من المقاطع في محاولة سابقة.'
  const chunks = [0, 1, 2, 3].map((index) => ({
    id: `chunk-${index}`, bookId: 'book', programId: 'program', index,
    text: `${baseText} الجزء ${index}.`, pageStart: index + 1, pageEnd: index + 1,
    textProvenance: 'NATIVE_TEXT', attempts: 0,
  }))
  const pending = chunks.slice(2) // chunks 0 and 1 were ANALYZED by the earlier run
  const analyzedCalls: number[] = []
  const savedCalls: number[] = []
  let completedJob = false
  const store = {
    getJob: async () => ({ id: 'job', bookId: 'book', programId: 'program', phase: 'ANALYZE', status: 'RUNNING' }),
    nextChunk: async (_bookId: string, excludeIds: string[]) => pending.find((chunk) => !excludeIds.includes(chunk.id)) ?? null,
    priorItems: async () => [],
    saveAnalyzed: async (chunk: { index: number }) => { savedCalls.push(chunk.index) },
    saveFailure: async () => { throw new Error('saveFailure must not run in the resume scenario') },
    complete: async () => { completedJob = true },
  }
  const analyze = async (input: { chunkText: string }) => {
    const index = chunks.find((chunk) => chunk.text === input.chunkText)!.index
    analyzedCalls.push(index)
    return [{ category: 'CONCEPT', title: 'مفهوم الاستئناف', summary: 'شرح مفهوم الاستئناف من التقدم المحفوظ', excerpt: baseText, importance: 80 }]
  }
  const result = await analyzeStepWithStore('job', Date.now() + 60_000, store as any, analyze as any)
  assert.deepEqual(analyzedCalls, [2, 3])
  assert.deepEqual(savedCalls, [2, 3])
  assert.equal(result.analyzed, 2)
  assert.equal(result.failed, 0)
  assert.equal(result.completed, true)
  assert.equal(completedJob, true)
}

pdfExtractionRegression()
  .then(() => analyzeResumeRegression())
  .then(() => console.log('book-reading regression checks passed'))
  .catch((error) => { console.error(error); process.exitCode = 1 })
