/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 7e — supervisor chat (ai.ts chatComplete) under auto mode.
// OFF: today's order — Gemini first, then the router, then direct ZAI,
// then the local fallback. ON: a SINGLE router call with purpose CHAT
// (taskType CHAT); no Gemini-first, no direct ZAI; the local fallback
// still fires on total failure.

let autoMode = false
let geminiReady = true
let geminiShouldThrow = false
let routerShouldThrow = false
const geminiCalls: Array<{ system: string }> = []
const routerCalls: Array<Record<string, unknown>> = []
const zaiCalls: Array<unknown> = []

const db: any = {
  program: { findMany: async () => [] },
  setting: { findMany: async () => [], findUnique: async () => null, upsert: async () => ({}) },
}
mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/settings', () => ({ getSettings: async () => ({}) }))
mock.module('@/lib/gemini', () => ({
  ensureGeminiKey: async () => geminiReady,
  geminiComplete: async (opts: any) => {
    geminiCalls.push({ system: String(opts?.system || '') })
    if (geminiShouldThrow) throw new Error('GEMINI_DOWN')
    return 'gemini-reply'
  },
  geminiCompleteJson: async () => '{"ok":true}',
  isAuthError: () => false,
  isQuotaError: () => false,
  isModelUnavailableError: () => false,
  isInvalidArgumentError: () => false,
}))
mock.module('@/lib/text-ai', () => ({
  textAiComplete: async (opts: any) => {
    routerCalls.push({ ...opts })
    if (routerShouldThrow) throw new Error('TEXT_AI_ROUTER_FAILED')
    return 'router-reply'
  },
  textAiCompleteJson: async () => '{"ok":true}',
  isTextAiAutoModeEnabled: async () => autoMode,
}))
const zaiInstance: any = {
  chat: {
    completions: {
      create: async (args: any) => {
        zaiCalls.push(args)
        return { choices: [{ message: { content: 'zai-reply' } }] }
      },
    },
  },
}
mock.module('z-ai-web-dev-sdk', () => ({ default: { create: async () => zaiInstance } }))

const { chatComplete } = await import('../../src/lib/ai')

// A question none of the local-answer rules claim (no program/fee/
// certificate/admission/greeting wording), so a model is required.
const QUESTION = [{ role: 'user', content: 'كيف أذاكر بفعالية قبل الامتحان؟' }]

beforeEach(() => {
  autoMode = false
  geminiReady = true
  geminiShouldThrow = false
  routerShouldThrow = false
  geminiCalls.length = 0
  routerCalls.length = 0
  zaiCalls.length = 0
})

describe('chatComplete under auto mode (step 7e)', () => {
  test('OFF keeps today\'s order: Gemini first, router untouched', async () => {
    const reply = await chatComplete(QUESTION as any, undefined, 'CHAT', { requireModelResponse: true })
    expect(reply).toBe('gemini-reply')
    expect(geminiCalls.length).toBe(1)
    expect(routerCalls.length).toBe(0)
    expect(zaiCalls.length).toBe(0)
  })

  test('OFF falls through Gemini -> router -> direct ZAI', async () => {
    geminiShouldThrow = true
    routerShouldThrow = true
    const reply = await chatComplete(QUESTION as any, undefined, 'CHAT', { requireModelResponse: true })
    expect(reply).toBe('zai-reply')
    expect(geminiCalls.length).toBe(1)
    expect(routerCalls.length).toBe(1)
    expect(zaiCalls.length).toBe(1)
  })

  test('ON is a single router call with purpose CHAT: no Gemini-first, no direct ZAI', async () => {
    autoMode = true
    const reply = await chatComplete(QUESTION as any, undefined, 'CHAT', { requireModelResponse: true })
    expect(reply).toBe('router-reply')
    expect(geminiCalls.length).toBe(0)
    expect(routerCalls.length).toBe(1)
    expect(routerCalls[0]?.purpose).toBe('CHAT')
    expect(routerCalls[0]?.taskType).toBe('CHAT')
    expect(zaiCalls.length).toBe(0)
  })

  test('ON total router failure still reaches the local fallback (no ZAI)', async () => {
    autoMode = true
    routerShouldThrow = true
    const reply = await chatComplete(QUESTION as any, undefined, 'CHAT', {})
    expect(geminiCalls.length).toBe(0)
    expect(routerCalls.length).toBe(1)
    expect(zaiCalls.length).toBe(0)
    // Local fallback answers in plain words instead of throwing.
    expect(typeof reply).toBe('string')
    expect(reply.length).toBeGreaterThan(0)
  })

  test('ON total router failure with requireModelResponse throws instead of falling back', async () => {
    autoMode = true
    routerShouldThrow = true
    await expect(chatComplete(QUESTION as any, undefined, 'CHAT', { requireModelResponse: true })).rejects.toThrow('AI_PROVIDER_UNAVAILABLE')
    expect(zaiCalls.length).toBe(0)
  })
})
