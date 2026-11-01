import { readFileSync } from 'fs'
import { __resolveWhatsAppBotReplyForTests } from '../src/app/api/webhooks/whatsapp/route'
import { sanitizeWhatsAppBotReply, WHATSAPP_IDENTITY_FALLBACK_REPLY, type WhatsAppInboundMessage } from '../src/lib/whatsapp-cloud'

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
      assert(typeof extraContext === 'string', `${name}: model must receive explicit context`)
      const context = String(extraContext ?? '')
      for (const expected of options.expectContext || []) assert(context.includes(expected), `${name}: model context must include ${expected}`)
      return `MODEL_ONLY_REPLY:${name}:${modelCalls}`
    },
    contextFlags: options.contextFlags as any,
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

// The bot once told a WhatsApp visitor "I am DeepSeek-V4-Flash, developed
// by DeepSeek." These cases drive the real resolver with a stub model reply
// and assert the identity guard strips model/provider self-identification
// before anything can be sent, while normal replies pass through untouched.
async function assertIdentityGuardCase(name: string, stubReply: string, expect: { mustNotInclude: string[]; mustInclude?: string[]; exact?: string }) {
  const reply = await __resolveWhatsAppBotReplyForTests(message({ text: 'السلام عليكم' }), null, {
    hasRecentAudit: async () => false,
    hasOpenHandoff: async () => false,
    audit: async () => {},
    classifyRoutingIntent: async () => ({ intent: 'QUERY', confidence: 0.99, reason: `test:${name}` } as any),
    createHandoff: async () => ({ id: `handoff-${name}` } as any),
    markRequested: async () => {},
    createAgentReply: async () => stubReply,
  })
  for (const forbidden of expect.mustNotInclude) assert(!reply.includes(forbidden), `${name}: reply must not include "${forbidden}" (got: ${reply})`)
  for (const expected of expect.mustInclude || []) assert(reply.includes(expected), `${name}: reply must keep "${expected}" (got: ${reply})`)
  if (expect.exact) assert(reply === expect.exact, `${name}: reply must be exactly the safe fallback (got: ${reply})`)
}

async function testIdentityGuard() {
  await assertIdentityGuardCase(
    'incident-deepseek-prefix',
    'I am DeepSeek-V4-Flash, developed by DeepSeek.\nالسلام عليكم، كيف يمكنني مساعدتك اليوم؟',
    { mustNotInclude: ['DeepSeek'], mustInclude: ['كيف يمكنني مساعدتك اليوم'] },
  )
  await assertIdentityGuardCase(
    'identity-only-becomes-fallback',
    'I am DeepSeek-V4-Flash, developed by DeepSeek.',
    { mustNotInclude: ['DeepSeek'], exact: WHATSAPP_IDENTITY_FALLBACK_REPLY },
  )
  await assertIdentityGuardCase(
    'english-language-model',
    "I'm a large language model developed by Google. How can I help you with our programs?",
    { mustNotInclude: ['Google', 'language model'], mustInclude: ['How can I help you'] },
  )
  await assertIdentityGuardCase(
    'arabic-model-claim',
    'أنا نموذج ذكاء اصطناعي تم تطويري بواسطة فريق خارجي. أهلاً بك في الأكاديمية، كيف أخدمك؟',
    { mustNotInclude: ['نموذج ذكاء اصطناعي', 'تطويري'], mustInclude: ['أهلاً بك في الأكاديمية'] },
  )
  await assertIdentityGuardCase(
    'normal-reply-untouched',
    'السلام عليكم، لدينا دبلوم إدارة الأزمات والكوارث، ويمكنك التسجيل من صفحة البرنامج.',
    { mustNotInclude: [], exact: 'السلام عليكم، لدينا دبلوم إدارة الأزمات والكوارث، ويمكنك التسجيل من صفحة البرنامج.' },
  )

  const direct = sanitizeWhatsAppBotReply('أنا الوكيل الذكي للأكاديمية. رسوم الدبلوم 300 دولار.')
  assert(direct.stripped === false, 'sanitizer: academy identity + normal content must not be flagged')
  const stripped = sanitizeWhatsAppBotReply('Powered by OpenAI technology. أهلاً بك.')
  assert(stripped.stripped === true && !stripped.text.includes('OpenAI'), 'sanitizer: powered-by segment must be stripped')
}

function testWhatsAppSourceWiring() {
  const route = readFileSync('src/app/api/webhooks/whatsapp/route.ts', 'utf8')
  assert(!route.includes('getHumanHandoffConfirmationReply'), 'WhatsApp route must not import or call getHumanHandoffConfirmationReply')
  const cloud = readFileSync('src/lib/whatsapp-cloud.ts', 'utf8')
  assert(cloud.includes('createOfficialWhatsAppAgentReply(message: WhatsAppInboundMessage, extraContext?: string)'), 'WhatsApp model reply must accept optional extraContext')
  assert(cloud.includes('سياق داخلي إضافي للنموذج فقط وليس رداً جاهزاً: ${extraContext}'), 'WhatsApp extraContext must be passed into uiContext')
  assert(cloud.includes('WHATSAPP_MODEL_UNAVAILABLE_REPLY'), 'WhatsApp must reject the fixed platform unavailable reply instead of sending it')
  assert(!route.includes('sendFallbackAndRequestHuman') && !route.includes('WHATSAPP_AI_FALLBACK_REPLY'), 'WhatsApp route must not send fixed fallback text when all models fail')
  assert(route.includes('sanitizeWhatsAppBotReply(rawReply)'), 'WhatsApp route must pass every bot reply through the identity guard before sending')
  assert(cloud.includes('export function sanitizeWhatsAppBotReply'), 'WhatsApp cloud must export the identity guard sanitizer')
}

async function main() {
  testWhatsAppSourceWiring()
  await testIdentityGuard()
  await assertModelOnlyCase('greeting', { text: 'السلام عليكم' }, 'QUERY')
  await assertModelOnlyCase('official-contact', { text: 'ممكن رقم التواصل؟' }, 'REQUEST_OFFICIAL_CONTACT', { expectContext: ['contactRequested=true'] })
  await assertModelOnlyCase('program-books', { text: 'شو الكتب المقررة لدبلوم الإسعاف النفسي؟' }, 'QUERY', { expectContext: ['contactRequested=false'] })
  await assertModelOnlyCase('human-handoff', { text: 'بدي موظف يحكيني' }, 'HUMAN_HANDOFF', { expectHandoff: true, expectContext: ['handoffCreated=true'] })
  await assertModelOnlyCase('voice-failed', { text: '🎤 رسالة صوتية تعذر تفريغها إلى نص.', rawType: 'audio', isVoice: true, originKind: 'VOICE' }, 'QUERY', { contextFlags: { voiceNotTranscribed: true, nonTextMessage: 'audio' }, expectContext: ['voiceNotTranscribed=true', 'nonTextMessage=audio'] })
  await assertModelOnlyCase('image', { text: '', rawType: 'image', mediaMimeType: 'image/jpeg' }, 'QUERY', { contextFlags: { nonTextMessage: 'image' }, expectContext: ['nonTextMessage=image'] })
  console.log('✓ WhatsApp model-only reply checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
