/// <reference types="bun-types" />
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const originalEnv: Record<string, string | undefined> = {
  MISTRAL_API_KEYS: process.env.MISTRAL_API_KEYS,
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
  CLOUDFLARE_API_KEYS: process.env.CLOUDFLARE_API_KEYS,
  CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
}
const MOCK_MISTRAL_TOKEN = 'test-mistral-key'
const MOCK_CLOUDFLARE_TOKEN = 'test-cloudflare-token'
const MISTRAL_BASE_URL = 'https://api.mistral.ai/v1'
const CLOUDFLARE_BASE_URL = 'https://api.cloudflare.com/client/v4/accounts/test123/ai/v1'

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

function configureMistral() {
  values.set('AI_TEXT_PROVIDER', 'MISTRAL')
  process.env.MISTRAL_API_KEYS = MOCK_MISTRAL_TOKEN
  values.set('MISTRAL_TEXT_MODEL', 'mistral-large-latest')
  values.set('MISTRAL_BASE_URL', MISTRAL_BASE_URL)
}

function configureCloudflare() {
  values.set('AI_TEXT_PROVIDER', 'CLOUDFLARE')
  process.env.CLOUDFLARE_API_KEYS = MOCK_CLOUDFLARE_TOKEN
  values.set('CLOUDFLARE_TEXT_MODEL', '@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  values.set('CLOUDFLARE_BASE_URL', CLOUDFLARE_BASE_URL)
}

beforeEach(() => {
  values.clear()
  globalThis.fetch = originalFetch
  delete process.env.MISTRAL_API_KEYS
  delete process.env.MISTRAL_API_KEY
  delete process.env.CLOUDFLARE_API_KEYS
  delete process.env.CLOUDFLARE_API_KEY
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

describe('MISTRAL + CLOUDFLARE text providers', () => {
  test('Mistral discovery takes priced chat models and drops non-chat models', async () => {
    configureMistral()
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization || '')
      if (urlText.endsWith('/models')) {
        expect(urlText).toBe(`${MISTRAL_BASE_URL}/models`)
        expect(auth).toBe(`Bearer ${MOCK_MISTRAL_TOKEN}`)
        return new Response(JSON.stringify({ data: [
          // Priced on purpose: the Mistral free plan is credit-based, so a
          // price marker must NOT filter these out.
          { id: 'mistral-large-latest', context_length: 131072, pricing: { prompt: '0.5', completion: '1.5' } },
          { id: 'mistral-medium-latest', context_length: 131072 },
          { id: 'mistral-small-latest', context_length: 131072 },
          { id: 'codestral-latest', context_length: 256000 },
          { id: 'ministral-8b-latest', context_length: 131072 },
          { id: 'mistral-embed', context_length: 131072 },
          { id: 'mistral-moderation-latest', context_length: 131072 },
          { id: 'mistral-ocr-latest', context_length: 131072 },
          { id: 'voxtral-mini-latest', context_length: 131072 },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any

    const catalog = await textAi.textAiFreeModelsForProvider('MISTRAL')
    expect(catalog.models).toEqual([
      'mistral-large-latest',
      'mistral-medium-latest',
      'mistral-small-latest',
      'codestral-latest',
      'ministral-8b-latest',
    ])
    expect(catalog.discoveredCount).toBe(5)
  })

  test('Mistral chat routes to the selected model with the Mistral key', async () => {
    configureMistral()
    const chatRequests: any[] = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization || '')
      if (urlText.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'mistral-large-latest', context_length: 131072 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (urlText.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body || '{}'))
        chatRequests.push({ url: urlText, auth, body })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-mistral' } })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any

    const reply = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hello' }], maxOutputTokens: 16 })
    expect(reply).toBe('ok')
    expect(chatRequests).toHaveLength(1)
    expect(chatRequests[0].url).toBe(`${MISTRAL_BASE_URL}/chat/completions`)
    expect(chatRequests[0].auth).toBe(`Bearer ${MOCK_MISTRAL_TOKEN}`)
    expect(chatRequests[0].body.model).toBe('mistral-large-latest')
  })

  test('Cloudflare falls back to the static list when /models is unavailable', async () => {
    configureCloudflare()
    const chatRequests: any[] = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization || '')
      if (urlText.endsWith('/models')) {
        // Workers AI publishes no OpenAI-style /models endpoint.
        return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      }
      if (urlText.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body || '{}'))
        chatRequests.push({ url: urlText, auth, body })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-cloudflare' } })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any

    const catalog = await textAi.textAiFreeModelsForProvider('CLOUDFLARE')
    expect(catalog.models).toEqual([
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/openai/gpt-oss-120b',
      '@cf/nvidia/nemotron-3-120b-a12b',
      '@cf/ibm-granite/granite-4.0-h-micro',
    ])
    expect(catalog.discoveredCount).toBe(0)

    const reply = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hello' }], maxOutputTokens: 16 })
    expect(reply).toBe('ok')
    expect(chatRequests).toHaveLength(1)
    expect(chatRequests[0].url).toBe(`${CLOUDFLARE_BASE_URL}/chat/completions`)
    expect(chatRequests[0].auth).toBe(`Bearer ${MOCK_CLOUDFLARE_TOKEN}`)
    expect(chatRequests[0].body.model).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
  })

  test('without keys both providers stay unconfigured and inert', async () => {
    const diagnostics = await textAi.textAiDiagnostics()
    expect(diagnostics.mistralConfigured).toBe(false)
    expect(diagnostics.cloudflareConfigured).toBe(false)
    expect(diagnostics.keyCounts.MISTRAL).toBe(0)
    expect(diagnostics.keyCounts.CLOUDFLARE).toBe(0)
  })

  test('primary order keeps both providers as rear reserves', () => {
    const order = textAi.__testPrimaryProviderOrder()
    expect(order.slice(-3)).toEqual(['MISTRAL', 'CLOUDFLARE', 'APINEX'])
    expect((KNOWN_AI_PROVIDERS as readonly string[])).toContain('MISTRAL')
    expect((KNOWN_AI_PROVIDERS as readonly string[])).toContain('CLOUDFLARE')
    expect((KNOWN_AI_PROVIDERS as readonly string[])).toContain('APINEX')
  })

  test('academic eligibility follows the shared size rules', () => {
    const allowed = (provider: string, model: string) => textAi.__testAcademicModelAllowedForTests(provider as any, model)
    expect(allowed('MISTRAL', 'mistral-large-latest')).toBe(true)
    expect(allowed('MISTRAL', 'mistral-medium-latest')).toBe(true)
    expect(allowed('MISTRAL', 'mistral-small-latest')).toBe(true)
    expect(allowed('MISTRAL', 'codestral-latest')).toBe(true)
    expect(allowed('MISTRAL', 'ministral-8b-latest')).toBe(false)
    expect(allowed('MISTRAL', 'open-mistral-7b')).toBe(false)
    expect(allowed('CLOUDFLARE', '@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe(true)
    expect(allowed('CLOUDFLARE', '@cf/openai/gpt-oss-120b')).toBe(true)
    expect(allowed('CLOUDFLARE', '@cf/qwen/qwen3-8b')).toBe(false)
    expect(allowed('CLOUDFLARE', '@cf/mistralai/mistral-small-3.1-24b-instruct')).toBe(false)
  })
})
