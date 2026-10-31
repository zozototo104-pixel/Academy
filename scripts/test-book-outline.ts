import { planBookOutline, detectOriginalSourceHeadings, outlineSubheadingMarkers, sourceBoundariesFromReadChunks, parseAiOutlineBoundaries, auditOutlineCoverage, outlineApprovalGuard, refineOversizedSections, type OutlineSectionDraft } from '@/lib/book-outline'
import { readFileSync } from 'node:fs'

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

function testGenericIntroductionRestoresLegacyAiFallback() {
  const chunks = [
    chunk(0, 'مقدمة الكتاب\n' + 'يعرض الكتاب سياق الإدارة ومبادئ التخطيط. '.repeat(5)),
    chunk(1, 'تطبيقات في الإدارة وتحسين الأداء المؤسسي. '.repeat(5)),
    chunk(2, 'مبادئ الموارد البشرية وتنظيم العمل الإداري. '.repeat(5)),
  ]
  const chunkIds = new Map(chunks.map((entry) => [entry.index, 'chunk-' + entry.index]))
  const items = chunks.map((entry) => ({ chunkId: 'chunk-' + entry.index, title: 'مفهوم مرتبط بالمقطع ' + entry.index, summary: 'مفهوم من النص المحفوظ' }))
  const preliminary = planBookOutline(chunks, items, chunkIds, 2, [
    { at: 0, title: 'مقدمة الكتاب' },
    { at: 1, title: 'مقدمة الكتاب — تابع' },
  ], 'كتاب الإدارة', true)
  assert(preliminary.source === 'AI_SEGMENTED', 'العناوين العامة لا تُعتبر فصولاً موثقة ولا توقف المسار الذكي القديم')
  const ai = parseAiOutlineBoundaries(JSON.stringify({ sections: [
    { at: 0, title: 'مبادئ التخطيط الإداري' },
    { at: 1, title: 'تطوير الأداء المؤسسي' },
    { at: 2, title: 'تنظيم الموارد البشرية' },
  ] }), chunks, 'كتاب الإدارة')
  const improved = planBookOutline(chunks, items, chunkIds, 2, ai, 'كتاب الإدارة')
  assert(improved.sections.some((s) => s.title === 'تطوير الأداء المؤسسي'), 'يجب اعتماد العناوين الموضوعية ذات المواضع الصحيحة')
  assert(!improved.sections.some((s) => s.title.includes('— تابع')), 'لا يجوز توليد أقسام مصطنعة بلا دليل')
}

function testAiOutlineRejectsInvalidAndGenericSections() {
  const chunks = [chunk(0, 'القيادة والاتصال الإداري'), chunk(1, 'استراتيجيات الأعمال'), chunk(2, 'الإدارة المالية')]
  let rejected = false
  try {
    parseAiOutlineBoundaries(JSON.stringify({ sections: [
      { at: 0, title: 'مقدمة الكتاب' },
      { at: 555, title: 'عنوان غير موجود بالمقاطع' },
      { at: 1, title: 'مقدمة الكتاب — تابع' },
    ] }), chunks, 'كتاب الإدارة')
  } catch (error) {
    rejected = error instanceof Error && error.message === 'BOOK_OUTLINE_INSUFFICIENT_GROUNDED_SECTIONS'
  }
  assert(rejected, 'يجب رفض الفهرس الشكلي قبل الحفظ دون حذف النسخة السابقة')
}

function testLegacyOcrFallbackRemainsConnected() {
  const route = readFileSync('src/app/api/admin/books/[id]/outline/route.ts', 'utf8')
  assert(route.includes('buildBookOutline(id, { reuseReadChunks: true })'), 'الفهرسة بعد OCR المكتمل يجب أن تبقي الإثراء الذكي القديم متاحاً')
  assert(!route.includes('deterministicOnly: true'), 'لا يجوز فرض تقسيم المقاطع وحده للفهرس')
}

function spanChunk(index: number, text: string, pageStart: number, pageEnd: number): ChunkInput {
  return { index, headingPath: null, text, pageStart, pageEnd }
}

function draftSection(order: number, title: string, pageStart: number, pageEnd: number): OutlineSectionDraft {
  return { order, title, level: 1, semester: 1, chunkStartIndex: order - 1, chunkEndIndex: order - 1, pageStart, pageEnd, itemsCount: 0 }
}

// 30 chunks tiling pages 1..297; chapter lines only up to page 50, so the
// third chapter's section must swallow pages 41..297 (the production case).
function book297() {
  const chunks: ChunkInput[] = []
  const chapterAt = new Map([[0, 'الفصل الأول: مدخل الإدارة'], [2, 'الفصل الثاني: التخطيط الاستراتيجي'], [4, 'الفصل الثالث: التنظيم الإداري']])
  for (let i = 0; i < 30; i++) {
    const pageStart = i < 29 ? i * 10 + 1 : 291
    const pageEnd = i < 29 ? (i + 1) * 10 : 297
    const head = chapterAt.get(i)
    chunks.push(spanChunk(i, `${head ? head + '\n' : ''}نص المقطع ${i} في إدارة الأعمال وتحليل المنظمات وقياس الأداء المؤسسي.`, pageStart, pageEnd))
  }
  return chunks
}

function testCoverageAuditFlagsMonsterTail() {
  const chunks = book297()
  const chunkIds = new Map(chunks.map((entry) => [entry.index, `chunk-${entry.index}`]))
  const items = chunks.map((entry) => ({ chunkId: `chunk-${entry.index}`, title: `عنصر ${entry.index}`, summary: 'ملخص اختباري' }))
  const result = planBookOutline(chunks, items, chunkIds, 1, [], 'ماستر في إدارة الأعمال')
  const report = auditOutlineCoverage(result.sections)
  assert(report.totalPages === 297, 'تدقيق التغطية يجب أن يرى الكتاب كاملاً (297 صفحة)')
  assert(report.blocked.length === 1, `قسم واحد فقط يجب أن يتجاوز حد المنع، وُجد ${report.blocked.length}`)
  assert(report.blocked[0].pageStart === 41 && report.blocked[0].pageEnd === 297, 'القسم المحظور يجب أن يكون الذيل 41–297 نفسه')
  assert(report.blocked[0].pages === 257, 'حجم الذيل يجب أن يُحسب 257 صفحة')
  assert(outlineApprovalGuard(result.sections).decision === 'BLOCK', 'حارس الاعتماد يجب أن يمنع اعتماد فهرس فيه ذيل 257 صفحة')
}

function testGuardBandsAndGenuineLongChapter() {
  const mixed = [draftSection(1, 'قسم قصير', 1, 40), draftSection(2, 'فصل أصلي طويل', 41, 100), draftSection(3, 'ذيل ضخم', 101, 297)]
  const report = auditOutlineCoverage(mixed)
  assert(report.review.length === 1 && report.review[0].title === 'فصل أصلي طويل', 'قسم 60 صفحة يجب أن يقع في نطاق المراجعة لا المنع')
  assert(report.blocked.length === 1 && report.blocked[0].title === 'ذيل ضخم', 'قسم 197 صفحة يجب أن يُمنع')
  assert(outlineApprovalGuard(mixed).decision === 'BLOCK', 'وجود قسم محظور يمنع الاعتماد')
  const genuine = [draftSection(1, 'فصل أصلي موثق', 1, 60)]
  assert(outlineApprovalGuard(genuine).decision === 'ALLOW_WITH_REVIEW', 'فصل أصلي من 60 صفحة يُعلَّم للمراجعة ولا يُمنع ولا يُقطَّع')
  const normal = [draftSection(1, 'قسم أول', 1, 30), draftSection(2, 'قسم ثانٍ', 31, 55)]
  assert(outlineApprovalGuard(normal).decision === 'ALLOW', 'أقسام طبيعية تمر بلا تنبيه')
}

async function testRefineSplitsMonsterFromDroppedSourceBoundaries() {
  const chunks = book297()
  const chunkIds = new Map(chunks.map((entry) => [entry.index, `chunk-${entry.index}`]))
  const items = chunks.map((entry) => ({ chunkId: `chunk-${entry.index}`, title: `عنصر ${entry.index}`, summary: 'ملخص اختباري' }))
  // Source (article) boundaries inside the tail: the global precedence picks
  // the text chapters and drops these, exactly like the production book.
  const sourceBoundaries = [
    { at: 10, title: 'تحليل البيئة التنافسية' },
    { at: 16, title: 'إدارة المعرفة التنظيمية' },
    { at: 22, title: 'قياس التفكير الإبداعي' },
    { at: 27, title: 'استراتيجيات الابتكار المؤسسي' },
  ]
  const planned = planBookOutline(chunks, items, chunkIds, 1, sourceBoundaries, 'ماستر في إدارة الأعمال')
  assert(auditOutlineCoverage(planned.sections).blocked.length === 1, 'قبل إعادة التقسيم يجب أن يوجد الذيل المحظور')
  const refined = await refineOversizedSections({ sections: planned.sections, chunks, items, chunkIds, semester: 1, sourceBoundaries, bookTitle: 'ماستر في إدارة الأعمال', allowAi: false })
  assert(refined.refinedRanges === 1, 'يجب إعادة تقسيم نطاق واحد')
  const report = auditOutlineCoverage(refined.sections)
  assert(report.blocked.length === 0, `بعد إعادة التقسيم لا يجوز بقاء أي قسم فوق حد المنع، وُجد ${report.blocked.length}`)
  assert(refined.sections.some((section) => section.title === 'قياس التفكير الإبداعي'), 'الأقسام الفرعية يجب أن تحمل عناوين الأدلة الحقيقية')
  assert(refined.sections.some((section) => section.title.includes('الفصل الثالث')), 'أول قسم فرعي يجب أن يبقى مثبتاً على عنوان القسم الأصلي')
  assert(!refined.sections.some((section) => section.title.includes('— تابع')), 'ممنوع توليد عناوين «تابع» وهمية أثناء إعادة التقسيم')
  assert(refined.sections.some((section) => section.pageStart === 221 && section.pageEnd === 270), 'القسم الفرعي 221–270 يجب أن يبقى مستقلاً ولا يُبتلع بالدمج أو سقف الأقسام')
}

function testSectionCapNeverExtendsLargestSpan() {
  // 17 chapter ranges: one 200-page chapter, then a 2-page chapter, then 15
  // short chapters. The cap must merge a small adjacent pair; folding the
  // 2-page chapter into the 200-page one would extend the largest span.
  const chunks: ChunkInput[] = []
  for (let i = 0; i < 26; i++) {
    const pageStart = i < 10 ? i * 20 + 1 : i === 10 ? 201 : 203 + (i - 11) * 2
    const pageEnd = i < 10 ? (i + 1) * 20 : i === 10 ? 202 : pageStart + 1
    const head = i === 0 ? 'الفصل الأول: الدراسة الضخمة' : i >= 10 ? `الفصل ${i - 8}: موضوع ${i}` : ''
    chunks.push(spanChunk(i, `${head ? head + '\n' : ''}نص المقطع ${i} في تحليل المنظمات وإدارة الأعمال المعاصرة.`, pageStart, pageEnd))
  }
  const chunkIds = new Map(chunks.map((entry) => [entry.index, `chunk-${entry.index}`]))
  const items = chunks.map((entry) => ({ chunkId: `chunk-${entry.index}`, title: `عنصر ${entry.index}`, summary: 'ملخص اختباري' }))
  const result = planBookOutline(chunks, items, chunkIds, 1, [], 'كتاب الاختبار')
  assert(result.sections.length <= 16, `سقف الأقسام يجب أن يبقى 16، وُجد ${result.sections.length}`)
  const huge = result.sections.find((section) => section.pageStart === 1)
  assert(huge && huge.pageEnd === 200, `القسم الضخم يجب أن ينتهي عند 200 لا أن يمتد بالدمج، انتهى عند ${huge?.pageEnd}`)
}

function testWordFormChaptersElevenAndTwelve() {
  // Regression: the ordinal alternatives string once lost its \s escapes, so
  // «الحادي عشر» never matched and «الثاني عشر» matched as chapter 2 — the
  // real chapter-12 boundary was then discarded as a duplicate of chapter 2
  // and its pages were silently absorbed by the previous section.
  const result = plan([
    chunk(0, 'الفصل الثاني: الأساسيات\nنص الفصل الثاني'),
    chunk(1, 'الفصل الحادي عشر: التطبيقات\nنص الفصل الحادي عشر'),
    chunk(2, 'الفصل الثاني عشر: دراسات حالة\nنص الفصل الثاني عشر'),
  ])
  assert(result.sections.length === 3, `الفصول 2 و11 و12 يجب أن تنتج 3 أقسام، وُجد ${result.sections.length}: ${titles(result)}`)
  assert(result.sections.some((s) => s.title.includes('الحادي عشر') && s.chunkStartIndex === 1), 'الفصل الحادي عشر يجب أن يظهر بقسمه المستقل')
  assert(result.sections.some((s) => s.title.includes('الثاني عشر') && s.chunkStartIndex === 2), 'الفصل الثاني عشر يجب ألا يُبتلع أو يُحسب فصلاً ثانياً مكرراً')
}

const tests = [
  testWordFormChaptersElevenAndTwelve,
  testGenericIntroductionRestoresLegacyAiFallback,
  testAiOutlineRejectsInvalidAndGenericSections,
  testLegacyOcrFallbackRemainsConnected,
  testReadChunksCreateOutlineWithoutReopeningPdf,
  testSubheadingReviewMarkers,
  testArticleHeadingsFromOriginalPdf,
  testOrdinaryLinesAreNotSections,
  testOriginalPdfChapterDetected,
  testReversedArabicChapterOrder,
  testArabicIndicDigitChapter,
  testTwoChaptersInSameChunk,
  testIntroAndMidChunkFirstChapter,
  testCoverageAuditFlagsMonsterTail,
  testGuardBandsAndGenuineLongChapter,
  testRefineSplitsMonsterFromDroppedSourceBoundaries,
  testSectionCapNeverExtendsLargestSpan,
]

;(async () => {
  for (const test of tests) {
    await test()
    console.log(`✓ ${test.name}`)
  }
})().catch((error) => { console.error(error); process.exit(1) })
