/// <reference types="bun-types" />
import { afterEach, describe, expect, mock, test } from 'bun:test'

// «كل النماذج تحدث تلقائيا» (2026-10-30): GEMINI / OPENAI / ANTHROPIC were the
// last providers fed only by coded static lists. These tests pin their live
// catalog discovery: correct endpoint shapes, prefix stripping, and the
// non-chat exclusions.

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
mock.module('@/lib/settings', () => ({ getSetting: async () => '' }))

const textAi = await import('../../src/lib/text-ai')
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  textAi.__resetTextAiStateForTests()
})

describe('native provider model discovery', () => {
  test('gemini: strips the models/ prefix and keeps only generateContent chat models', async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlText = String(url)
      expect(urlText).toContain('generativelanguage.googleapis.com/v1beta/models')
      expect(urlText).toContain('key=test-gemini-key')
      return new Response(JSON.stringify({ models: [
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-3.1-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as any

    const models = await textAi.__testDiscoverGeminiTextModelsForTests('test-gemini-key')
    expect(models).toEqual(['gemini-3.8-flash', 'gemini-3.1-pro'])
  })

  test('anthropic: reads the data array with the native auth headers', async () => {
    let seenHeaders: Record<string, string> = {}
    globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('api.anthropic.com/v1/models')
      seenHeaders = (init?.headers || {}) as Record<string, string>
      return new Response(JSON.stringify({ data: [
        { id: 'claude-sonnet-5', type: 'model' },
        { id: 'claude-opus-4-6', type: 'model' },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as any

    const models = await textAi.__testDiscoverAnthropicTextModelsForTests('test-anthropic-key')
    expect(models).toEqual(['claude-sonnet-5', 'claude-opus-4-6'])
    expect(seenHeaders['x-api-key']).toBe('test-anthropic-key')
    expect(seenHeaders['anthropic-version']).toBe('2023-06-01')
  })

  test('openai: keeps first-party chat families, drops fine-tunes and non-chat artifacts', async () => {
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://api.openai.com/v1/models')
      return new Response(JSON.stringify({ data: [
        { id: 'gpt-5.6' },
        { id: 'gpt-5.6-mini' },
        { id: 'o4-mini' },
        { id: 'ft:gpt-5.6:org:custom:abc123' },
        { id: 'gpt-5.6-audio' },
        { id: 'gpt-image-1' },
        { id: 'text-embedding-3-large' },
        { id: 'whisper-1' },
        { id: 'davinci-002' },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as any

    const models = await textAi.__testDiscoverOpenAiTextModelsForTests('https://api.openai.com/v1', 'test-openai-key')
    expect(models).toEqual(['gpt-5.6', 'gpt-5.6-mini', 'o4-mini'])
  })

  test('discovery failure returns nothing so the static list stays in charge', async () => {
    globalThis.fetch = mock(async () => {
      return new Response('nope', { status: 500 })
    }) as any
    expect(await textAi.__testDiscoverGeminiTextModelsForTests('k')).toEqual([])
    expect(await textAi.__testDiscoverAnthropicTextModelsForTests('k')).toEqual([])
    expect(await textAi.__testDiscoverOpenAiTextModelsForTests('https://api.openai.com/v1', 'k')).toEqual([])
    expect(await textAi.__testDiscoverGeminiTextModelsForTests('')).toEqual([])
  })
})
