import assert from 'node:assert/strict'
import { nextExtractionPage, pagesNeedingOcr, planBookChunks } from '../src/lib/book-reader'
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
console.log('book-reading regression checks passed')
