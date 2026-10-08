export const BOOK_READ_LOCK_MS = 270_000 // 240s work budget + 30s grace; below 300s maxDuration
export const BOOK_READ_RETRY_MS = 5 * 60_000

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
