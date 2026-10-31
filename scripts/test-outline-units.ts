import { canReplaceDeleteUnit, normalizeUnitSummaryAfterRetry, planOutlineUnitsFromSections, providerUnavailableStatus, summarizeReplaceUnitProtection, validateStudyGuideSources, validateUnitContentReferences } from '@/lib/outline-units'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function assertThrows(fn: () => unknown, message: string) {
  let thrown = false
  try { fn() } catch { thrown = true }
  assert(thrown, message)
}

function testApprovedUnitNotUpdatedOnRegenerate() {
  const actions = planOutlineUnitsFromSections({
    sections: [{ id: 'section-1', title: 'الفصل الأول: المدخل', level: 1, semester: 1, chunkStartIndex: 1, chunkEndIndex: 3, pageStart: 1, pageEnd: 12 }],
    existingUnits: [{ id: 'unit-1', outlineSectionId: 'section-1', status: 'APPROVED', order: 4, semester: 1, generationVersion: 7 }],
    currentMaxOrderBySemester: { 1: 4 },
    bookSemester: 1,
    regenerateDrafts: true,
  })
  assert(actions.length === 1, 'يجب أن تكون هناك حركة واحدة للقسم الموجود')
  assert(actions[0].action === 'skip-approved', 'وحدة APPROVED يجب ألا تتحول إلى update-draft عند إعادة التوليد')
}

function testUnitContentRejectsOutsideChunkRange() {
  assertThrows(() => validateUnitContentReferences([
    { heading: 'محور خارج النطاق', body: 'شرح يستند إلى صفحة 9 لكنه يشير إلى مقطع غير مسموح.', pageRefs: ['صفحة 9'], sourceChunkIndexes: [99], sourceKnowledgeIds: [] },
  ], ['k-1'], [1, 2, 3]), 'المحتوى الذي لا يملك مقطعاً أو عنصر معرفة داخل النطاق يجب أن يُرفض')

  const valid = validateUnitContentReferences([
    { heading: 'محور داخل النطاق', body: 'شرح تعليمي يستند إلى صفحة 2 داخل نطاق الوحدة ويحتفظ بالمرجع.', pageRefs: ['صفحة 2'], sourceChunkIndexes: [2], sourceKnowledgeIds: [] },
  ], ['k-1'], [1, 2, 3])
  assert(valid[0].sourceChunkIndexes?.[0] === 2, 'المقطع داخل النطاق يجب أن يبقى محفوظاً')
}

function testGuideWithoutSourceKnowledgeIdsRejected() {
  assertThrows(() => validateStudyGuideSources([], ['k-1', 'k-2']), 'دليل بلا sourceKnowledgeIds يجب أن يُرفض')
  assertThrows(() => validateStudyGuideSources(['outside'], ['k-1', 'k-2']), 'دليل بمصدر معرفة خارج النطاق يجب أن يُرفض')
  const ids = validateStudyGuideSources(['k-1', 'k-1', 'k-2'], ['k-1', 'k-2'])
  assert(ids.join(',') === 'k-1,k-2', 'يجب تنظيف وتوحيد sourceKnowledgeIds الصالحة')
}

function testReplaceProtectionKeepsApprovedOutlineAndAttemptedUnits() {
  const units = [
    { status: 'DRAFT', outlineSectionId: null, exam: null },
    { status: 'APPROVED', outlineSectionId: null, exam: null },
    { status: 'DRAFT', outlineSectionId: 'outline-section-1', exam: null },
    { status: 'DRAFT', outlineSectionId: null, exam: { _count: { attempts: 1 } } },
  ]
  assert(canReplaceDeleteUnit(units[0]), 'replace يجب أن يسمح بحذف مسودة عادية غير مرتبطة بالفهرس ولا محاولات لها')
  assert(!canReplaceDeleteUnit(units[1]), 'replace يجب ألا يحذف وحدة APPROVED')
  assert(!canReplaceDeleteUnit(units[2]), 'replace يجب ألا يحذف وحدة مرتبطة بـ outlineSectionId')
  assert(!canReplaceDeleteUnit(units[3]), 'replace يجب ألا يحذف وحدة لها ExamAttempt')
  const summary = summarizeReplaceUnitProtection(units)
  assert(summary.deleted === 1, 'replace يجب أن يعد وحدة واحدة فقط كقابلة للحذف')
  assert(summary.keptApproved === 1, 'replace يجب أن يحفظ وحدة APPROVED')
  assert(summary.keptOutline === 1, 'replace يجب أن يحفظ وحدة الفهرس')
  assert(summary.keptWithAttempts === 1, 'replace يجب أن يحفظ وحدة لها محاولات')
}

function errorWithStatus(status: number) {
  const error = new Error(`HTTP ${status}`) as Error & { status: number }
  error.status = status
  return error
}

function errorWithCode(message: string, code: string) {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

function testSummaryFallbackAndProviderClassification() {
  const longSummary = Array.from({ length: 172 }, (_, index) => `كلمة${index + 1}${index === 139 ? '.' : ''}`).join(' ')
  const trimmed = normalizeUnitSummaryAfterRetry(longSummary)
  assert(trimmed.split(/\s+/).length === 140, 'ملخص 172 كلمة يجب أن يُقص عند آخر جملة كاملة قبل 150 كلمة')
  assertThrows(() => normalizeUnitSummaryAfterRetry(Array.from({ length: 40 }, () => 'كلمة').join(' ')), 'ملخص 40 كلمة يجب أن يُرفض')

  assert(providerUnavailableStatus(errorWithStatus(429)), 'status=429 يجب أن يعتبر PAUSED')
  assert(providerUnavailableStatus(errorWithStatus(503)), 'status=503 يجب أن يعتبر PAUSED')
  assert(providerUnavailableStatus(new Error('GEMINI_NOT_CONFIGURED')), 'GEMINI_NOT_CONFIGURED يجب أن يعتبر PAUSED')
  assert(providerUnavailableStatus(new Error('AI_ACADEMIC_PROVIDER_UNAVAILABLE')), 'خطأ الراوتر الأكاديمي الثابت يجب أن يعتبر PAUSED')
  assert(providerUnavailableStatus(new Error('TEXT_AI_ROUTER_FAILED')), 'خطأ الراوتر العام الثابت يجب أن يعتبر PAUSED')
  assert(providerUnavailableStatus(new Error('PROVIDER_UNAVAILABLE')), 'عطل المزود الفعلي يجب أن يعتبر PAUSED')

  assert(!providerUnavailableStatus(new Error('UNIT_SUMMARY_OUT_OF_RANGE:wc=172')), 'خطأ طول ملخص الوحدة يجب أن يبقى FAILED')
  assert(!providerUnavailableStatus(new Error('UNIT_CONTENT_SECTION_MISSING_SOURCE_REFERENCE')), 'خطأ مرجع الوحدة لا يجب أن يعتبر PAUSED')
  assert(!providerUnavailableStatus(new Error('INVALID_JSON')), 'INVALID_JSON يجب أن يبقى FAILED لأنه خطأ تحقق')
  assert(!providerUnavailableStatus(errorWithCode('provider returned structurally invalid output', 'VALIDATION_REJECTED')), 'VALIDATION_REJECTED يجب أن يبقى FAILED حتى لو الرسالة عامة')
}

function testRebuildDoesNotDuplicateUnits() {
  // Outline v2 mints NEW section ids for the SAME chunk ranges v1 covered.
  const sections = [
    { id: 'v2-s1', title: 'الفصل الأول: المدخل', level: 1, semester: 1, chunkStartIndex: 0, chunkEndIndex: 4, pageStart: 1, pageEnd: 40 },
    { id: 'v2-s2', title: 'الفصل الثاني: التطبيق', level: 1, semester: 1, chunkStartIndex: 5, chunkEndIndex: 9, pageStart: 41, pageEnd: 90 },
  ]
  const existingUnits = [
    { id: 'unit-approved', outlineSectionId: 'v1-s1', status: 'APPROVED', order: 1, semester: 1, generationVersion: 3, chunkStartIndex: 0, chunkEndIndex: 4 },
    { id: 'unit-draft', outlineSectionId: 'v1-s2', status: 'DRAFT', order: 2, semester: 1, generationVersion: 1, chunkStartIndex: 5, chunkEndIndex: 9 },
  ]
  const kept = planOutlineUnitsFromSections({ sections, existingUnits, currentMaxOrderBySemester: { 1: 2 }, bookSemester: 1, regenerateDrafts: false })
  assert(!kept.some((a) => a.action === 'create'), 'إعادة بناء الفهرس بنفس النطاقات لا يجوز أن تنشئ أي وحدة جديدة')
  assert(kept.some((a) => a.action === 'skip-approved' && a.unitId === 'unit-approved'), 'الوحدة المعتمدة بنفس النطاق يجب أن تُحمى كما هي')
  assert(kept.some((a) => a.action === 'relink-draft' && a.unitId === 'unit-draft'), 'وحدة المسودة بنفس النطاق يجب أن تُعاد ربطها لا أن تُستبدل')
  const regenerated = planOutlineUnitsFromSections({ sections, existingUnits, currentMaxOrderBySemester: { 1: 2 }, bookSemester: 1, regenerateDrafts: true })
  assert(!regenerated.some((a) => a.action === 'create'), 'مع إعادة التوليد أيضاً لا وحدات مكررة')
  assert(regenerated.some((a) => a.action === 'skip-approved' && a.unitId === 'unit-approved'), 'المعتمدة لا تُحدَّث حتى مع إعادة التوليد')
  assert(regenerated.some((a) => a.action === 'update-draft' && a.unitId === 'unit-draft'), 'المسودة بنفس النطاق تُحدَّث عند طلب إعادة التوليد')
}

function testOverlapRequiresHumanReview() {
  const actions = planOutlineUnitsFromSections({
    sections: [{ id: 'v2-x', title: 'قسم متداخل', level: 1, semester: 1, chunkStartIndex: 3, chunkEndIndex: 7, pageStart: 30, pageEnd: 70 }],
    existingUnits: [{ id: 'unit-old', outlineSectionId: 'v1-x', status: 'DRAFT', order: 1, semester: 1, generationVersion: 1, chunkStartIndex: 5, chunkEndIndex: 9 }],
    currentMaxOrderBySemester: { 1: 1 },
    bookSemester: 1,
    regenerateDrafts: true,
  })
  assert(actions.length === 1 && actions[0].action === 'review-overlap', 'التداخل القوي غير التطابقي يجب أن يُرفع للمراجعة البشرية فقط')
  assert(!actions.some((a) => a.action === 'create'), 'لا إنشاء تلقائي فوق نطاق متداخل')
}

function testUnmatchedSectionStillCreatesAndUnitConsumedOnce() {
  const created = planOutlineUnitsFromSections({
    sections: [{ id: 'v2-new', title: 'قسم جديد كلياً', level: 1, semester: 1, chunkStartIndex: 20, chunkEndIndex: 24, pageStart: 200, pageEnd: 240 }],
    existingUnits: [{ id: 'unit-far', outlineSectionId: 'v1-far', status: 'DRAFT', order: 1, semester: 1, generationVersion: 1, chunkStartIndex: 0, chunkEndIndex: 4 }],
    currentMaxOrderBySemester: { 1: 1 },
    bookSemester: 1,
  })
  assert(created.length === 1 && created[0].action === 'create', 'قسم بلا أي وحدة سابقة يجب أن يُنشأ طبيعياً')
  const twice = planOutlineUnitsFromSections({
    sections: [
      { id: 'v2-a', title: 'قسم أ', level: 1, semester: 1, chunkStartIndex: 0, chunkEndIndex: 4, pageStart: 1, pageEnd: 40 },
      { id: 'v2-b', title: 'قسم ب', level: 1, semester: 1, chunkStartIndex: 0, chunkEndIndex: 4, pageStart: 1, pageEnd: 40 },
    ],
    existingUnits: [{ id: 'unit-only', outlineSectionId: 'v1-only', status: 'DRAFT', order: 1, semester: 1, generationVersion: 1, chunkStartIndex: 0, chunkEndIndex: 4 }],
    currentMaxOrderBySemester: { 1: 1 },
    bookSemester: 1,
  })
  assert(twice.filter((a) => a.action === 'relink-draft' || a.action === 'update-draft' || a.action === 'skip-draft').length === 1, 'الوحدة الواحدة لا تُستهلك إلا مرة واحدة')
}

function testSplitOldGiantBlocksEveryOverlappingNewUnit() {
  const sections = [
    { id: 'v2-a', title: 'استراتيجيات التخطيط', level: 1, semester: 1, chunkStartIndex: 5, chunkEndIndex: 10, pageStart: 51, pageEnd: 100 },
    { id: 'v2-b', title: 'الموارد البشرية', level: 1, semester: 1, chunkStartIndex: 11, chunkEndIndex: 16, pageStart: 101, pageEnd: 160 },
    { id: 'v2-c', title: 'قياس الأداء', level: 1, semester: 1, chunkStartIndex: 17, chunkEndIndex: 28, pageStart: 161, pageEnd: 297 },
  ]
  const existingUnits = [{ id: 'old-giant', outlineSectionId: 'v1-giant', status: 'DRAFT', order: 17, semester: 1, chunkStartIndex: 5, chunkEndIndex: 28 }]
  const actions = planOutlineUnitsFromSections({ sections, existingUnits, currentMaxOrderBySemester: { 1: 17 }, bookSemester: 1 })
  assert(actions.length === 3, 'يجب فحص الأقسام الثلاثة')
  assert(!actions.some((action) => action.action === 'create'), 'ممنوع إعادة إنشاء وحدات فوق نطاق الوحدة 17')
  assert(actions.every((action) => action.action === 'review-overlap'), 'الوحدة القديمة الكبيرة تمنع إنشاء أي قسم جديد متداخل معها، لا الأول فقط')
}

function testSmallIntersectionAlsoRequiresReview() {
  const actions = planOutlineUnitsFromSections({
    sections: [{ id: 'new', title: 'وحدة جديدة', level: 1, chunkStartIndex: 15, chunkEndIndex: 24, pageStart: 150, pageEnd: 240 }],
    existingUnits: [{ id: 'existing', outlineSectionId: 'old', status: 'APPROVED', order: 1, semester: 1, chunkStartIndex: 10, chunkEndIndex: 15 }],
    currentMaxOrderBySemester: { 1: 1 },
  })
  assert(actions.length === 1 && actions[0].action === 'review-overlap', 'حتى اشتراك مقطع واحد مع وحدة معتمدة يمنع إنشاء نسخة متداخلة')
}

function testBothUnitCreationEndpointsBlockOverlaps() {
  const fs = require('node:fs') as typeof import('node:fs')
  const primary = fs.readFileSync('src/app/api/admin/program-units/suggest/route.ts', 'utf8')
  const perBook = fs.readFileSync('src/app/api/admin/books/[id]/outline/units/route.ts', 'utf8')
  assert(primary.includes("code: 'OUTLINE_UNIT_OVERLAP_REVIEW_REQUIRED'"), 'زر توليد الوحدات الأساسي يجب أن يمنع التداخل قبل الحفظ')
  assert(primary.includes('const plans: Array<'), 'المسار الأساسي يجب أن يجمع خطة الكتب كاملة قبل الكتابة')
  assert(primary.includes('db.bookOutlineSection.findMany'), 'يجب تحميل أقسام الفهارس التاريخية')
  assert(primary.includes("action.action === 'relink-draft'"), 'إعادة الربط الآمن يجب أن تكون موصولة بالمسار الأساسي')
  assert(perBook.includes("code: 'OUTLINE_UNIT_OVERLAP_REVIEW_REQUIRED'"), 'المسار الفردي يجب أن يمنع التداخل أيضاً')
}

const tests = [
  testSplitOldGiantBlocksEveryOverlappingNewUnit,
  testSmallIntersectionAlsoRequiresReview,
  testBothUnitCreationEndpointsBlockOverlaps,
  testSummaryFallbackAndProviderClassification,
  testApprovedUnitNotUpdatedOnRegenerate,
  testUnitContentRejectsOutsideChunkRange,
  testGuideWithoutSourceKnowledgeIdsRejected,
  testReplaceProtectionKeepsApprovedOutlineAndAttemptedUnits,
  testRebuildDoesNotDuplicateUnits,
  testOverlapRequiresHumanReview,
  testUnmatchedSectionStillCreatesAndUnitConsumedOnce,
]

for (const test of tests) {
  test()
  console.log(`✓ ${test.name}`)
}
