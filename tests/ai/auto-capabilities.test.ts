/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test'

// Step 4 — capability classification: provider metadata first, real
// probes second, run-result feedback third. Name-based inference is only
// a last resort and is labelled inferred:true.
mock.module('@/lib/db', () => ({
  db: {
    setting: { findUnique: async () => null, findMany: async () => [] },
    $transaction: async (work: (tx: any) => Promise<any>) => work({}),
  },
}))

const { __testCapabilityFromModelRowForTests, modelAllowedForPurpose } = await import('../../src/lib/text-ai')
const autoMode = await import('../../src/lib/ai-auto-mode')
const probes = await import('../../src/lib/ai-capability-probes')

const COARENA_ROW = {
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

describe('capabilityFromModelRow — provider metadata mapping', () => {
  test('Coarena-style capabilities.vision row still maps vision:true (PR #214 behaviour kept)', () => {
    const cap = __testCapabilityFromModelRowForTests(COARENA_ROW)
    expect(cap.vision).toBe(true)
    expect(cap.modalities).toContain('image')
    // New flags from the same row: tools + json_schema support.
    expect(cap.tools).toBe(true)
    expect(cap.extraction).toBe(true)
    expect(cap.inferred).toBeUndefined()
  })

  test('explicit capability flags map: pdf, ocr, academic, audit, voice, maxOutputTokens', () => {
    const cap = __testCapabilityFromModelRowForTests({
      id: 'doc-model-1',
      context_length: 200000,
      capabilities: { pdf: true, ocr: true, academic: true, audit: true, voice: true, max_output_tokens: 8192 },
      supported_parameters: ['tools', 'temperature'],
    })
    expect(cap.pdf).toBe(true)
    expect(cap.ocr).toBe(true)
    expect(cap.academic).toBe(true)
    expect(cap.audit).toBe(true)
    expect(cap.voice).toBe(true)
    expect(cap.maxOutputTokens).toBe(8192)
    expect(cap.contextLength).toBe(200000)
    expect(cap.tools).toBe(true)
  })

  test('supported_parameters json_schema implies extraction; tools implies tools', () => {
    const cap = __testCapabilityFromModelRowForTests({
      id: 'json-model-1',
      modalities: ['text'],
      supported_parameters: ['response_format', 'tool_choice'],
    })
    expect(cap.extraction).toBe(true)
    expect(cap.tools).toBe(true)
    expect(cap.ocr).toBeUndefined()
  })

  test('costTier: zero pricing is free, priced rows are paid, unpriced rows are unknown', () => {
    expect(__testCapabilityFromModelRowForTests({ id: 'm-free', pricing: { prompt: 0, completion: 0 } }).costTier).toBe('free')
    expect(__testCapabilityFromModelRowForTests({ id: 'm-paid', pricing: { prompt: 0.001, completion: 0.002 } }).costTier).toBe('paid')
    // No balance API exists: an unpriced row is 'unknown', never 'free'.
    expect(__testCapabilityFromModelRowForTests({ id: 'm-plain', modalities: ['text'] }).costTier).toBe('unknown')
    expect(__testCapabilityFromModelRowForTests({ id: 'm-suffix:free', modalities: ['text'] }).costTier).toBe('free')
  })

  test('a model named *-vision-* with text-only metadata is NOT classified vision', () => {
    const cap = __testCapabilityFromModelRowForTests({
      id: 'acme-vision-9',
      modalities: ['text'],
      capabilities: { vision: false, image_url: false, image_base64: false },
    })
    expect(cap.vision).toBe(false)
    expect(cap.inferred).toBeUndefined()
    expect(modelAllowedForPurpose('acme-vision-9', 'VISION', cap)).toBe(false)
  })

  test('a model named *-vision-* with NO metadata at all falls back to the name, labelled inferred', () => {
    const cap = __testCapabilityFromModelRowForTests({ id: 'acme-vision-9' })
    expect(cap.vision).toBe(true)
    expect(cap.inferred).toBe(true)
  })

  test('a plain model with no metadata is not vision and not inferred', () => {
    const cap = __testCapabilityFromModelRowForTests({ id: 'plain-text-model' })
    expect(cap.vision).toBeUndefined()
    expect(cap.inferred).toBeUndefined()
  })
})

describe('capability probes — evaluators', () => {
  test('OCR probe passes only when the planted literal is returned verbatim', () => {
    const input = probes.buildOcrProbe('7Q3Z')
    // The planted literal must NOT be in the prompt itself — the model
    // has to read it from the page image.
    expect(input.prompt).not.toContain(input.planted!)
    expect(probes.evaluateProbeResponse('ocr', { text: `code: ${input.planted}`, ok: true }, input).pass).toBe(true)
    expect(probes.evaluateProbeResponse('ocr', { text: 'code: SOMETHING-ELSE', ok: true }, input).pass).toBe(false)
    expect(probes.evaluateProbeResponse('ocr', { text: '', ok: false, error: 'boom' }, input).pass).toBe(false)
  })

  test('JSON probe passes only for the exact requested shape', () => {
    const input = probes.buildJsonProbe()
    expect(probes.evaluateProbeResponse('json', { text: '{"probe": true, "value": 42}', ok: true }, input).pass).toBe(true)
    expect(probes.evaluateProbeResponse('json', { text: '{"probe": true, "value": 7}', ok: true }, input).pass).toBe(false)
    expect(probes.evaluateProbeResponse('json', { text: 'not json at all', ok: true }, input).pass).toBe(false)
  })

  test('long-context probe detects truncation errors and accepts ACCEPTED', () => {
    const input = probes.buildLongContextProbe(1000)
    expect(input.inputChars).toBe(1000)
    expect(input.prompt.length).toBeGreaterThan(1000)
    expect(probes.evaluateProbeResponse('long-context', { text: 'ACCEPTED', ok: true }, input).pass).toBe(true)
    expect(probes.evaluateProbeResponse('long-context', { text: 'Error: context length exceeded', ok: true }, input).pass).toBe(false)
    expect(probes.evaluateProbeResponse('long-context', { text: '', ok: true }, input).pass).toBe(false)
  })
})

describe('capability probes — capped runner', () => {
  test('runner probes at most 3 models per provider per run and reports the rest as skipped', async () => {
    const called: string[] = []
    const callModel = async (input: { kind: string; prompt: string; planted?: string; provider: string; model: string }) => {
      called.push(input.model)
      if (input.kind === 'ocr') return { text: `code: ${input.planted}`, ok: true }
      return { text: '{"probe": true, "value": 42}', ok: true }
    }
    const result = await probes.runCapabilityProbes({
      provider: 'ZAI',
      models: ['m1', 'm2', 'm3', 'm4', 'm5'],
      kinds: ['ocr', 'json'],
      callModel,
    })
    expect(result.probedModels).toEqual(['m1', 'm2', 'm3'])
    expect(result.skipped).toEqual(['m4', 'm5'])
    expect(result.capabilityUpdates.m1).toEqual({ ocr: true, extraction: true })
    expect(result.results.filter((r) => r.pass).length).toBe(6)
    expect(new Set(called)).toEqual(new Set(['m1', 'm2', 'm3']))
  })

  test('a failing probe call records nothing for that model', async () => {
    const result = await probes.runCapabilityProbes({
      provider: 'ZAI',
      models: ['m1'],
      kinds: ['json'],
      callModel: async () => ({ text: '', ok: false, error: 'PROVIDER_TIMEOUT' }),
    })
    expect(result.results[0].pass).toBe(false)
    expect(result.capabilityUpdates.m1).toBeUndefined()
  })

  test('a probe that returns the wrong JSON shape demotes extraction for that model', async () => {
    const result = await probes.runCapabilityProbes({
      provider: 'ZAI',
      models: ['m1'],
      kinds: ['json'],
      callModel: async () => ({ text: 'hello, not json', ok: true }),
    })
    expect(result.results[0].pass).toBe(false)
    expect(result.capabilityUpdates.m1).toEqual({ extraction: false })
  })
})

describe('run-result feedback demotes capability flags after N failures', () => {
  const event = (outcome: 'VALIDATION_REJECTED' | 'JSON_FAILED' | 'OCR_GATE_FAILED' | 'SUCCESS'): autoMode.RunResultEvent => ({
    provider: 'ZAI',
    model: 'glm-4.5',
    purpose: 'GENERATION',
    outcome,
  })

  test('one or two JSON failures do not demote; the third does', () => {
    let state = autoMode.emptyCapabilityFeedbackState()
    let out = autoMode.applyRunResultFeedback(state, [event('JSON_FAILED')])
    expect(out.demotions).toEqual([])
    out = autoMode.applyRunResultFeedback(out.state, [event('JSON_FAILED')])
    expect(out.demotions).toEqual([])
    out = autoMode.applyRunResultFeedback(out.state, [event('JSON_FAILED')])
    expect(out.demotions.map((d) => d.flag).sort()).toEqual(['audit', 'extraction'])
    expect(autoMode.demotedCapabilityFlags(out.state, 'ZAI', 'glm-4.5', 'GENERATION')).toEqual(
      expect.arrayContaining(['extraction', 'audit']),
    )
  })

  test('OCR-gate failures demote ocr for VISION only, not for other purposes', () => {
    const ocrEvent: autoMode.RunResultEvent = { provider: 'ZAI', model: 'glm-4.5', purpose: 'VISION', outcome: 'OCR_GATE_FAILED' }
    const { state, demotions } = autoMode.applyRunResultFeedback(
      autoMode.emptyCapabilityFeedbackState(),
      [ocrEvent, ocrEvent, ocrEvent],
    )
    expect(demotions.map((d) => d.flag)).toEqual(['ocr'])
    expect(autoMode.demotedCapabilityFlags(state, 'ZAI', 'glm-4.5', 'VISION')).toEqual(['ocr'])
    expect(autoMode.demotedCapabilityFlags(state, 'ZAI', 'glm-4.5', 'GENERATION')).toEqual([])
  })

  test('a success resets the failure counters for that purpose', () => {
    let state = autoMode.emptyCapabilityFeedbackState()
    let out = autoMode.applyRunResultFeedback(state, [event('JSON_FAILED'), event('JSON_FAILED')])
    out = autoMode.applyRunResultFeedback(out.state, [event('SUCCESS')])
    out = autoMode.applyRunResultFeedback(out.state, [event('JSON_FAILED')])
    expect(out.demotions).toEqual([])
  })

  test('demoted flags merge into a catalog capability as false, other flags untouched', () => {
    const cap = { vision: true, ocr: true, extraction: true, audit: true, modalities: ['text', 'image'] }
    const merged = autoMode.applyDemotedFlagsToCapability(cap, ['extraction', 'audit'])
    expect(merged?.extraction).toBe(false)
    expect(merged?.audit).toBe(false)
    expect(merged?.ocr).toBe(true)
    expect(merged?.vision).toBe(true)
  })

  test('malformed stored feedback state parses to empty instead of throwing', () => {
    expect(autoMode.parseCapabilityFeedbackState('not-json')).toEqual(autoMode.emptyCapabilityFeedbackState())
    expect(autoMode.parseCapabilityFeedbackState(null)).toEqual(autoMode.emptyCapabilityFeedbackState())
  })
})
