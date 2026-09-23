import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appVersion, serviceConfigurationStatus, timed } from '@/lib/monitoring'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const startedAt = Date.now()
  const dbCheck = await timed('database', async () => {
    await db.$queryRaw`SELECT 1`
    return true
  })

  const status = dbCheck.ok ? 'ok' : 'degraded'
  const body = {
    status,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    responseMs: Date.now() - startedAt,
    version: appVersion(),
    checks: {
      database: {
        ok: dbCheck.ok,
        ms: dbCheck.ms,
      },
    },
    configured: serviceConfigurationStatus(),
  }

  return NextResponse.json(body, {
    status: dbCheck.ok ? 200 : 503,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  })
}
