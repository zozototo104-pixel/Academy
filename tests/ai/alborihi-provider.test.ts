/// <reference types="bun-types" />
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const originalAlborihiApiKeys = process.env.ALBORIHI_API_KEYS
const originalAlborihiApiKey = process.env.ALBORIHI_API_KEY
const MOCK_ALBORIHI_TOKEN = 'mock-token'

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

const store = {
  async read(keys: string[]) {
    return Object.fromEntries(keys.map((key) => [key, values.get(key) || '']))
  },
  async write(key: string, value: string) {
    values.set(key, value)
  },
  async delete(key: string) {
    values.delete(key)
  },
  async scan(prefix: string) {
    return Object.fromEntries([...values.entries()].filter(([key]) => key.startsWith(prefix)))
  },
  async increment(key: string, amount: number) {
    values.set(key, String((Number(values.get(key) || 0) || 0) + amount))
  },
}

function configureAlborihi() {
  values.set('AI_TEXT_PROVIDER', 'ALBORIHI')
  process.env.ALBORIHI_API_KEYS = MOCK_ALBORIHI_TOKEN
  values.set('ALBORIHI_TEXT_MODEL', 'claude-sonnet-5')
  values.set('ALBORIHI_BASE_URL', 'https://alborihi-ai.com/api/public/dev/v1')
}

function alborihiModelsBody(rows = [
  { id: 'claude-sonnet-5', context_length: 200000, architecture: { input_modalities: ['text'] } },
]) {
  return { data: rows }
}

beforeEach(() => {
  values.clear()
  globalThis.fetch = originalFetch
  delete process.env.ALBORIHI_API_KEYS
  delete process.env.ALBORIHI_API_KEY
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
})

afterAll(() => {
  globalThis.fetch = originalFetch
  textAi.__setTextAiSettingStoreForTests(null)
  if (originalAlborihiApiKeys === undefined) delete process.env.ALBORIHI_API_KEYS
  else process.env.ALBORIHI_API_KEYS = originalAlborihiApiKeys
  if (originalAlborihiApiKey === undefined) delete process.env.ALBORIHI_API_KEY
  else process.env.ALBORIHI_API_KEY = originalAlborihiApiKey
})

describe('ALBORIHI text provider', () => {
  test('discovers allowed models and only routes images to discovered vision models', async () => {
    configureAlborihi()
    const chatRequests: any[] = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization || '')
      if (urlText.endsWith('/models')) {
        expect(urlText).toBe('https://alborihi-ai.com/api/public/dev/v1/models')
        expect(auth).toBe(`Bearer ${TEST_ALBORIHI_KEY}`)
        return new Response(JSON.stringify(alborihiModelsBody([
          { id: 'claude-sonnet-5', context_length: 200000, architecture: { input_modalities: ['text'] } },
          { id: 'gpt-5.6-luna', context_length: 128000, architecture: { input_modalities: ['text', 'image'] } },
        ])), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (urlText.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body || '{}'))
        chatRequests.push({ url: urlText, auth, body })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-success' } })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any

    const catalog = await textAi.textAiFreeModelsForProvider('ALBORIHI')
    expect(catalog.models).toEqual(['claude-sonnet-5', 'gpt-5.6-luna'])
    expect(catalog.discoveredCount).toBe(2)

    const reply = await textAi.textAiComplete({
      system: 'صف الصورة بإيجاز.',
      history: [{ role: 'user', text: 'ما محتوى الصورة؟' }],
      attachments: [{ mimeType: 'image/png', base64: 'aGVsbG8=' }],
      maxOutputTokens: 32,
    })

    expect(reply).toBe('ok')
    expect(chatRequests).toHaveLength(1)
    expect(chatRequests[0].url).toBe('https://alborihi-ai.com/api/public/dev/v1/chat/completions')
    expect(chatRequests[0].auth).toBe(`Bearer ${TEST_ALBORIHI_KEY}`)
    expect(chatRequests[0].body.model).toBe('gpt-5.6-luna')
    expect(chatRequests[0].body.messages[1].content.some((part: any) => part?.type === 'image_url')).toBe(true)
  })

  test('falls back to the static Alborihi model list when discovery fails', async () => {
    configureAlborihi()
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://alborihi-ai.com/api/public/dev/v1/models')
      return new Response(JSON.stringify({ error: { code: 'provider_unavailable', message: 'paused' } }), { status: 503, headers: { 'Content-Type': 'application/json' } })
    }) as any

    const catalog = await textAi.textAiFreeModelsForProvider('ALBORIHI')
    expect(catalog.models).toEqual(['claude-sonnet-5', 'claude-opus-4-6', 'gpt-5.6-luna'])
    expect(catalog.discoveredCount).toBe(0)
  })

  test('without an Alborihi key the active provider behavior remains driven by existing configured providers', async () => {
    values.set('GEMINI_API_KEYS', 'test-gemini-key')
    const diagnostics = await textAi.textAiDiagnostics()
    expect(diagnostics.alborihiConfigured).toBe(false)
    expect(diagnostics.keyCounts.ALBORIHI).toBe(0)
    expect(diagnostics.activeProvider).toBe('GEMINI')
    expect(textAi.parseAcademicAllowlist('').map((item) => item.provider)).toEqual(['GEMINI', 'GEMINI'])
  })

  async function runFailedChat(status: number, code: string, headers?: Record<string, string>) {
    configureAlborihi()
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlText = String(url)
      if (urlText.endsWith('/models')) {
        return new Response(JSON.stringify(alborihiModelsBody()), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (urlText.endsWith('/chat/completions')) {
        return new Response(JSON.stringify({ error: { code, message: code, request_id: 'req-failed' } }), {
          status,
          headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-failed', ...(headers || {}) },
        })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any

    await expect(textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hello' }], maxOutputTokens: 16 })).rejects.toThrow()
    return textAi.textAiDiagnostics()
  }

  test('marks 402 Alborihi subscription errors as no-balance for the key', async () => {
    const diagnostics = await runFailedChat(402, 'free_credit_exhausted')
    expect([...values.keys()].some((key) => key === 'AI_NO_BALANCE:ALBORIHI:1')).toBe(true)
    expect(diagnostics.recentAttempts.at(-1)?.requestId).toBe('req-failed')
  })

  test('marks model_not_allowed as a dead Alborihi model but does not do that for pending keys', async () => {
    await runFailedChat(403, 'model_not_allowed')
    expect([...values.keys()].some((key) => key === 'AI_MODEL_DEAD:ALBORIHI:claude-sonnet-5')).toBe(true)

    values.clear()
    textAi.__resetTextAiStateForTests()
    textAi.__setTextAiSettingStoreForTests(store)
    await runFailedChat(403, 'key_pending_approval')
    expect([...values.keys()].some((key) => key.startsWith('AI_MODEL_DEAD:ALBORIHI:'))).toBe(false)
    expect([...values.keys()].some((key) => key === 'AI_COOLDOWN:ALBORIHI:1')).toBe(true)
  })

  test('respects Retry-After on Alborihi 429 responses', async () => {
    await runFailedChat(429, 'rate_limit_rpm', { 'Retry-After': '120' })
    const raw = values.get('AI_COOLDOWN:ALBORIHI:1')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(String(raw))
    const remainingMs = Date.parse(parsed.until) - Date.now()
    expect(remainingMs).toBeGreaterThan(100_000)
    expect(remainingMs).toBeLessThan(150_000)
  })
})
