/// <reference types="bun-types" />
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const COARENA_ID = 'CUSTOM_421999B38709'
const COARENA_BASE_URL = 'https://coarena.ai/api/v1'
const MOCK_KEY = 'coarena-test-key'
// The mocked /models payload the node:https mock serves. Tests switch it to
// [] to prove the admin's chosen model survives even when discovery lists
// nothing; null means "serve MODEL_ROWS".
let mockRows: any[] | null = null

const db: any = {
  aiUsageLog: { create: async () => ({}) },
  user: { findUnique: async () => null },
  keyRateWindow: {
    upsert: async () => ({}),
    findUnique: async () => ({ count: 1 }),
  },
  setting: {
    findMany: async () => [],
    findUnique: async () => null,
    upsert: async () => ({}),
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/settings', () => ({ getSetting: async (key: string) => values.get(key) || '' }))
// Custom providers validate the endpoint with a real DNS lookup (public
// addresses only), both at discovery and at call time. Point it at a public
// address in tests; the model rows and chat calls still go through the
// mocked fetch. The live HTTPS call path for custom providers cannot run in
// this sandbox, so routing is asserted at the modelFallbacks level below.
mock.module('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }))
// Custom providers do not use global fetch: __testFetchWithTimeout routes
// them through node:https with a pinned DNS lookup. Emulate that socket
// surface with the canned /models payload; the DNS assertion above still
// runs for real (assertPublicCustomTextAiUrl), and the live TLS path cannot
// run in this sandbox, so routing is asserted at the modelFallbacks level.
mock.module('node:https', () => ({
  request: (_url: any, _options: any, callback: any) => {
    type HttpsListener = (...args: any[]) => void
    const handlers: Record<string, HttpsListener[]> = {}
    const req: any = {
      on: (event: string, fn: HttpsListener) => { (handlers[event] ||= []).push(fn); return req },
      end: () => {
        queueMicrotask(() => {
          const body = JSON.stringify({ object: 'list', data: mockRows ?? MODEL_ROWS })
          const res: any = {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            resume: () => {},
            on: (event: string, fn: HttpsListener) => {
              if (event === 'data') queueMicrotask(() => fn(Buffer.from(body)))
              if (event === 'end') queueMicrotask(() => fn())
              return res
            },
          }
          callback(res)
        })
        return req
      },
      destroy: (err?: any) => {
        if (err) (handlers.error || []).forEach((fn) => fn(err))
        return req
      },
    }
    return req
  },
}))

const textAi = await import('../../src/lib/text-ai')

function makeStore(backing: Map<string, string>) {
  return {
    async read(keys: string[]) {
      return Object.fromEntries(keys.map((key) => [key, backing.get(key) || '']))
    },
    async write(key: string, value: string) {
      backing.set(key, value)
    },
    async delete(key: string) {
      backing.delete(key)
    },
    async scan(prefix: string) {
      return Object.fromEntries([...backing.entries()].filter(([key]) => key.startsWith(prefix)))
    },
    async increment(key: string, amount: number) {
      const next = (Number(backing.get(key) || 0) || 0) + amount
      backing.set(key, String(next))
      return next
    },
  }
}

const store = makeStore(values)

function configureCoarena(allowPaid: boolean, selectedModel = '') {
  values.set('AI_CUSTOM_PROVIDERS', JSON.stringify([
    { id: COARENA_ID, name: 'Coarena', baseUrl: COARENA_BASE_URL, enabled: true, selectedModel, allowPaid },
  ]))
  values.set(`AI_CUSTOM_KEY_${COARENA_ID}`, MOCK_KEY)
  values.set('AI_TEXT_PROVIDER', COARENA_ID)
}

const MODEL_ROWS = [
  { id: 'gemini-4-argon', object: 'model', context_length: 1000000, pricing: { prompt: '0.0000012', completion: '0.000006' } },
  { id: 'gemini-3-8-flash', object: 'model', context_length: 1000000, pricing: { prompt: '0.000001', completion: '0.000002' } },
  { id: 'free/test-model', object: 'model', context_length: 1000000, pricing: { prompt: '0', completion: '0' } },
  { id: 'text-embedding-3', object: 'model', context_length: 1000000 },
]

beforeEach(() => {
  values.clear()
  mockRows = null
  globalThis.fetch = originalFetch
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
})

afterAll(() => {
  globalThis.fetch = originalFetch
  textAi.__setTextAiSettingStoreForTests(null)
})

describe('custom provider paid models (allowPaid)', () => {
  test('parse keeps allowPaid and defaults a missing flag to false', () => {
    const parsed = textAi.parseCustomTextAiProviders(JSON.stringify([
      { id: COARENA_ID, name: 'Coarena', baseUrl: COARENA_BASE_URL, enabled: true, selectedModel: '', allowPaid: true },
      { id: 'CUSTOM_AAAAAAAAAAAAAAAA', name: 'Other', baseUrl: 'https://api.other-provider.com/v1', enabled: true, selectedModel: '' },
    ]))
    expect(parsed).toHaveLength(2)
    expect(parsed[0].allowPaid).toBe(true)
    expect(parsed[1].allowPaid).toBe(false)
  })

  test('free-only by default: priced Coarena models stay out of the catalog', async () => {
    configureCoarena(false)
    const catalog = await textAi.textAiFreeModelsForProvider(COARENA_ID)
    expect(catalog.models).toEqual(['free/test-model'])
    expect(catalog.models).not.toContain('gemini-4-argon')
    expect(catalog.discoveredCount).toBe(1)
    expect(catalog.message).toContain('نموذج مجاني مؤكد')
  })

  test('allowPaid lists the whole priced catalog, still dropping non-chat models', async () => {
    configureCoarena(true)
    const catalog = await textAi.textAiFreeModelsForProvider(COARENA_ID)
    expect(catalog.models).toContain('gemini-4-argon')
    expect(catalog.models).toContain('gemini-3-8-flash')
    expect(catalog.models).toContain('free/test-model')
    expect(catalog.models).not.toContain('text-embedding-3')
    expect(catalog.discoveredCount).toBe(3)
    expect(catalog.message).toContain('نموذج متاح')
  })

  test('routing fallback keeps the chosen paid model when allowPaid is on', async () => {
    configureCoarena(true, 'gemini-4-argon')
    const models = await textAi.__testModelFallbacksForTests(COARENA_ID)
    expect(models).toContain('gemini-4-argon')
    expect(models[0]).toBe('gemini-4-argon')
    expect(models).toContain('free/test-model')
    expect(models).not.toContain('text-embedding-3')
  })

  test('routing fallback never keeps a priced model when allowPaid is off, even if selected', async () => {
    configureCoarena(false, 'gemini-4-argon')
    const models = await textAi.__testModelFallbacksForTests(COARENA_ID)
    expect(models).toEqual(['free/test-model'])
    expect(models).not.toContain('gemini-4-argon')
  })

  test('the chosen paid model survives in the catalog even when discovery lists nothing', async () => {
    configureCoarena(true, 'gemini-4-argon')
    mockRows = []
    const catalog = await textAi.textAiFreeModelsForProvider(COARENA_ID)
    expect(catalog.models).toEqual(['gemini-4-argon'])
  })

  test('the chosen paid model survives in the routing fallback even when discovery lists nothing', async () => {
    configureCoarena(true, 'gemini-4-argon')
    mockRows = []
    const models = await textAi.__testModelFallbacksForTests(COARENA_ID)
    expect(models).toEqual(['gemini-4-argon'])
  })
})
