// Auto AI capability probes (step 4) — tiny, cheap, purpose-shaped checks.
//
// Probes run ONLY from the background refresh (ai-auto-refresh.ts), never
// on the live request path. Each probe is ONE small call with a hard
// timeout, capped at ~3 models per provider per run, and only for
// providers the admin opted in (probeProviders). A probe never invents a
// capability: a pass records the flag as probe-verified, a fail records
// the flag as probe-observed-false, and a probe that errors records
// nothing at all.
//
// The OCR probe plants a literal string: the refresh caller renders it
// onto a 1-page image (or, for a text-only smoke check, sends it as text)
// and asks the model to return it. The evaluator below only checks the
// returned text for the planted literal — it never sees the image itself,
// so it is unit-testable with a stubbed call function.
import type { ModelCapability } from './text-ai'

export type ProbeKind = 'ocr' | 'json' | 'long-context'

export interface ProbeCallInput {
  kind: ProbeKind
  prompt: string
  planted?: string
  inputChars?: number
}

export interface ProbeCallResult {
  text: string
  ok: boolean
  error?: string
}

export type ProbeCallFn = (input: ProbeCallInput & { provider: string; model: string }) => Promise<ProbeCallResult>

export interface ProbeResult {
  kind: ProbeKind
  provider: string
  model: string
  pass: boolean
  detail: string
}

export const PROBE_MAX_MODELS_PER_PROVIDER_PER_RUN = 3
export const PROBE_LONG_CONTEXT_CHARS = 100_000

// Deterministic planted literal (seeded in tests). Production callers pass
// their own seed so the literal is not predictable across runs.
export function probePlantedLiteral(seed = '7Q3Z'): string {
  return `AUTO-PROBE-OCR-${String(seed).replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || '7Q3Z'}`
}

export function buildOcrProbe(seed = '7Q3Z'): ProbeCallInput {
  const planted = probePlantedLiteral(seed)
  return {
    kind: 'ocr',
    // The planted literal is deliberately NOT in the prompt: the refresh
    // caller renders it onto the 1-page probe image (input.planted) and
    // the model must read it from the image. A prompt containing the
    // literal would let the model copy it without reading anything.
    planted,
    prompt: 'Read the page image and repeat exactly the code printed on it, with no other words.',
  }
}

export function buildJsonProbe(): ProbeCallInput {
  return {
    kind: 'json',
    prompt: 'Reply with exactly this JSON object and nothing else: {"probe": true, "value": 42}',
  }
}

export function buildLongContextProbe(chars: number = PROBE_LONG_CONTEXT_CHARS): ProbeCallInput {
  const size = Math.max(1_000, Math.floor(chars) || PROBE_LONG_CONTEXT_CHARS)
  return {
    kind: 'long-context',
    inputChars: size,
    prompt: `The following input is ${size} characters long. Reply with the single word ACCEPTED and nothing else.\n${'x'.repeat(size)}`,
  }
}

export function evaluateProbeResponse(kind: ProbeKind, result: ProbeCallResult, input: ProbeCallInput): { pass: boolean; detail: string } {
  if (!result.ok) return { pass: false, detail: `probe call failed: ${String(result.error || 'unknown error').slice(0, 120)}` }
  const text = String(result.text || '')
  if (kind === 'ocr') {
    const planted = String(input.planted || '')
    if (!planted) return { pass: false, detail: 'ocr probe has no planted literal' }
    return text.includes(planted)
      ? { pass: true, detail: 'planted literal returned verbatim' }
      : { pass: false, detail: 'planted literal missing from response' }
  }
  if (kind === 'json') {
    try {
      const parsed = JSON.parse(text.trim())
      if (parsed && typeof parsed === 'object' && parsed.probe === true && Number(parsed.value) === 42) {
        return { pass: true, detail: 'valid JSON shape with expected keys' }
      }
      return { pass: false, detail: 'JSON parsed but shape differs from the requested object' }
    } catch {
      return { pass: false, detail: 'response is not valid JSON' }
    }
  }
  // long-context: the model accepted the input when it answers ACCEPTED;
  // a truncation / context-length error in the text (or an empty reply)
  // means the input did not fit.
  if (!text.trim()) return { pass: false, detail: 'empty response to long-context input' }
  if (/context (length|window)|too long|truncat|maximum context|input too large/i.test(text)) {
    return { pass: false, detail: 'model reports the input exceeds its context' }
  }
  return /ACCEPTED/.test(text)
    ? { pass: true, detail: `accepted a ${input.inputChars || 0}-char input` }
    : { pass: false, detail: 'model did not confirm acceptance of the long input' }
}

// Capability flags a probe outcome may set. A pass sets the flag true
// (probe-verified); a fail sets it false (probe-observed). A probe that
// errors (ok: false) sets nothing — an error is not evidence about the
// model. Long-context has no ModelCapability flag of its own: its outcome
// is recorded in the probe result only, and the scorer (step 5) reads the
// catalog contextLength, never an invented number.
export function probeCapabilityUpdate(kind: ProbeKind, pass: boolean): Partial<ModelCapability> {
  if (kind === 'ocr') return { ocr: pass }
  if (kind === 'json') return { extraction: pass }
  return {}
}

export interface RunCapabilityProbesInput {
  provider: string
  models: string[]
  kinds?: ProbeKind[]
  callModel: ProbeCallFn
  maxModelsPerRun?: number
  timeoutMs?: number
}

export interface RunCapabilityProbesResult {
  results: ProbeResult[]
  capabilityUpdates: Record<string, Partial<ModelCapability>>
  probedModels: string[]
  skipped: string[]
}

// Run the probes for at most `maxModelsPerRun` models (default 3). Models
// beyond the cap are reported in `skipped`, never probed — the cap is the
// quota guard. Every probe call is awaited with a hard timeout via
// Promise.race so a hung model cannot stall the refresh.
export async function runCapabilityProbes(input: RunCapabilityProbesInput): Promise<RunCapabilityProbesResult> {
  const provider = String(input.provider || '').toUpperCase()
  const kinds = input.kinds?.length ? input.kinds : (['ocr', 'json'] as ProbeKind[])
  const maxModels = Math.max(0, Math.min(10, Math.floor(input.maxModelsPerRun ?? PROBE_MAX_MODELS_PER_PROVIDER_PER_RUN)))
  const timeoutMs = Math.max(1_000, Math.floor(input.timeoutMs ?? 15_000))
  const probedModels = input.models.slice(0, maxModels)
  const skipped = input.models.slice(maxModels)
  const results: ProbeResult[] = []
  const capabilityUpdates: Record<string, Partial<ModelCapability>> = {}
  const withTimeout = async (probe: ProbeCallInput): Promise<ProbeCallResult> => {
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
      const timeout = new Promise<ProbeCallResult>((resolve) => {
        timer = setTimeout(() => resolve({ text: '', ok: false, error: 'PROBE_TIMEOUT' }), timeoutMs)
      })
      return await Promise.race([input.callModel(probe), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  for (const model of probedModels) {
    for (const kind of kinds) {
      const probe = kind === 'ocr' ? buildOcrProbe() : kind === 'json' ? buildJsonProbe() : buildLongContextProbe()
      let outcome: ProbeCallResult
      try {
        outcome = await withTimeout({ ...probe, provider, model })
      } catch (e: any) {
        outcome = { text: '', ok: false, error: String(e?.message || 'PROBE_ERROR').slice(0, 120) }
      }
      const evaluated = evaluateProbeResponse(kind, outcome, probe)
      results.push({ kind, provider, model, pass: evaluated.pass, detail: evaluated.detail })
      if (outcome.ok) {
        capabilityUpdates[model] = { ...(capabilityUpdates[model] || {}), ...probeCapabilityUpdate(kind, evaluated.pass) }
      }
    }
  }
  return { results, capabilityUpdates, probedModels, skipped }
}
