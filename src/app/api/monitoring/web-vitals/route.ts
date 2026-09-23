import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
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

    await db.auditLog.create({
      data: {
        actorName: 'Web Vitals',
        action: 'WEB_VITAL',
        entity: 'PerformanceMetric',
        entityId: id || undefined,
        details: `name=${name} | value=${value} | rating=${rating} | path=${path} | nav=${nav}`,
      },
    })

    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('web vitals ingestion error:', e)
    return NextResponse.json({ error: 'Failed to record metric' }, { status: 500 })
  }
}
