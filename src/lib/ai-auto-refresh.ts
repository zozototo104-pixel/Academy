// Auto AI background refresh (step 3) — discovery + capability probes.
//
// Quota-safe shape, enforced here and not left to callers:
// - ONE provider per run, round-robin over built-in and enabled custom providers.
// - One tiny /models fetch per run (the provider's own discovery path).
// - Capability probes capped (two models per run by default), rotated per
//   provider and never on the live request path.
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
  AUTO_PURPOSES,
  autoRankingKey,
  buildAutoRankingPayload,
  parseAutoRanking,
  rankModelsForTask,
  reconcileReferences,
  type AutoCandidate,
  type ReferenceWarning,
} from './ai-auto-mode'
import { runCapabilityProbes, type ProbeCallFn, type ProbeKind, type ProbeResult } from './ai-capability-probes'
import type { ModelCapability } from './text-ai'

export const AI_AUTO_LAST_REFRESH_KEY = 'AI_AUTO_LAST_REFRESH'
export const AI_AUTO_REFRESH_LAST_RUN_KEY = 'AI_AUTO_REFRESH_LAST_RUN'
// One provider per minute, not all providers in one expensive invocation.
export const AI_AUTO_REFRESH_INTERVAL_MS = 60 * 1000
export const AI_AUTO_CAPABILITY_PROBES_KEY_PREFIX = 'AI_AUTO_CAPABILITY_PROBES:'
export const AI_AUTO_PROBE_CURSOR_KEY_PREFIX = 'AI_AUTO_PROBE_CURSOR:'

// Built-in providers with a discovery path, in round-robin order. The cron
// appends enabled custom providers to this list at runtime.
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
  probeModelsPerRun?: number
  probeTimeoutMs?: number
  // The catalog is already in the text-router cache after discover().
  // Read its provider-declared capabilities without another network call.
  capabilitiesForProvider?: (provider: string) => Promise<Record<string, ModelCapability>>
  rankAfterRefresh?: boolean
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
  rankedPurposes?: string[]
}

function parseRecord(raw: unknown): Record<string, any> {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
  } catch { return {} }
}

// A changed provider replaces only its own entries. Other providers keep
// their most recent known-good scores until their round-robin turn arrives.
// At most three qualified candidates from each provider survive, so one
// gateway with hundreds of models cannot hide every alternative provider.
export function mergeProviderRanking(previous: AutoCandidate[], provider: string, fresh: AutoCandidate[]): AutoCandidate[] {
  const retained = previous.filter((item) => item.provider !== provider)
  const eligible = fresh.filter((item) => !item.excludedReason).slice(0, 3)
  const rejected = fresh.filter((item) => item.excludedReason).slice(0, 3)
  const combined = [...retained, ...eligible, ...rejected]
  combined.sort((a, b) => {
    if (!!a.excludedReason !== !!b.excludedReason) return a.excludedReason ? 1 : -1
    return (b.score ?? 0) - (a.score ?? 0) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)
  })
  return combined.slice(0, 64)
}

async function computeAndPersistRankings(args: {
  store: AutoRefreshStore
  provider: string
  models: string[]
  capabilities: Record<string, ModelCapability>
  nowMs: number
}): Promise<string[]> {
  const { store, provider, models, capabilities, nowMs } = args
  if (!models.length) return []
  const rankingKeys = AUTO_PURPOSES.map(autoRankingKey)
  const statsKeys = models.flatMap((model) => [
    `AI_MODEL_STATS:${provider}:${model}`,
    `AI_MODEL_HEALTH:${provider}:${model}`,
    ...AUTO_PURPOSES.map((purpose) => `AI_MODEL_STATS:${purpose}:${provider}:${model}`),
  ])
  const rows = await store.read([...rankingKeys, ...statsKeys, 'AI_PAID_USAGE_MODE', 'AI_PROVIDER_TIERS'])
  const tiers = String(rows.AI_PROVIDER_TIERS || '').split(',').map((item) => item.split(':'))
  const providerTier = tiers.find(([id]) => id?.toUpperCase() === provider)?.[1]?.toLowerCase()
  const allowPaid = ['last_resort', 'critical_first'].includes(String(rows.AI_PAID_USAGE_MODE || '').toLowerCase())
  for (const purpose of AUTO_PURPOSES) {
    const ranked = rankModelsForTask(models.map((model) => {
      const global = parseRecord(rows[`AI_MODEL_STATS:${provider}:${model}`])
      const specific = parseRecord(rows[`AI_MODEL_STATS:${purpose}:${provider}:${model}`])
      const count = (Number(specific.success) || 0) + Object.values(specific.fail || {}).reduce((n: number, v) => n + (Number(v) || 0), 0)
      const rawStats = count >= 5 ? specific : global
      const stats = {
        success: Number(rawStats.success) || 0,
        fail: parseRecord(rawStats.fail),
        avgMs: Number(rawStats.avgMs) || 0,
        jsonOk: Number(rawStats.jsonOk) || 0,
        jsonTotal: Number(rawStats.jsonTotal) || 0,
        evidenceOk: Number(rawStats.evidenceOk) || 0,
        evidenceTotal: Number(rawStats.evidenceTotal) || 0,
      }
      const health = parseRecord(rows[`AI_MODEL_HEALTH:${provider}:${model}`])
      const capability = capabilities[model] || null
      const costTier = capability?.costTier === 'paid' || providerTier === 'paid'
        ? 'paid' as const
        : capability?.costTier === 'free' || providerTier === 'free' ? 'free' as const : 'unknown' as const
      // A recent explicit provider 402 is useful negative evidence. An
      // unknown balance stays unknown; 429 only reduces the quota score.
      const noBalance = health.status === 402 && /balance|credit|quota|insufficient/i.test(String(health.error || ''))
      return {
        provider, model, purpose, stats,
        health: typeof health.ok === 'boolean'
          ? {
            ok: health.ok as boolean,
            latencyMs: Number(health.latencyMs) || undefined,
            checkedAt: typeof health.checkedAt === 'string' ? health.checkedAt : undefined,
            status: Number(health.status) || undefined,
            error: typeof health.error === 'string' ? health.error : undefined,
          } : null,
        capability,
        quotaState: { noBalance, rate429Count: health.status === 429 ? 1 : 0 },
        contextNeededTokens: purpose === 'LONG_CONTEXT' ? 64_000 : undefined,
        costState: { costTier, allowPaid },
      }
    }))
    const key = autoRankingKey(purpose)
    const fresh = buildAutoRankingPayload({ purpose, ranked, computedAtMs: nowMs }).candidates as AutoCandidate[]
    const combined = mergeProviderRanking(parseAutoRanking(rows[key]), provider, fresh)
    await store.write(key, JSON.stringify({ purpose, computedAt: new Date(nowMs).toISOString(), candidates: combined }))
  }
  return [...AUTO_PURPOSES]
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
