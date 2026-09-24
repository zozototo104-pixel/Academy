import { NextRequest, NextResponse } from 'next/server'
import { ACADEMY_INFO } from '@/lib/academyData'
import { platformPublicAgentComplete } from '@/lib/platform-agent'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const globalState = globalThis as unknown as { __aactWhatsappSeen?: Map<string, number> }
const seen = globalState.__aactWhatsappSeen || new Map<string, number>()
globalState.__aactWhatsappSeen = seen

function cleanupSeen() {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000
  for (const [id, ts] of seen.entries()) if (ts < cutoff) seen.delete(id)
}

function json(status: number, payload: any) {
  return NextResponse.json(payload, { status, headers: { 'Cache-Control': 'no-store' } })
}

function whatsappEnv() {
  return {
    token: process.env.WHATSAPP_ACCESS_TOKEN?.trim() || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN?.trim() || '',
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION?.trim() || 'v21.0',
    enabled: (process.env.WHATSAPP_AI_ENABLED || '1').trim() !== '0',
  }
}

async function sendWhatsAppText(to: string, body: string) {
  const env = whatsappEnv()
  if (!env.token || !env.phoneNumberId) throw new Error('WHATSAPP_CLOUD_API_NOT_CONFIGURED')
  const endpoint = `https://graph.facebook.com/${env.graphVersion}/${env.phoneNumberId}/messages`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: body.slice(0, 3900) },
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`WHATSAPP_SEND_FAILED_${res.status}: ${text.slice(0, 500)}`)
  }
  return res.json().catch(() => ({}))
}

async function markMessageRead(messageId: string) {
  const env = whatsappEnv()
  if (!env.token || !env.phoneNumberId || !messageId) return
  await fetch(`https://graph.facebook.com/${env.graphVersion}/${env.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  }).catch(() => {})
}

function extractTextMessages(payload: any) {
  const messages: Array<{ from: string; id: string; text: string; name?: string }> = []
  const entries = Array.isArray(payload?.entry) ? payload.entry : []
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : []
    for (const change of changes) {
      const value = change?.value
      const contacts = Array.isArray(value?.contacts) ? value.contacts : []
      const nameByWaId = new Map<string, string>()
      for (const c of contacts) if (c?.wa_id) nameByWaId.set(String(c.wa_id), String(c?.profile?.name || ''))
      const rawMessages = Array.isArray(value?.messages) ? value.messages : []
      for (const m of rawMessages) {
        const from = String(m?.from || '').trim()
        const id = String(m?.id || '').trim()
        const text = String(m?.text?.body || '').trim()
        if (from && id && text) messages.push({ from, id, text, name: nameByWaId.get(from) })
      }
    }
  }
  return messages
}

export async function GET(req: NextRequest) {
  const env = whatsappEnv()
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  if (mode === 'subscribe' && token && env.verifyToken && token === env.verifyToken) {
    return new NextResponse(challenge || '', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }
  return new NextResponse('Forbidden', { status: 403 })
}

export async function POST(req: NextRequest) {
  try {
    const env = whatsappEnv()
    if (!env.enabled) return json(200, { ok: true, ignored: 'disabled' })
    const payload = await req.json().catch(() => ({}))
    const messages = extractTextMessages(payload)
    if (!messages.length) return json(200, { ok: true, ignored: 'no_text_messages' })

    cleanupSeen()
    const processed: any[] = []
    for (const msg of messages.slice(0, 3)) {
      if (seen.has(msg.id)) {
        processed.push({ id: msg.id, duplicate: true })
        continue
      }
      seen.set(msg.id, Date.now())
      await markMessageRead(msg.id)

      const result = await platformPublicAgentComplete({
        channel: 'WHATSAPP',
        messages: [{ role: 'user', content: msg.text }],
        uiContext: [
          `المرسل عبر واتساب: ${msg.name || msg.from}.`,
          `رقم الأكاديمية الرسمي المثبت في المنصة: ${ACADEMY_INFO.whatsappDisplay || ACADEMY_INFO.whatsapp}.`,
          'أجب بإيجاز مناسب لواتساب. عند الحاجة للقبول أو الدفع أو مستندات، وجّه المستخدم إلى المنصة أو الإدارة.',
        ].join('\n'),
      })
      await sendWhatsAppText(msg.from, result.reply)
      processed.push({ id: msg.id, from: msg.from, agent: result.agent, engine: result.engine })
    }

    return json(200, { ok: true, processed })
  } catch (e: any) {
    console.error('WhatsApp webhook error:', String(e?.message || e).slice(0, 800))
    // نرجع 200 حتى لا يعيد واتساب إرسال نفس الرسالة بلا نهاية؛ الخطأ يظهر في اللوجات.
    return json(200, { ok: false, error: 'WHATSAPP_WEBHOOK_PROCESSING_FAILED' })
  }
}
