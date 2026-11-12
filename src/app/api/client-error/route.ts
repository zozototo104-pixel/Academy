import { NextRequest, NextResponse } from 'next/server'
import { clientIpFromHeaders, enforceApiRateLimit } from '@/lib/rate-limit'

// Receives a client-side error report from the app error boundary
// (src/app/error.tsx). The browser console alone never reaches the server,
// so without this endpoint the real error behind a crash screen — such as
// the one after the admin email-change dialog — stays invisible forever.
// Logging only: no database write and no user data beyond the error
// itself. Payloads are capped so the endpoint cannot flood server logs.
const MAX_TEXT = 4000

function capped(value: unknown): string {
  const text = typeof value === 'string' ? value : ''
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text
}

// Client errors may carry login/verification tokens in URL query strings or
// embedded stack URLs. Preserve the path for diagnosis, never credentials.
function safePageUrl(value: unknown): string {
  try {
    const url = new URL(capped(value))
    return ['https:', 'http:'].includes(url.protocol)
      ? capped(url.origin + url.pathname) : ''
  } catch {
    return ''
  }
}

function safeDiagnostic(value: unknown): string {
  return capped(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, (part) => safePageUrl(part) || '[redacted-url]')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~-]{8,}/gi, '$1[redacted]')
    .replace(/([?&](?:token|access_token|id_token|code|key|password|secret|state|session)=)[^&#\s]+/gi, '$1[redacted]')
}

export async function POST(req: NextRequest) {
  // Best-effort per-IP limiter: keeps an anonymous crash-report endpoint
  // from becoming a high-volume log sink without requiring a student login.
  const limited = enforceApiRateLimit(req, 'client-error-report', 20, 60_000, clientIpFromHeaders(req.headers))
  if (limited) return limited
  if (Number(req.headers.get('content-length') || 0) > 20_000) {
    return NextResponse.json({ ok: false, error: 'تقرير الخطأ أكبر من المسموح' }, { status: 413 })
  }
  let body: any = null
  try {
    const raw = await req.text()
    if (raw.length > 20_000) {
      return NextResponse.json({ ok: false, error: 'تقرير الخطأ أكبر من المسموح' }, { status: 413 })
    }
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ ok: false, error: 'طلب غير صالح' }, { status: 400 })
  }
  const message = safeDiagnostic(body?.message)
  if (!message) {
    return NextResponse.json({ ok: false, error: 'لا توجد رسالة خطأ' }, { status: 400 })
  }
  console.error(
    'AACT client error report:',
    JSON.stringify({
      message,
      stack: safeDiagnostic(body?.stack),
      digest: safeDiagnostic(body?.digest),
      url: safePageUrl(body?.url),
      userAgent: safeDiagnostic(body?.userAgent),
      at: new Date().toISOString(),
    }),
  )
  return NextResponse.json({ ok: true })
}
