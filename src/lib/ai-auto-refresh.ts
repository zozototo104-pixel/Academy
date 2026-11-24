// Auto AI background refresh (step 3) — discovery + capability probes.
//
// Quota-safe shape, enforced here and not left to callers:
// - ONE provider per hourly run, round-robin over built-in and enabled custom providers.
// - One tiny /models fetch per run (the provider's own discovery path).
// - Hourly capability probes capped (one model per production run), rotated
//   per provider; a separate per-purpose first-task preflight has its own
//   persisted lease/cache and tests at most two models on a cold task.
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
  noModelPendingKey,
  parseAutoRanking,
  rankModelsForTask,
  reconcileReferences,
  type AutoCandidate,
  type ReferenceWarning,
} from './ai-auto-mode'
import { buildJsonProbe, buildLongContextProbe, buildOcrProbe, evaluateProbeResponse, runCapabilityProbes, type ProbeCallFn, type ProbeCallInput, type ProbeKind, type ProbeResult } from './ai-capability-probes'
import type { ModelCapability, TextAiProvider } from './text-ai'

export const AI_AUTO_LAST_REFRESH_KEY = 'AI_AUTO_LAST_REFRESH'
export const AI_AUTO_REFRESH_LAST_RUN_KEY = 'AI_AUTO_REFRESH_LAST_RUN'
// One provider per hour; production also caps probes to one model per run.
export const AI_AUTO_REFRESH_INTERVAL_MS = 60 * 60 * 1000
export const AI_AUTO_TASK_BOOTSTRAP_LAST_RUN_KEY = 'AI_AUTO_TASK_BOOTSTRAP_LAST_RUN'
// A cold task may discover catalogs once. Concurrent/failed tasks cannot
// stampede all providers; hourly cron keeps refreshing after this warm-up.
export const AI_AUTO_TASK_BOOTSTRAP_COOLDOWN_MS = 10 * 60 * 1000
export const AI_AUTO_CAPABILITY_PROBES_KEY_PREFIX = 'AI_AUTO_CAPABILITY_PROBES:'
export const AI_AUTO_PROBE_CURSOR_KEY_PREFIX = 'AI_AUTO_PROBE_CURSOR:'
export const AI_AUTO_TASK_PREFLIGHT_KEY_PREFIX = 'AI_AUTO_TASK_PREFLIGHT:'
export const AI_AUTO_TASK_PREFLIGHT_VALID_MS = 24 * 60 * 60 * 1000
export const AI_AUTO_TASK_PREFLIGHT_RETRY_MS = 10 * 60 * 1000

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
  // Optional: present on the router's settingStore, the test stores and
  // the cron route's inline store. A store without delete simply cannot
  // clear a pending no-model event (decision 3 recovery).
  delete?(key: string): Promise<void>
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

export async function claimAiAutoTaskBootstrapRun(client: RawQueryClient = db, nowMs = Date.now()): Promise<boolean> {
  const rows = await client.$queryRawUnsafe<Array<{ key: string }>>(
    `INSERT INTO "Setting" ("key", "value", "updatedAt")
     VALUES ('AI_AUTO_TASK_BOOTSTRAP_LAST_RUN', $1, CURRENT_TIMESTAMP)
     ON CONFLICT ("key") DO UPDATE
       SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
     WHERE CASE
       WHEN "Setting"."value" ~ '^[0-9]+$' THEN "Setting"."value"::bigint
       ELSE 0
     END < $2
     RETURNING "key"`,
    String(nowMs),
    nowMs - AI_AUTO_TASK_BOOTSTRAP_COOLDOWN_MS,
  )
  return rows.length > 0
}

// A per-purpose, cross-instance lease prevents two concurrent first tasks
// from spending the same probe quota. Values are parameters, never SQL text.
export async function claimAiAutoTaskPreflightRun(purpose: string, client: RawQueryClient = db, nowMs = Date.now()): Promise<boolean> {
  if (!AUTO_PURPOSES.includes(purpose as typeof AUTO_PURPOSES[number])) return false
  const key = `${AI_AUTO_TASK_PREFLIGHT_KEY_PREFIX}CLAIM:${purpose}`
  const rows = await client.$queryRawUnsafe<Array<{ key: string }>>(
    `INSERT INTO "Setting" ("key", "value", "updatedAt")
     VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT ("key") DO UPDATE
       SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
     WHERE CASE
       WHEN "Setting"."value" ~ '^[0-9]+$' THEN "Setting"."value"::bigint
       ELSE 0
     END < $3
     RETURNING "key"`,
    key, String(nowMs), nowMs - AI_AUTO_TASK_PREFLIGHT_RETRY_MS,
  )
  return rows.length > 0
}

export type PreflightVerdict = { provider: string; model: string; pass: boolean; available: boolean; latencyMs: number }
export type PreflightSnapshot = { at: number; kind: ProbeKind; verdicts: PreflightVerdict[]; consecutiveFailures?: number }

export function taskPreflightKey(purpose: string): string {
  return `${AI_AUTO_TASK_PREFLIGHT_KEY_PREFIX}${purpose}`
}

// The hourly cron and first-task preflight share a single REAL, pinned
// provider/model call. The OCR answer is only present in the raster PNG;
// skipAutoSelection prevents probes recursively triggering preflights.
async function callPinnedProbe(input: ProbeCallInput & { provider: string; model: string }, timeoutMs: number, maxOutputTokens: number) {
  try {
    const attachments = input.kind === 'ocr' && input.planted
      ? [{ mimeType: 'image/png', base64: (await (await import('sharp')).default(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="820" height="240"><rect width="100%" height="100%" fill="white"/><text x="40" y="140" font-family="sans-serif" font-size="37" fill="black">${input.planted.replace(/[^A-Za-z0-9-]/g, '')}</text></svg>`)).png().toBuffer()).toString('base64') }]
      : undefined
    const { textAiCompleteWithMetadata } = await import('./text-ai')
    const result = await textAiCompleteWithMetadata({
      history: [{ role: 'user', text: input.prompt }],
      purpose: 'CHAT',
      system: 'Answer the prompt exactly as instructed, with nothing else.',
      restrictToModels: [{ provider: input.provider as Exclude<TextAiProvider, 'AUTO'>, model: input.model }],
      skipAutoSelection: true,
      attachments,
      json: input.kind === 'json',
      maxOutputTokens,
      timeoutMs,
    })
    if (result.provider !== input.provider || result.model !== input.model) return { text: '', ok: false, error: 'PROBE_MODEL_MISMATCH' }
    return { text: result.text, ok: true }
  } catch (error: any) {
    return { text: '', ok: false, error: String(error?.message || 'PROBE_CALL_FAILED').slice(0, 120) }
  }
}

// Preserve the hourly cron's existing allowance; keep first tasks faster.
export const callPinnedAutoProbeModel: ProbeCallFn = (input) => callPinnedProbe(input, 8_000, 256)
export const callFastAutoProbeModel: ProbeCallFn = (input) => callPinnedProbe(input, 6_000, 128)

function taskProbe(purpose: string): ProbeCallInput {
  if (purpose === 'VISION') return buildOcrProbe(Math.random().toString(36).slice(2, 10).toUpperCase())
  // A short acceptance smoke test, not a full 64k-token stress test.
  if (purpose === 'LONG_CONTEXT') return buildLongContextProbe(8_000)
  const instruction = purpose === 'ANALYSIS'
    ? 'An accounting ledger has revenue of 75 and expenses of 33. Calculate net profit.'
    : purpose === 'GRADING'
      ? 'A learner wrote 6 times 7 equals 40. Determine the correct numeric answer.'
      : purpose === 'REVIEW'
        ? 'Audit and correct this erroneous statement: 21 plus 21 equals 41.'
        : purpose === 'GENERATION'
          ? 'Generate the numeric answer to 7 multiplied by 6.'
          : 'What is the numeric answer to 6 multiplied by 7?'
  return { ...buildJsonProbe(), prompt: `${instruction} Reply ONLY as JSON with keys "probe":true and "value":the computed integer. Do not quote the answer from the question.` }
}

export function parseTaskPreflight(raw: string): PreflightSnapshot | null {
  try {
    const parsed = JSON.parse(raw || 'null') as PreflightSnapshot
    if (!parsed || !Number.isFinite(parsed.at) || parsed.at <= 0 || parsed.at > 8.64e15 || !Array.isArray(parsed.verdicts)
      || !['json', 'ocr', 'long-context'].includes(parsed.kind)) return null
    return parsed
  } catch { return null }
}

export function orderByTaskPreflight(candidates: AutoCandidate[], snapshot: PreflightSnapshot | null): AutoCandidate[] {
  if (!snapshot) return candidates
  const verdicts = new Map(snapshot.verdicts.map((item) => [`${item.provider}:${item.model}`, item]))
  const status = (item: AutoCandidate) => {
    const v = verdicts.get(`${item.provider}:${item.model}`)
    return !v ? 1 : v.pass ? 0 : 2
  }
  return [...candidates].sort((a, b) => status(a) - status(b)
    || (status(a) === 0 ? (verdicts.get(`${a.provider}:${a.model}`)?.latencyMs || Infinity) - (verdicts.get(`${b.provider}:${b.model}`)?.latencyMs || Infinity) : 0))
}

export interface TaskPreflightInput {
  store: AutoRefreshStore
  purpose: string
  candidates: AutoCandidate[] // Already filtered by paid/quota/verifier constraints.
  callModel: ProbeCallFn
  claim?: (purpose: string) => Promise<boolean>
  nowMs?: number
  timeoutMs?: number
}

// At most TWO live, pinned calls on the first task per purpose (one per
// provider where possible). Success is reused for a day, across tasks and
// Vercel workers. Transient failures retry after a 10-minute lease; normal
// requests incur zero calls. Sorting never admits excluded candidates.
export async function preflightAutoCandidatesForTask(input: TaskPreflightInput): Promise<AutoCandidate[]> {
  if (!AUTO_PURPOSES.includes(input.purpose as typeof AUTO_PURPOSES[number]) || !input.candidates.length) return input.candidates
  const nowMs = input.nowMs ?? Date.now()
  const key = taskPreflightKey(input.purpose)
  const saved = parseTaskPreflight((await input.store.read([key]))[key] || '')
  const available = new Set(input.candidates.map((item) => `${item.provider}:${item.model}`))
  const passedStillEligible = saved?.verdicts.some((item) => item.pass && available.has(`${item.provider}:${item.model}`)) || false
  // Exponential backoff if an entire pool is down: 10, 20, 40 ... up
  // to 6h. A new candidate can be explored at the next allowed check.
  const failures = Math.max(0, Math.min(8, Number(saved?.consecutiveFailures) || 0))
  const retryMs = Math.min(6 * 60 * 60 * 1000, AI_AUTO_TASK_PREFLIGHT_RETRY_MS * 2 ** Math.max(0, failures - 1))
  const validFor = passedStillEligible ? AI_AUTO_TASK_PREFLIGHT_VALID_MS : retryMs
  if (saved && nowMs >= saved.at && nowMs - saved.at < validFor) return orderByTaskPreflight(input.candidates, saved)
  if (!(await (input.claim || claimAiAutoTaskPreflightRun)(input.purpose))) {
    return saved && nowMs - saved.at < AI_AUTO_TASK_PREFLIGHT_VALID_MS
      ? orderByTaskPreflight(input.candidates, saved) : input.candidates
  }

  const chosen: AutoCandidate[] = []
  const seenProviders = new Set<string>()
  const passedBefore = new Set((saved?.verdicts || []).filter((item) => item.pass).map((item) => `${item.provider}:${item.model}`))
  const failedBefore = new Set((saved?.verdicts || []).filter((item) => !item.pass).map((item) => `${item.provider}:${item.model}`))
  const candidatePool = [
    ...input.candidates.filter((item) => passedBefore.has(`${item.provider}:${item.model}`)),
    ...input.candidates.filter((item) => !passedBefore.has(`${item.provider}:${item.model}`) && !failedBefore.has(`${item.provider}:${item.model}`)),
    ...input.candidates.filter((item) => failedBefore.has(`${item.provider}:${item.model}`)),
  ]
  for (const item of candidatePool) {
    if (chosen.length >= 2) break
    if (!seenProviders.has(item.provider)) { chosen.push(item); seenProviders.add(item.provider) }
  }
  for (const item of candidatePool) {
    if (chosen.length >= 2) break
    if (!chosen.includes(item)) chosen.push(item)
  }
  const probe = taskProbe(input.purpose)
  const timeoutMs = Math.max(1000, Math.min(8_000, input.timeoutMs ?? 6_500))
  const verdicts = await Promise.all(chosen.map(async ({ provider, model }): Promise<PreflightVerdict> => {
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        input.callModel({ ...probe, provider, model }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('PROBE_TIMEOUT')), timeoutMs) }),
      ])
      return { provider, model, pass: evaluateProbeResponse(probe.kind, result, probe).pass, available: result.ok, latencyMs: Date.now() - started }
    } catch {
      return { provider, model, pass: false, available: false, latencyMs: Date.now() - started }
    } finally { if (timer) clearTimeout(timer) }
  }))
  // Keep negative evidence from earlier bounded rounds so the next round
  // explores untested providers/models rather than paying for the same two.
  // Old passes are NOT rolled forward as fresh evidence.
  const sampled = new Set(verdicts.map((item) => `${item.provider}:${item.model}`))
  const oldFailures = nowMs - (saved?.at || 0) < 6 * 60 * 60 * 1000
    ? (saved?.verdicts || []).filter((item) => !item.pass && !sampled.has(`${item.provider}:${item.model}`)) : []
  const allVerdicts = [...verdicts, ...oldFailures].slice(0, 64)
  const snapshot: PreflightSnapshot = {
    at: nowMs, kind: probe.kind, verdicts: allVerdicts,
    consecutiveFailures: verdicts.some((item) => item.pass) ? 0 : failures + 1,
  }
  await input.store.write(key, JSON.stringify(snapshot))
  return orderByTaskPreflight(input.candidates, snapshot)
}

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
    // Decision 3 recovery: a ranking with >= 1 qualified candidate
    // clears that purpose's pending "no model" event, so the dashboard
    // banner disappears on next load. Best-effort and check-then-clear:
    // an all-excluded ranking leaves the event in place.
    if (combined.some((candidate) => !candidate.excludedReason)) {
      try { await store.delete?.(noModelPendingKey(purpose)) } catch { /* best-effort: never break the refresh */ }
    }
  }
  return [...AUTO_PURPOSES]
}

async function defaultDiscover(provider: string): Promise<DiscoveryResult> {
  const textAi = await import('./text-ai')
  return textAi.refreshDiscoveryForProvider(provider)
}

export interface AutoTaskBootstrapInput {
  store: AutoRefreshStore
  providers: readonly string[]
  claim?: () => Promise<boolean>
  discover?: (provider: string) => Promise<DiscoveryResult>
  capabilitiesForProvider?: (provider: string) => Promise<Record<string, ModelCapability>>
  nowMs?: number
  timeBudgetMs?: number
}

export interface AutoTaskBootstrapResult {
  claimed: boolean
  scanned: string[]
  ranked: string[]
  failed: string[]
}

// First actual task with an empty auto ranking: discover configured providers
// in a bounded, three-way catalog scan, then persist their purpose rankings.
// This discovery step itself makes no synthetic calls. The router invokes
// preflightAutoCandidatesForTask after filtering the discovered ranking;
// future tasks reuse the saved live evidence and stable pin.
export async function bootstrapAutoRankingsForTask(input: AutoTaskBootstrapInput): Promise<AutoTaskBootstrapResult> {
  const providers = [...new Set(input.providers.map((item) => String(item || '').toUpperCase()).filter(Boolean))]
  const summary: AutoTaskBootstrapResult = { claimed: false, scanned: [], ranked: [], failed: [] }
  if (!providers.length || !(await (input.claim || claimAiAutoTaskBootstrapRun)())) return summary
  summary.claimed = true
  const discover = input.discover || defaultDiscover
  const timeBudgetMs = Math.max(1000, Math.min(15_000, input.timeBudgetMs ?? 10_000))
  const deadline = Date.now() + timeBudgetMs
  let index = 0
  let rankWrites: Promise<void> = Promise.resolve()

  const worker = async () => {
    while (index < providers.length && Date.now() < deadline) {
      const provider = providers[index++]
      summary.scanned.push(provider)
      let timer: ReturnType<typeof setTimeout> | undefined
      let discovery: DiscoveryResult | null = null
      try {
        discovery = await Promise.race([
          discover(provider),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('CATALOG_TIMEOUT')), Math.min(4000, Math.max(1000, deadline - Date.now()))) }),
        ])
      } catch {
        summary.failed.push(provider)
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (!discovery?.discoveryOk || !discovery.models.length) {
        if (!summary.failed.includes(provider)) summary.failed.push(provider)
        continue
      }
      // Discovery may run concurrently; ranking writes are serialized so
      // each provider merges with the previous one, without lost updates.
      const result = discovery
      const write = rankWrites.then(async () => {
        const catalog = await input.capabilitiesForProvider?.(provider) || {}
        const probeKey = probeCapabilityKey(provider)
        const probes = parseRecord((await input.store.read([probeKey]))[probeKey])
        const capabilities = Object.fromEntries(result.models.map((model) => [
          model, { ...(catalog[model] || {}), ...(probes[model] || {}) } as ModelCapability,
        ]))
        await computeAndPersistRankings({ store: input.store, provider, models: result.models, capabilities, nowMs: input.nowMs ?? Date.now() })
        summary.ranked.push(provider)
      }).catch(() => { summary.failed.push(provider) })
      rankWrites = write
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, providers.length) }, () => worker()))
  await rankWrites
  return summary
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
