import { NextRequest, NextResponse } from 'next/server'

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

export async function POST(req: NextRequest) {
  let body: any = null
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'طلب غير صالح' }, { status: 400 })
  }
  const message = capped(body?.message)
  if (!message) {
    return NextResponse.json({ ok: false, error: 'لا توجد رسالة خطأ' }, { status: 400 })
  }
  console.error(
    'AACT client error report:',
    JSON.stringify({
      message,
      stack: capped(body?.stack),
      digest: capped(body?.digest),
      url: capped(body?.url),
      userAgent: capped(body?.userAgent),
      at: new Date().toISOString(),
    }),
  )
  return NextResponse.json({ ok: true })
}
