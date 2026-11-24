/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 7g — ASR selection WITHIN ASR only (asr.ts).
// OFF: today's order (Gemini Files-API transcription, then Whisper).
// ON: the stored AI_AUTO_RANKING:ASR order decides which backend is
// tried first. Protocols are unchanged: Gemini keeps its Files-API
// upload flow, Whisper keeps its /audio/transcriptions endpoint.
// Nothing here goes through the text router.

let autoMode = false
let asrRanking: Array<{ backend: string; score?: number }> = []
const geminiGenerateCalls: Array<{ model: string }> = []
const whisperCalls: Array<{ url: string }> = []
const originalFetch = globalThis.fetch
const originalOpenAiKey = process.env.OPENAI_API_KEY

mock.module('@/lib/gemini', () => ({
  geminiApiKeys: async () => ['gemini-key-1'],
  isRetryableGeminiKeyError: () => true,
}))
mock.module('@/lib/text-ai', () => ({
  isTextAiAutoModeEnabled: async () => autoMode,
  autoAsrRanking: async () => asrRanking.map((e) => ({ backend: e.backend, score: e.score })),
}))
mock.module('@google/genai', () => ({
  GoogleGenAI: class {
    files = {
      upload: async () => ({ name: 'files/abc', uri: 'gs://bucket/voice.ogg', mimeType: 'audio/ogg', state: 'ACTIVE' }),
      get: async () => ({ name: 'files/abc', uri: 'gs://bucket/voice.ogg', mimeType: 'audio/ogg', state: 'ACTIVE' }),
      delete: async () => ({}),
    }
    models = {
      generateContent: async (args: any) => {
        geminiGenerateCalls.push({ model: String(args?.model || '') })
        return { candidates: [{ content: { parts: [{ text: 'gemini transcript' }] } }] }
      },
    }
  },
  createPartFromUri: (uri: string, mimeType: string) => ({ fileData: { fileUri: uri, mimeType } }),
  createUserContent: (parts: unknown) => ({ parts }),
}))

const asr = await import('../../src/lib/asr')

const AUDIO = Buffer.from('fake-audio-bytes').toString('base64')

function installWhisperFetch() {
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    whisperCalls.push({ url: String(url) })
    return new Response(JSON.stringify({ text: 'whisper transcript' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as any
}

beforeEach(() => {
  autoMode = false
  asrRanking = []
  geminiGenerateCalls.length = 0
  whisperCalls.length = 0
  process.env.OPENAI_API_KEY = 'openai-key-1'
  installWhisperFetch()
})

describe('transcribeAudioBase64 under auto mode (step 7g)', () => {
  test('OFF: Gemini first; Whisper never attempted when Gemini answers', async () => {
    const text = await asr.transcribeAudioBase64(AUDIO, { mimeType: 'audio/ogg' })
    expect(text).toBe('gemini transcript')
    expect(geminiGenerateCalls.length).toBe(1)
    expect(whisperCalls.length).toBe(0)
  })

  test('ON with WHISPER-first ranking: Whisper first; Gemini never attempted', async () => {
    autoMode = true
    asrRanking = [{ backend: 'WHISPER', score: 0.9 }, { backend: 'GEMINI', score: 0.4 }]
    const text = await asr.transcribeAudioBase64(AUDIO, { mimeType: 'audio/ogg' })
    expect(text).toBe('whisper transcript')
    expect(whisperCalls.length).toBe(1)
    expect(whisperCalls[0]?.url).toContain('/audio/transcriptions')
    expect(geminiGenerateCalls.length).toBe(0)
  })

  test('ON with GEMINI-first ranking: Gemini first, same as OFF', async () => {
    autoMode = true
    asrRanking = [{ backend: 'GEMINI', score: 0.9 }, { backend: 'WHISPER', score: 0.4 }]
    const text = await asr.transcribeAudioBase64(AUDIO, { mimeType: 'audio/ogg' })
    expect(text).toBe('gemini transcript')
    expect(geminiGenerateCalls.length).toBe(1)
    expect(whisperCalls.length).toBe(0)
  })
})

describe('transcribeWhatsAppVoiceBase64 under auto mode (step 7g)', () => {
  test('OFF: fast Gemini inline attempt first', async () => {
    const text = await asr.transcribeWhatsAppVoiceBase64(AUDIO, { mimeType: 'audio/ogg' })
    expect(text).toBe('gemini transcript')
    expect(geminiGenerateCalls.length).toBe(1)
    expect(whisperCalls.length).toBe(0)
  })

  test('ON with WHISPER-first ranking: Whisper first; Gemini inline never attempted', async () => {
    autoMode = true
    asrRanking = [{ backend: 'WHISPER', score: 0.9 }, { backend: 'GEMINI', score: 0.4 }]
    const text = await asr.transcribeWhatsAppVoiceBase64(AUDIO, { mimeType: 'audio/ogg' })
    expect(text).toBe('whisper transcript')
    expect(whisperCalls.length).toBe(1)
    expect(geminiGenerateCalls.length).toBe(0)
  })
})

// Restore the process env/fetch this file touched.
;(globalThis as any).__autoPathsAsrCleanup = () => {
  globalThis.fetch = originalFetch
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = originalOpenAiKey
}
