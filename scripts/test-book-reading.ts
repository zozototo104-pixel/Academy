import assert from 'node:assert/strict'
import { nextExtractionPage, pagesNeedingOcr, planBookChunks, extractPdfBatch, extractNumberedPdfPages } from '../src/lib/book-reader'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { analyzeStepWithStore, isRepeatedBookConcept, validateBookKnowledgeCandidate } from '../src/lib/book-chunk-analyzer'
import { mergeBookPageReadIssues, parseBookOcrSoloPages, parseBookPageReadIssues, preserveBookPageReadIssues, withBookOcrSoloPages } from '../src/lib/book-read-job-control'

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

async function unreadablePdfPageDoesNotStopFollowingPages() {
  const content = 'تطبيقات الإدارة الاستراتيجية والتخطيط التشغيلي والرقابة على الأداء المؤسسي. '.repeat(5)
  const saved: { pageStart: number; pageEnd: number; text: string }[] = []
  const progress: { current: { pagesDone: number; issuePages: number[]; processedPages: number[] } | null } = { current: null }
  const extractPages = async (_buffer: Buffer, numbers: readonly number[]) => numbers.map((page) => ({
    page,
    text: [2, 4].includes(page) ? '' : content + 'رقم الصفحة ' + page,
    textProvenance: 'NATIVE_TEXT' as const,
  }))
  const ocrPages = async (_buffer: Buffer, numbers: readonly number[]) => {
    if (numbers.length > 1 || numbers[0] === 2) throw new Error('OCR_PAGE_UNREADABLE')
    return [{ page: numbers[0], text: content + 'نص الصفحة الرابعة المستعاد', textProvenance: 'VISION_OCR' as const }]
  }
  const result = await extractPdfBatch({
    buffer: Buffer.from('%PDF-TEST'), bookId: 'test-book', programId: 'test-program',
    jobId: 'test-job', pagesDone: 0, totalPages: 5, existingChunks: 0,
    deadlineMs: Date.now() + 90_000,
    extractPages: extractPages as any, ocrPages: ocrPages as any,
    store: {
      upsertChunk: async (chunk) => { saved.push(chunk) },
      saveProgress: async (_job, pagesDone, _total, _chunks, _phase, issues = [], processedPages = []) => {
        progress.current = { pagesDone, issuePages: issues.map((i) => i.page), processedPages: [...processedPages] }
        const ledger = mergeBookPageReadIssues(null, processedPages, issues)
        assert.deepEqual(parseBookPageReadIssues(ledger).map((i) => i.page), [2],
          'يجب حفظ فشل الصفحة الثانية مع تقدم بقية الكتاب')
        const afterAnalyzeFailure = preserveBookPageReadIssues(ledger, 'فشل تحليل المقطع')
        const afterCronFailure = preserveBookPageReadIssues(afterAnalyzeFailure, 'AI_ACADEMIC_PROVIDER_UNAVAILABLE')
        assert(afterCronFailure.includes('AI_ACADEMIC_PROVIDER_UNAVAILABLE'),
          'يجب الاحتفاظ بسبب فشل المرحلة الأخيرة')
        assert.deepEqual(parseBookPageReadIssues(afterCronFailure).map((i) => i.page), [2],
          'فشل التحليل والكرون لا يجوز أن يمحو سجل الصفحة غير المقروءة')
        assert.equal(mergeBookPageReadIssues(afterCronFailure, [2], []), null,
          'القراءة اللاحقة الناجحة تزيل المشكلة القديمة فقط')
      },
    },
  })
  assert.equal(result.pagesDone, 5, 'الكتاب يتقدم للصفحة الخامسة رغم فشل OCR للثانية')
  assert.deepEqual(progress.current?.issuePages, [2], 'الفشل موثّق على الصفحة المحددة')
  assert.deepEqual(progress.current?.processedPages, [1, 2, 3, 4, 5], 'التقدم يسجل دفعة الصفحات بأكملها')
  assert(saved.some((chunk) => chunk.text.includes('الصفحة الرابعة المستعاد')), 'لا يجوز خسارة صفحة نجح OCR لها')
  assert(saved.some((chunk) => chunk.text.includes('رقم الصفحة 5')), 'الصفحات التالية لم تتوقف')
  assert(saved.every((chunk) => chunk.pageEnd < 2 || chunk.pageStart > 2),
    'لا يجوز أن يدّعي أي مقطع أنه غطى الصفحة غير المقروءة')
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

function ocrSoloStateSurvivesPipelineWrites() {
  const marked = withBookOcrSoloPages(null, [4, 3])
  assert.deepEqual(parseBookOcrSoloPages(marked), [3, 4], 'حالة المحاولة الفردية تُحفظ وتُقرأ مرتبة')
  const afterError = preserveBookPageReadIssues(marked, 'AI_DEADLINE_EXCEEDED')
  assert.deepEqual(parseBookOcrSoloPages(afterError), [3, 4], 'خطأ لاحق في خط الأنابيب لا يمحو حالة المحاولة الفردية')
  assert.deepEqual(parseBookPageReadIssues(afterError), [], 'لا مشكلات صفحات مسجلة بعد')
  const withIssue = mergeBookPageReadIssues(afterError, [], [{ page: 3, kind: 'PARTIAL', reason: 'OCR_FAILED: بطء' }])
  assert.deepEqual(parseBookOcrSoloPages(withIssue), [3, 4], 'حفظ التقدم لا يمحو حالة المحاولة الفردية')
  assert.deepEqual(parseBookPageReadIssues(withIssue).map((i) => i.page), [3], 'مشكلة الصفحة تتعايش مع حالة المحاولة في نفس الحقل')
  const progressed = mergeBookPageReadIssues(withIssue, [3, 4], [])
  assert.equal(progressed, null, 'اكتمال الصفحات الفردية يمسح الحالة والمشكلة معًا')
}

async function deadlineKilledGroupOcrResumesSolo() {
  const content = 'محتوى الصفحة الممسوحة ضوئيًا للاستئناف الفردي. '.repeat(6)
  const extractPages = async (_buffer: Buffer, numbers: readonly number[]) => numbers.map((page) => ({
    page, text: '', textProvenance: 'NATIVE_TEXT' as const,
  }))
  // Run 1: the group OCR call burns the remaining budget and dies before
  // any page is decided. No progress may be invented, but the batch must
  // be recorded as solo-retry state.
  let soloRecorded: number[] | null = null
  const first = await extractPdfBatch({
    buffer: Buffer.from('%PDF-TEST'), bookId: 'solo-book', programId: 'solo-program',
    jobId: 'solo-job', pagesDone: 0, totalPages: 5, existingChunks: 0,
    deadlineMs: Date.now() + 26_000,
    extractPages: extractPages as any,
    ocrPages: (async (_buffer: Buffer, numbers: readonly number[]) => {
      if (numbers.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        throw new Error('AI_DEADLINE_EXCEEDED')
      }
      return [{ page: numbers[0], text: content + numbers[0], textProvenance: 'VISION_OCR' as const }]
    }) as any,
    store: {
      upsertChunk: async () => {},
      saveProgress: async () => {},
      saveOcrSoloPages: async (_job: string, pages: readonly number[]) => { soloRecorded = [...pages] },
    },
  })
  assert.equal(first.pagesDone, 0, 'لا تقدم مُخترع عند موت النداء الجماعي بالمهلة')
  assert.deepEqual(soloRecorded, [1, 2, 3, 4], 'الدفعة العالقة تُسجَّل للاستئناف الفردي بدل تكرارها جماعيًا')
  const persisted = withBookOcrSoloPages(null, soloRecorded!)
  assert.deepEqual(parseBookOcrSoloPages(persisted), [1, 2, 3, 4], 'الحالة المحفوظة في lastError تُقرأ كما هي')
  // Run 2: the resume must never repeat the group call for those pages,
  // and the book completes one page at a time.
  const callShapes: number[] = []
  const second = await extractPdfBatch({
    buffer: Buffer.from('%PDF-TEST'), bookId: 'solo-book', programId: 'solo-program',
    jobId: 'solo-job', pagesDone: 0, totalPages: 5, existingChunks: 0,
    deadlineMs: Date.now() + 90_000,
    extractPages: extractPages as any,
    ocrPages: (async (_buffer: Buffer, numbers: readonly number[]) => {
      callShapes.push(numbers.length)
      if (numbers.length > 1) throw new Error('GROUP_CALL_REPEATED')
      return [{ page: numbers[0], text: content + numbers[0], textProvenance: 'VISION_OCR' as const }]
    }) as any,
    store: { upsertChunk: async () => {}, saveProgress: async () => {} },
    soloPages: new Set(parseBookOcrSoloPages(persisted)),
  })
  assert.equal(second.pagesDone, 5, 'الاستئناف الفردي يكمل الكتاب كاملًا')
  assert.ok(callShapes.length > 0 && callShapes.every((n) => n === 1), 'لا نداء جماعي إطلاقًا في الاستئناف')
}

pdfExtractionRegression()
  .then(() => unreadablePdfPageDoesNotStopFollowingPages())
  .then(() => analyzeResumeRegression())
  .then(() => ocrSoloStateSurvivesPipelineWrites())
  .then(() => deadlineKilledGroupOcrResumesSolo())
  .then(() => console.log('book-reading regression checks passed'))
  .catch((error) => { console.error(error); process.exitCode = 1 })
