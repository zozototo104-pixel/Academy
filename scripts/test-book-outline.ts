import { planBookOutline, detectOriginalSourceHeadings, outlineSubheadingMarkers, sourceBoundariesFromReadChunks } from '@/lib/book-outline'

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

function testArticleHeadingsFromOriginalPdf() {
  const pages = [
    { page: 1, text: 'ماستر في إدارة الأعمال MBA\n\nالمقال: مقدمة في إدارة الأعمال\nتقدم الإدارة منهجاً متكاملاً لتنسيق الموارد وتحقيق النتائج التنظيمية الفعالة. '.repeat(2) + '\nأسئلة وأجوبة\nس: ما الإدارة؟\nخلاصة\n', textProvenance: 'NATIVE_TEXT' as const },
    { page: 2, text: 'ماستر في إدارة الأعمال MBA\n\nدور المدير في المنظمات الحديثة\nيتولى المدير التنسيق بين الفرق وتوجيه الموارد وتحديد الأولويات وفق الخطة التشغيلية. '.repeat(2), textProvenance: 'NATIVE_TEXT' as const },
    { page: 3, text: 'ماستر في إدارة الأعمال MBA\n\nالمقال: تطبيقات الإدارة المعاصرة\nتركز التطبيقات على التخطيط والرقابة والتطوير المتدرج للمؤسسات وتحسين جودة العمل. '.repeat(2), textProvenance: 'NATIVE_TEXT' as const },
  ]
  const headings = detectOriginalSourceHeadings(pages, 'كتاب إدارة الأعمال')
  assert(headings.some((h) => h.title === 'مقدمة في إدارة الأعمال'), 'يجب اكتشاف عنوان المقال')
  assert(headings.some((h) => h.title === 'دور المدير في المنظمات الحديثة'), 'يجب اكتشاف عنوان موضوع مستقل')
  assert(!headings.some((h) => /ماستر|أسئلة وأجوبة|خلاصة/.test(h.title)), 'لا يجوز اعتماد الترويسة أو الأقسام الفرعية')
}
function testOrdinaryLinesAreNotSections() {
  const pages = [{ page: 1, text: 'هذه جملة قصيرة عادية\nهذه الفقرة توضح كيفية عمل الفريق ومتابعة الأداء واستعمال وسائل القياس. '.repeat(3) + '\n1. البند الأول\nس: ماذا نفعل؟', textProvenance: 'NATIVE_TEXT' as const }]
  assert(detectOriginalSourceHeadings(pages, 'كتاب تجريبي').length === 0, 'السطر العادي لا يجوز أن يصبح قسماً')
}
function testOriginalPdfChapterDetected() {
  const pages = [{ page: 2, text: 'الفصل الأول\nمفاهيم الإدارة\nهذا شرح متصل لمنهج الإدارة وخطوات التخطيط والتحليل والتنفيذ. '.repeat(3), textProvenance: 'NATIVE_TEXT' as const }]
  assert(detectOriginalSourceHeadings(pages, 'كتاب تجريبي').some((h) => h.title === 'الفصل الأول'), 'فهرسة المصدر يجب أن تكشف الفصل الأصلي')
}

function testSubheadingReviewMarkers() {
  const pages = [{ page: 4, text: 'مقدمة في الإدارة\nأسئلة وأجوبة\nخلاصة\nهذا متن توضيحي طويل.', textProvenance: 'NATIVE_TEXT' as const }]
  const chunks = [chunk(0, pages[0].text, 4)]
  const draft = plan(chunks)
  const markers = outlineSubheadingMarkers(pages, chunks, draft.sections)
  assert(markers.some((m) => m.title === 'أسئلة وأجوبة' && m.page === 4), 'أسئلة وأجوبة يجب أن تظهر علامة مراجعة')
  assert(markers.some((m) => m.title === 'خلاصة' && m.charOffset !== null), 'الخلاصة يجب أن تحتفظ بموضعها')
  assert(draft.sections.length === 1, 'العلامات الفرعية يجب ألا تصبح حدود أقسام')
}

function testReadChunksCreateOutlineWithoutReopeningPdf() {
  const source = [
    chunk(0, 'الفصل الأول\nمدخل الإدارة\n' + 'شرح تفصيلي عن مبادئ الإدارة والتخطيط وتطبيقها العملي. '.repeat(4), 1),
    chunk(1, 'المقال: مقدمة في إدارة الأعمال\n' + 'يعرض هذا المقال مفاهيم الإدارة الحديثة وإدارة الموارد والعمليات. '.repeat(4), 3),
    chunk(2, 'المقال: دور المدير في المنظمات الحديثة\n' + 'يوضح هذا المقال مسؤوليات المدير وسبل التخطيط والتنفيذ. '.repeat(4), 7),
  ]
  const boundaries = sourceBoundariesFromReadChunks(source, 'كتاب الإدارة')
  assert(boundaries.some((b) => b.title === 'الفصل الأول'), 'فصل الكتاب الأصلي يجب أن يظهر من النص المحفوظ')
  assert(boundaries.some((b) => b.title === 'مقدمة في إدارة الأعمال'), 'عنوان المقال يجب أن يظهر دون إعادة قراءة PDF')
  const planned = planBookOutline(source, source.map((c) => ({ chunkId: 'chunk-' + c.index, title: 'عنصر', summary: 'ملخص' })), new Map(source.map((c) => [c.index, 'chunk-' + c.index])), 1, boundaries, 'كتاب الإدارة', true)
  assert(planned.sections.length >= 2, 'الفهرس من المقاطع يجب أن يحتوي على أكثر من قسم')
}

const tests = [
  testReadChunksCreateOutlineWithoutReopeningPdf,
  testSubheadingReviewMarkers,
  testArticleHeadingsFromOriginalPdf,
  testOrdinaryLinesAreNotSections,
  testOriginalPdfChapterDetected,
  testReversedArabicChapterOrder,
  testArabicIndicDigitChapter,
  testTwoChaptersInSameChunk,
  testIntroAndMidChunkFirstChapter,
]

for (const test of tests) {
  test()
  console.log(`✓ ${test.name}`)
}
