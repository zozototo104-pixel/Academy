import { NextRequest, NextResponse } from 'next/server'

type Bucket = {
  count: number
  resetAt: number
}

type RateLimitResult = {
  ok: boolean
  remaining: number
  resetAt: number
  retryAfterSec: number
}

const globalStore = globalThis as unknown as { __aactRateLimit?: Map<string, Bucket> }
const store = globalStore.__aactRateLimit || new Map<string, Bucket>()
globalStore.__aactRateLimit = store

function nowMs() {
  return Date.now()
}

function cleanup(now = nowMs()) {
  // Keep memory bounded in long-running Node processes.
  if (store.size < 5000) return
  for (const [key, bucket] of store.entries()) {
    if (bucket.resetAt <= now) store.delete(key)
  }
}

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = nowMs()
  cleanup(now)
  const bucket = store.get(key)
  if (!bucket || bucket.resetAt <= now) {
    const resetAt = now + windowMs
    store.set(key, { count: 1, resetAt })
    return { ok: true, remaining: Math.max(0, limit - 1), resetAt, retryAfterSec: 0 }
  }

  if (bucket.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      resetAt: bucket.resetAt,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    }
  }

  bucket.count += 1
  store.set(key, bucket)
  return { ok: true, remaining: Math.max(0, limit - bucket.count), resetAt: bucket.resetAt, retryAfterSec: 0 }
}

export function rateLimitHeaders(result: RateLimitResult) {
  return {
    'X-RateLimit-Remaining': String(result.remaining),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
    ...(result.ok ? {} : { 'Retry-After': String(result.retryAfterSec) }),
  }
}

export function clientIpFromHeaders(headers: Headers) {
  const cf = headers.get('cf-connecting-ip')
  if (cf) return cf.trim()
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown'
  return headers.get('x-real-ip')?.trim() || 'unknown'
}

export function rateLimitJson(result: RateLimitResult) {
  return NextResponse.json(
    { error: 'طلبات كثيرة، انتظر قليلًا ثم حاول مرة أخرى.' },
    { status: 429, headers: rateLimitHeaders(result) }
  )
}

export function checkApiRateLimit(
  req: NextRequest,
  scope: string,
  limit: number,
  windowMs: number,
  subject?: string | null
) {
  const ip = clientIpFromHeaders(req.headers)
  const subjectKey = subject ? String(subject).trim().toLowerCase() : 'anonymous'
  const ipLimit = checkRateLimit(`${scope}:ip:${ip}`, limit * 3, windowMs)
  if (!ipLimit.ok) return ipLimit
  return checkRateLimit(`${scope}:subject:${subjectKey}`, limit, windowMs)
}

export function enforceApiRateLimit(
  req: NextRequest,
  scope: string,
  limit: number,
  windowMs: number,
  subject?: string | null
) {
  const result = checkApiRateLimit(req, scope, limit, windowMs, subject)
  return result.ok ? null : rateLimitJson(result)
}
