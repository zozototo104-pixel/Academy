/// <reference types="bun-types" />
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const originalEnv: Record<string, string | undefined> = {
  APINEX_API_KEYS: process.env.APINEX_API_KEYS,
  GROQ_API_KEYS: process.env.GROQ_API_KEYS,
  MISTRAL_API_KEYS: process.env.MISTRAL_API_KEYS,
}

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

const GROQ_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768']
const MISTRAL_MODELS = ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-7b']

function configureThreeProviders() {
  process.env.APINEX_API_KEYS = 'test-apinex-key'
  process.env.GROQ_API_KEYS = 'test-groq-key'
  process.env.MISTRAL_API_KEYS = 'test-mistral-key'
  values.set('APINEX_TEXT_MODEL', 'free/deepseek-v4.1-flash')
  values.set('APINEX_BASE_URL', 'https://api.apinex.bond/v1')
  values.set('GROQ_TEXT_MODEL', GROQ_MODELS[0])
  values.set('MISTRAL_TEXT_MODEL', MISTRAL_MODELS[0])
}

function mockProviderFetch() {
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const urlText = String(url)
    if (urlText.endsWith('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (urlText.includes('api.groq.com') && urlText.endsWith('/models')) {
      return new Response(JSON.stringify({ data: GROQ_MODELS.map((id) => ({ id, object: 'model' })) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (urlText.includes('api.mistral.ai') && urlText.endsWith('/models')) {
      return new Response(JSON.stringify({ data: MISTRAL_MODELS.map((id) => ({ id, object: 'model' })) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (urlText.endsWith('/models')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    throw new Error(`unexpected fetch: ${urlText}`)
  }) as any
}

beforeEach(() => {
  values.clear()
  globalThis.fetch = originalFetch
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

describe('text-ai-check-all restored (Haris 2026-11-14: bring back the pre-#205 display)', () => {
  test('check-all probes up to 3 models per provider, as before', async () => {
    configureThreeProviders()
    mockProviderFetch()

    const result = await textAi.textAiCheckAllModelHealth({ maxMs: 30_000 })

    expect(result.checked).toBe(9)
    const byProvider = new Map<string, string[]>()
    for (const row of result.results) {
      const list = byProvider.get(row.provider) || []
      list.push(row.model)
      byProvider.set(row.provider, list)
    }
    expect([...byProvider.keys()].sort()).toEqual(['APINEX', 'GROQ', 'MISTRAL'])
    expect(byProvider.get('APINEX')).toHaveLength(3)
    expect(byProvider.get('GROQ')).toEqual(GROQ_MODELS)
    expect(byProvider.get('MISTRAL')).toEqual(MISTRAL_MODELS)
    expect(byProvider.get('APINEX')).toContain('free/deepseek-v4.1-flash')
    expect(byProvider.get('GROQ')).toContain(GROQ_MODELS[0])
    expect(byProvider.get('MISTRAL')).toContain(MISTRAL_MODELS[0])
    expect(result.results.every((row) => row.ok)).toBe(true)
  })

  test('check-all still honours an explicit provider + models scope (provider check path)', async () => {
    configureThreeProviders()
    mockProviderFetch()

    const result = await textAi.textAiCheckAllModelHealth({ maxMs: 30_000, provider: 'GROQ', models: GROQ_MODELS })
    expect(result.checked).toBe(3)
    expect(result.results.map((row) => row.provider)).toEqual(['GROQ', 'GROQ', 'GROQ'])
    expect(result.results.map((row) => row.model)).toEqual(GROQ_MODELS)
  })

  test('health list shows the first 40 rows across all providers, not just the current one', () => {
    const root = join(import.meta.dir, '..', '..')
    const tab = readFileSync(join(root, 'src/components/aact/AdminSystemTab.tsx'), 'utf8')
    expect(tab).toContain('textModelHealth.health.slice(0, 40).map((item) => (')
    expect(tab).not.toContain('textModelHealth.health.filter((item) => item.provider === catalogProviderForModels)')
  })
})
