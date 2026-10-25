import { db } from '@/lib/db'
import { textAiCompleteJson } from '@/lib/text-ai'
import { extractDocumentText, isPdfLike } from '@/lib/document-extract'
import { getFileBufferFromStorageOrBase64, getStorageDownloadPathForKey } from '@/lib/storage'
import { notify, audit } from '@/lib/notify'
import { emailAssignmentGraded } from '@/lib/mailer'
import { cleanAcademicOutput, looksLikeBrokenGeneratedArabic } from '@/lib/academic-output-quality'
// مسار قراءة الكتب نفسه (مرحلة READING): استخراج صفحة صفحة، OCR للصفحات
// المصوّرة فقط، إصلاح نص العربية، وتقسيم لمقاطع — بلا كتابة أي شيء في بنك
// المعرفة، لأن إجابة الطالب ليست كتاباً ولا تدخل بنك المعرفة أبداً.
import { extractNumberedPdfPages, transcribeScannedDocumentWithVision, planBookChunks, pagesNeedingOcr } from '@/lib/book-reader'
import { fixArabicPdfText } from '@/lib/arabic-pdf-text'
// cleanAcademicOutput هو نفسه حارس مخرجات بنك المعرفة (knowledge-bank يعيد تصديره
// باسم cleanAcademicGeneratedText) — نستورده من مصدره المباشر لتجنب سلسلة استيراد ثقيلة.
import { PDFDocument } from 'pdf-lib'

// ===== تحليل واجب طالب بمساعدة الذكاء، مع اعتماد بشري فقط =====
// القاعدة الصارمة: هذه الطبقة لا تحفظ أي درجة ولا ترسل أي نتيجة للطالب.
// التحليل يرجع مسودة فقط، والحفظ يتم حصرياً عبر gradeAssignmentSubmission
// بعد أن يعدّلها المشرف البشري ويعتمدها بنفسه.

export interface RubricCriterion {
  label: string
  weightPct: number
}

export interface DraftCriterion {
  label: string
  points: number
  maxPoints: number
  justification: string
}

export interface AiGradingDraft {
  score: number
  criteria: DraftCriterion[] | null
  feedback: string
  strengths: string[]
  gaps: string[]
  errors: string[]
  effortNote: string
}

export interface AnswerProvenance {
  answerSource: 'TEXT' | 'TEXT_AND_FILE' | 'FILE_TEXT' | 'FILE_OCR' | 'FILE_UNREADABLE' | 'NONE'
  answerSourceLabel: string
  ocrNote: string | null
  bookContextUsed: boolean
  bookTitles: string[]
  answerTruncated: boolean
}

export const DEFAULT_RUBRIC: RubricCriterion[] = [
  { label: 'الاستناد إلى مصادر الوحدة', weightPct: 30 },
  { label: 'جودة التحليل', weightPct: 30 },
  { label: 'التطبيق المهني', weightPct: 25 },
  { label: 'وضوح العرض', weightPct: 15 },
]

const MAX_ANSWER_CHARS = 20000
const MAX_BOOK_CHARS = 8000
const MAX_OCR_CHARS = 12000
// دفعات الكتب نفسها: 8 صفحات للدفعة كحد أقصى، و3 دفعات كحد لملف واجب واحد.
const MAX_PDF_PAGES = 24

/** قراءة PDF بمسار الكتب: صفحات مرقّمة، OCR لصفحات بلا نص فقط، مقاطع 2500–4000 حرف. */
export async function readPdfWithBookPath(buffer: Buffer): Promise<{ text: string; ocrPages: number; totalPages: number; truncated: boolean }> {
  const doc = await PDFDocument.load(buffer)
  const totalPages = doc.getPageCount()
  const pagesToRead = Math.min(totalPages, MAX_PDF_PAGES)
  const pages: { page: number; text: string; textProvenance: 'NATIVE_TEXT' | 'VISION_OCR' }[] = []
  let ocrPages = 0
  for (let start = 0; start < pagesToRead; start += 8) {
    const numbers = Array.from({ length: Math.min(8, pagesToRead - start) }, (_, i) => start + i + 1)
    const extracted = await extractNumberedPdfPages(buffer, numbers)
    const pageMap = new Map(extracted.map((p) => [p.page, p]))
    for (const range of pagesNeedingOcr(extracted)) {
      const ocr = await transcribeScannedDocumentWithVision(buffer, range, Date.now() + 120_000)
      for (const page of ocr) pageMap.set(page.page, page)
    }
    for (const number of numbers) {
      const page = pageMap.get(number)
      if (!page) continue
      if (page.textProvenance === 'NATIVE_TEXT') {
        pages.push({ page: page.page, text: fixArabicPdfText(page.text), textProvenance: 'NATIVE_TEXT' })
      } else {
        pages.push({ page: page.page, text: page.text, textProvenance: 'VISION_OCR' })
        ocrPages += 1
      }
    }
  }
  const chunks = planBookChunks(pages)
  return { text: chunks.map((c) => c.text).join('\n\n'), ocrPages, totalPages, truncated: totalPages > pagesToRead }
}

function cleanText(value: unknown, max: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function cleanParagraph(value: unknown, max: number): string {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max)
}

/** تحليل نص المعايير إلى أوزان. إذا لم تكن الأوزان صريحة أو مجموعها ليس 100، نرجع الافتراضي. */
export function parseRubricCriteria(rubric: string | null | undefined): RubricCriterion[] {
  const raw = String(rubric || '').trim()
  if (!raw) return DEFAULT_RUBRIC
  // قد تكون المعايير JSON array — في هذه الحالة نعاملها كنص عادي إذا لم تحمل نسباً.
  const segments = raw.split(/[،,;\n]+/).map((s) => s.trim()).filter(Boolean)
  const parsed: RubricCriterion[] = []
  for (const segment of segments) {
    const match = segment.match(/(\d+(?:\.\d+)?)\s*%/)
    if (!match) continue
    const label = segment
      .slice(0, match.index)
      .replace(/^[\d\-.:)\s]+/, '')
      .replace(/[:：]\s*$/, '')
      .trim()
    if (!label) continue
    parsed.push({ label: label.slice(0, 80), weightPct: Number(match[1]) })
  }
  const sum = parsed.reduce((total, c) => total + c.weightPct, 0)
  if (parsed.length >= 2 && Math.abs(sum - 100) < 0.01) return parsed
  return DEFAULT_RUBRIC
}

/** تطبيع مخرجات الذكاء الخام إلى مسودة صالحة، أو null إذا كانت غير صالحة. */
export function normalizeAiDraft(raw: any, points: number, criteria: RubricCriterion[]): AiGradingDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const scoreRaw = Number((raw as any).score)
  if (!Number.isFinite(scoreRaw)) return null
  const score = Math.min(points, Math.max(0, Math.round(scoreRaw * 100) / 100))
  // صياغة الرد بنفس حارس مخرجات الكتب: تنظيف مخرجات أكاديمية، ثم حارس العربية المكسورة.
  const feedback = cleanAcademicOutput((raw as any).feedback, 4000)
  if (feedback.length < 20 || looksLikeBrokenGeneratedArabic(feedback)) return null

  let breakdown: DraftCriterion[] | null = null
  const rawCriteria = Array.isArray((raw as any).criteria) ? (raw as any).criteria : null
  if (rawCriteria && rawCriteria.length === criteria.length) {
    const mapped: DraftCriterion[] = []
    let valid = true
    for (let i = 0; i < criteria.length; i++) {
      const maxPoints = Math.round(((points * criteria[i].weightPct) / 100) * 100) / 100
      const value = Number(rawCriteria[i]?.points)
      if (!Number.isFinite(value) || value < 0 || value > maxPoints + 0.01) {
        valid = false
        break
      }
      mapped.push({
        label: criteria[i].label,
        points: Math.round(value * 100) / 100,
        maxPoints,
        justification: cleanText(rawCriteria[i]?.justification, 300),
      })
    }
    if (valid) {
      const sum = mapped.reduce((total, c) => total + c.points, 0)
      // التفصيل يجب أن يطابق المجموع؛ إلا ذلك نسقط التفصيل ونبقي المجموع فقط.
      if (Math.abs(sum - score) <= Math.max(0.5, points * 0.02)) breakdown = mapped
    }
  }

  const stringList = (value: unknown): string[] => {
    if (!Array.isArray(value)) return []
    return value.map((v) => cleanText(v, 300)).filter(Boolean).slice(0, 8)
  }

  return {
    score,
    criteria: breakdown,
    feedback,
    strengths: stringList((raw as any).strengths),
    gaps: stringList((raw as any).gaps),
    errors: stringList((raw as any).errors),
    effortNote: cleanText((raw as any).effortNote, 600),
  }
}

function parseAiJson(raw: string): any | null {
  const text = String(raw || '').trim()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    // فشل JSON المباشر — جرّب استخراج كتلة JSON أو كتلة مسيّجة.
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  if (fenced) {
    try {
      return JSON.parse(fenced)
    } catch {
      // تابع إلى الاستخراج العام.
    }
  }
  const obj = text.match(/\{[\s\S]*\}/)?.[0]
  if (obj) {
    try {
      return JSON.parse(obj)
    } catch {
      return null
    }
  }
  return null
}

/**
 * نطاق المشرف: الأدمن مسموح دائماً (تجاوز)، والمشرف البشري مسموح فقط
 * إذا كان admission.supervisorId يساوي حسابه الحالي لنفس البرنامج.
 * الطالب الذي ما زال على مشرف ذكي فقط (supervisorId فارغ) لا يملك مشرفاً
 * بشرياً يصحح له، فيبقى الاعتماد للأدمن.
 */
export async function assertSupervisorScope(user: { id: string; role: string }, submission: any): Promise<any> {
  if (user.role === 'ADMIN') return null
  if (user.role !== 'SUPERVISOR') {
    const error = new Error('FORBIDDEN') as Error & { status?: number }
    error.status = 403
    throw error
  }
  const admission = await db.admissionApplication.findFirst({
    where: { userId: submission.userId, programId: submission.assignment.programId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, supervisorId: true, supervisionMode: true },
  })
  if (!admission || admission.supervisorId !== user.id) {
    const error = new Error('FORBIDDEN') as Error & { status?: number }
    error.status = 403
    throw error
  }
  return admission
}

export async function loadSupervisorAssignmentDetail(submissionId: string, user: { id: string; role: string; name?: string | null }) {
  const submission = await db.assignmentSubmission.findUnique({
    where: { id: submissionId },
    include: {
      assignment: true,
      user: { select: { id: true, name: true, email: true } },
    },
  })
  if (!submission) return null
  await assertSupervisorScope(user, submission)
  return {
    submissionId: submission.id,
    assignmentId: submission.assignment.id,
    assignmentTitle: cleanAcademicOutput(submission.assignment.title, 220),
    assignmentDescription: cleanAcademicOutput(submission.assignment.description, 6000),
    assignmentPoints: submission.assignment.points,
    assignmentRubric: submission.assignment.rubric || null,
    assignmentUnitId: submission.assignment.unitId || null,
    assignmentSemester: submission.assignment.semester,
    programId: submission.assignment.programId,
    studentName: submission.user?.name || 'طالب',
    studentEmail: submission.user?.email || null,
    answerText: submission.answerText || null,
    fileName: submission.fileName || null,
    fileUrl: submission.fileStorageKey ? getStorageDownloadPathForKey(submission.fileStorageKey) : null,
    mimeType: submission.mimeType || null,
    status: submission.status,
    score: submission.score ?? null,
    feedback: submission.feedback || null,
    submittedAt: submission.submittedAt,
  }
}

async function loadBookContext(programId: string, unitId: string | null, semester: number): Promise<{ text: string; titles: string[]; used: boolean }> {
  try {
    let unit: any = null
    if (unitId) {
      unit = await db.unit.findUnique({
        where: { id: unitId },
        select: { id: true, title: true, sourceBookId: true, chunkStartIndex: true, chunkEndIndex: true },
      })
    }
    if (!unit || !unit.sourceBookId || unit.chunkStartIndex == null || unit.chunkEndIndex == null) {
      const units = await db.unit.findMany({
        where: { programId, semester },
        orderBy: [{ order: 'asc' }],
        select: { id: true, title: true, sourceBookId: true, chunkStartIndex: true, chunkEndIndex: true },
      })
      unit = units.find((u: any) => u.sourceBookId && u.chunkStartIndex != null && u.chunkEndIndex != null) || null
    }
    if (!unit) return { text: '', titles: [], used: false }
    const chunks = await db.bookChunk.findMany({
      where: { bookId: unit.sourceBookId, index: { gte: unit.chunkStartIndex, lte: unit.chunkEndIndex } },
      orderBy: { index: 'asc' },
      take: 12,
      select: { id: true, text: true },
    })
    if (!chunks.length) return { text: '', titles: [], used: false }
    const knowledge = await db.bookKnowledgeItem.findMany({
      where: { programId, kbVersion: 2, chunkId: { in: chunks.map((c: any) => c.id) }, category: { notIn: ['QUESTION_SEED', 'LEGACY'] } },
      orderBy: [{ importance: 'desc' }],
      take: 20,
      select: { title: true, summary: true, excerpt: true },
    })
    const parts: string[] = []
    for (const item of knowledge) {
      const line = [item.title, item.summary, item.excerpt].filter(Boolean).join(' — ')
      if (line) parts.push(line)
    }
    if (!parts.length) {
      parts.push(...chunks.map((c: any) => String(c.text || '')).filter(Boolean))
    }
    const text = parts.join('\n').slice(0, MAX_BOOK_CHARS)
    const book = await db.book.findUnique({ where: { id: unit.sourceBookId }, select: { title: true } }).catch(() => null)
    return { text, titles: book?.title ? [book.title] : [], used: text.length > 0 }
  } catch {
    return { text: '', titles: [], used: false }
  }
}

interface AnswerContent {
  combinedText: string
  answerSource: AnswerProvenance['answerSource']
  answerSourceLabel: string
  ocrNote: string | null
  truncated: boolean
}

/** قراءة إجابة الطالب: نص مكتوب أولاً، ثم نص الملف المدموج، ثم OCR بالرؤية للملف المصوّر فقط. */
export async function loadAnswerContent(submission: any): Promise<AnswerContent> {
  const written = String(submission.answerText || '').trim()
  const hasFile = Boolean(submission.fileStorageKey || submission.fileUrl || submission.data)
  if (!hasFile) {
    return {
      combinedText: written.slice(0, MAX_ANSWER_CHARS),
      answerSource: written ? 'TEXT' : 'NONE',
      answerSourceLabel: written ? 'نص مكتوب من الطالب' : 'لا يوجد نص ولا ملف',
      ocrNote: null,
      truncated: written.length > MAX_ANSWER_CHARS,
    }
  }

  let fileText = ''
  let fileMime = String(submission.mimeType || '')
  let fileBuffer: Buffer | null = null
  let stored: any = null
  try {
    stored = await getFileBufferFromStorageOrBase64({
      provider: submission.fileStorageProvider,
      key: submission.fileStorageKey,
      url: submission.fileUrl,
      data: submission.data,
      mimeType: submission.mimeType,
    })
    if (stored) {
      fileBuffer = stored.buffer
      fileMime = stored.mimeType || fileMime
    }
  } catch {
    fileText = ''
  }

  // PDF أولاً بمسار الكتب (صفحات + OCR صفحة صفحة). إذا نجح بنص كافٍ، هذا هو النص.
  // إذا فشل المسار نفسه (ملف تالف مثلاً)، نسقط للمسار القديم أدناه، لا نفشل التصحيح كله.
  if (fileBuffer && isPdfLike(fileMime, submission.fileName)) {
    try {
      const bookPath = await readPdfWithBookPath(fileBuffer)
      if (bookPath.text.trim().length >= 40) {
        const combined = [written, bookPath.text].filter(Boolean).join('\n\n[نص الملف المرفق — مقروء بمسار قراءة الكتب]\n')
        const ocrPart = bookPath.ocrPages > 0 ? ` — منها ${bookPath.ocrPages} صفحة بالرؤية (OCR)` : ''
        const truncPart = bookPath.truncated ? ` — قُرئت أول ${MAX_PDF_PAGES} صفحة من أصل ${bookPath.totalPages}` : ''
        return {
          combinedText: combined.slice(0, MAX_ANSWER_CHARS),
          answerSource: written ? 'TEXT_AND_FILE' : bookPath.ocrPages > 0 ? 'FILE_OCR' : 'FILE_TEXT',
          answerSourceLabel: written
            ? `نص مكتوب + ملف PDF مقروء بمسار الكتب${ocrPart}`
            : bookPath.ocrPages > 0
              ? `ملف PDF مقروء بمسار الكتب (صفحات + OCR)${ocrPart}`
              : 'ملف PDF مقروء بمسار الكتب (نص مدموج)',
          ocrNote: bookPath.ocrPages > 0 || bookPath.truncated
            ? `قراءة بمسار الكتب: ${bookPath.totalPages} صفحة${ocrPart}${truncPart} — راجع الملف الأصلي للتحقق من الأجزاء غير الواضحة.`
            : null,
          truncated: combined.length > MAX_ANSWER_CHARS,
        }
      }
      // مسار الكتب لم يخرج نصاً كافياً رغم OCR الصفحات: الملف غير قابل للقراءة فعلاً.
      return {
        combinedText: written.slice(0, MAX_ANSWER_CHARS),
        answerSource: written ? 'TEXT' : 'FILE_UNREADABLE',
        answerSourceLabel: written ? 'نص مكتوب فقط — ملف PDF لم يُقرأ' : 'ملف PDF لم يُقرأ (لا نص مدموج ولا قراءة رؤية ناجحة)',
        ocrNote: 'تعذرت قراءة ملف PDF بمسار الكتب رغم محاولة الرؤية؛ صحّح من الملف الأصلي يدوياً.',
        truncated: written.length > MAX_ANSWER_CHARS,
      }
    } catch {
      // سقوط آمن للمسار القديم أدناه.
    }
  }

  // غير PDF، أو PDF فشل مسار الكتب فيه: استخراج عام ثم رؤية للملف المصوّر فقط.
  try {
    if (stored && fileBuffer) {
      const extracted = await extractDocumentText(fileBuffer, stored.mimeType, submission.fileName)
      if (extracted.readable && extracted.text.trim().length >= 40) {
        fileText = extracted.text
      }
    }
  } catch {
    fileText = ''
  }

  // الملف المصوّر أو بلا نص مدموج كافٍ: قراءة رؤية (OCR) — نسخ حرفي فقط، بلا تلخيص ولا اختراع.
  if (!fileText && fileBuffer && (isPdfLike(fileMime, submission.fileName) || String(fileMime).startsWith('image/'))) {
    try {
      const raw = await textAiCompleteJson({
        system: `أنت قارئ نصوص دقيق. انسخ النص الظاهر في الملف حرفياً قدر الإمكان، صفحة صفحة وبنفس الترتيب، بالعربية أو الإنجليزية كما ظهر. لا تلخّص ولا تعيد الصياغة ولا تخترع أي كلمة. إذا كان جزء غير واضح أو غير مقروء، اكتبه حرفياً بين قوسين هكذا: [غير واضح] ولا تحاول تخمينه. إذا لم يكن هناك أي نص ظاهر، اكتب ذلك صراحة. أجب بصيغة JSON فقط: {"readable":true/false,"extractedText":"<النص المنسوخ حرفياً>","qualityNote":"<وضوح القراءة وما تعذر قراءته>"}`,
        history: [{ role: 'user', text: 'انسخ النص الظاهر في المرفق حرفياً حسب التعليمات.' }],
        purpose: 'VISION',
        temperature: 0.05,
        maxOutputTokens: 4000,
        deadlineMs: Date.now() + 60_000,
        attachments: [{ mimeType: fileMime || 'application/pdf', base64: fileBuffer.toString('base64') }],
      })
      const parsed = parseAiJson(raw)
      const ocrText = cleanParagraph(parsed?.extractedText, MAX_OCR_CHARS)
      if (parsed?.readable && ocrText.length >= 20) {
        const combined = [written, ocrText].filter(Boolean).join('\n\n[نص الملف المقروء بالرؤية (OCR)]\n')
        return {
          combinedText: combined.slice(0, MAX_ANSWER_CHARS),
          answerSource: written ? 'TEXT_AND_FILE' : 'FILE_OCR',
          answerSourceLabel: written ? 'نص مكتوب + ملف مقروء بالرؤية (OCR)' : 'ملف مقروء بالرؤية (OCR)',
          ocrNote: cleanText(parsed?.qualityNote, 300) || 'تمت قراءة الملف بالرؤية (OCR)؛ راجع الملف الأصلي للتحقق.',
          truncated: combined.length > MAX_ANSWER_CHARS,
        }
      }
      return {
        combinedText: written.slice(0, MAX_ANSWER_CHARS),
        answerSource: written ? 'TEXT' : 'FILE_UNREADABLE',
        answerSourceLabel: written ? 'نص مكتوب فقط — الملف لم يُقرأ' : 'الملف لم يُقرأ (لا نص مدموج ولا قراءة رؤية ناجحة)',
        ocrNote: cleanText(parsed?.qualityNote, 300) || 'تعذرت قراءة الملف بالرؤية؛ صحّح من الملف الأصلي يدوياً.',
        truncated: written.length > MAX_ANSWER_CHARS,
      }
    } catch (e: any) {
      return {
        combinedText: written.slice(0, MAX_ANSWER_CHARS),
        answerSource: written ? 'TEXT' : 'FILE_UNREADABLE',
        answerSourceLabel: written ? 'نص مكتوب فقط — الملف لم يُقرأ' : 'الملف لم يُقرأ',
        ocrNote: `تعذرت قراءة الملف بالرؤية الآن: ${String(e?.message || e).slice(0, 180)} — صحّح من الملف الأصلي يدوياً.`,
        truncated: written.length > MAX_ANSWER_CHARS,
      }
    }
  }

  const combined = [written, fileText].filter(Boolean).join('\n\n[نص الملف المرفق]\n')
  return {
    combinedText: combined.slice(0, MAX_ANSWER_CHARS),
    answerSource: written && fileText ? 'TEXT_AND_FILE' : fileText ? 'FILE_TEXT' : written ? 'TEXT' : 'NONE',
    answerSourceLabel: written && fileText ? 'نص مكتوب + نص ملف' : fileText ? 'نص ملف مدموج' : written ? 'نص مكتوب من الطالب' : 'لا يوجد نص ولا ملف',
    ocrNote: null,
    truncated: combined.length > MAX_ANSWER_CHARS,
  }
}

function gradingSystemPrompt(points: number, criteria: RubricCriterion[]): string {
  const criteriaLines = criteria
    .map((c) => `- ${c.label}: ${c.weightPct}% من الدرجة، أي حد أقصى ${Math.round(((points * c.weightPct) / 100) * 100) / 100} من ${points}`)
    .join('\n')
  return `أنت أستاذ جامعي متخصص في التخصص، تصحّح واجب طالب باحتراف وعدل.
قواعد صارمة:
- الدرجة الكلية من ${points} فقط، وليست من 100 إلا إذا كان الواجب نفسه من 100.
- وزّع الدرجة على المعايير التالية، ويجب أن يساوي مجموع درجات المعايير الدرجة الكلية:
${criteriaLines}
- قارن الإجابة بمحتوى الكتاب المرفق كمرجع للفهم، لا كمطابقة حرفية: الطالب الذي يشرح بفهمه ويطبّق ويضرب أمثلة من واقعه يأخذ حقه كاملاً حتى لو لم يستخدم ألفاظ الكتاب نفسها. النسخ الحرفي الطويل من الكتاب بلا فهم أو تطبيق لا يأخذ علامة التحليل والتطبيق كاملة — اذكر ذلك بصراحة لكن بلا اتهام قطعي بالغش، وقل "يبدو منقولاً حرفياً" فقط عندما يكون التطابق واضحاً.
- كل تبرير معيار يجب أن يستند إلى عبارة أو مثال موجود فعلاً في إجابة الطالب — لا تذكر دليلاً غير موجود فيها، ولا تنسب للطالب ما لم يكتبه.
- قيّم الاجتهاد الشخصي صراحة: تحليل خاص، تطبيق مهني، أمثلة، ربط بالواقع، نقد — وليس طول الإجابة وحده.
- إذا كان مصدر الإجابة قراءة رؤية (OCR) وظهرت أجزاء [غير واضح]، لا تعاقب الطالب على تلك الأجزاء ولا تخترع ما فيها؛ اذكر أن الجزء غير واضح ويحتاج مراجعة الملف الأصلي.
- لا تخترع محتوى كتاب غير مرفق، ولا تعطِ تشخيصاً أو حكماً خارج الواجب.
- الملاحظة للطالب تكون مفصلة، محترمة، بالعربية الفصحى المبسطة، بصيغة المخاطب، وتشمل: ما أتقنه، ما ينقصه، الأخطاء الجوهرية إن وجدت، وخطوة عملية واحدة للتحسين — مع تفصيل الدرجة على المعايير.
أجب بصيغة JSON فقط، بلا أي نص خارجها:
{"score":0,"criteria":[{"label":"<اسم المعيار كما ورد>","points":0,"justification":"<لماذا هذه الدرجة؟>"}],"strengths":["..."],"gaps":["..."],"errors":["..."],"effortNote":"<تقييم الاجتهاد الشخصي بصراحة>","feedback":"<الملاحظة المفصلة للطالب>"}`
}

/** تحليل بلا حفظ: يرجع مسودة + مصدر القراءة + سياق الكتاب. أي فشل في الذكاء يرجع خطأ صريحاً، لا مسودة مخترعة. */
export async function analyzeAssignmentSubmission(submissionId: string, user: { id: string; role: string; name?: string | null }) {
  const submission = await db.assignmentSubmission.findUnique({
    where: { id: submissionId },
    include: { assignment: true, user: { select: { id: true, name: true, email: true } } },
  })
  if (!submission) {
    const error = new Error('NOT_FOUND') as Error & { status?: number }
    error.status = 404
    throw error
  }
  await assertSupervisorScope(user, submission)

  const criteria = parseRubricCriteria(submission.assignment.rubric)
  const book = await loadBookContext(submission.assignment.programId, submission.assignment.unitId, submission.assignment.semester)
  const answer = await loadAnswerContent(submission)
  if (!answer.combinedText.trim()) {
    const error = new Error('NO_ANSWER_TEXT') as Error & { status?: number }
    error.status = 422
    throw error
  }

  const userPrompt = `عنوان الواجب: ${cleanAcademicOutput(submission.assignment.title, 220)}
وصف الواجب: ${cleanAcademicOutput(submission.assignment.description, 3000)}
معايير الواجب كما كتبها المعلم: ${submission.assignment.rubric ? cleanAcademicOutput(submission.assignment.rubric, 1000) : 'الافتراضي: الاستناد إلى مصادر الوحدة 30%، جودة التحليل 30%، التطبيق المهني 25%، وضوح العرض 15%'}
مصدر قراءة الإجابة: ${answer.answerSourceLabel}${answer.ocrNote ? ` — ملاحظة القراءة: ${answer.ocrNote}` : ''}
${book.used ? `مقتطفات مرجعية من كتاب الوحدة (للمرجع فقط، ليست نموذج إجابة حرفي):\n${book.text}` : 'لا يوجد سياق كتاب متاح لهذه الوحدة؛ قيّم الإجابة على أساس الفهم والتحليل والتطبيق المهني فقط، ولا تخترع مرجعاً.'}
إجابة الطالب:
${answer.combinedText}`

  let raw: string
  try {
    raw = await textAiCompleteJson({
      system: gradingSystemPrompt(submission.assignment.points, criteria),
      history: [{ role: 'user', text: userPrompt }],
      purpose: 'GRADING',
      temperature: 0.2,
      maxOutputTokens: 4000,
      deadlineMs: Date.now() + 120_000,
    })
  } catch (e: any) {
    const error = new Error(`AI_UNAVAILABLE: ${String(e?.message || e).slice(0, 200)}`) as Error & { status?: number }
    error.status = 502
    throw error
  }
  const draft = normalizeAiDraft(parseAiJson(raw), submission.assignment.points, criteria)
  if (!draft) {
    const error = new Error('AI_OUTPUT_INVALID') as Error & { status?: number }
    error.status = 502
    throw error
  }
  return {
    submissionId: submission.id,
    assignmentTitle: cleanAcademicOutput(submission.assignment.title, 220),
    studentName: submission.user?.name || 'طالب',
    points: submission.assignment.points,
    criteria,
    draft,
    provenance: {
      answerSource: answer.answerSource,
      answerSourceLabel: answer.answerSourceLabel,
      ocrNote: answer.ocrNote,
      bookContextUsed: book.used,
      bookTitles: book.titles,
      answerTruncated: answer.truncated,
    } as AnswerProvenance,
  }
}

/** الحفظ الوحيد: المشرف البشري يعتمد درجته وملاحظته بعد التعديل. */
export async function gradeAssignmentSubmission(
  submissionId: string,
  user: { id: string; role: string; name?: string | null },
  input: { score: number; feedback: string; status: 'GRADED' | 'NEEDS_REVISION' }
) {
  const submission = await db.assignmentSubmission.findUnique({
    where: { id: submissionId },
    include: { assignment: true, user: { select: { id: true, name: true, email: true } } },
  })
  if (!submission) {
    const error = new Error('NOT_FOUND') as Error & { status?: number }
    error.status = 404
    throw error
  }
  await assertSupervisorScope(user, submission)

  const points = submission.assignment.points
  const score = Number(input.score)
  if (!Number.isFinite(score) || score < 0 || score > points) {
    const error = new Error('INVALID_SCORE') as Error & { status?: number }
    error.status = 400
    throw error
  }
  const feedback = String(input.feedback || '').trim()
  if (input.status === 'NEEDS_REVISION' && feedback.length < 8) {
    const error = new Error('FEEDBACK_REQUIRED') as Error & { status?: number }
    error.status = 400
    throw error
  }

  const updated = await db.assignmentSubmission.update({
    where: { id: submissionId },
    data: {
      score,
      feedback: feedback || null,
      status: input.status,
      gradedBy: user.name || null,
      gradedAt: new Date(),
    },
    include: { user: { select: { id: true, name: true, email: true } }, assignment: true },
  })

  await notify(
    submission.userId,
    'ASSIGNMENT',
    input.status === 'NEEDS_REVISION' ? 'واجب يحتاج تعديل' : 'تم تصحيح واجبك',
    `واجب «${submission.assignment.title}»: ${score}/${points}${feedback ? ` — ${feedback.slice(0, 120)}` : ''}`,
    'dashboard'
  )
  if (updated.user?.email) {
    await emailAssignmentGraded(updated.user.email, updated.user.name || 'الطالب', submission.assignment.title, input.status, score, points, feedback || null)
  }
  await audit(user as any, 'GRADE_ASSIGNMENT_SUPERVISOR', 'AssignmentSubmission', submissionId, `تصحيح مشرف لواجب ${submission.assignment.title} للطالب ${submission.user?.name || ''} — ${score}/${points}`)
  return updated
}
