/// <reference types="bun-types" />
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const originalEnv: Record<string, string | undefined> = {
  APINEX_API_KEYS: process.env.APINEX_API_KEYS,
  APINEX_API_KEY: process.env.APINEX_API_KEY,
}
const MOCK_APINEX_TOKEN = 'test-apinex-key'
const APINEX_BASE_URL = 'https://api.apinex.bond/v1'

// Curated static list: the 12 genuinely-free models only. The 9 models that
// wear the FREE tag but require a subscription (Claude 4.6 Sonnet/Opus,
// Qwen 3.8 MAX, Kimi K2.8, Gemini 3.1 Pro, MiniMax M3, DeepSeek V4 Flash,
// Mimo V2.6 Flash, HY 4) are deliberately excluded.
const APINEX_FREE_MODELS = [
  'free/deepseek-v4.1-flash',
  'free/glm-5.3-flash',
  'free/gpt-6-luna',
  'free/minimax-m3.1-flash',
  'free/gemini-3.8-flash',
  'free/deepseek-v4-pro-0813',
  'free/glm-5.3',
  'free/glm-5.3-flashx',
  'free/mimo-v2.6-pro',
  'free/kimi-k3',
  'free/muse-spark-1.3',
  'free/jev-1.13',
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

function configureApinex() {
  values.set('AI_TEXT_PROVIDER', 'APINEX')
  process.env.APINEX_API_KEYS = MOCK_APINEX_TOKEN
  values.set('APINEX_TEXT_MODEL', 'free/deepseek-v4.1-flash')
  values.set('APINEX_BASE_URL', APINEX_BASE_URL)
}

beforeEach(() => {
  values.clear()
  globalThis.fetch = originalFetch
  delete process.env.APINEX_API_KEYS
  delete process.env.APINEX_API_KEY
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

describe('APINEX text provider', () => {
  test('chat routes to the selected model with the APInex key', async () => {
    configureApinex()
    const chatRequests: any[] = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization || '')
      if (urlText.endsWith('/models')) {
        return new Response(JSON.stringify({ data: APINEX_FREE_MODELS.map((id) => ({ id, context_length: 1000000 })) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (urlText.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body || '{}'))
        chatRequests.push({ url: urlText, auth, body })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-apinex' } })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any

    const reply = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hello' }], maxOutputTokens: 16 })
    expect(reply).toBe('ok')
    expect(chatRequests).toHaveLength(1)
    expect(chatRequests[0].url).toBe(`${APINEX_BASE_URL}/chat/completions`)
    expect(chatRequests[0].auth).toBe(`Bearer ${MOCK_APINEX_TOKEN}`)
    expect(chatRequests[0].body.model).toBe('free/deepseek-v4.1-flash')
  })

  test('catalog is the static free list and excludes subscription-only models', async () => {
    configureApinex()
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as any

    const catalog = await textAi.textAiFreeModelsForProvider('APINEX')
    expect(catalog.models).toEqual(APINEX_FREE_MODELS)
    expect(catalog.models).not.toContain('free/claude-sonnet-4.6')
    expect(catalog.models).not.toContain('free/claude-opus-4.6')
    expect(catalog.models).not.toContain('free/qwen-3.8-max')
    expect(catalog.models).not.toContain('free/kimi-k2.8')
    expect(catalog.models).not.toContain('free/gemini-3.1-pro')
  })

  test('discovers free models from /models and drops subscription-only ones', async () => {
    configureApinex()
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlText = String(url)
      if (urlText.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [
          ...APINEX_FREE_MODELS.map((id) => ({ id, context_length: 1000000 })),
          // Subscription-only models wear the same FREE tag on the website
          // but must never enter the catalog.
          { id: 'free/claude-sonnet-4.6', context_length: 1000000 },
          { id: 'free/qwen-3.8-max', context_length: 1000000 },
          // A paid model without the free/ prefix must not enter either.
          { id: 'gpt-5-pro', context_length: 1000000 },
          // A future genuinely-free model appears automatically.
          { id: 'free/future-model-x', context_length: 1000000 },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any

    const catalog = await textAi.textAiFreeModelsForProvider('APINEX')
    expect(catalog.models).toHaveLength(APINEX_FREE_MODELS.length + 1)
    expect(catalog.models).toContain('free/future-model-x')
    for (const model of APINEX_FREE_MODELS) {
      expect(catalog.models).toContain(model)
    }
    expect(catalog.models).not.toContain('free/claude-sonnet-4.6')
    expect(catalog.models).not.toContain('free/qwen-3.8-max')
    expect(catalog.models).not.toContain('gpt-5-pro')
    expect(catalog.discoveredCount).toBe(APINEX_FREE_MODELS.length + 1)
  })

  test('without keys the provider stays unconfigured and inert', async () => {
    const diagnostics = await textAi.textAiDiagnostics()
    expect(diagnostics.apinexConfigured).toBe(false)
    expect(diagnostics.keyCounts.APINEX).toBe(0)
  })

  test('primary order keeps APINEX as the last rear reserve', async () => {
    const order = textAi.__testPrimaryProviderOrder()
    expect(order[order.length - 1]).toBe('APINEX')
    expect(order.slice(-3)).toEqual(['MISTRAL', 'CLOUDFLARE', 'APINEX'])
    expect((KNOWN_AI_PROVIDERS as readonly string[])).toContain('APINEX')
  })

  test('all static free models pass the shared academic gate', async () => {
    const allowed = (provider: string, model: string) => textAi.__testAcademicModelAllowedForTests(provider as any, model)
    for (const model of APINEX_FREE_MODELS) {
      expect(allowed('APINEX', model)).toBe(true)
    }
  })
})
