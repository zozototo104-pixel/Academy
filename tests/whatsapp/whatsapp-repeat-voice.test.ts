/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const conversations = new Map<string, any>()
const conversationMessages: any[] = []
let nextConversationId = 0
let nextMessageId = 0

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

function now() {
  return new Date()
}

function matchesMessageWhere(message: any, where: any) {
  if (where?.whatsappMessageId && message.whatsappMessageId !== where.whatsappMessageId) return false
  if (where?.direction && message.direction !== where.direction) return false
  if (where?.sender && message.sender !== where.sender) return false
  if (where?.conversationId && message.conversationId !== where.conversationId) return false
  if (where?.text && message.text !== where.text) return false
  if (where?.createdAt?.gte && new Date(message.createdAt).getTime() < new Date(where.createdAt.gte).getTime()) return false
  return true
}

const fakeDb: any = {
  program: { findMany: async () => [] },
  whatsAppConversation: {
    findUnique: async ({ where, select }: any) => {
      const conversation = conversations.get(where.waIdHash)
      if (!conversation) return null
      if (select?.messages) {
        const take = select.messages.take || 10
        const messages = conversationMessages
          .filter((message) => message.conversationId === conversation.id)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, take)
        return { ...conversation, messages }
      }
      return conversation
    },
    upsert: async ({ where, create, update }: any) => {
      const existing = conversations.get(where.waIdHash)
      if (existing) {
        Object.assign(existing, update)
        return existing
      }
      const created = { ...create, id: `conversation-${++nextConversationId}` }
      conversations.set(where.waIdHash, created)
      return created
    },
  },
  whatsAppConversationMessage: {
    findFirst: async ({ where, orderBy }: any) => {
      const matches = conversationMessages.filter((message) => matchesMessageWhere(message, where))
      if (orderBy?.createdAt === 'desc') matches.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      return matches[0] || null
    },
    create: async ({ data }: any) => {
      if (data.replyForMessageId && conversationMessages.some((message) => message.replyForMessageId === data.replyForMessageId)) {
        const error: any = new Error('Unique constraint failed on replyForMessageId')
        error.code = 'P2002'
        throw error
      }
      const created = { ...data, id: `message-${++nextMessageId}`, createdAt: data.createdAt || now() }
      conversationMessages.push(created)
      return created
    },
    update: async ({ where, data }: any) => {
      const message = conversationMessages.find((item) => item.id === where.id)
      if (!message) throw new Error('MESSAGE_NOT_FOUND')
      Object.assign(message, data)
      return message
    },
  },
  $transaction: async (work: any) => work(fakeDb),
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/platform-agent', () => ({ platformPublicAgentComplete: async () => ({ reply: 'AI contextual answer' }) }))
mock.module('@/lib/untrusted-context', () => ({ wrapUntrustedUiContext: (value: string) => value }))
mock.module('@/lib/prod-safety', () => ({ unsignedWebhookTestsAllowed: () => true }))
mock.module('@/lib/settings', () => ({
  DEFAULT_OFFICIAL_CONTACT: { phone: '+970599000000', phones: [], whatsapp: '+970599000000', whatsapps: [], email: 'info@example.test', address: 'رام الله' },
  DEFAULT_SETTINGS: [
    { key: 'PAYMENT_MODE', value: 'DIRECT_PAYMENT' },
    { key: 'FEE_APPLICATION', value: '50' },
    { key: 'FEE_DIPLOMAS_MIN', value: '300' },
    { key: 'FEE_DIPLOMAS_MAX', value: '900' },
    { key: 'FEE_MASTERS', value: '1500' },
    { key: 'FEE_DOCTORATE', value: '2500' },
    { key: 'CERTIFICATE_ISSUE_DAYS', value: '30' },
    { key: 'TRUST_BANNER_TEXT', value: 'اعتماد مهني تدريبي' },
  ],
  getOfficialContact: async () => ({ phone: '+970599000000', phones: [], whatsapp: '+970599000000', whatsapps: [], email: 'info@example.test', address: 'رام الله' }),
  getSettings: async () => ({ PAYMENT_MODE: 'DIRECT_PAYMENT', FEE_APPLICATION: '50', FEE_DIPLOMAS_MIN: '300', FEE_DIPLOMAS_MAX: '900', FEE_MASTERS: '1500', FEE_DOCTORATE: '2500', CERTIFICATE_ISSUE_DAYS: '30' }),
  getSetting: async () => 'true',
}))

const { resolveWhatsAppDirectSettingsReply } = await import('../../src/lib/whatsapp-cloud')
const { claimWhatsAppBotReply, isWhatsAppOutboundEcho } = await import('../../src/lib/whatsapp-conversations')

const faqDeps = {
  getSettings: async () => ({ PAYMENT_MODE: 'DIRECT_PAYMENT', FEE_APPLICATION: '50', FEE_DIPLOMAS_MIN: '300', FEE_DIPLOMAS_MAX: '900', FEE_MASTERS: '1500', FEE_DOCTORATE: '2500', CERTIFICATE_ISSUE_DAYS: '30' }),
  getOfficialContact: async () => ({ phone: '+970599000000', phones: [], whatsapp: '+970599000000', whatsapps: [], email: 'info@example.test', address: 'رام الله' }),
  listPrograms: async () => [],
}

beforeEach(() => {
  conversations.clear()
  conversationMessages.length = 0
  nextConversationId = 0
  nextMessageId = 0
})

describe('WhatsApp direct settings replies', () => {
  test('does not trigger contact canned reply for contextual registration contact wording', async () => {
    await expect(resolveWhatsAppDirectSettingsReply('بدي اتواصل بخصوص التسجيل', faqDeps)).resolves.toBeNull()
    await expect(resolveWhatsAppDirectSettingsReply('تواصل', faqDeps)).resolves.toBeNull()
    await expect(resolveWhatsAppDirectSettingsReply('رقم', faqDeps)).resolves.toBeNull()
  })

  test('sends the same canned answer once per recent conversation context', async () => {
    const first = await resolveWhatsAppDirectSettingsReply('رقم التواصل', faqDeps)
    expect(first).toContain('بيانات التواصل الرسمية')
    const second = await resolveWhatsAppDirectSettingsReply('رقم التواصل', faqDeps, {
      recentMessages: [{ direction: 'OUTBOUND', sender: 'BOT', text: first || '' }],
    })
    expect(second).toBeNull()
  })
})

describe('WhatsApp reply idempotency', () => {
  test('claims only one bot reply for a repeated waMessageId', async () => {
    const [first, second] = await Promise.all([
      claimWhatsAppBotReply({ waId: '+970599111111', text: 'أهلاً بك', replyForMessageId: 'wamid.in.1' }),
      claimWhatsAppBotReply({ waId: '+970599111111', text: 'أهلاً بك', replyForMessageId: 'wamid.in.1' }),
    ])
    expect([first, second].filter((item) => item.claimed)).toHaveLength(1)
    expect(conversationMessages.filter((message) => message.replyForMessageId === 'wamid.in.1')).toHaveLength(1)
  })

  test('suppresses same outbound text in the same conversation within two minutes', async () => {
    const first = await claimWhatsAppBotReply({ waId: '+970599111111', text: 'نفس الرد', replyForMessageId: 'wamid.in.1' })
    expect(first.claimed).toBe(true)
    const second = await claimWhatsAppBotReply({ waId: '+970599111111', text: 'نفس الرد', replyForMessageId: 'wamid.in.2', recentDuplicateWindowMs: 2 * 60 * 1000 })
    expect(second.claimed).toBe(false)
    expect(second.reason).toBe('RECENT_DUPLICATE_TEXT')
  })

  test('detects outbound bot echo by stored whatsappMessageId', async () => {
    const claim = await claimWhatsAppBotReply({ waId: '+970599111111', text: 'رد البوت', replyForMessageId: 'wamid.in.1' })
    expect(claim.claimed).toBe(true)
    await fakeDb.whatsAppConversationMessage.update({ where: { id: claim.message!.id }, data: { whatsappMessageId: 'wamid.out.1', status: 'SENT' } })
    await expect(isWhatsAppOutboundEcho('wamid.out.1', fakeDb)).resolves.toBe(true)
    await expect(isWhatsAppOutboundEcho('wamid.random', fakeDb)).resolves.toBe(false)
  })
})

describe('WhatsApp route and voice regressions (structural)', () => {
  test('preserves fromEncrypted outside redactDeep for cron recovery', () => {
    const route = source('src/app/api/webhooks/whatsapp/route.ts')
    expect(route).toContain('const fromEncrypted = encryptWhatsAppPhone(message.from) || null')
    expect(route).toContain('return { ...payload, message: { ...(payload?.message || {}), fromEncrypted } }')
    expect(route).toContain('decryptWhatsAppPhone(message?.fromEncrypted)')
  })

  test('uses reply claims, outbound echo guard, and disabled-AI handoff path', () => {
    const route = source('src/app/api/webhooks/whatsapp/route.ts')
    expect(route).toContain('claimWhatsAppBotReply')
    expect(route).toContain('replyForMessageId: message.id')
    expect(route).toContain('isWhatsAppOutboundEcho(message.id')
    expect(route).toContain('WHATSAPP_AI_DISABLED_HANDOFF')
    expect(route).toContain('WHATSAPP_AI_ENABLED')
  })

  test('voice transcription converts OGG/Opus before ASR and records failure reasons', () => {
    const asr = source('src/lib/asr.ts')
    const route = source('src/app/api/webhooks/whatsapp/route.ts')
    expect(asr).toContain('transcodeOggOpusToWavBase64')
    expect(asr).toContain('ffmpeg')
    expect(asr).toContain("mimeType: 'audio/wav'")
    expect(route).toContain('allowZaiFallback: true')
    expect(route).toContain('WHATSAPP_VOICE_TRANSCRIPTION_FAILED')
    expect(route).toContain('error: msg')
  })

  test('settings expose WhatsApp AI toggle and hash-secret warning', () => {
    expect(source('src/lib/settings.ts')).toContain("key: 'WHATSAPP_AI_ENABLED'")
    expect(source('src/components/aact/AdminExtras.tsx')).toContain("inputType === 'boolean'")
    expect(source('src/app/api/admin/system/route.ts')).toContain('WHATSAPP_HASH_SECRET غير موجود')
    expect(source('src/lib/whatsapp-privacy.ts')).toContain('export const whatsappWaIdHash = hashWhatsAppId')
  })
})
