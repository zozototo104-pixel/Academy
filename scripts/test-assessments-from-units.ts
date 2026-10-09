import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { canPublishUnitExamFromQuestions, selectUnitExamQuestionsApprovedFirst } from '../src/lib/unit-exam-policy'
import { hasSourceGroundedFlag, nextQuestionBankRetryAt, planQuestionBankJobManualReactivation, planQuestionBankSourceWindow, prepareMcqOptionsForStorage } from '../src/lib/question-bank-job'
import { parseGeneratedQuestionCandidates } from '../src/lib/question-bank-generation'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function src(path: string) {
  return readFileSync(path, 'utf8')
}

function routeFiles(dir = 'src/app/api'): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) return routeFiles(full)
    return entry === 'route.ts' ? [full] : []
  })
}

function generatedMcq(overrides: Record<string, unknown> = {}) {
  return {
    type: 'MCQ',
    text: 'ما المفهوم الرئيسي الذي يوضحه المصدر في هذا السؤال الأكاديمي؟',
    options: ['أ', 'ب', 'ج'],
    correctAnswer: 'أ',
    sourceEvidence: 'هذا اقتباس موثق ومباشر من المصدر التعليمي المعتمد للسؤال.',
    sourceIndex: 1,
    difficulty: 'MEDIUM',
    cognitiveSkill: 'UNDERSTAND',
    ...overrides,
  }
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

function testPausedFutureRetryManualReactivation() {
  const futureRetry = new Date(Date.now() + 24 * 60 * 60 * 1000)
  const plan = planQuestionBankJobManualReactivation({ status: 'PAUSED', requested: 4, retryAt: futureRetry }, 10, true)
  assert(plan.shouldUpdate, 'الضغط اليدوي يجب أن يعيد تفعيل job متوقف حتى لو retryAt في المستقبل')
  assert(plan.resetFailureCounter, 'إعادة التفعيل اليدوي يجب أن تصفر عداد الفشل المتتالي')
  assert(plan.status === 'QUEUED', 'job المتوقف يجب أن يعود إلى QUEUED عند الضغط اليدوي')
  assert(plan.retryAt === null, 'retryAt يجب أن يصبح null عند إعادة التفعيل اليدوي')
  assert(plan.requested === 10, 'requested يجب أن يرتفع إلى العدد المطلوب عند إعادة التفعيل')
}

function testEmptyBatchAdvancesQuestionBankCursor() {
  const planned = planQuestionBankSourceWindow(10, 0, 4)
  assert(planned.indexes.join(',') === '0,1,2,3', 'نافذة مصادر بنك الأسئلة يجب أن تبدأ من cursor الحالي')
  assert(planned.nextCursor === 4, 'دفعة بنك الأسئلة يجب أن تقدم cursor حتى لو لم تحفظ أسئلة')
  const code = src('src/lib/question-bank-job.ts')
  assert(code.indexOf('await saveJobCursor(job.id, window.nextCursor)') < code.indexOf("if (!rows.length) throw new Error('QUESTION_BANK_JOB_EMPTY_BATCH')"), 'يجب حفظ cursor قبل فشل الدفعة الفارغة')
}

function testVerifierRejectedQuestionIsNotSaved() {
  assert(!hasSourceGroundedFlag({ qualityFlags: ['NEEDS_REVIEW'] }), 'السؤال المرفوض من المحقق لا يجب اعتباره SOURCE_GROUNDED')
  assert(hasSourceGroundedFlag({ qualityFlags: ['SOURCE_GROUNDED'] }), 'السؤال المثبت فقط يحفظ كـ SOURCE_GROUNDED')
  const code = src('src/lib/question-bank-job.ts')
  assert(code.includes('const groundedQuestions = verified.filter(hasSourceGroundedFlag)'), 'يجب فلترة أسئلة verifier قبل الحفظ')
  assert(code.includes('for (const item of groundedQuestions)'), 'الحفظ يجب أن يمر فقط على الأسئلة المثبتة من verifier')
  assert(!code.includes("qualityFlags: ['SOURCE_LINKED', 'SOURCE_GROUNDED'"), 'ممنوع إضافة SOURCE_GROUNDED يدوياً عند الحفظ')
}

function testIncompleteMcqOptionsAreRejected() {
  const code = src('src/lib/question-bank-job.ts')
  assert(!code.includes('خيار أول'), 'لا يجب اختراع خيارات MCQ وهمية')
  assert(code.includes('MCQ_REQUIRES_AT_LEAST_3_OPTIONS'), 'أسئلة MCQ الناقصة يجب أن ترفض بسبب عدد الخيارات')
}

function testGeneratedQuestionsRequireExplicitEvidenceSkillAndDifficulty() {
  const code = src('src/lib/question-bank-job.ts')
  assert(!code.includes('raw.sourceEvidence || fallback.excerpt'), 'sourceEvidence الناقص لا يجب أن يُستبدل بالمقتطف أو الملخص')
  assert(!code.includes("raw.cognitiveSkill || 'UNDERSTAND'"), 'cognitiveSkill الناقص لا يجب أن يُستبدل بقيمة افتراضية')
  assert(!code.includes(": 'MEDIUM'"), 'difficulty الناقص لا يجب أن يُستبدل بقيمة افتراضية')
  assert(code.includes('SOURCE_EVIDENCE_REQUIRED'), 'يجب تسجيل سبب واضح عند غياب sourceEvidence')
  assert(code.includes('COGNITIVE_SKILL_REQUIRED'), 'يجب تسجيل سبب واضح عند غياب cognitiveSkill')
  assert(code.includes('DIFFICULTY_REQUIRED'), 'يجب تسجيل سبب واضح عند غياب difficulty')
}

function testPreviewPollingNudgesQuestionBankJob() {
  const statusRoute = src('src/app/api/admin/question-bank-jobs/[id]/route.ts')
  assert(statusRoute.includes('questionBankJobCanRunStep(job)'), 'مسار حالة job يجب أن يفحص إمكانية تشغيل خطوة عند polling')
  assert(statusRoute.includes('after(() => runQuestionBankGenerationJobStep'), 'مسار حالة job يجب أن يشغل خطوة خلفية واحدة في Preview')
  const unitRoute = src('src/app/api/admin/unit-exams/generate/route.ts')
  assert(unitRoute.includes('maxDuration = 300'), 'مسار توليد اختبار الوحدة يحتاج maxDuration أعلى من خطوة بنك الأسئلة')
  assert(unitRoute.includes('runQuestionBankGenerationJobStepsUntil'), 'ضغط زر الاختبار يجب أن يشغل runner متعدد الخطوات عبر after')
}

function testQuestionBankStepRoutesHaveMaxDuration() {
  const offenders = routeFiles()
    .map((file) => ({ file, code: src(file) }))
    .filter(({ code }) => code.includes('runQuestionBankGenerationJobStep'))
    .filter(({ code }) => {
      const match = code.match(/export const maxDuration\s*=\s*(\d+)/)
      return !match || Number(match[1]) < 120
    })
    .map(({ file }) => file)
  assert(offenders.length === 0, `كل route يستدعي runQuestionBankGenerationJobStep يحتاج maxDuration >= 120: ${offenders.join(', ')}`)
}

function testQuestionBankRetryAtNotBeyondOneHour() {
  const now = Date.now()
  const retry = nextQuestionBankRetryAt(now, 365 * 24 * 60 * 60 * 1000)
  assert(retry.getTime() - now <= 60 * 60 * 1000, 'retryAt لوظيفة بنك الأسئلة لا يجب أن يتجاوز ساعة')
}

const tests = [
  testUnitExamDoesNotFixCorrectAnswer,
  testUnitExamScopedToUnitQuestionBank,
  testAssignmentsAndGuidesNoFallbackTemplates,
  testComprehensiveExamCoversUnits,
  testUnitExamPendingReviewBlocksPublish,
  testUnitExamExcludesRejectedAndPrioritizesApproved,
  testPausedFutureRetryManualReactivation,
  testEmptyBatchAdvancesQuestionBankCursor,
  testVerifierRejectedQuestionIsNotSaved,
  testIncompleteMcqOptionsAreRejected,
  testGeneratedQuestionsRequireExplicitEvidenceSkillAndDifficulty,
  testPreviewPollingNudgesQuestionBankJob,
  testQuestionBankStepRoutesHaveMaxDuration,
  testQuestionBankRetryAtNotBeyondOneHour,
]

for (const test of tests) {
  test()
  console.log(`✓ ${test.name}`)
}
