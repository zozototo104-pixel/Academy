import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

function configuredServices() {
  return {
    database: boolEnv(['DATABASE_URL', 'DATABASE_POSTGRES_PRISMA_URL', 'POSTGRES_PRISMA_URL', 'DATABASE_POSTGRES_URL', 'POSTGRES_URL']),
    resend: boolEnv(['RESEND_API_KEY']),
    storage: boolEnv(['AACT_S3_ENDPOINT', 'AACT_S3_BUCKET', 'AACT_S3_ACCESS_KEY_ID', 'AACT_S3_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'S3_BUCKET', 'AWS_S3_BUCKET']),
    stripe: boolEnv(['STRIPE_SECRET_KEY']),
    paypal: boolEnv(['PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'PAYPAL_CLIENT_SECRET']),
    usdt: boolEnv(['USDT_WALLET_ADDRESS', 'NEXT_PUBLIC_USDT_WALLET_ADDRESS']),
    vcSigning: boolEnv(['AACT_VC_SIGNING_SECRET']),
  }
}

export async function GET() {
  return NextResponse.json(
    {
      ok: true,
      status: 'ok',
      kind: 'liveness',
      message: 'Application route is deployed and responding.',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      version: appVersion(),
      configured: configuredServices(),
      readiness: '/api/ready',
    },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  )
}
