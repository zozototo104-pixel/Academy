import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Wiring pins for the 2026-11-04 book-read failure fixes. The behavioral half
// (which errors pause vs fail a job) lives in scripts/test-book-read-lock.ts;
// these pins keep the user-facing honesty guarantees from silently regressing:
// a FAILED job must not be reported as "not found", a trailing step call after
// a COMPLETED job must not surface as an error, and the text router's final
// error must name the candidates it skipped instead of implying a 1-provider
// chain.
const root = join(import.meta.dir, '..', '..')
const readStep = readFileSync(join(root, 'src/app/api/admin/books/[id]/read-step/route.ts'), 'utf8')
const textAi = readFileSync(join(root, 'src/lib/text-ai.ts'), 'utf8')
const jobControl = readFileSync(join(root, 'src/lib/book-read-job-control.ts'), 'utf8')
const cron = readFileSync(join(root, 'src/app/api/cron/book-read-jobs/route.ts'), 'utf8')
const readJobRoute = readFileSync(join(root, 'src/app/api/admin/books/[id]/read-job/route.ts'), 'utf8')
const retryFailedChunksRoute = readFileSync(join(root, 'src/app/api/admin/books/[id]/retry-failed-chunks/route.ts'), 'utf8')
const adminBooks = readFileSync(join(root, 'src/components/aact/AdminBooks.tsx'), 'utf8')

describe('read-step honest job states', () => {
  it('never answers the bare BOOK_READ_JOB_NOT_FOUND code', () => {
    expect(readStep.includes('BOOK_READ_JOB_NOT_FOUND')).toBe(false)
  })

  it('tells the admin a FAILED job must be restarted from the read button', () => {
    expect(readStep).toContain("latest?.status === 'FAILED'")
    expect(readStep).toContain('آخر محاولة لقراءة هذا الكتاب فشلت')
    expect(readStep).toContain('status: 409')
  })

  it('treats a step call after completion as an already-completed skip', () => {
    expect(readStep).toContain("latest?.status === 'COMPLETED'")
    expect(readStep).toContain("skipped: 'ALREADY_COMPLETED'")
  })
})

describe('four-way failure handling in the read-step route', () => {
  it('classifies step failures instead of a binary transient check', () => {
    expect(readStep).toContain('classifyBookReadFailure')
    expect(jobControl).toContain('export function classifyBookReadFailure')
  })

  it('stops with a clear operator message on proven billing exhaustion', () => {
    expect(readStep).toContain("kind === 'BILLING'")
    expect(readStep).toContain('نفد رصيد جميع المزودين المتاحين')
  })

  it('stops with a settings message when no provider is configured', () => {
    expect(readStep).toContain("kind === 'CONFIG'")
    expect(readStep).toContain('خطأ إعدادات')
  })

  it('keeps the strict billing rule: any non-balance skip downgrades the verdict', () => {
    expect(jobControl).toContain("skipReasons.every((reason) => reason === 'NO_BALANCE')")
    expect(jobControl).toContain('if (skipReasons.length > 0) return \'TRANSIENT\'')
  })
})

describe('router error names skipped candidates', () => {
  it('collects skip notes with fixed reason codes', () => {
    expect(textAi).toContain('const noteSkip = ')
    expect(textAi).toContain("noteSkip(provider, model, 'NO_BALANCE')")
    expect(textAi).toContain("noteSkip(provider, model, 'COOLDOWN_KEY')")
    expect(textAi).toContain("noteSkip(provider, model, 'COOLDOWN_MODEL')")
    expect(textAi).toContain("noteSkip(provider, model, 'MODEL_DEAD')")
  })

  it('appends the skipped list to the final router error', () => {
    expect(textAi).toContain('|| تخطّى: ${skipNotes.join(')
    expect(textAi).toContain("errors.join(' | ') || 'TEXT_AI_ROUTER_FAILED'")
  })
})

describe('per-book stop preserves existing background scheduling', () => {
  it('keeps the same cron selection for old queued, running, and retry-due jobs', () => {
    expect(cron).toContain("status: { in: ['QUEUED', 'RUNNING'] }")
    expect(cron).toContain("{ status: 'PAUSED', retryAt: { lte: new Date() } }")
    expect(cron).toContain("if (!(await claimBookReadLock(db, job.id, claimedAt)))")
    expect(jobControl).toContain("if (cron) await db.bookReadJob.updateMany({")
  })

  it('never requeues a manually stopped job or overwrites it when work finishes', () => {
    expect(cron).toContain("current.retryAt?.getUTCFullYear() === 9999")
    expect(cron).toContain("releaseBookReadLock(db, job.id, claimedAt, true)")
    expect(readStep).toContain("releaseBookReadLock(db, job.id, now, false)")
    expect(jobControl).toContain("where: { ...base, status: 'PAUSED', retryAt: manualStopAt }")
    expect(jobControl).toContain("where: { ...base, status: 'QUEUED' }")
  })

  it('STOP and RESUME target only the current book and retain its existing job', () => {
    expect(readJobRoute).toContain("body?.action === 'STOP' || body?.action === 'RESUME'")
    expect(readJobRoute).toContain("where: { bookId: id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }")
    expect(readJobRoute).toContain("where: { id: current.id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }")
    expect(readJobRoute).toContain("where: { id: current.id, status: 'PAUSED' }")
    expect(readJobRoute).toContain("new Date('9999-12-31T00:00:00.000Z')")
    expect(readJobRoute).toContain("db.bookReadJob.findUniqueOrThrow({ where: { id: current.id } })")
  })
})

describe('terminal book failure recovery in admin UI', () => {
  const pollingStart = adminBooks.indexOf("if (workspaceTab !== 'knowledge') return\n    const timer = setInterval")
  const pollingEnd = adminBooks.indexOf('    }, 5000)', pollingStart)
  it('never silently restarts a FAILED book when the page is open', () => {
    expect(pollingStart).toBeGreaterThan(-1)
    expect(pollingEnd).toBeGreaterThan(pollingStart)
    const polling = adminBooks.slice(pollingStart, pollingEnd)
    expect(polling).toContain("if (job?.status === 'FAILED') continue")
    expect(polling).not.toContain('/retry-failed-chunks')
    expect(polling).not.toContain("method: 'POST'")
  })

  it('retains background progress for scheduled and retry-due jobs', () => {
    const polling = adminBooks.slice(pollingStart, pollingEnd)
    expect(polling).toContain("['QUEUED', 'RUNNING', 'PAUSED'].includes(job.status)")
    expect(polling).toContain("job.retryAt && new Date(job.retryAt).getTime() > Date.now()")
    expect(polling).toContain('void advanceBookReadJob(book.id)')
  })

  it('retries failed enrichment as enrichment, never as a fresh PDF read', () => {
    expect(adminBooks).toContain("job.phase === 'ENRICH' ? startBookEnrichment(b.id)")
    expect(adminBooks).toContain("job.phase === 'ANALYZE' && chunksFailed > 0 ? retryFailedBookChunks(b.id) : startBookReadJob(b.id)")
    expect(adminBooks).toContain('إعادة محاولة استخراج المزيد')
  })
})

describe('manual resume keeps saved book progress', () => {
  it('revives failed extraction, analysis or enrichment in the same job without resetting page/chunk counters', () => {
    expect(readJobRoute).toContain("if (lastJob?.status === 'FAILED')")
    expect(readJobRoute).toContain("lastJob.phase === 'ENRICH' ? 'ENRICH' : 'EXTRACT'")
    expect(readJobRoute).toContain("mode !== resumeMode || body?.restart === true")
    expect(readJobRoute).toContain("where: { id: lastJob.id, status: 'FAILED' }")
    expect(readJobRoute).toContain("data: { status: 'QUEUED', retryAt: null, lockedUntil: null, finishedAt: null }")
    expect(readJobRoute).toContain("await tx.bookChunk.updateMany({")
    expect(readJobRoute).not.toContain("data: { status: 'QUEUED', pagesDone: 0")
    expect(readJobRoute).not.toContain("data: { status: 'QUEUED', chunksAnalyzed: 0")
  })

  it('retries only failed knowledge chunks without erasing completed chunks or replacing the job', () => {
    expect(retryFailedChunksRoute).toContain("where: { bookId: id, status: 'FAILED' }")
    expect(retryFailedChunksRoute).toContain("data: { status: 'PENDING', attempts: 0, lastError: null }")
    expect(retryFailedChunksRoute).toContain("latest?.status !== 'FAILED' || latest.phase !== 'ANALYZE'")
    expect(retryFailedChunksRoute).toContain("if (!failedCount) return { noFailedChunks: true")
    expect(retryFailedChunksRoute).toContain("where: { id: latest.id, status: 'FAILED' }")
    expect(retryFailedChunksRoute).toContain("chunksFailed: 0")
    expect(retryFailedChunksRoute).not.toContain("tx.bookReadJob.create(")
    expect(retryFailedChunksRoute).not.toContain("bookKnowledgeItem.deleteMany")
    expect(retryFailedChunksRoute).not.toContain("chunksAnalyzed: 0")
  })

  it('leaves an actively working or manually stopped book alone', () => {
    expect(retryFailedChunksRoute).toContain("if (active) return { chunksReset: 0, jobId: active.id, resumed: true }")
    expect(adminBooks).toContain("chunksFailed > 0 ? retryFailedBookChunks(b.id)")
  })
})

// Exercise the real route against an isolated in-memory DB contract, not just
// its source text. No production records or external services are touched.
type RetryJob = {
  id: string; bookId: string; programId: string; status: string
  phase: string; pagesDone: number; totalPages: number; chunksAnalyzed: number
  chunksFailed: number; lockedUntil: Date | null; retryAt: Date | null
}
type RetryChunk = { status: string; attempts: number; lastError: string | null }
let retryJob: RetryJob
let retryChunks: RetryChunk[]
let createdJobs = 0
let changedChunks = 0

const retryDb: any = {
  book: { findUnique: async () => ({ id: 'book-1', programId: 'program-1' }) },
  bookReadJob: {
    findFirst: async ({ where }: any) =>
      !retryJob || (where?.status?.in && !where.status.in.includes(retryJob.status)) ? null : { ...retryJob },
    updateMany: async ({ where, data }: any) => {
      if (!retryJob || retryJob.id !== where.id || (where.status && where.status !== retryJob.status)) return { count: 0 }
      Object.assign(retryJob, data)
      return { count: 1 }
    },
    create: async ({ data }: any) => {
      createdJobs++
      retryJob = { ...retryJob, ...data, id: 'new-analysis-job' }
      return { ...retryJob }
    },
  },
  bookChunk: {
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const chunk of retryChunks) {
        if (chunk.status !== where.status) continue
        Object.assign(chunk, data)
        count++
      }
      changedChunks += count
      return { count }
    },
  },
  $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(retryDb),
}
mock.module('@/lib/db', () => ({ db: retryDb }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', role: 'ADMIN' }) }))
const retryApi = await import('@/app/api/admin/books/[id]/retry-failed-chunks/route')

function requestFailedChunkRetry() {
  return retryApi.POST(
    new NextRequest('https://academy.test/api/admin/books/book-1/retry-failed-chunks', { method: 'POST' }),
    { params: Promise.resolve({ id: 'book-1' }) },
  )
}

describe('direct failed-chunk API cannot skip unfinished extraction', () => {
  beforeEach(() => {
    retryJob = {
      id: 'saved-job', bookId: 'book-1', programId: 'program-1',
      status: 'FAILED', phase: 'EXTRACT', pagesDone: 86, totalPages: 227,
      chunksAnalyzed: 24, chunksFailed: 1, lockedUntil: null, retryAt: null,
    }
    retryChunks = [
      { status: 'FAILED', attempts: 3, lastError: 'previous analysis problem' },
      { status: 'ANALYZED', attempts: 0, lastError: null },
    ]
    createdJobs = 0
    changedChunks = 0
  })

  it('returns 409 with the saved extraction job and changes nothing when pages remain', async () => {
    const response = await requestFailedChunkRetry()
    const body = await response.json()
    expect(response.status).toBe(409)
    expect(body.error).toBe('BOOK_EXTRACTION_INCOMPLETE')
    expect(body.resumeMode).toBe('EXTRACT')
    expect(body.jobId).toBe('saved-job')
    expect(retryJob.phase).toBe('EXTRACT')
    expect(retryJob.pagesDone).toBe(86)
    expect(retryJob.status).toBe('FAILED')
    expect(retryChunks[0]).toEqual({ status: 'FAILED', attempts: 3, lastError: 'previous analysis problem' })
    expect(changedChunks).toBe(0)
    expect(createdJobs).toBe(0)
  })

  it('continues to retry only failed chunks within the saved analysis job', async () => {
    retryJob.phase = 'ANALYZE'
    retryJob.pagesDone = 227
    const response = await requestFailedChunkRetry()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.jobId).toBe('saved-job')
    expect(body.chunksReset).toBe(1)
    expect(retryJob.status).toBe('QUEUED')
    expect(retryJob.phase).toBe('ANALYZE')
    expect(retryJob.pagesDone).toBe(227)
    expect(retryJob.chunksAnalyzed).toBe(24)
    expect(retryChunks[0].status).toBe('PENDING')
    expect(retryChunks[1].status).toBe('ANALYZED')
    expect(createdJobs).toBe(0)
  })

  it('does not reset chunks or leases of an already active book', async () => {
    retryJob.status = 'RUNNING'
    retryJob.phase = 'ANALYZE'
    retryJob.lockedUntil = new Date('2026-11-11T21:00:00.000Z')
    const response = await requestFailedChunkRetry()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.jobId).toBe('saved-job')
    expect(body.chunksReset).toBe(0)
    expect(changedChunks).toBe(0)
    expect(createdJobs).toBe(0)
    expect(retryJob.lockedUntil?.toISOString()).toBe('2026-11-11T21:00:00.000Z')
  })
})
