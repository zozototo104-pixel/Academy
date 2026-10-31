import { describe, expect, test } from 'bun:test'
import { extractWhatsAppInboundMessages } from '../src/lib/whatsapp-cloud'

// Keep provider fallback assertions alongside WhatsApp voice attachment coverage.
describe('ASR fallback for WhatsApp voice and ordinary audio', () => {
  const saved = {
    gemini: process.env.GEMINI_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    groq: process.env.GROQ_API_KEY,
  }

  async function withWhisperMock(reply: { ok: boolean; body: unknown }, check: (calls: { url: string; mime: string }[]) => Promise<void>) {
    const originalFetch = globalThis.fetch
    const calls: { url: string; mime: string }[] = []
    process.env.GEMINI_API_KEY = ''
    process.env.GOOGLE_API_KEY = ''
    process.env.OPENAI_API_KEY = 'test-whisper-key'
    process.env.GROQ_API_KEY = ''
    globalThis.fetch = (async (url: any, init: any) => {
      const file = init.body.get('file') as File
      calls.push({ url: String(url), mime: file.type })
      return new Response(JSON.stringify(reply.body), { status: reply.ok ? 200 : 503, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      await check(calls)
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, value] of Object.entries({ GEMINI_API_KEY: saved.gemini, GOOGLE_API_KEY: saved.google, OPENAI_API_KEY: saved.openai, GROQ_API_KEY: saved.groq })) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }

  test('Whisper transcribes non-OGG audio when Gemini is unavailable', async () => {
    await withWhisperMock({ ok: true, body: { text: 'تفريغ صوتي صحيح' } }, async (calls) => {
      const { transcribeAudioBase64 } = await import('../src/lib/asr')
      const transcript = await transcribeAudioBase64(Buffer.from('sample audio').toString('base64'), { mimeType: 'audio/webm' })
      expect(transcript).toBe('تفريغ صوتي صحيح')
      expect(calls).toHaveLength(1)
      expect(calls[0].url).toContain('/audio/transcriptions')
      expect(calls[0].mime).toBe('audio/webm')
    })
  })

  test('all ASR providers failing produces explicit error instead of empty transcript', async () => {
    await withWhisperMock({ ok: false, body: { error: { message: 'provider unavailable' } } }, async (calls) => {
      const { transcribeAudioBase64 } = await import('../src/lib/asr')
      await expect(transcribeAudioBase64(Buffer.from('sample audio').toString('base64'), { mimeType: 'audio/ogg' }))
        .rejects.toThrow('ASR_PROVIDERS_UNAVAILABLE')
      expect(calls).toHaveLength(1)
    })
  })
})

describe('WhatsApp incoming attachments', () => {
  function payload(type: string, media: Record<string, unknown>) {
    return {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: '123456789' },
        contacts: [{ wa_id: '970599123456', profile: { name: 'Test contact' } }],
        messages: [{ id: 'wamid.test', from: '970599123456', type, [type]: media }],
      } }] }],
    }
  }

  test.each(['image', 'video', 'audio', 'document', 'sticker'])(
    'extracts %s media identifier and MIME type',
    (type) => {
      const messages = extractWhatsAppInboundMessages(payload(type, {
        id: '1234567891011', mime_type: type === 'document' ? 'application/pdf' : 'image/jpeg',
        sha256: 'checksum', caption: 'وصف الصورة', filename: 'document.pdf', voice: true,
      }))
      expect(messages).toHaveLength(1)
      expect(messages[0].rawType).toBe(type)
      expect(messages[0].mediaId).toBe('1234567891011')
      expect(messages[0].mediaSha256).toBe('checksum')
      expect(messages[0].mediaCaption).toBe('وصف الصورة')
      expect(messages[0].mediaFilename).toBe('document.pdf')
      expect(messages[0].isVoice).toBe(type === 'audio')
    },
  )

  test('preserves ordinary text message semantics', () => {
    const result = extractWhatsAppInboundMessages(payload('text', { body: 'مرحبا' }))
    expect(result[0].text).toBe('مرحبا')
    expect(result[0].mediaId).toBeUndefined()
  })

  test('does not invent an attachment ID for a Meta unsupported message', () => {
    const result = extractWhatsAppInboundMessages(payload('unsupported', { id: 'not-a-media-id' }))
    expect(result[0].rawType).toBe('unsupported')
    expect(result[0].mediaId).toBeUndefined()
  })
})
