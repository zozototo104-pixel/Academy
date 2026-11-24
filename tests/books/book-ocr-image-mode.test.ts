import { describe, expect, mock, test } from 'bun:test'
import { PDFDocument } from 'pdf-lib'

// Part 2: PDF-to-images conversion (PNG screenshots via pdf-parse) must work
// with the eligible providers whether the READING profile is enabled or
// disabled. The image retry is the second chance inside transcribeWithMeta;
// the profile-off path reaches it through the READING rescue in
// transcribeScannedDocumentWithVision, and the no-profile path through a
// direct image-mode transcribeOnce call.
mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/gemini', () => ({ geminiCompleteJson: async () => '{"items":[]}' }))
mock.module('@/lib/ai-stage-profiles', () => ({
  buildStageRoutingOverrides: () => ({
    kind: 'stage',
    preferredModels: [{ provider: 'APINEX', model: 'free/gemini-3.8-flash' }],
    preferredProviders: [],
    policy: 'primary_first',
    allowGlobalFallback: false,
  }),
  resolveEffectiveStageProfile: async () => ({ id: 'reading-test', stage: 'READING' }),
}))

// The stub plays the router: it records every call's attachments and invokes
// the validate callback like the real router, so a garbled answer would fail
// the call instead of being saved.
type OcrCall = { attachments: { mimeType: string; base64: string }[]; preferredModels?: unknown }
const ocrCalls: OcrCall[] = []
let ocrBehavior: (callIndex: number, call: OcrCall) => Promise<{ text: string; provider: string; model: string }> =
  async () => ({ text: '{"pages":[{"page":1,"text":""},{"page":2,"text":""}]}', provider: 'GEMINI', model: 'gemini-3.5-flash-lite' })
mock.module('@/lib/text-ai', () => ({
  textAiCompleteJsonWithMetadata: async (opts: any) => {
    const call: OcrCall = { attachments: opts?.attachments ?? [], preferredModels: opts?.preferredModels }
    ocrCalls.push(call)
    const result = await ocrBehavior(ocrCalls.length, call)
    opts?.validate?.(result.text)
    return result
  },
  // Bound by book-reader at load time (step 6a auto OCR selection);
  // auto OFF here, so the reader keeps its stage-profile/global path.
  isTextAiAutoModeEnabled: async () => false,
  autoRankingForPurpose: async () => [],
  CUSTOM_AI_PROVIDERS_SETTING: 'AI_CUSTOM_PROVIDERS',
  parseCustomTextAiProviders: () => [],
  pipelineConfigSnapshot: () => ({}),
}))

const reader = await import('../../src/lib/book-reader')
const { __testTranscribeOnceForTests, __testTranscribeWithMetaForTests, transcribeScannedDocumentWithVision } = reader

const cleanPage = 'يشرح هذا الفصل مفهوم الأصول المتداولة وكيفية قياسها في القوائم المالية. '.repeat(50)
const cleanOcrJson = JSON.stringify({ pages: [{ page: 1, text: cleanPage }, { page: 2, text: cleanPage }] })

async function makePdf(pages = 2) {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pages; i++) pdf.addPage([595, 842])
  return Buffer.from(await pdf.save())
}

describe('PDF-to-images OCR conversion', () => {
  test('profile off: a direct image-mode call renders the PDF pages to PNG and reads them', async () => {
    ocrCalls.length = 0
    ocrBehavior = async () => ({ text: cleanOcrJson, provider: 'APINEX', model: 'free/gemini-3.8-flash' })
    const buffer = await makePdf(2)
    const result = await __testTranscribeOnceForTests(buffer, [1, 2], Date.now() + 120_000, null, true)
    expect(result.pages).toHaveLength(2)
    expect(result.pages[0].text).toBe(cleanPage.trim())
    expect(result.pages[0].textProvenance).toBe('VISION_OCR')
    expect(ocrCalls).toHaveLength(1)
    expect(ocrCalls[0].attachments).toHaveLength(2)
    for (const attachment of ocrCalls[0].attachments) {
      expect(attachment.mimeType).toBe('image/png')
      expect(attachment.base64.length).toBeGreaterThan(100)
    }
  })

  test('profile on: a failed PDF attempt retries the same pages as PNG through the READING profile', async () => {
    ocrCalls.length = 0
    ocrBehavior = async (callIndex) => {
      if (callIndex === 1) throw new Error('GLOBAL_OCR_FAILED')
      if (callIndex === 2) throw new Error('STAGE_PDF_FAILED')
      return { text: cleanOcrJson, provider: 'APINEX', model: 'free/gemini-3.8-flash' }
    }
    const buffer = await makePdf(2)
    const pages = await transcribeScannedDocumentWithVision(buffer, [1, 2])
    expect(pages).toHaveLength(2)
    expect(pages[0].text).toBe(cleanPage.trim())
    expect(ocrCalls).toHaveLength(3)
    // Call 1: global PDF attempt. Call 2: READING-profile PDF attempt.
    expect(ocrCalls[0].attachments[0].mimeType).toBe('application/pdf')
    expect(ocrCalls[1].attachments[0].mimeType).toBe('application/pdf')
    expect(ocrCalls[1].preferredModels).toEqual([{ provider: 'APINEX', model: 'free/gemini-3.8-flash' }])
    // Call 3: the image retry — the same pages rendered to PNG.
    expect(ocrCalls[2].attachments).toHaveLength(2)
    for (const attachment of ocrCalls[2].attachments) {
      expect(attachment.mimeType).toBe('image/png')
      expect(attachment.base64.length).toBeGreaterThan(100)
    }
  })

  test('empty OCR on every page is rejected so the router can try another model', async () => {
    ocrCalls.length = 0
    ocrBehavior = async () => ({
      text: JSON.stringify({ pages: [{ page: 1, text: '' }, { page: 2, text: '  ' }] }),
      provider: 'CUSTOM_EXTRAA', model: 'free/gemini-3.8-flash',
    })
    const buffer = await makePdf(2)
    await expect(__testTranscribeOnceForTests(buffer, [1, 2], Date.now() + 120_000, null))
      .rejects.toThrow('OCR_ALL_PAGES_EMPTY')
  })

  test('global routing retries original PDF as PNG when the PDF call fails', async () => {
    ocrCalls.length = 0
    ocrBehavior = async (index) => {
      if (index === 1) throw new Error('PDF_NOT_SUPPORTED')
      return { text: cleanOcrJson, provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }
    }
    const buffer = await makePdf(2)
    const meta = await __testTranscribeWithMetaForTests(buffer, [1, 2], Date.now() + 120_000, null)
    expect(meta.pages.map((page) => page.text)).toEqual([cleanPage.trim(), cleanPage.trim()])
    expect(meta.fellBack).toBe(false)
    expect(ocrCalls).toHaveLength(2)
    expect(ocrCalls[0].attachments[0].mimeType).toBe('application/pdf')
    expect(ocrCalls[1].attachments.map((item) => item.mimeType)).toEqual(['image/png', 'image/png'])
    expect(ocrCalls[1].preferredModels).toBeUndefined()
  })

  test('READING stage failure falls back to global PDF then global PNG if allowed', async () => {
    ocrCalls.length = 0
    ocrBehavior = async (index) => {
      if (index < 4) throw new Error('PROVIDER_UNAVAILABLE')
      return { text: cleanOcrJson, provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }
    }
    const stage = {
      preferredModels: [{ provider: 'CUSTOM_EXTRAA', model: 'free/gemini-3.8-flash' }],
      preferredProviders: [],
      policy: 'primary_first',
      allowGlobalFallback: true,
    }
    let fallbackNotices = 0
    const buffer = await makePdf(2)
    const meta = await __testTranscribeWithMetaForTests(
      buffer, [1, 2], Date.now() + 120_000, stage, () => { fallbackNotices++ },
    )
    expect(meta.pages[0].text).toBe(cleanPage.trim())
    expect(meta.fellBack).toBe(true)
    expect(fallbackNotices).toBe(1)
    expect(ocrCalls).toHaveLength(4)
    expect(ocrCalls.map((call) => call.attachments[0].mimeType))
      .toEqual(['application/pdf', 'image/png', 'application/pdf', 'image/png'])
    expect(ocrCalls[0].preferredModels).toEqual(stage.preferredModels)
    expect(ocrCalls[1].preferredModels).toEqual(stage.preferredModels)
    expect(ocrCalls[2].preferredModels).toBeUndefined()
    expect(ocrCalls[3].preferredModels).toBeUndefined()
  })

  test('READING stage with global fallback disabled never invokes global models', async () => {
    ocrCalls.length = 0
    ocrBehavior = async () => { throw new Error('STAGE_VISION_UNAVAILABLE') }
    const stage = {
      preferredModels: [{ provider: 'CUSTOM_EXTRAA', model: 'free/gemini-3.8-flash' }],
      preferredProviders: [],
      policy: 'primary_first',
      allowGlobalFallback: false,
    }
    const buffer = await makePdf(2)
    await expect(__testTranscribeWithMetaForTests(buffer, [1, 2], Date.now() + 120_000, stage))
      .rejects.toThrow('STAGE_VISION_UNAVAILABLE')
    expect(ocrCalls).toHaveLength(2)
    expect(ocrCalls.every((call) => JSON.stringify(call.preferredModels) === JSON.stringify(stage.preferredModels))).toBe(true)
  })

  test('profile off: a clean global PDF attempt needs no image rendering', async () => {
    ocrCalls.length = 0
    ocrBehavior = async () => ({ text: cleanOcrJson, provider: 'GEMINI', model: 'gemini-3.5-flash-lite' })
    const buffer = await makePdf(2)
    const pages = await transcribeScannedDocumentWithVision(buffer, [1, 2])
    expect(pages).toHaveLength(2)
    expect(pages[0].text).toBe(cleanPage.trim())
    expect(ocrCalls).toHaveLength(1)
    expect(ocrCalls[0].attachments[0].mimeType).toBe('application/pdf')
  })
})
