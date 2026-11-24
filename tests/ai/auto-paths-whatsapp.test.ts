/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 7f — WhatsApp / public agent (platform-agent.ts).
// OFF: today's order — GEMINI_DIRECT first on WhatsApp, then local,
// then the router (via chatComplete). ON: GEMINI_DIRECT is skipped
// entirely; the router call (taskType WHATSAPP) is the provider path;
// the local open-source path stays as configured and human-handoff
// intents are still decided before any model attempt.
import { resolvePlatformAgentAttemptOrder } from '../../src/lib/ai-auto-mode'

let autoMode = false
const geminiDirectCalls: Array<unknown> = []
const classifierCalls: Array<unknown> = []
const chatCompleteCalls: Array<{ taskType?: string; skipGemini?: boolean }> = []

function tableStub(): any {
  return {
    findMany: async () => [],
    findUnique: async () => null,
    findFirst: async () => null,
    create: async () => ({}),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    upsert: async () => ({}),
    count: async () => 0,
    deleteMany: async () => ({ count: 0 }),
    aggregate: async () => ({ _sum: {}, _count: 0 }),
  }
}
const db: any = new Proxy({}, {
  get: (_target, prop) => {
    if (prop === 'then') return undefined
    if (prop === '$transaction') return async (ops: any) => (Array.isArray(ops) ? ops.map(() => ({})) : {})
    if (prop === '$queryRaw' || prop === '$executeRaw') return async () => []
    return tableStub()
  },
})
mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/settings', () => ({
  getSettings: async () => ({}),
  getSetting: async () => '',
  getOfficialContact: async () => ({ email: '', whatsapp: '' }),
}))
mock.module('@/lib/gemini', () => ({
  ensureGeminiKey: async () => true,
  geminiActiveTextModel: async () => 'gemini-3.5-flash-lite',
  geminiDiscussionThinkingLevel: async () => 'high',
  geminiComplete: async (opts: any) => {
    geminiDirectCalls.push(opts)
    return 'gemini-public-reply'
  },
  geminiCompleteJson: async (opts: any) => {
    classifierCalls.push(opts)
    return JSON.stringify({ intent: 'GENERAL_SUPPORT', confidence: 0.8, suggestedAgent: 'ADMISSIONS', responseDepth: 'normal' })
  },
  geminiStreamText: async function* () { yield 'x' },
}))
mock.module('@/lib/text-ai', () => ({
  textAiComplete: async () => 'router-reply',
  textAiCompleteJson: async () => '{"ok":true}',
  textAiDiagnostics: () => ({}),
  textAiModelHealthSnapshot: async () => ({}),
  isTextAiAutoModeEnabled: async () => autoMode,
}))
mock.module('@/lib/ai', () => ({
  OFFICIAL_INFO_UNAVAILABLE_REPLY: 'unavailable',
  chatComplete: async (_messages: any, _context: any, _persona: any, opts: any) => {
    chatCompleteCalls.push({ taskType: opts?.taskType, skipGemini: opts?.skipGemini })
    return 'router-public-reply'
  },
  buildSupervisorSystemPrompt: () => '',
  buildSupervisorPersonaBlock: () => '',
}))
mock.module('@/lib/open-source-llm', () => ({
  localAgentConfig: async () => ({ enabled: false }),
  localChatComplete: async () => 'local-reply',
}))

const { platformPublicAgentComplete } = await import('../../src/lib/platform-agent')

const QUESTION = [{ role: 'user', content: 'كيف أذاكر بفعالية قبل الامتحان؟' }]

beforeEach(() => {
  autoMode = false
  geminiDirectCalls.length = 0
  classifierCalls.length = 0
  chatCompleteCalls.length = 0
})

describe('platform attempt order (pure decision, step 7f)', () => {
  test('OFF WhatsApp: GEMINI_DIRECT first, then local, then router', () => {
    expect(resolvePlatformAgentAttemptOrder({ autoMode: false, channel: 'WHATSAPP', shouldPreferGemini: true, localEnabled: true }))
      .toEqual(['GEMINI_DIRECT', 'LOCAL_OPEN_SOURCE', 'ROUTER'])
  })

  test('OFF web without preference: local, then GEMINI_DIRECT, then router', () => {
    expect(resolvePlatformAgentAttemptOrder({ autoMode: false, channel: 'WEB_WIDGET', shouldPreferGemini: false, localEnabled: true }))
      .toEqual(['LOCAL_OPEN_SOURCE', 'GEMINI_DIRECT', 'ROUTER'])
  })

  test('ON WhatsApp: no GEMINI_DIRECT at all; local stays, router last', () => {
    expect(resolvePlatformAgentAttemptOrder({ autoMode: true, channel: 'WHATSAPP', shouldPreferGemini: true, localEnabled: true }))
      .toEqual(['LOCAL_OPEN_SOURCE', 'ROUTER'])
  })

  test('ON with local disabled: router only', () => {
    expect(resolvePlatformAgentAttemptOrder({ autoMode: true, channel: 'WHATSAPP', shouldPreferGemini: true, localEnabled: false }))
      .toEqual(['ROUTER'])
  })
})

describe('platformPublicAgentComplete under auto mode (step 7f)', () => {
  test('OFF WhatsApp: GEMINI_DIRECT answers first; chatComplete never reached', async () => {
    const result = await platformPublicAgentComplete({ messages: QUESTION as any, channel: 'WHATSAPP' })
    expect(result.reply).toContain('gemini-public-reply')
    expect(geminiDirectCalls.length).toBeGreaterThanOrEqual(1)
    expect(chatCompleteCalls.length).toBe(0)
  })

  test('ON WhatsApp: GEMINI_DIRECT skipped; router via chatComplete with taskType WHATSAPP', async () => {
    autoMode = true
    const result = await platformPublicAgentComplete({ messages: QUESTION as any, channel: 'WHATSAPP' })
    expect(result.reply).toContain('router-public-reply')
    expect(geminiDirectCalls.length).toBe(0)
    expect(chatCompleteCalls.length).toBe(1)
    expect(chatCompleteCalls[0]?.taskType).toBe('WHATSAPP')
    expect(chatCompleteCalls[0]?.skipGemini).toBe(true)
  })

  test('ON WhatsApp: the intent classifier still runs (governed shim, ANALYSIS)', async () => {
    autoMode = true
    await platformPublicAgentComplete({ messages: QUESTION as any, channel: 'WHATSAPP' })
    expect(classifierCalls.length).toBe(1)
    expect((classifierCalls[0] as any)?.purpose).toBe('ANALYSIS')
    expect((classifierCalls[0] as any)?.taskType).toBe('INTENT_CLASSIFICATION')
  })
})
