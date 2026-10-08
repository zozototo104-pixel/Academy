import assert from 'node:assert/strict'
import { analyzeStepWithStore, validateBookKnowledgeCandidate, isRepeatedBookConcept, type AnalyzeStepStore, type BookKnowledgeCandidate } from '../src/lib/book-chunk-analyzer'

const evidence = 'تقوم المعرفة الأكاديمية على الملاحظة المنظمة والتجريب الدقيق وتوثيق النتائج بصورة تسمح بإعادة الفحص والتحقق العلمي المستقل.'
const secondEvidence = 'تتطلب الدراسة التطبيقية اختيار منهج واضح وقياس النتائج وفق مؤشرات معلنة ومراجعة البيانات قبل إعلان الاستنتاجات النهائية.'
const first: BookKnowledgeCandidate = { category: 'CONCEPT', title: 'المعرفة العلمية', summary: 'تفسير دور التجريب والملاحظة في المعرفة', excerpt: evidence, importance: 80 }
const second: BookKnowledgeCandidate = { category: 'METHOD', title: 'التحقق التجريبي', summary: 'آلية التوثيق والتحقق من نتائج البحث', excerpt: evidence, importance: 70 }
const invalid: BookKnowledgeCandidate = { ...first, title: 'غير حرفي', excerpt: 'هذه جملة مختلقة غير موجودة في نص الكتاب الأصلي '.repeat(2) }
assert.ok(validateBookKnowledgeCandidate(first, evidence))
assert.equal(validateBookKnowledgeCandidate(invalid, evidence), null)
assert.ok(isRepeatedBookConcept(first, [first]))

async function testKnowledgeAndResume() {
  const chunks = [
    { id: 'a', bookId: 'book', programId: 'program', index: 0, text: evidence, pageStart: 1, pageEnd: 1, textProvenance: 'NATIVE_TEXT', attempts: 0, status: 'EXTRACTED' },
    { id: 'b', bookId: 'book', programId: 'program', index: 1, text: secondEvidence, pageStart: 2, pageEnd: 2, textProvenance: 'VISION_OCR', attempts: 0, status: 'EXTRACTED' },
  ]
  const saved: BookKnowledgeCandidate[] = []
  let legacy = false, completed = false, analyzed = 0
  const store: AnalyzeStepStore = {
    getJob: async () => ({ id: 'job', bookId: 'book', programId: 'program', phase: completed ? 'DONE' : 'ANALYZE', status: completed ? 'COMPLETED' : 'RUNNING' }),
    nextChunk: async (_bookId, excluded) => chunks.find((chunk) => chunk.status === 'EXTRACTED' && !excluded.includes(chunk.id)) || null,
    priorItems: async () => saved,
    saveAnalyzed: async (chunk, items) => { saved.push(...items); chunks.find((item) => item.id === chunk.id)!.status = 'ANALYZED'; analyzed++ },
    saveFailure: async () => { throw new Error('unexpected failure') },
    complete: async () => { legacy = true; completed = true },
  }
  const analyze = async ({ chunkText }: { chunkText: string }) => chunkText === evidence ? [first, second, invalid] : [first]
  const result = await analyzeStepWithStore('job', Date.now() + 30000, store, analyze as any)
  assert.equal(result.completed, true)
  assert.equal(saved.length, 2)
  assert.equal(analyzed, 2)
  assert.equal(legacy, true)
  await analyzeStepWithStore('job', Date.now() + 30000, store, analyze as any)
  assert.equal(analyzed, 2, 'resume must not analyze completed chunks')
}

async function testThreeFailuresAndContinue() {
  const chunks = ['bad', 'good'].map((id, index) => ({ id, bookId: 'book', programId: 'program', index, text: index === 0 ? evidence : secondEvidence, pageStart: index + 1, pageEnd: index + 1, textProvenance: 'NATIVE_TEXT', attempts: 0, status: 'EXTRACTED' }))
  let failed = 0, analyzed = 0, completed = false
  const store: AnalyzeStepStore = {
    getJob: async () => ({ id: 'job', bookId: 'book', programId: 'program', phase: 'ANALYZE', status: 'RUNNING' }),
    nextChunk: async (_bookId, excluded) => chunks.find((chunk) => chunk.status === 'EXTRACTED' && !excluded.includes(chunk.id)) || null,
    priorItems: async () => [],
    saveAnalyzed: async (chunk) => { chunks.find((item) => item.id === chunk.id)!.status = 'ANALYZED'; analyzed++ },
    saveFailure: async (id, _jobId, _message, exhausted) => { const chunk = chunks.find((item) => item.id === id)!; chunk.attempts++; if (exhausted) { chunk.status = 'FAILED'; failed++ } },
    complete: async () => { completed = true },
  }
  const analyze = async ({ chunkText, bookId }: any) => {
    void chunkText; void bookId
    // The first selected chunk is the one that fails until exhausted.
    if (chunks[0].status === 'EXTRACTED' && chunks[0].attempts < 3 && analyzed === 0) throw new Error('TEMPORARY_FAILURE')
    return [first]
  }
  for (let attempt = 0; attempt < 3; attempt++) await analyzeStepWithStore('job', Date.now() + 30000, store, analyze as any)
  assert.equal(chunks[0].status, 'FAILED')
  assert.equal(failed, 1)
  assert.equal(chunks[1].status, 'ANALYZED')
  assert.equal(analyzed, 1)
  assert.equal(completed, true)
}

Promise.all([testKnowledgeAndResume(), testThreeFailuresAndContinue()])
  .then(() => console.log('book chunk analysis regression checks passed'))
  .catch((error) => { console.error(error); process.exitCode = 1 })
