import assert from 'node:assert/strict'
import { buildExamSourceChunks } from '../src/lib/exam-source-chunks'

const original = 'هذا نص أصلي طويل من الكتاب يستخدم كدليل حرفي موثوق لبناء سؤال الامتحان الشامل، ويجب أن يبقى مرتبطًا بالمصدر الحقيقي.'
const second = 'وهذا مقطع أصلي ثانٍ من كتاب آخر، طوله كافٍ للاقتباس الحرفي والتحقق من ترقيم المصادر بعد استبعاد المحتوى غير الموثوق.'

function main() {
  console.log('▶ comprehensive exam chunks: original sources only and one-based numbering')
  const chunks = buildExamSourceChunks([
    { bookId: 'b1', bookTitle: 'الأول', text: original, contentQuality: 'UPLOADED_FILE' },
    { bookId: 'vision', bookTitle: 'Vision', text: 'نص مولد بواسطة الرؤية '.repeat(10), contentQuality: 'GEMINI_DOCUMENT' },
    { bookId: 'short', bookTitle: 'قصير', text: 'نص قصير', contentQuality: 'LINK_TEXT' },
    { bookId: 'b2', bookTitle: 'الثاني', text: second, contentQuality: 'LINK_TEXT' },
  ])
  assert.equal(chunks.length, 2)
  assert.deepEqual(chunks.map((chunk) => chunk.sourceIndex), [1, 2])
  assert.deepEqual(chunks.map((chunk) => chunk.bookId), ['b1', 'b2'])
  assert.equal(chunks[0]?.text, original)

  console.log('▶ comprehensive exam chunks: generated stored knowledge is excluded')
  assert.equal(buildExamSourceChunks([
    { bookId: 'derived', bookTitle: 'مشتق', text: original, contentQuality: 'STORED_TEXT', sourceNote: 'خريطة معرفة مولدة من المحتوى المحفوظ' },
  ]).length, 0)

  console.log('▶ comprehensive exam chunks: extracted stored text remains eligible')
  const stored = buildExamSourceChunks([
    { bookId: 'stored', bookTitle: 'مخزن', text: original, contentQuality: 'STORED_TEXT', sourceNote: 'النص المحفوظ المستخرج سابقًا' },
  ])
  assert.equal(stored.length, 1)
  assert.equal(stored[0]?.sourceIndex, 1)

  console.log('comprehensive exam source chunks: ok')
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
