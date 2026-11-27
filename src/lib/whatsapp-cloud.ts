import crypto from 'crypto'
import { db } from '@/lib/db'
import { platformPublicAgentComplete } from '@/lib/platform-agent'
import { getOfficialContact } from '@/lib/settings'
import { wrapUntrustedUiContext } from '@/lib/untrusted-context'
import { hashWhatsAppId } from '@/lib/whatsapp-conversations'
import { unsignedWebhookTestsAllowed } from '@/lib/prod-safety'

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
  mediaCaption?: string
  mediaFilename?: string
  isVoice?: boolean
  transcriptionStatus?: 'TRANSCRIBED' | 'FAILED'
  originKind?: 'TEXT' | 'VOICE'
}

function trim(value: unknown) {
  return String(value || '').trim()
}

function compactText(value: unknown, max = 1200) {
  return trim(value).replace(/\s+/g, ' ').slice(0, max)
}

const WHATSAPP_CUSTOMER_CARE_WINDOW_MS = 24 * 60 * 60 * 1000
const PLATFORM_AI_UNAVAILABLE_MESSAGE = 'المساعد غير متاح حالياً، حاول بعد قليل'

async function assertWhatsAppFreeformWindowOpen(to: string) {
  const waIdHash = hashWhatsAppId(to)
  const conversation = await db.whatsAppConversation.findUnique({
    where: { waIdHash },
    select: { lastInboundAt: true },
  })
  const lastInboundAt = conversation?.lastInboundAt?.getTime() || 0
  if (!lastInboundAt || Date.now() - lastInboundAt > WHATSAPP_CUSTOMER_CARE_WINDOW_MS) {
    throw new Error('WHATSAPP_24H_WINDOW_CLOSED: free-form messages require a customer message within the last 24 hours; use an approved template message instead.')
  }
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
  if (!secret) return unsignedWebhookTestsAllowed()
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
  const type = trim(message?.type)
  if (!['audio', 'image', 'video', 'document', 'sticker'].includes(type)) return {}
  const media = message?.[type] || {}
  return {
    mediaId: trim(media?.id),
    mediaMimeType: trim(media?.mime_type),
    mediaSha256: trim(media?.sha256),
    mediaCaption: compactText(media?.caption, 1200),
    mediaFilename: compactText(media?.filename, 240),
    isVoice: type === 'audio' && Boolean(media?.voice),
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
        const media = mediaFromWhatsAppMessage(message)
        inbound.push({
          id,
          from,
          text,
          name: compactText(contact?.profile?.name, 120),
          phoneNumberId,
          rawType: trim(message?.type) || 'unknown',
          originKind: message?.type === 'audio' ? 'VOICE' : 'TEXT',
          ...media,
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

export async function createOfficialWhatsAppAgentReply(message: WhatsAppInboundMessage, extraContext?: string) {
  const modelMessage = message.text ? message : { ...message, text: '[رسالة واتساب غير نصية أو فارغة]' }
  const messages = await recentWhatsAppAgentMessages(modelMessage)
  const contact = await getOfficialContact().catch(() => ({} as any))
  const officialNumbers = Array.from(new Set([contact.whatsapp, ...(contact.whatsapps || []), contact.phone, ...(contact.phones || [])].map((v: unknown) => String(v || '').trim()).filter(Boolean))).join(' / ') || 'غير مضبوط في الإعدادات'
  const result = await platformPublicAgentComplete({
    messages,
    channel: 'WHATSAPP',
    uiContext: wrapUntrustedUiContext([
      'المستخدم يتواصل عبر واتساب الرسمي للأكاديمية، وليس عبر نافذة الموقع.',
      'قدّم نفسك فقط بصفتك الوكيل الذكي للأكاديمية؛ لا تبدأ بتعريف نفسك باسم النموذج التقني الذي ينفّذ المحادثة أو الشركة التي طوّرته. لا تغيّر جودة إجابتك عن الأسئلة الأكاديمية أو إجراءات التحويل للموظف.',
      `اسم جهة الاتصال إن وجد: ${message.name || 'غير متاح'}.`,
      `رقم واتساب الرسمي للإدارة من الإعدادات: ${officialNumbers}.`,
      'لا تكرر الترحيب بالاسم في كل رد؛ يكفي في بداية المحادثة أو بعد انقطاع واضح. إذا كانت الرسالة مجاملة قصيرة فأجب باختصار. إذا كان السؤال عن الأكاديمية أو البرامج أو الرسوم أو التسجيل فأعطِ تفصيلاً مفيداً حسب السؤال.',
      'إذا كانت الرسالة عن شركة تدريب أو تعاون أو شراكة أو وكالة أو اعتماد، عالجها كطلب تعاون مؤسسي واجمع معلومات الجهة وهدف التعاون؛ لا تعرض تحويل موظف إلا إذا طلب المستخدم ذلك صراحة.',
      extraContext ? `سياق داخلي إضافي للنموذج فقط وليس رداً جاهزاً: ${extraContext}` : '',
    ].filter(Boolean).join(' ')),
  })

  const reply = String(result.reply || '').trim()
  if (!reply) throw new Error('WHATSAPP_MODEL_EMPTY_REPLY')
  if (reply === PLATFORM_AI_UNAVAILABLE_MESSAGE) throw new Error('WHATSAPP_MODEL_UNAVAILABLE_REPLY')
  return result.reply
}

// WhatsApp-only output boundary. A provider/model may occasionally introduce
// itself despite the academy persona. Strip SELF-identification, not ordinary
// mentions of technical products in a visitor's requested answer.
export const WHATSAPP_IDENTITY_FALLBACK_REPLY = 'أنا الوكيل الذكي للأكاديمية.'

const WHATSAPP_MODEL_SELF_IDENTITY: RegExp[] = [
  /\b(?:i\s+am|i'm|my\s+name\s+is|this\s+is)\s+(?:(?:an?|the)\s+)?(?:deepseek[\w.-]*|chatgpt[\w.-]*|gpt-\d[\w.-]*|claude[\w.-]*|gemini[\w.-]*|llama[\w.-]*|grok[\w.-]*|qwen[\w.-]*|mistral[\w.-]*|copilot[\w.-]*)\b/i,
  /\b(?:i\s+am|i'm|my\s+name\s+is)\s+(?:(?:an?|the)\s+)?(?:ai|artificial\s+intelligence|large\s+language\s+model|language\s+model|llm|chatbot)\b/i,
  /\b(?:developed|created|powered|trained)\s+by\s+(?:openai|google|deepseek|anthropic|meta|microsoft|xai|alibaba)\b/i,
  /(?:أنا|انا|اسمي)\s+(?:(?:نموذج\s+)?(?:ذكاء\s+اصطناعي|لغوي)|(?:ديب\s*سيك|شات\s*جي\s*بي\s*تي|جيميني|deepseek|chatgpt|gemini))(?=\s|[.!؟،,؛;:]|$)/iu,
  /(?:أنا|انا)\s+نموذج[^.!؟\n]{0,70}(?:تم\s+تطويري|من\s+تطوير|بواسطة)/u,
  /(?:تم\s+تطويري|طوّرني|طورني)\s+(?:بواسطة|من\s+قبل)\s+[^.!؟\n]{1,50}/u,
]

export function sanitizeWhatsAppBotReply(reply: string): { text: string; stripped: boolean } {
  const raw = String(reply || '')
  if (!raw.trim()) return { text: raw, stripped: false }
  const segments = raw.split(/(?<=[.!?؟])\s+|\n+/).map((segment) => segment.trim()).filter(Boolean)
  const identitySegment = (segment: string) => WHATSAPP_MODEL_SELF_IDENTITY.some((pattern) => pattern.test(segment))
  if (!segments.some(identitySegment)) return { text: raw, stripped: false }
  const cleaned = segments.filter((segment) => !identitySegment(segment)).join(' ').trim()
  // Never request a second model reply here: it would change routing/handoff
  // side effects. One incoming message still produces at most one send.
  return { text: cleaned || WHATSAPP_IDENTITY_FALLBACK_REPLY, stripped: true }
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
  await assertWhatsAppFreeformWindowOpen(to)
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

export async function sendOfficialWhatsAppHumanFollowup(
  to: string,
  customerName: string,
  options?: { phoneNumberId?: string; imageUrl?: string },
) {
  const config = getWhatsAppCloudConfig(options?.phoneNumberId)
  if (!config) {
    throw new Error('WhatsApp Cloud API is not configured. Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.')
  }

  const normalizedName = compactText(customerName, 120) || 'عميلنا الكريم'
  const appUrl = trim(process.env.NEXT_PUBLIC_APP_URL || 'https://aactacademy.com').replace(/\/$/, '')
  const imageUrl = trim(options?.imageUrl) || `${appUrl}/logo.png`
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: 'human_followup_ar',
      language: { code: 'ar' },
      components: [
        {
          type: 'header',
          parameters: [{ type: 'image', image: { link: imageUrl } }],
        },
        {
          type: 'body',
          parameters: [{ type: 'text', parameter_name: 'customer_name', text: normalizedName }],
        },
      ],
    },
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
    const message = data?.error?.message || data?.error?.code || `WhatsApp template send failed with status ${response.status}`
    throw new Error(String(message).slice(0, 500))
  }
  return data
}

type WhatsAppTemplateCheck = {
  checked: boolean
  ok: boolean
  message: string
  headerFormat?: string
  bodyParameterCount?: number
}

// Read-only Meta preflight. A missing WABA ID/management permission is
// UNVERIFIED, not evidence that an approved template is missing.
export async function checkOfficialWhatsAppTemplate(
  templateName: string,
  languageCode: string,
  wabaId: string,
  expectation?: { bodyParameterCount?: number; verifyHeaderImageUrl?: string },
): Promise<WhatsAppTemplateCheck> {
  const name = trim(templateName)
  const language = trim(languageCode)
  const accountId = trim(wabaId)
  if (!name) return { checked: true, ok: false, message: 'اسم قالب واتساب غير محفوظ' }
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) {
    return { checked: true, ok: false, message: 'رمز لغة القالب غير صالح — مثال: ar أو ar_EG' }
  }
  if (!accountId) return { checked: false, ok: false, message: 'أدخل معرّف حساب واتساب التجاري (WABA ID) لفحص القالب في Meta' }
  if (!/^\d{5,30}$/.test(accountId)) {
    return { checked: true, ok: false, message: 'معرّف حساب واتساب التجاري غير صالح' }
  }
  const config = getWhatsAppCloudConfig()
  if (!config) return { checked: false, ok: false, message: 'اتصال واتساب غير مهيأ في السيرفر' }
  try {
    const query = new URLSearchParams({ name, fields: 'name,language,status,components', limit: '100' })
    const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${accountId}/message_templates?${query}`, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      signal: AbortSignal.timeout(8000),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      return {
        checked: false,
        ok: false,
        message: `تعذر فحص القالب عند Meta (${data?.error?.code || response.status}) — تحقق من معرّف WABA وصلاحية whatsapp_business_management`,
      }
    }
    const templates = Array.isArray(data?.data) ? data.data : []
    const matched = templates.find((item: any) => trim(item?.name) === name && trim(item?.language) === language)
    if (!matched) {
      const languages = templates.filter((item: any) => trim(item?.name) === name).map((item: any) => trim(item?.language)).filter(Boolean).slice(0, 8)
      return {
        checked: true,
        ok: false,
        message: `القالب "${name}" غير موجود باللغة "${language}" في حساب Meta المحدد${languages.length ? ` — اللغات المتاحة: ${languages.join(', ')}` : ''}`,
      }
    }
    if (matched.status !== 'APPROVED') {
      return { checked: true, ok: false, message: `القالب "${name}" باللغة "${language}" حالته ${matched.status || 'غير معروفة'} وليست APPROVED` }
    }
    if (!Array.isArray(matched.components)) {
      return { checked: false, ok: false, message: 'القالب معتمد لكن Meta لم تُرجع المكوّنات — لا يمكن التحقق من الهيدر والجسم' }
    }
    const headers = matched.components.filter((item: any) => trim(item?.type).toUpperCase() === 'HEADER')
    const body = matched.components.find((item: any) => trim(item?.type).toUpperCase() === 'BODY')
    if (headers.length > 1 || typeof body?.text !== 'string') {
      return { checked: false, ok: false, message: 'مكوّنات القالب غير مكتملة أو غير متوقعة — لا يمكن تأكيد توافق الإرسال' }
    }
    const headerFormat = headers.length ? trim(headers[0]?.format).toUpperCase() : 'NONE'
    if (!['NONE', 'IMAGE', 'TEXT'].includes(headerFormat) ||
        (headerFormat === 'TEXT' && /\{\{\s*\d+\s*\}\}/.test(trim(headers[0]?.text)))) {
      return { checked: true, ok: false, headerFormat, message: `هيدر القالب ${headerFormat || 'غير معروف'} ولا يدعم مرسل دعوة الامتحان هذه الصيغة` }
    }
    const indexes = Array.from(new Set(Array.from(body.text.matchAll(/\{\{\s*(\d+)\s*\}\}/g), (match: RegExpMatchArray) => Number(match[1])))).sort((a, b) => a - b)
    const bodyParameterCount = indexes.length
    const expected = expectation?.bodyParameterCount
    if (expected !== undefined && (indexes.length !== expected || indexes.some((value, index) => value !== index + 1))) {
      return { checked: true, ok: false, headerFormat, bodyParameterCount, message: `متغيرات BODY في Meta هي ${indexes.join(', ') || 'بلا متغيرات'}، بينما الإرسال يتطلب {{1}} إلى {{${expected}}}` }
    }
    if (headerFormat === 'IMAGE' && expectation?.verifyHeaderImageUrl) {
      try {
        const url = new URL(expectation.verifyHeaderImageUrl)
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_IMAGE_URL')
        const image = await fetch(url.toString(), { method: 'HEAD', signal: AbortSignal.timeout(8000) })
        if (!image.ok || !/^image\/(?:png|jpeg)(?:;|$)/i.test(image.headers.get('content-type') || '')) {
          return { checked: true, ok: false, headerFormat, bodyParameterCount, message: 'رابط هيدر الصورة لا يرجع صورة PNG/JPEG متاحة مباشرة عبر HTTPS' }
        }
      } catch {
        return { checked: true, ok: false, headerFormat, bodyParameterCount, message: 'تعذر الوصول إلى رابط هيدر الصورة والتحقق منه — تأكد من الرابط العام قبل الإرسال' }
      }
    }
    return { checked: true, ok: true, headerFormat, bodyParameterCount, message: `القالب "${name}" معتمد باللغة "${language}" — الهيدر ${headerFormat}، ومتغيرات BODY: ${bodyParameterCount}${headerFormat === 'IMAGE' && expectation?.verifyHeaderImageUrl ? '، ورابط الصورة صالح' : ''}` }
  } catch {
    return { checked: false, ok: false, message: 'تعذر الوصول إلى Meta لفحص القالب — تحقق من الاتصال ثم حاول مجددًا' }
  }
}

// Generic approved-template sender for comprehensive-exam invitations.
// Preserve Arabic ("ar") for old callers unless a specific locale is passed.
// The optional WABA preflight prevents known name/language mismatches;
// missing management permissions never block an otherwise valid send.
// Pass headerImageUrl when the template carries an IMAGE header — Meta
// rejects the send with #132012 when the header component is missing.
export async function sendOfficialWhatsAppTemplate(
  to: string,
  templateName: string,
  bodyParameters: string[],
  options?: { phoneNumberId?: string; languageCode?: string; wabaId?: string; headerImageUrl?: string },
) {
  const config = getWhatsAppCloudConfig(options?.phoneNumberId)
  if (!config) {
    throw new Error('WhatsApp Cloud API is not configured. Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.')
  }
  const name = trim(templateName)
  if (!name) throw new Error('WhatsApp template name is missing.')
  const language = trim(options?.languageCode) || 'ar'
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(language)) {
    throw new Error('رمز لغة قالب واتساب غير صالح — مثال: ar_EG')
  }
  // If Meta confirms the schema, its HEADER format is authoritative. Without
  // preflight, only the known IMAGE invite template gets a fallback image;
  // an unknown/legacy template remains body-only instead of guessing.
  const headerImageUrl = trim(options?.headerImageUrl)
  let includeImageHeader = Boolean(headerImageUrl && name === 'comprehensive_exam_invite_ar')
  if (trim(options?.wabaId)) {
    const check = await checkOfficialWhatsAppTemplate(name, language, trim(options?.wabaId), { bodyParameterCount: bodyParameters.length })
    if (check.checked && !check.ok) throw new Error(check.message)
    if (check.checked && check.ok) {
      includeImageHeader = check.headerFormat === 'IMAGE'
      if (includeImageHeader && !headerImageUrl) throw new Error(`قالب "${name}" يحتاج هيدر IMAGE ولم يُمرر رابط الصورة`)
    }
  }
  const components: any[] = []
  if (includeImageHeader) {
    const url = new URL(headerImageUrl)
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('رابط هيدر الصورة يجب أن يكون HTTPS عامًا')
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: url.toString() } }],
    })
  }
  components.push({
    type: 'body',
    parameters: bodyParameters.map((text) => ({ type: 'text', text: String(text ?? '') })),
  })
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name,
      language: { code: language },
      components,
    },
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
    if (Number(data?.error?.code) === 132001) {
      throw new Error(`Meta #132001: القالب "${name}" غير موجود باللغة "${language}" في حساب واتساب المرسل — طابق الاسم واللغة وحساب WABA مع Meta`)
    }
    if (Number(data?.error?.code) === 132012) {
      throw new Error(`Meta #132012: صيغة أحد بارامترات القالب "${name}" لا تطابق القالب المعتمد — تحقق من هيدر الصورة (IMAGE) وبارامترات الجسم بالترتيب`)
    }
    const message = data?.error?.message || data?.error?.code || `WhatsApp template send failed with status ${response.status}`
    throw new Error(String(message).slice(0, 500))
  }
  return data
}
