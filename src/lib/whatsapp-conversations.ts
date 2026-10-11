import { db } from '@/lib/db'
import { decryptWhatsAppPhone, encryptWhatsAppPhone, maskWhatsAppPhone, whatsappWaIdHash } from '@/lib/whatsapp-privacy'

const REQUESTED_TTL_MS = 24 * 60 * 60 * 1000

export function normalizeWaId(value: string | null | undefined) {
  return String(value || '').replace(/\D/g, '')
}

export function maskWaId(value: string | null | undefined) {
  return maskWhatsAppPhone(value)
}

export function hashWaId(value: string | null | undefined) {
  return whatsappWaIdHash(normalizeWaId(value))
}

export function conversationKey(value: string | null | undefined) {
  return `wa:${hashWaId(value).slice(0, 32)}`
}

export function decryptConversationWaIdForInternalUse(record: { waId?: string | null; waIdEncrypted?: string | null }) {
  return decryptWhatsAppPhone(record.waIdEncrypted) || normalizeWaId(record.waId || '')
}

export async function getOrCreateWhatsAppConversation(waId: string, opts: { displayName?: string | null } = {}) {
  const normalized = normalizeWaId(waId)
  if (!normalized) return null
  const waIdHash = hashWaId(normalized)
  const masked = maskWaId(normalized)
  const encrypted = encryptWhatsAppPhone(normalized)
  return db.whatsAppConversation.upsert({
    where: { waIdHash },
    update: {
      waId: masked,
      waIdEncrypted: encrypted || undefined,
      phoneMasked: masked,
      displayName: opts.displayName || undefined,
      lastInboundAt: new Date(),
      updatedAt: new Date(),
    },
    create: {
      waId: masked,
      waIdHash,
      waIdEncrypted: encrypted || null,
      phoneMasked: masked,
      displayName: opts.displayName || null,
      status: 'ACTIVE',
      lastInboundAt: new Date(),
    },
  })
}

export async function markWhatsAppConversationRequested(args: { waId: string; handoffRequestId?: string | null }) {
  const normalized = normalizeWaId(args.waId)
  if (!normalized) return null
  const waIdHash = hashWaId(normalized)
  const masked = maskWaId(normalized)
  const encrypted = encryptWhatsAppPhone(normalized)
  return db.whatsAppConversation.upsert({
    where: { waIdHash },
    update: {
      waId: masked,
      waIdEncrypted: encrypted || undefined,
      phoneMasked: masked,
      status: 'HUMAN_REQUESTED',
      humanRequestedAt: new Date(),
      handoffRequestId: args.handoffRequestId || undefined,
      updatedAt: new Date(),
    },
    create: {
      waId: masked,
      waIdHash,
      waIdEncrypted: encrypted || null,
      phoneMasked: masked,
      status: 'HUMAN_REQUESTED',
      humanRequestedAt: new Date(),
      handoffRequestId: args.handoffRequestId || null,
      lastInboundAt: new Date(),
    },
  })
}

export async function isWhatsAppConversationHumanRequested(waId: string) {
  const normalized = normalizeWaId(waId)
  if (!normalized) return false
  const row = await db.whatsAppConversation.findUnique({ where: { waIdHash: hashWaId(normalized) }, select: { status: true, humanRequestedAt: true } }).catch(() => null)
  if (!row || row.status !== 'HUMAN_REQUESTED') return false
  if (!row.humanRequestedAt) return true
  return Date.now() - row.humanRequestedAt.getTime() < REQUESTED_TTL_MS
}

export async function markWhatsAppConversationAutoReplied(waId: string, message: string) {
  const normalized = normalizeWaId(waId)
  if (!normalized) return null
  const waIdHash = hashWaId(normalized)
  const masked = maskWaId(normalized)
  const encrypted = encryptWhatsAppPhone(normalized)
  return db.whatsAppConversation.upsert({
    where: { waIdHash },
    update: {
      waId: masked,
      waIdEncrypted: encrypted || undefined,
      phoneMasked: masked,
      status: 'ACTIVE',
      lastAutoReplyAt: new Date(),
      lastAutoReplyText: String(message || '').slice(0, 2000),
      updatedAt: new Date(),
    },
    create: {
      waId: masked,
      waIdHash,
      waIdEncrypted: encrypted || null,
      phoneMasked: masked,
      status: 'ACTIVE',
      lastAutoReplyAt: new Date(),
      lastAutoReplyText: String(message || '').slice(0, 2000),
      lastInboundAt: new Date(),
    },
  })
}
