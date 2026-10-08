import { canReplaceDeleteUnit, planOutlineUnitsFromSections, summarizeReplaceUnitProtection, validateStudyGuideSources, validateUnitContentReferences } from '@/lib/outline-units'

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

const tests = [
  testApprovedUnitNotUpdatedOnRegenerate,
  testUnitContentRejectsOutsideChunkRange,
  testGuideWithoutSourceKnowledgeIdsRejected,
  testReplaceProtectionKeepsApprovedOutlineAndAttemptedUnits,
]

for (const test of tests) {
  test()
  console.log(`✓ ${test.name}`)
}
