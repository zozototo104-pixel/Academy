// Comprehensive exam — custom-book question source (phase 1).
// The admin uploads ONE PDF inside the preparation tab. The book is
// NEVER enrolled as a program book: its text is read in memory only,
// questions are generated from its chunks, and only the questions
// (each with a verbatim evidence span) are saved — PENDING_REVIEW.
// Closed questions ONLY (MCQ | TF). There is no essay type anywhere
// in this module. Scanned books with no readable text layer are
// reported honestly as unreadable — no silent zero-question result.
import { createHash } from 'crypto'
import { PDFDocument } from 'pdf-lib'
import { extractNumberedPdfPages, planBookChunks, type ExtractedBookPage } from './book-reader'
import { fixArabicPdfText } from './arabic-pdf-text'
import { looksLikeBrokenBookPageText } from './academic-output-quality'
import { selectExamSourceChunks, type ExamSourceChunk } from './exam-source-chunks'
import { normalizeArabic } from './arabic-normalize'
import {
  MAX_QUESTIONS_PER_SOURCE_CHUNK,
  throwComprehensiveExamInsufficientSource,
  validateGeneratedExamQuestionsAgainstSelectedChunks,
  type GeneratedComprehensiveExamQuestion,
} from './comprehensive-exam-evidence'
import { validateComprehensiveQuestion, type ComprehensiveQuestionInput } from './comprehensive-exam'
import { validateQuestionBatchAgainstKnowledge } from './question-bank-evidence'
import { geminiCompleteJson } from './gemini'
import { prepareStageRun, runStageAttempt, type StageUsage } from './ai-stage-runner'
import { withPipelineRun } from './ai-pipeline-log'
import type { TextAiPreferredModel, TextAiProvider, TextAiRouterPolicy } from './text-ai'

export const CUSTOM_BOOK_MAX_FILE_BYTES = 10 * 1024 * 1024 // 10MB — same cap as a program-book upload
export const CUSTOM_BOOK_MAX_PAGES = 300 // longer books go through the normal book pipeline, then the bank
export const CUSTOM_BOOK_MIN_QUESTIONS = 1
export const CUSTOM_BOOK_MAX_QUESTIONS = 10
export const CUSTOM_BOOK_DEFAULT_QUESTIONS = 5
export const CUSTOM_BOOK_MAX_PROMPT_CHUNKS = 12
export const CUSTOM_BOOK_EXTRACT_BATCH_PAGES = 8 // same batch width as the book pipeline

export type CustomBookUnreadablePage = { page: number; reason: string }

export type CustomBookChunk = ExamSourceChunk & { pageStart: number; pageEnd: number }

export type CustomBookExtraction = {
  bookId: string // synthetic, never a Book row: `custom-upload:<sha256>`
  bookTitle: string
  totalPages: number
  readablePages: number
  unreadablePages: CustomBookUnreadablePage[]
  chunks: CustomBookChunk[] // ALL chunks, sourceIndex 1..n over the whole book
}

export type CustomBookRejectedQuestion = { index: number; reason: string }

export type CustomBookGenerationResult = {
  questions: ComprehensiveQuestionInput[]
  requested: number
  accepted: number
  rejected: CustomBookRejectedQuestion[]
  rejectedCount: number
  provider?: string
  model?: string
}

export function clampCustomBookQuestionCount(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return CUSTOM_BOOK_DEFAULT_QUESTIONS
  return Math.max(CUSTOM_BOOK_MIN_QUESTIONS, Math.min(CUSTOM_BOOK_MAX_QUESTIONS, Math.floor(n)))
}

// The synthetic id is content-addressed, so re-uploading the same file
// maps to the same source — and it can never collide with a real Book
// id (cuid), so it is safe to store on the question rows as sourceBookId.
export function customBookSourceId(buffer: Buffer): string {
  return `custom-upload:${createHash('sha256').update(buffer).digest('hex').slice(0, 16)}`
}

export function customBookFileName(fileName: string): string {
  const name = String(fileName || '').trim().replace(/\.[^.]+$/, '').trim()
  return name || 'كتاب مخصص'
}

// Pure mapping: planned chunks (with page ranges) → evidence chunks.
// The page range survives into the prompt locator and the saved evidence.
export function customBookChunksToExamChunks(
  chunks: ReadonlyArray<{ index: number; pageStart: number; pageEnd: number; text: string; textProvenance: 'NATIVE_TEXT' | 'VISION_OCR' }>,
  bookId: string,
  bookTitle: string,
): CustomBookChunk[] {
  return chunks.map((c, i) => ({
    sourceIndex: i + 1,
    bookId,
    bookTitle,
    text: c.text,
    textProvenance: c.textProvenance,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
  }))
}

export function formatCustomBookChunksForPrompt(chunks: readonly CustomBookChunk[]): string {
  return chunks
    .map((c) => `[${c.sourceIndex}] صفحات ${c.pageStart}–${c.pageEnd} من «${c.bookTitle}»:\n${c.text}`)
    .join('\n\n')
}

// Parses the model's JSON array (bare or wrapped in prose). The
// evidence validator reports rejections only when it throws, so the
// caller reuses this parse to attach a reason to each dropped draft.
export function parseRawQuestionItems(raw: string): Array<Record<string, unknown>> {
  const trimmed = String(raw || '').trim()
  const tryParse = (text: string): Array<Record<string, unknown>> | null => {
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : null
    } catch {
      return null
    }
  }
  const direct = tryParse(trimmed)
  if (direct) return direct
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) return tryParse(trimmed.slice(start, end + 1)) ?? []
  return []
}

export function countRawQuestionItems(raw: string): number {
  return parseRawQuestionItems(raw).length
}

// Reads the uploaded PDF in memory only — no Book row, no job row, no
// pipeline state. Pages with no text or with garbled text (the same
// quality gate the book pipeline uses) are reported as unreadable
// holes, never silently dropped and never turned into chunks.
export async function extractCustomBookChunks(
  buffer: Buffer,
  fileName: string,
  deps: { extractPages?: typeof extractNumberedPdfPages } = {},
): Promise<CustomBookExtraction> {
  const bookId = customBookSourceId(buffer)
  const bookTitle = customBookFileName(fileName)
  let pdf: Awaited<ReturnType<typeof PDFDocument.load>>
  try {
    pdf = await PDFDocument.load(buffer)
  } catch {
    throw new Error('CUSTOM_BOOK_NOT_A_PDF')
  }
  const totalPages = pdf.getPageCount()
  if (totalPages < 1) throw new Error('CUSTOM_BOOK_EMPTY_PDF')
  if (totalPages > CUSTOM_BOOK_MAX_PAGES) throw new Error('CUSTOM_BOOK_TOO_LONG')
  const extractPages = deps.extractPages || extractNumberedPdfPages
  const pages: ExtractedBookPage[] = []
  for (let start = 1; start <= totalPages; start += CUSTOM_BOOK_EXTRACT_BATCH_PAGES) {
    const numbers = Array.from(
      { length: Math.min(CUSTOM_BOOK_EXTRACT_BATCH_PAGES, totalPages - start + 1) },
      (_, i) => start + i,
    )
    let batch: ExtractedBookPage[]
    try {
      batch = await extractPages(buffer, numbers)
    } catch (error) {
      // One corrupt batch must not cancel the rest of the book.
      const reason = 'NATIVE_EXTRACTION_FAILED: ' + String(error instanceof Error ? error.message : error).slice(0, 120)
      batch = numbers.map((page) => ({ page, text: '', textProvenance: 'NATIVE_TEXT' as const, readError: reason }))
    }
    pages.push(...batch)
  }
  pages.sort((a, b) => a.page - b.page)
  const unreadablePages: CustomBookUnreadablePage[] = []
  const cleanPages: ExtractedBookPage[] = []
  for (const page of pages) {
    const text = page.textProvenance === 'NATIVE_TEXT' ? fixArabicPdfText(page.text) : page.text
    if (!text.trim()) {
      unreadablePages.push({ page: page.page, reason: page.readError || 'NO_EXTRACTABLE_TEXT' })
      continue
    }
    if (looksLikeBrokenBookPageText(text)) {
      unreadablePages.push({ page: page.page, reason: 'BOOK_PAGE_TEXT_FAILED_QUALITY_GATE' })
      continue
    }
    cleanPages.push({ ...page, text })
  }
  const planned = planBookChunks(cleanPages)
  return {
    bookId,
    bookTitle,
    totalPages,
    readablePages: cleanPages.length,
    unreadablePages,
    chunks: customBookChunksToExamChunks(planned, bookId, bookTitle),
  }
}

// The generation prompt. MCQ/TF ONLY — the two allowed types are the
// only ones named in the JSON example, and essay/short questions are
// forbidden in plain words. Evidence rules mirror the existing exam
// generation prompt: verbatim quotes, one chunk per evidence, max 3
// questions per chunk.
export function buildCustomBookQuestionPrompt(input: {
  bookTitle: string
  programTitleAr: string
  count: number
  chunksSection: string
  previousTexts: string[]
}): string {
  const previousSection = input.previousTexts.length
    ? input.previousTexts.slice(-80).map((q, i) => `${i + 1}. ${String(q).replace(/\s+/g, ' ').trim().slice(0, 260)}`).join('\n')
    : 'لا توجد أسئلة سابقة في هذا الامتحان.'
  return `أنت لجنة امتحانات عليا في الأكاديمية. مهمتك: بناء أسئلة امتحان جامعي (صح/خطأ واختيار متعدد فقط — لا أسئلة مقالية ولا أسئلة قصيرة) من كتاب مرفوع، لامتحان شامل لخريج درس البرنامج في مؤسسة أخرى.

الكتاب: «${input.bookTitle}»
البرنامج: ${input.programTitleAr}
عدد الأسئلة المطلوبة الآن: ${input.count}

المقاطع المختارة الوحيدة المسموح استخدامها كمصدر. كل sourceEvidence يجب أن يكون اقتباساً حرفياً من المقطع المشار إليه فقط، بعدد 40 حرفاً على الأقل، ولا يجوز استخدام أي ملخص أو معرفة عامة كدليل:

${input.chunksSection}

أسئلة سبق توليدها في نفس الامتحان ويُمنع تكرارها أو تكرار فكرتها أو خياراتها:
${previousSection}

شروط صارمة:
- كل سؤال يقيس نقطة تعلم مركزية من الكتاب: مفهوم، نموذج، نظرية، قرار، علاقة سببية، خطأ تطبيقي، أو حالة تحليلية. إذا استطاع الطالب الإجابة دون قراءة الكتاب فالسؤال مرفوض.
- لا تستخدم نفس sourceIndex لأكثر من ${MAX_QUESTIONS_PER_SOURCE_CHUNK} أسئلة؛ وزّع الأسئلة بين المقاطع.
- سؤال الاختيار المتعدد: options مصفوفة 4 نصوص مختلفة تماماً، وcorrectAnswer نص الخيار الصحيح نفسه مطابقاً لأحد عناصر options. وزّع الإجابات الصحيحة بين الخيارات ولا تجعل الخيار الصحيح دائماً الأول.
- سؤال صح/خطأ: options ["صح","خطأ"]، وcorrectAnswer "صح" أو "خطأ"، والعبارة من محتوى الكتاب لا عموميات.
- كل سؤال: sourceIndex رقم المقطع، وsourceEvidence اقتباس حرفي لا يقل عن 40 حرفاً من ذلك المقطع فقط؛ لا تقبل إعادة الصياغة هنا.
- كل سؤال: difficulty واحدة من EASY أو MEDIUM أو ADVANCED، وrationale يشرح لماذا الإجابة صحيحة (12 حرفاً على الأقل).
- صياغة عربية فصحى واضحة؛ صحّح تشوهات النص في صياغة السؤال ولا تنقل عبارات مكسورة.
- لا تكرر سؤالاً أو فكرة سؤال مرتين، ولا تكرر نفس خيارات الاختيار بين سؤال وآخر.
- لا تبدأ نص السؤال بـ «وفق المقطع الآتي» أو «يعرض الكتاب» أو أي صيغة قالبية مشابهة.
- لا تضع أسئلة عن إدارة أو قيادة عامة إلا إذا وردت في محتوى الكتاب نفسه.
- ممنوع تماماً أي سؤال مقالي أو سؤال قصير — النوعان المسموحان فقط هما MCQ وTF.
- لا تستخدم علامة تنصيص " داخل نص السؤال أو الخيارات (استخدم «» بدلاً منها).
- أرسل كل سؤال في سطر مستقل — كائن JSON واحد لكل سطر داخل مصفوفة.

أجب بصيغة JSON فقط — مصفوفة من ${input.count} أسئلة، مثال شكلي فقط:
[{"type":"MCQ","text":"...","options":["...","...","...","..."],"correctAnswer":"...","sourceIndex":1,"sourceEvidence":"اقتباس حرفي لا يقل عن أربعين حرفاً من نص المصدر المحدد فقط","difficulty":"MEDIUM","rationale":"سبب صحة الخيار الصحيح مستنداً إلى الدليل"},
{"type":"TF","text":"...","options":["صح","خطأ"],"correctAnswer":"صح","sourceIndex":2,"sourceEvidence":"اقتباس حرفي لا يقل عن أربعين حرفاً من نص المصدر المحدد فقط","difficulty":"EASY","rationale":"سبب صحة الحكم"}]`
}

type CompleteJsonFn = (args: {
  system: string
  prompt: string
  validate: (text: string, context?: { provider: string; model: string }) => void
}) => Promise<{ text: string; provider?: string; model?: string }>

// The default completion path: the GENERATION stage profile (the
// admin's chosen models, or the auto ranking when auto is on) with the
// same ACADEMIC_CRITICAL strictness as the existing exam generation —
// a failed validation rethrows, so the allowlist cannot be escaped.
async function defaultCompleteJsonWithStage(args: {
  system: string
  prompt: string
  batchId: string
  deadlineMs: number
  validate: (text: string, context?: { provider: string; model: string }) => void
}): Promise<{ text: string; provider?: string; model?: string }> {
  const genPlan = await prepareStageRun('GENERATION')
  const genUsage: StageUsage = { fallbackUsed: false }
  let context: { provider?: string; model?: string } = {}
  const text = await withPipelineRun(
    {
      stage: 'GENERATION',
      bookId: null,
      batchId: args.batchId,
      inputText: args.prompt,
      promptText: args.system,
      profileStamp: genPlan.profileStamp,
      fallbackUsed: !genPlan.isStage,
      liveState: genUsage,
      detail: { ...genPlan.detail, source: 'comprehensive-exam-custom-book' },
    },
    () =>
      runStageAttempt(genPlan, genUsage, (routing) => {
        const routingModels = routing
          ? routing.preferredModels.map((m) => ({ provider: m.provider as TextAiPreferredModel['provider'], model: m.model }))
          : []
        return geminiCompleteJson({
          system: args.system,
          history: [{ role: 'user', text: args.prompt }],
          temperature: 0.25,
          maxOutputTokens: 8192,
          taskLevel: 'ACADEMIC_CRITICAL',
          deadlineMs: args.deadlineMs,
          stickyScope: `COMPREHENSIVE_CUSTOM_BOOK:${args.batchId}`,
          validate: (t, c) => {
            context = c || {}
            args.validate(t, c)
          },
          ...(routing
            ? {
                preferredModels: routingModels,
                restrictToModels: routingModels,
                preferredProviders: [...new Set([...routing.preferredProviders, ...routing.preferredModels.map((m) => m.provider)])] as TextAiProvider[],
                ...(routing.policy ? { routerPolicy: routing.policy as TextAiRouterPolicy } : {}),
              }
            : {}),
        })
      }),
    () => ({ provider: context.provider ?? null, model: context.model ?? null }),
  )
  return { text, provider: context.provider, model: context.model }
}

function mapValidatedToComprehensiveInput(
  validated: readonly GeneratedComprehensiveExamQuestion[],
  previousTexts: readonly string[],
): { questions: ComprehensiveQuestionInput[]; rejected: CustomBookRejectedQuestion[] } {
  const questions: ComprehensiveQuestionInput[] = []
  const rejected: CustomBookRejectedQuestion[] = []
  const seen = new Set(previousTexts.map((t) => normalizeArabic(t)))
  validated.forEach((q, index) => {
    const key = normalizeArabic(q.text)
    if (seen.has(key)) {
      rejected.push({ index, reason: 'DUPLICATE_OF_EXISTING_QUESTION' })
      return
    }
    const checked = validateComprehensiveQuestion({
      type: q.type,
      text: q.text,
      options: q.type === 'TF' ? ['صح', 'خطأ'] : q.options,
      correctAnswer: q.correct,
      sourceEvidence: q.sourceEvidence,
    })
    if (!checked.ok) {
      rejected.push({ index, reason: checked.errors.join('؛ ') })
      return
    }
    seen.add(key)
    questions.push(checked.question)
  })
  return { questions, rejected }
}

// Generates MCQ/TF questions from the uploaded book's chunks. The
// evidence validator is the same gate the program-exam generation
// uses: every accepted question carries a verbatim span from one
// selected chunk, at most 3 questions per chunk. The requested count
// is clamped to what the evidence allows (chunks × 3) and reported.
export async function generateCustomBookQuestions(
  extraction: CustomBookExtraction,
  input: {
    programTitleAr: string
    count: number
    previousQuestionTexts?: string[]
    deadlineMs?: number
  },
  deps: { completeJson?: CompleteJsonFn } = {},
): Promise<CustomBookGenerationResult> {
  const requested = clampCustomBookQuestionCount(input.count)
  const previousTexts = input.previousQuestionTexts || []
  const selected = selectExamSourceChunks(extraction.chunks, {
    maxChunks: CUSTOM_BOOK_MAX_PROMPT_CHUNKS,
    maxTotalChars: 18000,
  })
  if (!selected.length) {
    throw new Error('مصادر الكتاب غير كافية لتوليد أسئلة موثّقة (المتاح: 0 مقاطع)')
  }
  const maxByEvidence = selected.length * MAX_QUESTIONS_PER_SOURCE_CHUNK
  const count = Math.min(requested, maxByEvidence)
  const chunksSection = formatCustomBookChunksForPrompt(selected as CustomBookChunk[])
  const prompt = buildCustomBookQuestionPrompt({
    bookTitle: extraction.bookTitle,
    programTitleAr: input.programTitleAr,
    count,
    chunksSection,
    previousTexts,
  })
  const system = 'أنت لجنة امتحانات عليا ترجع JSON صالحاً فقط دون أي نص إضافي أو تعليقات.'
  const deadlineMs = input.deadlineMs || Date.now() + 240_000
  const batchId = `custom-book-${Date.now()}`
  let generationContext: { provider?: string; model?: string } = {}
  // The router's retry signal is the evidence validation itself: an
  // empty batch or a mostly-rejected batch throws VALIDATION_REJECTED
  // and the router tries another model. A short-but-nonempty batch is
  // NOT a failure here — the surviving questions are saved and the
  // shortfall is reported, so the admin can press again.
  const validate = (text: string, context?: { provider: string; model: string }) => {
    generationContext = context || {}
    validateGeneratedExamQuestionsAgainstSelectedChunks(text, selected, 'MIX_CORE', generationContext)
  }
  const complete: CompleteJsonFn =
    deps.completeJson ||
    (async (args) => defaultCompleteJsonWithStage({ ...args, batchId, deadlineMs }))
  const { text: raw } = await complete({ system, prompt, validate })
  const validated = validateGeneratedExamQuestionsAgainstSelectedChunks(raw, selected, 'MIX_CORE', generationContext)
  const mapped = mapValidatedToComprehensiveInput(validated, previousTexts)
  // The evidence validator guarantees at least one accepted question;
  // the single gate can still reject all of them (e.g. a text shorter
  // than its 10-character floor). That is a wholly empty batch: fail
  // outright rather than saving nothing silently.
  if (!mapped.questions.length) {
    throwComprehensiveExamInsufficientSource({
      availableChunks: selected.length,
      requestedQuestions: count,
      acceptedQuestions: 0,
    })
  }
  // The validator returns only the survivors, so the reasons for the
  // dropped drafts are rebuilt here from the same pure evidence check
  // it runs internally: evidence rejections carry their reason
  // (NOT_FOUND / BAD_INDEX / TOO_SHORT), shape rejections get a generic
  // reason, and mapping rejections keep theirs — all keyed by the raw
  // position in the model's array.
  const rawItems = parseRawQuestionItems(raw)
  const validatedTexts = new Set(validated.map((q) => normalizeArabic(q.text)))
  const rejected: CustomBookRejectedQuestion[] = []
  const evidenceRejectedIndexes = new Set<number>()
  const knowledge = validateQuestionBatchAgainstKnowledge(
    rawItems.map((r) => ({
      sourceIndex: (r as any)?.sourceIndex ?? '',
      sourceEvidence: String((r as any)?.sourceEvidence ?? ''),
    })),
    selected,
  )
  for (const r of knowledge.rejected) {
    if (validatedTexts.has(normalizeArabic(String((rawItems[r.index] as any)?.text ?? '')))) continue
    evidenceRejectedIndexes.add(r.index)
    rejected.push({ index: r.index, reason: r.reason })
  }
  rawItems.forEach((_item, i) => {
    if (validatedTexts.has(normalizeArabic(String((_item as any)?.text ?? '')))) return
    if (evidenceRejectedIndexes.has(i)) return
    rejected.push({ index: i, reason: 'VALIDATION_REJECTED' })
  })
  for (const m of mapped.rejected) {
    const text = normalizeArabic(validated[m.index]?.text ?? '')
    const rawIndex = rawItems.findIndex((r) => normalizeArabic(String((r as any)?.text ?? '')) === text)
    rejected.push({ index: rawIndex >= 0 ? rawIndex : m.index, reason: m.reason })
  }
  rejected.sort((a, b) => a.index - b.index)
  const rejectedCount = Math.max(0, rawItems.length - validated.length) + mapped.rejected.length
  return {
    questions: mapped.questions,
    requested,
    accepted: mapped.questions.length,
    rejected,
    rejectedCount,
    provider: generationContext.provider,
    model: generationContext.model,
  }
}
