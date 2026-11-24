/// <reference types="bun-types" />
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { looksLikeBrokenBookPageText } from '../../src/lib/academic-output-quality'

// Part 2: the NATIVE Gemini loop (gemini.ts) used to swallow a garbled-OCR
// validate rejection: the plain OCR_TEXT_FAILED_VERIFICATION error matched
// none of its break conditions, so the whole call failed WITHOUT trying the
// next model. The fix adds the code to the break regex. This drives the real
// native loop with a stubbed Google SDK and the router disabled.
const generateCalls: string[] = (() => {
  const g = globalThis as any
  if (!Array.isArray(g.__geminiTestCalls)) g.__geminiTestCalls = []
  return g.__geminiTestCalls as string[]
})()
function setReplies(next: Record<string, string>) { (globalThis as any).__geminiTestReplies = next }

mock.module('@/lib/db', () => ({ db: { setting: { findUnique: async () => null } } }))
mock.module('@/lib/text-ai', () => ({
  hasExternalTextAi: async () => false,
  textAiCompleteJson: async () => { throw new Error('router disabled in this test') },
  textAiStreamText: async () => { throw new Error('router disabled in this test') },
}))
// mock.module factories are re-parsed without TypeScript syntax: keep the
// factory body plain JS (no type annotations, no `as` casts) and route the
// shared call log and per-model replies through globalThis, initialized
// lazily (module-scope evaluation order is not reliable under mock hoisting).
mock.module('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: (input) => {
      if (!globalThis.__geminiTestCalls) globalThis.__geminiTestCalls = []
      globalThis.__geminiTestCalls.push(String(input.model))
      return Promise.resolve({ text: (globalThis.__geminiTestReplies || {})[String(input.model)] || '' })
    } }
    constructor(opts) {}
  },
}))

const gemini = await import('../../src/lib/gemini')

const cleanPage = 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية. '.repeat(50)
const garbledPage = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)
const cleanOcrJson = JSON.stringify({ pages: [{ page: 1, text: cleanPage }] })
const garbledOcrJson = JSON.stringify({ pages: [{ page: 1, text: garbledPage }] })

function ocrValidate(raw: string) {
  const parsed = JSON.parse(String(raw).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim())
  const text = String(parsed?.pages?.[0]?.text || '')
  if (text.trim() && looksLikeBrokenBookPageText(text)) throw new Error('OCR_TEXT_FAILED_VERIFICATION')
}

const restrictToModels = [
  { provider: 'GEMINI', model: 'gemini-3.8-flash' },
  { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' },
] as const

afterEach(() => {
  generateCalls.length = 0
  setReplies({})
  delete process.env.GEMINI_API_KEYS
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_TEXT_MODEL
})

describe('native Gemini loop failover on garbled OCR validate rejection', () => {
  test('a garbled first model is skipped and the next model answers cleanly', async () => {
    process.env.GEMINI_API_KEYS = 'AIza-test-key-00000000000000000000000000000000'
    setReplies({ 'gemini-3.8-flash': garbledOcrJson, 'gemini-3.5-flash-lite': cleanOcrJson })
    const result = await gemini.geminiCompleteJson({
      system: 'أنت محرك OCR حرفي.',
      history: [{ role: 'user', text: 'اقرأ الصفحة.' }],
      validate: ocrValidate,
      restrictToModels: [...restrictToModels],
    })
    expect(result).toBe(cleanOcrJson)
    // The chain order depends on the last successful model (activeTextModel
    // sticks); what matters is that BOTH models were attempted.
    expect([...generateCalls].sort()).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash'])
  })

  test('when every model answers garbled text the call fails honestly instead of saving garbage', async () => {
    process.env.GEMINI_API_KEYS = 'AIza-test-key-00000000000000000000000000000000'
    setReplies({ 'gemini-3.8-flash': garbledOcrJson, 'gemini-3.5-flash-lite': garbledOcrJson })
    await expect(gemini.geminiCompleteJson({
      system: 'أنت محرك OCR حرفي.',
      history: [{ role: 'user', text: 'اقرأ الصفحة.' }],
      validate: ocrValidate,
      restrictToModels: [...restrictToModels],
    })).rejects.toThrow('OCR_TEXT_FAILED_VERIFICATION')
    expect([...generateCalls].sort()).toEqual(['gemini-3.5-flash-lite', 'gemini-3.8-flash'])
  })
})
