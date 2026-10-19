export const BOOK_READ_LOCK_MS = 270_000 // 240s work budget + 30s grace; below 300s maxDuration
export const BOOK_READ_RETRY_MS = 5 * 60_000
export const BOOK_READ_TRANSIENT_RETRY_MS = 60_000

export function isTransientBookReadError(message: unknown): boolean {
  const text = String(message || '').toLowerCase()
  return [
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
  ].some((term) => text.includes(term))
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
