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
  count: number
  chunksSection: string
  previousTexts: string[]
}): string {
  const previousSection = input.previousTexts.length
    ? input.previousTexts.slice(-80).map((q, i) => `${i + 1}. ${String(q).replace(/\s+/g, ' ').trim().slice(0, 260)}`).join('\n')
    : 'لا توجد أسئلة سابقة في هذا الامتحان.'
  return `أنت لجنة امتحانات عليا في الأكاديمية. مهمتك: بناء أسئلة امتحان جامعي (صح/خطأ واختيار متعدد فقط — لا أسئلة مقالية ولا أسئلة قصيرة) من نتائج بحث عبر الإنترنت، لامتحان شامل لخريج درس البرنامج في مؤسسة أخرى.

موضوع البحث: «${input.topic}»
البرنامج: ${input.programTitleAr}
عدد الأسئلة المطلوبة الآن: ${input.count}

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
    count: number
    previousQuestionTexts?: string[]
    deadlineMs?: number
  },
  deps: { completeJson?: CompleteJsonFn } = {},
): Promise<InternetGenerationResult> {
  const requested = clampInternetQuestionCount(input.count)
  const previousTexts = input.previousQuestionTexts || []
  const sourceId = internetSourceId(input.topic)
  const allChunks = tavilyResultsToExamChunks(results, sourceId)
  const selected = selectExamSourceChunks(allChunks, {
    maxChunks: INTERNET_MAX_PROMPT_CHUNKS,
    maxTotalChars: 18000,
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
    count,
    chunksSection: formatInternetChunksForPrompt(selected),
    previousTexts,
  })
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
      deadlineMs: input.deadlineMs,
    },
    deps,
  )
  const questions: InternetExamQuestion[] = core.items.map((item) => ({
    ...item.question,
    sourceUrl: urlBySourceIndex.get(Number(item.sourceIndex)) || '',
  }))
  return {
    questions,
    requested: core.requested,
    accepted: core.accepted,
    rejected: core.rejected,
    rejectedCount: core.rejectedCount,
    provider: core.provider,
    model: core.model,
    search: { resultsFound: results.length, chunksUsed: selected.length },
  }
}
