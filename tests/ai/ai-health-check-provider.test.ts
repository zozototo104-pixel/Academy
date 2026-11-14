/// <reference types="bun-types" />
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const originalEnv: Record<string, string | undefined> = {
  OPENAI_COMPAT_API_KEYS: process.env.OPENAI_COMPAT_API_KEYS,
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

function configureCompat() {
  process.env.OPENAI_COMPAT_API_KEYS = 'test-compat-key'
  values.set('OPENAI_COMPAT_BASE_URL', 'https://gateway.example.test/v1')
  values.set('OPENAI_COMPAT_TEXT_MODEL', 'alpha-model')
}

function mockModelsFetch(rows: Array<Record<string, unknown>>, status = 200) {
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const urlText = String(url)
    if (urlText.endsWith('/models')) {
      return new Response(JSON.stringify({ data: rows }), { status, headers: { 'Content-Type': 'application/json' } })
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

describe('provider health check falls back to the full discovered catalog (Haris 2026-11-14)', () => {
  test('unmarked models appear in the discovered catalog but not in the free catalog', async () => {
    configureCompat()
    mockModelsFetch([{ id: 'alpha-model' }, { id: 'beta-model' }])

    const discovered = await textAi.textAiDiscoveredModelsForProvider('OPENAI_COMPAT')
    expect(discovered.models).toEqual(['alpha-model', 'beta-model'])
    expect(discovered.discoveredCount).toBe(2)

    const free = await textAi.textAiFreeModelsForProvider('OPENAI_COMPAT')
    // The unselected, unmarked model never enters the free catalog.
    expect(free.models).not.toContain('beta-model')
    // The selected model stays in the free catalog by design (it is the
    // admin's explicit choice), so the assertion is about the unmarked
    // model the admin did not select.
    expect(free.models).toContain('alpha-model')
  })

  test('a failed discovery returns an empty discovered catalog (route then reports honestly)', async () => {
    configureCompat()
    mockModelsFetch([], 500)

    const discovered = await textAi.textAiDiscoveredModelsForProvider('OPENAI_COMPAT')
    expect(discovered.models).toEqual([])
    expect(discovered.discoveredCount).toBe(0)
  })

  test('check-provider route falls back to the discovered catalog and no longer refuses with the misleading message', () => {
    const root = join(import.meta.dir, '..', '..')
    const route = readFileSync(join(root, 'src/app/api/admin/system/route.ts'), 'utf8')
    expect(route).toContain('textAiDiscoveredModelsForProvider(provider)')
    expect(route).toContain('تعذّر الوصول إلى قائمة نماذج المزود')
    expect(route).not.toContain('لا توجد نماذج مكتشفة لهذا المزود')
  })
})
