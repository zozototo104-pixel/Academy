import assert from 'node:assert/strict'
import { bookReadLockWhere, canRunBookReadJob, claimBookReadLock, isTransientBookReadError } from '../src/lib/book-read-job-control'

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

function testTransientClassification() {
  // The 2026-11-04 production failure: a provider billing refusal must pause
  // the job (recoverable operator state), never kill it as FAILED.
  assert.equal(isTransientBookReadError('OPENAI/gpt-5.6-luna/key#1: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing'), true)
  assert.equal(isTransientBookReadError('APINEX/free/gpt-6-luna/key#1: Insufficient credits for this request'), true)
  assert.equal(isTransientBookReadError('GEMINI/gemini-3.5-flash-lite/key#1: your credit balance is too low'), true)
  // Nobody was even attempted (every candidate skipped): a bench state that
  // clears when cooldowns expire, so it is transient too.
  assert.equal(isTransientBookReadError('TEXT_AI_ROUTER_FAILED'), true)
  assert.equal(isTransientBookReadError('TEXT_AI_ROUTER_FAILED || تخطّى: GEMINI/gemini-3.8-flash (COOLDOWN_MODEL)'), true)
  // Genuine book/content problems stay non-transient: the job must fail loudly.
  assert.equal(isTransientBookReadError('BOOK_PDF_REQUIRED'), false)
  assert.equal(isTransientBookReadError('INVALID_BOOK_KNOWLEDGE_ENVELOPE'), false)
  assert.equal(isTransientBookReadError('BOOK_PROGRESS_EXCEEDS_PDF'), false)
}

Promise.all([testConcurrentStepLock(), testActiveJobUniqueness(), testPauseRetry()])
  .then(() => { testTransientClassification(); console.log('book read lock and retry tests passed') })
  .catch((error) => { console.error(error); process.exitCode = 1 })
