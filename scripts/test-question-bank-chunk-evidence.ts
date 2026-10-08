import assert from 'node:assert/strict'
import { resolveQuestionBankEvidence } from '../src/lib/question-bank-chunk-evidence'
import { applyOcrDerivedFlags } from '../src/lib/text-provenance'

const excerpt = 'توضح هذه الفقرة العلمية المطولة كيف تؤثر الملاحظة الدقيقة والتجربة الموثقة في صحة الاستنتاجات الأكاديمية.'
const books = [
  { id: 'book-a', textContent: 'مقدمة قصيرة لا تتضمن نص الصفحة المتأخرة', linkReadStatus: 'STORED_TEXT' },
  { id: 'book-b', textContent: 'محتوى كتاب مختلف', linkReadStatus: 'STORED_TEXT' },
]
const chunks = [
  { id: 'late-page', bookId: 'book-a', text: `صفحة متأخرة: ${excerpt}` },
  { id: 'ocr-page', bookId: 'book-a', text: `نص مستخرج بصرياً: ${excerpt}` },
  { id: 'foreign', bookId: 'book-b', text: excerpt },
]
const items = [
  { id: 'late', kbVersion: 2, bookId: 'book-a', chunkId: 'late-page', textProvenance: 'NATIVE_TEXT', excerpt },
  { id: 'ocr', kbVersion: 2, bookId: 'book-a', chunkId: 'ocr-page', textProvenance: 'VISION_OCR', excerpt },
  { id: 'cross-book', kbVersion: 2, bookId: 'book-a', chunkId: 'foreign', textProvenance: 'NATIVE_TEXT', excerpt },
]
const result = resolveQuestionBankEvidence(items, books, chunks, (item) => item.excerpt)
assert.equal(books[0].textContent.includes(excerpt), false, 'fixture must be absent from truncated book text')
assert.deepEqual(result.evidenceKnowledge.map((item) => item.id), ['late', 'ocr'], 'v2 chunk evidence must accept late and OCR pages, reject foreign-book chunks')
assert.equal(result.evidenceSources[0].textProvenance, 'NATIVE_TEXT')
assert.equal(result.evidenceSources[1].textProvenance, 'VISION_OCR', 'OCR provenance must reach evidenceSources unchanged')
const ocrFlags = applyOcrDerivedFlags(['SOURCE_LINKED', 'SOURCE_GROUNDED'], result.evidenceSources[1].textProvenance)
assert.ok(ocrFlags.includes('OCR_DERIVED_SOURCE'))
assert.ok(ocrFlags.includes('NEEDS_HUMAN_REVIEW'))
assert.ok(!ocrFlags.includes('SOURCE_GROUNDED'), 'OCR must never be promoted to SOURCE_GROUNDED')
console.log('PASS question-bank v2 chunk evidence: late pages, OCR flags, cross-book rejection')
