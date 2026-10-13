import { NextRequest, NextResponse } from 'next/server'
import { processStaleWhatsAppInboundEvents } from '@/app/api/webhooks/whatsapp/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function cronAuthorized(req: NextRequest) {
  const expected = process.env.CRON_SECRET || process.env.VERCEL_CRON_SECRET || ''
  if (!expected) return true
  const header = req.headers.get('authorization') || ''
  return header === `Bearer ${expected}`
}

export async function GET(req: NextRequest) {
  if (!cronAuthorized(req)) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  const result = await processStaleWhatsAppInboundEvents(20)
  return NextResponse.json({ ok: true, ...result })
}
