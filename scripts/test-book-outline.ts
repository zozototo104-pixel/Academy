import { planBookOutline } from '@/lib/book-outline'

type ChunkInput = Parameters<typeof planBookOutline>[0][number]

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function chunk(index: number, text: string, pageStart = index + 1): ChunkInput {
  return { index, headingPath: null, text, pageStart, pageEnd: pageStart }
}

function plan(chunks: ChunkInput[]) {
  const chunkIds = new Map(chunks.map((entry) => [entry.index, `chunk-${entry.index}`]))
  const items = chunks.map((entry) => ({ chunkId: `chunk-${entry.index}`, title: `عنصر ${entry.index}`, summary: 'ملخص اختباري' }))
  return planBookOutline(chunks, items, chunkIds, 1, [], 'كتاب الاختبار')
}

function titles(result: ReturnType<typeof planBookOutline>) {
  return result.sections.map((section) => section.title).join(' | ')
}

function testReversedArabicChapterOrder() {
  const result = plan([
    chunk(0, 'المداخل المعرفية\nالأول الفصل\nنص الفصل الأول'),
    chunk(1, 'الفصل الثاني\nالإطار التطبيقي\nنص الفصل الثاني'),
  ])
  assert(titles(result).includes('الفصل الأول'), 'الصيغة المقلوبة "الأول الفصل" لم تُكتشف كالفصل الأول')
  assert(titles(result).includes('المداخل المعرفية'), 'اسم الفصل في الصيغة المقلوبة لم يؤخذ من السطر السابق')
}

function testArabicIndicDigitChapter() {
  const result = plan([
    chunk(0, 'الفصل ١\nمدخل إلى المفاهيم\nنص الفصل الأول'),
    chunk(1, 'الفصل الثاني\nامتداد المفاهيم\nنص الفصل الثاني'),
  ])
  assert(titles(result).includes('الفصل الأول'), 'الصيغة "الفصل ١" لم تُطبّع إلى الفصل الأول')
}

function testTwoChaptersInSameChunk() {
  const result = plan([
    chunk(0, 'الفصل الأول\nتمهيد\nنص طويل للفصل الأول\nالفصل الثاني\nتطبيقات\nنص الفصل الثاني'),
  ])
  assert(result.sections.length === 2, `كان متوقعاً قسمان من مقطع واحد، لكن الناتج ${result.sections.length}`)
  assert(result.sections.every((section) => section.chunkStartIndex === 0), 'القسمان يجب أن يبدآ من المقطع نفسه')
  assert(result.sections.some((section) => (section.startCharOffset ?? 0) > 0), 'القسم الثاني داخل نفس المقطع يحتاج startCharOffset')
}

function testIntroAndMidChunkFirstChapter() {
  const result = plan([
    chunk(0, 'مقدمة عامة عن الكتاب ونطاقه\nالفصل الأول\nالإطار النظري\nنص الفصل الأول'),
  ])
  assert(result.sections.length === 2, `المقدمة والفصل الأول داخل المقطع نفسه يجب أن ينتجا قسمين، لكن الناتج ${result.sections.length}`)
  assert(result.sections[0].title.includes('مقدمة'), 'القسم الأول يجب أن يبقى مقدمة')
  assert(result.sections[1].title.includes('الفصل الأول'), 'القسم الثاني يجب أن يكون الفصل الأول')
  assert(result.sections[1].chunkStartIndex === 0 && (result.sections[1].startCharOffset ?? 0) > 0, 'الفصل الأول يجب أن يبدأ من نفس المقطع مع startCharOffset')
}

const tests = [
  testReversedArabicChapterOrder,
  testArabicIndicDigitChapter,
  testTwoChaptersInSameChunk,
  testIntroAndMidChunkFirstChapter,
]

for (const test of tests) {
  test()
  console.log(`✓ ${test.name}`)
}
