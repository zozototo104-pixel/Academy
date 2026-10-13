import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ ok: false, error: 'WhatsApp retry cron was removed' }, { status: 410 })
}
