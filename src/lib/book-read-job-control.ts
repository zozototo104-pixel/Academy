export type BookPageReadIssue = { page: number; kind: 'UNREADABLE' | 'PARTIAL'; reason: string }
const PAGE_ISSUES_PREFIX = 'BOOK_PAGE_ISSUES:'

/** Persist per-page reading limitations with the resumable job, without schema migration. */
export function parseBookPageReadIssues(lastError: string | null | undefined): BookPageReadIssue[] {
  if (!lastError) return []
  // Keep legacy ledger-only values readable, plus errors that carry the
  // ledger as a suffix. Provider/analysis errors must not destroy page evidence.
  const marker = lastError.startsWith(PAGE_ISSUES_PREFIX)
    ? 0 : lastError.lastIndexOf('\n' + PAGE_ISSUES_PREFIX) + 1
  if (marker < 0 || !lastError.slice(marker).startsWith(PAGE_ISSUES_PREFIX)) return []
  try {
    const parsed = JSON.parse(lastError.slice(marker + PAGE_ISSUES_PREFIX.length))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((issue): issue is BookPageReadIssue =>
      Number.isSafeInteger(issue?.page) && issue.page > 0 &&
      (issue.kind === 'UNREADABLE' || issue.kind === 'PARTIAL') &&
      typeof issue.reason === 'string').map((issue) => ({
        page: issue.page, kind: issue.kind, reason: issue.reason.slice(0, 160),
      }))
  } catch { return [] }
}

/** A successful later re-read clears the corresponding old issue. */
export function mergeBookPageReadIssues(
  previous: string | null | undefined,
  processedPages: readonly number[],
  newIssues: readonly BookPageReadIssue[],
): string | null {
  const processed = new Set(processedPages)
  const byPage = new Map(parseBookPageReadIssues(previous)
    .filter((issue) => !processed.has(issue.page)).map((issue) => [issue.page, issue]))
  for (const issue of newIssues) if (Number.isSafeInteger(issue.page) && issue.page > 0) {
    byPage.set(issue.page, { page: issue.page, kind: issue.kind, reason: issue.reason.slice(0, 160) })
  }
  const report = [...byPage.values()].sort((a, b) => a.page - b.page)
  return report.length ? PAGE_ISSUES_PREFIX + JSON.stringify(report) : null
}

export function hasBookPageReadIssues(value: string | null | undefined): boolean {
  return parseBookPageReadIssues(value).length > 0
}

export const BOOK_READ_LOCK_MS = 270_000 // 240s work budget + 30s grace; below 300s maxDuration
export const BOOK_READ_RETRY_MS = 5 * 60_000
export const BOOK_READ_TRANSIENT_RETRY_MS = 60_000

const BOOK_READ_TRANSIENT_TERMS = [
  'ai_deadline_exceeded',
  'deadline',
  'timeout',
  'timed out',
  'abort',
  'high demand',
  'overloaded',
  'unavailable',
  '503',
  '429',
  'resource_exhausted',
  'rate limit',
  'book_extract_deadline',
  'book_read_time_budget_exhausted',
  'ai_academic_provider_unavailable',
  // Nobody was even attempted (every candidate skipped): a bench state that
  // clears when cooldowns expire — unless the strict billing rule below
  // proves every skip was a known no-balance mark.
  'text_ai_router_failed',
  'no_provider',
]

const BOOK_READ_BILLING_TERMS = [
  'no credits',
  'add credits',
  'insufficient credits',
  'credit balance',
  'payment required',
  'no balance',
  'no_balance',
  'recharge',
  'top up',
  'topup',
]

function hasTransientTerm(text: string): boolean {
  return BOOK_READ_TRANSIENT_TERMS.some((term) => text.includes(term))
}

function isBillingAttemptText(attempt: string): boolean {
  return BOOK_READ_BILLING_TERMS.some((term) => attempt.includes(term)) || /\b402\b/.test(attempt)
}

export type BookReadFailureKind = 'TRANSIENT' | 'BILLING' | 'CONFIG' | 'FATAL'

/**
 * Four-way classification of a book-read step failure (Haris's taxonomy,
 * 2026-11-04):
 * - TRANSIENT: provider pressure / temporary outage — pause and auto-retry
 *   from the same phase.
 * - BILLING: every available provider is KNOWN to be out of balance — stop
 *   for the operator (top up / enable another provider); retrying is futile.
 * - CONFIG: no provider is configured with a usable key — a settings error
 *   for the operator, never a transient outage.
 * - FATAL: anything else (book/content problems) — fail loudly as before.
 *
 * BILLING is deliberately strict (Haris's audit rule): it requires that
 * every router attempt failed with a billing refusal AND every skipped
 * candidate carries the NO_BALANCE mark. Any cooldown / health / dead-model
 * / rate-limit skip means some provider's state is merely temporary, so the
 * verdict falls back to TRANSIENT instead of declaring a final billing stop.
 */
export function classifyBookReadFailure(message: unknown): BookReadFailureKind {
  const text = String(message || '').toLowerCase()
  if (!text.trim()) return 'FATAL'
  if (
    text.includes('text_ai_router_not_configured')
    || text.includes('not_configured')
    || text.includes('no api key')
    || text.includes('missing api key')
  ) return 'CONFIG'
  const skipMarker = '|| تخطّى:'
  const markerIndex = text.indexOf(skipMarker)
  const attemptsPart = (markerIndex >= 0 ? text.slice(0, markerIndex) : text).trim()
  const skipsPart = markerIndex >= 0 ? text.slice(markerIndex + skipMarker.length).trim() : ''
  const skipReasons = [...skipsPart.matchAll(/\(([^)]+)\)/g)].map((match) => match[1].trim().toUpperCase())
  const attempts = attemptsPart.split(' | ').map((attempt) => attempt.trim()).filter(Boolean)
  const bareRouterFailure = attempts.length === 1 && attempts[0] === 'text_ai_router_failed'
  if (!bareRouterFailure && attempts.length > 0 && attempts.every(isBillingAttemptText) && skipReasons.every((reason) => reason === 'NO_BALANCE')) return 'BILLING'
  if (bareRouterFailure && skipReasons.length > 0 && skipReasons.every((reason) => reason === 'NO_BALANCE')) return 'BILLING'
  // Any recorded skip that is not a no-balance mark proves a temporary or
  // unknown provider state was in play (cooldown, health, dead model, rate
  // gate, no models) — the failure is pausing, never a final billing stop.
  if (skipReasons.length > 0) return 'TRANSIENT'
  if (hasTransientTerm(text)) return 'TRANSIENT'
  return 'FATAL'
}

export function isTransientBookReadError(message: unknown): boolean {
  return classifyBookReadFailure(message) === 'TRANSIENT'
}

export function planBookReadJobResume(lastJob: { status?: string | null; phase?: string | null } | null | undefined, restart?: boolean): 'RESUME' | 'CREATE' {
  if (restart) return 'CREATE'
  if (lastJob?.status === 'FAILED' && ['EXTRACT', 'ANALYZE'].includes(String(lastJob.phase || ''))) return 'RESUME'
  return 'CREATE'
}

export function canRunBookReadJob(job: { status: string; retryAt: Date | null }, now: Date): boolean {
  return ['QUEUED', 'RUNNING', 'PAUSED'].includes(job.status) && (job.status !== 'PAUSED' || !job.retryAt || job.retryAt <= now)
}

export function bookReadLockWhere(id: string, now: Date) {
  return {
    id,
    status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
    OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    AND: [{ OR: [{ status: { not: 'PAUSED' } }, { retryAt: null }, { retryAt: { lte: now } }] }],
  }
}

export async function claimBookReadLock(db: { bookReadJob: { updateMany: (args: any) => Promise<{ count: number }> } }, id: string, now = new Date()): Promise<boolean> {
  const updated = await db.bookReadJob.updateMany({
    where: bookReadLockWhere(id, now),
    data: { lockedUntil: new Date(now.getTime() + BOOK_READ_LOCK_MS), status: 'RUNNING', startedAt: now },
  })
  return updated.count === 1
}
