import assert from 'node:assert/strict'
import { bookReadLockWhere, canRunBookReadJob, claimBookReadLock, classifyBookReadFailure, isTransientBookReadError } from '../src/lib/book-read-job-control'

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

async function testPauseRetry() {
  const now = new Date('2026-10-08T12:00:00.000Z')
  const retryAt = new Date(now.getTime() + 60_000)
  const job = { status: 'PAUSED', retryAt }
  assert.equal(canRunBookReadJob(job, now), false)
  assert.equal(canRunBookReadJob(job, new Date(retryAt.getTime() + 1)), true)
  assert.deepEqual(bookReadLockWhere('job', now).OR[1], { lockedUntil: { lt: now } })
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

Promise.all([testConcurrentStepLock(), testActiveJobUniqueness(), testPauseRetry()])
  .then(() => { testFailureClassification(); console.log('book read lock and retry tests passed') })
  .catch((error) => { console.error(error); process.exitCode = 1 })
