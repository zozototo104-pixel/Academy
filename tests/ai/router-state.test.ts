import { afterEach, describe, expect, test } from 'bun:test'
import {
  __resetTextAiStateForTests,
  __setTextAiSettingStoreForTests,
  __testResolveRouterCooldownMinutesForTests,
  __testTextAiRouterStatePayloadForTests,
  clearTextAiRouterState,
  textAiRouterStateSnapshot,
} from '../../src/lib/text-ai'
import { POST } from '../../src/app/api/admin/system/route'

function fakeStore(initial: Record<string, string>) {
  const values = new Map<string, string>(Object.entries(initial))
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
    async increment(key: string, amount: number) {
      const next = (Number(values.get(key) || 0) || 0) + amount
      values.set(key, String(next))
      return next
    },
    async scan(prefix: string) {
      return Object.fromEntries(Array.from(values.entries()).filter(([key]) => key.startsWith(prefix)))
    },
  }
  return { values, store }
}

function expiredPayload() {
  return JSON.stringify({ until: new Date(Date.now() - 60_000).toISOString(), reason: 'expired', status: 429 })
}

describe('text AI router state transparency', () => {
  afterEach(() => {
    __setTextAiSettingStoreForTests(null)
    __resetTextAiStateForTests()
  })

  test('router-state returns key/model cooldown, no-balance, and model-dead states but not expired rows or secrets', async () => {
    const { store } = fakeStore({
      OPENAI_API_KEY: 'sk-secret-value-that-must-never-appear',
      'AI_COOLDOWN:OPENAI:0': __testTextAiRouterStatePayloadForTests(60_000, 'rpm_limit', 429),
      'AI_COOLDOWN:OPENAI:0:gpt-5.1': __testTextAiRouterStatePayloadForTests(60_000, 'model_busy', 503),
      'AI_NO_BALANCE:OPENAI:0': __testTextAiRouterStatePayloadForTests(60_000, 'no_balance', 402),
      'AI_MODEL_DEAD:OPENAI:gpt-5.1': __testTextAiRouterStatePayloadForTests(60_000, 'model_not_found', 404),
      'AI_COOLDOWN:GROQ:0': expiredPayload(),
    })
    __setTextAiSettingStoreForTests(store)

    const state = await textAiRouterStateSnapshot()
    expect(state.map((item) => item.type).sort()).toEqual(['KEY_COOLDOWN', 'MODEL_COOLDOWN', 'MODEL_DEAD', 'NO_BALANCE'])
    expect(state.some((item) => item.provider === 'GROQ')).toBe(false)
    expect(JSON.stringify(state)).not.toContain('sk-secret')
    expect(state.every((item) => item.keyIndex === null || typeof item.keyIndex === 'number')).toBe(true)
  })

  test('clear-router-state removes only the requested item', async () => {
    const { values, store } = fakeStore({
      'AI_COOLDOWN:OPENAI:0': __testTextAiRouterStatePayloadForTests(60_000, 'rpm_limit', 429),
      'AI_COOLDOWN:OPENAI:0:gpt-5.1': __testTextAiRouterStatePayloadForTests(60_000, 'model_busy', 503),
      'AI_NO_BALANCE:OPENAI:0': __testTextAiRouterStatePayloadForTests(60_000, 'no_balance', 402),
    })
    __setTextAiSettingStoreForTests(store)

    await clearTextAiRouterState({ type: 'MODEL_COOLDOWN', provider: 'OPENAI', keyIndex: 0, model: 'gpt-5.1' })

    expect(values.has('AI_COOLDOWN:OPENAI:0:gpt-5.1')).toBe(false)
    expect(values.has('AI_COOLDOWN:OPENAI:0')).toBe(true)
    expect(values.has('AI_NO_BALANCE:OPENAI:0')).toBe(true)
  })

  test('clear-provider removes cooldown and no-balance rows without removing model-dead rows', async () => {
    const { values, store } = fakeStore({
      'AI_COOLDOWN:OPENAI:0': __testTextAiRouterStatePayloadForTests(60_000, 'rpm_limit', 429),
      'AI_COOLDOWN:OPENAI:0:gpt-5.1': __testTextAiRouterStatePayloadForTests(60_000, 'model_busy', 503),
      'AI_NO_BALANCE:OPENAI:0': __testTextAiRouterStatePayloadForTests(60_000, 'no_balance', 402),
      'AI_MODEL_DEAD:OPENAI:gpt-5.1': __testTextAiRouterStatePayloadForTests(60_000, 'model_not_found', 404),
    })
    __setTextAiSettingStoreForTests(store)

    await clearTextAiRouterState({ type: 'clear-provider', provider: 'OPENAI', clearProvider: true })

    expect(values.has('AI_COOLDOWN:OPENAI:0')).toBe(false)
    expect(values.has('AI_COOLDOWN:OPENAI:0:gpt-5.1')).toBe(false)
    expect(values.has('AI_NO_BALANCE:OPENAI:0')).toBe(false)
    expect(values.has('AI_MODEL_DEAD:OPENAI:gpt-5.1')).toBe(true)
  })

  test('saved router cooldown minutes take precedence over env and invalid values fall back to 15', () => {
    expect(__testResolveRouterCooldownMinutesForTests('45', '7')).toBe(45)
    expect(__testResolveRouterCooldownMinutesForTests('', '7')).toBe(7)
    expect(__testResolveRouterCooldownMinutesForTests('0', '7')).toBe(15)
    expect(__testResolveRouterCooldownMinutesForTests('999', '999')).toBe(15)
    expect(__testResolveRouterCooldownMinutesForTests('bad', '')).toBe(15)
  })

  test('router-state action requires admin access', async () => {
    const res = await POST(new Request('http://localhost/api/admin/system', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'router-state' }),
    }) as any)

    expect(res.status).toBe(401)
  })
})
