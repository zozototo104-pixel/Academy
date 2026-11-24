/// <reference types="bun-types" />
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

// Step 9 — protection guards (plan §(c) step 9 + §(g) risk 7):
// (i) auditor independence — with auto ON, REVIEW ranking excludes the
//     generator's provider AND family in all cases, including the
//     ALBORIHI cross-family exception path (auto must not widen it);
// (ii) paid-never-ranked — with AI_PAID_USAGE_MODE=off and
//     allowPaid=false, paid models never appear in ANY purpose ranking;
// (iii) no permission change — auto ON/OFF does not change who can call
//     admin routes (spot-check: the auto cron route stays CRON_SECRET
//     gated and the system route stays requireAdmin gated in both modes).
const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const originalEnv: Record<string, string | undefined> = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ALBORIHI_API_KEY: process.env.ALBORIHI_API_KEY,
  CRON_SECRET: process.env.CRON_SECRET,
}

const db: any = {
  aiUsageLog: { create: async () => ({}) },
  user: { findUnique: async () => null },
  keyRateWindow: { upsert: async () => ({}), findUnique: async () => ({ count: 1 }) },
  setting: {
    findMany: async () => [],
    findUnique: async ({ where }: any) => (where?.key === 'AI_AUTO_MODE_ENABLED' && values.get('AI_AUTO_MODE_ENABLED') ? { key: where.key, value: values.get('AI_AUTO_MODE_ENABLED') } : null),
    upsert: async () => ({}),
  },
  $queryRawUnsafe: async () => [],
}
mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/settings', () => ({ getSetting: async (key: string) => values.get(key) || '' }))
mock.module('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async () => ({ text: '{"native":"ok"}' }),
      generateContentStream: async function* () { yield { text: 'hello-native' } },
    }
  },
}))

const textAi = await import('../../src/lib/text-ai')
const autoMode = await import('../../src/lib/ai-auto-mode')
const { __testVerifierFamilyAllowedForTests } = await import('../../src/lib/question-verifier')
const autoRefreshRoute = await import('../../src/app/api/cron/ai-auto-refresh/route')

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

function setRanking(purpose: string, candidates: Array<{ provider: string; model: string }>) {
  values.set(`AI_AUTO_RANKING:${purpose}`, JSON.stringify({ candidates }))
}

beforeEach(() => {
  values.clear()
  globalThis.fetch = originalFetch
  delete process.env.GROQ_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.ALBORIHI_API_KEY
  delete process.env.CRON_SECRET
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

describe('auditor independence — scorer level', () => {
  const familyOf = (provider: string, model: string) => textAi.modelFamily(model)

  test('generator provider is excluded even when it would score highest', () => {
    const scored = autoMode.scoreModelForTask({
      provider: 'GROQ', model: 'llama-3.3-70b-versatile', purpose: 'REVIEW',
      stats: { success: 10, fail: {}, avgMs: 100, jsonOk: 5, jsonTotal: 5, evidenceOk: 5, evidenceTotal: 5 },
      excludeProviders: ['GROQ'], excludeModelFamilies: ['llama'], modelFamily: familyOf,
    })
    expect(scored.score).toBe(0)
    expect(scored.excludedReason).toBe('EXCLUDED_PROVIDER')
  })

  test('same-family model from another provider is excluded', () => {
    const scored = autoMode.scoreModelForTask({
      provider: 'OPENAI', model: 'deepseek-r1', purpose: 'REVIEW',
      excludeProviders: ['TOPTOOLS'], excludeModelFamilies: ['deepseek'], modelFamily: familyOf,
    })
    expect(scored.score).toBe(0)
    expect(scored.excludedReason).toBe('EXCLUDED_FAMILY')
  })

  test('a different-family model is NOT excluded by the same generator', () => {
    const scored = autoMode.scoreModelForTask({
      provider: 'GEMINI', model: 'gemini-3.5-flash-lite', purpose: 'REVIEW',
      stats: { success: 10, fail: {}, avgMs: 100, jsonOk: 5, jsonTotal: 5, evidenceOk: 5, evidenceTotal: 5 },
      excludeProviders: ['GROQ'], excludeModelFamilies: ['llama'], modelFamily: familyOf,
    })
    expect(scored.score).toBeGreaterThan(0)
    expect(scored.excludedReason).toBeUndefined()
  })

  test('ALBORIHI exception: cross-family model allowed, same-family model excluded, provider exclusion still bites', () => {
    const generatorFamily = textAi.modelFamily('claude-sonnet-5')
    expect(generatorFamily).toBe('claude')
    // Cross-family (GPT after Claude) stays allowed — the exception.
    const crossFamily = autoMode.scoreModelForTask({
      provider: 'ALBORIHI', model: 'gpt-5.6-luna', purpose: 'REVIEW',
      excludeProviders: [], excludeModelFamilies: ['claude'], modelFamily: familyOf,
    })
    expect(crossFamily.excludedReason).toBeUndefined()
    expect(crossFamily.score).toBeGreaterThan(0)
    // Same family (Claude after Claude) is excluded — auto does not widen it.
    const sameFamily = autoMode.scoreModelForTask({
      provider: 'ALBORIHI', model: 'claude-opus-4-6', purpose: 'REVIEW',
      excludeProviders: [], excludeModelFamilies: ['claude'], modelFamily: familyOf,
    })
    expect(sameFamily.score).toBe(0)
    expect(sameFamily.excludedReason).toBe('EXCLUDED_FAMILY')
    // And excluding the provider still excludes even the cross-family model.
    const providerExcluded = autoMode.scoreModelForTask({
      provider: 'ALBORIHI', model: 'gpt-5.6-luna', purpose: 'REVIEW',
      excludeProviders: ['ALBORIHI'], excludeModelFamilies: ['claude'], modelFamily: familyOf,
    })
    expect(providerExcluded.score).toBe(0)
    expect(providerExcluded.excludedReason).toBe('EXCLUDED_PROVIDER')
  })
})

describe('auditor independence — ranking choke point', () => {
  const familyOf = (provider: string, model: string) => textAi.modelFamily(model)
  const reviewRanking = [
    { provider: 'ALBORIHI', model: 'claude-sonnet-5' },
    { provider: 'ALBORIHI', model: 'gpt-5.6-luna' },
    { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
  ]

  test('generator provider + family excluded from the REVIEW ranking', () => {
    const resolved = autoMode.resolveAutoCandidates({
      autoMode: true, ranking: reviewRanking, purpose: 'REVIEW',
      excludeProviders: ['ALBORIHI'], excludeModelFamilies: ['claude'], modelFamily: familyOf,
    })
    expect(resolved.autoOverride).toBe(true)
    expect(resolved.autoCandidates.map((c) => `${c.provider}:${c.model}`)).toEqual(['GROQ:llama-3.3-70b-versatile'])
    expect(resolved.excludedReasons.some((r) => r.includes('ALBORIHI:claude-sonnet-5') && r.includes('EXCLUDED_PROVIDER'))).toBe(true)
  })

  test('ALBORIHI exception path: provider re-admitted, same-family model still dropped', () => {
    // The router re-admits ALBORIHI as a provider (allowAlborihiCrossFamilyVerifier)
    // but the family exclusion stays: only the cross-family model survives.
    const resolved = autoMode.resolveAutoCandidates({
      autoMode: true, ranking: reviewRanking, purpose: 'REVIEW',
      excludeProviders: [], excludeModelFamilies: ['claude'], modelFamily: familyOf,
    })
    expect(resolved.autoCandidates.map((c) => `${c.provider}:${c.model}`)).toEqual([
      'ALBORIHI:gpt-5.6-luna', 'GROQ:llama-3.3-70b-versatile',
    ])
    expect(resolved.excludedReasons.some((r) => r.includes('ALBORIHI:claude-sonnet-5') && r.includes('EXCLUDED_FAMILY'))).toBe(true)
  })

  test('question-verifier helper agrees: GPT after Claude ok, Claude after Claude never', () => {
    expect(__testVerifierFamilyAllowedForTests({ provider: 'ALBORIHI', model: 'gpt-5.6-luna' }, 'ALBORIHI', 'claude')).toEqual({ ok: true })
    expect(__testVerifierFamilyAllowedForTests({ provider: 'ALBORIHI', model: 'claude-opus-4-6' }, 'ALBORIHI', 'claude')).toEqual({ ok: false, reason: 'VERIFIER_SAME_FAMILY' })
    // A catalog-declared claude family beats the gpt-looking name.
    expect(__testVerifierFamilyAllowedForTests({ provider: 'ALBORIHI', model: 'gpt-5.6-luna', family: 'claude' }, 'ALBORIHI', 'claude')).toEqual({ ok: false, reason: 'VERIFIER_SAME_FAMILY' })
  })
})

describe('auditor independence — router end to end under auto ON', () => {
  test('ALBORIHI exception: cross-family model attempted, same-family model never attempted', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('REVIEW', [
      { provider: 'ALBORIHI', model: 'claude-sonnet-5' },
      { provider: 'ALBORIHI', model: 'gpt-5.6-luna' },
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
    ])
    process.env.ALBORIHI_API_KEY = 'alborihi-test-key'
    values.set('ALBORIHI_TEXT_MODEL', 'claude-sonnet-5')
    process.env.GROQ_API_KEY = 'gsk-test-key'
    values.set('GROQ_TEXT_MODEL', 'llama-3.3-70b-versatile')
    const seenModels: string[] = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      if (urlText.includes('alborihi-ai.com') && urlText.endsWith('/models')) {
        return jsonResponse({ data: [
          { id: 'gpt-5.6-luna', context_length: 200000 },
          { id: 'claude-sonnet-5', context_length: 200000 },
          { id: 'claude-opus-4-6', context_length: 200000 },
        ] })
      }
      if (urlText.endsWith('/models')) {
        return jsonResponse({ data: [{ id: 'llama-3.3-70b-versatile', context_length: 131072 }] })
      }
      if (urlText.endsWith('/chat/completions')) {
        const model = JSON.parse(String(init?.body || '{}')).model as string
        seenModels.push(model)
        return jsonResponse({ choices: [{ message: { content: model === 'gpt-5.6-luna' ? 'verified' : 'other-verified' } }] })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any
    // Generator is ALBORIHI / claude family. The ALBORIHI exception
    // re-admits the provider, but the family exclusion must still hold.
    const reply = await textAi.textAiComplete({
      system: 'verify', history: [{ role: 'user', text: 'check this' }],
      purpose: 'REVIEW', taskLevel: 'ACADEMIC_CRITICAL',
      excludeProviders: ['ALBORIHI'], excludeModelFamilies: ['claude'],
      allowAlborihiCrossFamilyVerifier: true,
    })
    expect(reply).toBe('verified')
    expect(seenModels).toEqual(['gpt-5.6-luna'])
    expect(seenModels).not.toContain('claude-sonnet-5')
    expect(seenModels).not.toContain('claude-opus-4-6')
  })
})

describe('paid models are never ranked when paid is off', () => {
  test('scorer: paid model excluded with PAID_BLOCKED; allowed only with explicit permission + budget', () => {
    const blocked = autoMode.scoreModelForTask({
      provider: 'OPENAI', model: 'gpt-5.1', purpose: 'CHAT',
      costState: { costTier: 'paid', allowPaid: false },
    })
    expect(blocked.score).toBe(0)
    expect(blocked.excludedReason).toBe('PAID_BLOCKED')
    const allowed = autoMode.scoreModelForTask({
      provider: 'OPENAI', model: 'gpt-5.1', purpose: 'CHAT',
      stats: { success: 5, fail: {}, avgMs: 100, jsonOk: 5, jsonTotal: 5, evidenceOk: 5, evidenceTotal: 5 },
      costState: { costTier: 'paid', allowPaid: true, budgetOk: true },
    })
    expect(allowed.score).toBeGreaterThan(0)
    expect(allowed.excludedReason).toBeUndefined()
  })

  test('choke point: paid model dropped from EVERY purpose ranking', () => {
    const paid = { provider: 'OPENAI', model: 'some-paid-model' }
    const free = { provider: 'GROQ', model: 'llama-3.3-70b-versatile' }
    for (const purpose of autoMode.AUTO_PURPOSES) {
      const resolved = autoMode.resolveAutoCandidates({
        autoMode: true, ranking: [paid, free], purpose,
        paidBlockedModels: ['some-paid-model'],
      })
      expect(resolved.autoCandidates.map((c) => c.model)).not.toContain('some-paid-model')
      expect(resolved.autoCandidates.map((c) => c.model)).toContain('llama-3.3-70b-versatile')
      expect(resolved.excludedReasons.some((r) => r.includes('some-paid-model') && r.includes('PAID_BLOCKED'))).toBe(true)
    }
  })
})

describe('paid models are never ranked when paid is off — router end to end', () => {
  test('ON, AI_PAID_USAGE_MODE=off: the paid model in the ranking is never attempted', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    values.set('AI_PAID_USAGE_MODE', 'off')
    values.set('AI_PAID_MODELS', 'gpt-5.1')
    setRanking('CHAT', [
      { provider: 'OPENAI', model: 'gpt-5.1' },
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
    ])
    process.env.OPENAI_API_KEY = 'sk-test-key'
    values.set('OPENAI_TEXT_MODEL', 'gpt-5.1')
    process.env.GROQ_API_KEY = 'gsk-test-key'
    values.set('GROQ_TEXT_MODEL', 'llama-3.3-70b-versatile')
    const seenModels: string[] = []
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      if (urlText.endsWith('/models')) {
        return jsonResponse({ data: [{ id: 'llama-3.3-70b-versatile', context_length: 131072 }] })
      }
      if (urlText.endsWith('/chat/completions')) {
        const model = JSON.parse(String(init?.body || '{}')).model as string
        seenModels.push(model)
        return jsonResponse({ choices: [{ message: { content: 'groq-ok' } }] })
      }
      throw new Error(`unexpected fetch: ${urlText}`)
    }) as any
    const reply = await textAi.textAiComplete({ system: 'test', history: [{ role: 'user', text: 'hi' }] })
    expect(reply).toBe('groq-ok')
    expect(seenModels).toEqual(['llama-3.3-70b-versatile'])
    expect(seenModels).not.toContain('gpt-5.1')
  })
})

describe('quota-safe periodic catalog updates', () => {
  test('unconfigured providers are skipped while active providers remain discoverable', async () => {
    process.env.GROQ_API_KEY = 'test-configured-key'
    const configured = await textAi.textAiAutoConfiguredProviders()
    expect(configured).toContain('GROQ')
    expect(configured).not.toContain('OPENAI')
    expect(configured).not.toContain('ANTHROPIC')
    const cron = readFileSync('src/app/api/cron/ai-auto-refresh/route.ts', 'utf8')
    expect(cron).toContain('textAiAutoConfiguredProviders()')
    expect(cron).toContain('configured.has(provider)')
  })
})

describe('no permission change — auto ON/OFF does not change who can call admin routes', () => {
  test('the auto cron route is CRON_SECRET gated and the check precedes any auto logic', () => {
    const route = readFileSync('src/app/api/cron/ai-auto-refresh/route.ts', 'utf8')
    expect(route).toContain('request.headers.get(\'authorization\')')
    expect(route).toContain('Bearer ${secret}')
    expect(route).toContain("return NextResponse.json(redactDeep({ error: 'UNAUTHORIZED' }), { status: 401 })")
    // Auth is the first decision in GET: the auto-mode read happens after it.
    expect(route.indexOf('authorization')).toBeLessThan(route.indexOf('AI_AUTO_MODE_ENABLED'))
  })

  test('the auto toggle goes through the same requireAdmin gate as every system key', () => {
    const route = readFileSync('src/app/api/admin/system/route.ts', 'utf8')
    expect(route).toContain('await requireAdmin()')
    expect(route).toContain("'AI_AUTO_MODE_ENABLED'")
    expect(route).toContain("'AI_AUTO_MODE_CONFIG'")
  })

  test('cron route without auth returns 401 whether auto is ON or OFF', async () => {
    process.env.CRON_SECRET = 'test-cron-secret'
    for (const autoValue of ['1', '0']) {
      values.set('AI_AUTO_MODE_ENABLED', autoValue)
      const noAuth = await autoRefreshRoute.GET(
        new NextRequest('https://academy.test/api/cron/ai-auto-refresh', { method: 'GET' }),
      )
      expect(noAuth.status).toBe(401)
      expect((await noAuth.json()).error).toBe('UNAUTHORIZED')
      const wrongSecret = await autoRefreshRoute.GET(
        new NextRequest('https://academy.test/api/cron/ai-auto-refresh', {
          method: 'GET', headers: { authorization: 'Bearer wrong-secret' },
        }),
      )
      expect(wrongSecret.status).toBe(401)
    }
  })
})
