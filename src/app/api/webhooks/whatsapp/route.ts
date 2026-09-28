import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  buildOfficialWhatsAppImmediateGreeting,
  createOfficialWhatsAppAgentReply,
  extractWhatsAppInboundMessages,
  officialWhatsAppConfigured,
  sendOfficialWhatsAppText,
  sendOfficialWhatsAppTypingIndicator,
  verifyWhatsAppSignature,
} from '@/lib/whatsapp-cloud'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const processedMessageIds = new Map<string, number>()
const recentGreetingKeys = new Map<string, number>()
const PROCESSED_TTL_MS = 30 * 60 * 1000
const IMMEDIATE_GREETING_WINDOW_MS = 24 * 60 * 60 * 1000

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

function cleanupGreetingKeys() {
  const now = Date.now()
  for (const [key, ts] of recentGreetingKeys.entries()) {
    if (now - ts > IMMEDIATE_GREETING_WINDOW_MS) recentGreetingKeys.delete(key)
  }
}

function conversationKey(from: string) {
  return `wa:${createHash('sha256').update(String(from || '')).digest('hex').slice(0, 32)}`
}

async function shouldSendImmediateGreeting(from: string) {
  cleanupGreetingKeys()
  const key = conversationKey(from)
  const now = Date.now()
  const recent = recentGreetingKeys.get(key)
  if (recent && now - recent < IMMEDIATE_GREETING_WINDOW_MS) return { ok: false, key }

  const since = new Date(now - IMMEDIATE_GREETING_WINDOW_MS)
  const previous = await db.auditLog.findFirst({
    where: {
      action: 'WHATSAPP_IMMEDIATE_GREETING_SENT',
      entityId: key,
      createdAt: { gte: since },
    },
    select: { id: true },
  }).catch(() => null)

  if (previous) {
    recentGreetingKeys.set(key, now)
    return { ok: false, key }
  }

  recentGreetingKeys.set(key, now)
  return { ok: true, key }
}

async function markImmediateGreetingSent(key: string, from: string, messageId: string) {
  await auditWhatsAppWebhook('WHATSAPP_IMMEDIATE_GREETING_SENT', {
    from: maskPhone(from),
    messageId,
    windowHours: Math.round(IMMEDIATE_GREETING_WINDOW_MS / 60 / 60 / 1000),
  }, key)
}

function maskPhone(value?: string | null) {
  const raw = String(value || '').replace(/\D/g, '')
  if (!raw) return ''
  return raw.length <= 4 ? `****${raw}` : `${raw.slice(0, 3)}****${raw.slice(-4)}`
}

async function auditWhatsAppWebhook(action: string, details: Record<string, any>, entityId?: string | null) {
  try {
    await db.auditLog.create({
      data: {
        actorName: 'WhatsApp Webhook',
        action,
        entity: 'WhatsAppWebhook',
        entityId: entityId || null,
        details: JSON.stringify(details).slice(0, 3500),
      },
    })
  } catch (error) {
    console.warn('WhatsApp webhook audit failed:', String(error).slice(0, 300))
  }
}

// Meta webhook verification for WhatsApp Business Platform.
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge') || ''
  const expected = process.env.WHATSAPP_VERIFY_TOKEN || ''

  if (mode === 'subscribe' && expected && token === expected) {
    await auditWhatsAppWebhook('WHATSAPP_WEBHOOK_VERIFIED', { mode, hasExpectedToken: Boolean(expected), challengeLength: challenge.length })
    return new NextResponse(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  await auditWhatsAppWebhook('WHATSAPP_WEBHOOK_VERIFY_FAILED', { mode, hasExpectedToken: Boolean(expected), hasProvidedToken: Boolean(token) })
  return NextResponse.json({ ok: false, error: 'Invalid WhatsApp webhook verification token' }, { status: 403 })
}

// Incoming official WhatsApp messages. This reuses the same public platform agent
// that powers the floating WhatsApp widget, then sends the answer back through
// WhatsApp Cloud API.
export async function POST(req: NextRequest) {
  const rawBody = await req.text()

  if (!verifyWhatsAppSignature(rawBody, req.headers.get('x-hub-signature-256'))) {
    await auditWhatsAppWebhook('WHATSAPP_WEBHOOK_REJECTED', {
      reason: 'invalid_signature',
      hasSignature: Boolean(req.headers.get('x-hub-signature-256')),
      bodyBytes: rawBody.length,
    })
    return NextResponse.json({ ok: false, error: 'Invalid WhatsApp webhook signature' }, { status: 401 })
  }

  let payload: any = {}
  try {
    payload = rawBody ? JSON.parse(rawBody) : {}
  } catch {
    await auditWhatsAppWebhook('WHATSAPP_WEBHOOK_REJECTED', { reason: 'invalid_json', bodyBytes: rawBody.length })
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  // Always acknowledge non-message webhooks such as status updates.
  const messages = extractWhatsAppInboundMessages(payload)
  if (!messages.length) {
    await auditWhatsAppWebhook('WHATSAPP_WEBHOOK_RECEIVED', {
      received: 0,
      sent: 0,
      configured: officialWhatsAppConfigured(),
      note: 'no inbound messages; likely status update or verification event',
      object: payload?.object || null,
      entries: Array.isArray(payload?.entry) ? payload.entry.length : 0,
    })
    return NextResponse.json({ ok: true, received: 0, sent: 0, configured: officialWhatsAppConfigured() })
  }

  if (!officialWhatsAppConfigured()) {
    console.warn('Official WhatsApp webhook received messages, but Cloud API env vars are missing')
    await auditWhatsAppWebhook('WHATSAPP_WEBHOOK_RECEIVED', {
      received: messages.length,
      sent: 0,
      configured: false,
      reason: 'missing_cloud_api_environment',
      messages: messages.map((message) => ({ id: message.id, from: maskPhone(message.from), text: message.text.slice(0, 180) })),
    }, messages[0]?.id)
    return NextResponse.json({ ok: true, received: messages.length, sent: 0, configured: false })
  }

  let sent = 0
  let immediateGreetings = 0
  let typingIndicators = 0
  let skippedDuplicates = 0
  const errors: string[] = []

  for (const message of messages) {
    if (alreadyProcessed(message.id)) {
      skippedDuplicates += 1
      continue
    }
    try {
      const greetingDecision = await shouldSendImmediateGreeting(message.from)
      if (greetingDecision.ok) {
        try {
          await sendOfficialWhatsAppText(message.from, buildOfficialWhatsAppImmediateGreeting(message), {
            phoneNumberId: message.phoneNumberId,
            replyToMessageId: message.id,
          })
          await markImmediateGreetingSent(greetingDecision.key, message.from, message.id)
          immediateGreetings += 1
        } catch (greetingError: any) {
          const msg = `greeting: ${String(greetingError?.message || greetingError || 'failed').slice(0, 220)}`
          console.warn('official WhatsApp immediate greeting failed:', msg)
          errors.push(msg)
        }
      }

      try {
        await sendOfficialWhatsAppTypingIndicator(message)
        typingIndicators += 1
      } catch (typingError: any) {
        const msg = `typing: ${String(typingError?.message || typingError || 'failed').slice(0, 220)}`
        console.warn('official WhatsApp typing indicator failed:', msg)
        errors.push(msg)
      }

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

  await auditWhatsAppWebhook('WHATSAPP_WEBHOOK_RECEIVED', {
    received: messages.length,
    sent,
    immediateGreetings,
    typingIndicators,
    skippedDuplicates,
    configured: true,
    errors: errors.slice(0, 3),
    messages: messages.map((message) => ({ id: message.id, from: maskPhone(message.from), text: message.text.slice(0, 180), phoneNumberId: message.phoneNumberId || null })),
  }, messages[0]?.id)

  return NextResponse.json({ ok: true, received: messages.length, sent, immediateGreetings, typingIndicators, skippedDuplicates, errors: errors.slice(0, 3), configured: true })
}
