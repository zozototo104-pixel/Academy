import crypto from 'crypto'
import { ACADEMY_INFO } from '@/lib/academyData'
import { db } from '@/lib/db'
import { platformPublicAgentComplete } from '@/lib/platform-agent'
import { hashWhatsAppId } from '@/lib/whatsapp-conversations'

type WhatsAppConfig = {
  accessToken: string
  phoneNumberId: string
  graphVersion: string
}

export type WhatsAppInboundMessage = {
  id: string
  from: string
  text: string
  name?: string
  phoneNumberId?: string
  rawType?: string
  mediaId?: string
  mediaMimeType?: string
  mediaSha256?: string
  mediaFileSize?: number
  isVoice?: boolean
  originKind?: 'TEXT' | 'VOICE'
}

function trim(value: unknown) {
  return String(value || '').trim()
}

function compactText(value: unknown, max = 1200) {
  return trim(value).replace(/\s+/g, ' ').slice(0, max)
}

export function officialWhatsAppConfigured() {
  return Boolean(
    process.env.WHATSAPP_ACCESS_TOKEN?.trim() &&
    process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() &&
    process.env.WHATSAPP_VERIFY_TOKEN?.trim()
  )
}

export function getWhatsAppCloudConfig(fallbackPhoneNumberId?: string): WhatsAppConfig | null {
  const accessToken = trim(process.env.WHATSAPP_ACCESS_TOKEN)
  const inboundPhoneNumberId = trim(fallbackPhoneNumberId)
  const phoneNumberId = inboundPhoneNumberId || trim(process.env.WHATSAPP_PHONE_NUMBER_ID)
  if (!accessToken || !phoneNumberId) return null
  return {
    accessToken,
    phoneNumberId,
    graphVersion: trim(process.env.WHATSAPP_GRAPH_VERSION) || 'v22.0',
  }
}

export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null, appSecret = process.env.WHATSAPP_APP_SECRET) {
  const secret = trim(appSecret)
  if (!secret) return process.env.NODE_ENV !== 'production'
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  try {
    const provided = Buffer.from(signatureHeader.replace(/^sha256=/, ''), 'hex')
    const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex')
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
  } catch {
    return false
  }
}

function textFromWhatsAppMessage(message: any) {
  if (message?.type === 'text') return compactText(message?.text?.body)
  if (message?.type === 'button') return compactText(message?.button?.text || message?.button?.payload)
  if (message?.type === 'interactive') {
    return compactText(
      message?.interactive?.button_reply?.title ||
      message?.interactive?.button_reply?.id ||
      message?.interactive?.list_reply?.title ||
      message?.interactive?.list_reply?.id
    )
  }
  return ''
}

function mediaFromWhatsAppMessage(message: any) {
  if (message?.type !== 'audio') return {}
  const audio = message?.audio || {}
  return {
    mediaId: trim(audio?.id),
    mediaMimeType: trim(audio?.mime_type),
    mediaSha256: trim(audio?.sha256),
    isVoice: Boolean(audio?.voice),
  }
}

export function extractWhatsAppInboundMessages(payload: any): WhatsAppInboundMessage[] {
  const inbound: WhatsAppInboundMessage[] = []
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {}
      const contacts = Array.isArray(value?.contacts) ? value.contacts : []
      const phoneNumberId = trim(value?.metadata?.phone_number_id)
      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        const from = trim(message?.from)
        const id = trim(message?.id)
        if (!from || !id) continue
        const contact = contacts.find((c: any) => trim(c?.wa_id) === from) || contacts[0]
        const text = textFromWhatsAppMessage(message)
        inbound.push({
          id,
          from,
          text,
          name: compactText(contact?.profile?.name, 120),
          phoneNumberId,
          rawType: trim(message?.type) || 'unknown',
        })
      }
    }
  }
  return inbound
}

async function recentWhatsAppAgentMessages(message: WhatsAppInboundMessage) {
  const waIdHash = hashWhatsAppId(message.from)
  const conversation = await db.whatsAppConversation.findUnique({
    where: { waIdHash },
    select: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { direction: true, sender: true, text: true, whatsappMessageId: true },
      },
    },
  }).catch(() => null)
  const history = (conversation?.messages || [])
    .reverse()
    .filter((m) => String(m.text || '').trim())
    .map((m) => ({
      role: m.direction === 'INBOUND' ? 'user' : 'assistant',
      content: String(m.text || '').slice(0, 1200),
    }))
  const currentText = message.text.slice(0, 1200)
  const hasCurrent = history.some((m) => m.role === 'user' && m.content === currentText)
  if (!hasCurrent) history.push({ role: 'user', content: currentText })
  return history.slice(-12)
}

export async function createOfficialWhatsAppAgentReply(message: WhatsAppInboundMessage) {
  if (!message.text) {
    return 'أهلاً بك في الأكاديمية الأمريكية للاستشارات والتدريب. حالياً أستطيع قراءة الرسائل النصية فقط. اكتب سؤالك نصاً عن البرامج، الرسوم، التسجيل، الشهادات، أو الاعتماد وسأجيبك فوراً.'
  }

  const messages = await recentWhatsAppAgentMessages(message)
  const result = await platformPublicAgentComplete({
    messages,
    channel: 'WHATSAPP',
    uiContext: [
      'المستخدم يتواصل عبر واتساب الرسمي للأكاديمية، وليس عبر نافذة الموقع.',
      `اسم جهة الاتصال إن وجد: ${message.name || 'غير متاح'}.`,
      `رقم واتساب الرسمي للإدارة: ${ACADEMY_INFO.whatsappDisplay}.`,
      'لا تكرر الترحيب بالاسم في كل رد؛ يكفي في بداية المحادثة أو بعد انقطاع واضح. إذا كانت الرسالة مجاملة قصيرة فأجب باختصار. إذا كان السؤال عن الأكاديمية أو البرامج أو الرسوم أو التسجيل فأعطِ تفصيلاً مفيداً حسب السؤال.',
      'إذا كانت الرسالة عن شركة تدريب أو تعاون أو شراكة أو وكالة أو اعتماد، عالجها كطلب تعاون مؤسسي واجمع معلومات الجهة وهدف التعاون؛ لا تعرض تحويل موظف إلا إذا طلب المستخدم ذلك صراحة.',
    ].join(' '),
  })

  return result.reply || 'أهلاً بك، كيف يمكنني مساعدتك في برامج الأكاديمية؟'
}

export function buildOfficialWhatsAppImmediateGreeting(message: WhatsAppInboundMessage) {
  const name = compactText(message.name, 60)
  const displayName = name || 'ضيفنا الكريم'
  return `أهلاً وسهلاً بك ${displayName} في الأكاديمية الأمريكية للاستشارات والتدريب.\nأنا هنا لمساعدتك في أي شيء يخص المنصة التعليمية AACT، وسأجهز لك الرد المناسب الآن.`
}

async function sendOfficialWhatsAppMessageStatus(message: WhatsAppInboundMessage, includeTyping: boolean) {
  const config = getWhatsAppCloudConfig(message.phoneNumberId)
  if (!config) {
    throw new Error('WhatsApp Cloud API is not configured. Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.')
  }

  const body: any = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: message.id,
  }
  if (includeTyping) body.typing_indicator = { type: 'text' }

  const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const errorMessage = data?.error?.message || data?.error?.code || `WhatsApp message status failed with status ${response.status}`
    throw new Error(String(errorMessage).slice(0, 500))
  }

  return data
}

export async function sendOfficialWhatsAppReadReceipt(message: WhatsAppInboundMessage) {
  return sendOfficialWhatsAppMessageStatus(message, false)
}

export async function sendOfficialWhatsAppTypingIndicator(message: WhatsAppInboundMessage) {
  return sendOfficialWhatsAppMessageStatus(message, true)
}

export function splitOfficialWhatsAppText(text: string, maxLength = 3600): string[] {
  const raw = String(text || '').trim()
  if (!raw) return []
  if (raw.length <= maxLength) return [raw]
  const chunks: string[] = []
  let rest = raw
  while (rest.length > maxLength && chunks.length < 5) {
    const windowText = rest.slice(0, maxLength)
    const splitAt = Math.max(
      windowText.lastIndexOf('\n\n'),
      windowText.lastIndexOf('\n'),
      windowText.lastIndexOf('. '),
      windowText.lastIndexOf('، '),
      windowText.lastIndexOf(' ')
    )
    const cut = splitAt > 1200 ? splitAt : maxLength
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest.slice(0, maxLength).trim())
  return chunks.filter(Boolean)
}

export async function sendOfficialWhatsAppText(to: string, text: string, options?: { phoneNumberId?: string; replyToMessageId?: string }) {
  const config = getWhatsAppCloudConfig(options?.phoneNumberId)
  if (!config) {
    throw new Error('WhatsApp Cloud API is not configured. Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.')
  }

  const chunks = splitOfficialWhatsAppText(text)
  if (!chunks.length) throw new Error('WhatsApp text is empty.')
  const sentMessages: any[] = []
  let lastData: any = null

  for (let i = 0; i < chunks.length; i += 1) {
    const body: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body: chunks[i],
      },
    }

    if (i === 0 && options?.replyToMessageId) {
      body.context = { message_id: options.replyToMessageId }
    }

    const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = data?.error?.message || data?.error?.code || `WhatsApp send failed with status ${response.status}`
      throw new Error(String(message).slice(0, 500))
    }
    lastData = data
    if (Array.isArray(data?.messages)) sentMessages.push(...data.messages)
  }

  return { ...(lastData || {}), messages: sentMessages.length ? sentMessages : lastData?.messages }
}
