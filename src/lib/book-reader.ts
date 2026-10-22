import { createHash } from 'node:crypto'
import { PDFDocument } from 'pdf-lib'
import { db } from '@/lib/db'
import { getFileBufferFromStorageOrBase64 } from '@/lib/storage'
import { fixArabicPdfText } from '@/lib/arabic-pdf-text'
import { textAiCompleteJsonWithMetadata, type TextAiPreferredModel, type TextAiProvider, type TextAiRouterPolicy } from '@/lib/text-ai'
import { buildStageRoutingOverrides, resolveEffectiveStageProfile, type StageRoutingOverrides } from '@/lib/ai-stage-profiles'
import { withPipelineRun } from '@/lib/ai-pipeline-log'

export type ExtractedBookPage = { page: number; text: string; textProvenance: 'NATIVE_TEXT' | 'VISION_OCR' }
export type PlannedBookChunk = { index: number; pageStart: number; pageEnd: number; headingPath: string | null; text: string; charCount: number; textProvenance: 'NATIVE_TEXT' | 'VISION_OCR'; contentHash: string }

export function pagesNeedingOcr(pages: readonly { page: number; text: string }[]): number[][] {
  const missing = pages.filter((page) => page.text.trim().length < 80).map((page) => page.page)
  const batches: number[][] = []
  for (let i = 0; i < missing.length; i += 4) batches.push(missing.slice(i, i + 4))
  return batches
}
export function nextExtractionPage(pagesDone: number, totalPages: number): number | null {
  return pagesDone < totalPages ? pagesDone + 1 : null
}
function heading(text: string): string | null {
  return text.split('\n').map((line) => line.trim()).find((line) => /^(?:الفصل|الباب|المبحث|المطلب|Chapter|Part)\s+\S+/i.test(line))?.slice(0, 240) || null
}
export function planBookChunks(pages: readonly ExtractedBookPage[], minChars = 2500, maxChars = 4000): PlannedBookChunk[] {
  const chunks: PlannedBookChunk[] = []
  let text = '', start = 0, end = 0
  let provenance: ExtractedBookPage['textProvenance'] = 'NATIVE_TEXT'
  let headingPath: string | null = null
  const flush = () => {
    if (!text.trim()) return
    const value = text.trim()
    chunks.push({ index: chunks.length, pageStart: start, pageEnd: end, headingPath, text: value, charCount: value.length, textProvenance: provenance, contentHash: createHash('sha256').update(value).digest('hex') })
    text = ''
  }
  for (const page of pages) {
    const sentences = page.text.match(/[^.!؟。\n]+(?:[.!؟。]+|$)/gu) || []
    for (const sentence of sentences) {
      const part = sentence.trim()
      if (!part) continue
      if (text && (text.length + part.length + 1 > maxChars || provenance !== page.textProvenance)) flush()
      if (!text) { start = page.page; provenance = page.textProvenance; headingPath = heading(page.text) }
      end = page.page
      text += (text ? ' ' : '') + part
      // Preserve unusually long sentences intact instead of cutting evidence.
      if (text.length >= maxChars) flush()
    }
  }
  flush()
  return chunks
}

/** PDFParse v2 supports `partial` (1-based page numbers); never flatten pages into one document. */
export async function extractNumberedPdfPages(buffer: Buffer, pageNumbers: readonly number[]): Promise<ExtractedBookPage[]> {
  const worker = await import('pdf-parse/worker')
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(buffer), CanvasFactory: (worker as any).CanvasFactory } as any)
  try {
    const pages: ExtractedBookPage[] = []
    for (const page of pageNumbers) {
      const result = await parser.getText({ partial: [page] })
      const raw = (result as any).pages?.find((entry: any) => entry.num === page)?.text ?? (result as any).pages?.[0]?.text ?? result.text ?? ''
      pages.push({ page, text: String(raw).trim(), textProvenance: 'NATIVE_TEXT' })
    }
    return pages
  } finally {
    await parser.destroy().catch(() => {})
  }
}

async function transcribeWithMeta(buffer: Buffer, pageNumbers: readonly number[], deadlineMs: number, overrides: { preferredModels: { provider: string; model: string }[]; preferredProviders: string[]; policy: string | null } | null): Promise<{ pages: ExtractedBookPage[]; provider: string; model: string }> {
  if (!pageNumbers.length || pageNumbers.length > 8) throw new Error('OCR_PAGE_RANGE_INVALID')
  if (deadlineMs - Date.now() < 25_000) throw new Error('BOOK_READ_TIME_BUDGET_EXHAUSTED')
  const original = await PDFDocument.load(buffer)
  const subset = await PDFDocument.create()
  const copied = await subset.copyPages(original, pageNumbers.map((page) => page - 1))
  for (const page of copied) subset.addPage(page)
  const data = Buffer.from(await subset.save())
  const meta = await textAiCompleteJsonWithMetadata({
    system: 'أنت محرك OCR حرفي. انسخ النص المرئي كما هو، دون شرح أو وصف أو استنتاج. لا تستخدم VISION_DESCRIPTION.',
    history: [{ role: 'user', text: `الملف يحتوي ${pageNumbers.length} صفحات بالترتيب. أرجع JSON فقط بالشكل {"pages":[{"page":1,"text":"النص الحرفي"}]}، حيث page هو رقم الصفحة داخل الملف الفرعي من 1 إلى ${pageNumbers.length}. لا تخترع نصاً ولا تلخص.` }],
    purpose: 'VISION',
    routerPolicy: (overrides?.policy ?? 'primary_first') as TextAiRouterPolicy,
    ...(overrides?.preferredModels.length ? { preferredModels: overrides.preferredModels.map((m) => ({ provider: m.provider as TextAiPreferredModel['provider'], model: m.model })) } : {}),
    ...(overrides?.preferredProviders.length ? { preferredProviders: overrides.preferredProviders as TextAiProvider[] } : {}),
    maxOutputTokens: 16000,
    deadlineMs: Math.min(deadlineMs - 10_000, Date.now() + 90_000),
    attachments: [{ mimeType: 'application/pdf', base64: data.toString('base64') }],
  })
  const parsed = JSON.parse(meta.text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim())
  if (!Array.isArray(parsed?.pages)) throw new Error('OCR_INVALID_PAGE_RESPONSE')
  const pages = pageNumbers.map((page, i) => {
    const match = parsed.pages.find((entry: any) => Number(entry.page) === i + 1)
    if (!match || typeof match.text !== 'string') throw new Error(`OCR_MISSING_PAGE_${page}`)
    return { page, text: match.text.trim(), textProvenance: 'VISION_OCR' as const }
  })
  return { pages, provider: meta.provider, model: meta.model }
}

export async function transcribeScannedDocumentWithVision(buffer: Buffer, pageNumbers: readonly number[], deadlineMs = Date.now() + 120_000): Promise<ExtractedBookPage[]> {
  return (await transcribeWithMeta(buffer, pageNumbers, deadlineMs, null)).pages
}

export type ExtractStepStore = {
  upsertChunk: (chunk: PlannedBookChunk, bookId: string, programId: string) => Promise<void>
  saveProgress: (jobId: string, pagesDone: number, totalPages: number, totalChunks: number, phase: 'EXTRACT' | 'ANALYZE') => Promise<void>
}

/** One durable batch is at most eight pages. Progress advances only after every chunk is saved. */
async function extractPdfBatchInner(input: { buffer: Buffer; bookId: string; programId: string; jobId: string; pagesDone: number; totalPages: number; existingChunks: number; store: ExtractStepStore; deadlineMs: number; extractPages?: typeof extractNumberedPdfPages; ocrPages?: typeof transcribeScannedDocumentWithVision; routing?: { preferredModels: { provider: string; model: string }[]; preferredProviders: string[]; policy: string | null } | null; aiUsage?: { provider: string | null; model: string | null } }): Promise<{ pagesDone: number; totalPages: number; totalChunks: number; phase: 'EXTRACT' | 'ANALYZE' }> {
  const { buffer, bookId, programId, jobId, store } = input
  if (Date.now() >= input.deadlineMs) throw new Error('BOOK_EXTRACT_DEADLINE')
  const lastPage = Math.min(input.totalPages, input.pagesDone + 8)
  const numbers = Array.from({ length: lastPage - input.pagesDone }, (_, index) => input.pagesDone + index + 1)
  const extracted = await (input.extractPages || extractNumberedPdfPages)(buffer, numbers)
  const pageMap = new Map(extracted.map((page) => [page.page, page]))
  for (const range of pagesNeedingOcr(extracted)) {
    if (input.deadlineMs - Date.now() < 25_000) return { pagesDone: input.pagesDone, totalPages: input.totalPages, totalChunks: input.existingChunks, phase: 'EXTRACT' }
    const ocr = input.ocrPages
      ? await input.ocrPages(buffer, range, input.deadlineMs)
      : await (async () => {
          const meta = await transcribeWithMeta(buffer, range, input.deadlineMs, input.routing ?? null)
          if (input.aiUsage) { input.aiUsage.provider = meta.provider; input.aiUsage.model = meta.model }
          return meta.pages
        })()
    for (const page of ocr) pageMap.set(page.page, page)
  }
  const ordered = numbers.map((page) => {
    const result = pageMap.get(page)
    if (!result) throw new Error(`BOOK_PAGE_MISSING_${page}`)
    return result.textProvenance === 'NATIVE_TEXT' ? { ...result, text: fixArabicPdfText(result.text) } : result
  })
  const chunks = planBookChunks(ordered)
  for (let index = 0; index < chunks.length; index++) {
    await store.upsertChunk({ ...chunks[index], index: input.existingChunks + index }, bookId, programId)
  }
  const phase = lastPage >= input.totalPages ? 'ANALYZE' : 'EXTRACT'
  const totalChunks = input.existingChunks + chunks.length
  await store.saveProgress(jobId, lastPage, input.totalPages, totalChunks, phase)
  return { pagesDone: lastPage, totalPages: input.totalPages, totalChunks, phase }
}

// D0+D2.1: كل دفعة استخراج تُسجَّل كتشغيلة قراءة. بروفايل القراءة
// الفعّال يُحسم أولًا: بروفايل مرحلة صالح يقود نداءات OCR ويُختم به
// الصف؛ غيابه/تعطيله/فراغه/عدم صلاحيته يعيد التشغيلة للعام كما كانت
// قبل D2.1 بالضبط، مع تسجيل سبب الرجوع وfallbackUsed.
export async function extractPdfBatch(input: Parameters<typeof extractPdfBatchInner>[0]): ReturnType<typeof extractPdfBatchInner> {
  let overrides: StageRoutingOverrides | { kind: 'resolution-error' }
  try {
    overrides = buildStageRoutingOverrides(await resolveEffectiveStageProfile('READING'))
  } catch {
    overrides = { kind: 'resolution-error' }
  }
  const aiUsage = { provider: null as string | null, model: null as string | null }
  const isStage = overrides.kind === 'stage'
  let routing: { preferredModels: { provider: string; model: string }[]; preferredProviders: string[]; policy: string | null } | null = null
  let profileStamp: { profileId: string; profileVersion: string; policy: string | null; allowedModels: string[] } | undefined
  if (overrides.kind === 'stage') {
    routing = { preferredModels: overrides.preferredModels, preferredProviders: overrides.preferredProviders, policy: overrides.policy }
    profileStamp = {
      profileId: overrides.profileId,
      profileVersion: String(overrides.version),
      policy: overrides.policy,
      allowedModels: overrides.preferredModels.map((m) => `${m.provider}:${m.model}`),
    }
  }
  const detail: Record<string, unknown> = { profileKind: overrides.kind }
  if (overrides.kind === 'global') detail.fallbackReason = overrides.reason
  if (overrides.kind === 'invalid') { detail.profileInvalid = true; detail.invalidReason = overrides.reason }
  return withPipelineRun(
    { stage: 'READING', bookId: input.bookId, batchId: input.jobId, inputData: input.buffer, profileStamp, fallbackUsed: !isStage, detail },
    () => extractPdfBatchInner({ ...input, routing, aiUsage }),
    (r) => ({ provider: aiUsage.provider, model: aiUsage.model, outputCount: r.totalChunks, detail: { pagesDone: r.pagesDone, totalPages: r.totalPages, phase: r.phase } }),
  )
}

export async function runExtractStep(jobId: string, deadlineMs: number) {
  const job = await db.bookReadJob.findUnique({ where: { id: jobId } })
  if (!job) throw new Error('BOOK_READ_JOB_NOT_FOUND')
  if (job.phase !== 'EXTRACT') return { pagesDone: job.pagesDone, totalPages: job.totalPages, totalChunks: job.totalChunks, phase: job.phase }
  const book = await db.book.findUnique({ where: { id: job.bookId } })
  if (!book) throw new Error('BOOK_NOT_FOUND')
  const stored = await getFileBufferFromStorageOrBase64({ provider: book.storageProvider, key: book.storageKey, url: book.fileUrl, data: book.data, mimeType: book.mimeType })
  if (!stored?.buffer?.length || !/^%PDF-/.test(stored.buffer.subarray(0, 5).toString())) throw new Error('BOOK_PDF_REQUIRED')
  const pdf = await PDFDocument.load(stored.buffer)
  const totalPages = pdf.getPageCount()
  if (job.pagesDone > totalPages) throw new Error('BOOK_PROGRESS_EXCEEDS_PDF')
  const store: ExtractStepStore = {
    upsertChunk: async (chunk, bookId, programId) => {
      const existing = await db.bookChunk.findUnique({ where: { bookId_index: { bookId, index: chunk.index } }, select: { status: true, contentHash: true } })
      if (existing?.status === 'ANALYZED' && existing.contentHash === chunk.contentHash) return
      await db.bookChunk.upsert({
        where: { bookId_index: { bookId, index: chunk.index } },
        create: { ...chunk, bookId, programId, status: 'EXTRACTED' },
        update: { ...chunk, status: 'EXTRACTED', attempts: 0, lastError: null },
      })
    },
    saveProgress: async (id, pagesDone, totalPages, totalChunks, phase) => {
      await db.bookReadJob.update({ where: { id }, data: { pagesDone, totalPages, totalChunks, phase } })
    },
  }
  return extractPdfBatch({ buffer: stored.buffer, bookId: job.bookId, programId: job.programId, jobId, pagesDone: job.pagesDone, totalPages, existingChunks: job.totalChunks, store, deadlineMs })
}
