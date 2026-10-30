/// <reference types="bun-types" />
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const originalEnv: Record<string, string | undefined> = {
  OXION_API_KEYS: process.env.OXION_API_KEYS,
  OXION_API_KEY: process.env.OXION_API_KEY,
}
const MOCK_OXION_TOKEN = 'cc_mock_oxion_token_0123456789abcdef0123456789abcdef'
const OXION_BASE_URL = 'https://www.oxionai.com/v1'

// Provisional static fallback list (flagship IDs from Oxion's published
// catalog names). The live /models discovery is the real source once the
// account key is configured; this list only covers discovery failures.
const OXION_STATIC_MODELS = [
  'claude-sonnet-5',
  'gpt-5.6',
  'gemini-3.1-pro',
  'deepseek-v4',
  'kimi-k3',
  'grok-4.6',
]

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

const textAi = await import('../../src/lib/text-ai')
const { KNOWN_AI_PROVIDERS } = await import('../../src/lib/ai-stage-profiles')

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

function configureOxion() {
  values.set('AI_TEXT_PROVIDER', 'OXION')
  process.env.OXION_API_KEYS = MOCK_OXION_TOKEN
  values.set('OXION_TEXT_MODEL', 'claude-sonnet-5')
  values.set('OXION_BASE_URL', OXION_BASE_URL)
}

beforeEach(() => {
  values.clear()
  globalThis.fetch = originalFetch
  delete process.env.OXION_API_KEYS
  delete process.env.OXION_API_KEY
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
})

afterAll(() => {
  globalThis.fetch = originalFetch
  textAi.__setTextAiSettingStoreForTests(null)
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('OXION text provider', () => {
  test('chat routes to the selected model with the Oxion key', async () => {
    configureOxion()
    const chatRequests: any[] = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization || '')
      if (urlText.endsWith('/models')) {
        return new Response(JSON.stringify({ data: OXION_STATIC_MODELS.map((id) => ({ id, context_length: 1000000 })) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (urlText.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body || '{}'))
        chatRequests.push({ url: urlText, auth, body })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-oxion' } })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any

    const reply = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hello' }], maxOutputTokens: 16 })
    expect(reply).toBe('ok')
    expect(chatRequests).toHaveLength(1)
    expect(chatRequests[0].url).toBe(`${OXION_BASE_URL}/chat/completions`)
    expect(chatRequests[0].auth).toBe(`Bearer ${MOCK_OXION_TOKEN}`)
    expect(chatRequests[0].body.model).toBe('claude-sonnet-5')
  })

  test('catalog falls back to the static list when discovery returns nothing', async () => {
    configureOxion()
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as any

    const catalog = await textAi.textAiFreeModelsForProvider('OXION')
    expect(catalog.models).toEqual(OXION_STATIC_MODELS)
    expect(catalog.staticCount).toBe(OXION_STATIC_MODELS.length)
  })

  test('discovers models from /models and drops non-chat models', async () => {
    configureOxion()
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlText = String(url)
      if (urlText.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [
          ...OXION_STATIC_MODELS.map((id) => ({ id, context_length: 1000000 })),
          // A future flagship appears automatically.
          { id: 'future-flagship-x', context_length: 1000000 },
          // Non-chat artifacts never enter the catalog.
          { id: 'text-embedding-3', context_length: 1000000 },
          { id: 'whisper-large-v3', context_length: 1000000 },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any

    const catalog = await textAi.textAiFreeModelsForProvider('OXION')
    expect(catalog.models).toContain('future-flagship-x')
    for (const model of OXION_STATIC_MODELS) {
      expect(catalog.models).toContain(model)
    }
    expect(catalog.models).not.toContain('text-embedding-3')
    expect(catalog.models).not.toContain('whisper-large-v3')
    expect(catalog.discoveredCount).toBe(OXION_STATIC_MODELS.length + 1)
  })

  test('without keys the provider stays unconfigured and inert', async () => {
    const diagnostics = await textAi.textAiDiagnostics()
    expect(diagnostics.oxionConfigured).toBe(false)
    expect(diagnostics.keyCounts.OXION).toBe(0)
  })

  test('primary order keeps OXION as the last rear reserve', async () => {
    const order = textAi.__testPrimaryProviderOrder()
    expect(order[order.length - 1]).toBe('OXION')
    expect(order.slice(-4)).toEqual(['MISTRAL', 'CLOUDFLARE', 'APINEX', 'OXION'])
    expect((KNOWN_AI_PROVIDERS as readonly string[])).toContain('OXION')
  })

  test('all static models pass the shared academic gate', async () => {
    const allowed = (provider: string, model: string) => textAi.__testAcademicModelAllowedForTests(provider as any, model)
    for (const model of OXION_STATIC_MODELS) {
      expect(allowed('OXION', model)).toBe(true)
    }
  })
})
