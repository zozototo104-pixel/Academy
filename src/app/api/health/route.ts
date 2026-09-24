import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { appVersion, serviceConfigurationStatus, timed } from '@/lib/monitoring'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const database = await timed('database', async () => {
    await db.$queryRaw`SELECT 1`
    return true
  })

  const configured = serviceConfigurationStatus()
  const required = {
    database: configured.database,
    vcSigning: configured.vcSigning,
  }
  const missingRequired = Object.entries(required)
    .filter(([, ok]) => !ok)
    .map(([name]) => name)

  const ok = database.ok && missingRequired.length === 0

  return NextResponse.json(
    {
      ok,
      status: ok ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      version: appVersion(),
      configured,
      checks: {
        database: {
          ok: database.ok,
          ms: database.ms,
          error: database.ok ? undefined : database.error,
        },
        requiredEnv: {
          ok: missingRequired.length === 0,
          missing: missingRequired,
        },
      },
    },
    {
      status: ok ? 200 : 503,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  )
}
