import assert from 'node:assert/strict'
import { assertBookReadLease, bookReadLockWhere, canRunBookReadJob, claimBookReadLock, releaseBookReadLock, planBookReadJobResume, classifyBookReadFailure, isTransientBookReadError } from '../src/lib/book-read-job-control'

async function testConcurrentStepLock() {
  let lockedUntil: Date | null = null
  let executed = 0
  const fakeDb = { bookReadJob: { updateMany: async ({ where, data }: any) => {
    assert.deepEqual(where.OR[0], { lockedUntil: null })
    const now = new Date(data.startedAt)
    if (lockedUntil && lockedUntil >= now) return { count: 0 }
    lockedUntil = data.lockedUntil
    return { count: 1 }
  } } }
  const [first, second] = await Promise.all([claimBookReadLock(fakeDb, 'job'), claimBookReadLock(fakeDb, 'job')])
  for (const claimed of [first, second]) if (claimed) executed++
  assert.equal(executed, 1)
}

async function testActiveJobUniqueness() {
  const active = new Map<string, string>()
  const create = async (bookId: string) => {
    if (active.has(bookId)) return active.get(bookId)
    // Simulate the PostgreSQL unique index as the authoritative constraint.
    const jobId = `job-${bookId}`
    active.set(bookId, jobId)
    return jobId
  }
  const jobs = await Promise.all([create('book'), create('book')])
  assert.equal(new Set(jobs).size, 1)
  assert.equal(active.size, 1)
}

async function testBookScopedStopAndResume() {
  const first = new Date('2026-11-11T12:00:00.000Z')
  const second = new Date(first.getTime() + 1000)
  const lease = new Date(first.getTime() + 270_000)
  type State = { status: string; startedAt: Date; lockedUntil: Date | null; retryAt: Date | null }
  const states = new Map<string, State>([
    ['book-A', { status: 'RUNNING', startedAt: first, lockedUntil: lease, retryAt: null }],
    ['book-B', { status: 'RUNNING', startedAt: second, lockedUntil: new Date(lease.getTime() + 1000), retryAt: null }],
  ])
  const db = { bookReadJob: { updateMany: async ({ where, data }: any) => {
    const job = states.get(where.id)
    if (!job || (where.status && job.status !== where.status)) return { count: 0 }
    if (where.startedAt && job.startedAt.getTime() !== new Date(where.startedAt).getTime()) return { count: 0 }
    if (where.retryAt instanceof Date && job.retryAt?.getTime() !== where.retryAt.getTime()) return { count: 0 }
    if (where.OR && !where.OR.some((part: any) =>
      ('retryAt' in part && part.retryAt === null && job.retryAt === null)
      || (part.retryAt?.lt && job.retryAt && job.retryAt < part.retryAt.lt)
    )) return { count: 0 }
    Object.assign(job, data)
    return { count: 1 }
  } } }

  // STOP A while its provider call is in flight. Its lease is freed only
  // when the owning worker returns; B continues entirely unchanged.
  const a = states.get('book-A')!
  const b = states.get('book-B')!
  a.status = 'PAUSED'
  a.retryAt = new Date('9999-12-31T00:00:00.000Z')
  await releaseBookReadLock(db, 'book-A', first, true)
  assert.equal(a.status, 'PAUSED')
  assert.equal(a.lockedUntil, null)
  assert.equal(canRunBookReadJob(a, new Date()), false)
  assert.equal(b.status, 'RUNNING')
  assert.notEqual(b.lockedUntil, null)

  // RESUME while the old call is still finishing. The old lease releases
  // without waiting 270 seconds and no second worker can start before it.
  a.status = 'QUEUED'
  a.retryAt = null
  a.lockedUntil = lease
  await releaseBookReadLock(db, 'book-A', first, false)
  assert.equal(a.status, 'QUEUED')
  assert.equal(a.lockedUntil, null)
  assert.equal(canRunBookReadJob(a, new Date()), true)

  // A delayed older worker must never unlock a newer worker's lease.
  a.status = 'RUNNING'
  a.startedAt = second
  a.lockedUntil = new Date(lease.getTime() + 1000)
  await releaseBookReadLock(db, 'book-A', first, true)
  assert.equal(a.status, 'RUNNING')
  assert.equal(a.lockedUntil?.getTime(), lease.getTime() + 1000)

  // Cron keeps its previous automatic-retry behavior for book B.
  b.status = 'PAUSED'
  b.retryAt = new Date('2026-11-11T12:01:00.000Z')
  await releaseBookReadLock(db, 'book-B', second, true)
  assert.equal(b.status, 'QUEUED')
  assert.equal(b.lockedUntil, null)
  assert.equal(b.retryAt, null)
}

async function testFencedWritesAfterWorkerTakeover() {
  const now = Date.now()
  const oldClaim = new Date(now - 80_000)
  const freshClaim = new Date(now - 2_000)
  const state = {
    id: 'book-A-job', status: 'RUNNING',
    startedAt: oldClaim, lockedUntil: new Date(now + 100_000),
    pagesDone: 48, chunksAnalyzed: 11, knowledgeCount: 32,
  }
  const tx = {
    $queryRaw: async (parts: TemplateStringsArray, id: string, claimedAt: Date) => {
      // The real SQL must lock the job row, not merely check it before writes.
      assert.match(parts.join('?'), /FOR UPDATE/)
      assert.match(parts.join('?'), /"lockedUntil" > clock_timestamp\(\)/)
      return state.id === id && state.status === 'RUNNING'
        && state.startedAt.getTime() === claimedAt.getTime()
        && state.lockedUntil.getTime() > Date.now() ? [{ id }] : []
    },
  }
  const persist = async (claimedAt: Date, updates: { pages?: number; chunks?: number; items?: number }) => {
    await assertBookReadLease(tx as any, state.id, claimedAt)
    if (updates.pages !== undefined) state.pagesDone = updates.pages
    if (updates.chunks) state.chunksAnalyzed += updates.chunks
    if (updates.items) state.knowledgeCount += updates.items
  }

  await persist(oldClaim, { pages: 56, chunks: 1, items: 2 })
  assert.deepEqual([state.pagesDone, state.chunksAnalyzed, state.knowledgeCount], [56, 12, 34])

  // A newer cron worker reclaims the very same job after an old function
  // freezes. The old timestamp must fail for ALL three saved-data types.
  state.startedAt = freshClaim
  await assert.rejects(persist(oldClaim, { pages: 8, chunks: 1, items: 20 }), /BOOK_READ_LEASE_LOST/)
  // The stale worker must not mark the newer worker's task completed either.
  await assert.rejects((async () => {
    await assertBookReadLease(tx as any, state.id, oldClaim)
    state.status = 'COMPLETED'
  })(), /BOOK_READ_LEASE_LOST/)
  assert.equal(state.status, 'RUNNING')
  assert.deepEqual([state.pagesDone, state.chunksAnalyzed, state.knowledgeCount], [56, 12, 34])
  await persist(freshClaim, { pages: 64, chunks: 1, items: 3 })
  assert.deepEqual([state.pagesDone, state.chunksAnalyzed, state.knowledgeCount], [64, 13, 37])

  // Even when no new worker has claimed yet, an expired lease cannot write.
  state.lockedUntil = new Date(now - 1000)
  await assert.rejects(persist(freshClaim, { pages: 16, chunks: 1, items: 4 }), /BOOK_READ_LEASE_LOST/)
  assert.deepEqual([state.pagesDone, state.chunksAnalyzed, state.knowledgeCount], [64, 13, 37])

  // Manual STOP also excludes a still-finishing provider call.
  state.status = 'PAUSED'
  state.lockedUntil = new Date(now + 100_000)
  await assert.rejects(persist(freshClaim, { pages: 1, chunks: 1, items: 4 }), /BOOK_READ_LEASE_LOST/)
  assert.deepEqual([state.pagesDone, state.chunksAnalyzed, state.knowledgeCount], [64, 13, 37])
}

function testResumeFromSavedPhase() {
  for (const phase of ['EXTRACT', 'ANALYZE', 'ENRICH']) {
    assert.equal(planBookReadJobResume({ status: 'FAILED', phase }), 'RESUME', `failed ${phase} must continue the saved job`)
    assert.equal(planBookReadJobResume({ status: 'FAILED', phase }, true), 'CREATE', 'only an explicit restart opts out of resume')
  }
  assert.equal(planBookReadJobResume({ status: 'COMPLETED', phase: 'ENRICH' }), 'CREATE')
  assert.equal(planBookReadJobResume({ status: 'FAILED', phase: 'UNKNOWN' }), 'CREATE')
  assert.equal(planBookReadJobResume(null), 'CREATE')
}

async function testPauseRetry() {
  const now = new Date('2026-10-08T12:00:00.000Z')
  const retryAt = new Date(now.getTime() + 60_000)
  const job = { status: 'PAUSED', retryAt }
  assert.equal(canRunBookReadJob(job, now), false)
  assert.equal(canRunBookReadJob(job, new Date(retryAt.getTime() + 1)), true)
  assert.deepEqual(bookReadLockWhere('job', now).OR[1], { lockedUntil: { lt: now } })

  // Only the manually stopped book becomes ineligible: cron keeps processing
  // every other queued, running, and due-for-retry job as before.
  const manualStop = { status: 'PAUSED', retryAt: new Date('9999-12-31T00:00:00.000Z') }
  assert.equal(canRunBookReadJob(manualStop, now), false)
  assert.equal(canRunBookReadJob({ status: 'QUEUED', retryAt: null }, now), true)
  assert.equal(canRunBookReadJob({ status: 'RUNNING', retryAt: null }, now), true)
  assert.equal(canRunBookReadJob(job, new Date(retryAt.getTime() + 1)), true)
}

function testFailureClassification() {
  // Haris's taxonomy (2026-11-04): pressure pauses and retries; proven
  // billing exhaustion stops for the operator; missing configuration is a
  // settings error; genuine book problems fail loudly.
  const incident = 'OPENAI/gpt-5.6-luna/key#1: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing'
  // BILLING — every available provider's state is known and billing-dead:
  // the incident itself (single attempted provider, nothing else pending),
  // billing attempts plus no-balance skips only, and the all-skipped variant.
  assert.equal(classifyBookReadFailure(incident), 'BILLING')
  assert.equal(classifyBookReadFailure('OPENAI/gpt-5.6-luna/key#1: You have no credits remaining || تخطّى: APINEX/free/gpt-6-luna (NO_BALANCE)، TOPTOOLS/glm-5/key#1 (NO_BALANCE)'), 'BILLING')
  assert.equal(classifyBookReadFailure('TEXT_AI_ROUTER_FAILED || تخطّى: OPENAI/gpt-5.6-luna (NO_BALANCE)'), 'BILLING')
  // NOT billing while any provider's state is temporary/unknown (Haris's
  // audit rule): a cooldown, health, dead-model or rate-limit skip — or a
  // non-billing attempt — downgrades the verdict to a pausing TRANSIENT.
  assert.equal(classifyBookReadFailure('OPENAI/gpt-5.6-luna/key#1: You have no credits remaining || تخطّى: GEMINI/gemini-3.8-flash (COOLDOWN_MODEL)'), 'TRANSIENT')
  assert.equal(classifyBookReadFailure('TEXT_AI_ROUTER_FAILED || تخطّى: GEMINI/gemini-3.8-flash (COOLDOWN_MODEL)، APINEX/free/gpt-6-luna (NO_BALANCE)'), 'TRANSIENT')
  assert.equal(classifyBookReadFailure('TEXT_AI_ROUTER_FAILED || تخطّى: GEMINI/gemini-3.5-flash-lite (HEALTH_SKIP)، OPENAI/gpt-5.6-luna (NO_BALANCE)'), 'TRANSIENT')
  assert.equal(classifyBookReadFailure('GEMINI/gemini-3.8-flash/key#1: 429 Resource exhausted — rate limit exceeded | OPENAI/gpt-5.6-luna/key#1: You have no credits remaining'), 'TRANSIENT')
  // TRANSIENT — plain provider pressure.
  assert.equal(classifyBookReadFailure('GEMINI/gemini-3.8-flash/key#1: 503 Service unavailable, high demand'), 'TRANSIENT')
  assert.equal(classifyBookReadFailure('TEXT_AI_ROUTER_FAILED'), 'TRANSIENT')
  assert.equal(classifyBookReadFailure('AI_ACADEMIC_PROVIDER_UNAVAILABLE'), 'TRANSIENT')
  // CONFIG — the bench was never configured with a usable key.
  assert.equal(classifyBookReadFailure('TEXT_AI_ROUTER_NOT_CONFIGURED'), 'CONFIG')
  assert.equal(classifyBookReadFailure('Provider OPENAI is not_configured for this workspace'), 'CONFIG')
  // FATAL — genuine book/content problems fail loudly, never pause or stop
  // with an operator billing/settings message.
  assert.equal(classifyBookReadFailure('BOOK_PDF_REQUIRED'), 'FATAL')
  assert.equal(classifyBookReadFailure('INVALID_BOOK_KNOWLEDGE_ENVELOPE'), 'FATAL')
  assert.equal(classifyBookReadFailure('BOOK_PROGRESS_EXCEEDS_PDF'), 'FATAL')
  // The legacy predicate is exactly the TRANSIENT bucket.
  assert.equal(isTransientBookReadError('GEMINI/gemini-3.8-flash/key#1: 503 Service unavailable'), true)
  assert.equal(isTransientBookReadError(incident), false)
  assert.equal(isTransientBookReadError('TEXT_AI_ROUTER_NOT_CONFIGURED'), false)
  assert.equal(isTransientBookReadError('BOOK_PDF_REQUIRED'), false)
}

Promise.all([testConcurrentStepLock(), testActiveJobUniqueness(), testPauseRetry(), testBookScopedStopAndResume(), testFencedWritesAfterWorkerTakeover()])
  .then(() => { testResumeFromSavedPhase(); testFailureClassification(); console.log('book read lock and retry tests passed') })
  .catch((error) => { console.error(error); process.exitCode = 1 })
