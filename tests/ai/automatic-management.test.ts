import { afterEach, describe, expect, test } from 'bun:test'
import { automaticManagementEnabled, automaticModelScore } from '../../src/lib/ai-auto-policy'
import { __resetTextAiStateForTests, __setTextAiSettingStoreForTests, textAiAutomaticSnapshot, textAiComplete, textAiRefreshAutomaticCatalog } from '../../src/lib/text-ai'

const originalFetch = globalThis.fetch
const originalKey = process.env.OPENAI_COMPAT_API_KEY
function setup(overrides: Record<string, string> = {}) {
  process.env.OPENAI_COMPAT_API_KEY = 'test-only-key'
  __resetTextAiStateForTests()
  const values = new Map(Object.entries({
    AI_AUTO_MANAGEMENT_ENABLED: 'true', AI_TEXT_PROVIDER: 'OPENAI_COMPAT',
    OPENAI_COMPAT_BASE_URL: 'https://api.example.test/v1',
    OPENAI_COMPAT_TEXT_MODEL: 'manual-model', AI_PROVIDER_TIER_OPENAI_COMPAT: 'FREE',
    AI_ACADEMIC_ALLOWLIST_STRICT: 'false', AI_ROUTER_ALLOW_PUBLIC_GATEWAYS: 'true', ...overrides,
  }))
  __setTextAiSettingStoreForTests({
    read: async (keys) => Object.fromEntries(keys.map(key => [key, values.get(key) || ''])),
    write: async (key, value) => { values.set(key, value) },
    scan: async (prefix) => Object.fromEntries([...values].filter(([key]) => key.startsWith(prefix))),
    delete: async (key) => { values.delete(key) },
    increment: async (key, amount) => { const next = Number(values.get(key) || 0) + amount; values.set(key, String(next)); return next },
  })
  return values
}
function catalog(models = ['discovered-a', 'discovered-b']) {
  return new Response(JSON.stringify({ data: models.map(id => ({ id, context_length: 128000, pricing: { prompt: '0', completion: '0' } })) }))
}
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.OPENAI_COMPAT_API_KEY
  else process.env.OPENAI_COMPAT_API_KEY = originalKey
  __setTextAiSettingStoreForTests(null)
  __resetTextAiStateForTests()
})

describe('automatic management', () => {
  test('only explicit enabled values activate the policy', () => {
    expect(automaticManagementEnabled('true')).toBe(true)
    expect(automaticManagementEnabled('1')).toBe(true)
    expect(automaticManagementEnabled('false')).toBe(false)
    expect(automaticManagementEnabled('0')).toBe(false)
    expect(automaticManagementEnabled(undefined)).toBe(false)
  })
  test('observed failures and poor evidence reduce the score', () => {
    const good = { success: 20, fail: {}, avgMs: 1000, jsonOk: 20, jsonTotal: 20, evidenceOk: 20, evidenceTotal: 20 }
    expect(automaticModelScore(good)).toBeGreaterThan(automaticModelScore(null))
    expect(automaticModelScore(good)).toBeGreaterThan(automaticModelScore({ ...good, fail: { invalid: 30 }, evidenceOk: 0 }))
  })
  test('uses discovered models, ignores manual preference, then restores it when disabled', async () => {
    const values = setup()
    const attempted: string[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith('/models')) return catalog()
      attempted.push(JSON.parse(init.body).model)
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Valid response' } }] }))
    }) as unknown as typeof fetch
    const opts = { system: 'Answer', history: [{ role: 'user' as const, text: 'Hello' }], purpose: 'CHAT' as const }
    await textAiComplete(opts)
    expect(attempted[0]).toBe('discovered-a')
    expect(values.get('OPENAI_COMPAT_TEXT_MODEL')).toBe('manual-model')
    values.set('AI_AUTO_MANAGEMENT_ENABLED', 'false')
    __resetTextAiStateForTests()
    await textAiComplete(opts)
    expect(attempted[1]).toBe('manual-model')
  })
  test('tries the next discovered model on failure while preserving explicit restrictions', async () => {
    setup()
    const attempted: string[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      if (String(url).endsWith('/models')) return catalog()
      const model = JSON.parse(init.body).model
      attempted.push(model)
      if (model === 'discovered-a') return new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 })
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Fallback response' } }] }))
    }) as unknown as typeof fetch
    expect(await textAiComplete({ system: 'Answer', history: [{ role: 'user', text: 'Hi' }], purpose: 'CHAT', restrictToModels: [{ provider: 'OPENAI_COMPAT', model: 'discovered-a' }, { provider: 'OPENAI_COMPAT', model: 'discovered-b' }] })).toBe('Fallback response')
    expect(attempted).toEqual(['discovered-a', 'discovered-b'])
  })
  test('failed forced discovery preserves last successful catalog, including after process restart', async () => {
    const values = setup()
    let unavailable = false
    let discoveries = 0
    globalThis.fetch = (async () => { discoveries++; return unavailable ? new Response('unavailable', { status: 503 }) : catalog() }) as unknown as typeof fetch
    await textAiRefreshAutomaticCatalog()
    const before = [...values].filter(([key]) => key.includes('AI_MODELS_AVAILABLE:'))
    expect(before.length).toBeGreaterThan(0)
    unavailable = true
    __resetTextAiStateForTests()
    await textAiRefreshAutomaticCatalog()
    expect(discoveries).toBeGreaterThan(1)
    expect([...values].filter(([key]) => key.includes('AI_MODELS_AVAILABLE:'))).toEqual(before)
    const snapshot = await textAiAutomaticSnapshot()
    expect(snapshot.stages.find(stage => stage.purpose === 'CHAT')?.primary?.model).toBe('discovered-a')
  })
  test('unknown pricing is excluded instead of being described as free', async () => {
    setup({ AI_PROVIDER_TIERS: 'OPENAI_COMPAT=UNKNOWN' })
    globalThis.fetch = (async () => catalog()) as unknown as typeof fetch
    const snapshot = await textAiAutomaticSnapshot()
    expect(snapshot.stages[0].primary).toBeNull()
    expect(snapshot.stages[0].excluded[0]?.reason).toContain('التكلفة غير موثقة')
  })
  test('no discovered models means no invented default candidates', async () => {
    setup()
    globalThis.fetch = (async () => catalog([])) as unknown as typeof fetch
    const snapshot = await textAiAutomaticSnapshot()
    expect(snapshot.stages.every(stage => stage.primary === null && !stage.fallback.length)).toBe(true)
  })
})
