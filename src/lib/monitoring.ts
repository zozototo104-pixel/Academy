import { performance } from 'perf_hooks'

export function appVersion() {
  return {
    commit: process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_COMMIT_SHA || 'local',
    branch: process.env.VERCEL_GIT_COMMIT_REF || process.env.NEXT_PUBLIC_GIT_BRANCH || 'unknown',
    env: process.env.VERCEL_ENV || process.env.NODE_ENV || 'unknown',
  }
}

export function boolEnv(names: string[]) {
  return names.some((name) => !!process.env[name]?.trim())
}

export function serviceConfigurationStatus() {
  return {
    database: boolEnv(['DATABASE_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL', 'DATABASE_POSTGRES_URL']),
    resend: boolEnv(['RESEND_API_KEY']),
    storage: boolEnv(['AACT_S3_ENDPOINT', 'AACT_S3_BUCKET', 'AACT_S3_ACCESS_KEY_ID', 'AACT_S3_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_BUCKET', 'S3_BUCKET', 'AWS_S3_BUCKET']),
    stripe: boolEnv(['STRIPE_SECRET_KEY']),
    paypal: boolEnv(['PAYPAL_CLIENT_ID', 'PAYPAL_SECRET', 'PAYPAL_CLIENT_SECRET']),
    usdt: boolEnv(['USDT_WALLET_ADDRESS', 'NEXT_PUBLIC_USDT_WALLET_ADDRESS']),
    tronGrid: boolEnv(['TRONGRID_API_KEY', 'TRON_GRID_API_KEY']),
    vcSigning: boolEnv(['AACT_VC_SIGNING_SECRET']),
  }
}

export async function timed<T>(name: string, fn: () => Promise<T>) {
  const start = performance.now()
  try {
    const result = await fn()
    return { name, ok: true as const, ms: Math.round(performance.now() - start), result }
  } catch (error: any) {
    return { name, ok: false as const, ms: Math.round(performance.now() - start), error: error?.message || String(error) }
  }
}

export function ratingForWebVital(name: string, value: number): 'good' | 'needs-improvement' | 'poor' | 'unknown' {
  // حدود تقريبية متوافقة مع Web Vitals العامة.
  if (!Number.isFinite(value)) return 'unknown'
  switch (name) {
    case 'CLS':
      return value <= 0.1 ? 'good' : value <= 0.25 ? 'needs-improvement' : 'poor'
    case 'LCP':
      return value <= 2500 ? 'good' : value <= 4000 ? 'needs-improvement' : 'poor'
    case 'INP':
      return value <= 200 ? 'good' : value <= 500 ? 'needs-improvement' : 'poor'
    case 'FID':
      return value <= 100 ? 'good' : value <= 300 ? 'needs-improvement' : 'poor'
    case 'TTFB':
      return value <= 800 ? 'good' : value <= 1800 ? 'needs-improvement' : 'poor'
    case 'FCP':
      return value <= 1800 ? 'good' : value <= 3000 ? 'needs-improvement' : 'poor'
    default:
      return 'unknown'
  }
}

export function safePath(value: unknown) {
  const raw = String(value || '')
  if (!raw) return '/'
  try {
    const url = raw.startsWith('http') ? new URL(raw) : new URL(raw, 'https://local.invalid')
    return `${url.pathname}${url.search}`.slice(0, 300)
  } catch {
    return raw.replace(/[^a-zA-Z0-9/_?=&.-]/g, '').slice(0, 300) || '/'
  }
}
