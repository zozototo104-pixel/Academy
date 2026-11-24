// Auto AI background refresh (step 3) — discovery + capability probes.
//
// Quota-safe shape, enforced here and not left to callers:
// - ONE provider per run, round-robin over the built-in providers.
// - One tiny /models fetch per run (the provider's own discovery path).
// - Capability probes capped (max ~3 models/provider/run), opt-in per
//   provider, and never on the live request path.
// - A failed discovery refresh keeps the last good catalog (the transient
//   rule lives in text-ai.ts liveFreeModels); this module only records
//   the outcome in AI_AUTO_LAST_REFRESH.
// - Nothing here writes to manual keys (AI_PROVIDER_FALLBACK_ORDER,
//   {PROVIDER}_TEXT_MODEL, stage profiles) — discovery only reads them
//   for reconciliation warnings.
//
// Pure where it matters: provider picking, state parsing and the refresh
// summary are pure functions of the injected store/discover/probe deps,
// so tests run them with an in-memory store and stubbed fetch.
import { db } from '@/lib/db'
import {
  reconcileReferences,
  type ReferenceWarning,
} from './ai-auto-mode'
import { runCapabilityProbes, type ProbeCallFn, type ProbeKind, type ProbeResult } from './ai-capability-probes'

export const AI_AUTO_LAST_REFRESH_KEY = 'AI_AUTO_LAST_REFRESH'
export const AI_AUTO_REFRESH_LAST_RUN_KEY = 'AI_AUTO_REFRESH_LAST_RUN'
export const AI_AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000
export const AI_AUTO_CAPABILITY_PROBES_KEY_PREFIX = 'AI_AUTO_CAPABILITY_PROBES:'
export const AI_AUTO_PROBE_PROVIDERS_KEY = 'AI_AUTO_PROBE_PROVIDERS'

// Built-in providers with a discovery path, in round-robin order. Custom
// providers refresh through their own admin action
// (refreshCustomTextAiFreeModels) and are not in this rotation.
export const ROUND_ROBIN_PROVIDERS: readonly string[] = [
  'GEMINI', 'ANTHROPIC', 'OPENAI', 'GROQ', 'OPENROUTER', 'DEEPINFRA',
  'TOGETHER', 'UNOROUTER', 'RELAYROUTER', 'TOPTOOLS', 'ALBORIHI',
  'MISTRAL', 'CLOUDFLARE', 'APINEX', 'OXION', 'OPENAI_COMPAT', 'ZAI',
]

export interface AutoRefreshStore {
  read(keys: string[]): Promise<Record<string, string>>
  write(key: string, value: string): Promise<void>
}

export interface DiscoveryResult {
  provider: string
  models: string[]
  discoveryOk: boolean
  sourceCount?: number
  lastError?: string
  retired?: string[]
  renamed?: Record<string, string>
}

export interface LastRefreshState {
  lastProvider?: string
  lastRunAt?: number
  results?: Record<string, { discoveryOk: boolean; models: number; at: number; lastError?: string }>
}

export function parseLastRefreshState(raw: unknown): LastRefreshState {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const record = value as Record<string, unknown>
    const results = record.results && typeof record.results === 'object' && !Array.isArray(record.results)
      ? (record.results as Record<string, { discoveryOk: boolean; models: number; at: number; lastError?: string }>)
      : undefined
    return {
      lastProvider: typeof record.lastProvider === 'string' ? record.lastProvider : undefined,
      lastRunAt: Number.isFinite(Number(record.lastRunAt)) ? Number(record.lastRunAt) : undefined,
      results,
    }
  } catch {
    return {}
  }
}

// Next provider in the rotation: the one after lastProvider, wrapping
// around. Unknown/missing lastProvider starts at the head of the list.
export function pickNextRefreshProvider(providers: readonly string[], state: LastRefreshState): string {
  const list = providers.length ? [...providers] : [...ROUND_ROBIN_PROVIDERS]
  const lastIndex = list.findIndex((p) => p.toUpperCase() === String(state.lastProvider || '').toUpperCase())
  return list[(lastIndex + 1) % list.length]
}

export function probeCapabilityKey(provider: string): string {
  return `${AI_AUTO_CAPABILITY_PROBES_KEY_PREFIX}${String(provider || '').toUpperCase()}`
}

type RawQueryClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>
}

// Same claim pattern as claimAiHealthRun (ai-health.ts): one winner per
// hour, so overlapping Vercel invocations never double-spend quota.
export async function claimAiAutoRefreshRun(client: RawQueryClient = db, nowMs = Date.now()): Promise<boolean> {
  const cutoffMs = nowMs - AI_AUTO_REFRESH_INTERVAL_MS
  const rows = await client.$queryRawUnsafe<Array<{ key: string }>>(
    `INSERT INTO "Setting" ("key", "value", "updatedAt")
     VALUES ('AI_AUTO_REFRESH_LAST_RUN', $1, CURRENT_TIMESTAMP)
     ON CONFLICT ("key") DO UPDATE
       SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
     WHERE CASE
       WHEN "Setting"."value" ~ '^[0-9]+$' THEN "Setting"."value"::bigint
       ELSE 0
     END < $2
     RETURNING "key"`,
    String(nowMs),
    cutoffMs,
  )
  return rows.length > 0
}

export const __testAiAutoRefreshClaimConstants = { AI_AUTO_REFRESH_LAST_RUN_KEY, AI_AUTO_REFRESH_INTERVAL_MS }

export interface RunAutoRefreshInput {
  store: AutoRefreshStore
  // Defaults to text-ai refreshDiscoveryForProvider (real /models fetch).
  discover?: (provider: string) => Promise<DiscoveryResult>
  // Probe call for the refresh run. When omitted, probes are skipped and
  // the run only refreshes discovery. Production passes a router call
  // pinned to one model (see the cron route); tests inject a stub.
  callModel?: ProbeCallFn
  probeProviders?: string[]
  probeKinds?: ProbeKind[]
  providers?: readonly string[]
  // Reconciliation inputs (defaults: empty — warnings only, never writes).
  // Stage refs carry their provider so only refs for the refreshed
  // provider are compared against its catalog.
  hardcodedModels?: (provider: string) => string[]
  adminChosenModel?: (provider: string) => Promise<string | undefined> | string | undefined
  stageProfileModels?: Array<{ provider: string; model: string }>
  nowMs?: number
}

export interface RunAutoRefreshResult {
  provider: string
  discoveryOk: boolean
  models: string[]
  modelCount: number
  sourceCount?: number
  lastError?: string
  retired: string[]
  renamed: Record<string, string>
  warnings: ReferenceWarning[]
  probes: ProbeResult[]
  probedModels: string[]
  skippedProbeModels: string[]
}

async function defaultDiscover(provider: string): Promise<DiscoveryResult> {
  const textAi = await import('./text-ai')
  return textAi.refreshDiscoveryForProvider(provider)
}

export async function runAutoRefresh(input: RunAutoRefreshInput): Promise<RunAutoRefreshResult> {
  const nowMs = input.nowMs ?? Date.now()
  const store = input.store
  const stateRaw = (await store.read([AI_AUTO_LAST_REFRESH_KEY]))[AI_AUTO_LAST_REFRESH_KEY] || ''
  const state = parseLastRefreshState(stateRaw)
  const provider = pickNextRefreshProvider(input.providers || ROUND_ROBIN_PROVIDERS, state)
  const discover = input.discover || defaultDiscover
  const result = await discover(provider)
  const warnings = reconcileReferences({
    provider,
    discovered: result.models,
    hardcoded: input.hardcodedModels?.(provider) || [],
    retired: result.retired || [],
    adminChosen: await input.adminChosenModel?.(provider),
    stageProfileModels: (input.stageProfileModels || [])
      .filter((ref) => String(ref.provider || '').toUpperCase() === provider.toUpperCase())
      .map((ref) => ref.model),
  })
  // Probes are enabled by the cron for every configured provider and
  // capped inside runCapabilityProbes; unit tests may opt into a subset.
  // The probe call is the caller's responsibility (router call pinned to
  // one model); without it, discovery still refreshes and probes report
  // nothing — a missing probe caller must never fail the refresh.
  let probes: ProbeResult[] = []
  let probedModels: string[] = []
  let skippedProbeModels: string[] = []
  const probeOptIn = (input.probeProviders || []).map((p) => p.toUpperCase())
  if (input.callModel && probeOptIn.includes(provider.toUpperCase()) && result.models.length) {
    const cursorKey = `${AI_AUTO_PROBE_CURSOR_KEY_PREFIX}${provider}`
    const oldCursor = Number((await store.read([cursorKey]))[cursorKey]) || 0
    const start = ((oldCursor % result.models.length) + result.models.length) % result.models.length
    const rotated = [...result.models.slice(start), ...result.models.slice(0, start)]
    const probeRun = await runCapabilityProbes({
      provider,
      models: rotated,
      kinds: input.probeKinds || ['ocr', 'json'],
      callModel: input.callModel,
      maxModelsPerRun: input.probeModelsPerRun ?? 2,
      timeoutMs: input.probeTimeoutMs ?? 8_000,
    })
    probes = probeRun.results
    probedModels = probeRun.probedModels
    skippedProbeModels = probeRun.skipped
    await store.write(cursorKey, String((start + probeRun.probedModels.length) % result.models.length))
    if (Object.keys(probeRun.capabilityUpdates).length) {
      const previousRaw = (await store.read([probeCapabilityKey(provider)]))[probeCapabilityKey(provider)] || ''
      let previous: Record<string, unknown> = {}
      try { previous = JSON.parse(previousRaw || '{}') || {} } catch { previous = {} }
      await store.write(probeCapabilityKey(provider), JSON.stringify({
        ...previous,
        ...probeRun.capabilityUpdates,
        probedAt: new Date(nowMs).toISOString(),
        source: 'probe',
      }))
    }
  }
  let rankedPurposes: string[] = []
  if (input.rankAfterRefresh && result.discoveryOk && result.models.length) {
    const catalogCapabilities = await input.capabilitiesForProvider?.(provider) || {}
    const probeRow = parseRecord((await store.read([probeCapabilityKey(provider)]))[probeCapabilityKey(provider)])
    const capabilities = Object.fromEntries(result.models.map((model) => [
      model,
      { ...(catalogCapabilities[model] || {}), ...(probeRow[model] || {}) } as ModelCapability,
    ]))
    rankedPurposes = await computeAndPersistRankings({ store, provider, models: result.models, capabilities, nowMs })
  }
  const nextState: LastRefreshState = {
    lastProvider: provider,
    lastRunAt: nowMs,
    results: {
      ...(state.results || {}),
      [provider]: {
        discoveryOk: result.discoveryOk,
        models: result.models.length,
        at: nowMs,
        ...(result.lastError ? { lastError: result.lastError } : {}),
      },
    },
  }
  await store.write(AI_AUTO_LAST_REFRESH_KEY, JSON.stringify(nextState))
  return {
    provider,
    discoveryOk: result.discoveryOk,
    models: result.models,
    modelCount: result.models.length,
    sourceCount: result.sourceCount,
    lastError: result.lastError,
    retired: result.retired || [],
    renamed: result.renamed || {},
    warnings,
    probes,
    probedModels,
    skippedProbeModels,
    rankedPurposes,
  }
}

// Manual "refresh now" for one provider (admin action): same discovery
// path as the cron, without advancing the round-robin cursor.
export async function refreshProviderNow(
  provider: string,
  deps: { store: AutoRefreshStore; discover?: (provider: string) => Promise<DiscoveryResult> },
): Promise<DiscoveryResult> {
  return (deps.discover || defaultDiscover)(String(provider || '').toUpperCase())
}
