/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test'

// text-ai يقرأ الإعدادات من قاعدة البيانات عند بناء الطلبات؛ الاختبار هنا
// يفحص دوال اختيار الرؤية النقية فقط، فتُستبدل القاعدة ببديل فارغ.
mock.module('@/lib/db', () => ({
  db: {
    setting: { findUnique: async () => null, findMany: async () => [] },
    $transaction: async (work: (tx: any) => Promise<any>) => work({}),
  },
}))

const { __testVisionOrderForTests, __testVisionSupportForTests, modelAllowedForPurpose } = await import('../../src/lib/text-ai')

describe('APINEX in the vision queue (Haris ruling 2026-10-30)', () => {
  test('vision order pins GEMINI first and APINEX second, rest keep relative order', () => {
    expect(__testVisionOrderForTests(['ALBORIHI', 'OPENAI', 'APINEX', 'GEMINI', 'OPENROUTER']))
      .toEqual(['GEMINI', 'APINEX', 'ALBORIHI', 'OPENAI', 'OPENROUTER'])
  })

  test('vision order without APINEX only pins GEMINI', () => {
    expect(__testVisionOrderForTests(['OPENAI', 'GEMINI', 'ALBORIHI'])).toEqual(['GEMINI', 'OPENAI', 'ALBORIHI'])
  })

  test('vision order without GEMINI puts APINEX first', () => {
    expect(__testVisionOrderForTests(['OPENAI', 'APINEX'])).toEqual(['APINEX', 'OPENAI'])
    expect(__testVisionOrderForTests([])).toEqual([])
  })

  test('APINEX serves images through its Gemini model', () => {
    expect(__testVisionSupportForTests({ provider: 'APINEX', model: 'free/gemini-3.8-flash' })).toBe(true)
  })

  test('APINEX text-only models never receive images', () => {
    expect(__testVisionSupportForTests({ provider: 'APINEX', model: 'free/deepseek-v4-pro-0813' })).toBe(false)
    expect(__testVisionSupportForTests({ provider: 'APINEX', model: 'free/glm-5.3' })).toBe(false)
    expect(__testVisionSupportForTests({ provider: 'APINEX', model: 'free/minimax-m3.1-flash' })).toBe(false)
  })

  test('APINEX model with discovered vision capability serves images', () => {
    expect(__testVisionSupportForTests({ provider: 'APINEX', model: 'free/kimi-k3', vision: true })).toBe(true)
    expect(__testVisionSupportForTests({ provider: 'APINEX', model: 'free/kimi-k3' })).toBe(false)
    expect(__testVisionSupportForTests({ provider: 'APINEX', model: 'free/kimi-k3', modalities: ['text', 'image'] })).toBe(true)
  })

  test('PDF attachments follow the stricter document rule on APINEX too', () => {
    expect(__testVisionSupportForTests({ provider: 'APINEX', model: 'free/gemini-3.8-flash', pdf: true })).toBe(true)
    expect(__testVisionSupportForTests({ provider: 'APINEX', model: 'free/deepseek-v4-pro-0813', pdf: true })).toBe(false)
  })

  test('provider gate stays closed for non-vision providers', () => {
    expect(__testVisionSupportForTests({ provider: 'GROQ', model: 'llama-3.3-70b-versatile' })).toBe(false)
    expect(__testVisionSupportForTests({ provider: 'TOPTOOLS', model: 'gpt-5.6-sol' })).toBe(false)
  })

  test('GEMINI vision behavior is unchanged', () => {
    expect(__testVisionSupportForTests({ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' })).toBe(true)
    expect(__testVisionSupportForTests({ provider: 'GEMINI', model: 'gemini-3.5-flash-lite', pdf: true })).toBe(true)
  })

  test('Gemini discovery without modality metadata does not skip document OCR', () => {
    expect(modelAllowedForPurpose('gemini-3.5-flash-lite', 'VISION')).toBe(true)
    expect(modelAllowedForPurpose('gemini-3.5-flash-lite', 'VISION', { vision: false, modalities: [] })).toBe(true)
    expect(modelAllowedForPurpose('gemini-3.5-flash-lite', 'VISION', { vision: false })).toBe(true)
  })

  test('explicit text-only models remain excluded from document OCR', () => {
    expect(modelAllowedForPurpose('text-only-model', 'VISION', { vision: false, modalities: ['text'] })).toBe(false)
    expect(modelAllowedForPurpose('gemini-3.5-flash-lite', 'VISION', { vision: true, modalities: ['text', 'image'] })).toBe(true)
  })
})
