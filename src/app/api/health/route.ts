import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type TimedResult = {
  ok: boolean
  ms: number
  error?: string
}

function boolEnv(names: string[]) {
  return names.some((name) => Boolean(process.env[name]?.trim()))
}

function appVersion() {
  return {
    commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_COMMIT_SHA || 'local',
    branch: process.env.VERCEL_GIT_COMMIT_REF || process.env.NEXT_PUBLIC_GIT_BRANCH || 'unknown',
    env: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
  }
}

function serviceConfigurationStatus() {
  return {
    database: boolEnv(['DATABASE_URL', 'DATABASE_POSTGRES_PRISMA_URL', 'POSTGRES_PRISMA_URL', 'DATABASE_POSTGRES_URL', 'POSTGRES_URL']),
    resend: boolEnv(['RESEND_API_KEY']),
    storage: boolEnv(['AACT_S3_ENDPOINT', 'AACT_S3_BUCKET', 'AACT_S3_ACCESS_KEY_ID', 'AACT_S3_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'S3_BUCKET', 'AWS_S3_BUCKET']),
    stripe: boolEnv(['STRIPE_SECRET_KEY']),
    paypal: boolEnv(['PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'PAYPAL_CLIENT_SECRET']),
    usdt: boolEnv(['USDT_WALLET_ADDRESS', 'NEXT_PUBLIC_USDT_WALLET_ADDRESS']),
    tronGrid: boolEnv(['TRONGRID_API_KEY', 'TRON_GRID_API_KEY']),
    vcSigning: boolEnv(['AACT_VC_SIGNING_SECRET']),
  }
}

async function timed(name: string, fn: () => Promise<unknown>): Promise<TimedResult> {
  const startedAt = Date.now()
  try {
    await fn()
    return { ok: true, ms: Date.now() - startedAt }
  } catch (error: any) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      error: error?.message || `${name} check failed`,
    }
  }
}

async function databaseCheck() {
  return timed('database', async () => {
    const { db } = await import('@/lib/db')
    await db.$queryRaw`SELECT 1`
  })
}

export async function GET() {
  const startedAt = Date.now()

  try {
    const database = await databaseCheck()
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
        kind: 'deep-health',
        timestamp: new Date().toISOString(),
        responseMs: Date.now() - startedAt,
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
  } catch (error: any) {
    return NextResponse.json(
      {
        ok: false,
        status: 'degraded',
        kind: 'deep-health',
        timestamp: new Date().toISOString(),
        responseMs: Date.now() - startedAt,
        version: appVersion(),
        configured: serviceConfigurationStatus(),
        checks: {
          route: {
            ok: false,
            error: error?.message || 'Health route failed before checks completed',
          },
        },
      },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      }
    )
  }
}
