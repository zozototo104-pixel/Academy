import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { canPublishUnitExamFromQuestions, selectUnitExamQuestionsApprovedFirst } from '../src/lib/unit-exam-policy'
import { assertGeneratedBatchHasAcceptedCandidates, hasSourceGroundedFlag, nextQuestionBankRetryAt, planQuestionBankJobManualReactivation, planQuestionBankSourceWindow, prepareMcqOptionsForStorage } from '../src/lib/question-bank-job'
import { parseGeneratedQuestionCandidates } from '../src/lib/question-bank-generation'
import { __testAcademicBackfillDataForTests, __testProgramExamAutoStatusUpdateWhereForTests, __testProgramQuestionAcademicCopyForTests, __testQualifiedQuestionBankItemForProgramExamForTests } from '../src/lib/program-exam-assembly'
import { calculateProgramExamAcademicMissingCounts, validateProgramExamPublicationReadiness } from '../src/lib/program-exam-publication-readiness'
import { __testDocumentedBankQuestionForPublicationForTests, __testParseBankDocAiRowsForTests, selectBankItemsNeedingDocumentation } from '../src/lib/question-bank-documentation'
import { buildAdminStudentsEnrollmentRelationFilter, OPEN_ENROLLMENT_STATUSES } from '../src/lib/enrollment-status'
import { __testApproveQuestionBankQualityFlagsForTests, __testOrderQuestionBankItemsForReviewForTests } from '../src/app/api/admin/question-bank/route'
import { validateCognitiveDistribution } from '../src/lib/exam-cognitive-policy'
import { balanceQuestionBankExamSelection } from '../src/lib/question-bank-exam-balance'
import { resolveUnitQuestionBankJobStatus } from '../src/lib/unit-question-bank-status'
import { isTransientBookReadError, planBookReadJobResume } from '../src/lib/book-read-job-control'
import { pagesNeedingOcr } from '../src/lib/book-reader'

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

function generatedOpenQuestion(type: 'SHORT' | 'ESSAY', modelAnswer: string, overrides: Record<string, unknown> = {}) {
  return {
    type,
    text: 'ما النتيجة المباشرة التي يذكرها المصدر في هذا السياق التعليمي؟',
    options: [],
    sourceEvidence: 'هذا اقتباس موثق ومباشر من المصدر التعليمي المعتمد للسؤال.',
    sourceIndex: 1,
    difficulty: 'MEDIUM',
    cognitiveSkill: 'UNDERSTAND',
    modelAnswer,
    ...overrides,
  }
}

function generatedTf(overrides: Record<string, unknown> = {}) {
  return {
    type: 'TF',
    text: 'يوفر الدليل إطاراً لدعم الأفراد بطرق تراعي كرامتهم وثقافتهم وقدراتهم.',
    options: ['صح', 'خطأ'],
    correctAnswer: 'صح',
    sourceEvidence: 'يوفر الدليل إطاراً لدعم الأفراد بطرق تراعي كرامتهم وثقافتهم وقدراتهم.',
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
  const route = src('src/app/api/admin/program-exams/generate/route.ts')
  const assembly = src('src/lib/program-exam-assembly.ts')
  assert(route.includes('advanceProgramExamFromVerifiedBank'), 'مسار توليد الامتحان يجب أن يستخدم التجميع الموثق من بنك الأسئلة')
  assert(assembly.includes('db.unit.findMany') && assembly.includes('programId: exam.programId'), 'الامتحان العام يجب أن يبدأ من وحدات البرنامج')
  assert(assembly.includes('exam.semester === 3 ? {} : { semester: exam.semester }'), 'الامتحان الشامل يجب أن يغطي الوحدات من جميع الفصول')
  assert(assembly.includes('loadUnitPools(exam.programId, units)'), 'يجب أن يجلب الأسئلة بنطاق وحدات البرنامج')
  assert(assembly.includes('byUnit[next.unitId]') && assembly.includes('unitDiff'), 'يجب أن يوازن اختيار الأسئلة بين الوحدات')
  assert(assembly.includes('unitBreakdown') && assembly.includes('questionCount: result.byUnit[unit.id]'), 'رد التوليد يجب أن يعرض توزيع الأسئلة لكل وحدة')
  assert(!route.includes('book.textContent') && !route.includes('examSourceBooks') && !route.includes('generateExamQuestionBatch') && !assembly.includes('book.textContent') && !assembly.includes('generateExamQuestionBatch'), 'الامتحان العام لا يجب أن يستخدم نص الكتاب الخام أو المولد القديم')
}

function testUnitExamPendingReviewBlocksPublish() {
  const selection = selectUnitExamQuestionsApprovedFirst([
    { id: 'approved-1', status: 'APPROVED', qualityFlags: '["SOURCE_GROUNDED"]' },
    { id: 'pending-1', status: 'PENDING_REVIEW', qualityFlags: '["SOURCE_GROUNDED"]' },
  ], 2)
  assert(!selection.readyToBuild, 'اختبار الوحدة يجب ألا يبنى حتى يكتمل الحد الأدنى من APPROVED فقط')
  assert(!selection.publishable, 'اختبار الوحدة الذي ينقصه APPROVED يجب ألا يكون قابلاً للنشر حتى لو وُجدت PENDING_REVIEW')
  assert(selection.pendingReviewCount === 1, 'أسئلة PENDING_REVIEW يجب أن تبقى محسوبة للمراجعة فقط')
  assert(selection.currentEligibleCount === 1, 'العدد المؤهل للبناء يجب أن يحسب APPROVED فقط')
  assert(!selection.selectedIds.includes('pending-1'), 'أسئلة PENDING_REVIEW يجب ألا تدخل selectedIds')
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

function testQuestionBankCompletedJobDoesNotBlockQueue() {
  const code = src('src/lib/question-bank-job.ts')
  assert(code.includes('questionBankJobRequestedTarget'), 'تشغيل بنك الأسئلة يجب أن يحسب المطلوب الفعلي للوحدة')
  assert(code.includes('if (job.saved >= requested)'), 'job مكتمل saved >= requested يجب أن يعالج قبل تشغيل خطوة جديدة')
  assert(code.includes("status: 'COMPLETED'") && code.includes('continue'), 'job مكتمل يجب أن يتحول إلى COMPLETED ثم يتخطى للوظيفة التالية')
}

function testQuestionBankLockedJobDoesNotBlockQueue() {
  const code = src('src/lib/question-bank-job.ts')
  assert(code.includes('lockedUntil: { lt: now }'), 'اختيار job التالي يجب أن يستبعد jobs المقفلة حتى المستقبل')
  assert(code.includes("{ status: 'PAUSED', retryAt: { lte: now } }") && code.includes("{ status: 'PAUSED', OR: runnableRetry }"), 'PAUSED بلا retryAt يجب ألا تعمل مع queuedOnly وأن تبقى مسموحة يدوياً بدون queuedOnly')
  assert(code.includes('new Date(result.updatedAt).getTime() === new Date(job.updatedAt).getTime()') && code.includes('questionBankJobHasActiveLock(result)') && code.includes('continue'), 'فشل claim أو القفل الفعال فقط يجب أن يتخطى الوظيفة')
  assert(!code.includes('result.saved === job.saved && (result.status === job.status'), 'بعد خطوة فعلية يجب إرجاع النتيجة حتى لو لم يزد saved')
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

function testMcqThreeOptionsAccepted() {
  const parsed = parseGeneratedQuestionCandidates(JSON.stringify([generatedMcq({ options: ['الأول', 'الثاني', 'الثالث'], correctAnswer: '2' })]))
  assert(parsed.accepted.length === 1, 'سؤال MCQ بثلاثة خيارات يجب أن يُقبل')
}

function testMcqFiveOptionsKeepsFifthCorrectAnswer() {
  const parsed = parseGeneratedQuestionCandidates(JSON.stringify([generatedMcq({ options: ['أ', 'ب', 'ج', 'د', 'هـ'], correctAnswer: 'هـ' })]))
  assert(parsed.accepted.length === 1, 'سؤال MCQ بخمسة خيارات وجواب نصي صحيح يجب أن يُقبل')
  const reduced = prepareMcqOptionsForStorage(['أ', 'ب', 'ج', 'د', 'هـ'], 'هـ')
  assert(reduced.options.length === 4, 'سؤال MCQ بخمسة خيارات يجب أن يُختصر إلى أربعة خيارات عند التخزين')
  assert(reduced.options.includes('هـ'), 'الجواب الصحيح الخامس يجب أن يبقى ضمن الخيارات المخزنة')
  assert(reduced.correctAnswer != null && reduced.options[Number(reduced.correctAnswer)] === 'هـ', 'رقم correctAnswer يجب أن يشير إلى الخيار الصحيح بعد الاختصار')
}

function testMcqTwoOptionsRejectedWithReason() {
  const parsed = parseGeneratedQuestionCandidates(JSON.stringify([generatedMcq({ options: ['أ', 'ب'], correctAnswer: 'أ' })]))
  assert(parsed.accepted.length === 0, 'سؤال MCQ بخيارين يجب أن يُرفض')
  assert(parsed.rejectedReasons.includes('MCQ_REQUIRES_AT_LEAST_3_OPTIONS'), 'سبب رفض خيارين يجب أن يكون MCQ_REQUIRES_AT_LEAST_3_OPTIONS')
}

function testMcqDuplicateOptionsRejectedWithReason() {
  const parsed = parseGeneratedQuestionCandidates(JSON.stringify([generatedMcq({ options: ['أ', 'أ', 'ج'], correctAnswer: 'أ' })]))
  assert(parsed.accepted.length === 0, 'سؤال MCQ بخيارات مكررة يجب أن يُرفض')
  assert(parsed.rejectedReasons.includes('MCQ_DUPLICATE_OPTIONS'), 'سبب رفض التكرار يجب أن يكون MCQ_DUPLICATE_OPTIONS')
}

function testArabicCognitiveSkillAnalyzeNormalizes() {
  const parsed = parseGeneratedQuestionCandidates(JSON.stringify([generatedMcq({ cognitiveSkill: 'تحليل' })]))
  assert(parsed.accepted.length === 1, 'المهارة المعرفية العربية تحليل يجب أن تُقبل')
  assert(parsed.accepted[0].cognitiveSkill === 'ANALYZE', 'تحليل يجب أن تتحول إلى ANALYZE')
}

function testExpandedCognitiveSkillAliasesNormalize() {
  const parsed = parseGeneratedQuestionCandidates(JSON.stringify([
    generatedMcq({ cognitiveSkill: 'معرفة' }),
    generatedMcq({ cognitiveSkill: 'استيعاب' }),
    generatedMcq({ cognitiveSkill: 'Comprehension' }),
  ]))
  assert(parsed.accepted.length === 3, 'مرادفات المهارة المعرفية الجديدة يجب أن تُقبل')
  assert(parsed.accepted[0].cognitiveSkill === 'REMEMBER', 'معرفة يجب أن تتحول إلى REMEMBER')
  assert(parsed.accepted[1].cognitiveSkill === 'UNDERSTAND', 'استيعاب يجب أن تتحول إلى UNDERSTAND')
  assert(parsed.accepted[2].cognitiveSkill === 'UNDERSTAND', 'Comprehension يجب أن تتحول إلى UNDERSTAND')
}

function testShortConciseAnswerAccepted() {
  const parsed = parseGeneratedQuestionCandidates(JSON.stringify([generatedOpenQuestion('SHORT', '27 مستجيباً')]))
  assert(parsed.accepted.length === 1, 'سؤال SHORT بإجابة نموذجية قصيرة يجب أن يُقبل')
}

function testTfArabicCorrectAnswerAliasesNormalize() {
  const parsed = parseGeneratedQuestionCandidates(JSON.stringify([generatedTf({ correctAnswer: 'صحيح' })]))
  assert(parsed.accepted.length === 1, 'إجابة TF بقيمة صحيح يجب أن تُقبل')
  assert(parsed.accepted[0].correctAnswer === 'صح', 'صحيح يجب أن تتحول إلى صح')
}

function testTfNumericAnswerUsesGeneratedOptionIndex() {
  const zeroTrue = parseGeneratedQuestionCandidates(JSON.stringify([generatedTf({ options: ['صح', 'خطأ'], correctAnswer: 0 })]))
  const oneFalse = parseGeneratedQuestionCandidates(JSON.stringify([generatedTf({ options: ['صح', 'خطأ'], correctAnswer: 1 })]))
  const zeroFalse = parseGeneratedQuestionCandidates(JSON.stringify([generatedTf({ options: ['خطأ', 'صح'], correctAnswer: 0 })]))
  assert(zeroTrue.accepted[0]?.correctAnswer === 'صح', 'correctAnswer=0 مع خيارات صح/خطأ يجب أن يعني صح')
  assert(oneFalse.accepted[0]?.correctAnswer === 'خطأ', 'correctAnswer=1 مع خيارات صح/خطأ يجب أن يعني خطأ')
  assert(zeroFalse.accepted[0]?.correctAnswer === 'خطأ', 'correctAnswer=0 يجب أن يتبع ترتيب خيارات الموديل نفسه')
}

function testUnitExamTfOptionsStayStable() {
  const code = src('src/app/api/admin/unit-exams/generate/route.ts')
  assert(code.includes("options: JSON.stringify(['صح', 'خطأ'])"), 'اختبار الوحدة يجب أن يخزن خيارات TF دائماً بترتيب صح ثم خطأ')
  assert(!code.includes("shuffleWithAnswer(['صح', 'خطأ']"), 'اختبار الوحدة يجب ألا يخلط خيارات TF')
}

function testEssayShortAnswerRejected() {
  const parsed = parseGeneratedQuestionCandidates(JSON.stringify([generatedOpenQuestion('ESSAY', 'قصير جداً')]))
  assert(parsed.accepted.length === 0, 'سؤال ESSAY بإجابة أقل من 40 حرفاً يجب أن يُرفض')
}

function testAllStructurallyRejectedBatchThrows() {
  const parsed = parseGeneratedQuestionCandidates(JSON.stringify([generatedMcq({ options: ['أ', 'ب'], correctAnswer: 'أ' })]))
  let thrown = false
  try {
    assertGeneratedBatchHasAcceptedCandidates(parsed)
  } catch (error) {
    thrown = error instanceof Error && error.message === 'QUESTION_BATCH_ALL_STRUCTURALLY_REJECTED'
  }
  assert(thrown, 'دفعة كل أسئلتها مرفوضة بنيوياً يجب أن ترمي QUESTION_BATCH_ALL_STRUCTURALLY_REJECTED')
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

function testQuestionBankJobCompletesWithSharedSelector() {
  const statusRoute = src('src/app/api/admin/question-bank-jobs/[id]/route.ts')
  assert(statusRoute.includes('selectUnitExamQuestionsApprovedFirst'), 'حالة job يجب أن تستخدم نفس selector الخاص ببناء اختبار الوحدة')
  assert(statusRoute.includes('selection.readyToBuild') && statusRoute.includes("status: 'COMPLETED'"), 'عند readyToBuild يجب تعليم job كـ COMPLETED')
  assert(statusRoute.includes('!activeLock'), 'لا يجب تعليم job كـ COMPLETED أثناء وجود lock فعّال')
  const ui = src('src/components/aact/AdminBooks.tsx')
  assert(ui.includes("unit.questionBankJob?.readyToBuild") && ui.includes('بناء الاختبار الآن'), 'زر الوحدة يجب أن يتحول إلى بناء الاختبار الآن عند readyToBuild')
}

function testLateQuestionBankStepDoesNotReopenCompleted() {
  const code = src('src/lib/question-bank-job.ts')
  const protectedUpdates = (code.match(/status:\s*\{\s*not:\s*'COMPLETED'\s*\}/g) || []).length
  assert(protectedUpdates >= 2, 'نجاح أو فشل خطوة متأخرة لا يجب أن يغير job مكتمل')
}

function testUnitQuestionsApiScopesToSingleUnit() {
  const code = src('src/app/api/admin/units/[id]/questions/route.ts')
  assert(code.includes('where: { unitId: unit.id }'), 'أسئلة لوحة الوحدة يجب أن تقرأ unitId المحدد فقط')
  assert(code.includes('selectUnitExamQuestionsApprovedFirst'), 'جاهزية أسئلة الوحدة يجب أن تستخدم نفس selector')
}

function testUnitQuestionsApiHydratesKnowledgePages() {
  const code = src('src/app/api/admin/units/[id]/questions/route.ts')
  assert(code.includes('knowledgeItemId: true'), 'API أسئلة الوحدة يجب أن يقرأ knowledgeItemId من السؤال')
  assert(code.includes('db.bookKnowledgeItem.findMany'), 'API أسئلة الوحدة يجب أن يجلب عناصر المعرفة باستعلام واحد')
  assert(code.includes('select: { id: true, pageStart: true, pageEnd: true, title: true }'), 'استعلام عناصر المعرفة يجب أن يختار الحقول الموجودة فقط')
  assert(code.includes('pageStart: knowledge?.pageStart ?? null'), 'السؤال المرتبط بعنصر معرفة يجب أن يأخذ pageStart من عنصر المعرفة')
  assert(code.includes('pageEnd: knowledge?.pageEnd ?? null'), 'السؤال المرتبط بعنصر معرفة يجب أن يأخذ pageEnd من عنصر المعرفة')
  assert(code.includes('knowledgeTitle: knowledge?.title ?? null'), 'السؤال المرتبط بعنصر معرفة يجب أن يرجع عنوان عنصر المعرفة')
}

function testUnitQuestionPagesFallbackToLocator() {
  const api = src('src/app/api/admin/units/[id]/questions/route.ts')
  const ui = src('src/components/aact/AdminBooks.tsx')
  assert(api.includes('pageStart: knowledge?.pageStart ?? null') && api.includes('pageEnd: knowledge?.pageEnd ?? null'), 'السؤال بدون knowledgeItemId يجب أن يرجع صفحات null بدون كسر')
  assert(ui.includes('sourceReference') && ui.includes('q.sourceLocator ||'), 'الواجهة يجب أن تعرض sourceLocator عندما لا توجد صفحات')
  assert(ui.includes('صفحات ${q.pageStart}–${q.pageEnd}') && ui.includes('صفحة ${q.pageStart}'), 'الواجهة يجب أن تعرض صفحة X أو صفحات X–Y')
}

function testUnitQuestionJobRequestedCanShrink() {
  const code = src('src/lib/question-bank-job.ts')
  assert(code.includes('const requested = params.unitId ? unitExamRequiredQuestions(params.requested)'), 'مهام الوحدة يجب أن تخزن العدد المطلوب من helper الموحد')
  assert(code.includes('existing.requested !== requested'), 'لو job وحدة موجود بعدد مختلف يجب تحديث requested للعدد الجديد')
  assert(code.includes('requested,\n              status:'), 'تحديث job الوحدة يجب أن يكتب requested الجديد مباشرة')
}

function testProgramQuestionJobRequestedKeepsOldMaxBehavior() {
  const code = src('src/lib/question-bank-job.ts')
  assert(code.includes('planQuestionBankJobManualReactivation(existing, requested'), 'مهام البرنامج يجب أن تبقى تستخدم مخطط max القديم')
  assert(code.includes('Math.max(job.requested || 0, requested)'), 'مخطط مهام البرنامج يجب أن يبقي requested الأكبر كما كان')
}

function testDraftExamCanBeRebuiltReadyAfterApprovals() {
  const unitRoute = src('src/app/api/admin/unit-exams/generate/route.ts')
  const ui = src('src/components/aact/AdminBooks.tsx')
  assert(unitRoute.includes("const examStatus = reviewRequired ? 'DRAFT' : 'READY'"), 'إعادة بناء الاختبار من أسئلة معتمدة يجب أن يحوله إلى READY')
  assert(ui.includes('تحديث الاختبار ونشره') && ui.includes('draftPendingCount === 0'), 'لوحة الوحدة يجب أن تعرض تحديث الاختبار ونشره بعد اعتماد كل الأسئلة')
}

function testQuestionBankSanitizesTfBeforeNumericValidation() {
  const code = src('src/lib/question-bank-job.ts')
  const tfNormalizeIndex = code.indexOf("type === 'TF' && correctAnswer != null")
  const numericValidationIndex = code.indexOf('Number.isNaN(Number(correctAnswer))')
  assert(tfNormalizeIndex >= 0 && numericValidationIndex >= 0 && tfNormalizeIndex < numericValidationIndex, 'تحويل إجابة TF النصية إلى 0/1 يجب أن يحدث قبل التحقق الرقمي')
  for (const word of ['صح', 'صحيح', 'true', 'خطأ', 'خطا', 'خاطئ', 'false']) assert(code.includes(word), `sanitizeQuestion يجب أن يدعم مرادف TF: ${word}`)
  assert(code.includes('TF_ANSWER_REQUIRED'), 'أسئلة TF التي تبقى بلا correctAnswer صالح يجب أن تُرفض')
}

function testExamTimingUsesStartedAtNotClientDuration() {
  const detail = src('src/app/api/program-exam/detail/route.ts')
  const start = src('src/app/api/program-exam/start/route.ts')
  const submit = src('src/app/api/program-exam/submit/route.ts')
  assert(start.includes("status: 'STARTED'") && start.includes('startedAt: now'), 'بدء الامتحان يجب أن يسجل startedAt على الخادم من مسار start الصريح')
  assert(submit.includes('startedAttempt.startedAt') && submit.includes('(exam.durationMin + 2)'), 'التسليم يجب أن يتحقق من startedAt ومدة الامتحان مع دقيقتي سماح')
  assert(start.includes("status: 'EXPIRED'") && detail.includes('انتهى الوقت دون تسليم'), 'المحاولة STARTED المنتهية يجب أن تتحول إلى EXPIRED وتظهر بتسمية واضحة')
  assert(submit.includes("status: 'EXPIRED'") && submit.includes('انتهى وقت هذه المحاولة'), 'تسليم محاولة EXPIRED يجب أن يرجع 409 برسالة واضحة')
  assert(submit.includes('serverDurationUsedMin'), 'مدة الاستخدام يجب أن تحسب من الخادم لا من المتصفح')
}

function testBookReplacementProtectedWhenUnitsLinked() {
  const books = src('src/app/api/admin/books/route.ts')
  const chunkUpload = src('src/app/api/admin/books/upload-chunk/route.ts')
  assert(books.includes("sourceBookId: bookId") && books.includes('الكتاب مربوط بوحدات'), 'تغيير ملف كتاب مربوط بوحدات يجب أن يُرفض')
  assert(chunkUpload.includes("sourceBookId: bookId") && chunkUpload.includes('الكتاب مربوط بوحدات'), 'الرفع المجزأ لكتاب مربوط بوحدات يجب أن يُرفض')
}

function testQuestionBankPatchValidatesCorrectAnswer() {
  const code = src('src/app/api/admin/question-bank/route.ts')
  assert(code.includes('خيارات الاختيار المتعدد يجب أن تكون بين 3 و6'), 'PATCH بنك الأسئلة يجب أن يتحقق من عدد خيارات MCQ')
  assert(code.includes('الإجابة الصحيحة خارج نطاق الخيارات'), 'PATCH بنك الأسئلة يجب أن يرفض correctAnswer خارج خيارات MCQ')
  assert(code.includes('إجابة صح/خطأ يجب أن تكون 0 أو 1'), 'PATCH بنك الأسئلة يجب أن يرفض TF correctAnswer غير 0/1')
}

function testQuestionBankRetryAtNotBeyondOneHour() {
  const now = Date.now()
  const retry = nextQuestionBankRetryAt(now, 365 * 24 * 60 * 60 * 1000)
  assert(retry.getTime() - now <= 60 * 60 * 1000, 'retryAt لوظيفة بنك الأسئلة لا يجب أن يتجاوز ساعة')
}

function testProgramExamCopiesAcademicSourceFields() {
  const copied = __testProgramQuestionAcademicCopyForTests({
    bookTitle: 'كتاب إدارة الأزمات',
    knowledgeTitle: 'التخطيط للأزمات',
    pageStart: 12,
    pageEnd: 14,
    bank: {
      sourceLocator: 'مقطع 3',
      sourceEvidence: 'النص الحرفي المعتمد من الكتاب',
      cognitiveSkill: 'ANALYZE',
      difficulty: 'ADVANCED',
      correctRationale: 'لأن الدليل يربط التخطيط بالاستجابة',
      distractorRationales: '["سبب خطأ الخيار"]',
    },
  })
  assert(copied.sourceBookTitle === 'كتاب إدارة الأزمات', 'نسخ امتحان البرنامج يجب أن يعبئ عنوان الكتاب من عنصر المعرفة')
  assert(String(copied.sourceLocator).includes('صفحة 12–14') && String(copied.sourceLocator).includes('مقطع 3'), 'نسخ امتحان البرنامج يجب أن يعبئ موضع/صفحة المصدر')
  assert(copied.sourceEvidence === 'النص الحرفي المعتمد من الكتاب', 'نسخ امتحان البرنامج يجب أن يحتفظ بالدليل الحرفي')
  assert(copied.cognitiveSkill === 'ANALYZE' && copied.difficulty === 'ADVANCED', 'نسخ امتحان البرنامج يجب أن يحتفظ بالمهارة والصعوبة')
}

function testProgramExamBackfillDoesNotTouchQuestionTextOrAnswer() {
  const data = __testAcademicBackfillDataForTests(
    { type: 'MCQ', difficulty: null, cognitiveSkill: null, correctRationale: null, distractorRationales: null },
    { id: 'q1', difficulty: 'MEDIUM', cognitiveSkill: 'UNDERSTAND', correctRationale: 'تعليل من الدليل', distractorRationales: ['سبب خطأ'] },
  )
  assert(data.difficulty === 'MEDIUM' && data.cognitiveSkill === 'UNDERSTAND', 'backfill يجب أن يعبئ الصعوبة والمهارة فقط عند النقص')
  assert(!Object.prototype.hasOwnProperty.call(data, 'text'), 'backfill ممنوع أن يغير نص السؤال')
  assert(!Object.prototype.hasOwnProperty.call(data, 'correctAnswer'), 'backfill ممنوع أن يغير الإجابة الصحيحة')
}

function testProgramExamTfWithoutDistractorRationalesStillQualified() {
  assert(__testQualifiedQuestionBankItemForProgramExamForTests({ type: 'TF', distractorRationales: null }), 'سؤال TF من البنك يجب أن يظل مؤهلاً حتى لو لم تكن أسباب عكس الإجابة موجودة قبل الـ backfill')
}

function testSyncedProgramExamQuestionPassesPublicationSourceCheck() {
  const copied = __testProgramQuestionAcademicCopyForTests({
    bookTitle: 'كتاب إدارة الأزمات',
    knowledgeTitle: 'تحليل المخاطر',
    pageStart: 8,
    pageEnd: 8,
    bank: {
      sourceEvidence: 'النص الحرفي المعتمد من المصدر الأكاديمي',
      cognitiveSkill: 'UNDERSTAND',
      difficulty: 'EASY',
      correctRationale: 'الدليل يثبت صحة الإجابة',
      distractorRationales: '["سبب عكس الإجابة"]',
    },
  })
  const questions = Array.from({ length: 5 }, (_, index) => ({
    status: 'PUBLISHED', type: 'TF', text: `سؤال موثق رقم ${index + 1}`, correctAnswer: '0', ...copied,
  }))
  const errors = validateProgramExamPublicationReadiness(questions, 'DIPLOMA', 'QUESTION_BANK')
  assert(!errors.some((error) => error.includes('مصدر أكاديمي')), 'السؤال المعبأ من sync يجب أن يمر شرط المصدر الأكاديمي نفسه في فحص النشر')
  assert(errors.length === 0, `السؤال المعبأ من sync يجب أن يمر فحص النشر: ${errors.join(' | ')}`)
}

function testProgramExamAcademicMissingCounts() {
  const counts = calculateProgramExamAcademicMissingCounts([
    { status: 'PENDING_REVIEW', type: 'MCQ', sourceEvidence: '', sourceBookTitle: '', sourceLocator: '', cognitiveSkill: '', difficulty: '', correctRationale: '', distractorRationales: '[]', qualityFlags: '[]', knowledgeItemId: '' },
    { status: 'PENDING_REVIEW', type: 'TF', sourceEvidence: 'دليل', sourceBookTitle: 'كتاب', sourceLocator: 'صفحة 1', cognitiveSkill: 'UNDERSTAND', difficulty: 'EASY', correctRationale: 'تعليل', distractorRationales: '["سبب"]', qualityFlags: '["QUESTION_BANK_ITEM_ID:qb1"]', knowledgeItemId: '' },
  ])
  assert(counts.remaining === 1, 'عداد البيانات الأكاديمية الناقصة يجب أن يحسب سؤالاً ناقصاً واحداً')
  assert(counts.missingSource === 1 && counts.missingSkill === 1 && counts.missingDistractors === 1, 'عدادات المصدر والمهارة وأسباب الخطأ يجب أن تطابق النقص')
  assert(counts.unsourceable === 1, 'السؤال بلا QUESTION_BANK_ITEM_ID ولا knowledgeItemId يجب أن يظهر كغير قابل للإسناد')
}

function testQuestionBankDocumentationPassesProgramExamPublicationSourceCheck() {
  const documented = __testDocumentedBankQuestionForPublicationForTests({ bookTitle: 'كتاب الإدارة', knowledgeTitle: 'التخطيط', pageStart: 11, pageEnd: 12, excerpt: 'الدليل الحرفي من عنصر المعرفة' })
  const questions = Array.from({ length: 5 }, (_, index) => ({ ...documented, text: `سؤال بنك موثق ${index + 1}` }))
  const errors = validateProgramExamPublicationReadiness(questions, 'DIPLOMA', 'QUESTION_BANK')
  assert(!errors.some((error) => error.includes('مصدر أكاديمي')), 'سؤال بنك فيه knowledgeItemId فقط بعد تعبئة التوثيق يجب أن يمر شرط المصدر الأكاديمي')
}

function testQuestionBankDocumentationParserAcceptsQuestionsKey() {
  const rows = __testParseBankDocAiRowsForTests('{"questions":[{"id":"q1","difficulty":"EASY"}]}')
  assert(rows.length === 1, 'محلل توثيق بنك الأسئلة يجب أن يقبل questions كمصفوفة')
  assert(rows[0]?.id === 'q1' && rows[0]?.difficulty === 'EASY', 'محلل توثيق بنك الأسئلة يجب أن يرجع صف q1 بالصعوبة')
}

function testQuestionBankDocumentationSelectionReachesItemAfterFirstTwoHundred() {
  const documented = Array.from({ length: 200 }, (_, index) => ({ id: `ok-${index}`, type: 'MCQ', text: 'سؤال موثق', options: '["أ","ب"]', correctAnswer: 'أ', sourceEvidence: 'دليل موثق', cognitiveSkill: 'UNDERSTAND', difficulty: 'EASY', correctRationale: 'تعليل', distractorRationales: '["سبب"]' }))
  const target = { id: 'q-201', type: 'MCQ', text: 'سؤال ناقص', options: '["أ","ب"]', correctAnswer: 'أ', sourceEvidence: 'دليل موثق', cognitiveSkill: '', difficulty: '', correctRationale: '', distractorRationales: '[]' }
  const selected = selectBankItemsNeedingDocumentation([...documented, target] as any[])
  assert(selected.length === 1 && selected[0]?.id === 'q-201', 'انتقاء توثيق بنك الأسئلة يجب أن يصل للسؤال 201 إذا أول 200 موثقين')
}

function testProgramExamAutoStatusUpdateDoesNotTouchReady() {
  const where = __testProgramExamAutoStatusUpdateWhereForTests('exam-1') as any
  assert(where.id === 'exam-1', 'حماية تحديث حالة الامتحان يجب أن تبقى محصورة بالامتحان نفسه')
  assert(where.status?.not === 'READY', 'أي مسار تلقائي لتحديث حالة الامتحان يجب ألا يلمس امتحاناً جاهزاً')
}

function testQuestionBankPendingReviewOrdersFirst() {
  const ordered = __testOrderQuestionBankItemsForReviewForTests([
    { id: 'approved-new', status: 'APPROVED', createdAt: new Date('2026-01-03T00:00:00Z') },
    { id: 'pending-old', status: 'PENDING_REVIEW', createdAt: new Date('2026-01-01T00:00:00Z') },
    { id: 'pending-new', status: 'PENDING_REVIEW', createdAt: new Date('2026-01-02T00:00:00Z') },
  ])
  assert(ordered[0]?.id === 'pending-new' && ordered[1]?.id === 'pending-old', 'قائمة بنك الأسئلة يجب أن تعرض المعلقة أولاً بترتيب الأحدث')
}

function testApprovedQuestionBankFlagsRemoveReviewMarkers() {
  const flags = JSON.parse(__testApproveQuestionBankQualityFlagsForTests(JSON.stringify(['SOURCE_GROUNDED', 'NEEDS_HUMAN_REVIEW', 'LEGACY_GROUNDING_UNVERIFIED'])))
  assert(flags.includes('SOURCE_GROUNDED'), 'اعتماد سؤال البنك يجب أن يحافظ على الأعلام الأخرى')
  assert(!flags.includes('NEEDS_HUMAN_REVIEW') && !flags.includes('LEGACY_GROUNDING_UNVERIFIED'), 'اعتماد سؤال البنك يجب أن يزيل أعلام المراجعة القديمة')
}

function testBankExamCognitiveBalancePassesPolicy() {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `low-${i}`, text: `low ${i}`, cognitiveSkill: 'UNDERSTAND', difficulty: 'MEDIUM', type: 'MCQ' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `mid-${i}`, text: `mid ${i}`, cognitiveSkill: 'APPLY', difficulty: 'MEDIUM', type: 'MCQ' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `high-${i}`, text: `high ${i}`, cognitiveSkill: i % 2 ? 'ANALYZE' : 'EVALUATE', difficulty: 'ADVANCED', type: 'MCQ' })),
  ]
  const result = balanceQuestionBankExamSelection(rows, 40, { lowMaxPercent: 50, highMinPercent: 20 })
  assert(result.selected.length === 40, 'موازن بنك الأسئلة يجب أن يختار العدد المطلوب')
  assert(validateCognitiveDistribution(result.selected, 'PROGRAM', { lowMaxPercent: 50, programHighMinPercent: 20 }).ok, 'موازن بنك الأسئلة يجب أن يختار توزيعاً معرفياً صالحاً عند توفر الأسئلة')
}

function testBankExamCognitiveBalanceWarnsWithoutHighQuestions() {
  const rows = [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `low-only-${i}`, text: `low only ${i}`, cognitiveSkill: 'UNDERSTAND', difficulty: 'MEDIUM', type: 'MCQ' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `mid-only-${i}`, text: `mid only ${i}`, cognitiveSkill: 'APPLY', difficulty: 'MEDIUM', type: 'MCQ' })),
  ]
  const result = balanceQuestionBankExamSelection(rows, 40, { lowMaxPercent: 50, highMinPercent: 20 })
  assert(result.selected.length === 40, 'موازن بنك الأسئلة لا يجب أن يفشل إذا لم تتوفر أسئلة عالية كفاية')
  assert(!!result.cognitiveWarning, 'موازن بنك الأسئلة يجب أن يرجع تحذيراً إذا لم تتوفر أسئلة تحليل/تقييم كافية')
}

function testBankExamCognitiveBalanceRespectsTypePlanWhenPossible() {
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `mcq-low-${i}`, text: `mcq low ${i}`, cognitiveSkill: 'UNDERSTAND', difficulty: 'MEDIUM', type: 'MCQ' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `mcq-high-${i}`, text: `mcq high ${i}`, cognitiveSkill: i % 2 ? 'ANALYZE' : 'EVALUATE', difficulty: 'ADVANCED', type: 'MCQ' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `essay-low-${i}`, text: `essay low ${i}`, cognitiveSkill: 'UNDERSTAND', difficulty: 'MEDIUM', type: 'ESSAY' })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `essay-high-${i}`, text: `essay high ${i}`, cognitiveSkill: i % 2 ? 'ANALYZE' : 'EVALUATE', difficulty: 'ADVANCED', type: 'ESSAY' })),
  ]
  const result = balanceQuestionBankExamSelection(rows, 20, { lowMaxPercent: 50, highMinPercent: 20, typePlan: { MCQ: 75, ESSAY: 25 } })
  assert(result.selected.filter((q) => q.type === 'MCQ').length === 15, 'موازن البنك يجب أن يحترم حصة MCQ عند توفرها')
  assert(result.selected.filter((q) => q.type === 'ESSAY').length === 5, 'موازن البنك يجب أن يحترم حصة ESSAY عند توفرها')
  assert(validateCognitiveDistribution(result.selected, 'PROGRAM', { lowMaxPercent: 50, programHighMinPercent: 20 }).ok, 'توزيع الأنواع يجب ألا يكسر سياسة المهارات عند توفر البدائل')
}

function testBankExamCognitiveBalanceCompletesMissingTypeFromAvailableTypes() {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `mcq-only-${i}`, text: `mcq only ${i}`, cognitiveSkill: i < 4 ? 'ANALYZE' : 'APPLY', difficulty: 'MEDIUM', type: 'MCQ' }))
  const result = balanceQuestionBankExamSelection(rows, 10, { lowMaxPercent: 50, highMinPercent: 20, typePlan: { MCQ: 50, ESSAY: 50 } })
  assert(result.selected.length === 10, 'موازن البنك يجب أن يكمل العدد من الأنواع المتاحة إذا غاب نوع مطلوب')
}

function testUnitQuestionBankStatusResolverCompletesFailedWhenApprovedTargetMet() {
  const status = resolveUnitQuestionBankJobStatus({ jobStatus: 'FAILED', approved: 20, required: 20 })
  assert(status === 'COMPLETED', 'حالة بنك أسئلة الوحدة يجب أن تصبح COMPLETED إذا وصل المعتمد للمطلوب حتى لو job FAILED')
}

function testUnitQuestionBankStatusResolverKeepsRunningWhenApprovedBelowTarget() {
  const status = resolveUnitQuestionBankJobStatus({ jobStatus: 'RUNNING', approved: 12, required: 20 })
  assert(status === 'RUNNING', 'حالة بنك أسئلة الوحدة RUNNING يجب أن تبقى RUNNING إذا لم يصل المعتمد للمطلوب')
}

function testUnitQuestionBankStatusResolverKeepsFailedWhenApprovedBelowTarget() {
  const status = resolveUnitQuestionBankJobStatus({ jobStatus: 'FAILED', approved: 5, required: 20 })
  assert(status === 'FAILED', 'حالة بنك أسئلة الوحدة FAILED يجب أن تبقى FAILED إذا لم يصل المعتمد للمطلوب')
}

function testTransientBookReadErrorsClassifyRetryableProviderPressure() {
  assert(isTransientBookReadError('GEMINI/gemini-3.5-flash-lite/key#3: This model is currently experiencing high demand'), 'high demand provider errors must pause and retry book reading')
}

function testTransientBookReadErrorsClassifyDeadline() {
  assert(isTransientBookReadError('AI_DEADLINE_EXCEEDED'), 'AI_DEADLINE_EXCEEDED must pause and retry book reading')
}

function testTransientBookReadErrorsDoNotClassifyPermanentPdfError() {
  assert(!isTransientBookReadError('BOOK_PDF_REQUIRED'), 'BOOK_PDF_REQUIRED must stay a permanent book read error')
}

function testBookReadJobResumePlansFailedAnalyze() {
  assert(planBookReadJobResume({ status: 'FAILED', phase: 'ANALYZE' }, false) === 'RESUME', 'failed analyze book read jobs should resume without restart')
}

function testBookReadJobResumeRestartCreatesNewJob() {
  assert(planBookReadJobResume({ status: 'FAILED', phase: 'ANALYZE' }, true) === 'CREATE', 'explicit restart should create a new book read job')
}

function testBookReadJobResumeCompletedCreatesNewJob() {
  assert(planBookReadJobResume({ status: 'COMPLETED', phase: 'DONE' }, false) === 'CREATE', 'completed book read jobs should not resume')
}

function testPagesNeedingOcrSplitsEightBlankPagesIntoTwoBatches() {
  const batches = pagesNeedingOcr(Array.from({ length: 8 }, (_, i) => ({ page: i + 1, text: '' })))
  assert(batches.length === 2, 'OCR pages should split 8 blank pages into two batches')
  assert(JSON.stringify(batches[0]) === JSON.stringify([1, 2, 3, 4]), 'first OCR batch should contain 4 pages')
  assert(JSON.stringify(batches[1]) === JSON.stringify([5, 6, 7, 8]), 'second OCR batch should contain 4 pages')
}

function testPagesNeedingOcrKeepsOnlyBlankPagesInSingleBatch() {
  const pages = Array.from({ length: 8 }, (_, i) => ({ page: i + 1, text: i === 2 || i === 6 ? '' : 'x'.repeat(120) }))
  const batches = pagesNeedingOcr(pages)
  assert(batches.length === 1, 'OCR pages should keep two blank pages in one batch')
  assert(JSON.stringify(batches[0]) === JSON.stringify([3, 7]), 'OCR batch should include only blank page numbers')
}

function testAdminStudentsEnrollmentWhereBuilder() {
  const all = buildAdminStudentsEnrollmentRelationFilter('ALL', null) as any
  assert(JSON.stringify(all.some.status.in) === JSON.stringify([...OPEN_ENROLLMENT_STATUSES]), 'فلتر كل الطلاب يجب أن يعرض فقط أصحاب برنامج مفتوح')
  const registeredOnly = buildAdminStudentsEnrollmentRelationFilter('REGISTERED_ONLY', null) as any
  assert(JSON.stringify(registeredOnly.none.status.in) === JSON.stringify([...OPEN_ENROLLMENT_STATUSES]), 'فلتر المسجلين بلا برنامج مفتوح يجب أن يستبعد أي تسجيل مفتوح')
  const active = buildAdminStudentsEnrollmentRelationFilter('ACTIVE', 'program-1') as any
  assert(active.some.status === 'ACTIVE' && active.some.programId === 'program-1', 'فلتر حالة تسجيل محددة يجب أن يبقي السلوك الحالي مع programId')
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
  testQuestionBankCompletedJobDoesNotBlockQueue,
  testQuestionBankLockedJobDoesNotBlockQueue,
  testVerifierRejectedQuestionIsNotSaved,
  testIncompleteMcqOptionsAreRejected,
  testMcqThreeOptionsAccepted,
  testMcqFiveOptionsKeepsFifthCorrectAnswer,
  testMcqTwoOptionsRejectedWithReason,
  testMcqDuplicateOptionsRejectedWithReason,
  testArabicCognitiveSkillAnalyzeNormalizes,
  testExpandedCognitiveSkillAliasesNormalize,
  testShortConciseAnswerAccepted,
  testTfArabicCorrectAnswerAliasesNormalize,
  testTfNumericAnswerUsesGeneratedOptionIndex,
  testUnitExamTfOptionsStayStable,
  testEssayShortAnswerRejected,
  testAllStructurallyRejectedBatchThrows,
  testGeneratedQuestionsRequireExplicitEvidenceSkillAndDifficulty,
  testPreviewPollingNudgesQuestionBankJob,
  testQuestionBankStepRoutesHaveMaxDuration,
  testQuestionBankJobCompletesWithSharedSelector,
  testLateQuestionBankStepDoesNotReopenCompleted,
  testUnitQuestionsApiScopesToSingleUnit,
  testUnitQuestionsApiHydratesKnowledgePages,
  testUnitQuestionPagesFallbackToLocator,
  testUnitQuestionJobRequestedCanShrink,
  testProgramQuestionJobRequestedKeepsOldMaxBehavior,
  testDraftExamCanBeRebuiltReadyAfterApprovals,
  testQuestionBankSanitizesTfBeforeNumericValidation,
  testExamTimingUsesStartedAtNotClientDuration,
  testBookReplacementProtectedWhenUnitsLinked,
  testQuestionBankPatchValidatesCorrectAnswer,
  testQuestionBankRetryAtNotBeyondOneHour,
  testProgramExamCopiesAcademicSourceFields,
  testProgramExamBackfillDoesNotTouchQuestionTextOrAnswer,
  testProgramExamTfWithoutDistractorRationalesStillQualified,
  testSyncedProgramExamQuestionPassesPublicationSourceCheck,
  testProgramExamAcademicMissingCounts,
  testQuestionBankDocumentationPassesProgramExamPublicationSourceCheck,
  testQuestionBankDocumentationParserAcceptsQuestionsKey,
  testProgramExamAutoStatusUpdateDoesNotTouchReady,
  testQuestionBankPendingReviewOrdersFirst,
  testApprovedQuestionBankFlagsRemoveReviewMarkers,
  testBankExamCognitiveBalancePassesPolicy,
  testBankExamCognitiveBalanceWarnsWithoutHighQuestions,
  testBankExamCognitiveBalanceRespectsTypePlanWhenPossible,
  testBankExamCognitiveBalanceCompletesMissingTypeFromAvailableTypes,
  testUnitQuestionBankStatusResolverCompletesFailedWhenApprovedTargetMet,
  testUnitQuestionBankStatusResolverKeepsRunningWhenApprovedBelowTarget,
  testUnitQuestionBankStatusResolverKeepsFailedWhenApprovedBelowTarget,
  testTransientBookReadErrorsClassifyRetryableProviderPressure,
  testTransientBookReadErrorsClassifyDeadline,
  testTransientBookReadErrorsDoNotClassifyPermanentPdfError,
  testBookReadJobResumePlansFailedAnalyze,
  testBookReadJobResumeRestartCreatesNewJob,
  testBookReadJobResumeCompletedCreatesNewJob,
  testPagesNeedingOcrSplitsEightBlankPagesIntoTwoBatches,
  testPagesNeedingOcrKeepsOnlyBlankPagesInSingleBatch,
  testAdminStudentsEnrollmentWhereBuilder,
]

for (const test of tests) {
  test()
  console.log(`✓ ${test.name}`)
}
