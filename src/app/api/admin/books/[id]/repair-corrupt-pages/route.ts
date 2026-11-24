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

export const runtime = 'nodejs'
export const maxDuration = 300
type Context = { params: Promise<{ id: string }> }

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
  try {
    await requireAdmin()
    const { id } = await context.params
    const book = await db.book.findUnique({
      where: { id },
      select: { id: true, programId: true, title: true, storageProvider: true, storageKey: true, fileUrl: true, data: true, mimeType: true },
    })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })

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
    const stillUnreadable: { index: number; pages: number[]; reason: string }[] = []
    const skippedLinked: { index: number; linkedItems: number; linked: LinkCounts }[] = []

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
      // still unlinked at write time, then replace the text and reset it for
      // re-analysis. Knowledge items are NOT deleted here — the analyze step
      // replaces them when it re-analyzes the repaired chunk.
      const outcome = await db.$transaction(async (tx) => {
        const current = await tx.bookChunk.findUnique({ where: { id: chunk.id }, select: { contentHash: true } })
        if (!current || current.contentHash !== chunk.contentHash) return { skipped: 'changed' as const }
        const itemIds = (await tx.bookKnowledgeItem.findMany({
          where: { bookId: id, kbVersion: 2, chunkId: chunk.id }, select: { id: true },
        })).map((item) => item.id)
        const linked = await countItemLinks(tx, itemIds, book.programId)
        if (linked.questions + linked.assignments + linked.guides > 0) {
          return { skipped: 'linked' as const, linkedItems: itemIds.length, linked }
        }
        const changed = await tx.bookChunk.updateMany({
          where: { id: chunk.id, contentHash: chunk.contentHash },
          data: {
            text: ocrText, charCount: ocrText.length,
            contentHash: createHash('sha256').update(ocrText).digest('hex'),
            textProvenance: 'VISION_OCR', status: 'EXTRACTED',
            attempts: 0, lastError: null, analysisPasses: 0, saturatedAt: null,
          },
        })
        if (!changed.count) return { skipped: 'changed' as const }
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
        return { repaired: true as const }
      })
      if ('repaired' in outcome) repaired.push({ index: chunk.index, pages })
      else if (outcome.skipped === 'linked') skippedLinked.push({ index: chunk.index, linkedItems: outcome.linkedItems, linked: outcome.linked })
      else stillUnreadable.push({ index: chunk.index, pages, reason: 'BOOK_REPAIR_CHUNK_CHANGED' })
    }

    // Re-queue the latest analysis job so the repaired chunks are
    // re-analyzed by the normal driver. A manually stopped book is never
    // re-queued: the admin resumes it deliberately with RESUME.
    let jobRequeued = false
    if (repaired.length && requeueableJob && latest) {
      const changed = await db.bookReadJob.updateMany({
        where: { id: latest.id, status: latest.status },
        data: { status: 'QUEUED', phase: 'ANALYZE', chunksFailed: 0, retryAt: null, lockedUntil: null, finishedAt: null },
      })
      jobRequeued = changed.count === 1
    }
    try {
      const admin = await requireAdmin()
      await audit({ id: admin.id, name: admin.name }, 'REPAIR_BOOK_PAGES', 'Book', id,
        `إعادة قراءة صفحات تالفة عبر OCR: أُصلح ${repaired.length} مقطع، بقي غير مقروء ${stillUnreadable.length}، تُخطّى لارتباط ${skippedLinked.length} (الكتاب: ${book.title})`)
    } catch (error) { console.error('Book repair audit failed:', error) }
    return NextResponse.json({
      ok: true,
      repairedChunks: repaired,
      stillUnreadable,
      skippedLinked,
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
