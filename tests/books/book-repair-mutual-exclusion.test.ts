import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

// Criterion 4, second direction: a read/enrich step (manual button or cron)
// must refuse/skip a book while a scan repair is active on it, and must
// proceed normally once the repair is gone. Real routes against an in-memory
// fake DB; the step functions themselves are stubbed because this file pins
// only the exclusion decision, not the analysis engine.
let readJob: any
let activeRepairJob: any
let analyzeCalls = 0

mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', role: 'ADMIN' }) }))
mock.module('@/lib/book-reader', () => ({
  runExtractStep: async () => ({ phase: 'EXTRACT' }),
  // Imported by book-repair-job; never called in these tests (the exclusion
  // check happens before any OCR work).
  transcribeScannedDocumentWithVision: async () => [],
}))
mock.module('@/lib/book-chunk-analyzer', () => ({
  runAnalyzeStep: async () => { analyzeCalls += 1; return { phase: 'ANALYZE' } },
  runEnrichStep: async () => { analyzeCalls += 1; return { phase: 'ENRICH' } },
  // Imported by book-repair-scan; never called in these tests.
  conceptTokens: () => [],
}))
mock.module('@/lib/book-outline', () => ({
  buildBookOutline: async () => ({ id: 'outline-1', version: 1, sections: [], status: 'DRAFT' }),
}))
mock.module('@/lib/book-read-job-control', () => ({
  BOOK_READ_RETRY_MS: 60_000,
  BOOK_READ_TRANSIENT_RETRY_MS: 30_000,
  canRunBookReadJob: () => true,
  claimBookReadLock: async () => true,
  releaseBookReadLock: async () => undefined,
  classifyBookReadFailure: () => 'FATAL',
  preserveBookPageReadIssues: (previous: string | null) => previous,
  // Imported by book-repair-job and the repair route; never called in these
  // tests (no OCR work runs here).
  mergeBookPageReadIssues: (previous: string | null) => previous,
  parseBookPageReadIssues: () => [],
}))
mock.module('@/lib/ai-health', () => ({ claimAiHealthRun: async () => false }))
// The mock replaces text-ai for the whole import graph (knowledge-bank and
// gemini import from it), so it must carry every named export those modules
// read at import time — not only the health check the cron itself calls.
mock.module('@/lib/text-ai', () => ({
  textAiCheckAllModelHealth: async () => ({ checked: 0, results: [] }),
  hasExternalTextAi: async () => false,
  textAiCompleteJson: async () => ({}),
  textAiCompleteJsonWithMetadata: async () => ({ result: {}, model: 'mock', provider: 'mock' }),
  textAiStreamText: async () => ({}),
}))

const stepDb: any = {
  bookReadJob: {
    findFirst: async () => (readJob ? { ...readJob } : null),
    findMany: async () => (readJob ? [{ id: readJob.id, bookId: readJob.bookId, phase: readJob.phase }] : []),
    findUnique: async () => (readJob ? { ...readJob } : null),
    findUniqueOrThrow: async () => {
      if (!readJob) throw new Error('JOB_NOT_FOUND')
      return { ...readJob }
    },
    updateMany: async () => ({ count: 0 }),
  },
  bookRepairJob: {
    findFirst: async () => activeRepairJob,
  },
  bookOutline: { findFirst: async () => null },
  bookChunk: { count: async () => 0 },
  bookKnowledgeItem: { count: async () => 0 },
}
mock.module('@/lib/db', () => ({ db: stepDb }))

const readStepApi = await import('@/app/api/admin/books/[id]/read-step/route')
const cronApi = await import('@/app/api/cron/book-read-jobs/route')

function postReadStep() {
  return readStepApi.POST(
    new NextRequest('https://academy.test/api/admin/books/book-1/read-step', { method: 'POST' }),
    { params: Promise.resolve({ id: 'book-1' }) },
  )
}

function getCron() {
  return cronApi.GET(
    new NextRequest('https://academy.test/api/cron/book-read-jobs', {
      method: 'GET',
      headers: { authorization: 'Bearer test-secret' },
    }),
  )
}

describe('repair mutual exclusion — read/enrich side', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'test-secret'
    readJob = {
      id: 'job-1', bookId: 'book-1', phase: 'ANALYZE', status: 'QUEUED',
      createdAt: new Date(), startedAt: null, retryAt: null, lockedUntil: null,
      totalPages: 0, pagesDone: 0, totalChunks: 0, chunksAnalyzed: 0, chunksFailed: 0,
      lastError: null, enrichmentTarget: null,
    }
    activeRepairJob = null
    analyzeCalls = 0
  })

  test('the manual step refuses with 409 while a repair job is active', async () => {
    activeRepairJob = { id: 'repair-1', bookId: 'book-1', status: 'RUNNING' }
    const response = await postReadStep()
    const body = await response.json()
    expect(response.status).toBe(409)
    expect(body.error).toBe('BOOK_REPAIR_JOB_ACTIVE')
    expect(analyzeCalls).toBe(0)
  })

  test('the manual step proceeds once the repair job is gone', async () => {
    const response = await postReadStep()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(analyzeCalls).toBe(1)
  })

  test('the cron skips the job without stepping it while a repair is active', async () => {
    activeRepairJob = { id: 'repair-1', bookId: 'book-1', status: 'PAUSED' }
    const response = await getCron()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.outcomes).toEqual([{ jobId: 'job-1', outcome: 'SKIPPED_REPAIR_ACTIVE' }])
    expect(analyzeCalls).toBe(0)
  })

  test('the cron steps the job once the repair job is gone', async () => {
    const response = await getCron()
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.outcomes).toEqual([{ jobId: 'job-1', outcome: 'PROGRESSED' }])
    expect(analyzeCalls).toBe(1)
  })
})
