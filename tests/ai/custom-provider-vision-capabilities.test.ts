/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test'

// text-ai يقرأ الإعدادات من قاعدة البيانات عند بناء الطلبات؛ الاختبار هنا
// يفحص دوال القدرات والرؤية النقية فقط، فتُستبدل القاعدة ببديل فارغ.
mock.module('@/lib/db', () => ({
  db: {
    setting: { findUnique: async () => null, findMany: async () => [] },
    $transaction: async (work: (tx: any) => Promise<any>) => work({}),
  },
}))

const { __testCapabilityFromModelRowForTests, __testVisionSupportForTests, modelAllowedForPurpose } = await import('../../src/lib/text-ai')

// Coarena /models shape (snapshot 2026-11-24): vision lives ONLY inside
// `capabilities` — no modalities/architecture field on any of the 28 rows.
// Production failure 2026-11-24 15:27: a book OCR step failed with 11 pages
// UNREADABLE because every Coarena model was skipped by the vision filter.
const COARENA_DEEPSEEK_ROW = {
  id: 'deepseek-v4-1-flash-1017',
  capabilities: {
    vision: true,
    tools: true,
    json_schema: true,
    reasoning_text: true,
    efforts: ['none', 'high', 'max'],
    image_url: false,
    image_base64: true,
    max_images: 8,
    max_image_bytes: 5242880,
  },
}

const COARENA_GEMINI_ROW = {
  id: 'gemini-3-8-flash',
  capabilities: { vision: true, image_url: false, image_base64: true, max_images: 3000 },
}

describe('custom-provider vision capabilities from catalog rows', () => {
  test('Coarena-style row declares vision via capabilities only', () => {
    const cap = __testCapabilityFromModelRowForTests(COARENA_DEEPSEEK_ROW)
    expect(cap.vision).toBe(true)
    expect(cap.modalities).toContain('image')
  })

  test('capabilities all false declares no vision', () => {
    const cap = __testCapabilityFromModelRowForTests({
      id: 'some-text-model',
      capabilities: { vision: false, image_url: false, image_base64: false },
    })
    expect(cap.vision).toBe(false)
    expect(cap.modalities?.some((m: string) => /image|vision/.test(m))).toBe(false)
  })

  test('existing modalities sources still merge with capabilities vision', () => {
    const cap = __testCapabilityFromModelRowForTests({
      id: 'custom-text-1',
      modalities: ['text'],
      capabilities: { vision: true },
    })
    expect(cap.vision).toBe(true)
    expect(cap.modalities).toContain('text')
    expect(cap.modalities).toContain('image')
  })

  test('capabilities as an array of strings merge as modalities', () => {
    const cap = __testCapabilityFromModelRowForTests({
      id: 'custom-array-model',
      capabilities: ['text', 'image'],
    })
    expect(cap.vision).toBe(true)
    expect(cap.modalities).toContain('text')
    expect(cap.modalities).toContain('image')
  })

  test('image_url alone declares vision', () => {
    const cap = __testCapabilityFromModelRowForTests({
      id: 'custom-url-model',
      capabilities: { image_url: true },
    })
    expect(cap.vision).toBe(true)
    expect(cap.modalities).toContain('image_url')
  })

  test('custom-provider model with capabilities-only vision passes the image filter', () => {
    const cap = __testCapabilityFromModelRowForTests(COARENA_DEEPSEEK_ROW)
    expect(__testVisionSupportForTests({
      provider: 'CUSTOM_421999B38709',
      model: 'deepseek-v4-1-flash-1017',
      vision: cap.vision,
      modalities: cap.modalities,
    })).toBe(true)
    const geminiCap = __testCapabilityFromModelRowForTests(COARENA_GEMINI_ROW)
    expect(__testVisionSupportForTests({
      provider: 'CUSTOM_421999B38709',
      model: 'gemini-3-8-flash',
      vision: geminiCap.vision,
      modalities: geminiCap.modalities,
    })).toBe(true)
  })

  test('custom-provider model with capabilities all false fails the image filter', () => {
    const cap = __testCapabilityFromModelRowForTests({
      id: 'some-text-model',
      capabilities: { vision: false, image_url: false, image_base64: false },
    })
    expect(__testVisionSupportForTests({
      provider: 'CUSTOM_421999B38709',
      model: 'some-text-model',
      vision: cap.vision,
      modalities: cap.modalities,
    })).toBe(false)
  })

  test('PDF attachments still follow the stricter document rule for customs', () => {
    const cap = __testCapabilityFromModelRowForTests(COARENA_DEEPSEEK_ROW)
    expect(__testVisionSupportForTests({
      provider: 'CUSTOM_421999B38709',
      model: 'deepseek-v4-1-flash-1017',
      vision: cap.vision,
      modalities: cap.modalities,
      pdf: true,
    })).toBe(false)
  })

  test('modelAllowedForPurpose stays consistent with the mapped capability', () => {
    const visionCap = __testCapabilityFromModelRowForTests(COARENA_DEEPSEEK_ROW)
    expect(modelAllowedForPurpose('deepseek-v4-1-flash-1017', 'VISION', visionCap)).toBe(true)
    expect(modelAllowedForPurpose('some-text-model', 'VISION', {
      vision: false,
      modalities: ['text'],
    })).toBe(false)
  })

  test('built-in GEMINI vision behavior is unchanged', () => {
    expect(__testVisionSupportForTests({ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' })).toBe(true)
    expect(__testVisionSupportForTests({ provider: 'GEMINI', model: 'gemini-3.5-flash-lite', pdf: true })).toBe(true)
  })
})
