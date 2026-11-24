/// <reference types="bun-types" />
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 7g + 7h — ASR selection within ASR only, and Live/TTS exclusion.
// Live/TTS models stay on their native chains and can never be substituted
// by (or injected into) text routing; ASR ranks backends (Gemini Files
// API vs Whisper-compatible endpoint), never text models.
import {
  AUTO_VOICE_EXCLUSION_NOTE,
  applyAsrOutcomeToRanking,
  filterVoiceModelsFromTextRanking,
  isVoiceNativeOnlyModel,
  parseAsrRanking,
  resolveAsrBackendOrder,
} from '../../src/lib/ai-auto-mode'

describe('voice exclusion (step 7h)', () => {
  test('every live/TTS model id from gemini.ts is voice-native-only', () => {
    const liveAndTts = [
      'gemini-3.8-live',
      'gemini-3.1-flash-live-preview',
      'gemini-2.5-flash-native-audio-preview-12-2025',
      'gemini-3.8-live-extended-thinking',
      'gemini-3.1-flash-tts-preview',
      'gemini-2.5-flash-preview-tts',
      'gemini-2.5-pro-preview-tts',
    ]
    for (const model of liveAndTts) expect(isVoiceNativeOnlyModel(model)).toBe(true)
  })

  test('text models are not voice-native-only', () => {
    for (const model of ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'llama-3.3-70b', 'gpt-5.6-luna']) {
      expect(isVoiceNativeOnlyModel(model)).toBe(false)
    }
  })

  test('a text ranking can never carry a live/TTS model into text routing', () => {
    const filtered = filterVoiceModelsFromTextRanking([
      { provider: 'GEMINI', model: 'gemini-3.8-flash' },
      { provider: 'GEMINI', model: 'gemini-3.8-live' },
      { provider: 'GEMINI', model: 'gemini-2.5-flash-preview-tts' },
      { provider: 'GROQ', model: 'llama-3.3-70b' },
    ])
    expect(filtered.map((c) => c.model)).toEqual(['gemini-3.8-flash', 'llama-3.3-70b'])
  })

  test('the dashboard marker names the exclusion', () => {
    expect(AUTO_VOICE_EXCLUSION_NOTE).toBe('voice: native protocol — not auto-selected')
  })
})

describe('ASR ranking (pure, step 7g)', () => {
  test('OFF (or empty ranking) keeps today\'s order: Gemini, then Whisper', () => {
    expect(resolveAsrBackendOrder({ autoMode: false, ranking: [{ backend: 'WHISPER' }], available: ['GEMINI', 'WHISPER'] }))
      .toEqual(['GEMINI', 'WHISPER'])
    expect(resolveAsrBackendOrder({ autoMode: true, ranking: [], available: ['GEMINI', 'WHISPER'] }))
      .toEqual(['GEMINI', 'WHISPER'])
  })

  test('ON with a stored WHISPER-first ranking tries Whisper first', () => {
    expect(resolveAsrBackendOrder({
      autoMode: true,
      ranking: [{ backend: 'WHISPER', score: 0.9 }, { backend: 'GEMINI', score: 0.4 }],
      available: ['GEMINI', 'WHISPER'],
    })).toEqual(['WHISPER', 'GEMINI'])
  })

  test('an unavailable backend is dropped, never attempted', () => {
    expect(resolveAsrBackendOrder({
      autoMode: true,
      ranking: [{ backend: 'WHISPER' }, { backend: 'GEMINI' }],
      available: ['GEMINI'],
    })).toEqual(['GEMINI'])
  })

  test('parseAsrRanking accepts both payload shapes and drops invalid backends', () => {
    expect(parseAsrRanking(JSON.stringify({ backends: [{ backend: 'WHISPER', model: 'whisper-1', score: 0.8 }] })))
      .toEqual([{ backend: 'WHISPER', model: 'whisper-1', score: 0.8 }])
    expect(parseAsrRanking([{ backend: 'gemini' }, { backend: 'OPENAI' }, { backend: 'WHISPER' }]))
      .toEqual([{ backend: 'GEMINI' }, { backend: 'WHISPER' }])
    expect(parseAsrRanking('not json')).toEqual([])
  })

  test('outcome feedback moves a success to the front and a failure to the back', () => {
    const ranking = [{ backend: 'GEMINI' as const }, { backend: 'WHISPER' as const }]
    expect(applyAsrOutcomeToRanking(ranking, 'WHISPER', true).map((e) => e.backend)).toEqual(['WHISPER', 'GEMINI'])
    expect(applyAsrOutcomeToRanking(ranking, 'GEMINI', false).map((e) => e.backend)).toEqual(['WHISPER', 'GEMINI'])
  })
})

// --- Settings-seam guard: a stored ranking listing a live model can
// never put it on the text path (filter applied in settings()) ---

const values = new Map<string, string>()
const dbStub: any = {
  aiUsageLog: { create: async () => ({}) },
  user: { findUnique: async () => null },
  keyRateWindow: { upsert: async () => ({}), findUnique: async () => ({ count: 1 }) },
  setting: { findMany: async () => [], findUnique: async () => null, upsert: async () => ({}) },
}
mock.module('@/lib/db', () => ({ db: dbStub }))
mock.module('@/lib/settings', () => ({ getSetting: async (key: string) => values.get(key) || '' }))
mock.module('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: async () => ({ text: '{}' }), generateContentStream: async function* () { yield { text: 'x' } } }
    files = { upload: async () => ({}), get: async () => ({}), delete: async () => ({}) }
  },
  createPartFromUri: (uri: string, mimeType: string) => ({ fileData: { fileUri: uri, mimeType } }),
  createUserContent: (parts: unknown) => ({ parts }),
}))

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

describe('voice models never enter text routing (settings seam, step 7h)', () => {
  beforeEach(() => {
    values.clear()
    textAi.__resetTextAiStateForTests()
    textAi.__setTextAiSettingStoreForTests(makeStore(values) as any)
  })
  afterAll(() => {
    textAi.__setTextAiSettingStoreForTests(null)
  })

  test('autoRankingForPurpose drops a stored live/TTS model', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    values.set('AI_AUTO_RANKING:CHAT', JSON.stringify({
      candidates: [
        { provider: 'GEMINI', model: 'gemini-3.8-live', score: 0.99 },
        { provider: 'GEMINI', model: 'gemini-3.8-flash', score: 0.8 },
        { provider: 'GEMINI', model: 'gemini-2.5-flash-preview-tts', score: 0.7 },
      ],
    }))
    const ranking = await textAi.autoRankingForPurpose('CHAT')
    expect(ranking.map((c) => c.model)).toEqual(['gemini-3.8-flash'])
  })
})
