/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Guard: WhatsApp inbound event claim + delivery statuses.
// - An event stuck in PROCESSING longer than the stale threshold (its
//   processor died before writing a result) must be reclaimable — the
//   retry predicate already reschedules it, so the claim must agree or
//   the message is lost forever. A fresh PROCESSING event (a live
//   processor owns it) must NOT be claimable.
// - Meta delivery statuses (sent/delivered/read/failed) are written to
//   the matching outbound message row, monotonically: no downgrades,
//   FAILED is terminal, a failure keeps its error in meta.

function matchesWhere(row: any, where: any): boolean {
  for (const [key, cond] of Object.entries(where || {})) {
    if (key === 'OR') { if (!(cond as any[]).some((w) => matchesWhere(row, w))) return false; continue }
    const actual = row[key]
    if (cond === null) { if (actual !== null && actual !== undefined) return false; continue }
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in (cond as any)) { if (!(cond as any).in.includes(actual)) return false } else if ('lt' in (cond as any)) { if (!(actual < (cond as any).lt)) return false } else if ('gt' in (cond as any)) { if (!(actual > (cond as any).gt)) return false }
      continue
    }
    if (actual !== cond) return false
  }
  return true
}

function applyData(row: any, data: any) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as any)) row[k] = (row[k] || 0) + (v as any).increment
    else row[k] = v
  }
}

let events: Map<string, any>
let conversationMessages: any[]
let eventUpdateCalls: any[]
let humanActive = true

const db: any = {
  auditLog: { create: async () => ({}) },
  whatsAppInboundEvent: {
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const event of events.values()) {
        if (!matchesWhere(event, where)) continue
        applyData(event, data)
        event.updatedAt = new Date()
        count++
      }
      return { count }
    },
    findUnique: async ({ where }: any) => events.get(where.id) ?? null,
    update: async ({ where, data }: any) => {
      eventUpdateCalls.push({ where, data })
      const event = events.get(where.id)
      if (event) applyData(event, data)
      return event ?? {}
    },
  },
  whatsAppConversationMessage: {
    findFirst: async ({ where }: any) => conversationMessages.find((m) => matchesWhere(m, where)) ?? null,
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const m of conversationMessages) {
        if (!matchesWhere(m, where)) continue
        applyData(m, data)
        count++
      }
      return { count }
    },
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/asr', () => ({ transcribeAudioBase64: async () => '' }))
mock.module('@/lib/human-handoff', () => ({
  analyzeHumanHandoffIntent: async () => ({ isHandoffDetails: false, wantsHumanSupport: false, confidence: 0 }),
  createHumanHandoffRequest: async () => ({ id: 'handoff-1' }),
  hasOpenHumanHandoffRequest: async () => false,
}))
mock.module('@/lib/whatsapp-cloud', () => ({
  createOfficialWhatsAppAgentReply: async () => 'رد آلي',
  sanitizeWhatsAppBotReply: (text: string) => ({ text, stripped: false }),
  extractWhatsAppInboundMessages: () => [],
  officialWhatsAppConfigured: () => true,
  sendOfficialWhatsAppReadReceipt: async () => null,
  sendOfficialWhatsAppText: async () => ({ messages: [{ id: 'wamid.out' }] }),
  sendOfficialWhatsAppTypingIndicator: async () => null,
  verifyWhatsAppSignature: () => true,
}))
mock.module('@/lib/whatsapp-conversations', () => ({
  isWhatsAppConversationHumanActive: async () => humanActive,
  markWhatsAppConversationRequested: async () => {},
  recordWhatsAppInboundMessage: async () => ({ conversation: null, message: null }),
  recordWhatsAppOutboundMessage: async () => ({}),
}))
mock.module('@/lib/whatsapp-media', () => ({
  downloadOfficialWhatsAppMediaBase64: async () => '',
  getOfficialWhatsAppMediaInfo: async () => ({}),
}))
mock.module('@/lib/whatsapp-privacy', () => ({
  decryptWhatsAppPhone: () => '',
  encryptWhatsAppPhone: () => null,
  maskWhatsAppPhone: () => '***',
  whatsappWaIdHash: (value: string) => `hash:${value}`,
}))
mock.module('@/lib/secret-crypto', () => ({ redactDeep: (value: any) => value }))

const route = await import('../../src/app/api/webhooks/whatsapp/route')

function makeEvent(id: string, status: string, updatedAt: Date) {
  events.set(id, {
    id,
    waMessageId: `wamid.${id}`,
    status,
    attempts: 0,
    updatedAt,
    payload: { message: { id: `wamid.${id}`, from: '970599000000', text: 'مرحبا', rawType: 'text' } },
  })
}

beforeEach(() => {
  events = new Map()
  conversationMessages = []
  eventUpdateCalls = []
  humanActive = true
})

describe('WhatsApp inbound event claim', () => {
  test('a stale PROCESSING event is reclaimed and processed (not lost)', async () => {
    makeEvent('ev-stale', 'PROCESSING', new Date(Date.now() - 11 * 60 * 1000))
    await route.__processWhatsAppEventForTests('ev-stale')
    const event = events.get('ev-stale')
    expect(event.attempts).toBe(1)
    // عولجت حتى النهاية: المحادثة بيد إنسان ⇒ SKIPPED مكتوب على الحدث
    expect(event.status).toBe('SKIPPED')
    expect(eventUpdateCalls.some((c) => c.data.status === 'SKIPPED')).toBe(true)
  })

  test('a fresh PROCESSING event is NOT claimed (a live processor owns it)', async () => {
    makeEvent('ev-fresh', 'PROCESSING', new Date())
    await route.__processWhatsAppEventForTests('ev-fresh')
    const event = events.get('ev-fresh')
    expect(event.attempts).toBe(0)
    expect(event.status).toBe('PROCESSING')
    expect(eventUpdateCalls).toHaveLength(0)
  })

  test('RECEIVED and FAILED events still claim as before', async () => {
    makeEvent('ev-received', 'RECEIVED', new Date())
    makeEvent('ev-failed', 'FAILED', new Date())
    await route.__processWhatsAppEventForTests('ev-received')
    await route.__processWhatsAppEventForTests('ev-failed')
    expect(events.get('ev-received').status).toBe('SKIPPED')
    expect(events.get('ev-failed').status).toBe('SKIPPED')
  })
})

describe('WhatsApp delivery statuses', () => {
  function seedMessage(status: string, meta: any = { phoneNumberId: 'pn-1' }) {
    conversationMessages = [{ id: 'msg-1', whatsappMessageId: 'wamid.out-1', status, meta }]
    return conversationMessages[0]
  }

  test('progression SENT → DELIVERED → READ lands on the row', async () => {
    const msg = seedMessage('SENT')
    await route.__applyWhatsAppDeliveryStatusesForTests([{ id: 'wamid.out-1', status: 'delivered', errors: [] }])
    expect(msg.status).toBe('DELIVERED')
    await route.__applyWhatsAppDeliveryStatusesForTests([{ id: 'wamid.out-1', status: 'read', errors: [] }])
    expect(msg.status).toBe('READ')
  })

  test('no downgrade: DELIVERED after READ is ignored', async () => {
    const msg = seedMessage('READ')
    await route.__applyWhatsAppDeliveryStatusesForTests([{ id: 'wamid.out-1', status: 'delivered', errors: [] }])
    expect(msg.status).toBe('READ')
  })

  test('FAILED records the Meta error in meta and keeps prior meta keys', async () => {
    const msg = seedMessage('SENT')
    await route.__applyWhatsAppDeliveryStatusesForTests([
      { id: 'wamid.out-1', status: 'failed', errors: [{ code: 131049, title: 'Meta policy', message: 'blocked' }] },
    ])
    expect(msg.status).toBe('FAILED')
    expect(msg.meta.phoneNumberId).toBe('pn-1')
    expect(msg.meta.deliveryError[0].code).toBe(131049)
    expect(msg.meta.deliveryFailedAt).toBeTruthy()
  })

  test('FAILED is terminal and a failure after READ is ignored', async () => {
    const failedMsg = seedMessage('FAILED')
    await route.__applyWhatsAppDeliveryStatusesForTests([{ id: 'wamid.out-1', status: 'delivered', errors: [] }])
    expect(failedMsg.status).toBe('FAILED')
    const readMsg = seedMessage('READ')
    await route.__applyWhatsAppDeliveryStatusesForTests([
      { id: 'wamid.out-1', status: 'failed', errors: [{ code: 1, title: 'x', message: 'y' }] },
    ])
    expect(readMsg.status).toBe('READ')
  })

  test('unknown message ids and unknown statuses are skipped silently', async () => {
    seedMessage('SENT')
    await route.__applyWhatsAppDeliveryStatusesForTests([
      { id: 'wamid.missing', status: 'delivered', errors: [] },
      { id: 'wamid.out-1', status: 'played', errors: [] },
    ])
    expect(conversationMessages[0].status).toBe('SENT')
  })
})
