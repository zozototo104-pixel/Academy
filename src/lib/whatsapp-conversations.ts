import { db } from '@/lib/db'
import type { WhatsAppInboundMessage } from '@/lib/whatsapp-cloud'
import { decryptWhatsAppPhone, encryptWhatsAppPhone, hashWhatsAppId as canonicalHashWhatsAppId, maskWhatsAppPhone } from '@/lib/whatsapp-privacy'

type ConversationStatus = 'BOT_ACTIVE' | 'HUMAN_REQUESTED' | 'HUMAN_ACTIVE' | 'CLOSED'
type OutboundSender = 'BOT' | 'HUMAN' | 'SYSTEM'

function digitsOnly(value?: string | null) {
  return String(value || '').replace(/\D/g, '')
}

export function maskWhatsAppId(value?: string | null) {
  return maskWhatsAppPhone(value)
}

export function hashWhatsAppId(value: string) {
  return canonicalHashWhatsAppId(value)
}

function isUniqueConstraintError(error: any) {
  return error?.code === 'P2002' || String(error?.message || '').includes('Unique constraint failed')
}

export function whatsappConversationKey(value: string) {
  return `whatsapp:${hashWhatsAppId(value).slice(0, 24)}`
}

export function decryptConversationWaIdForInternalUse(record: { waId?: string | null; waIdEncrypted?: string | null }) {
  return decryptWhatsAppPhone(record.waIdEncrypted) || digitsOnly(record.waId || '')
}

function compact(value: unknown, max = 1200) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max)
}

function safeConversationSenderFields(waId: string) {
  const normalized = digitsOnly(waId)
  const masked = maskWhatsAppId(normalized)
  return {
    waId: masked,
    waIdHash: hashWhatsAppId(normalized),
    waIdEncrypted: encryptWhatsAppPhone(normalized) || null,
    phoneMasked: masked,
  }
}

export async function upsertWhatsAppConversationFromInbound(message: WhatsAppInboundMessage) {
  const safe = safeConversationSenderFields(message.from)
  const now = new Date()
  const text = compact(message.text || `[${message.rawType || 'message'}]`, 1000)

  return db.whatsAppConversation.upsert({
    where: { waIdHash: safe.waIdHash },
    create: {
      ...safe,
      displayName: message.name || null,
      phoneNumberId: message.phoneNumberId || null,
      status: 'BOT_ACTIVE',
      lastInboundAt: now,
      lastMessageAt: now,
      lastMessageText: text || null,
    },
    update: {
      waId: safe.waId,
      waIdEncrypted: safe.waIdEncrypted || undefined,
      phoneMasked: safe.phoneMasked,
      displayName: message.name || undefined,
      phoneNumberId: message.phoneNumberId || undefined,
      lastInboundAt: now,
      lastMessageAt: now,
      lastMessageText: text || null,
      humanClosedAt: text ? null : undefined,
    },
  })
}

export async function recordWhatsAppInboundMessage(message: WhatsAppInboundMessage) {
  let conversation = await upsertWhatsAppConversationFromInbound(message)
  if (conversation.status === 'CLOSED') {
    conversation = await db.whatsAppConversation.update({
      where: { id: conversation.id },
      data: { status: 'BOT_ACTIVE', humanClosedAt: null },
    })
  }
  const text = message.text || `رسالة غير نصية (${message.rawType || 'unknown'})`
  const stored = await db.whatsAppConversationMessage.create({
    data: {
      conversationId: conversation.id,
      whatsappMessageId: message.id || null,
      direction: 'INBOUND',
      sender: 'CUSTOMER',
      text: text.slice(0, 4096),
      rawType: message.rawType || null,
      meta: {
        phoneNumberId: message.phoneNumberId || null,
        contactName: message.name || null,
        kind: message.originKind || (message.rawType === 'audio' ? 'VOICE' : 'TEXT'),
        mediaId: message.mediaId || null,
        mediaMimeType: message.mediaMimeType || null,
        mediaFileSize: message.mediaFileSize || null,
        isVoice: Boolean(message.isVoice),
        fromHash: safeConversationSenderFields(message.from).waIdHash,
        fromMasked: maskWhatsAppId(message.from),
      },
    },
  }).catch(() => null)
  return { conversation, message: stored }
}

export async function recordWhatsAppOutboundMessage(args: {
  waId: string
  phoneNumberId?: string | null
  text: string
  sender: OutboundSender
  whatsappMessageId?: string | null
  replyForMessageId?: string | null
  sentById?: string | null
  sentByName?: string | null
  status?: string | null
}) {
  const safe = safeConversationSenderFields(args.waId)
  const now = new Date()
  const conversation = await db.whatsAppConversation.upsert({
    where: { waIdHash: safe.waIdHash },
    create: {
      ...safe,
      phoneNumberId: args.phoneNumberId || null,
      status: 'BOT_ACTIVE',
      lastOutboundAt: now,
      lastMessageAt: now,
      lastMessageText: args.text.slice(0, 1000),
    },
    update: {
      waId: safe.waId,
      waIdEncrypted: safe.waIdEncrypted || undefined,
      phoneMasked: safe.phoneMasked,
      phoneNumberId: args.phoneNumberId || undefined,
      lastOutboundAt: now,
      lastMessageAt: now,
      lastMessageText: args.text.slice(0, 1000),
    },
  })
  await db.whatsAppConversationMessage.create({
    data: {
      conversationId: conversation.id,
      whatsappMessageId: args.whatsappMessageId || null,
      direction: 'OUTBOUND',
      sender: args.sender,
      text: args.text.slice(0, 4096),
      status: args.status || 'SENT',
      sentById: args.sentById || null,
      sentByName: args.sentByName || null,
      meta: { phoneNumberId: args.phoneNumberId || null },
    },
  }).catch(() => {})
  return conversation
}

export async function markWhatsAppConversationRequested(args: {
  waId: string
  handoffRequestId?: string | null
}) {
  const safe = safeConversationSenderFields(args.waId)
  await db.whatsAppConversation.updateMany({
    where: { waIdHash: safe.waIdHash, status: { not: 'HUMAN_ACTIVE' } },
    data: {
      waId: safe.waId,
      waIdEncrypted: safe.waIdEncrypted || undefined,
      phoneMasked: safe.phoneMasked,
      status: 'HUMAN_REQUESTED',
      handoffRequestId: args.handoffRequestId || undefined,
    },
  }).catch(() => {})
}

export async function isWhatsAppConversationHumanActive(waId: string) {
  const waIdHash = hashWhatsAppId(waId)
  const conversation = await db.whatsAppConversation.findUnique({
    where: { waIdHash },
    select: { id: true, status: true },
  }).catch(() => null)
  return conversation?.status === 'HUMAN_ACTIVE'
}

export async function setWhatsAppConversationStatus(args: {
  conversationId: string
  status: ConversationStatus
  adminId?: string | null
  adminName?: string | null
}) {
  const now = new Date()
  const data: any = { status: args.status }
  if (args.status === 'HUMAN_ACTIVE') {
    data.assignedToId = args.adminId || null
    data.assignedToName = args.adminName || null
    data.assignedAt = now
    data.humanClosedAt = null
  }
  if (args.status === 'BOT_ACTIVE' || args.status === 'CLOSED') {
    data.humanClosedAt = now
    data.assignedToId = args.status === 'CLOSED' ? args.adminId || null : null
    data.assignedToName = args.status === 'CLOSED' ? args.adminName || null : null
  }
  return db.whatsAppConversation.update({ where: { id: args.conversationId }, data })
}
