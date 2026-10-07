import assert from 'node:assert/strict'
import { buildExamSourceChunks, selectExamSourceChunks } from '../src/lib/exam-source-chunks'

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
  assert.deepEqual(chunks.map((chunk) => chunk.sourceIndex), [1, 2])
  assert.deepEqual(chunks.map((chunk) => chunk.bookId), ['b1', 'b2'])

  console.log('▶ comprehensive exam chunks: long paragraphs split on safe boundaries')
  const sentence = 'هذه جملة كاملة يجب أن تبقى داخل مقطع واحد حتى يظل الاقتباس الحرفي قابلًا للتحقق دون كسر الكلمات أو الجمل.'
  const longText = `${'مقدمة مفيدة '.repeat(140)}. ${sentence} ${'تفصيل إضافي '.repeat(180)}. ${'خاتمة واضحة '.repeat(80)}`
  const split = buildExamSourceChunks([{ bookId: 'long', bookTitle: 'طويل', text: longText, contentQuality: 'UPLOADED_FILE' }], 1800)
  assert.ok(split.length >= 2)
  assert.ok(split.some((chunk) => chunk.text.includes(sentence)), 'A complete source sentence must remain wholly inside one chunk')
  const originalTokens = longText.trim().split(/\s+/)
  const chunkTokens = split.map((c) => c.text).join(' ').trim().split(/\s+/)
  assert.deepEqual(chunkTokens, originalTokens, 'Chunks must preserve every word intact and in order')

  console.log('▶ comprehensive exam chunks: whitespace-only boundaries preserve every token')
  const wordsOnly = Array.from({ length: 700 }, (_, i) => `كلمة${i + 1}`).join(' ')
  const whitespaceSplit = buildExamSourceChunks([{ bookId: 'spaces', bookTitle: 'مسافات فقط', text: wordsOnly, contentQuality: 'UPLOADED_FILE' }], 1800)
  assert.ok(wordsOnly.length > 4000)
  assert.ok(whitespaceSplit.length >= 2)
  const whitespaceOriginalTokens = wordsOnly.trim().split(/\s+/)
  const whitespaceChunkTokens = whitespaceSplit.map((c) => c.text).join(' ').trim().split(/\s+/)
  assert.deepEqual(whitespaceChunkTokens, whitespaceOriginalTokens, 'Whitespace fallback must preserve every word intact and in order')

  console.log('▶ comprehensive exam chunks: selected sample is capped, distributed, and renumbered')
  const hundred = Array.from({ length: 100 }, (_, i) => ({ sourceIndex: i + 1, bookId: 'all', bookTitle: 'كامل', text: `مقطع ${i + 1} ${'محتوى أصلي موثوق '.repeat(8)}` }))
  const selected = selectExamSourceChunks(hundred, { maxChunks: 12, maxTotalChars: 18000 })
  assert.equal(selected.length, 12)
  assert.deepEqual(selected.map((chunk) => chunk.sourceIndex), Array.from({ length: 12 }, (_, i) => i + 1))
  assert.equal(selected[0].text, hundred[0].text)
  assert.equal(selected.at(-1)?.text, hundred.at(-1)?.text)
  assert.ok(selected.some((chunk) => chunk.text === hundred[45].text || chunk.text === hundred[54].text), 'Selection must cover the middle of the source set')

  console.log('▶ comprehensive exam chunks: STORED_TEXT requires explicit extraction provenance')
  assert.equal(buildExamSourceChunks([{ bookId: 'unknown', bookTitle: 'غير مثبت', text: original, contentQuality: 'STORED_TEXT' }]).length, 0)
  assert.equal(buildExamSourceChunks([{ bookId: 'generated', bookTitle: 'مولد', text: original, contentQuality: 'STORED_TEXT', sourceNote: 'النص المحفوظ المستخرج سابقًا' }]).length, 0)
  const stored = buildExamSourceChunks([{ bookId: 'stored', bookTitle: 'مخزن', text: original, contentQuality: 'STORED_TEXT', linkReadStatus: 'FILE_EXTRACTED' }])
  assert.equal(stored.length, 1)

  console.log('comprehensive exam source chunks: ok')
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
