import crypto from 'crypto'
import { db } from '@/lib/db'
import type { WhatsAppInboundMessage } from '@/lib/whatsapp-cloud'

type ConversationStatus = 'BOT_ACTIVE' | 'HUMAN_REQUESTED' | 'HUMAN_ACTIVE' | 'CLOSED'

type OutboundSender = 'BOT' | 'HUMAN' | 'SYSTEM'

function digitsOnly(value?: string | null) {
  return String(value || '').replace(/\D/g, '')
}

export function maskWhatsAppId(value?: string | null) {
  const raw = digitsOnly(value)
  if (!raw) return ''
  return raw.length <= 4 ? `****${raw}` : `${raw.slice(0, 3)}****${raw.slice(-4)}`
}

export function hashWhatsAppId(value: string) {
  const raw = digitsOnly(value) || String(value || '').trim()
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function whatsappConversationKey(value: string) {
  return `whatsapp:${hashWhatsAppId(value).slice(0, 24)}`
}

function compact(value: unknown, max = 1200) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max)
}

export async function upsertWhatsAppConversationFromInbound(message: WhatsAppInboundMessage) {
  const waId = digitsOnly(message.from)
  const waIdHash = hashWhatsAppId(waId)
  const now = new Date()
  const text = compact(message.text || `[${message.rawType || 'message'}]`, 1000)

  return db.whatsAppConversation.upsert({
    where: { waIdHash },
    create: {
      waId,
      waIdHash,
      phoneMasked: maskWhatsAppId(waId),
      displayName: message.name || null,
      phoneNumberId: message.phoneNumberId || null,
      status: 'BOT_ACTIVE',
      lastInboundAt: now,
      lastMessageAt: now,
      lastMessageText: text || null,
    },
    update: {
      waId,
      phoneMasked: maskWhatsAppId(waId),
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
  sentById?: string | null
  sentByName?: string | null
  status?: string | null
}) {
  const waId = digitsOnly(args.waId)
  const waIdHash = hashWhatsAppId(waId)
  const now = new Date()
  const conversation = await db.whatsAppConversation.upsert({
    where: { waIdHash },
    create: {
      waId,
      waIdHash,
      phoneMasked: maskWhatsAppId(waId),
      phoneNumberId: args.phoneNumberId || null,
      status: 'BOT_ACTIVE',
      lastOutboundAt: now,
      lastMessageAt: now,
      lastMessageText: args.text.slice(0, 1000),
    },
    update: {
      waId,
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
  const waIdHash = hashWhatsAppId(args.waId)
  await db.whatsAppConversation.updateMany({
    where: { waIdHash, status: { not: 'HUMAN_ACTIVE' } },
    data: {
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
