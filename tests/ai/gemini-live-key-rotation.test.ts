/// <reference types="bun-types" />
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

let supervisorAccessLocked = false
let reserveUsageCalls = 0

const db: any = {
  auditLog: { create: async () => ({}) },
  enrollment: { count: async () => 0 },
  thesisSubmission: { findFirst: async () => null },
  setting: {
    findMany: async () => [],
    findUnique: async () => null,
    upsert: async () => ({}),
    delete: async () => ({}),
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({ requireUser: async () => ({ id: 'student-1', role: 'STUDENT' }) }))
mock.module('@/lib/student-ai-access', () => ({
  requireStudentAiSupervisorAccess: async () => {
    if (supervisorAccessLocked) {
      const err: any = new Error('locked')
      err.code = 'AI_SUPERVISOR_LOCKED'
      err.reason = 'المشرف الذكي غير متاح لهذا الطالب حالياً'
      throw err
    }
    return { ok: true }
  },
}))
mock.module('@/lib/rate-limit', () => ({ enforceApiRateLimit: () => null }))
mock.module('@/lib/settings', () => ({ getSetting: async () => 'ar-PS' }))
mock.module('@/lib/supervisor-ai', () => ({
  buildSupervisorContext: async () => '',
  mergeContext: (...parts: unknown[]) => parts.filter(Boolean).join('\n'),
}))
mock.module('@/lib/voicePrompt', () => ({ buildVoiceSystemPrompt: (context: string) => `voice:${context}` }))
mock.module('@/lib/live-usage-guard', () => ({
  getGeminiLiveAllowance: async () => ({ ok: true, status: 200, sessionLimitMinutes: 10, totalRemainingMinutes: 10, message: 'ok' }),
  reserveGeminiLiveUsage: async () => {
    reserveUsageCalls++
    return { ok: true, status: 200, sessionId: 'live-session-1', sessionLimitMinutes: 10, totalRemainingMinutes: 8, message: 'ok' }
  },
}))

const realGemini = await import('../../src/lib/gemini')
mock.module('@/lib/gemini', () => ({
  ...realGemini,
  geminiActiveLiveModel: async () => 'gemini-3.1-flash-live-preview',
  geminiTTSVoice: async () => 'Charon',
}))

const textAi = await import('../../src/lib/text-ai')
const { dialectInstruction } = await import('../../src/lib/voice-dialect')
const { POST, buildGeminiLiveSetup, buildGeminiLiveSdkConfig, cleanDialect } = await import('../../src/app/api/ai/gemini-live/session/route')

const values = new Map<string, string>()
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
}

const originalFetch = globalThis.fetch
const originalGeminiApiKey = process.env.GEMINI_API_KEY
const originalGeminiApiKeys = process.env.GEMINI_API_KEYS
let fetchKeys: string[] = []

function configureGeminiKeys(...keys: string[]) {
  values.set('GEMINI_API_KEYS', keys.join('\n'))
}

function liveRequest(dialect = 'ar-PS') {
  return new NextRequest('http://localhost/api/ai/gemini-live/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testOnly: true, purpose: 'SUPERVISOR', model: 'gemini-3.1-flash-live-preview', dialect }),
  })
}

function mockTokenFetch(handler: (key: string) => { status: number; body: unknown }) {
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined
    const key = String(headers?.['x-goog-api-key'] || '')
    fetchKeys.push(key)
    const result = handler(key)
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as any
}

beforeEach(() => {
  values.clear()
  globalThis.fetch = originalFetch
  fetchKeys = []
  supervisorAccessLocked = false
  reserveUsageCalls = 0
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_API_KEYS
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
})

afterAll(() => {
  globalThis.fetch = originalFetch
  textAi.__setTextAiSettingStoreForTests(null)
  if (originalGeminiApiKey === undefined) delete process.env.GEMINI_API_KEY
  else process.env.GEMINI_API_KEY = originalGeminiApiKey
  if (originalGeminiApiKeys === undefined) delete process.env.GEMINI_API_KEYS
  else process.env.GEMINI_API_KEYS = originalGeminiApiKeys
})

describe('Gemini Live raw setup shape', () => {
  test('normalizes legacy Gemini model aliases before routing', () => {
    expect(realGemini.normalizeGeminiModelName('models/gemini-3.5-flash')).toBe('gemini-3.5-flash-lite')
    expect(realGemini.normalizeGeminiModelName('gemini-3.7-flash')).toBe('gemini-3.8-flash')
    expect(realGemini.normalizeGeminiModelName('gemini-2.0-flash')).toBe('gemini-3.8-flash')
    expect(realGemini.normalizeGeminiModelName('gemini-2.5-flash-live-preview')).toBe('gemini-2.5-flash-native-audio-preview-12-2025')
    expect(textAi.parseAcademicAllowlist('GEMINI:gemini-3.5-flash')).toEqual([
      { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' },
    ])
  })

  test('discovers all allowed Alborihi text models from /models', async () => {
    values.set('AI_TEXT_PROVIDER', 'ALBORIHI')
    values.set('ALBORIHI_API_KEYS', 'alb_dev_test')
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://alborihi-ai.com/api/public/dev/v1/models')
      expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe('Bearer alb_dev_test')
      return new Response(JSON.stringify({
        data: [
          { id: 'claude-sonnet-5', context_length: 200000, architecture: { input_modalities: ['text'], modality: 'text' } },
          { id: 'gpt-5.6-luna', context_length: 128000, architecture: { input_modalities: ['text', 'image'], modality: 'text' } },
          { id: 'small-context-chat', context_length: 8000, architecture: { input_modalities: ['text'], modality: 'text' } },
          { id: 'text-embedding-3-large', type: 'embedding' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as any

    const catalog = await textAi.textAiFreeModelsForProvider('ALBORIHI')
    expect(catalog.models).toEqual(['claude-sonnet-5', 'gpt-5.6-luna', 'small-context-chat'])
    expect(catalog.discoveredCount).toBe(3)
    expect(catalog.message).toContain('مسموح')
  })

  test('uses generationConfig for response modalities and keeps transcription directly under setup', () => {
    const variants = ['minimal', 'generationConfig', 'bare'] as const
    const palestinianInstruction = dialectInstruction('ar-PS')

    for (const variant of variants) {
      const payload = buildGeminiLiveSetup(variant, 'gemini-3.1-flash-live-preview', 'voice instructions', 'Charon', 'ar-PS') as any
      const setup = payload.setup

      expect(setup.model).toBe('models/gemini-3.1-flash-live-preview')
      expect(setup.generationConfig?.responseModalities).toEqual(['AUDIO'])
      expect(setup.generationConfig?.speechConfig).toEqual({
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } },
      })
      expect(setup.generationConfig?.speechConfig?.languageCode).toBeUndefined()
      expect(setup.systemInstruction.parts[0].text.startsWith(palestinianInstruction)).toBe(true)
      expect(setup.systemInstruction.parts[0].text).toContain('\n\nvoice instructions')
      expect(setup.inputAudioTranscription).toEqual({})
      expect(setup.inputAudioTranscription.languageCode).toBeUndefined()
      expect(setup.outputAudioTranscription).toEqual({})
      expect(setup.outputAudioTranscription.languageCode).toBeUndefined()
      expect(setup.responseModalities).toBeUndefined()
      expect(setup.speechConfig).toBeUndefined()
      expect(setup.generationConfig?.inputAudioTranscription).toBeUndefined()
      expect(setup.generationConfig?.outputAudioTranscription).toBeUndefined()
    }
  })

  test('normalizes unknown dialect codes to the supported default', () => {
    expect(cleanDialect('ar-XX')).toBe('ar-PS')
    expect(cleanDialect('ar-IQ')).toBe('ar-IQ')
    expect(dialectInstruction('xx-YY')).toBe(dialectInstruction('ar-PS'))
  })

  test('uses the same dialect instruction and transcription shape in SDK config', () => {
    const palestinianInstruction = dialectInstruction('ar-PS')
    const sdkConfig = buildGeminiLiveSdkConfig('voice instructions', 'Charon', 'ar-PS') as any

    expect(sdkConfig.responseModalities).toEqual(['AUDIO'])
    expect(sdkConfig.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } })
    expect(sdkConfig.inputAudioTranscription).toEqual({})
    expect(sdkConfig.inputAudioTranscription.languageCode).toBeUndefined()
    expect(sdkConfig.outputAudioTranscription).toEqual({})
    expect(sdkConfig.outputAudioTranscription.languageCode).toBeUndefined()
    expect(sdkConfig.systemInstruction.startsWith(palestinianInstruction)).toBe(true)
    expect(sdkConfig.systemInstruction).toContain('\n\nvoice instructions')
  })
})

describe('Gemini Live key rotation uses the text AI router state', () => {
  test('student without supervisor AI access receives 403 before minutes are reserved', async () => {
    supervisorAccessLocked = true
    configureGeminiKeys('AIzaGOOD2222')
    mockTokenFetch(() => ({ status: 200, body: { name: 'live-token' } }))

    const response = await POST(new NextRequest('http://localhost/api/ai/gemini-live/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ purpose: 'SUPERVISOR', model: 'gemini-3.1-flash-live-preview' }),
    }))
    const payload = await response.json()

    expect(response.status).toBe(403)
    expect(payload).toEqual({ error: 'المشرف الذكي غير متاح لهذا الطالب حالياً', code: 'AI_SUPERVISOR_LOCKED' })
    expect(fetchKeys).toEqual([])
    expect(reserveUsageCalls).toBe(0)
  })

  test('key 1 returns 403 and key 2 succeeds, while key 1 receives router cooldown', async () => {
    configureGeminiKeys('AIzaBAD1111', 'AIzaGOOD2222')
    mockTokenFetch((key) => key === 'AIzaBAD1111'
      ? { status: 403, body: { error: { message: 'PERMISSION_DENIED: Live API disabled for this key' } } }
      : { status: 200, body: { name: 'live-token-from-key-2' } })

    const response = await POST(liveRequest())
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ ok: true, model: 'gemini-3.1-flash-live-preview' })
    expect(payload.setup.setup.systemInstruction.parts[0].text.startsWith(dialectInstruction('ar-PS'))).toBe(true)
    expect(payload.sdkConfig.systemInstruction.startsWith(dialectInstruction('ar-PS'))).toBe(true)
    expect(fetchKeys).toEqual(['AIzaBAD1111', 'AIzaGOOD2222'])

    const cooldownRaw = values.get('AI_COOLDOWN:GEMINI:1:gemini-live')
    expect(cooldownRaw).toBeTruthy()
    const cooldown = JSON.parse(String(cooldownRaw))
    expect(cooldown.status).toBe(403)
    expect(Date.parse(cooldown.until)).toBeGreaterThan(Date.now() + 50 * 60 * 1000)

    const diagnostics = await textAi.textAiDiagnostics()
    expect(diagnostics.recentAttempts.map((attempt: any) => ({ provider: attempt.provider, keyIndex: attempt.keyIndex, ok: attempt.ok, status: attempt.status }))).toEqual([
      { provider: 'GEMINI', keyIndex: 1, ok: false, status: 403 },
      { provider: 'GEMINI', keyIndex: 2, ok: true, status: undefined },
    ])
  })

  test('a key cooled down only for a text model remains available for Live', async () => {
    configureGeminiKeys('AIzaTEXT1111', 'AIzaGOOD2222')
    values.set('AI_COOLDOWN:GEMINI:1:gemini-3.5-flash-lite', JSON.stringify({
      until: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      reason: 'text router cooldown',
      status: 429,
    }))
    mockTokenFetch(() => ({ status: 200, body: { name: 'live-token-from-key-1' } }))

    const response = await POST(liveRequest())

    expect(response.status).toBe(200)
    expect(fetchKeys).toEqual(['AIzaTEXT1111'])
  })

  test('a memory cooldown for a text model remains available for Live', async () => {
    configureGeminiKeys('AIzaMODEL1111')
    textAi.__testMarkModelCooldownForTests('GEMINI', 'AIzaMODEL1111', 'gemini-3.5-flash-lite')
    mockTokenFetch(() => ({ status: 200, body: { name: 'live-token-from-model-cooled-key' } }))

    const response = await POST(liveRequest())

    expect(response.status).toBe(200)
    expect(fetchKeys).toEqual(['AIzaMODEL1111'])
  })

  test('a memory cooldown with status 429 and api_key in the reason remains available for Live', async () => {
    configureGeminiKeys('AIzaRATE1111')
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlText = String(url)
      if (urlText.includes(':generateContent')) {
        fetchKeys.push('text:AIzaRATE1111')
        return new Response(JSON.stringify({ error: { message: 'rate limited api_key:xyz' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      const headers = init?.headers as Record<string, string> | undefined
      const key = String(headers?.['x-goog-api-key'] || '')
      fetchKeys.push(key)
      return new Response(JSON.stringify({ name: 'live-token-from-rate-key' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as any

    await expect(textAi.textAiComplete({
      system: 'test',
      history: [{ role: 'user', text: 'hello' }],
      maxOutputTokens: 8,
      deadlineMs: Date.now() + 5_000,
    })).rejects.toThrow()

    const response = await POST(liveRequest())

    expect(response.status).toBe(200)
    expect(fetchKeys).toEqual(['text:AIzaRATE1111', 'AIzaRATE1111'])
  })

  test('all key failures return a generic message without details to students', async () => {
    configureGeminiKeys('AIzaBAD1111', 'AIzaBAD2222')
    mockTokenFetch(() => ({ status: 401, body: { error: { message: 'UNAUTHENTICATED: invalid Live key' } } }))

    const response = await POST(liveRequest())
    const payload = await response.json()
    const serialized = JSON.stringify(payload)

    expect(response.status).toBe(401)
    expect(payload).toEqual({ error: 'الصوت غير متاح حالياً، استخدم المحادثة النصية' })
    expect(serialized).not.toContain('details')
    expect(serialized).not.toContain('AIzaBAD1111')
    expect(serialized).not.toContain('AIzaBAD2222')
    expect(serialized).not.toContain('AIza…1111')
    expect(serialized).not.toContain('AIza…2222')
  })
})
