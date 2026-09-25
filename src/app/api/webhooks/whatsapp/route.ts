import { NextRequest, NextResponse } from 'next/server'
import {
  createOfficialWhatsAppAgentReply,
  extractWhatsAppInboundMessages,
  officialWhatsAppConfigured,
  sendOfficialWhatsAppText,
  verifyWhatsAppSignature,
} from '@/lib/whatsapp-cloud'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const processedMessageIds = new Map<string, number>()
const PROCESSED_TTL_MS = 30 * 60 * 1000

function cleanupProcessedIds() {
  const now = Date.now()
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > PROCESSED_TTL_MS) processedMessageIds.delete(id)
  }
}

function alreadyProcessed(id: string) {
  cleanupProcessedIds()
  if (processedMessageIds.has(id)) return true
  processedMessageIds.set(id, Date.now())
  return false
}

// Meta webhook verification for WhatsApp Business Platform.
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge') || ''
  const expected = process.env.WHATSAPP_VERIFY_TOKEN || ''

  if (mode === 'subscribe' && expected && token === expected) {
    return new NextResponse(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  return NextResponse.json({ ok: false, error: 'Invalid WhatsApp webhook verification token' }, { status: 403 })
}

// Incoming official WhatsApp messages. This reuses the same public platform agent
// that powers the floating WhatsApp widget, then sends the answer back through
// WhatsApp Cloud API.
export async function POST(req: NextRequest) {
  const rawBody = await req.text()

  if (!verifyWhatsAppSignature(rawBody, req.headers.get('x-hub-signature-256'))) {
    return NextResponse.json({ ok: false, error: 'Invalid WhatsApp webhook signature' }, { status: 401 })
  }

  let payload: any = {}
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  // Always acknowledge non-message webhooks such as status updates.
  const messages = extractWhatsAppInboundMessages(payload)
  if (!messages.length) {
    return NextResponse.json({ ok: true, received: 0, sent: 0, configured: officialWhatsAppConfigured() })
  }

  if (!officialWhatsAppConfigured()) {
    console.warn('Official WhatsApp webhook received messages, but Cloud API env vars are missing')
    return NextResponse.json({ ok: true, received: messages.length, sent: 0, configured: false })
  }

  let sent = 0
  const errors: string[] = []

  for (const message of messages) {
    if (alreadyProcessed(message.id)) continue
    try {
      const reply = await createOfficialWhatsAppAgentReply(message)
      await sendOfficialWhatsAppText(message.from, reply, {
        phoneNumberId: message.phoneNumberId,
        replyToMessageId: message.id,
      })
      sent += 1
    } catch (error: any) {
      const msg = String(error?.message || error || 'unknown WhatsApp webhook error').slice(0, 500)
      console.error('official WhatsApp agent reply failed:', msg)
      errors.push(msg)
    }
  }

  return NextResponse.json({ ok: true, received: messages.length, sent, errors: errors.slice(0, 3), configured: true })
}
