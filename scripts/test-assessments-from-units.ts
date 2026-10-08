import { readFileSync } from 'fs'

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
