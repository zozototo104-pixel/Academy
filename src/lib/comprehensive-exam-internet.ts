// Comprehensive exam — AI-from-internet question source (phase 1).
// The admin types a topic; Tavily searches the web (free tier, 1
// credit per basic search); the returned snippets become the ONLY
// sources. Questions are generated from them through the shared
// generation core — every accepted question carries a verbatim evidence
// span from one snippet AND the snippet's source URL, and lands
// PENDING_REVIEW. No Tavily answer text is used as evidence (it is
// model-generated, not a source); only the snippets count.
// Closed questions ONLY (MCQ | TF). There is no essay type anywhere
// in this module.
import { createHash } from 'crypto'
import { prepareStageRun, runStageAttempt, type StageUsage } from './ai-stage-runner'
import { geminiCompleteJson } from './gemini'
import type { TextAiPreferredModel, TextAiProvider, TextAiRouterPolicy } from './text-ai'
import { verifyQuestionsWithCrossProvider, type VerifiableQuestion } from './question-verifier'
import { internetAcademicTopicIssue, internetQuestionAcademicIssue, internetSourceAcademicIssue } from './comprehensive-exam'
import { selectExamSourceChunks, type ExamSourceChunk } from './exam-source-chunks'
import { MAX_QUESTIONS_PER_SOURCE_CHUNK, throwComprehensiveExamInsufficientSource } from './comprehensive-exam-evidence'
import {
  generateExamQuestionsFromChunks,
  type CompleteJsonFn,
  type ExamGenerationRejected,
} from './comprehensive-exam-generation'
import type { ComprehensiveQuestionInput } from './comprehensive-exam'
import type { TavilySearchResult } from './tavily-search'

export const INTERNET_MAX_QUESTIONS = 10
export const INTERNET_MIN_QUESTIONS = 1
export const INTERNET_DEFAULT_QUESTIONS = 5
export const INTERNET_MAX_PROMPT_CHUNKS = 12
export const INTERNET_MAX_SEARCH_RESULTS = 10
// A snippet shorter than this cannot yield a 40+ character verbatim
// evidence span with room to spare — it is skipped, never padded.
export const INTERNET_MIN_SNIPPET_CHARS = 60

export type InternetExamAxis = { topic: string; origin: 'CURRICULUM' | 'AI_SUGGESTION' }
const GENERIC_AXIS = /^(?:مقدمة|مدخل|تمهيد|خاتمة|مراجعة|اختبار|تقييم|(?:الوحدة|المحاضرة|الفصل|الباب|الموضوع)(?:\s+[\p{L}\p{N}]+)?)$/u

export function normalizeSpecialtyAxes(candidates: readonly unknown[], specialtyTitle: string, origin: InternetExamAxis['origin'], limit = 10): InternetExamAxis[] {
  const axes: InternetExamAxis[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const topic = String(typeof candidate === 'string' ? candidate : (candidate as any)?.topic || '')
      .replace(/^[\s\d.\-)]+/u, '').replace(/^(?:الوحدة|الفصل|المحاضرة)\s+[^\s:：–-]+\s*[:：–-]\s*/u, '')
      .replace(/\s+/gu, ' ').trim().slice(0, 160)
    const key = topic.normalize('NFKC').toLowerCase().replace(/[\u064b-\u065f]/gu, '')
    if (topic.length < 10 || GENERIC_AXIS.test(topic) || seen.has(key) || internetAcademicTopicIssue(topic, specialtyTitle)) continue
    seen.add(key)
    axes.push({ topic, origin })
    if (axes.length === limit) break
  }
  return axes
}

export function curriculumCoverageAxes(titles: readonly string[], specialtyTitle: string): InternetExamAxis[] {
  const all = normalizeSpecialtyAxes(titles, specialtyTitle, 'CURRICULUM', titles.length)
  if (all.length <= 10) return all
  return Array.from({ length: 10 }, (_, index) => all[Math.round((index * (all.length - 1)) / 9)])
}

export function parseSuggestedSpecialtyAxes(raw: string, specialtyTitle: string): InternetExamAxis[] {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/iu, '').replace(/```\s*$/u, '').trim()
  try {
    const parsed = JSON.parse(cleaned)
    return normalizeSpecialtyAxes(Array.isArray(parsed) ? parsed : parsed?.axes || [], specialtyTitle, 'AI_SUGGESTION')
  } catch { return [] }
}

export function buildSpecialtyInternetQuery(topic: string, specialtyTitle: string): string {
  const discipline = String(specialtyTitle || '').replace(/\b(?:DBA|MBA|PhD)\b/giu, '')
    .replace(/(?:الدكتوراه|دكتوراه|الماجستير|ماجستير|الدبلوم|دبلوم|المهنية|المهني|الاحترافية|الاحترافي|بكالوريوس|درجة|برنامج|تخصص)/gu, '')
    .replace(/\s+/gu, ' ').trim()
  if (discipline.length < 5 || topic.includes(discipline)) return topic
  return `${topic} ${discipline}`.slice(0, 240)
}

export function buildSpecialtyResearchQueries(topic: string, specialtyTitle: string): string[] {
  const base = buildSpecialtyInternetQuery(topic, specialtyTitle)
  return [
    `${base} نظريات نماذج مفاهيم علمية`,
    `${base} دراسات علمية أبحاث محكمة منهجيات نتائج peer reviewed research`,
    `${base} دراسات حالة تطبيقات مهنية تحليل قرارات case study`,
  ]
}

export async function suggestComprehensiveInternetPlan(input: { specialtyTitle: string; category: string; approvedUnitTitles: string[] }): Promise<{
  axes: InternetExamAxis[]; basis: 'CURRICULUM' | 'MIXED' | 'AI_SUGGESTION'; warning?: string
}> {
  const curriculumAxes = curriculumCoverageAxes(input.approvedUnitTitles, input.specialtyTitle)
  let raw: string
  try {
    const genPlan = await prepareStageRun('GENERATION')
    const usage: StageUsage = { fallbackUsed: false }
    raw = await runStageAttempt(genPlan, usage, async (routing) => {
      const models = routing?.preferredModels.map((m) => ({ provider: m.provider as TextAiPreferredModel['provider'], model: m.model })) || []
      const text = await geminiCompleteJson({
        system: 'أنت لجنة تصميم اختبارات كفاءة أكاديمية. اقترح محاور تخصصية فقط في JSON دون أي نص إضافي. هذه مقترحات للمراجعة وليست منهجاً معتمداً.',
        history: [{ role: 'user', text: `التخصص: «${input.specialtyTitle}». المستوى: «${input.category}».
اقترح من 8 إلى 10 محاور علمية مختلفة وعميقة تغطي الكفاءات الأساسية لهذا التخصص، من النظريات والمناهج والبحث إلى التحليل التطبيقي واتخاذ القرار وحل المشكلات المهنية. صياغة كل محور دقيقة ومحددة، 10 إلى 120 حرفاً.
لا تذكر شروط قبول، درجات علمية، جامعات، رسوم، أو وصف برامج. لا تذكر محاور خارجة عن التخصص. لا تكرر محاور متداخلة. محاور الوحدات المعتمدة المتاحة إن وجدت (للاسترشاد فقط): ${JSON.stringify(curriculumAxes.map((axis) => axis.topic))}.
أجب JSON فقط: {"axes":[{"topic":"محور تخصصي محدد"}]}.` }],
        purpose: 'GENERATION', taskLevel: 'ACADEMIC_DRAFT', temperature: 0.15, maxOutputTokens: 1800,
        deadlineMs: Date.now() + 100_000,
        ...(routing ? {
          preferredModels: models, restrictToModels: models,
          preferredProviders: [...new Set([...routing.preferredProviders, ...routing.preferredModels.map((m) => m.provider)])] as TextAiProvider[],
          ...(routing.policy ? { routerPolicy: routing.policy as TextAiRouterPolicy } : {}),
        } : {}),
      })
      if (parseSuggestedSpecialtyAxes(text, input.specialtyTitle).length < 5) throw new Error('INSUFFICIENT_ACADEMIC_AXES')
      return text
    })
  } catch (error) {
    if (curriculumAxes.length >= 5) return {
      axes: curriculumAxes, basis: 'CURRICULUM', warning: 'تعذّر اقتراح محاور إضافية بالذكاء؛ هذه محاور المنهج المعتمد فقط.',
    }
    throw error
  }
  const proposed = parseSuggestedSpecialtyAxes(raw, input.specialtyTitle)
  const anchors = curriculumAxes.length > 5
    ? Array.from({ length: 5 }, (_, index) => curriculumAxes[Math.round((index * (curriculumAxes.length - 1)) / 4)])
    : curriculumAxes
  const occupied = new Set(anchors.map((axis) => axis.topic.normalize('NFKC').toLowerCase()))
  const axes = [...anchors]
  for (const axis of proposed) {
    const key = axis.topic.normalize('NFKC').toLowerCase()
    if (!occupied.has(key) && axes.length < 10) axes.push(axis)
    occupied.add(key)
  }
  if (axes.length < 5) throw new Error('INSUFFICIENT_DISTINCT_ACADEMIC_AXES')
  return { axes, basis: curriculumAxes.length ? 'MIXED' : 'AI_SUGGESTION' }
}

export type InternetExamQuestion = ComprehensiveQuestionInput & { sourceUrl: string }

export type InternetGenerationResult = {
  questions: InternetExamQuestion[]
  requested: number
  accepted: number
  rejected: ExamGenerationRejected[]
  rejectedCount: number
  provider?: string
  model?: string
  search: { resultsFound: number; chunksUsed: number }
}

type InternetVerifyFn = typeof verifyQuestionsWithCrossProvider

export function clampInternetQuestionCount(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return INTERNET_DEFAULT_QUESTIONS
  return Math.max(INTERNET_MIN_QUESTIONS, Math.min(INTERNET_MAX_QUESTIONS, Math.floor(n)))
}

// The synthetic id is content-addressed on the search topic, so the
// same topic maps to the same source — and it can never collide with a
// real Book id (cuid), so it is safe to store on the question rows as
// sourceBookId.
export function internetSourceId(topic: string): string {
  return `tavily:${createHash('sha256').update(String(topic || '').trim().toLowerCase()).digest('hex').slice(0, 16)}`
}

export type InternetExamChunk = ExamSourceChunk & { url: string }

// One search result → one chunk. Results with no usable snippet are
// dropped (counted in the report, never padded); duplicate URLs keep
// only their first result.
export function tavilyResultsToExamChunks(
  results: readonly TavilySearchResult[],
  sourceId: string,
): InternetExamChunk[] {
  const seenUrls = new Set<string>()
  const chunks: InternetExamChunk[] = []
  for (const result of results) {
    const url = String(result.url || '').trim()
    const content = String(result.content || '').trim()
    if (!url || content.length < INTERNET_MIN_SNIPPET_CHARS) continue
    if (internetSourceAcademicIssue(String(result.title || ''), content)) continue
    if (seenUrls.has(url)) continue
    seenUrls.add(url)
    chunks.push({
      sourceIndex: chunks.length + 1,
      bookId: sourceId,
      bookTitle: String(result.title || url).trim() || url,
      text: content,
      textProvenance: 'NATIVE_TEXT',
      url,
    })
  }
  return chunks
}

// Round-robin across distinct research angles, never allowing one website
// to dominate the specialty-wide evidence. Tavily's advanced excerpts are
// bounded per URL so selection cannot silently discard oversized chunks.
export function diverseInternetEvidence(
  groups: readonly (readonly TavilySearchResult[])[],
  maxResults = INTERNET_MAX_PROMPT_CHUNKS,
): { results: TavilySearchResult[]; distinctDomains: number } {
  const results: TavilySearchResult[] = []
  const seenUrls = new Set<string>()
  const domains = new Map<string, number>()
  const limit = Math.min(INTERNET_MAX_PROMPT_CHUNKS, Math.max(1, maxResults))
  const longest = Math.max(0, ...groups.map((group) => group.length))
  for (let offset = 0; offset < longest && results.length < limit; offset++) {
    for (const group of groups) {
      const item = group[offset]
      if (!item) continue
      const url = String(item.url || '').trim()
      const content = String(item.content || '').trim()
      if (!url || content.length < INTERNET_MIN_SNIPPET_CHARS || internetSourceAcademicIssue(item.title, content)) continue
      let domain: string
      try {
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol)) continue
        domain = parsed.hostname.replace(/^www\./u, '').toLowerCase()
      } catch { continue }
      if (!domain || seenUrls.has(url) || (domains.get(domain) || 0) >= 2) continue
      seenUrls.add(url)
      domains.set(domain, (domains.get(domain) || 0) + 1)
      results.push({ ...item, content: content.slice(0, 2400) })
      if (results.length === limit) break
    }
  }
  return { results, distinctDomains: domains.size }
}

export function formatInternetChunksForPrompt(chunks: readonly InternetExamChunk[]): string {
  return chunks
    .map((c) => `[${c.sourceIndex}] «${c.bookTitle}» — ${c.url}:\n${c.text}`)
    .join('\n\n')
}

// The generation prompt. MCQ/TF ONLY — the two allowed types are the
// only ones named in the JSON example, and essay/short questions are
// forbidden in plain words. Evidence rules mirror the existing exam
// generation prompt: verbatim quotes, one chunk per evidence, max 3
// questions per chunk. The snippet text is the only permitted source —
// never general knowledge, never the search engine's own summary.
export function buildInternetQuestionPrompt(input: {
  topic: string
  programTitleAr: string
  programLevel?: string
  count: number
  comprehensive?: boolean
  chunksSection: string
  previousTexts: string[]
}): string {
  const previousSection = input.previousTexts.length
    ? input.previousTexts.slice(-80).map((q, i) => `${i + 1}. ${String(q).replace(/\s+/g, ' ').trim().slice(0, 260)}`).join('\n')
    : 'لا توجد أسئلة سابقة في هذا الامتحان.'
  return `أنت لجنة امتحانات عليا في الأكاديمية. مهمتك: بناء أسئلة امتحان جامعي (صح/خطأ واختيار متعدد فقط — لا أسئلة مقالية ولا أسئلة قصيرة) من نتائج بحث عبر الإنترنت، لامتحان شامل لخريج درس البرنامج في مؤسسة أخرى.

موضوع البحث: «${input.topic}»
التخصص العلمي الذي سيمتحَن فيه الخريج: ${input.programTitleAr}
عدد الأسئلة المطلوبة الآن: ${input.count}
${input.comprehensive ? `هذه دفعة ضمن امتحان شامل موزع على محاور علمية متعددة. مستوى الامتحان: ${input.programLevel || 'حسب التخصص'}. في هذا المحور قدّم أسئلة بمستويات معرفية متوازنة ${input.programLevel === 'DOCTORATE' ? 'تقريباً 10% فهم أساسي، 30% تطبيق، و60% تحليل حالات متقدمة وتقويم القرارات ومناهج البحث' : input.programLevel === 'DIPLOMA' ? 'تقريباً 35% فهم أساسي، 45% تطبيق، و20% تحليل حالات عملية' : 'تقريباً 20% فهم أساسي، 35% تطبيق، و45% تحليل حالات مهنية مع تفسير القرار'}. لا تكتفِ بتعريفات أو أسئلة مباشرة. صِغ الحالات بحيث يمكن استنتاج الإجابة الصحيحة من الدليل المرفق حصراً؛ إذا لم يسمح النص بحالة تحليلية فلا تختلق واحدة.` : ''}

تنبيه أساسي: هذا امتحان كفاءة علمية ومهنية في التخصص، وليس اختبار معلومات عن برنامج الدراسة نفسه.
ممنوع تماماً توليد أسئلة عن الفئة المستهدفة، شروط القبول أو الالتحاق، المؤهلات المطلوبة، تكاليف الدراسة، الجامعات، أو تعريف درجة DBA/MBA/الدكتوراه.
يجب أن تختبر الأسئلة مفاهيم وتطبيقات وتحليلات ومشكلات مهنية من المحور العلمي «${input.topic}» فقط؛ لا تسأل عن اسم الدرجة أو خصائص البرنامج.
إذا لم تتضمن المصادر مادة تخصصية صالحة للاختبار، أرجع مصفوفة فارغة ولا تختلق أسئلة بديلة.

المقاطع المختارة الوحيدة المسموح استخدامها كمصدر. كل مقطع هو خلاصة من صفحة ويب، واسمه ورابطه مكتوبان فوق نصه. كل sourceEvidence يجب أن يكون اقتباساً حرفياً من المقطع المشار إليه فقط، بعدد 40 حرفاً على الأقل، ولا يجوز استخدام أي ملخص أو معرفة عامة كدليل:

${input.chunksSection}

أسئلة سبق توليدها في نفس الامتحان ويُمنع تكرارها أو تكرار فكرتها أو خياراتها:
${previousSection}

شروط صارمة:
- كل سؤال يقيس نقطة تعلم مركزية من المصادر: مفهوم، نموذج، نظرية، قرار، علاقة سببية، خطأ تطبيقي، أو حالة تحليلية. إذا استطاع الطالب الإجابة دون قراءة المصادر فالسؤال مرفوض.
- لا تستخدم نفس sourceIndex لأكثر من ${MAX_QUESTIONS_PER_SOURCE_CHUNK} أسئلة؛ وزّع الأسئلة بين المقاطع.
- سؤال الاختيار المتعدد: options مصفوفة 4 نصوص مختلفة تماماً، وcorrectAnswer نص الخيار الصحيح نفسه مطابقاً لأحد عناصر options. وزّع الإجابات الصحيحة بين الخيارات ولا تجعل الخيار الصحيح دائماً الأول.
- سؤال صح/خطأ: options ["صح","خطأ"]، وcorrectAnswer "صح" أو "خطأ"، والعبارة من محتوى المصادر لا عموميات.
- كل سؤال: sourceIndex رقم المقطع، وsourceEvidence اقتباس حرفي لا يقل عن 40 حرفاً من ذلك المقطع فقط؛ لا تقبل إعادة الصياغة هنا.
- كل سؤال: difficulty واحدة من EASY أو MEDIUM أو ADVANCED، وrationale يشرح لماذا الإجابة صحيحة (12 حرفاً على الأقل).
- صياغة عربية فصحى واضحة؛ لا تنقل عبارات مكسورة من الخلاصات.
- لا تكرر سؤالاً أو فكرة سؤال مرتين، ولا تكرر نفس خيارات الاختيار بين سؤال وآخر.
- لا تبدأ نص السؤال بـ «وفق المقطع الآتي» أو «حسب المصدر» أو أي صيغة قالبية مشابهة.
- ممنوع تماماً أي سؤال مقالي أو سؤال قصير — النوعان المسموحان فقط هما MCQ وTF.
- لا تستخدم علامة تنصيص " داخل نص السؤال أو الخيارات (استخدم «» بدلاً منها).
- أرسل كل سؤال في سطر مستقل — كائن JSON واحد لكل سطر داخل مصفوفة.

أجب بصيغة JSON فقط — مصفوفة من ${input.count} أسئلة، مثال شكلي فقط:
[{"type":"MCQ","text":"...","options":["...","...","...","..."],"correctAnswer":"...","sourceIndex":1,"sourceEvidence":"اقتباس حرفي لا يقل عن أربعين حرفاً من نص المصدر المحدد فقط","difficulty":"MEDIUM","rationale":"سبب صحة الخيار الصحيح مستنداً إلى الدليل"},
{"type":"TF","text":"...","options":["صح","خطأ"],"correctAnswer":"صح","sourceIndex":2,"sourceEvidence":"اقتباس حرفي لا يقل عن أربعين حرفاً من نص المصدر المحدد فقط","difficulty":"EASY","rationale":"سبب صحة الحكم"}]`
}

// Generates MCQ/TF questions from Tavily search results via the shared
// generation core. Every accepted question carries a verbatim span from
// one snippet plus that snippet's URL. A wholly empty batch fails
// outright rather than saving nothing silently.
export async function generateInternetQuestions(
  results: readonly TavilySearchResult[],
  input: {
    topic: string
    programTitleAr: string
    programLevel?: string
    count: number
    comprehensive?: boolean
    previousQuestionTexts?: string[]
    deadlineMs?: number
  },
  deps: { completeJson?: CompleteJsonFn; verifyQuestions?: InternetVerifyFn } = {},
): Promise<InternetGenerationResult> {
  const requested = clampInternetQuestionCount(input.count)
  const previousTexts = input.previousQuestionTexts || []
  const sourceId = internetSourceId(input.topic)
  const allChunks = tavilyResultsToExamChunks(results, sourceId)
  const selected = selectExamSourceChunks(allChunks, {
    maxChunks: INTERNET_MAX_PROMPT_CHUNKS,
    maxTotalChars: input.comprehensive ? 30000 : 18000,
  }) as InternetExamChunk[]
  if (!selected.length) {
    throwComprehensiveExamInsufficientSource({
      availableChunks: 0,
      requestedQuestions: requested,
      acceptedQuestions: 0,
    })
  }
  const urlBySourceIndex = new Map<number, string>()
  for (const chunk of selected) urlBySourceIndex.set(chunk.sourceIndex, chunk.url)
  const maxByEvidence = selected.length * MAX_QUESTIONS_PER_SOURCE_CHUNK
  const count = Math.min(requested, maxByEvidence)
  const prompt = buildInternetQuestionPrompt({
    topic: input.topic,
    programTitleAr: input.programTitleAr,
    programLevel: input.programLevel,
    count,
    comprehensive: input.comprehensive,
    chunksSection: formatInternetChunksForPrompt(selected),
    previousTexts,
  })
  // Reserve time for a separate REVIEW model to test the *meaning* of
  // the answer against the source. A literal quote alone is insufficient.
  const workflowDeadline = input.deadlineMs ?? Date.now() + 270_000
  const batchId = `internet-${Date.now()}`
  const core = await generateExamQuestionsFromChunks(
    {
      selected,
      requested,
      prompt,
      previousTexts,
      batchId,
      stickyScope: `COMPREHENSIVE_INTERNET:${batchId}`,
      detailSource: 'comprehensive-exam-internet',
      deadlineMs: workflowDeadline - 50_000,
    },
    deps,
  )
  const candidates = core.items.filter((item) => !internetQuestionAcademicIssue(item.question.text))
  const reviewPlan = candidates.length && !deps.verifyQuestions ? await prepareStageRun('REVIEW') : null
  const remainingReviewMs = Math.max(0, Math.min(45_000, workflowDeadline - Date.now()))
  const reviewed = candidates.length
    ? await (deps.verifyQuestions || verifyQuestionsWithCrossProvider)({
        questions: candidates.map((item) => ({ ...item.question, sourceIndex: item.sourceIndex, textProvenance: 'NATIVE_TEXT' as const })) as VerifiableQuestion[],
        sources: selected.map((chunk) => ({ text: chunk.text, textProvenance: chunk.textProvenance })),
        generatorProvider: core.provider,
        generatorModel: core.model,
        routing: reviewPlan?.routing,
        timeBudgetMs: remainingReviewMs,
        batchSize: 5,
      })
    : []
  const reviewByIndex = new Map(candidates.map((item, index) => [item, reviewed[index]]))
  const questions: InternetExamQuestion[] = []
  const academicRejected: ExamGenerationRejected[] = []
  for (const [index, item] of core.items.entries()) {
    const issue = internetQuestionAcademicIssue(item.question.text)
    if (issue) {
      academicRejected.push({ index, reason: issue })
      continue
    }
    const review = reviewByIndex.get(item)
    if (!review?.qualityFlags?.includes('SOURCE_GROUNDED')) {
      academicRejected.push({ index, reason: review?.verifierReason || review?.verificationReason || 'ANSWER_NOT_INDEPENDENTLY_VERIFIED' })
      continue
    }
    questions.push({ ...item.question, sourceUrl: urlBySourceIndex.get(Number(item.sourceIndex)) || '' })
  }
  return {
    questions,
    requested: core.requested,
    accepted: questions.length,
    rejected: [...core.rejected, ...academicRejected],
    rejectedCount: core.rejectedCount + academicRejected.length,
    provider: core.provider,
    model: core.model,
    search: { resultsFound: results.length, chunksUsed: selected.length },
  }
}
