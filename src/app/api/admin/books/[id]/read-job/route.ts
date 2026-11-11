import { NextRequest, NextResponse } from 'next/server'
import { PDFDocument } from 'pdf-lib'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getFileBufferFromStorageOrBase64 } from '@/lib/storage'
import { audit } from '@/lib/notify'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string }> }

async function authorize() {
  return requireAdmin()
}

// Book knowledge IDs also occur in legacy JSON/text evidence lists. Never
// erase referenced evidence during a manual rebuild, even if there is no FK.
function usesAnyKnowledgeId(value: unknown, ids: string[]): boolean {
  if (value == null || !ids.length) return false
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return ids.some((id) => serialized.includes(id))
}

export async function GET(_request: NextRequest, context: Context) {
  try {
    await authorize()
    const { id } = await context.params
    const book = await db.book.findUnique({ where: { id }, select: { id: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
    const job = await db.bookReadJob.findFirst({ where: { bookId: id }, orderBy: { createdAt: 'desc' } })
    // Retried/enrichment jobs start with zero local counters. Report persisted
    // book totals separately so the UI never mistakes a retry for lost work.
    const [storedChunks, analyzedChunks, failedChunks, saturatedChunks, knowledgeTotal, previousRead] = await Promise.all([
      db.bookChunk.count({ where: { bookId: id } }),
      db.bookChunk.count({ where: { bookId: id, status: 'ANALYZED' } }),
      db.bookChunk.count({ where: { bookId: id, status: 'FAILED' } }),
      db.bookChunk.count({ where: { bookId: id, status: 'ANALYZED', OR: [{ saturatedAt: { not: null } }, { analysisPasses: { gte: 3 } }] } }),
      db.bookKnowledgeItem.count({ where: { bookId: id, kbVersion: 2 } }),
      db.bookReadJob.findFirst({ where: { bookId: id, totalPages: { gt: 0 } }, orderBy: { createdAt: 'desc' }, select: { totalPages: true, pagesDone: true } }),
    ])
    const enrichment = {
      totalChunks: analyzedChunks,
      storedChunks,
      failedChunks,
      knowledgeTotal,
      sourcePages: previousRead?.totalPages || 0,
      pagesSaved: previousRead?.pagesDone || 0,
      saturatedChunks,
      addedItems: job && (job.phase === 'ENRICH' || (job.phase === 'DONE' && job.totalChunks === 0))
        ? await db.bookKnowledgeItem.count({ where: { bookId: id, kbVersion: 2, createdAt: { gte: job.createdAt } } }) : 0,
    }
    return NextResponse.json({ ok: true, job, enrichment })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    console.error('book read-job GET error:', error)
    return NextResponse.json({ error: 'تعذر تحميل حالة قراءة الكتاب' }, { status: 500 })
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    await authorize()
    const { id } = await context.params
    const body = await request.json().catch(() => ({}))
    const mode = body?.mode === 'ENRICH' ? 'ENRICH' : 'EXTRACT'
    const book = await db.book.findUnique({ where: { id }, select: { id: true, programId: true } })
    if (!book) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })

    if (body?.action === 'REBUILD') {
      // This is a deliberate destructive reset of GENERATED material only,
      // separate from resumable reading. The book/file and legacy knowledge
      // remain intact; linked academic evidence must never be orphaned.
      const source = await db.book.findUnique({ where: { id }, select: {
        id: true, programId: true, title: true, storageProvider: true,
        storageKey: true, fileUrl: true, data: true, mimeType: true,
      } })
      if (!source) return NextResponse.json({ error: 'BOOK_NOT_FOUND' }, { status: 404 })
      if (body?.confirmation !== 'REBUILD_FROM_ZERO' || body?.confirmBookTitle !== source.title) {
        return NextResponse.json({ error: 'BOOK_REBUILD_CONFIRMATION_REQUIRED', message: 'يجب تأكيد اسم الكتاب وإعادة البناء من الصفر صراحةً.' }, { status: 400 })
      }
      // Verify the actual PDF is still readable BEFORE changing stored work.
      let readablePdf = false
      try {
        const stored = await getFileBufferFromStorageOrBase64({
          provider: source.storageProvider, key: source.storageKey,
          url: source.fileUrl, data: source.data, mimeType: source.mimeType,
        })
        if (stored?.buffer?.length && stored.buffer.subarray(0, 5).toString() === '%PDF-') {
          const pdf = await PDFDocument.load(stored.buffer)
          readablePdf = pdf.getPageCount() > 0
        }
      } catch (error) {
        console.warn('Book rebuild PDF source preflight failed:', error)
      }
      if (!readablePdf) return NextResponse.json({
        error: 'BOOK_REBUILD_SOURCE_UNREADABLE',
        message: 'الملف الأصلي غير متاح أو ليس PDF مقروءًا. لن تُمس البيانات السابقة.',
      }, { status: 422 })

      const outcome = await db.$transaction(async (tx) => {
        // Serialize two rebuild requests for this book. Other books and the
        // global cron are not locked, cancelled, or modified.
        await tx.$queryRaw`SELECT "id" FROM "Book" WHERE "id" = ${id} FOR UPDATE`
        const currentSource = await tx.book.findUnique({ where: { id }, select: {
          storageProvider: true, storageKey: true, fileUrl: true, data: true, title: true,
        } })
        if (!currentSource || currentSource.title !== source.title ||
          currentSource.storageProvider !== source.storageProvider ||
          currentSource.storageKey !== source.storageKey ||
          currentSource.fileUrl !== source.fileUrl || currentSource.data !== source.data) {
          return { error: 'BOOK_REBUILD_SOURCE_CHANGED' as const }
        }
        const candidate = await tx.bookReadJob.findFirst({
          where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
          orderBy: { createdAt: 'desc' },
        })
        // Lock the existing job row as well as Book. This serializes a
        // concurrent RESUME or finishing worker with the destructive reset.
        if (candidate) await tx.$queryRaw`SELECT "id" FROM "BookReadJob" WHERE "id" = ${candidate.id} FOR UPDATE`
        const active = candidate
          ? await tx.bookReadJob.findUniqueOrThrow({ where: { id: candidate.id } })
          : null
        // After manual STOP, an abandoned serverless worker may never return
        // to clear lockedUntil. An EXPIRED lease is just as safe as NULL:
        // no new worker may claim the year-9999 manual pause.
        const stoppedAndReleased = active?.status === 'PAUSED' &&
          active.retryAt?.getUTCFullYear() === 9999 &&
          (!active.lockedUntil || active.lockedUntil <= new Date())
        if (active && !stoppedAndReleased) return { error: 'BOOK_REBUILD_JOB_ACTIVE' as const }

        const known = await tx.bookKnowledgeItem.findMany({
          where: { bookId: id, kbVersion: 2 }, select: { id: true },
        })
        const ids = known.map((item) => item.id)
        const [
          linkedUnits, approvedOutlines, linkedQuestions, linkedExamQuestions,
          linkedProgramQuestions, legacyChunkKnowledge, assignments, guides,
        ] = await Promise.all([
          tx.unit.count({ where: { sourceBookId: id } }),
          tx.bookOutline.count({ where: { bookId: id, status: 'APPROVED' } }),
          tx.questionBankItem.count({ where: { OR: [
            { bookId: id }, ...(ids.length ? [{ knowledgeItemId: { in: ids } }] : []),
          ] } }),
          ids.length ? tx.question.count({ where: { knowledgeItemId: { in: ids } } }) : Promise.resolve(0),
          ids.length ? tx.programQuestion.count({ where: { knowledgeItemId: { in: ids } } }) : Promise.resolve(0),
          tx.bookKnowledgeItem.count({ where: { bookId: id, kbVersion: { not: 2 }, chunkId: { not: null } } }),
          ids.length ? tx.programAssignment.findMany({ where: { programId: source.programId }, select: { sourceKnowledgeIds: true } }) : Promise.resolve([]),
          ids.length ? tx.programStudyGuide.findMany({ where: { programId: source.programId }, select: { sourceKnowledgeIds: true } }) : Promise.resolve([]),
        ])
        const linkedAssignments = assignments.filter((a) => usesAnyKnowledgeId(a.sourceKnowledgeIds, ids)).length
        const linkedGuides = guides.filter((g) => usesAnyKnowledgeId(g.sourceKnowledgeIds, ids)).length
        const blockers = {
          linkedUnits, approvedOutlines, linkedQuestions, linkedExamQuestions,
          linkedProgramQuestions, linkedAssignments, linkedGuides, legacyChunkKnowledge,
        }
        if (Object.values(blockers).some((count) => count > 0)) {
          return { error: 'BOOK_REBUILD_ACADEMIC_REFERENCES' as const, blockers }
        }

        // Reset only generated artifacts, atomically. Do not delete the book,
        // its file, uploads, historical read jobs or non-v2 knowledge records.
        const outlines = await tx.bookOutline.deleteMany({ where: { bookId: id, status: 'DRAFT' } })
        const knowledge = await tx.bookKnowledgeItem.deleteMany({ where: { bookId: id, kbVersion: 2 } })
        const chunks = await tx.bookChunk.deleteMany({ where: { bookId: id } })
        if (active && stoppedAndReleased) {
          await tx.bookReadJob.updateMany({
            where: { id: active.id, status: 'PAUSED', lockedUntil: null },
            data: { status: 'FAILED', finishedAt: new Date() },
          })
        }
        const job = await tx.bookReadJob.create({
          data: { bookId: id, programId: source.programId, phase: 'EXTRACT', status: 'QUEUED' },
        })
        return { job, removed: { outlines: outlines.count, knowledge: knowledge.count, chunks: chunks.count } }
      })
      if ('error' in outcome) {
        const errors = {
          BOOK_REBUILD_JOB_ACTIVE: 'هناك مهمة قراءة/تحليل تعمل أو لم تُحرر قفلها. أوقف هذا الكتاب أولًا وانتظر اكتمال الخطوة الجارية.',
          BOOK_REBUILD_ACADEMIC_REFERENCES: 'لا يمكن إعادة البناء من الصفر لأن معلومات هذا الكتاب مرتبطة بوحدات أو أسئلة أو واجبات أو أدلة أو فهرس معتمد. لم تتغير أي بيانات.',
          BOOK_REBUILD_SOURCE_CHANGED: 'تغيّر ملف الكتاب أثناء التأكيد. حدّث الصفحة وأعد التحقق.',
        }
        return NextResponse.json({
          error: outcome.error,
          message: outcome.error ? errors[outcome.error] : 'تعذر إعادة بناء الكتاب؛ لم تُعدَّل البيانات.',
          ...('blockers' in outcome ? { blockers: outcome.blockers } : {}),
        }, { status: 409 })
      }
      // Audit must not turn a successful committed rebuild into a false 500.
      try {
        const admin = await authorize()
        await audit({ id: admin.id, name: admin.name }, 'REBUILD_BOOK', 'Book', id,
          `إعادة بناء من PDF أصلي مع تأكيد إداري: ${source.title} (مقاطع ${outcome.removed.chunks}، معرفة ${outcome.removed.knowledge}، مسودات ${outcome.removed.outlines})`)
      } catch (error) { console.error('Book rebuild audit failed:', error) }
      return NextResponse.json({ ok: true, rebuilt: true, job: outcome.job, removed: outcome.removed })
    }

    // A manual stop is PAUSED with an out-of-range retry time: the cron,
    // read-step lock, and browser driver must never resume it automatically.
    // Keep the existing lock until its owner finishes, avoiding concurrent
    // workers if the admin resumes before the in-flight request returns.
    if (body?.action === 'STOP' || body?.action === 'RESUME') {
      const current = await db.bookReadJob.findFirst({
        where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
        orderBy: { createdAt: 'desc' },
      })
      if (!current) return NextResponse.json({ error: 'لا توجد مهمة جارية يمكن التحكم بها' }, { status: 409 })
      const manualStop = current.status === 'PAUSED' && current.retryAt?.getUTCFullYear() === 9999
      if (body.action === 'STOP' && !manualStop) {
        await db.bookReadJob.updateMany({
          where: { id: current.id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
          data: { status: 'PAUSED', retryAt: new Date('9999-12-31T00:00:00.000Z') },
        })
      } else if (body.action === 'RESUME' && current.status === 'PAUSED') {
        await db.bookReadJob.updateMany({
          where: { id: current.id, status: 'PAUSED' },
          data: { status: 'QUEUED', retryAt: null },
        })
      }
      const job = await db.bookReadJob.findUniqueOrThrow({ where: { id: current.id } })
      return NextResponse.json({ ok: true, job, manuallyStopped: job.status === 'PAUSED' && job.retryAt?.getUTCFullYear() === 9999 })
    }
    const existing = await db.bookReadJob.findFirst({ where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
    if (existing) return NextResponse.json({ ok: true, job: existing, resumed: true })
    const lastJob = await db.bookReadJob.findFirst({ where: { bookId: id }, orderBy: { createdAt: 'desc' } })
    if (lastJob?.status === 'FAILED') {
      // A failed phase must be resumed in-place, never bypassed by creating
      // ENRICH or a fresh EXTRACT job from previously saved knowledge.
      // EXTRACT is the UI's entry point for a failed ANALYZE phase as well.
      const resumeMode = lastJob.phase === 'ENRICH' ? 'ENRICH' : 'EXTRACT'
      if (!['EXTRACT', 'ANALYZE', 'ENRICH'].includes(lastJob.phase) || mode !== resumeMode || body?.restart === true) {
        return NextResponse.json({
          error: 'BOOK_FAILED_PHASE_RESUME_REQUIRED',
          message: 'يجب استكمال المرحلة الفاشلة لنفس مهمة الكتاب قبل بدء مرحلة أخرى.',
          jobId: lastJob.id, resumeMode, failedPhase: lastJob.phase,
        }, { status: 409 })
      }
      // Compare-and-swap owns the recovery. For a failed ANALYZE, reset only
      // failed chunks inside the SAME transaction; all successfully analyzed
      // chunks, knowledge, page cursor, enhancement passes and issue ledger stay.
      const changed = lastJob.phase === 'ANALYZE'
        ? await db.$transaction(async (tx) => {
            const resumed = await tx.bookReadJob.updateMany({
              where: { id: lastJob.id, status: 'FAILED' },
              data: { status: 'QUEUED', chunksFailed: 0, retryAt: null, lockedUntil: null, finishedAt: null },
            })
            if (resumed.count) await tx.bookChunk.updateMany({
              where: { bookId: id, status: 'FAILED' },
              data: { status: 'PENDING', attempts: 0, lastError: null },
            })
            return resumed
          })
        : await db.bookReadJob.updateMany({
            where: { id: lastJob.id, status: 'FAILED' },
            data: { status: 'QUEUED', retryAt: null, lockedUntil: null, finishedAt: null },
          })
      if (changed.count) {
        const resumed = await db.bookReadJob.findUniqueOrThrow({ where: { id: lastJob.id } })
        return NextResponse.json({ ok: true, job: resumed, resumed: true })
      }
      const winner = await db.bookReadJob.findFirst({ where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
      if (winner) return NextResponse.json({ ok: true, job: winner, resumed: true })
      return NextResponse.json({ error: 'BOOK_RESUME_CONFLICT', message: 'تغيّرت حالة المهمة أثناء الاستكمال — حدّث الحالة وأعد المحاولة.' }, { status: 409 })
    }
    if (mode === 'ENRICH') {
      const readable = await db.bookChunk.count({ where: { bookId: id, status: 'ANALYZED' } })
      if (!readable) return NextResponse.json({ error: 'شغّل القراءة الكاملة أولاً' }, { status: 400 })
    }
    try {
      const job = await db.bookReadJob.create({ data: { bookId: id, programId: book.programId, phase: mode, status: 'QUEUED' } })
      return NextResponse.json({ ok: true, job, resumed: false })
    } catch (error: any) {
      // PostgreSQL partial unique index protects the create itself; a competing
      // request may have won between findFirst and create.
      if (error?.code !== 'P2002' && error?.code !== '23505') throw error
      const winner = await db.bookReadJob.findFirst({ where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
      if (!winner) throw error
      return NextResponse.json({ ok: true, job: winner, resumed: true })
    }
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
    console.error('book read-job POST error:', error)
    return NextResponse.json({ error: 'تعذر بدء قراءة الكتاب' }, { status: 500 })
  }
}
