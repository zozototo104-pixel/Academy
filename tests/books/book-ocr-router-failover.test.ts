/// <reference types="bun-types" />
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { looksLikeBrokenBookPageText } from '../../src/lib/academic-output-quality'

// Part 2: the router `validate` rejection of a garbled OCR answer must make
// the router try the NEXT model (bot commit 150eebe3 moved the quality check
// into the validate callback). This drives the REAL router with stubbed
// HTTP, exactly like tests/ai/ai-apinex-provider.test.ts.
const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const MOCK_APINEX_TOKEN = 'apinex-test-token-000000000000000000000000000000'
const APINEX_BASE_URL = 'https://api.apinex.bond/v1'
const APINEX_FREE_MODELS = ['free/gemini-3.8-flash', 'free/deepseek-v4.1-flash']

const db: any = {
  aiUsageLog: { create: async () => ({}) },
  user: { findUnique: async () => null },
  keyRateWindow: { upsert: async () => ({}), findUnique: async () => ({ count: 1 }) },
  setting: { findMany: async () => [], findUnique: async () => null, upsert: async () => ({}) },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/settings', () => ({ getSetting: async (key: string) => values.get(key) || '' }))

const textAi = await import('../../src/lib/text-ai')

function makeStore(backing: Map<string, string>) {
  return {
    async read(keys: string[]) { return Object.fromEntries(keys.map((key) => [key, backing.get(key) || ''])) },
    async write(key: string, value: string) { backing.set(key, value) },
    async delete(key: string) { backing.delete(key) },
    async scan(prefix: string) { return Object.fromEntries([...backing.entries()].filter(([key]) => key.startsWith(prefix))) },
    async increment(key: string, amount: number) {
      const next = (Number(backing.get(key) || 0) || 0) + amount
      backing.set(key, String(next))
      return next
    },
  }
}

const store = makeStore(values)

const cleanPage = 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية. '.repeat(50)
const garbledPage = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)
const cleanOcrJson = JSON.stringify({ pages: [{ page: 1, text: cleanPage }] })
const garbledOcrJson = JSON.stringify({ pages: [{ page: 1, text: garbledPage }] })

// Same rule as the reader's parsePages validate: a broken page fails the
// model call so failover gets its chance.
function ocrValidate(raw: string) {
  const parsed = JSON.parse(String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim())
  const text = String(parsed?.pages?.[0]?.text || '')
  if (text.trim() && looksLikeBrokenBookPageText(text)) throw new Error('OCR_TEXT_FAILED_VERIFICATION')
}

beforeEach(() => {
  values.clear()
  globalThis.fetch = originalFetch
  delete process.env.APINEX_API_KEYS
  delete process.env.APINEX_API_KEY
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
  values.set('AI_TEXT_PROVIDER', 'APINEX')
  process.env.APINEX_API_KEYS = MOCK_APINEX_TOKEN
  values.set('APINEX_TEXT_MODEL', 'free/gemini-3.8-flash')
  values.set('APINEX_BASE_URL', APINEX_BASE_URL)
})

afterAll(() => {
  globalThis.fetch = originalFetch
  textAi.__setTextAiSettingStoreForTests(null)
  delete process.env.APINEX_API_KEYS
  delete process.env.APINEX_API_KEY
})

function stubFetch(chatReply: (model: string) => string) {
  const chatRequests: { model: string }[] = []
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url)
    if (urlText.endsWith('/models')) {
      return new Response(JSON.stringify({ data: APINEX_FREE_MODELS.map((id) => ({ id, context_length: 1000000 })) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (urlText.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body || '{}'))
      chatRequests.push({ model: String(body.model || '') })
      return new Response(JSON.stringify({ choices: [{ message: { content: chatReply(String(body.model || '')) } }] }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-test' } })
    }
    throw new Error(`unexpected fetch: ${urlText}`)
  }) as any
  return chatRequests
}

const preferredModels = [
  { provider: 'APINEX', model: 'free/gemini-3.8-flash' },
  { provider: 'APINEX', model: 'free/deepseek-v4.1-flash' },
] as const

describe('router failover on garbled OCR validate rejection', () => {
  test('a garbled first model is skipped and the next model answers cleanly', async () => {
    const chatRequests = stubFetch((model) => (model === 'free/gemini-3.8-flash' ? garbledOcrJson : cleanOcrJson))
    const result = await textAi.textAiCompleteJsonWithMetadata({
      system: 'أنت محرك OCR حرفي.',
      history: [{ role: 'user', text: 'اقرأ الصفحة.' }],
      purpose: 'VISION',
      routerPolicy: 'primary_first',
      preferredModels: [...preferredModels],
      restrictToModels: [...preferredModels],
      maxOutputTokens: 16000,
      deadlineMs: Date.now() + 90_000,
      validate: ocrValidate,
    })
    expect(result.text).toBe(cleanOcrJson)
    expect(result.model).toBe('free/deepseek-v4.1-flash')
    expect(chatRequests.map((request) => request.model)).toEqual(['free/gemini-3.8-flash', 'free/deepseek-v4.1-flash'])
  })

  test('when every model answers garbled text the call fails honestly instead of saving garbage', async () => {
    const chatRequests = stubFetch(() => garbledOcrJson)
    await expect(textAi.textAiCompleteJsonWithMetadata({
      system: 'أنت محرك OCR حرفي.',
      history: [{ role: 'user', text: 'اقرأ الصفحة.' }],
      purpose: 'VISION',
      routerPolicy: 'primary_first',
      preferredModels: [...preferredModels],
      restrictToModels: [...preferredModels],
      maxOutputTokens: 16000,
      deadlineMs: Date.now() + 90_000,
      validate: ocrValidate,
    })).rejects.toThrow('OCR_TEXT_FAILED_VERIFICATION')
    expect(chatRequests.map((request) => request.model)).toEqual(['free/gemini-3.8-flash', 'free/deepseek-v4.1-flash'])
  })
})
