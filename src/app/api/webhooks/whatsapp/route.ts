import { createHash } from 'crypto'
import { after, NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { transcribeAudioBase64 } from '@/lib/asr'
import { ensureGeminiKey, geminiCompleteJson } from '@/lib/gemini'
import { getOfficialContact } from '@/lib/settings'
import {
  analyzeHumanHandoffIntent,
  createHumanHandoffRequest,
  hasOpenHumanHandoffRequest,
  HUMAN_HANDOFF_CONFIRMATION_REPLY,
  HUMAN_SUPPORT_REPLY,
  withHumanHandoffActiveNote,
} from '@/lib/human-handoff'
import {
  buildOfficialWhatsAppImmediateGreeting,
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
const IMMEDIATE_GREETING_WINDOW_MS = 24 * 60 * 60 * 1000
const MESSAGE_PROCESSING_BUDGET_MS = 50_000
const STALE_PROCESSING_RETRY_MS = 10 * 60 * 1000
const WHATSAPP_VOICE_MAX_BYTES = 10 * 1024 * 1024
const WHATSAPP_VOICE_HOURLY_LIMIT = 10
const WHATSAPP_VOICE_TOO_LONG_REPLY = 'الرسالة الصوتية طويلة، ممكن تختصرها أو تكتب سؤالك؟'
const WHATSAPP_VOICE_HANDOFF_REPLY = 'استلمنا رسالتك الصوتية ✅ تعذر تحليلها الآن بسبب ضغط/مشكلة مؤقتة، وسيتم تحويل المحادثة للموظف لمتابعة طلبك.'
const WHATSAPP_AI_FALLBACK_REPLY = 'استلمنا رسالتك ✅ وسيتم الرد عليك قريباً.'

function cleanupGreetingKeys() {
  const now = Date.now()
  for (const [key, ts] of recentGreetingKeys.entries()) {
    if (now - ts > IMMEDIATE_GREETING_WINDOW_MS) recentGreetingKeys.delete(key)
  }
}

function conversationKey(from: string) {
  return `wa:${createHash('sha256').update(String(from || '')).digest('hex').slice(0, 32)}`
}

function waIdHash(from: string) {
  return createHash('sha256').update(String(from || '')).digest('hex')
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
      action: { in: ['WHATSAPP_IMMEDIATE_GREETING_SENT', 'WHATSAPP_SIMPLE_GREETING_REPLY_SENT'] },
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

const SIMPLE_WHATSAPP_GREETING_REPLY = 'وعليكم السلام ورحمة الله 🌟\n\nكيف يمكنني مساعدتك اليوم؟'

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
  const raw = String(value || '').replace(/\D/g, '')
  if (!raw) return ''
  return raw.length <= 4 ? `****${raw}` : `${raw.slice(0, 3)}****${raw.slice(-4)}`
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
  return {
    message: {
      id: message.id,
      from: message.from,
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
  }
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
  const from = String(message?.from || '').trim()
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
        allowZaiFallback: false,
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
  await markWhatsAppConversationRequested({ waId: message.from, handoffRequestId: null })
  await auditWhatsAppWebhook('WHATSAPP_AI_FALLBACK_SENT', {
    from: maskPhone(message.from),
    messageId: message.id,
    reason: reason.slice(0, 300),
  }, conversationKey(message.from))
}

async function resolveWhatsAppBotReply(message: WhatsAppInboundMessage, storedInbound: any) {
  const handoffKey = conversationKey(message.from)
  const promptActive = await hasRecentWhatsAppAudit('WHATSAPP_HUMAN_SUPPORT_PROMPT_SENT', handoffKey)
  const digits = String(message.from || '').replace(/\D/g, '')
  const handoffOpen = await hasOpenHumanHandoffRequest({
    sourceRef: handoffKey,
    phone: digits ? `+${digits}` : null,
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
  const handoffIntent = await analyzeHumanHandoffIntent(text, { promptActive, handoffOpen, recentMessages })
  await auditWhatsAppWebhook('WHATSAPP_HANDOFF_INTENT_ANALYZED', {
    from: maskPhone(message.from),
    text: text.slice(0, 180),
    promptActive,
    handoffOpen,
    decision: handoffIntent,
  }, message.id)

  if (promptActive && !handoffOpen && handoffIntent.isHandoffDetails && handoffIntent.confidence >= 0.55) {
    const handoff = await createHumanHandoffRequest({
      user: { name: 'زائر واتساب', phone: digits ? `+${digits}` : undefined },
      message: text,
      source: 'WHATSAPP',
      sourceRef: handoffKey,
    })
    await markWhatsAppConversationRequested({ waId: message.from, handoffRequestId: handoff?.id || null })
    return HUMAN_HANDOFF_CONFIRMATION_REPLY
  }

  if (handoffIntent.wantsHumanSupport && handoffIntent.confidence >= 0.55) {
    await markWhatsAppHumanSupportPrompt(handoffKey, message.from, message.id)
    return HUMAN_SUPPORT_REPLY
  }

  const agentReply = await createOfficialWhatsAppAgentReply(message)
  if (agentReply.trim() === HUMAN_SUPPORT_REPLY.trim()) {
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

  if (await isWhatsAppConversationHumanActive(inboundMessage.from).catch(() => false)) {
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
      await markWhatsAppConversationRequested({ waId: inboundMessage.from, handoffRequestId: null })
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
    const sendResult = await sendOfficialWhatsAppText(inboundMessage.from, SIMPLE_WHATSAPP_GREETING_REPLY, {
      phoneNumberId: inboundMessage.phoneNumberId,
      replyToMessageId: inboundMessage.id,
    })
    await recordWhatsAppOutboundMessage({
      waId: inboundMessage.from,
      phoneNumberId: inboundMessage.phoneNumberId,
      text: SIMPLE_WHATSAPP_GREETING_REPLY,
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

  const greetingDecision = await shouldSendImmediateGreeting(inboundMessage.from)
  if (greetingDecision.ok) {
    try {
      const greetingText = buildOfficialWhatsAppImmediateGreeting(inboundMessage)
      const greetingSend = await sendOfficialWhatsAppText(inboundMessage.from, greetingText, {
        phoneNumberId: inboundMessage.phoneNumberId,
        replyToMessageId: inboundMessage.id,
      })
      await recordWhatsAppOutboundMessage({
        waId: inboundMessage.from,
        phoneNumberId: inboundMessage.phoneNumberId,
        text: greetingText,
        sender: 'BOT',
        whatsappMessageId: greetingSend?.messages?.[0]?.id || null,
      }).catch(() => {})
      await markImmediateGreetingSent(greetingDecision.key, inboundMessage.from, inboundMessage.id)
    } catch (greetingError: any) {
      console.warn('official WhatsApp immediate greeting failed:', String(greetingError?.message || greetingError || 'failed').slice(0, 220))
    }
  }

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
  const message = inboundMessageFromEventPayload(event?.payload)
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
    try {
      await sendFallbackAndRequestHuman(message, msg)
    } catch (fallbackError: any) {
      console.error('official WhatsApp fallback reply failed:', String(fallbackError?.message || fallbackError || 'failed').slice(0, 500))
    }
    await markInboundEventStatus(eventId, 'FAILED', msg)
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
