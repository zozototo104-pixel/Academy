import { NextRequest, NextResponse } from 'next/server'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { ratingForWebVital, safePath } from '@/lib/monitoring'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED = new Set(['CLS', 'FCP', 'FID', 'INP', 'LCP', 'TTFB'])

function num(value: unknown, max = 60_000) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(max, n))
}

async function persistWebVital(metric: {
  name: string
  value: number
  rating: string
  path: string
  nav: string
  id: string
}) {
  // Web Vitals are telemetry, not core product traffic. By default we avoid
  // writing every browser metric to Postgres because high-volume test runs can
  // create Prisma connection noise in serverless logs. Enable persistence only
  // when explicitly needed.
  if (process.env.WEB_VITALS_PERSIST !== '1') return false
  if (metric.rating === 'good' && process.env.WEB_VITALS_PERSIST_GOOD !== '1') return false

  try {
    const { db } = await import('@/lib/db')
    await db.auditLog.create({
      data: {
        actorName: 'Web Vitals',
        action: 'WEB_VITAL',
        entity: 'PerformanceMetric',
        entityId: metric.id || undefined,
        details: `name=${metric.name} | value=${metric.value} | rating=${metric.rating} | path=${metric.path} | nav=${metric.nav}`,
      },
    })
    return true
  } catch (error: any) {
    console.warn('web vitals persistence skipped:', error?.message || String(error))
    return false
  }
}

export async function POST(req: NextRequest) {
  try {
    const limited = enforceApiRateLimit(req, 'web-vitals', 80, 5 * 60 * 1000)
    if (limited) return limited

    const payload = await req.json().catch(() => ({}))
    const name = String(payload.name || '').toUpperCase().slice(0, 12)
    const value = num(payload.value)
    if (!ALLOWED.has(name) || value === null) {
      return NextResponse.json({ error: 'Invalid metric' }, { status: 400 })
    }

    const path = safePath(payload.path || payload.url || '/')
    const rating = String(payload.rating || ratingForWebVital(name, value)).slice(0, 40)
    const nav = String(payload.navigationType || '').slice(0, 60)
    const id = String(payload.id || '').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 80)

    const persisted = await persistWebVital({ name, value, rating, path, nav, id })

    return NextResponse.json(
      { ok: true, persisted },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (e: any) {
    console.warn('web vitals ingestion skipped:', e?.message || String(e))
    return NextResponse.json(
      { ok: true, skipped: true },
      { headers: { 'Cache-Control': 'no-store' } }
    )
  }
}
