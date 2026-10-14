import { after, NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { transcribeAudioBase64 } from '@/lib/asr'
import { getOfficialContact } from '@/lib/settings'
import { redactDeep } from '@/lib/secret-crypto'
import { decryptWhatsAppPhone, encryptWhatsAppPhone, maskWhatsAppPhone, whatsappWaIdHash } from '@/lib/whatsapp-privacy'
import {
  analyzeHumanHandoffIntent,
  createHumanHandoffRequest,
  hasOpenHumanHandoffRequest,
  getHumanHandoffConfirmationReply,
  getHumanSupportReply,
  withHumanHandoffActiveNote,
} from '@/lib/human-handoff'
import {
  createOfficialWhatsAppAgentReply,
  extractWhatsAppInboundMessages,
  officialWhatsAppConfigured,
  sendOfficialWhatsAppReadReceipt,
  sendOfficialWhatsAppText,
  sendOfficialWhatsAppTypingIndicator,
  verifyWhatsAppSignature,
  type WhatsAppInboundMessage,
} from '@/lib/whatsapp-cloud'
import {
  isWhatsAppConversationHumanActive,
  markWhatsAppConversationRequested,
  recordWhatsAppInboundMessage,
  recordWhatsAppOutboundMessage,
} from '@/lib/whatsapp-conversations'
import {
  downloadOfficialWhatsAppMediaBase64,
  getOfficialWhatsAppMediaInfo,
} from '@/lib/whatsapp-media'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const recentGreetingKeys = new Map<string, number>()
const pendingInboundMessages = new Map<string, WhatsAppInboundMessage>()
const IMMEDIATE_GREETING_WINDOW_MS = 24 * 60 * 60 * 1000
const MESSAGE_PROCESSING_BUDGET_MS = 50_000
const STALE_PROCESSING_RETRY_MS = 10 * 60 * 1000
const WHATSAPP_VOICE_MAX_BYTES = 10 * 1024 * 1024
const WHATSAPP_VOICE_HOURLY_LIMIT = 10
const WHATSAPP_VOICE_TOO_LONG_REPLY = 'الرسالة الصوتية طويلة، ممكن تختصرها أو تكتب سؤالك؟'
const WHATSAPP_VOICE_HANDOFF_REPLY = 'استلمنا رسالتك الصوتية ✅ تعذر تحليلها الآن بسبب ضغط/مشكلة مؤقتة، وسيتم تحويل المحادثة للموظف لمتابعة طلبك.'
const WHATSAPP_AI_FALLBACK_REPLY = 'ما قدرت أجاوب تلقائياً هلأ، حوّلت رسالتك لفريق الأكاديمية وبيردوا عليك بأقرب وقت.'

function conversationKey(from: string) {
  return `wa:${whatsappWaIdHash(from).slice(0, 32)}`
}

function waIdHash(from: string) {
  return whatsappWaIdHash(from)
}

async function markSimpleGreetingReplySent(key: string, from: string, messageId: string) {
  recentGreetingKeys.set(key, Date.now())
  await auditWhatsAppWebhook('WHATSAPP_SIMPLE_GREETING_REPLY_SENT', {
    from: maskPhone(from),
    messageId,
    windowHours: Math.round(IMMEDIATE_GREETING_WINDOW_MS / 60 / 60 / 1000),
  }, key)
}

function normalizeGreetingText(value: string) {
  return String(value || '')
    .trim()
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isSimpleWhatsAppGreeting(text: string) {
  const normalized = normalizeGreetingText(text)
  if (!normalized) return false
  const greetings = new Set([
    'السلام عليكم',
    'سلام عليكم',
    'وعليكم السلام',
    'السلام عليكم ورحمه الله',
    'السلام عليكم ورحمه الله وبركاته',
    'مرحبا',
    'هلا',
    'اهلا',
    'اهلا وسهلا',
    'صباح الخير',
    'مساء الخير',
  ])
  return greetings.has(normalized)
}

function simpleWhatsAppGreetingReply(text: string) {
  const greeting = normalizeGreetingText(text)
  if (greeting.includes('صباح')) return 'صباح النور 🌟 كيف يمكنني مساعدتك اليوم؟'
  if (greeting.includes('مساء')) return 'مساء النور 🌟 كيف يمكنني مساعدتك اليوم؟'
  if (greeting.includes('السلام') || greeting.startsWith('سلام')) return 'وعليكم السلام ورحمة الله 🌟 كيف يمكنني مساعدتك اليوم؟'
  return 'أهلًا وسهلًا بك في الأكاديمية 🌟 كيف يمكنني مساعدتك اليوم؟'
}

async function hasRecentWhatsAppAudit(action: string, key: string, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const found = await db.auditLog.findFirst({
    where: { action, entityId: key, createdAt: { gte: since } },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null)
  return !!found
}

async function markWhatsAppHumanSupportPrompt(key: string, from: string, messageId: string) {
  await auditWhatsAppWebhook('WHATSAPP_HUMAN_SUPPORT_PROMPT_SENT', {
    from: maskPhone(from),
    messageId,
    nextExpected: 'name_and_subject',
  }, key)
}

function maskPhone(value?: string | null) {
  return maskWhatsAppPhone(value)
}

function summarizeNonMessageWhatsAppPayload(payload: any) {
  const statusUpdates: any[] = []
  const webhookErrors: any[] = []
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {}
      const phoneNumberId = value?.metadata?.phone_number_id || null
      for (const status of Array.isArray(value?.statuses) ? value.statuses : []) {
        statusUpdates.push({
          id: String(status?.id || '').slice(0, 80),
          status: String(status?.status || 'unknown'),
          recipient: maskPhone(status?.recipient_id),
          timestamp: status?.timestamp || null,
          phoneNumberId,
          conversationId: String(status?.conversation?.id || '').slice(0, 80) || null,
          errors: Array.isArray(status?.errors) ? status.errors.map((e: any) => ({ code: e?.code || null, title: e?.title || null, message: e?.message || null })).slice(0, 3) : [],
        })
      }
      for (const error of Array.isArray(value?.errors) ? value.errors : []) {
        webhookErrors.push({ code: error?.code || null, title: error?.title || null, message: error?.message || null })
      }
    }
  }
  return { statusUpdates: statusUpdates.slice(0, 5), webhookErrors: webhookErrors.slice(0, 5) }
}

function keepTypingIndicatorAlive(message: any, onSent: () => void, onError: (message: string) => void) {
  const timer = setInterval(() => {
    sendOfficialWhatsAppTypingIndicator(message)
      .then(() => onSent())
      .catch((error) => onError(`typing-refresh: ${String(error?.message || error || 'failed').slice(0, 220)}`))
  }, 15_000)
  return () => clearInterval(timer)
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

function isUniqueConstraintError(error: any) {
  return error?.code === 'P2002' || String(error?.message || '').includes('Unique constraint failed')
}

function expectedWhatsAppPhoneNumberId() {
  return String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim()
}

function filterMessagesForConfiguredPhoneNumber(messages: WhatsAppInboundMessage[]) {
  const expected = expectedWhatsAppPhoneNumberId()
  if (!expected) return { accepted: messages, ignored: [] as WhatsAppInboundMessage[] }
  const accepted: WhatsAppInboundMessage[] = []
  const ignored: WhatsAppInboundMessage[] = []
  for (const message of messages) {
    if (String(message.phoneNumberId || '').trim() === expected) accepted.push(message)
    else ignored.push(message)
  }
  return { accepted, ignored }
}

function inboundEventPayload(message: WhatsAppInboundMessage) {
  const fromEncrypted = encryptWhatsAppPhone(message.from) || null
  const payload = redactDeep({
    message: {
      id: message.id,
      fromHash: waIdHash(message.from),
      fromMasked: maskPhone(message.from),
      text: message.text || '',
      name: message.name || null,
      phoneNumberId: message.phoneNumberId || null,
      rawType: message.rawType || null,
      mediaId: message.mediaId || null,
      mediaMimeType: message.mediaMimeType || null,
      mediaSha256: message.mediaSha256 || null,
      mediaFileSize: message.mediaFileSize || null,
      isVoice: Boolean(message.isVoice),
      originKind: message.originKind || (message.rawType === 'audio' ? 'VOICE' : 'TEXT'),
    },
  }) as any
  return { ...payload, message: { ...(payload?.message || {}), fromEncrypted } }
}

function shouldRetryExistingInboundEvent(event: { status: string; updatedAt: Date }) {
  if (event.status === 'RECEIVED' || event.status === 'FAILED') return true
  if (event.status === 'PROCESSING') return Date.now() - new Date(event.updatedAt).getTime() > STALE_PROCESSING_RETRY_MS
  return false
}

async function registerInboundWhatsAppEvents(messages: WhatsAppInboundMessage[]) {
  const eventIds: string[] = []
  let skippedDuplicates = 0
  const errors: string[] = []
  for (const message of messages) {
    try {
      const event = await db.whatsAppInboundEvent.create({
        data: {
          waMessageId: message.id,
          waIdHash: waIdHash(message.from),
          phoneNumberId: message.phoneNumberId || null,
          messageType: message.rawType || null,
          payload: inboundEventPayload(message),
          status: 'RECEIVED',
        },
        select: { id: true },
      })
      pendingInboundMessages.set(event.id, message)
      eventIds.push(event.id)
    } catch (error: any) {
      if (isUniqueConstraintError(error)) {
        const existing = await db.whatsAppInboundEvent.findUnique({
          where: { waMessageId: message.id },
          select: { id: true, status: true, updatedAt: true },
        }).catch(() => null)
        if (existing && shouldRetryExistingInboundEvent(existing)) {
          eventIds.push(existing.id)
        } else {
          skippedDuplicates += 1
        }
        continue
      }
      const msg = `register-event: ${String(error?.message || error || 'failed').slice(0, 220)}`
      errors.push(msg)
      console.error('WhatsApp inbound event registration failed:', msg)
    }
  }
  return { eventIds, skippedDuplicates, errors }
}

function inboundMessageFromEventPayload(payload: any): WhatsAppInboundMessage | null {
  const message = payload?.message || null
  const id = String(message?.id || '').trim()
  const from = String(message?.from || '').trim() || decryptWhatsAppPhone(message?.fromEncrypted)
  if (!id || !from) return null
  return {
    id,
    from,
    text: String(message?.text || ''),
    name: message?.name ? String(message.name) : undefined,
    phoneNumberId: message?.phoneNumberId ? String(message.phoneNumberId) : undefined,
    rawType: message?.rawType ? String(message.rawType) : undefined,
    mediaId: message?.mediaId ? String(message.mediaId) : undefined,
    mediaMimeType: message?.mediaMimeType ? String(message.mediaMimeType) : undefined,
    mediaSha256: message?.mediaSha256 ? String(message.mediaSha256) : undefined,
    mediaFileSize: Number(message?.mediaFileSize || 0) || undefined,
    isVoice: Boolean(message?.isVoice),
    originKind: message?.originKind === 'VOICE' ? 'VOICE' : 'TEXT',
  }
}

async function markInboundEventStatus(eventId: string, status: 'SENT' | 'FAILED' | 'SKIPPED', error?: string | null) {
  await db.whatsAppInboundEvent.update({
    where: { id: eventId },
    data: {
      status,
      error: error ? error.slice(0, 1500) : null,
      processedAt: new Date(),
    },
  }).catch((updateError) => {
    console.warn('WhatsApp inbound event status update failed:', String(updateError).slice(0, 300))
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function sendImmediateVoiceReply(message: WhatsAppInboundMessage, text: string) {
  const sendResult = await sendOfficialWhatsAppText(message.from, text, {
    phoneNumberId: message.phoneNumberId,
    replyToMessageId: message.id,
  })
  await recordWhatsAppOutboundMessage({
    waId: message.from,
    phoneNumberId: message.phoneNumberId,
    text,
    sender: 'BOT',
    whatsappMessageId: sendResult?.messages?.[0]?.id || null,
  }).catch(() => {})
}

async function hasExceededVoiceHourlyLimit(message: WhatsAppInboundMessage) {
  const since = new Date(Date.now() - 60 * 60 * 1000)
  const count = await db.whatsAppInboundEvent.count({
    where: {
      waIdHash: waIdHash(message.from),
      messageType: 'audio',
      createdAt: { gte: since },
    },
  }).catch(() => 0)
  return count > WHATSAPP_VOICE_HOURLY_LIMIT
}

async function prepareWhatsAppMessageForProcessing(message: WhatsAppInboundMessage): Promise<{ message: WhatsAppInboundMessage; immediateReply?: string; requestHuman?: boolean; failureReason?: string }> {
  if (message.rawType !== 'audio') return { message }

  if (await hasExceededVoiceHourlyLimit(message)) {
    return {
      message: { ...message, text: '🎤 رسالة صوتية تجاوزت حد الاستخدام المؤقت.', originKind: 'VOICE' },
      immediateReply: 'وصلتنا عدة رسائل صوتية خلال وقت قصير. ممكن تكتب سؤالك نصاً أو تحاول لاحقاً؟',
    }
  }

  if (!message.mediaId) {
    return {
      message: { ...message, text: '🎤 رسالة صوتية بدون ملف قابل للقراءة.', originKind: 'VOICE' },
      immediateReply: WHATSAPP_VOICE_HANDOFF_REPLY,
      requestHuman: true,
      failureReason: 'missing_media_id',
    }
  }

  try {
    const mediaInfo = await getOfficialWhatsAppMediaInfo(message.mediaId, message.phoneNumberId)
    const fileSize = Number(mediaInfo.fileSize || message.mediaFileSize || 0)
    if (fileSize > WHATSAPP_VOICE_MAX_BYTES) {
      return {
        message: {
          ...message,
          text: '🎤 رسالة صوتية طويلة أو كبيرة الحجم.',
          mediaMimeType: mediaInfo.mimeType || message.mediaMimeType,
          mediaFileSize: fileSize,
          mediaSha256: mediaInfo.sha256 || message.mediaSha256,
          originKind: 'VOICE',
        },
        immediateReply: WHATSAPP_VOICE_TOO_LONG_REPLY,
      }
    }

    const audioBase64 = await downloadOfficialWhatsAppMediaBase64(mediaInfo, message.phoneNumberId)
    const startedAt = Date.now()
    const transcript = await withTimeout(
      transcribeAudioBase64(audioBase64, {
        mimeType: mediaInfo.mimeType || message.mediaMimeType || 'audio/ogg',
        allowZaiFallback: true,
      }),
      38_000,
      'whatsapp_voice_transcription'
    )
    const text = String(transcript || '').trim()
    if (!text) {
      await auditWhatsAppWebhook('WHATSAPP_VOICE_TRANSCRIPTION_EMPTY', {
        from: maskPhone(message.from),
        messageId: message.id,
        mediaId: message.mediaId || null,
        mimeType: mediaInfo.mimeType || message.mediaMimeType || 'audio/ogg',
        fileSize,
      }, message.id)
      return {
        message: {
          ...message,
          text: '🎤 رسالة صوتية تعذر تفريغها إلى نص.',
          mediaMimeType: mediaInfo.mimeType || message.mediaMimeType,
          mediaFileSize: fileSize,
          mediaSha256: mediaInfo.sha256 || message.mediaSha256,
          originKind: 'VOICE',
        },
        immediateReply: WHATSAPP_VOICE_HANDOFF_REPLY,
        requestHuman: true,
        failureReason: 'empty_transcript',
      }
    }

    await auditWhatsAppWebhook('WHATSAPP_VOICE_TRANSCRIPTION_OK', {
      from: maskPhone(message.from),
      messageId: message.id,
      mediaId: message.mediaId || null,
      mimeType: mediaInfo.mimeType || message.mediaMimeType || 'audio/ogg',
      fileSize,
      ms: Date.now() - startedAt,
      transcriptChars: text.length,
    }, message.id)

    return {
      message: {
        ...message,
        text,
        mediaMimeType: mediaInfo.mimeType || message.mediaMimeType,
        mediaFileSize: fileSize,
        mediaSha256: mediaInfo.sha256 || message.mediaSha256,
        isVoice: true,
        originKind: 'VOICE',
      },
    }
  } catch (error: any) {
    const msg = String(error?.message || error || 'voice transcription failed').slice(0, 300)
    await auditWhatsAppWebhook('WHATSAPP_VOICE_TRANSCRIPTION_FAILED', {
      from: maskPhone(message.from),
      messageId: message.id,
      mediaId: message.mediaId || null,
      mimeType: message.mediaMimeType || 'unknown',
      fileSize: message.mediaFileSize || null,
      error: msg,
    }, message.id)
    return {
      message: { ...message, text: '🎤 رسالة صوتية تعذر تفريغها؛ تم تحويلها للموظف لمتابعة الطلب.', originKind: 'VOICE' },
      immediateReply: WHATSAPP_VOICE_HANDOFF_REPLY,
      requestHuman: true,
      failureReason: msg,
    }
  }
}

async function sendFallbackAndRequestHuman(message: WhatsAppInboundMessage, reason: string) {
  const sendResult = await sendOfficialWhatsAppText(message.from, WHATSAPP_AI_FALLBACK_REPLY, {
    phoneNumberId: message.phoneNumberId,
    replyToMessageId: message.id,
  })
  await recordWhatsAppOutboundMessage({
    waId: message.from,
    phoneNumberId: message.phoneNumberId,
    text: WHATSAPP_AI_FALLBACK_REPLY,
    sender: 'BOT',
    whatsappMessageId: sendResult?.messages?.[0]?.id || null,
  }).catch(() => {})
  const handoff = await createHumanHandoffRequest({
    user: { name: 'زائر واتساب', phone: maskPhone(message.from), rawPhone: message.from },
    message: `${reason}\n\n${message.text || ''}`.trim(),
    source: 'WHATSAPP',
    sourceRef: conversationKey(message.from),
  })
  await markWhatsAppConversationRequested({ waId: message.from, handoffRequestId: handoff?.id || null })
  await auditWhatsAppWebhook('WHATSAPP_AI_FALLBACK_SENT', {
    from: maskPhone(message.from),
    messageId: message.id,
    reason: reason.slice(0, 300),
  }, conversationKey(message.from))
}

type WhatsAppContactIntentKind = 'REQUEST_OFFICIAL_CONTACT' | 'PROVIDED_OWN_CONTACT' | 'OTHER'

type WhatsAppContactIntent = {
  intent: WhatsAppContactIntentKind
  confidence: number
  reason?: string
}

function contactValues(primary?: unknown, list?: unknown): string[] {
  const values = [primary, ...(Array.isArray(list) ? list : [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  return Array.from(new Set(values))
}

function normalizeIntentText(text: string): string {
  return String(text || '')
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase()
    .trim()
}

function hasPhoneLikeValue(text: string): boolean {
  return /(?:\+?\d[\d\s().-]{6,}\d)/.test(text)
}

function looksLikeContactIntentCandidate(text: string): boolean {
  const n = normalizeIntentText(text)
  if (hasPhoneLikeValue(n)) return true
  return /(?:تواصل|التواصل|واتساب|واتس|رقم|ارقام|نمره|نمرة|هاتف|جوال|موبايل|اتصل|اتصال|كلم|كلمني|احكي|بريد|ايميل|email|phone|whatsapp|call|contact)/i.test(n)
}

function fallbackContactIntent(text: string): WhatsAppContactIntent {
  const n = normalizeIntentText(text)
  const hasPhone = hasPhoneLikeValue(n)
  const givesOwnContact = /(?:رقمي|نمري|نمرتي|هذا رقمي|هذا الرقم|خد رقمي|خذ رقمي|تواصلوا معي|تواصل معي|اتصلوا علي|اتصل علي|كلمني|كلموني|ابعثولي|راسلوني|على هذا الرقم|ع هذا الرقم)/.test(n)
  if (hasPhone && givesOwnContact) return { intent: 'PROVIDED_OWN_CONTACT', confidence: 0.78, reason: 'fallback-own-contact' }
  if (hasPhone && /^(?:\+?\d[\d\s().-]{6,}\d)\s*$/.test(n)) return { intent: 'PROVIDED_OWN_CONTACT', confidence: 0.72, reason: 'fallback-phone-only' }

  const asksForOfficialContact = /(?:شو|ما|ما هي|ما هو|وين|كيف|اريد|بدي|ابغي|ابغى|ممكن|اعطيني|ارسل|ارسلوا|زودني|احتاج).{0,40}(?:رقمكم|ارقامكم|رقم التواصل|ارقام التواصل|واتسابكم|واتسكم|هاتفكم|جوالكم|ايميلكم|بريدكم|التواصل معكم|طرق التواصل|احكي معكم|اتصل فيكم|اكلمكم)/.test(n)
    || /(?:رقم|ارقام|واتساب|واتس|هاتف|جوال|ايميل|بريد).{0,24}(?:الاكاديميه|الاكاديمية|عندكم|رسمي|الرسمية|التواصل)/.test(n)
  if (asksForOfficialContact) return { intent: 'REQUEST_OFFICIAL_CONTACT', confidence: 0.76, reason: 'fallback-official-contact' }

  return { intent: 'OTHER', confidence: 0.4, reason: 'fallback-other' }
}

async function classifyWhatsAppContactIntent(text: string): Promise<WhatsAppContactIntent> {
  if (!looksLikeContactIntentCandidate(text)) return { intent: 'OTHER', confidence: 0.95, reason: 'not-contact-candidate' }
  return fallbackContactIntent(text)
}

type WhatsAppRoutingIntent = {
  intent: 'REQUEST_OFFICIAL_CONTACT' | 'PROVIDED_OWN_CONTACT' | 'HANDOFF_DETAILS' | 'HUMAN_HANDOFF' | 'QUERY'
  confidence: number
  reason?: string
  contactIntent?: WhatsAppContactIntent
  handoffIntent?: Awaited<ReturnType<typeof analyzeHumanHandoffIntent>>
}

async function classifyWhatsAppRoutingIntent(text: string, context: { promptActive: boolean; handoffOpen: boolean; recentMessages: { role: string; content: string }[] }): Promise<WhatsAppRoutingIntent> {
  const contactIntent = await classifyWhatsAppContactIntent(text)
  if (contactIntent.intent === 'REQUEST_OFFICIAL_CONTACT' && contactIntent.confidence >= 0.62) return { intent: 'REQUEST_OFFICIAL_CONTACT', confidence: contactIntent.confidence, reason: contactIntent.reason, contactIntent }
  if (contactIntent.intent === 'PROVIDED_OWN_CONTACT' && contactIntent.confidence >= 0.62) return { intent: 'PROVIDED_OWN_CONTACT', confidence: contactIntent.confidence, reason: contactIntent.reason, contactIntent }
  const handoffIntent = await analyzeHumanHandoffIntent(text, context)
  if (context.promptActive && !context.handoffOpen && handoffIntent.isHandoffDetails && handoffIntent.confidence >= 0.55) return { intent: 'HANDOFF_DETAILS', confidence: handoffIntent.confidence, reason: handoffIntent.reason, handoffIntent }
  if (handoffIntent.wantsHumanSupport && handoffIntent.confidence >= 0.55) return { intent: 'HUMAN_HANDOFF', confidence: handoffIntent.confidence, reason: handoffIntent.reason, handoffIntent }
  return { intent: 'QUERY', confidence: handoffIntent.confidence || contactIntent.confidence || 0.5, reason: handoffIntent.reason || contactIntent.reason, contactIntent, handoffIntent }
}

function isOfficialAddressQuestion(text: string) {
  const normalized = normalizeIntentText(text).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
  if (/\b(?:website|url|web)\b|(?:رابط|الكتروني|التسجيل|المنصه)/i.test(normalized)) return false
  const asksWhere = /(?:وين|اين|فين|ماذا|ما هو|شو|اعطيني|اريد|بدي|ممكن|where|location|address)/i.test(normalized)
  const mentionsPlace = /(?:موقع|عنوان|مقر|مكان|تقع|توجد|location|address)/i.test(normalized)
  const directlyAsksAddress = /(?:عنوانكم|موقعكم|مقركم|عنوان الاكاديميه|موقع الاكاديميه|مقر الاكاديميه)/.test(normalized)
  return (asksWhere && mentionsPlace) || directlyAsksAddress
}

async function buildOfficialAddressReply(): Promise<string> {
  const contact = await getOfficialContact()
  const address = String(contact?.address || '').trim()
  return address
    ? `عنوان الأكاديمية الرسمي بحسب إعدادات الأكاديمية: ${address}`
    : 'عنوان الأكاديمية غير محدد حالياً في إعدادات التواصل الرسمية. يمكن للإدارة تحديثه من لوحة الإعدادات.'
}

async function buildOfficialContactReply(): Promise<string> {
  const contact: any = await getOfficialContact().catch(() => ({}))
  const whatsapps = contactValues(contact.whatsapp, contact.whatsapps)
  const phones = contactValues(contact.phone, contact.phones)
  const email = String(contact.email || '').trim()
  const lines = ['بيانات التواصل الرسمية للأكاديمية:']
  if (whatsapps.length) lines.push(`واتساب: ${whatsapps.join(' / ')}`)
  if (phones.length) lines.push(`هاتف: ${phones.join(' / ')}`)
  if (email) lines.push(`البريد الرسمي: ${email}`)
  if (contact.responsiblePerson) lines.push(`مسؤول التواصل: ${String(contact.responsiblePerson).trim()}`)
  if (lines.length === 1) return 'بيانات التواصل الرسمية غير مضبوطة حالياً في الإعدادات. يمكنك فتح صفحة التواصل الرسمية من الموقع لمتابعة طلبك.'
  return `${lines.join('\n')}\n\nإذا أرسلت رقمك للتواصل، سنحوّله للموظف المختص للمتابعة.`
}

async function resolveWhatsAppBotReply(message: WhatsAppInboundMessage, storedInbound: any) {
  const handoffKey = conversationKey(message.from)
  const promptActive = await hasRecentWhatsAppAudit('WHATSAPP_HUMAN_SUPPORT_PROMPT_SENT', handoffKey)
  const maskedFrom = maskPhone(message.from)
  const handoffOpen = await hasOpenHumanHandoffRequest({
    sourceRef: handoffKey,
    phone: maskedFrom || null,
  })
  const text = String(message.text || '').trim()
  const recentMessages = storedInbound?.conversation?.id
    ? (await db.whatsAppConversationMessage.findMany({
        where: { conversationId: storedInbound.conversation.id },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { direction: true, text: true },
      }).catch(() => [])).reverse().map((item) => ({
        role: item.direction === 'INBOUND' ? 'user' : 'assistant',
        content: item.text,
      }))
    : []

  // A physical address is authoritative in admin settings, not in generated answers.
  if (isOfficialAddressQuestion(text)) return await buildOfficialAddressReply()

  const routingIntent = await classifyWhatsAppRoutingIntent(text, { promptActive, handoffOpen, recentMessages })
  await auditWhatsAppWebhook('WHATSAPP_ROUTING_INTENT_CLASSIFIED', {
    from: maskPhone(message.from),
    text: text.slice(0, 180),
    promptActive,
    handoffOpen,
    decision: routingIntent,
  }, message.id)

  if (routingIntent.intent === 'REQUEST_OFFICIAL_CONTACT') return await buildOfficialContactReply()

  if (routingIntent.intent === 'PROVIDED_OWN_CONTACT') {
    if (!handoffOpen) {
      const handoff = await createHumanHandoffRequest({
        user: { name: 'زائر واتساب', phone: maskPhone(message.from) || undefined, rawPhone: message.from },
        message: text,
        source: 'WHATSAPP',
        sourceRef: handoffKey,
      })
      await markWhatsAppConversationRequested({ waId: message.from, handoffRequestId: handoff?.id || null })
    }
    return handoffOpen
      ? 'استلمنا بيانات تواصلك ✅ طلب المتابعة موجود بالفعل لدى الفريق، وسيتم الرد عليك عبر المحادثة أو الرقم الذي أرسلته.'
      : 'استلمنا رقمك أو بيانات تواصلك ✅ سيتم تحويلها للموظف المختص للمتابعة.'
  }

  if (routingIntent.intent === 'HANDOFF_DETAILS') {
    const handoff = await createHumanHandoffRequest({
      user: { name: 'زائر واتساب', phone: maskPhone(message.from) || undefined, rawPhone: message.from },
      message: text,
      source: 'WHATSAPP',
      sourceRef: handoffKey,
    })
    await markWhatsAppConversationRequested({ waId: message.from, handoffRequestId: handoff?.id || null })
    return getHumanHandoffConfirmationReply()
  }

  if (routingIntent.intent === 'HUMAN_HANDOFF') {
    if (!handoffOpen) {
      const handoff = await createHumanHandoffRequest({
        user: { name: 'زائر واتساب', phone: maskedFrom || undefined, rawPhone: message.from },
        message: text || 'طلب صريح للتواصل مع موظف',
        source: 'WHATSAPP',
        sourceRef: handoffKey,
      })
      await markWhatsAppConversationRequested({ waId: message.from, handoffRequestId: handoff?.id || null })
    }
    await markWhatsAppHumanSupportPrompt(handoffKey, message.from, message.id)
    return handoffOpen ? getHumanSupportReply() : getHumanHandoffConfirmationReply()
  }

  const agentReply = await createOfficialWhatsAppAgentReply(message)
  if (agentReply.trim() === (await getHumanSupportReply()).trim()) {
    await markWhatsAppHumanSupportPrompt(handoffKey, message.from, message.id)
  }
  return handoffOpen ? withHumanHandoffActiveNote(agentReply) : agentReply
}

async function processWhatsAppMessage(message: WhatsAppInboundMessage): Promise<'SENT' | 'SKIPPED'> {
  if (message.rawType === 'audio') {
    await sendOfficialWhatsAppReadReceipt(message).catch(() => null)
    await sendOfficialWhatsAppTypingIndicator(message).catch(() => null)
  }
  const prepared = await prepareWhatsAppMessageForProcessing(message)
  const inboundMessage = prepared.message
  const storedInbound = await recordWhatsAppInboundMessage(inboundMessage)

  // If the handoff state cannot be checked, fail closed instead of letting the bot reply.
  if (await isWhatsAppConversationHumanActive(inboundMessage.from)) {
    try {
      await sendOfficialWhatsAppReadReceipt(inboundMessage)
    } catch (readError: any) {
      console.warn('official WhatsApp human-held read receipt failed:', String(readError?.message || readError || 'failed').slice(0, 220))
    }
    await auditWhatsAppWebhook('WHATSAPP_HUMAN_CONVERSATION_HELD', {
      from: maskPhone(inboundMessage.from),
      text: inboundMessage.text.slice(0, 180),
      conversationId: storedInbound?.conversation?.id || null,
      note: 'conversation claimed by admin; bot reply suppressed; read receipt attempted',
    }, storedInbound?.conversation?.id || inboundMessage.id)
    return 'SKIPPED'
  }

  if (prepared.immediateReply) {
    await sendOfficialWhatsAppReadReceipt(inboundMessage).catch(() => null)
    await sendImmediateVoiceReply(inboundMessage, prepared.immediateReply)
    if (prepared.requestHuman) {
      const handoff = await createHumanHandoffRequest({
        user: { name: 'زائر واتساب', phone: maskPhone(inboundMessage.from) || undefined, rawPhone: inboundMessage.from },
        message: `${prepared.failureReason || 'voice_processing_failed'}\n\n${inboundMessage.text || ''}`.trim(),
        source: 'WHATSAPP',
        sourceRef: conversationKey(inboundMessage.from),
      })
      await markWhatsAppConversationRequested({ waId: inboundMessage.from, handoffRequestId: handoff?.id || null })
      await auditWhatsAppWebhook('WHATSAPP_VOICE_HANDOFF_REQUESTED', {
        from: maskPhone(inboundMessage.from),
        messageId: inboundMessage.id,
        conversationId: storedInbound?.conversation?.id || null,
        reason: String(prepared.failureReason || 'voice_processing_failed').slice(0, 300),
      }, storedInbound?.conversation?.id || inboundMessage.id)
    }
    return 'SENT'
  }

  if (isSimpleWhatsAppGreeting(inboundMessage.text)) {
    await sendOfficialWhatsAppReadReceipt(inboundMessage).catch(() => null)
    const greetingReply = simpleWhatsAppGreetingReply(inboundMessage.text)
    const sendResult = await sendOfficialWhatsAppText(inboundMessage.from, greetingReply, {
      phoneNumberId: inboundMessage.phoneNumberId,
      replyToMessageId: inboundMessage.id,
    })
    await recordWhatsAppOutboundMessage({
      waId: inboundMessage.from,
      phoneNumberId: inboundMessage.phoneNumberId,
      text: greetingReply,
      sender: 'BOT',
      whatsappMessageId: sendResult?.messages?.[0]?.id || null,
    }).catch(() => {})
    await markSimpleGreetingReplySent(conversationKey(inboundMessage.from), inboundMessage.from, inboundMessage.id)
    return 'SENT'
  }

  await sendOfficialWhatsAppReadReceipt(inboundMessage).catch((readError: any) => {
    console.warn('official WhatsApp read receipt failed:', String(readError?.message || readError || 'failed').slice(0, 220))
  })
  await sendOfficialWhatsAppTypingIndicator(inboundMessage).catch((typingError: any) => {
    console.warn('official WhatsApp typing indicator failed:', String(typingError?.message || typingError || 'failed').slice(0, 220))
  })

  // A substantive question gets one answer; simple greetings are handled above.

  const stopTypingRefresh = keepTypingIndicatorAlive(
    inboundMessage,
    () => {},
    (typingMessage) => console.warn('official WhatsApp typing refresh failed:', typingMessage)
  )

  let reply = ''
  try {
    reply = await withTimeout(resolveWhatsAppBotReply(inboundMessage, storedInbound), MESSAGE_PROCESSING_BUDGET_MS, 'whatsapp_reply_generation')
  } finally {
    stopTypingRefresh()
  }

  // The administrator may claim the conversation while the AI is generating.
  if (await isWhatsAppConversationHumanActive(inboundMessage.from)) return 'SKIPPED'

  const sendResult = await sendOfficialWhatsAppText(inboundMessage.from, reply, {
    phoneNumberId: inboundMessage.phoneNumberId,
    replyToMessageId: inboundMessage.id,
  })
  await recordWhatsAppOutboundMessage({
    waId: inboundMessage.from,
    phoneNumberId: inboundMessage.phoneNumberId,
    text: reply,
    sender: 'BOT',
    whatsappMessageId: sendResult?.messages?.[0]?.id || null,
  }).catch(() => {})
  return 'SENT'
}

async function processWhatsAppEvent(eventId: string) {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_RETRY_MS)
  const claim = await db.whatsAppInboundEvent.updateMany({
    where: {
      id: eventId,
      OR: [
        { status: 'RECEIVED' },
        { status: 'FAILED' },
        { status: 'PROCESSING', updatedAt: { lt: staleBefore } },
      ],
    },
    data: { status: 'PROCESSING', attempts: { increment: 1 }, error: null },
  }).catch((error) => {
    console.error('WhatsApp inbound event claim failed:', String(error).slice(0, 300))
    return { count: 0 }
  })

  if (!claim.count) return

  const event = await db.whatsAppInboundEvent.findUnique({ where: { id: eventId } }).catch(() => null)
  const message = pendingInboundMessages.get(eventId) || inboundMessageFromEventPayload(event?.payload)
  pendingInboundMessages.delete(eventId)
  if (!event || !message) {
    await markInboundEventStatus(eventId, 'SKIPPED', 'Missing or invalid WhatsApp inbound event payload')
    return
  }

  try {
    const outcome = await processWhatsAppMessage(message)
    await markInboundEventStatus(eventId, outcome)
    await auditWhatsAppWebhook(outcome === 'SENT' ? 'WHATSAPP_INBOUND_EVENT_SENT' : 'WHATSAPP_INBOUND_EVENT_SKIPPED', {
      eventId,
      messageId: message.id,
      from: maskPhone(message.from),
      rawType: message.rawType || null,
    }, eventId)
  } catch (error: any) {
    const msg = String(error?.message || error || 'unknown WhatsApp processing error').slice(0, 500)
    console.error('official WhatsApp event processing failed:', msg)
    let fallbackDelivered = false
    try {
      await sendFallbackAndRequestHuman(message, msg)
      fallbackDelivered = true
    } catch (fallbackError: any) {
      console.error('official WhatsApp fallback reply failed:', String(fallbackError?.message || fallbackError || 'failed').slice(0, 500))
    }
    // Do not retry this inbound event after successfully sending a fallback reply.
    await markInboundEventStatus(eventId, fallbackDelivered ? 'SENT' : 'FAILED', msg)
    await auditWhatsAppWebhook('WHATSAPP_INBOUND_EVENT_FAILED', {
      eventId,
      messageId: message.id,
      from: maskPhone(message.from),
      error: msg,
    }, eventId)
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

// Incoming official WhatsApp messages. The route validates and records inbound
// events first, acknowledges Meta quickly, then processes each event after the
// response. Idempotency lives in WhatsAppInboundEvent.waMessageId.
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

  const extractedMessages = extractWhatsAppInboundMessages(payload)
  const { accepted: messages, ignored: ignoredPhoneMessages } = filterMessagesForConfiguredPhoneNumber(extractedMessages)
  if (ignoredPhoneMessages.length) {
    await auditWhatsAppWebhook('WHATSAPP_WEBHOOK_IGNORED_PHONE_NUMBER', {
      ignored: ignoredPhoneMessages.length,
      expectedPhoneNumberId: expectedWhatsAppPhoneNumberId() || null,
      phoneNumberIds: Array.from(new Set(ignoredPhoneMessages.map((message) => message.phoneNumberId || 'missing'))).slice(0, 8),
    })
  }

  // Always acknowledge non-message webhooks such as status updates.
  if (!messages.length) {
    const nonMessage = summarizeNonMessageWhatsAppPayload(payload)
    await auditWhatsAppWebhook('WHATSAPP_WEBHOOK_RECEIVED', {
      received: 0,
      sent: 0,
      configured: officialWhatsAppConfigured(),
      ignoredPhoneMessages: ignoredPhoneMessages.length,
      note: nonMessage.statusUpdates.length ? 'status update only; no accepted inbound message text in payload' : 'no accepted inbound messages; likely verification, unsupported, duplicate, or wrong phone number event',
      object: payload?.object || null,
      entries: Array.isArray(payload?.entry) ? payload.entry.length : 0,
      statusUpdates: nonMessage.statusUpdates,
      webhookErrors: nonMessage.webhookErrors,
    })
    return NextResponse.json({ ok: true, received: 0, queued: 0, duplicates: 0, ignoredPhoneMessages: ignoredPhoneMessages.length, statusUpdates: nonMessage.statusUpdates.length, configured: officialWhatsAppConfigured() })
  }

  const registered = await registerInboundWhatsAppEvents(messages)
  for (const eventId of registered.eventIds) {
    after(() => processWhatsAppEvent(eventId).catch((error) => {
      console.error('WhatsApp after-event processing failed:', String(error?.message || error || 'failed').slice(0, 500))
    }))
  }

  await auditWhatsAppWebhook('WHATSAPP_WEBHOOK_RECEIVED', {
    received: messages.length,
    queued: registered.eventIds.length,
    duplicates: registered.skippedDuplicates,
    ignoredPhoneMessages: ignoredPhoneMessages.length,
    configured: officialWhatsAppConfigured(),
    errors: registered.errors.slice(0, 3),
    messages: messages.map((message) => ({ id: message.id, from: maskPhone(message.from), text: message.text.slice(0, 180), phoneNumberId: message.phoneNumberId || null })),
  }, messages[0]?.id)

  return NextResponse.json({
    ok: true,
    received: messages.length,
    queued: registered.eventIds.length,
    duplicates: registered.skippedDuplicates,
    ignoredPhoneMessages: ignoredPhoneMessages.length,
    errors: registered.errors.slice(0, 3),
    configured: officialWhatsAppConfigured(),
  })
}
