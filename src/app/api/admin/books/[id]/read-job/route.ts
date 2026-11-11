import { NextRequest, NextResponse } from 'next/server'
import { PDFDocument } from 'pdf-lib'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getFileBufferFromStorageOrBase64 } from '@/lib/storage'
import { audit } from '@/lib/notify'

export const runtime = 'nodejs'
type Context = { params: Promise<{ id: string }> }

async function authorize() {
  await requireAdmin()
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
