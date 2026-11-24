import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { PDFDocument } from 'pdf-lib'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getFileBufferFromStorageOrBase64 } from '@/lib/storage'
import { audit } from '@/lib/notify'
import { transcribeScannedDocumentWithVision } from '@/lib/book-reader'
import { looksLikeBrokenBookPageText } from '@/lib/academic-output-quality'
import { mergeBookPageReadIssues } from '@/lib/book-read-job-control'
import { correctKnowledgeItemFromSource } from '@/lib/book-repair-scan'
import { hasActiveBookRepairJob, runBookRepairScanStep } from '@/lib/book-repair-job'
import { resumePendingUnitRegenerations } from '@/lib/unit-regeneration-link'

export const runtime = 'nodejs'
export const maxDuration = 300
type Context = { params: Promise<{ id: string }> }

// Latest scan-repair job + counters for the book (the «فحص وإصلاح تشوهات
// الكتاب» button polls this after each step).
export async function GET(_request: NextRequest, context: Context) {
  try {
    await requireAdmin()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { id: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const job = await db.bookRepairJob.findFirst({ where: { bookId: id }, orderBy: { createdAt: 'desc' } })
    return NextResponse.json({ ok: true, job })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('repair job GET error:', error)
    return NextResponse.json({ error: 'تعذر تحميل حالة إصلاح الكتاب' }, { status: 500 })
  }
}

// Repair at most this many corrupt chunks per call: each needs a vision OCR
// round-trip, and one serverless request must not swallow the whole book.
const MAX_CHUNKS_PER_CALL = 4

// Book knowledge IDs also occur in legacy JSON/text evidence lists. Mirrors
// the REBUILD check in read-job/route.ts, scoped here to one chunk's items.
function usesAnyKnowledgeId(value: unknown, ids: string[]): boolean {
  if (value == null || !ids.length) return false
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return ids.some((id) => serialized.includes(id))
}

type LinkCounts = { questions: number; assignments: number; guides: number }

// The single-chunk repair transaction returns one of three shapes. Declared
// explicitly (not inferred): generic inference from multiple returns does
// not produce a union that `in` narrows, so `outcome.corrected` read as
// possibly-undefined under tsc until this annotation (CI, fb4405ba).
type RepairTxOutcome =
  | { skipped: 'changed' }
  | { skipped: 'linked'; linkedItems: number; linked: LinkCounts }
  | { repaired: true; hadItems: boolean; corrected: { itemId: string }[]; needsReview: { itemId: string; reason: string }[] }

async function countItemLinks(
  tx: any,
  itemIds: string[],
  programId: string,
): Promise<LinkCounts> {
  if (!itemIds.length) return { questions: 0, assignments: 0, guides: 0 }
  const [questions, examQuestions, programQuestions, assignments, guides] = await Promise.all([
    tx.questionBankItem.count({ where: { knowledgeItemId: { in: itemIds } } }),
    tx.question.count({ where: { knowledgeItemId: { in: itemIds } } }),
    tx.programQuestion.count({ where: { knowledgeItemId: { in: itemIds } } }),
    tx.programAssignment.findMany({ where: { programId }, select: { sourceKnowledgeIds: true } }),
    tx.programStudyGuide.findMany({ where: { programId }, select: { sourceKnowledgeIds: true } }),
  ])
  return {
    questions: questions + examQuestions + programQuestions,
    assignments: assignments.filter((a: any) => usesAnyKnowledgeId(a.sourceKnowledgeIds, itemIds)).length,
    guides: guides.filter((g: any) => usesAnyKnowledgeId(g.sourceKnowledgeIds, itemIds)).length,
  }
}

export async function POST(request: NextRequest, context: Context) {
  const requestStartedAt = Date.now()
  try {
    await requireAdmin()
    const { id } = await context.params
    const book = await db.book.findUnique({
      where: { id },
      select: { id: true, programId: true, title: true, storageProvider: true, storageKey: true, fileUrl: true, data: true, mimeType: true },
    })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const body = await request.json().catch(() => ({}))

    // Pause / resume the book-wide scan job (it is resumable by design; the
    // single-shot repair below is synchronous and has nothing to stop).
    if (body?.action === 'STOP' || body?.action === 'RESUME') {
      const repairJob = await db.bookRepairJob.findFirst({
        where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
        orderBy: { createdAt: 'desc' },
      })
      if (!repairJob) return NextResponse.json({ error: 'لا توجد مهمة إصلاح جارية يمكن التحكم بها' }, { status: 409 })
      if (body.action === 'STOP' && repairJob.status !== 'PAUSED') {
        await db.bookRepairJob.update({ where: { id: repairJob.id }, data: { status: 'PAUSED' } })
      } else if (body.action === 'RESUME' && repairJob.status === 'PAUSED') {
        await db.bookRepairJob.update({ where: { id: repairJob.id }, data: { status: 'QUEUED' } })
      }
      const job = await db.bookRepairJob.findUniqueOrThrow({ where: { id: repairJob.id } })
      return NextResponse.json({ ok: true, job })
    }

    // Verify the original PDF is still readable BEFORE changing stored work.
    let buffer: Buffer | null = null
    try {
      const stored = await getFileBufferFromStorageOrBase64({
        provider: book.storageProvider, key: book.storageKey,
        url: book.fileUrl, data: book.data, mimeType: book.mimeType,
      })
      if (stored?.buffer?.length && stored.buffer.subarray(0, 5).toString() === '%PDF-') {
        const pdf = await PDFDocument.load(stored.buffer)
        if (pdf.getPageCount() > 0) buffer = stored.buffer
      }
    } catch (error) {
      console.warn('Book repair PDF source preflight failed:', error)
    }
    if (!buffer) return NextResponse.json({
      error: 'BOOK_REPAIR_SOURCE_UNREADABLE',
      message: 'الملف الأصلي غير متاح أو ليس PDF مقروءًا. لن تُمس البيانات السابقة.',
    }, { status: 422 })

    // Book-wide selective repair («فحص وإصلاح تشوهات الكتاب»): one bounded
    // scan step per call; the job row persists progress + counters, so the
    // admin re-posts while work remains. Available for EVERY book, not just
    // the two accounting books — nothing here names a book or a title.
    if (body?.mode === 'SCAN') {
      const latest = await db.bookReadJob.findFirst({ where: { bookId: id }, orderBy: { createdAt: 'desc' } })
      const active = latest && ['QUEUED', 'RUNNING', 'PAUSED'].includes(latest.status) ? latest : null
      const stoppedAndReleased = active?.status === 'PAUSED' &&
        active.retryAt?.getUTCFullYear() === 9999 &&
        (!active.lockedUntil || active.lockedUntil <= new Date())
      if (active && !stoppedAndReleased) {
        return NextResponse.json({
          error: 'BOOK_REPAIR_JOB_ACTIVE',
          message: 'هناك مهمة قراءة/تحليل تعمل أو لم تُحرر قفلها. أوقف هذا الكتاب أولًا وانتظر اكتمال الخطوة الجارية.',
          jobId: active.id,
        }, { status: 409 })
      }
      if (latest?.status === 'FAILED' && latest.phase === 'EXTRACT') {
        return NextResponse.json({
          error: 'BOOK_EXTRACTION_INCOMPLETE',
          message: 'قراءة الكتاب فشلت قبل اكتمال الصفحات. استكمل القراءة أولاً من آخر صفحة محفوظة عبر مسار read-job؛ لا يمكن إصلاح المقاطع الآن.',
          jobId: latest.id, resumeMode: 'EXTRACT',
        }, { status: 409 })
      }
      let repairJob = await db.bookRepairJob.findFirst({
        where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
        orderBy: { createdAt: 'desc' },
      })
      if (!repairJob) {
        repairJob = await db.bookRepairJob.create({ data: { bookId: id, programId: book.programId, status: 'QUEUED', mode: 'SCAN' } })
      }
      try {
        const step = await runBookRepairScanStep(repairJob.id, buffer, Date.now() + 240_000)
        const job = await db.bookRepairJob.findUniqueOrThrow({ where: { id: repairJob.id } })
        // Repair-first auto-resume: when this step finishes the repair,
        // resume any deferred unit regenerations waiting on this book.
        // A resume failure never fails the repair response — the cron
        // backstop heals it on its next run.
        let resumed: Awaited<ReturnType<typeof resumePendingUnitRegenerations>> | null = null
        if (step.done) {
          try {
            resumed = await resumePendingUnitRegenerations(id, { deadlineMs: requestStartedAt + 285_000 })
          } catch (error) {
            console.warn('Unit regeneration auto-resume failed after repair completion:', error)
          }
        }
        try {
          const admin = await requireAdmin()
          await audit({ id: admin.id, name: admin.name }, 'REPAIR_BOOK_SCAN', 'Book', id,
            `فحص وإصلاح تشوهات الكتاب: مقاطع صحيحة ${step.counters.chunksHealthy} · مصلحة ${step.counters.chunksCorrected} · متبقية ${step.counters.chunksRemaining} · تحتاج مراجعة ${step.counters.chunksNeedsReview}؛ عناصر مصلحة ${step.counters.itemsCorrected} · تحتاج مراجعة ${step.counters.itemsNeedsReview} (الكتاب: ${book.title})`)
        } catch (error) { console.error('Book repair audit failed:', error) }
        return NextResponse.json({ ok: true, job, counters: step.counters, done: step.done, processedChunks: step.processedChunks, processedItems: step.processedItems, ...(resumed ? { resumed } : {}) })
      } catch (error: any) {
        if (error?.message === 'BOOK_REPAIR_JOB_ACTIVE') {
          return NextResponse.json({ error: 'BOOK_REPAIR_JOB_ACTIVE', message: 'بدأت مهمة قراءة/تحليل على هذا الكتاب أثناء الإصلاح. أوقفها أولًا ثم استكمل الإصلاح.' }, { status: 409 })
        }
        throw error
      }
    }

    const chunks = await db.bookChunk.findMany({
      where: { bookId: id },
      select: { id: true, index: true, pageStart: true, pageEnd: true, text: true, contentHash: true, status: true },
      orderBy: { index: 'asc' },
    })
    const corrupt = chunks.filter((chunk) => looksLikeBrokenBookPageText(chunk.text))
    if (!corrupt.length) {
      return NextResponse.json({ ok: true, repairedChunks: [], stillUnreadable: [], skippedLinked: [], remainingCorruptChunks: 0, jobRequeued: false, jobId: null })
    }

    const latest = await db.bookReadJob.findFirst({ where: { bookId: id }, orderBy: { createdAt: 'desc' } })
    const active = latest && ['QUEUED', 'RUNNING', 'PAUSED'].includes(latest.status) ? latest : null
    const stoppedAndReleased = active?.status === 'PAUSED' &&
      active.retryAt?.getUTCFullYear() === 9999 &&
      (!active.lockedUntil || active.lockedUntil <= new Date())
    if (active && !stoppedAndReleased) {
      return NextResponse.json({
        error: 'BOOK_REPAIR_JOB_ACTIVE',
        message: 'هناك مهمة قراءة/تحليل تعمل أو لم تُحرر قفلها. أوقف هذا الكتاب أولًا وانتظر اكتمال الخطوة الجارية.',
        jobId: active.id,
      }, { status: 409 })
    }
    // Mutual exclusion (criterion 4): a book-wide scan repair and this
    // single-shot repair must never run on the same book at the same time.
    if (await hasActiveBookRepairJob(id)) {
      return NextResponse.json({
        error: 'BOOK_REPAIR_JOB_ACTIVE',
        message: 'هناك مهمة فحص وإصلاح تشوهات جارية على هذا الكتاب. انتظر اكتمالها أو أوقفها قبل إصلاح الصفحات التالفة.',
      }, { status: 409 })
    }
    // A failed extraction owns this operation's precondition: unread pages
    // cannot be repaired by re-reading analyzed chunks.
    if (latest?.status === 'FAILED' && latest.phase === 'EXTRACT') {
      return NextResponse.json({
        error: 'BOOK_EXTRACTION_INCOMPLETE',
        message: 'قراءة الكتاب فشلت قبل اكتمال الصفحات. استكمل القراءة أولاً من آخر صفحة محفوظة عبر مسار read-job؛ لا يمكن إصلاح المقاطع الآن.',
        jobId: latest.id, resumeMode: 'EXTRACT',
      }, { status: 409 })
    }
    const requeueableJob =
      (latest?.status === 'FAILED' && latest.phase === 'ANALYZE') ||
      (latest?.status === 'COMPLETED' && latest.phase === 'DONE')
    if (!requeueableJob && !stoppedAndReleased) {
      return NextResponse.json({
        error: 'BOOK_REPAIR_NO_ANALYSIS_JOB',
        message: 'لا توجد مهمة تحليل مكتملة أو فاشلة يمكن استكمالها بعد الإصلاح. أكمل قراءة الكتاب وتحليله أولاً.',
        jobId: latest?.id ?? null, phase: latest?.phase ?? null,
      }, { status: 409 })
    }

    const deadlineMs = Date.now() + 240_000
    const batch = corrupt.slice(0, MAX_CHUNKS_PER_CALL)
    const repaired: { index: number; pages: number[] }[] = []
    const repairedWithoutItems: number[] = []
    const stillUnreadable: { index: number; pages: number[]; reason: string }[] = []
    const skippedLinked: { index: number; linkedItems: number; linked: LinkCounts }[] = []
    const itemsCorrected: { index: number; itemId: string }[] = []
    const itemsNeedsReview: { index: number; itemId: string; reason: string }[] = []

    for (const chunk of batch) {
      const pages = Array.from({ length: chunk.pageEnd - chunk.pageStart + 1 }, (_, i) => chunk.pageStart + i)
      // OCR outside any transaction: a slow vision call must never hold a
      // database lock. transcribeOnce already rejects a broken OCR answer,
      // so a returned page is verified text; the gate re-check below is
      // defence in depth before anything is written.
      let ocrText = ''
      try {
        const ocrPages: { page: number; text: string }[] = []
        for (let offset = 0; offset < pages.length; offset += 8) {
          const part = await transcribeScannedDocumentWithVision(buffer, pages.slice(offset, offset + 8), deadlineMs)
          ocrPages.push(...part)
        }
        ocrText = pages
          .map((page) => ocrPages.find((item) => item.page === page)?.text?.trim() || '')
          .filter(Boolean)
          .join('\n')
          .trim()
      } catch (error) {
        stillUnreadable.push({ index: chunk.index, pages, reason: 'OCR_FAILED: ' + String(error instanceof Error ? error.message : error).slice(0, 120) })
        continue
      }
      if (!ocrText || looksLikeBrokenBookPageText(ocrText)) {
        stillUnreadable.push({ index: chunk.index, pages, reason: ocrText ? 'OCR_TEXT_FAILED_VERIFICATION' : 'OCR_RETURNED_NO_TEXT' })
        continue
      }
      // Commit per chunk: re-check the chunk is unchanged and its items are
      // still unlinked at write time, then replace the text. Criterion 1:
      // a chunk that HAS items is corrected IN PLACE — its items are fixed
      // from the re-read text under the same IDs (or sent to REVIEW when
      // unprovable), never deleted and recreated. Only a chunk with NO items
      // returns to EXTRACTED for a first-time analysis afterwards.
      const outcome: RepairTxOutcome = await db.$transaction(async (tx) => {
        const current = await tx.bookChunk.findUnique({ where: { id: chunk.id }, select: { contentHash: true } })
        if (!current || current.contentHash !== chunk.contentHash) return { skipped: 'changed' as const }
        const itemRows = await tx.bookKnowledgeItem.findMany({
          where: { bookId: id, kbVersion: 2, chunkId: chunk.id },
          select: { id: true, title: true, summary: true, excerpt: true, pageStart: true, pageEnd: true },
        })
        const itemIds = itemRows.map((item) => item.id)
        const linked = await countItemLinks(tx, itemIds, book.programId)
        if (linked.questions + linked.assignments + linked.guides > 0) {
          return { skipped: 'linked' as const, linkedItems: itemIds.length, linked }
        }
        const changed = await tx.bookChunk.updateMany({
          where: { id: chunk.id, contentHash: chunk.contentHash },
          data: {
            text: ocrText, charCount: ocrText.length,
            contentHash: createHash('sha256').update(ocrText).digest('hex'),
            textProvenance: 'VISION_OCR',
            ...(itemRows.length ? {} : { status: 'EXTRACTED', attempts: 0, analysisPasses: 0, saturatedAt: null }),
            lastError: null,
          },
        })
        if (!changed.count) return { skipped: 'changed' as const }
        const corrected: { itemId: string }[] = []
        const needsReview: { itemId: string; reason: string }[] = []
        for (const item of itemRows) {
          const result = correctKnowledgeItemFromSource(
            { id: item.id, title: item.title, summary: item.summary, excerpt: item.excerpt || '', pageStart: item.pageStart, pageEnd: item.pageEnd },
            ocrText,
          )
          if (result.status === 'REVIEW') { needsReview.push({ itemId: item.id, reason: result.reason }); continue }
          if (result.data.title !== item.title || result.data.summary !== item.summary || result.data.excerpt !== (item.excerpt || '')) {
            await tx.bookKnowledgeItem.update({ where: { id: item.id }, data: { title: result.data.title, summary: result.data.summary, excerpt: result.data.excerpt } })
            corrected.push({ itemId: item.id })
          }
        }
        // The repaired pages are readable now: clear their UNREADABLE
        // ledger entries on the latest job (same helper the extract step
        // uses; the job's message segment is replaced on progress writes,
        // as it is by saveProgress).
        if (latest) {
          const job = await tx.bookReadJob.findUnique({ where: { id: latest.id }, select: { lastError: true } })
          if (job) await tx.bookReadJob.update({
            where: { id: latest.id },
            data: { lastError: mergeBookPageReadIssues(job.lastError, pages, []) },
          })
        }
        return { repaired: true as const, hadItems: itemRows.length > 0, corrected, needsReview }
      })
      if ('repaired' in outcome) {
        repaired.push({ index: chunk.index, pages })
        if (!outcome.hadItems) repairedWithoutItems.push(chunk.index)
        itemsCorrected.push(...outcome.corrected.map((entry) => ({ ...entry, index: chunk.index })))
        itemsNeedsReview.push(...outcome.needsReview.map((entry) => ({ ...entry, index: chunk.index })))
      }
      else if (outcome.skipped === 'linked') skippedLinked.push({ index: chunk.index, linkedItems: outcome.linkedItems, linked: outcome.linked })
      else stillUnreadable.push({ index: chunk.index, pages, reason: 'BOOK_REPAIR_CHUNK_CHANGED' })
    }

    // Record the still-unreadable pages in the UNREADABLE ledger on the
    // latest job, so they are visible for review instead of only living in
    // this response. (Repaired pages had their entries cleared above.)
    if (stillUnreadable.length && latest) {
      try {
        const job = await db.bookReadJob.findUnique({ where: { id: latest.id }, select: { lastError: true } })
        if (job) {
          const issues = stillUnreadable.flatMap((entry) =>
            entry.pages.map((page) => ({ page, kind: 'UNREADABLE' as const, reason: entry.reason.slice(0, 160) })))
          await db.bookReadJob.update({
            where: { id: latest.id },
            data: { lastError: mergeBookPageReadIssues(job.lastError, [], issues) },
          })
        }
      } catch (error) { console.warn('Book repair ledger write failed (response still reports the pages):', error) }
    }

    // Re-queue the latest analysis job ONLY for repaired chunks that had no
    // items (first-time analysis — nothing exists to delete). A chunk whose
    // items were corrected in place is already ANALYZED and must never be
    // re-analyzed: re-analysis would delete and recreate its items under
    // NEW ids (criterion 1). A manually stopped book is never re-queued:
    // the admin resumes it deliberately with RESUME.
    let jobRequeued = false
    if (repairedWithoutItems.length && requeueableJob && latest) {
      const changed = await db.bookReadJob.updateMany({
        where: { id: latest.id, status: latest.status },
        data: { status: 'QUEUED', phase: 'ANALYZE', chunksFailed: 0, retryAt: null, lockedUntil: null, finishedAt: null },
      })
      jobRequeued = changed.count === 1
    }
    try {
      const admin = await requireAdmin()
      await audit({ id: admin.id, name: admin.name }, 'REPAIR_BOOK_PAGES', 'Book', id,
        `إعادة قراءة صفحات تالفة عبر OCR: أُصلح ${repaired.length} مقطع، بقي غير مقروء ${stillUnreadable.length}، تُخطّى لارتباط ${skippedLinked.length}، عناصر مصلحة في المكان ${itemsCorrected.length}، عناصر تحتاج مراجعة ${itemsNeedsReview.length} (الكتاب: ${book.title})`)
    } catch (error) { console.error('Book repair audit failed:', error) }
    return NextResponse.json({
      ok: true,
      repairedChunks: repaired,
      stillUnreadable,
      skippedLinked,
      itemsCorrected,
      itemsNeedsReview,
      remainingCorruptChunks: corrupt.length - repaired.length,
      jobRequeued,
      jobId: latest?.id ?? null,
      manuallyStopped: !!stoppedAndReleased && !requeueableJob,
    })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('repair corrupt book pages error:', error)
    return NextResponse.json({ error: 'تعذر إصلاح الصفحات التالفة' }, { status: 500 })
  }
}
