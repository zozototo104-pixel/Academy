import { readFileSync } from 'fs'
import { __resolveWhatsAppBotReplyForTests } from '../src/app/api/webhooks/whatsapp/route'
import type { WhatsAppInboundMessage } from '../src/lib/whatsapp-cloud'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

type Intent = 'REQUEST_OFFICIAL_CONTACT' | 'PROVIDED_OWN_CONTACT' | 'HANDOFF_DETAILS' | 'HUMAN_HANDOFF' | 'QUERY'

const FIXED_REPLY_SNIPPETS = [
  'عنوان الأكاديمية الرسمي بحسب إعدادات الأكاديمية',
  'بيانات التواصل الرسمية للأكاديمية',
  'استلمنا رقمك أو بيانات تواصلك',
  'تم استلام طلبك وتحويله لفريق الإدارة',
  'أستطيع قراءة الرسائل النصية فقط',
]

function message(partial: Partial<WhatsAppInboundMessage>): WhatsAppInboundMessage {
  return {
    id: partial.id || `wamid-${Math.random().toString(36).slice(2)}`,
    from: partial.from || '15551234567',
    text: partial.text || '',
    name: partial.name || 'زائر',
    phoneNumberId: partial.phoneNumberId || 'phone-1',
    rawType: partial.rawType || 'text',
    mediaId: partial.mediaId,
    mediaMimeType: partial.mediaMimeType,
    mediaSha256: partial.mediaSha256,
    mediaFileSize: partial.mediaFileSize,
    isVoice: partial.isVoice,
    originKind: partial.originKind || (partial.rawType === 'audio' ? 'VOICE' : 'TEXT'),
  }
}

async function assertModelOnlyCase(name: string, input: Partial<WhatsAppInboundMessage>, intent: Intent, options: { expectHandoff?: boolean; contextFlags?: Record<string, unknown>; expectContext?: string[] } = {}) {
  let modelCalls = 0
  let handoffCalls = 0
  let markCalls = 0
  const reply = await __resolveWhatsAppBotReplyForTests(message(input), null, {
    hasRecentAudit: async () => false,
    hasOpenHandoff: async () => false,
    audit: async () => {},
    classifyRoutingIntent: async () => ({ intent, confidence: 0.99, reason: `test:${name}` } as any),
    createHandoff: async () => {
      handoffCalls += 1
      return { id: `handoff-${name}` } as any
    },
    markRequested: async () => {
      markCalls += 1
    },
    createAgentReply: async (_message, extraContext) => {
      modelCalls += 1
      assert(typeof extraContext === 'string' && extraContext.includes(intent), `${name}: model must receive routing context`)
      return `MODEL_ONLY_REPLY:${name}:${modelCalls}`
    },
  })
  assert(modelCalls === 1, `${name}: exactly one model call is required`)
  assert(reply === `MODEL_ONLY_REPLY:${name}:1`, `${name}: reply must come from the model stub`)
  assert(FIXED_REPLY_SNIPPETS.every((snippet) => !reply.includes(snippet)), `${name}: reply must not be a fixed canned text`)
  if (options.expectHandoff) {
    assert(handoffCalls === 1, `${name}: handoff request must be created before model reply`)
    assert(markCalls === 1, `${name}: WhatsApp conversation must be marked as requested`)
  } else {
    assert(handoffCalls === 0, `${name}: must not create handoff request`)
  }
}

function testWhatsAppSourceWiring() {
  const route = readFileSync('src/app/api/webhooks/whatsapp/route.ts', 'utf8')
  assert(!route.includes('getHumanHandoffConfirmationReply'), 'WhatsApp route must not import or call getHumanHandoffConfirmationReply')
  const cloud = readFileSync('src/lib/whatsapp-cloud.ts', 'utf8')
  assert(cloud.includes('createOfficialWhatsAppAgentReply(message: WhatsAppInboundMessage, extraContext?: string)'), 'WhatsApp model reply must accept optional extraContext')
  assert(cloud.includes('سياق داخلي إضافي للنموذج فقط وليس رداً جاهزاً: ${extraContext}'), 'WhatsApp extraContext must be passed into uiContext')
}

async function main() {
  testWhatsAppSourceWiring()
  await assertModelOnlyCase('greeting', { text: 'السلام عليكم' }, 'QUERY')
  await assertModelOnlyCase('official-contact', { text: 'ممكن رقم التواصل؟' }, 'REQUEST_OFFICIAL_CONTACT')
  await assertModelOnlyCase('program-books', { text: 'شو الكتب المقررة لدبلوم الإسعاف النفسي؟' }, 'QUERY')
  await assertModelOnlyCase('human-handoff', { text: 'بدي موظف يحكيني' }, 'HUMAN_HANDOFF', { expectHandoff: true })
  await assertModelOnlyCase('image', { text: '', rawType: 'image', mediaMimeType: 'image/jpeg' }, 'QUERY')
  console.log('✓ WhatsApp model-only reply checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
