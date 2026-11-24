/// <reference types="bun-types" />
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 9 — sticky-'auto' regression guard (plan §(g) risk 3, bot failure
// mode). This is the EXACT scenario from scripts/test-router-health.ts:321
// (stickyModelIsPreferredForSameScope) that broke the bot's version: its
// manual-first reorder in modelFallbacks forced the unproven static
// default ahead of the healthy proven model. Our tree excludes 'auto'
// from selectedPart (text-ai.ts modelFallbacks, `!selectedIsAuto`), so
// the healthy model must win — this test pins that behaviour.
//   provider UNOROUTER, model 'auto' (resolves to the static default
//   gpt-5.6-sol:free), catalog [first-model:free (10 successes),
//   second-model:free (1 success + 4 fails)], mock chat returns 'first'
//   only for first-model:free.
const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const originalEnv: Record<string, string | undefined> = {
  UNOROUTER_API_KEY: process.env.UNOROUTER_API_KEY,
  AI_TEXT_PROVIDER: process.env.AI_TEXT_PROVIDER,
  AI_ROUTER_POLICY: process.env.AI_ROUTER_POLICY,
  UNOROUTER_TEXT_MODEL: process.env.UNOROUTER_TEXT_MODEL,
}

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Records every router chat attempt (discovery /models excluded).
function installFetch() {
  const seenModels: string[] = []
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url)
    if (urlText.includes('/api/pricing/catalog')) {
      return jsonResponse({ data: [
        { id: 'first-model:free', is_free: true, online: true, type: 'text', context_length: 128000 },
        { id: 'second-model:free', is_free: true, online: true, type: 'text', context_length: 128000 },
      ] })
    }
    if (urlText.endsWith('/chat/completions')) {
      const model = JSON.parse(String(init?.body || '{}')).model as string
      seenModels.push(model)
      return jsonResponse({ choices: [{ message: { content: model === 'first-model:free' ? 'first' : 'second' } }] })
    }
    throw new Error(`unexpected fetch: ${urlText}`)
  }) as any
  return seenModels
}

function configureUnoRouterAuto() {
  // UNOROUTER is a strict provider: a plaintext Setting row for its key
  // is dropped by decryptSettingValue, so the key goes via env (same as
  // scripts/test-router-health.ts configureUnoRouter).
  process.env.UNOROUTER_API_KEY = 'unorouter-test-key'
  process.env.AI_TEXT_PROVIDER = 'UNOROUTER'
  process.env.AI_ROUTER_POLICY = 'fallback_only'
  values.set('UNOROUTER_TEXT_MODEL', 'auto')
  values.set('AI_MODEL_STATS:UNOROUTER:first-model:free', JSON.stringify({ success: 10, fail: {}, avgMs: 100, jsonOk: 5, jsonTotal: 5, evidenceOk: 5, evidenceTotal: 5 }))
  values.set('AI_MODEL_STATS:UNOROUTER:second-model:free', JSON.stringify({ success: 1, fail: { other: 4 }, avgMs: 1000, jsonOk: 1, jsonTotal: 2, evidenceOk: 1, evidenceTotal: 2 }))
}

function setRanking(purpose: string, candidates: Array<{ provider: string; model: string }>) {
  values.set(`AI_AUTO_RANKING:${purpose}`, JSON.stringify({ candidates }))
}

beforeEach(() => {
  values.clear()
  globalThis.fetch = originalFetch
  delete process.env.UNOROUTER_API_KEY
  delete process.env.AI_TEXT_PROVIDER
  delete process.env.AI_ROUTER_POLICY
  delete process.env.UNOROUTER_TEXT_MODEL
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

afterAll(() => {
  textAi.__setTextAiSettingStoreForTests(null)
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe("sticky-'auto': healthy proven model wins over the unproven static default", () => {
  test('OFF: first call returns first, second call with the same stickyScope returns first', async () => {
    configureUnoRouterAuto()
    const seenModels = installFetch()
    const first = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }], stickyScope: 'batch-1' })
    expect(first).toBe('first')
    const second = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }], stickyScope: 'batch-1' })
    expect(second).toBe('first')
    expect(seenModels).toEqual(['first-model:free', 'first-model:free'])
  })

  test('OFF: the static default gpt-5.6-sol:free is never attempted when the catalog has proven models', async () => {
    configureUnoRouterAuto()
    const seenModels = installFetch()
    await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }], stickyScope: 'batch-1' })
    expect(seenModels).not.toContain('gpt-5.6-sol:free')
    expect(seenModels).not.toContain('auto')
  })

  test('the resolved auto default is a real candidate that loses on health order (not vacuously absent)', async () => {
    // normalizeModel resolves 'auto' to defaults[0] (gpt-5.6-sol:free)
    // at settings-load time, so modelFor() can no longer tell an
    // explicit choice from a resolved default. The guard is that
    // modelFallbacks has NO post-health-sort manual-first reorder: the
    // fallback list must contain the resolved default AND rank the
    // healthy proven model ahead of it.
    configureUnoRouterAuto()
    installFetch()
    const fallbacks = await textAi.__testModelFallbacksForTests('UNOROUTER')
    expect(fallbacks).toContain('gpt-5.6-sol:free')
    expect(fallbacks[0]).toBe('first-model:free')
    expect(fallbacks.indexOf('first-model:free')).toBeLessThan(fallbacks.indexOf('gpt-5.6-sol:free'))
  })
})

describe("sticky-as-hint under auto ON (step 5 rule)", () => {
  test('ON: the top-ranked model wins even when a sticky points elsewhere', async () => {
    configureUnoRouterAuto()
    const seenModels = installFetch()
    // Call 1, auto OFF: the healthy model wins and the sticky is set to it.
    const first = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }], stickyScope: 'batch-1' })
    expect(first).toBe('first')
    // Call 2, auto ON with a ranking whose top is the OTHER model: the
    // sticky is only a hint, so the ranking wins.
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('CHAT', [{ provider: 'UNOROUTER', model: 'second-model:free' }])
    const second = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }], stickyScope: 'batch-1' })
    expect(second).toBe('second')
    expect(seenModels[seenModels.length - 1]).toBe('second-model:free')
    expect(seenModels).toEqual(['first-model:free', 'second-model:free'])
  })

  test('ON: the sticky still wins when it is already the top-ranked model', async () => {
    configureUnoRouterAuto()
    const seenModels = installFetch()
    const first = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }], stickyScope: 'batch-1' })
    expect(first).toBe('first')
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('CHAT', [{ provider: 'UNOROUTER', model: 'first-model:free' }, { provider: 'UNOROUTER', model: 'second-model:free' }])
    const second = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'x' }], stickyScope: 'batch-1' })
    expect(second).toBe('first')
    expect(seenModels).toEqual(['first-model:free', 'first-model:free'])
  })
})
