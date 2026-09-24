import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type CheckResult = {
  ok: boolean
  ms?: number
  error?: string
}

function appVersion() {
  return {
    commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_COMMIT_SHA || 'local',
    branch: process.env.VERCEL_GIT_COMMIT_REF || process.env.NEXT_PUBLIC_GIT_BRANCH || 'unknown',
    env: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
  }
}

function boolEnv(names: string[]) {
  return names.some((name) => !!process.env[name]?.trim())
}

function requiredEnvCheck() {
  const groups = {
    database: ['DATABASE_URL', 'DATABASE_POSTGRES_PRISMA_URL', 'POSTGRES_PRISMA_URL', 'DATABASE_POSTGRES_URL', 'POSTGRES_URL'],
    nextAuth: ['NEXTAUTH_SECRET'],
    appUrl: ['NEXTAUTH_URL', 'NEXT_PUBLIC_APP_URL'],
    vcSigning: ['AACT_VC_SIGNING_SECRET'],
  }

  const details = Object.fromEntries(
    Object.entries(groups).map(([name, envs]) => [name, { ok: boolEnv(envs), accepted: envs }])
  ) as Record<string, { ok: boolean; accepted: string[] }>

  const missing = Object.entries(details).filter(([, value]) => !value.ok).map(([name]) => name)
  return { ok: missing.length === 0, missing, details }
}

async function databaseCheck(): Promise<CheckResult> {
  const startedAt = Date.now()
  try {
    const { db } = await import('@/lib/db')
    await db.$queryRaw`SELECT 1`
    return { ok: true, ms: Date.now() - startedAt }
  } catch (error: any) {
    return { ok: false, ms: Date.now() - startedAt, error: error?.message || String(error) }
  }
}

export async function GET() {
  const startedAt = Date.now()
  const env = requiredEnvCheck()
  const database = await databaseCheck()
  const ok = env.ok && database.ok

  return NextResponse.json(
    {
      ok,
      status: ok ? 'ready' : 'not_ready',
      kind: 'readiness',
      timestamp: new Date().toISOString(),
      responseMs: Date.now() - startedAt,
      version: appVersion(),
      checks: {
        requiredEnv: env,
        database,
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
