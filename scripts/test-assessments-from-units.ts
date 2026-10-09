import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { canPublishUnitExamFromQuestions, selectUnitExamQuestionsApprovedFirst } from '../src/lib/unit-exam-policy'
import { assertGeneratedBatchHasAcceptedCandidates, hasSourceGroundedFlag, nextQuestionBankRetryAt, planQuestionBankJobManualReactivation, planQuestionBankSourceWindow, prepareMcqOptionsForStorage } from '../src/lib/question-bank-job'
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
  testQuestionBankRetryAtNotBeyondOneHour,
]

for (const test of tests) {
  test()
  console.log(`✓ ${test.name}`)
}
