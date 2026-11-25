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
import { extractDocumentText, isDocxLike } from './document-extract'
import { fixArabicPdfText } from './arabic-pdf-text'
import { looksLikeBrokenBookPageText } from './academic-output-quality'
import { selectExamSourceChunks, type ExamSourceChunk } from './exam-source-chunks'
import { MAX_QUESTIONS_PER_SOURCE_CHUNK } from './comprehensive-exam-evidence'
import {
  generateExamQuestionsFromChunks,
  parseRawQuestionItems,
  countRawQuestionItems,
  type CompleteJsonFn,
  type ExamGenerationResult,
} from './comprehensive-exam-generation'
import type { ComprehensiveQuestionInput } from './comprehensive-exam'

// Re-exported so existing import sites keep working: the parsing
// helpers now live in the shared generation core.
export { parseRawQuestionItems, countRawQuestionItems }
export type { CompleteJsonFn, ExamGenerationResult }

export const CUSTOM_BOOK_MAX_FILE_BYTES = 10 * 1024 * 1024 // 10MB — same cap as a program-book upload
export const CUSTOM_BOOK_MAX_PAGES = 300 // longer books go through the normal book pipeline, then the bank
export const CUSTOM_BOOK_MIN_QUESTIONS = 1
export const CUSTOM_BOOK_MAX_QUESTIONS = 10
export const CUSTOM_BOOK_DEFAULT_QUESTIONS = 5
export const CUSTOM_BOOK_MAX_PROMPT_CHUNKS = 12
export const CUSTOM_BOOK_EXTRACT_BATCH_PAGES = 8 // same batch width as the book pipeline
// Word has no real pages: one pseudo-page is ~one PDF page's worth of
// text, counted and labelled honestly as «مقطع نصي» in the report,
// never as a PDF page. The 300-page cap applies to pseudo-pages too.
export const CUSTOM_BOOK_DOCX_CHARS_PER_PSEUDO_PAGE = 2000
export const CUSTOM_BOOK_DOCX_MAX_CHARS = CUSTOM_BOOK_MAX_PAGES * CUSTOM_BOOK_DOCX_CHARS_PER_PSEUDO_PAGE

export type CustomBookUnreadablePage = { page: number; reason: string }

export type CustomBookChunk = ExamSourceChunk & { pageStart: number; pageEnd: number }

export type CustomBookExtraction = {
  bookId: string // synthetic, never a Book row: `custom-upload:<sha256>`
  bookTitle: string
  kind: 'PDF' | 'DOCX'
  totalPages: number // real PDF pages, or Word pseudo-pages (see CUSTOM_BOOK_DOCX_CHARS_PER_PSEUDO_PAGE)
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

export function formatCustomBookChunksForPrompt(chunks: readonly CustomBookChunk[], pageLabel = 'صفحات'): string {
  return chunks
    .map((c) => `[${c.sourceIndex}] ${pageLabel} ${c.pageStart}–${c.pageEnd} من «${c.bookTitle}»:\n${c.text}`)
    .join('\n\n')
}

function findPseudoPageCut(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars)
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('؟ '), window.lastIndexOf('! '), window.lastIndexOf('؛ '))
  if (sentence > maxChars * 0.5) return sentence + 2
  const space = window.lastIndexOf(' ')
  if (space > maxChars * 0.5) return space + 1
  return maxChars
}

// Splits Word text into pseudo-pages of ~one PDF page's text each,
// at paragraph boundaries (a single over-long paragraph is cut at a
// sentence end, then a space, then hard). Pure — unit-tested directly.
export function splitDocxTextIntoPseudoPages(
  text: string,
  charsPerPage: number = CUSTOM_BOOK_DOCX_CHARS_PER_PSEUDO_PAGE,
): string[] {
  const paragraphs = String(text || '')
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const pages: string[] = []
  let current = ''
  const pushPage = (block: string) => {
    const trimmed = block.trim()
    if (trimmed) pages.push(trimmed)
  }
  const flush = () => {
    pushPage(current)
    current = ''
  }
  for (const paragraph of paragraphs) {
    let rest = paragraph
    while (rest.length > charsPerPage) {
      const cut = findPseudoPageCut(rest, charsPerPage)
      pushPage(rest.slice(0, cut))
      rest = rest.slice(cut).trim()
    }
    if (!current) {
      current = rest
      continue
    }
    if (current.length + 1 + rest.length <= charsPerPage) {
      current += '\n' + rest
      continue
    }
    flush()
    current = rest
  }
  flush()
  return pages
}

// Word (.docx) path: mammoth via extractDocumentText (the repo's own
// reader — no new dependency, no new parser). The text is split into
// pseudo-pages, then the SAME quality gate and the SAME planBookChunks
// chunking as the PDF path run over them. Legacy .doc is rejected by
// the route before it ever reaches here.
async function extractCustomBookDocxChunks(
  buffer: Buffer,
  bookId: string,
  bookTitle: string,
  deps: { extractDocumentText?: typeof extractDocumentText },
): Promise<CustomBookExtraction> {
  const extract = deps.extractDocumentText || extractDocumentText
  const doc = await extract(buffer, '', `${bookTitle}.docx`, CUSTOM_BOOK_DOCX_MAX_CHARS)
  if (doc.reader === 'ERROR') throw new Error('CUSTOM_BOOK_DOCX_UNREADABLE')
  if (!doc.readable || !doc.text.trim()) {
    return { bookId, bookTitle, kind: 'DOCX', totalPages: 0, readablePages: 0, unreadablePages: [], chunks: [] }
  }
  const pseudoPages = splitDocxTextIntoPseudoPages(doc.text)
  if (pseudoPages.length > CUSTOM_BOOK_MAX_PAGES) throw new Error('CUSTOM_BOOK_TOO_LONG')
  const pages: ExtractedBookPage[] = pseudoPages.map((text, i) => ({ page: i + 1, text, textProvenance: 'NATIVE_TEXT' as const }))
  const unreadablePages: CustomBookUnreadablePage[] = []
  const cleanPages: ExtractedBookPage[] = []
  for (const page of pages) {
    if (!page.text.trim()) {
      unreadablePages.push({ page: page.page, reason: 'NO_EXTRACTABLE_TEXT' })
      continue
    }
    if (looksLikeBrokenBookPageText(page.text)) {
      unreadablePages.push({ page: page.page, reason: 'BOOK_PAGE_TEXT_FAILED_QUALITY_GATE' })
      continue
    }
    cleanPages.push(page)
  }
  const planned = planBookChunks(cleanPages)
  return {
    bookId,
    bookTitle,
    kind: 'DOCX',
    totalPages: pseudoPages.length,
    readablePages: cleanPages.length,
    unreadablePages,
    chunks: customBookChunksToExamChunks(planned, bookId, bookTitle),
  }
}

// Reads the uploaded PDF in memory only — no Book row, no job row, no
// pipeline state. Pages with no text or with garbled text (the same
// quality gate the book pipeline uses) are reported as unreadable
// holes, never silently dropped and never turned into chunks.
export async function extractCustomBookChunks(
  buffer: Buffer,
  fileName: string,
  deps: { extractPages?: typeof extractNumberedPdfPages; extractDocumentText?: typeof extractDocumentText } = {},
): Promise<CustomBookExtraction> {
  const bookId = customBookSourceId(buffer)
  const bookTitle = customBookFileName(fileName)
  if (isDocxLike('', fileName)) return extractCustomBookDocxChunks(buffer, bookId, bookTitle, deps)
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
    kind: 'PDF',
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

// Generates MCQ/TF questions from the uploaded book's chunks via the
// shared generation core: the evidence validator is the same gate the
// program-exam generation uses — every accepted question carries a
// verbatim span from one selected chunk, at most 3 questions per
// chunk. The requested count is clamped to what the evidence allows
// (chunks × 3) and reported.
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
  const chunksSection = formatCustomBookChunksForPrompt(
    selected as CustomBookChunk[],
    extraction.kind === 'DOCX' ? 'مقاطع نصية' : 'صفحات',
  )
  const prompt = buildCustomBookQuestionPrompt({
    bookTitle: extraction.bookTitle,
    programTitleAr: input.programTitleAr,
    count,
    chunksSection,
    previousTexts,
  })
  const batchId = `custom-book-${Date.now()}`
  const core = await generateExamQuestionsFromChunks(
    {
      selected,
      requested,
      prompt,
      previousTexts,
      batchId,
      stickyScope: `COMPREHENSIVE_CUSTOM_BOOK:${batchId}`,
      detailSource: 'comprehensive-exam-custom-book',
      deadlineMs: input.deadlineMs,
    },
    deps,
  )
  return {
    questions: core.items.map((item) => item.question),
    requested: core.requested,
    accepted: core.accepted,
    rejected: core.rejected,
    rejectedCount: core.rejectedCount,
    provider: core.provider,
    model: core.model,
  }
}
