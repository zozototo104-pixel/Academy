// Book-wide selective repair job (scan): re-reads ONLY distorted pages from
// the original PDF via OCR, corrects distorted knowledge items IN PLACE
// (same ID, never delete-and-recreate), sends unprovable items to REVIEW,
// fixes only the quoted parts of linked guides/questions, and never halts
// the whole book on one stuck chunk. Runs as a resumable background job:
// each call processes a bounded batch and persists progress + counters on
// the BookRepairJob row, so STOP/RESUME continues where it left off.
import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { transcribeScannedDocumentWithVision } from '@/lib/book-reader'
import { looksLikeBrokenBookPageText } from '@/lib/academic-output-quality'
import {
  scanBookDistortion,
  correctKnowledgeItemFromSource,
  buildKeyTermForItem,
  buildSectionSummaryForItem,
  replaceQuotedExcerpt,
} from '@/lib/book-repair-scan'
import { mergeBookPageReadIssues } from '@/lib/book-read-job-control'

export const BOOK_REPAIR_ACTIVE_STATUSES = ['QUEUED', 'RUNNING', 'PAUSED'] as const
export const BOOK_REPAIR_MAX_CHUNKS_PER_STEP = 4
export const BOOK_REPAIR_MAX_ITEMS_PER_STEP = 20

export type BookRepairProgress = {
  distortedChunkIds: string[]
  distortedItemIds: string[]
  repairedChunkIds: string[]
  reviewChunkIds: string[]
  correctedItemIds: string[]
  reviewItemIds: string[]
}

export function parseBookRepairProgress(value: string | null | undefined): BookRepairProgress {
  const empty: BookRepairProgress = {
    distortedChunkIds: [], distortedItemIds: [], repairedChunkIds: [],
    reviewChunkIds: [], correctedItemIds: [], reviewItemIds: [],
  }
  if (!value) return empty
  try {
    const parsed = JSON.parse(value)
    const list = (key: keyof BookRepairProgress): string[] =>
      Array.isArray(parsed?.[key]) ? [...new Set(parsed[key].filter((id: unknown) => typeof id === 'string'))] : []
    return {
      distortedChunkIds: list('distortedChunkIds'),
      distortedItemIds: list('distortedItemIds'),
      repairedChunkIds: list('repairedChunkIds'),
      reviewChunkIds: list('reviewChunkIds'),
      correctedItemIds: list('correctedItemIds'),
      reviewItemIds: list('reviewItemIds'),
    }
  } catch { return empty }
}

export async function hasActiveBookRepairJob(bookId: string): Promise<boolean> {
  const job = await db.bookRepairJob.findFirst({
    where: { bookId, status: { in: [...BOOK_REPAIR_ACTIVE_STATUSES] } },
    select: { id: true },
  })
  return !!job
}

export type BookRepairCounters = {
  chunksTotal: number
  chunksHealthy: number
  chunksCorrected: number
  chunksRemaining: number
  chunksNeedsReview: number
  itemsTotal: number
  itemsHealthy: number
  itemsCorrected: number
  itemsRemaining: number
  itemsNeedsReview: number
}

// Counters derive from the accumulated progress sets so they always sum to
// the totals, across steps and resumes: corrected = fixed in place;
// needs-review = recorded for review; remaining = baseline minus resolved;
// healthy = the residual (never distorted and never touched).
export function computeBookRepairCounters(
  totalChunks: number,
  totalItems: number,
  progress: BookRepairProgress,
): BookRepairCounters {
  const chunksCorrected = progress.repairedChunkIds.length
  const chunksNeedsReview = progress.reviewChunkIds.length
  const chunksRemaining = progress.distortedChunkIds.filter(
    (id) => !progress.repairedChunkIds.includes(id) && !progress.reviewChunkIds.includes(id),
  ).length
  const itemsCorrected = progress.correctedItemIds.length
  const itemsNeedsReview = progress.reviewItemIds.length
  const itemsRemaining = progress.distortedItemIds.filter(
    (id) => !progress.correctedItemIds.includes(id) && !progress.reviewItemIds.includes(id),
  ).length
  return {
    chunksTotal: totalChunks,
    chunksHealthy: Math.max(0, totalChunks - chunksCorrected - chunksNeedsReview - chunksRemaining),
    chunksCorrected,
    chunksRemaining,
    chunksNeedsReview,
    itemsTotal: totalItems,
    itemsHealthy: Math.max(0, totalItems - itemsCorrected - itemsNeedsReview - itemsRemaining),
    itemsCorrected,
    itemsRemaining,
    itemsNeedsReview,
  }
}


type RepairItemRow = {
  id: string
  chunkId: string | null
  title: string
  summary: string
  excerpt: string | null
  pageStart: number | null
  pageEnd: number | null
}

function parseJsonArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  }
  return []
}

// Fix ONLY the parts of linked guides/questions that quote this item's
// damaged text (criterion 1: IDs and links preserved; criterion 2: the new
// text is proven from the source before it is saved). A guide entry is
// rebuilt only when it matches the old derived text exactly — a hand-edited
// entry is left alone. A question is touched only where the old excerpt is
// literally quoted. Nothing else in any row changes.
async function fixDerivedTextsForItem(
  tx: any,
  programId: string,
  oldItem: RepairItemRow,
  newFields: { title: string; summary: string; excerpt: string },
): Promise<void> {
  const newItem = { ...oldItem, ...newFields }
  const oldKeyTerm = buildKeyTermForItem(oldItem)
  const newKeyTerm = buildKeyTermForItem(newItem)
  const oldSectionSummary = buildSectionSummaryForItem(oldItem)
  const newSectionSummary = buildSectionSummaryForItem(newItem)
  const guides = await tx.programStudyGuide.findMany({
    where: { programId },
    select: { id: true, keyTerms: true, sections: true, sourceKnowledgeIds: true },
  })
  for (const guide of guides) {
    const ids = parseJsonArray(guide.sourceKnowledgeIds)
    if (!ids.includes(oldItem.id)) continue
    let changed = false
    const keyTerms = parseJsonArray(guide.keyTerms)
    const nextKeyTerms = keyTerms.map((entry: unknown) =>
      entry === oldKeyTerm ? (changed = true, newKeyTerm) : entry)
    const sections = parseJsonArray(guide.sections)
    const nextSections = sections.map((section: any) => {
      if (section?.summary !== oldSectionSummary) return section
      if (!parseJsonArray(section?.sourceKnowledgeIds).includes(oldItem.id)) return section
      changed = true
      return { ...section, summary: newSectionSummary }
    })
    if (changed) {
      await tx.programStudyGuide.update({
        where: { id: guide.id },
        data: { keyTerms: JSON.stringify(nextKeyTerms), sections: JSON.stringify(nextSections) },
      })
    }
  }
  const questionTables = ['questionBankItem', 'question', 'programQuestion'] as const
  for (const table of questionTables) {
    const rows = await tx[table].findMany({
      where: { knowledgeItemId: oldItem.id },
      select: { id: true, text: true, sourceEvidence: true },
    })
    for (const row of rows) {
      const data: Record<string, string> = {}
      if (typeof row.text === 'string') {
        const replaced = replaceQuotedExcerpt(row.text, oldItem.excerpt || '', newFields.excerpt)
        if (replaced.replaced) data.text = replaced.text
      }
      if (typeof row.sourceEvidence === 'string') {
        const replaced = replaceQuotedExcerpt(row.sourceEvidence, oldItem.excerpt || '', newFields.excerpt)
        if (replaced.replaced) data.sourceEvidence = replaced.text
      }
      if (Object.keys(data).length) await tx[table].update({ where: { id: row.id }, data })
    }
  }
}

// Correct one item from its chunk's (corrected) text, in place (same ID) or
// to REVIEW. Returns 'corrected' (fields changed and saved), 'unchanged'
// (proven fine as-is), or 'review' (unprovable — left untouched).
async function correctOneItem(
  tx: any,
  programId: string,
  item: RepairItemRow,
  sourceText: string,
): Promise<'corrected' | 'unchanged' | 'review'> {
  const result = correctKnowledgeItemFromSource(
    { id: item.id, title: item.title, summary: item.summary, excerpt: item.excerpt || '', pageStart: item.pageStart, pageEnd: item.pageEnd },
    sourceText,
  )
  if (result.status === 'REVIEW') return 'review'
  const changed =
    result.data.title !== item.title ||
    result.data.summary !== item.summary ||
    result.data.excerpt !== (item.excerpt || '')
  if (!changed) return 'unchanged'
  const oldItem = { ...item }
  await tx.bookKnowledgeItem.update({ where: { id: item.id }, data: { title: result.data.title, summary: result.data.summary, excerpt: result.data.excerpt } })
  await fixDerivedTextsForItem(tx, programId, oldItem, result.data)
  return 'corrected'
}


export type BookRepairScanStepResult = {
  jobId: string
  status: string
  counters: BookRepairCounters
  done: boolean
  paused: boolean
  processedChunks: number
  processedItems: number
}

// One bounded scan step: re-read up to 4 distorted chunks from the original
// PDF via OCR and correct up to 20 distorted items on healthy chunks from
// their current text. Progress + counters persist after every chunk, so a
// stop or a crash resumes where it left off. A single stuck chunk is
// recorded for review (ledger + progress) and never halts the book.

// The per-chunk repair transaction returns one of two shapes. Declared
// explicitly (not inferred): generic inference from multiple returns does
// not produce a union that `in` narrows, so `outcome.corrected` read as
// possibly-undefined under tsc until this annotation (CI, fb4405ba).
type RepairScanTxOutcome =
  | { skipped: 'changed' }
  | { repaired: true; corrected: string[]; review: string[] }

export async function runBookRepairScanStep(
  jobId: string,
  buffer: Buffer,
  deadlineMs: number,
  ocr: (buffer: Buffer, pages: number[], deadlineMs: number) => Promise<{ page: number; text: string }[]> = transcribeScannedDocumentWithVision,
): Promise<BookRepairScanStepResult> {
  const job = await db.bookRepairJob.findUnique({ where: { id: jobId } })
  if (!job) throw new Error('BOOK_REPAIR_JOB_NOT_FOUND')
  const progress = parseBookRepairProgress(job.progress)
  const countersNow = (totalChunks: number, totalItems: number) => computeBookRepairCounters(totalChunks, totalItems, progress)
  if (job.status === 'PAUSED') {
    return { jobId, status: job.status, counters: countersNow(job.chunksTotal, job.itemsTotal), done: false, paused: true, processedChunks: 0, processedItems: 0 }
  }
  if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'STOPPED') {
    return { jobId, status: job.status, counters: countersNow(job.chunksTotal, job.itemsTotal), done: job.status === 'COMPLETED', paused: false, processedChunks: 0, processedItems: 0 }
  }
  // Mutual exclusion, defence in depth: the route already refused when a
  // read job was active; re-check here in case one started since.
  const latestRead = await db.bookReadJob.findFirst({ where: { bookId: job.bookId }, orderBy: { createdAt: 'desc' } })
  const readActive = latestRead && ['QUEUED', 'RUNNING', 'PAUSED'].includes(latestRead.status)
  const readStopped = readActive && latestRead.status === 'PAUSED' &&
    latestRead.retryAt?.getUTCFullYear() === 9999 &&
    (!latestRead.lockedUntil || latestRead.lockedUntil <= new Date())
  if (readActive && !readStopped) throw new Error('BOOK_REPAIR_JOB_ACTIVE')

  await db.bookRepairJob.update({
    where: { id: jobId },
    data: { status: 'RUNNING', startedAt: job.startedAt ?? new Date() },
  })

  const chunks = await db.bookChunk.findMany({
    where: { bookId: job.bookId },
    orderBy: { index: 'asc' },
    select: { id: true, index: true, pageStart: true, pageEnd: true, text: true, contentHash: true, status: true },
  })
  const items: RepairItemRow[] = await db.bookKnowledgeItem.findMany({
    where: { bookId: job.bookId, kbVersion: 2 },
    select: { id: true, chunkId: true, title: true, summary: true, excerpt: true, pageStart: true, pageEnd: true },
  })

  const scan = scanBookDistortion(chunks, items)
  for (const id of scan.distortedChunkIds) if (!progress.distortedChunkIds.includes(id)) progress.distortedChunkIds.push(id)
  for (const id of scan.distortedItemIds) if (!progress.distortedItemIds.includes(id)) progress.distortedItemIds.push(id)

  const saveProgress = async (done: boolean) => {
    const counters = countersNow(chunks.length, items.length)
    await db.bookRepairJob.update({
      where: { id: jobId },
      data: { ...counters, progress: JSON.stringify(progress), status: done ? 'COMPLETED' : 'RUNNING', ...(done ? { finishedAt: new Date() } : {}) },
    })
    return counters
  }

  const distortedChunks = chunks.filter((chunk) =>
    scan.distortedChunkIds.includes(chunk.id) &&
    !progress.repairedChunkIds.includes(chunk.id) &&
    !progress.reviewChunkIds.includes(chunk.id))
  const batch = distortedChunks.slice(0, BOOK_REPAIR_MAX_CHUNKS_PER_STEP)
  let processedChunks = 0
  let processedItems = 0

  for (const chunk of batch) {
    const pages = Array.from({ length: chunk.pageEnd - chunk.pageStart + 1 }, (_, i) => chunk.pageStart + i)
    let ocrText = ''
    let ocrReason: string | null = null
    const ocrPages: { page: number; text: string }[] = []
    try {
      for (let offset = 0; offset < pages.length; offset += 8) {
        const part = await ocr(buffer, pages.slice(offset, offset + 8), deadlineMs)
        ocrPages.push(...part)
      }
      ocrText = pages
        .map((page) => ocrPages.find((item) => item.page === page)?.text?.trim() || '')
        .filter(Boolean)
        .join('\n')
        .trim()
    } catch (error) {
      ocrReason = 'OCR_FAILED: ' + String(error instanceof Error ? error.message : error).slice(0, 120)
    }
    if (!ocrReason && (!ocrText || looksLikeBrokenBookPageText(ocrText))) {
      ocrReason = ocrText ? 'OCR_TEXT_FAILED_VERIFICATION' : 'OCR_RETURNED_NO_TEXT'
    }
    // Step 9 (d) — OCR-incomplete flag: the JOINED text can pass
    // verification while individual pages came back empty or broken
    // (e.g. one page of a chunk unreadable). Without a flag the chunk
    // is "repaired" from the surviving pages and the lost page is
    // silently dropped. Record the scan-level reason so the per-page
    // UNREADABLE issues below carry it — only for the bad pages.
    let incompletePages: number[] = []
    if (!ocrReason) {
      incompletePages = pages.filter((page) => {
        const text = (ocrPages.find((item) => item.page === page)?.text || '').trim()
        return !text || looksLikeBrokenBookPageText(text)
      })
      if (incompletePages.length > 0) ocrReason = 'OCR_INCOMPLETE_OR_INVALID_PAGES'
    }
    if (ocrReason) {
      // A stuck chunk never halts the book: record it for review (progress
      // + the UNREADABLE ledger on the latest read job) and continue.
      if (!progress.reviewChunkIds.includes(chunk.id)) progress.reviewChunkIds.push(chunk.id)
      for (const item of items.filter((row) => row.chunkId === chunk.id && scan.distortedItemIds.includes(row.id))) {
        if (!progress.reviewItemIds.includes(item.id)) progress.reviewItemIds.push(item.id)
      }
      try {
        const latest = await db.bookReadJob.findFirst({ where: { bookId: job.bookId }, orderBy: { createdAt: 'desc' } })
        if (latest) {
          const row = await db.bookReadJob.findUnique({ where: { id: latest.id }, select: { lastError: true } })
          if (row) {
            // An incomplete scan flags only its bad pages; a whole-chunk
            // OCR failure (OCR_FAILED / verification / no text) flags
            // every page, as before.
            const issuePages = incompletePages.length > 0 ? incompletePages : pages
            await db.bookReadJob.update({
              where: { id: latest.id },
              data: { lastError: mergeBookPageReadIssues(row.lastError, [], issuePages.map((page) => ({ page, kind: 'UNREADABLE' as const, reason: (ocrReason as string).slice(0, 160) }))) },
            })
          }
        }
      } catch (error) { console.warn('Book repair ledger write failed (progress still recorded):', error) }
      await saveProgress(false)
      continue
    }
    // Commit per chunk: CAS on contentHash, correct its items in place
    // (same IDs, never delete-and-recreate), clear its ledger entries. A
    // chunk that never had items returns to EXTRACTED so the normal
    // analysis run picks it up afterwards; a chunk with items stays
    // ANALYZED — its items are corrected in place, not re-analyzed.
    const chunkItems = items.filter((item) => item.chunkId === chunk.id)
    const hadItems = chunkItems.length > 0
    const outcome: RepairScanTxOutcome = await db.$transaction(async (tx) => {
      const current = await tx.bookChunk.findUnique({ where: { id: chunk.id }, select: { contentHash: true } })
      if (!current || current.contentHash !== chunk.contentHash) return { skipped: 'changed' as const }
      const changed = await tx.bookChunk.updateMany({
        where: { id: chunk.id, contentHash: chunk.contentHash },
        data: {
          text: ocrText, charCount: ocrText.length,
          contentHash: createHash('sha256').update(ocrText).digest('hex'),
          textProvenance: 'VISION_OCR',
          ...(hadItems ? {} : { status: 'EXTRACTED', attempts: 0, analysisPasses: 0, saturatedAt: null }),
          lastError: null,
        },
      })
      if (!changed.count) return { skipped: 'changed' as const }
      const corrected: string[] = []
      const review: string[] = []
      for (const item of chunkItems) {
        const result = await correctOneItem(tx, job.programId, item, ocrText)
        if (result === 'corrected') corrected.push(item.id)
        else if (result === 'review') review.push(item.id)
      }
      const latest = await tx.bookReadJob.findFirst({ where: { bookId: job.bookId }, orderBy: { createdAt: 'desc' } })
      if (latest) {
        const row = await tx.bookReadJob.findUnique({ where: { id: latest.id }, select: { lastError: true } })
        if (row) await tx.bookReadJob.update({ where: { id: latest.id }, data: { lastError: mergeBookPageReadIssues(row.lastError, pages, []) } })
      }
      return { repaired: true as const, corrected, review }
    })
    if (!('repaired' in outcome)) continue
    if (!progress.repairedChunkIds.includes(chunk.id)) progress.repairedChunkIds.push(chunk.id)
    for (const id of outcome.corrected) if (!progress.correctedItemIds.includes(id)) progress.correctedItemIds.push(id)
    for (const id of outcome.review) if (!progress.reviewItemIds.includes(id)) progress.reviewItemIds.push(id)
    processedChunks++
    processedItems += outcome.corrected.length + outcome.review.length
    await saveProgress(false)
  }

  // Distorted items on healthy chunks need no OCR: correct them from the
  // chunk's current text. Bounded per step; already-resolved items skip.
  const healthyChunkIds = new Set(chunks.filter((chunk) => !scan.distortedChunkIds.includes(chunk.id)).map((chunk) => chunk.id))
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk] as const))
  const pendingItems = items.filter((item) =>
    item.chunkId && healthyChunkIds.has(item.chunkId) &&
    scan.distortedItemIds.includes(item.id) &&
    !progress.correctedItemIds.includes(item.id) &&
    !progress.reviewItemIds.includes(item.id),
  ).slice(0, BOOK_REPAIR_MAX_ITEMS_PER_STEP)
  for (const item of pendingItems) {
    const chunk = chunkById.get(item.chunkId as string)
    if (!chunk) continue
    const outcome = await db.$transaction(async (tx) => {
      const current = await tx.bookKnowledgeItem.findUnique({ where: { id: item.id }, select: { title: true, summary: true, excerpt: true } })
      if (!current) return { skipped: 'gone' as const }
      const result = await correctOneItem(tx, job.programId, { ...item, ...current }, chunk.text)
      return { result }
    })
    if ('skipped' in outcome) continue
    // 'unchanged' means the item is proven fine as-is: resolved, not review.
    if (outcome.result === 'corrected' || outcome.result === 'unchanged') {
      if (!progress.correctedItemIds.includes(item.id)) progress.correctedItemIds.push(item.id)
    } else if (!progress.reviewItemIds.includes(item.id)) {
      progress.reviewItemIds.push(item.id)
    }
    processedItems++
    await saveProgress(false)
  }

  const counters = countersNow(chunks.length, items.length)
  const done = counters.chunksRemaining === 0 && counters.itemsRemaining === 0
  const finalCounters = await saveProgress(done)
  return { jobId, status: done ? 'COMPLETED' : 'RUNNING', counters: finalCounters, done, paused: false, processedChunks, processedItems }
}
