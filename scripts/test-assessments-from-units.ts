import { readFileSync } from 'fs'
import { canPublishUnitExamFromQuestions, selectUnitExamQuestionsApprovedFirst } from '../src/lib/unit-exam-policy'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function src(path: string) {
  return readFileSync(path, 'utf8')
}

function testUnitExamDoesNotFixCorrectAnswer() {
  const code = src('src/app/api/admin/unit-exams/generate/route.ts')
  assert(!code.includes('function buildQuestions'), 'اختبار الوحدة يجب ألا يستخدم buildQuestions القالبية')
  assert(!/correctAnswer\s*:\s*['"]0['"][,}]/.test(code), 'اختبار الوحدة يجب ألا يثبت correctAnswer دائماً على 0')
  assert(code.includes('shuffleWithAnswer'), 'اختبار الوحدة يجب أن يخلط الخيارات ويعيد حساب correctAnswer')
}

function testUnitExamScopedToUnitQuestionBank() {
  const code = src('src/app/api/admin/unit-exams/generate/route.ts')
  assert(code.includes('ensureQuestionBankGenerationJob({ programId, unitId'), 'اختبار الوحدة يجب أن يشغل وظيفة بنك الأسئلة بنطاق unitId عند النقص')
  assert(/where:\s*\{\s*programId,\s*unitId/.test(code), 'اختبار الوحدة يجب أن يقرأ أسئلة بنك الأسئلة الخاصة بالوحدة فقط')
  assert(!code.includes('book.textContent') && !code.includes('generateExamQuestionBatch'), 'اختبار الوحدة لا يجب أن يستخدم نص الكتاب أو مولد الامتحان القديم')
}

function testAssignmentsAndGuidesNoFallbackTemplates() {
  const assignments = src('src/app/api/admin/assignments/suggest/route.ts')
  const guides = src('src/app/api/admin/study-guides/route.ts')
  assert(!assignments.includes('fallbackSuggestions'), 'الواجبات لا يجب أن تنتج قوالب fallback عند فشل AI')
  assert(!assignments.includes('ensureProgramKnowledge'), 'الواجبات لا يجب أن تبني v1 عبر ensureProgramKnowledge')
  assert(!assignments.includes('geminiCompleteJson') && !assignments.includes('chatWithRetry'), 'الواجبات يجب أن تستخدم الراوتر الأكاديمي لا Gemini/ZAI مباشرة')
  assert(!guides.includes('domainTermsForGuide') && !guides.includes('fallbackGuideSections'), 'الأدلة العامة لا يجب أن تحتوي مصطلحات/قوالب ثابتة')
  assert(!guides.includes('ensureProgramKnowledge'), 'الأدلة العامة لا يجب أن تبني v1 عبر ensureProgramKnowledge')
  assert(guides.includes('STUDY_GUIDE_REQUIRES_SOURCE_KNOWLEDGE_IDS'), 'الأدلة العامة يجب أن تلزم sourceKnowledgeIds')
}

function testComprehensiveExamCoversUnits() {
  const code = src('src/app/api/admin/program-exams/generate/route.ts')
  assert(code.includes('unitsForExam'), 'الامتحان العام يجب أن يبدأ من الوحدات')
  assert(code.includes('comprehensive ? {} : { semester }'), 'الامتحان الشامل يجب أن يغطي كل الوحدات لا فصل واحد فقط')
  assert(code.includes('unitBreakdown'), 'رد التوليد يجب أن يعرض توزيع الأسئلة لكل وحدة')
  assert(!code.includes('book.textContent') && !code.includes('examSourceBooks') && !code.includes('generateExamQuestionBatch'), 'الامتحان العام لا يجب أن يستخدم book.textContent أو exam-source-chunks')
}

function testUnitExamPendingReviewBlocksPublish() {
  const selection = selectUnitExamQuestionsApprovedFirst([
    { id: 'approved-1', status: 'APPROVED', qualityFlags: '["SOURCE_GROUNDED"]' },
    { id: 'pending-1', status: 'PENDING_REVIEW', qualityFlags: '["SOURCE_GROUNDED"]' },
  ], 2)
  assert(selection.readyToBuild, 'اختبار الوحدة يجب أن يبنى عند اكتمال الحد الأدنى من approved + pending')
  assert(!selection.publishable, 'اختبار الوحدة الذي يحتوي PENDING_REVIEW يجب ألا يكون قابلاً للنشر')
  assert(!canPublishUnitExamFromQuestions([{ text: '【يحتاج مراجعة】 سؤال غير معتمد' }]), 'نشر اختبار يحتوي شارة يحتاج مراجعة يجب أن يُمنع')
}

function testUnitExamExcludesRejectedAndPrioritizesApproved() {
  const selection = selectUnitExamQuestionsApprovedFirst([
    { id: 'pending-1', status: 'PENDING_REVIEW', qualityFlags: '["SOURCE_GROUNDED"]' },
    { id: 'rejected-1', status: 'REJECTED', qualityFlags: '["SOURCE_GROUNDED"]' },
    { id: 'approved-1', status: 'APPROVED', qualityFlags: '["SOURCE_GROUNDED"]' },
    { id: 'approved-2', status: 'APPROVED', qualityFlags: '["SOURCE_GROUNDED"]' },
  ], 3)
  assert(!selection.selectedIds.includes('rejected-1'), 'اختبار الوحدة يجب ألا يختار أسئلة REJECTED')
  assert(selection.selectedIds[0] === 'approved-1' && selection.selectedIds[1] === 'approved-2', 'اختبار الوحدة يجب أن يعطي الأولوية دائماً للأسئلة APPROVED')
  assert(selection.pendingReviewCount === 1, 'يجب استخدام PENDING_REVIEW فقط لاستكمال النقص بعد APPROVED')
}

const tests = [
  testUnitExamDoesNotFixCorrectAnswer,
  testUnitExamScopedToUnitQuestionBank,
  testAssignmentsAndGuidesNoFallbackTemplates,
  testComprehensiveExamCoversUnits,
]

for (const test of tests) {
  test()
  console.log(`✓ ${test.name}`)
}
