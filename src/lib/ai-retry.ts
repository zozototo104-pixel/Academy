export function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | null {
  const raw = String(value || '').trim()
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(0, Math.floor(seconds * 1000))
  const dateMs = Date.parse(raw)
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - nowMs)
  return null
}

export function aiRetryDelayMs(attemptIndex: number, opts: { retryAfter?: string | null; deadlineMs?: number; nowMs?: number; jitterRatio?: number } = {}): number | null {
  const now = Number.isFinite(opts.nowMs || NaN) ? Number(opts.nowMs) : Date.now()
  const remaining = Number.isFinite(opts.deadlineMs || NaN) ? Number(opts.deadlineMs) - now : Infinity
  if (remaining <= 0) return null
  const base = [500, 1000, 2000][Math.max(0, Math.min(2, attemptIndex))] || 2000
  const jitterRatio = Math.max(0, Math.min(0.3, opts.jitterRatio ?? 0.3))
  const random = Math.random() * 2 - 1
  const jittered = Math.round(base * (1 + random * jitterRatio))
  const retryAfter = parseRetryAfterMs(opts.retryAfter, now)
  if (retryAfter != null && retryAfter >= remaining) return null
  const preferred = retryAfter != null ? retryAfter : jittered
  if (preferred >= remaining) return null
  return Math.max(0, Math.floor(preferred))
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
