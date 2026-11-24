/// <reference types="bun-types" />
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 2 — Part 7 core seam: resolveAutoCandidates inside textAiComplete +
// governed Gemini shim (geminiCompleteJson / geminiStreamText /
// geminiVisionJson). The native GoogleGenAI SDK is mocked so no network is
// attempted; the router is driven with stubbed HTTP.
const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const originalEnv: Record<string, string | undefined> = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  APINEX_API_KEY: process.env.APINEX_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_API_KEYS: process.env.GEMINI_API_KEYS,
}

const nativeCalls: Array<{ model: string; kind: 'json' | 'stream' | 'vision' }> = []

const db: any = {
  aiUsageLog: { create: async () => ({}) },
  user: { findUnique: async () => null },
  keyRateWindow: { upsert: async () => ({}), findUnique: async () => ({ count: 1 }) },
  setting: { findMany: async () => [], findUnique: async () => null, upsert: async () => ({}) },
}
mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/settings', () => ({ getSetting: async (key: string) => values.get(key) || '' }))
mock.module('@google/genai', () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (args: any) => {
        const isVision = JSON.stringify(args || {}).includes('inlineData')
        nativeCalls.push({ model: String(args?.model || ''), kind: isVision ? 'vision' : 'json' })
        return { text: '{"native":"ok"}' }
      },
      generateContentStream: async function* (args: any) {
        nativeCalls.push({ model: String(args?.model || ''), kind: 'stream' })
        yield { text: 'hello-native' }
      },
    }
  },
}))

const textAi = await import('../../src/lib/text-ai')
const autoMode = await import('../../src/lib/ai-auto-mode')
const gemini = await import('../../src/lib/gemini')

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

interface FetchBehaviour {
  groqChat?: number
  geminiGenerate?: number
  apinexChat?: number
}

// Records every router provider attempt (discovery /models excluded).
function installFetch(behaviour: FetchBehaviour = {}) {
  const calls: Array<{ url: string; model: string }> = []
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url)
    if (urlText.includes('generativelanguage.googleapis.com/v1beta/models?')) {
      return jsonResponse({ models: [
        { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      ] })
    }
    if (urlText.includes(':generateContent')) {
      const model = decodeURIComponent(urlText.split('/models/')[1].split(':')[0])
      calls.push({ url: urlText, model })
      if ((behaviour.geminiGenerate ?? 200) !== 200) return jsonResponse({ error: { message: 'boom' } }, behaviour.geminiGenerate)
      return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"ok":"gemini"}' }] } }] })
    }
    if (urlText.includes('api.apinex.bond') && urlText.endsWith('/models')) {
      return jsonResponse({ data: [
        { id: 'free/gemini-3.8-flash', context_length: 1000000 },
        { id: 'free/deepseek-v4.1-flash', context_length: 1000000 },
      ] })
    }
    if (urlText.includes('api.apinex.bond') && urlText.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body || '{}'))
      calls.push({ url: urlText, model: body.model })
      if ((behaviour.apinexChat ?? 200) !== 200) return jsonResponse({ error: { message: 'boom' } }, behaviour.apinexChat)
      return jsonResponse({ choices: [{ message: { content: '{"pages":[]}' } }] })
    }
    if (urlText.endsWith('/models')) {
      return jsonResponse({ data: [{ id: 'llama-3.3-70b-versatile', context_length: 131072 }] })
    }
    if (urlText.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body || '{}'))
      calls.push({ url: urlText, model: body.model })
      if ((behaviour.groqChat ?? 200) !== 200) return jsonResponse({ error: { message: 'boom' } }, behaviour.groqChat)
      return jsonResponse({ choices: [{ message: { content: '{"ok":"groq"}' } }] })
    }
    throw new Error(`unexpected fetch: ${urlText}`)
  }) as any
  return calls
}

function setRanking(purpose: string, candidates: Array<{ provider: string; model: string }>) {
  values.set(`AI_AUTO_RANKING:${purpose}`, JSON.stringify({ candidates }))
}

beforeEach(() => {
  values.clear()
  nativeCalls.length = 0
  globalThis.fetch = originalFetch
  delete process.env.GROQ_API_KEY
  delete process.env.APINEX_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_API_KEYS
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

describe('resolveAutoCandidates passthrough when OFF (router level)', () => {
  test('OFF: caller preferredModels/restrictToModels reach the router unchanged', async () => {
    values.set('GEMINI_API_KEY', 'test-gemini-key')
    values.set('GEMINI_TEXT_MODEL', 'gemini-3.5-flash-lite')
    process.env.GROQ_API_KEY = 'gsk-test-key'
    values.set('GROQ_TEXT_MODEL', 'llama-3.3-70b-versatile')
    const calls = installFetch()
    // A caller pin stays a pin when auto is OFF.
    const reply = await textAi.textAiCompleteJson({
      system: 'test', history: [{ role: 'user', text: 'hi' }],
      preferredModels: [{ provider: 'GROQ', model: 'llama-3.3-70b-versatile' }],
    })
    expect(reply).toBe('{"ok":"groq"}')
    expect(calls[0].model).toBe('llama-3.3-70b-versatile')
    expect(autoMode.resolveAutoCandidates({ autoMode: false, ranking: [{ provider: 'GROQ', model: 'x' }] }).autoOverride).toBe(false)
  })
})

describe('ranking replaces inputs when ON, exclusions preserved', () => {
  test('ON: verifier exclusion survives — excluded provider is never attempted', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('CHAT', [
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
      { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' },
    ])
    values.set('GEMINI_API_KEY', 'test-gemini-key')
    values.set('GEMINI_TEXT_MODEL', 'gemini-3.5-flash-lite')
    process.env.GROQ_API_KEY = 'gsk-test-key'
    values.set('GROQ_TEXT_MODEL', 'llama-3.3-70b-versatile')
    const calls = installFetch()
    // excludeProviders marks a verifier-style call: Groq is the generator
    // here, so the ranking must not re-admit it even though it ranks first.
    const reply = await textAi.textAiCompleteJson({
      system: 'test', history: [{ role: 'user', text: 'hi' }],
      excludeProviders: ['GROQ'],
    })
    expect(reply).toBe('{"ok":"gemini"}')
    expect(calls).toHaveLength(1)
    expect(calls[0].model).toBe('gemini-3.5-flash-lite')
    expect(calls.some((c) => c.url.includes('api.groq.com'))).toBe(false)
  })

  test('ON: excludeModelFamilies survives — same-family candidate is never attempted', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('CHAT', [{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }])
    values.set('GEMINI_API_KEY', 'test-gemini-key')
    values.set('GEMINI_TEXT_MODEL', 'gemini-3.5-flash-lite')
    process.env.GROQ_API_KEY = 'gsk-test-key'
    values.set('GROQ_TEXT_MODEL', 'llama-3.3-70b-versatile')
    const calls = installFetch()
    // The Gemini family is excluded (verifier must differ from generator).
    // No other qualified auto model exists, so the call must fail closed
    // instead of silently switching to the manual Groq configuration.
    await expect(textAi.textAiCompleteJson({
      system: 'test', history: [{ role: 'user', text: 'hi' }],
      excludeProviders: ['OPENAI'],
      excludeModelFamilies: ['gemini'],
    })).rejects.toThrow(/AI_AUTO_NO_QUALIFIED_MODEL_FOR_TASK/)
    expect(calls.some((c) => c.url.includes('generativelanguage.googleapis.com'))).toBe(false)
    expect(calls.some((c) => c.url.includes('api.groq.com'))).toBe(false)
  })
})

describe('Gemini shim native fallback is governed when ON', () => {
  function configureRouterFails() {
    process.env.GROQ_API_KEY = 'gsk-test-key'
    values.set('GROQ_TEXT_MODEL', 'llama-3.3-70b-versatile')
    process.env.GEMINI_API_KEY = 'test-gemini-key'
    values.set('GEMINI_TEXT_MODEL', 'gemini-3.5-flash-lite')
  }

  test('OFF: router failure still falls back to native Gemini (today’s behaviour)', async () => {
    configureRouterFails()
    installFetch({ groqChat: 500, geminiGenerate: 500 })
    const reply = await gemini.geminiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'hi' }] })
    expect(reply).toBe('{"native":"ok"}')
    expect(nativeCalls).toHaveLength(1)
    expect(nativeCalls[0].kind).toBe('json')
  })

  test('ON, Gemini NOT in the ranking: router error stands, native never called', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('CHAT', [{ provider: 'GROQ', model: 'llama-3.3-70b-versatile' }])
    configureRouterFails()
    installFetch({ groqChat: 500, geminiGenerate: 500 })
    await expect(gemini.geminiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'hi' }] })).rejects.toThrow(/GROQ|TEXT_AI_ROUTER/)
    expect(nativeCalls).toHaveLength(0)
  })

  test('ON, Gemini IS in the ranking: router exhaustion never bypasses selection', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('CHAT', [
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile' },
      { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' },
    ])
    configureRouterFails()
    installFetch({ groqChat: 500, geminiGenerate: 500 })
    await expect(gemini.geminiCompleteJson({ system: 'test', history: [{ role: 'user', text: 'hi' }] })).rejects.toThrow()
    expect(nativeCalls).toHaveLength(0)
  })

  test('ON: purpose selects the ranking — GENERATION failure cannot use native fallback', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('CHAT', [{ provider: 'GROQ', model: 'llama-3.3-70b-versatile' }])
    setRanking('GENERATION', [{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }])
    configureRouterFails()
    installFetch({ groqChat: 500, geminiGenerate: 500 })
    await expect(gemini.geminiCompleteJson({
      system: 'test', history: [{ role: 'user', text: 'hi' }], purpose: 'GENERATION',
    })).rejects.toThrow()
    expect(nativeCalls).toHaveLength(0)
  })

  test('ON, Gemini NOT in the ranking: stream fallback is also blocked', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('CHAT', [{ provider: 'GROQ', model: 'llama-3.3-70b-versatile' }])
    configureRouterFails()
    installFetch({ groqChat: 500, geminiGenerate: 500 })
    let out = ''
    await expect((async () => {
      for await (const chunk of gemini.geminiStreamText({ system: 'test', history: [{ role: 'user', text: 'hi' }] })) out += chunk
    })()).rejects.toThrow()
    expect(out).toBe('')
    expect(nativeCalls).toHaveLength(0)
  })

  test('OFF: stream fallback reaches native Gemini', async () => {
    configureRouterFails()
    installFetch({ groqChat: 500, geminiGenerate: 500 })
    let out = ''
    for await (const chunk of gemini.geminiStreamText({ system: 'test', history: [{ role: 'user', text: 'hi' }] })) out += chunk
    expect(out).toBe('hello-native')
    expect(nativeCalls).toHaveLength(1)
    expect(nativeCalls[0].kind).toBe('stream')
  })
})

describe('geminiVisionJson routes via the router when ON', () => {
  const images = [{ mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }]

  test('ON: vision goes through the router ranking (APINEX), native never called', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('VISION', [{ provider: 'APINEX', model: 'free/gemini-3.8-flash' }])
    process.env.APINEX_API_KEY = 'apinex-test-key'
    values.set('APINEX_BASE_URL', 'https://api.apinex.bond/v1')
    values.set('APINEX_TEXT_MODEL', 'free/gemini-3.8-flash')
    const calls = installFetch()
    const reply = await gemini.geminiVisionJson({ prompt: 'read this page', images })
    expect(reply).toBe('{"pages":[]}')
    expect(nativeCalls).toHaveLength(0)
    expect(calls.some((c) => c.url.includes('api.apinex.bond') && c.model === 'free/gemini-3.8-flash')).toBe(true)
  })

  test('ON, ranking non-empty: router failure stands, native never called', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('VISION', [{ provider: 'APINEX', model: 'free/gemini-3.8-flash' }])
    process.env.APINEX_API_KEY = 'apinex-test-key'
    values.set('APINEX_BASE_URL', 'https://api.apinex.bond/v1')
    values.set('APINEX_TEXT_MODEL', 'free/gemini-3.8-flash')
    process.env.GEMINI_API_KEY = 'test-gemini-key'
    installFetch({ apinexChat: 500, geminiGenerate: 500 })
    await expect(gemini.geminiVisionJson({ prompt: 'read this page', images })).rejects.toThrow()
    expect(nativeCalls).toHaveLength(0)
  })

  test('ON, ranking empty: bootstrap may route, but native manual model is forbidden', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    setRanking('VISION', [])
    process.env.APINEX_API_KEY = 'apinex-test-key'
    values.set('APINEX_BASE_URL', 'https://api.apinex.bond/v1')
    values.set('APINEX_TEXT_MODEL', 'free/gemini-3.8-flash')
    process.env.GEMINI_API_KEY = 'test-gemini-key'
    installFetch({ apinexChat: 500, geminiGenerate: 500 })
    await expect(gemini.geminiVisionJson({ prompt: 'read this page', images })).rejects.toThrow()
    expect(nativeCalls).toHaveLength(0)
  })

  test('OFF: vision stays on the native path (today’s behaviour)', async () => {
    process.env.GEMINI_API_KEY = 'test-gemini-key'
    installFetch({ apinexChat: 500, geminiGenerate: 500 })
    const reply = await gemini.geminiVisionJson({ prompt: 'read this page', images })
    expect(reply).toBe('{"native":"ok"}')
    expect(nativeCalls).toHaveLength(1)
    expect(nativeCalls[0].kind).toBe('vision')
  })
})
