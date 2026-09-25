import crypto from 'crypto'
import { ACADEMY_INFO } from '@/lib/academyData'
import { platformPublicAgentComplete } from '@/lib/platform-agent'

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
  const phoneNumberId = trim(process.env.WHATSAPP_PHONE_NUMBER_ID) || trim(fallbackPhoneNumberId)
  if (!accessToken || !phoneNumberId) return null
  return {
    accessToken,
    phoneNumberId,
    graphVersion: trim(process.env.WHATSAPP_GRAPH_VERSION) || 'v22.0',
  }
}

export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null, appSecret = process.env.WHATSAPP_APP_SECRET) {
  const secret = trim(appSecret)
  if (!secret) return true
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

export async function createOfficialWhatsAppAgentReply(message: WhatsAppInboundMessage) {
  if (!message.text) {
    return 'أهلاً بك في الأكاديمية الأمريكية للاستشارات والتدريب. حالياً أستطيع قراءة الرسائل النصية فقط. اكتب سؤالك نصاً عن البرامج، الرسوم، التسجيل، الشهادات، أو الاعتماد وسأجيبك فوراً.'
  }

  const result = await platformPublicAgentComplete({
    messages: [{ role: 'user', content: message.text.slice(0, 1200) }],
    channel: 'WHATSAPP',
    uiContext: [
      'المستخدم يتواصل عبر واتساب الرسمي للأكاديمية، وليس عبر نافذة الموقع.',
      `اسم جهة الاتصال إن وجد: ${message.name || 'غير متاح'}.`,
      `رقم واتساب الرسمي للإدارة: ${ACADEMY_INFO.whatsappDisplay}.`,
      'أجب بإيجاز ووضوح، وادعُ المستخدم لإرسال اسمه وبرنامجه المطلوب إذا كان يريد متابعة التسجيل.',
    ].join(' '),
  })

  return result.reply || 'أهلاً بك، كيف يمكنني مساعدتك في برامج الأكاديمية؟'
}

export async function sendOfficialWhatsAppText(to: string, text: string, options?: { phoneNumberId?: string; replyToMessageId?: string }) {
  const config = getWhatsAppCloudConfig(options?.phoneNumberId)
  if (!config) {
    throw new Error('WhatsApp Cloud API is not configured. Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.')
  }

  const body: any = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: {
      preview_url: false,
      body: text.slice(0, 4096),
    },
  }

  if (options?.replyToMessageId) {
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

  return data
}
