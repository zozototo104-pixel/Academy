// Auto AI provider/model management — toggle + ranking lookup (steps 1-2).
//
// Pure layer: no database, route or UI imports. The router (text-ai.ts)
// owns persistence (Setting keys) and the call loop; this module owns the
// override contract so it can be unit-tested without a database:
//
// - OFF (default): every helper is a passthrough — manual provider order,
//   admin-chosen global models and stage-profile restrictions behave
//   byte-for-byte as today. Auto code NEVER writes to manual keys
//   (AI_PROVIDER_FALLBACK_ORDER, AI_TEXT_PROVIDER, {PROVIDER}_TEXT_MODEL,
//   stage-profile snapshots).
// - ON: the auto ranking (AI_AUTO_RANKING:<purpose>, computed by later
//   steps — scorer/discovery/probes) replaces preferredProviders /
//   preferredModels / restrictToModels for the call. The admin-chosen
//   global model stays only as the fallback seed when the ranking is
//   empty; stage-profile restrictToModels is ignored for ranking but the
//   override is recorded in telemetry (detail.autoOverride, see
//   autoOverrideDetail()).
// - Paid safety holds in both modes: a candidate whose model is on the
//   paid list while AI_PAID_USAGE_MODE is off is dropped by
//   resolveAutoCandidates; the router's paid-budget check still gates
//   paid tiers downstream. Auto never enables a paid model.
// - Verifier safety is a hard invariant: excludeProviders /
//   excludeModelFamilies are NEVER overridden — ranking candidates that
//   match an exclusion are dropped with a reason, never attempted.
import type { ModelCapability, TextAiPreferredModel, TextAiPurpose } from './text-ai'

export const AI_AUTO_MODE_ENABLED_KEY = 'AI_AUTO_MODE_ENABLED'
export const AI_AUTO_MODE_CONFIG_KEY = 'AI_AUTO_MODE_CONFIG'
export const AI_AUTO_RANKING_KEY_PREFIX = 'AI_AUTO_RANKING:'
// Step 8 — transitions log: every auto<->manual switch is recorded in
// this Setting key as a JSON array of { at, from, to }, newest first,
// capped at AI_AUTO_MODE_TRANSITIONS_MAX entries. It is OUR OWN store
// and key (not the bot's); the toggle UI in AdminSystemTab saves through
// /api/admin/system PATCH, which is where the recording happens.
export const AI_AUTO_MODE_TRANSITIONS_KEY = 'AI_AUTO_MODE_TRANSITIONS'
export const AI_AUTO_MODE_TRANSITIONS_MAX = 20

export const AUTO_PURPOSES: readonly TextAiPurpose[] = [
  'CHAT', 'ANALYSIS', 'GENERATION', 'GRADING', 'VISION', 'LONG_CONTEXT', 'REVIEW',
]

export function autoRankingKey(purpose: TextAiPurpose | string): string {
  return `${AI_AUTO_RANKING_KEY_PREFIX}${String(purpose || 'CHAT').toUpperCase()}`
}

export interface AutoCandidate {
  provider: string
  model: string
  score?: number
  // Score breakdown persisted by buildAutoRankingPayload (step 5) so the
  // dashboard can show WHY a model was chosen. Absent on rows written
  // before step 5 / hand-written rows — never invented by the reader.
  components?: ScoreComponents
  // Set by the scorer (step 5) on persisted rankings: a model excluded
  // for quota/capability/paid reasons is stored WITH its reason so the
  // dashboard can show why — but it must never be attempted.
  excludedReason?: string
}

export interface AutoModeConfig {
  explorationRate: number
  refreshIntervalMinutes: number
  probeBudgetPerRun: number
}

export const DEFAULT_AUTO_MODE_CONFIG: AutoModeConfig = {
  explorationRate: 0.2,
  refreshIntervalMinutes: 60,
  probeBudgetPerRun: 3,
}

function isTruthyAutoValue(value: unknown): boolean {
  const v = String(value ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

// The single toggle. Accepts the settings() shape ({ autoMode: boolean }),
// a raw Setting row map ({ AI_AUTO_MODE_ENABLED: '1' }), or a raw value.
// Default is OFF — auto mode is opt-in, never on by accident.
export function isAutoModeEnabled(settings: unknown): boolean {
  if (typeof settings === 'string' || typeof settings === 'number' || typeof settings === 'boolean') {
    return isTruthyAutoValue(settings)
  }
  if (!settings || typeof settings !== 'object') return false
  const record = settings as Record<string, unknown>
  if ('autoMode' in record) return record.autoMode === true
  if (AI_AUTO_MODE_ENABLED_KEY in record) return isTruthyAutoValue(record[AI_AUTO_MODE_ENABLED_KEY])
  return false
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// AI_AUTO_MODE_CONFIG is JSON; malformed or partial input falls back to
// defaults per field — a bad config row must never break routing.
export function parseAutoModeConfig(raw: unknown): AutoModeConfig {
  let parsed: Record<string, unknown> = {}
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>
  } catch {
    parsed = {}
  }
  return {
    explorationRate: clampNumber(parsed.explorationRate, DEFAULT_AUTO_MODE_CONFIG.explorationRate, 0, 1),
    refreshIntervalMinutes: Math.floor(clampNumber(parsed.refreshIntervalMinutes, DEFAULT_AUTO_MODE_CONFIG.refreshIntervalMinutes, 5, 1440)),
    probeBudgetPerRun: Math.floor(clampNumber(parsed.probeBudgetPerRun, DEFAULT_AUTO_MODE_CONFIG.probeBudgetPerRun, 0, 10)),
  }
}

const PROVIDER_ID_RE = /^[A-Z][A-Z0-9_]{1,31}$/
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.\/:@-]{0,180}$/

export function isValidAutoCandidate(candidate: unknown): candidate is AutoCandidate {
  if (!candidate || typeof candidate !== 'object') return false
  const item = candidate as Record<string, unknown>
  return PROVIDER_ID_RE.test(String(item.provider || '').toUpperCase())
    && MODEL_ID_RE.test(String(item.model || ''))
}

// Parse a stored AI_AUTO_RANKING:<purpose> payload. Accepts
// { candidates: [{ provider, model, score? }] } or a bare array.
// Invalid rows are dropped (never invented); duplicates collapse;
// at most 64 candidates are kept.
export function parseAutoRanking(raw: unknown): AutoCandidate[] {
  let rows: unknown = null
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw
    if (Array.isArray(value)) rows = value
    else if (value && typeof value === 'object') rows = (value as Record<string, unknown>).candidates ?? null
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const out: AutoCandidate[] = []
  for (const row of rows) {
    if (!isValidAutoCandidate(row)) continue
    const candidate: AutoCandidate = {
      provider: String(row.provider).toUpperCase(),
      model: String(row.model),
    }
    const score = Number((row as unknown as Record<string, unknown>).score)
    if (Number.isFinite(score)) candidate.score = score
    // Score breakdown, when the stored row carries one: six 0..1 numbers.
    // A malformed components object is dropped, never repaired or guessed.
    const rawComponents = (row as unknown as Record<string, unknown>).components
    if (rawComponents && typeof rawComponents === 'object' && !Array.isArray(rawComponents)) {
      const comp = rawComponents as Record<string, unknown>
      const fields = ['quality', 'recentSuccess', 'adherence', 'latency', 'quota', 'cost'] as const
      const parsed = {} as Record<string, number>
      let valid = true
      for (const field of fields) {
        const n = Number(comp[field])
        if (!Number.isFinite(n) || n < 0 || n > 1) { valid = false; break }
        parsed[field] = n
      }
      if (valid) candidate.components = parsed as ScoreComponents
    }
    const excludedReason = (row as unknown as Record<string, unknown>).excludedReason
    if (typeof excludedReason === 'string' && excludedReason.trim()) candidate.excludedReason = excludedReason.trim().slice(0, 120)
    const key = `${candidate.provider}:${candidate.model.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
    if (out.length >= 64) break
  }
  return out
}

// A stored AI_AUTO_RANKING:<purpose> payload as the dashboard reads it:
// the ranking's computedAt plus its candidates (score / components /
// excludedReason preserved). A missing or malformed computedAt is null,
// never invented — the dashboard shows "not computed yet" instead.
export function parseAutoRankingPayload(raw: unknown): { computedAt: string | null; candidates: AutoCandidate[] } {
  let computedAt: string | null = null
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const at = (value as Record<string, unknown>).computedAt
      if (typeof at === 'string' && Number.isFinite(Date.parse(at))) computedAt = at
    }
  } catch {
    computedAt = null
  }
  return { computedAt, candidates: parseAutoRanking(raw) }
}

export type AutoModeDirection = 'auto' | 'manual'

export interface AutoModeTransition {
  at: string
  from: AutoModeDirection
  to: AutoModeDirection
}

function isAutoModeDirection(value: unknown): value is AutoModeDirection {
  return value === 'auto' || value === 'manual'
}

// Parse the stored AI_AUTO_MODE_TRANSITIONS array. Invalid rows are
// dropped; the stored order (newest first) is kept; the cap is enforced
// so a corrupt or over-long row can never grow unbounded.
export function parseAutoModeTransitions(raw: unknown): AutoModeTransition[] {
  let rows: unknown = null
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw
    if (Array.isArray(value)) rows = value
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: AutoModeTransition[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    const item = row as Record<string, unknown>
    if (typeof item.at !== 'string' || !Number.isFinite(Date.parse(item.at))) continue
    if (!isAutoModeDirection(item.from) || !isAutoModeDirection(item.to)) continue
    out.push({ at: item.at, from: item.from, to: item.to })
    if (out.length >= AI_AUTO_MODE_TRANSITIONS_MAX) break
  }
  return out
}

// Prepend one switch to the log, newest first, capped at
// AI_AUTO_MODE_TRANSITIONS_MAX. A no-op (from === to) returns the
// previous log unchanged — the caller must only record real changes,
// and this guard keeps a double-save from writing a phantom switch.
export function recordAutoModeTransition(
  previous: AutoModeTransition[],
  from: AutoModeDirection,
  to: AutoModeDirection,
  nowMs = Date.now(),
): AutoModeTransition[] {
  const validPrevious = (previous || []).filter(
    (entry): entry is AutoModeTransition =>
      !!entry && typeof entry.at === 'string' && isAutoModeDirection(entry.from) && isAutoModeDirection(entry.to),
  )
  if (from === to) return validPrevious.slice(0, AI_AUTO_MODE_TRANSITIONS_MAX)
  return [{ at: new Date(nowMs).toISOString(), from, to }, ...validPrevious].slice(0, AI_AUTO_MODE_TRANSITIONS_MAX)
}

export interface ResolveAutoCandidatesInput {
  autoMode: boolean
  ranking: AutoCandidate[]
  purpose?: string
  taskType?: string
  excludeProviders?: readonly string[]
  excludeModelFamilies?: readonly string[]
  // Family of a (provider, model) pair, when the caller can resolve it.
  // When omitted, family exclusions still hold downstream in the router
  // loop (eligibleFamily) — this module never clears them.
  modelFamily?: (provider: string, model: string) => string | undefined
  preferredProviders?: readonly string[]
  preferredModels?: readonly TextAiPreferredModel[]
  restrictToModels?: readonly TextAiPreferredModel[]
  // Models on the paid list while AI_PAID_USAGE_MODE is off. Such
  // candidates are dropped even when the ranking lists them.
  paidBlockedModels?: readonly string[]
}

export interface ResolveAutoCandidatesResult {
  preferredProviders: string[]
  preferredModels: TextAiPreferredModel[]
  restrictToModels: readonly TextAiPreferredModel[] | undefined
  autoOverride: boolean
  autoCandidates: AutoCandidate[]
  overriddenRestrictToModels?: readonly TextAiPreferredModel[]
  excludedReasons: string[]
}

// THE choke point (plan step 2). When auto is OFF — or when auto is ON but
// the ranking for this purpose is empty — this is a no-op passthrough:
// the caller's preferred/restrict inputs reach the router unchanged, and
// the admin global model still seeds modelFallbacks downstream.
// When auto is ON with a non-empty qualified ranking, the ranking replaces
// preferredProviders / preferredModels and restrictToModels is ignored
// (recorded in overriddenRestrictToModels for telemetry). Exclusions and
// paid blocks are applied BEFORE the ranking can win anything.
export function resolveAutoCandidates(input: ResolveAutoCandidatesInput): ResolveAutoCandidatesResult {
  const passthrough: ResolveAutoCandidatesResult = {
    preferredProviders: [...(input.preferredProviders || [])],
    preferredModels: [...(input.preferredModels || [])],
    restrictToModels: input.restrictToModels,
    autoOverride: false,
    autoCandidates: [],
    excludedReasons: [],
  }
  if (!input.autoMode) return passthrough
  const excludedProviders = new Set((input.excludeProviders || []).map((p) => String(p).toUpperCase()))
  const excludedFamilies = new Set((input.excludeModelFamilies || []).map((f) => String(f).toLowerCase()))
  const paidBlocked = new Set((input.paidBlockedModels || []).map((m) => String(m).toLowerCase()))
  const excludedReasons: string[] = []
  const qualified = (input.ranking || []).filter((candidate) => {
    // A persisted ranking entry the scorer excluded (quota, capability,
    // paid, context) is never re-admitted by the router, whatever the
    // stored order says — the reason is recorded, not retried.
    if (candidate.excludedReason) {
      excludedReasons.push(`${candidate.provider}:${candidate.model} ${candidate.excludedReason}`)
      return false
    }
    if (excludedProviders.has(candidate.provider.toUpperCase())) {
      excludedReasons.push(`${candidate.provider}:${candidate.model} EXCLUDED_PROVIDER`)
      return false
    }
    const family = input.modelFamily?.(candidate.provider, candidate.model)
    if (family && excludedFamilies.has(family.toLowerCase())) {
      excludedReasons.push(`${candidate.provider}:${candidate.model} EXCLUDED_FAMILY`)
      return false
    }
    if (paidBlocked.has(candidate.model.toLowerCase())) {
      excludedReasons.push(`${candidate.provider}:${candidate.model} PAID_BLOCKED`)
      return false
    }
    return true
  })
  if (!qualified.length) return { ...passthrough, excludedReasons }
  return {
    preferredProviders: [...new Set(qualified.map((c) => c.provider))],
    preferredModels: qualified.map((c) => ({ provider: c.provider as TextAiPreferredModel['provider'], model: c.model })),
    restrictToModels: undefined,
    autoOverride: true,
    autoCandidates: qualified,
    overriddenRestrictToModels: input.restrictToModels?.length ? [...input.restrictToModels] : undefined,
    excludedReasons,
  }
}

// Telemetry detail for AiPipelineOperationLog.detail.autoOverride: what the
// auto layer overrode on this run, so an admin can see the manual value
// that lost. Pure — it never writes anything itself.
export function autoOverrideDetail(args: {
  autoOverride: boolean
  autoCandidates?: AutoCandidate[]
  overriddenRestrictToModels?: readonly { provider: string; model: string }[]
  excludedReasons?: string[]
  stageProfile?: { profileId: string; version: number } | null
  // Step 5 telemetry: the model actually chosen + why it ranked
  // first, recorded in AiPipelineOperationLog.detail so an admin can
  // see the ranking reason for every pipeline run.
  chosenModel?: { provider: string; model: string } | null
  rankingReason?: string
}): Record<string, unknown> {
  return {
    autoOverride: args.autoOverride,
    autoCandidates: (args.autoCandidates || []).map((c) => `${c.provider}:${c.model}`),
    overriddenRestrictToModels: (args.overriddenRestrictToModels || []).map((m) => `${m.provider}:${m.model}`),
    excludedReasons: [...(args.excludedReasons || [])],
    ...(args.chosenModel ? { chosenModel: `${args.chosenModel.provider}:${args.chosenModel.model}` } : {}),
    ...(args.rankingReason ? { rankingReason: args.rankingReason.slice(0, 240) } : {}),
    ...(args.stageProfile ? { stageProfile: { profileId: args.stageProfile.profileId, version: args.stageProfile.version } } : {}),
  }
}

// ---------------------------------------------------------------------------
// Step 3 — discovery reconciliation (pure).
//
// A refresh result is either SUCCESSFUL (the provider answered /models) or
// FAILED (HTTP error / timeout / exception). Only a successful refresh may
// move a model toward retirement:
// - present in the new catalog → ACTIVE, missedRefreshes reset to 0.
// - absent after 1 successful refresh → still ACTIVE, missedRefreshes = 1.
// - absent after 2 consecutive successful refreshes → RETIRED.
// - a failed refresh changes NOTHING: the previous catalog (and its
//   missedRefreshes) is returned unchanged with discoveryOk: false.
// A renamed model is detected conservatively: same family + same context
// size + the same name once version/date suffixes are stripped. Anything
// weaker is NOT a rename — the old name retires and the new name appears
// as a genuinely new model. Never guess.
// ---------------------------------------------------------------------------

export interface DiscoveryCatalogSnapshot {
  models: string[]
  capabilities?: Record<string, Pick<ModelCapability, 'family' | 'contextLength'>>
  missedCounts?: Record<string, number>
  retired?: string[]
}

export interface ReconcileDiscoveryOptions {
  provider: string
  nowMs: number
  // Family resolver for a model name (the router passes modelFamily()).
  // When omitted, only the catalog's declared `family` is used — a model
  // with no declared family can never match a rename.
  familyOf?: (model: string) => string | undefined
}

export interface DiscoveredModelRecord {
  provider: string
  model: string
  status: 'ACTIVE' | 'RETIRED' | 'RENAMED' | 'UNAVAILABLE'
  renamedTo?: string
  missedRefreshes: number
  firstSeenAt?: number
  lastSeenAt?: number
}

export interface ReconcileDiscoveryResult {
  provider: string
  discoveryOk: boolean
  changed: boolean
  models: string[]
  records: DiscoveredModelRecord[]
  retired: string[]
  renamed: Record<string, string>
  missedCounts: Record<string, number>
  newlyAppeared: string[]
  newlyRetired: string[]
}

// Strip version/date suffixes so `glm-5.3-flash-20261101` and
// `glm-5.3-flash` compare equal for rename detection. Only trailing
// suffixes are stripped; the core name must match exactly.
export function stripModelVersionSuffix(model: string): string {
  let name = String(model || '').trim().toLowerCase()
  name = name.replace(/:free$/, '')
  let changed = true
  while (changed) {
    changed = false
    const next = name
      .replace(/[-_:]v?\d+(?:\.\d+){1,4}$/, '')
      .replace(/[-_:]\d{6,8}$/, '')
      .replace(/[-_:](latest|preview|beta)$/, '')
    if (next !== name) { name = next; changed = true }
  }
  return name
}

function reconcileFamilyOf(
  model: string,
  capabilities: Record<string, Pick<ModelCapability, 'family' | 'contextLength'>> | undefined,
  familyOf: ReconcileDiscoveryOptions['familyOf'],
): string {
  const declared = capabilities?.[model]?.family
  if (declared && String(declared).trim()) return String(declared).toLowerCase()
  const resolved = familyOf?.(model)
  return resolved ? String(resolved).toLowerCase() : 'unknown'
}

export function reconcileDiscoveryCatalog(
  previous: DiscoveryCatalogSnapshot | null,
  next: { models: string[]; capabilities?: Record<string, Pick<ModelCapability, 'family' | 'contextLength'>>; ok?: boolean },
  opts: ReconcileDiscoveryOptions,
): ReconcileDiscoveryResult {
  const provider = String(opts.provider || '').toUpperCase()
  // Previous models = the last catalog PLUS any model already counting
  // misses or retired: after a first miss the persisted `models` list no
  // longer contains the model — only `missedCounts` remembers it. Without
  // this union the second miss would never see the model to retire it.
  const prevModels = [...new Set([
    ...(previous?.models || []),
    ...Object.keys(previous?.missedCounts || {}),
    ...(previous?.retired || []),
  ])]
  const prevMissed = { ...(previous?.missedCounts || {}) }
  const prevRetired = new Set(previous?.retired || [])
  const base: ReconcileDiscoveryResult = {
    provider,
    discoveryOk: false,
    changed: false,
    models: [...prevModels],
    records: prevModels.map((model) => ({
      provider,
      model,
      status: prevRetired.has(model) ? 'RETIRED' as const : 'ACTIVE' as const,
      missedRefreshes: prevMissed[model] || 0,
    })),
    retired: [...prevRetired],
    renamed: {},
    missedCounts: { ...prevMissed },
    newlyAppeared: [],
    newlyRetired: [],
  }
  // Failed refresh: return the previous catalog untouched.
  if (next.ok === false) return base
  const nextModels = [...new Set((next.models || []).map(String))]
  const nextSet = new Set(nextModels.map((m) => m.toLowerCase()))
  const prevSet = new Set(prevModels.map((m) => m.toLowerCase()))
  const newlyAppeared = nextModels.filter((m) => !prevSet.has(m.toLowerCase()))
  const missing = prevModels.filter((m) => !nextSet.has(m.toLowerCase()))
  // Conservative rename detection, on the FIRST miss only: a missing model
  // and a newly appeared model are the same model renamed when family and
  // context size agree exactly and the stripped names are identical.
  const renamed: Record<string, string> = {}
  const renamedTargets = new Set<string>()
  for (const oldModel of missing) {
    if ((prevMissed[oldModel] || 0) > 0) continue
    const oldFamily = reconcileFamilyOf(oldModel, previous?.capabilities, opts.familyOf)
    const oldContext = previous?.capabilities?.[oldModel]?.contextLength
    if (oldFamily === 'unknown' || !Number.isFinite(Number(oldContext))) continue
    for (const newModel of newlyAppeared) {
      if (renamedTargets.has(newModel.toLowerCase())) continue
      const newFamily = reconcileFamilyOf(newModel, next.capabilities, opts.familyOf)
      const newContext = next.capabilities?.[newModel]?.contextLength
      if (newFamily !== oldFamily || Number(newContext) !== Number(oldContext)) continue
      if (stripModelVersionSuffix(oldModel) !== stripModelVersionSuffix(newModel)) continue
      renamed[oldModel] = newModel
      renamedTargets.add(newModel.toLowerCase())
      break
    }
  }
  const missedCounts: Record<string, number> = {}
  // A previously retired model that reappears is active again — retirement
  // is a statement about the last two refreshes, not a permanent ban.
  const retired: string[] = [...prevRetired].filter((m) => !nextSet.has(m.toLowerCase()))
  const newlyRetired: string[] = []
  for (const oldModel of missing) {
    if (renamed[oldModel]) continue
    const missed = (prevMissed[oldModel] || 0) + 1
    if (missed >= 2) {
      if (!retired.includes(oldModel)) { retired.push(oldModel); newlyRetired.push(oldModel) }
    } else missedCounts[oldModel] = missed
  }
  const records: DiscoveredModelRecord[] = nextModels.map((model) => ({
    provider,
    model,
    status: 'ACTIVE',
    missedRefreshes: 0,
    lastSeenAt: opts.nowMs,
  }))
  for (const oldModel of missing) {
    if (renamed[oldModel]) {
      records.push({ provider, model: oldModel, status: 'RENAMED', renamedTo: renamed[oldModel], missedRefreshes: 0 })
    } else if (retired.includes(oldModel)) {
      records.push({ provider, model: oldModel, status: 'RETIRED', missedRefreshes: (prevMissed[oldModel] || 0) + 1 })
    } else {
      records.push({ provider, model: oldModel, status: 'ACTIVE', missedRefreshes: missedCounts[oldModel] || 0 })
    }
  }
  const changed = newlyAppeared.filter((m) => !renamedTargets.has(m.toLowerCase())).length > 0
    || newlyRetired.length > 0 || Object.keys(renamed).length > 0
    || JSON.stringify(missedCounts) !== JSON.stringify(prevMissed)
  return {
    provider,
    discoveryOk: true,
    changed,
    models: nextModels,
    records,
    retired,
    renamed,
    missedCounts,
    newlyAppeared: newlyAppeared.filter((m) => !renamedTargets.has(m.toLowerCase())),
    newlyRetired,
  }
}

// ---------------------------------------------------------------------------
// Step 3 — reference reconciliation: diff the discovered catalog against
// the hardcoded lists (text-ai.ts), the admin-chosen {PROVIDER}_TEXT_MODEL
// and stage-profile model refs. Warnings only — discovery NEVER rewrites a
// manual setting or drops a stage-profile model. A retired model that a
// stage profile still references keeps loading (with a warning) so the
// admin sees it instead of silently losing the profile.
// ---------------------------------------------------------------------------

export type ReferenceWarningKind =
  | 'ADMIN_MODEL_NOT_DISCOVERED'
  | 'STAGE_MODEL_RETIRED'
  | 'STAGE_MODEL_NOT_DISCOVERED'
  | 'HARDCODED_MODEL_NOT_DISCOVERED'

export interface ReferenceWarning {
  kind: ReferenceWarningKind
  provider: string
  model: string
  detail: string
}

export function reconcileReferences(args: {
  provider: string
  discovered: string[]
  hardcoded: string[]
  retired?: string[]
  adminChosen?: string
  stageProfileModels?: string[]
}): ReferenceWarning[] {
  const provider = String(args.provider || '').toUpperCase()
  const discovered = new Set((args.discovered || []).map((m) => m.toLowerCase()))
  const hardcoded = new Set((args.hardcoded || []).map((m) => m.toLowerCase()))
  const retired = new Set((args.retired || []).map((m) => m.toLowerCase()))
  const warnings: ReferenceWarning[] = []
  const adminChosen = String(args.adminChosen || '').trim()
  if (adminChosen && adminChosen.toLowerCase() !== 'auto' && !/(^|\/|\-)auto$/i.test(adminChosen)) {
    if (!discovered.has(adminChosen.toLowerCase())) {
      warnings.push({
        kind: 'ADMIN_MODEL_NOT_DISCOVERED',
        provider,
        model: adminChosen,
        detail: 'Admin-chosen model is not in the discovered catalog; the saved choice still stands and routing falls back to it.',
      })
    }
  }
  for (const model of args.stageProfileModels || []) {
    const key = model.toLowerCase()
    if (retired.has(key)) {
      warnings.push({ kind: 'STAGE_MODEL_RETIRED', provider, model, detail: 'Stage profile references a retired model; the profile still loads, the ranked model is its rename target or the next qualified model.' })
    } else if (!discovered.has(key) && !hardcoded.has(key)) {
      warnings.push({ kind: 'STAGE_MODEL_NOT_DISCOVERED', provider, model, detail: 'Stage profile references a model absent from both the discovered catalog and the hardcoded list.' })
    }
  }
  for (const model of args.hardcoded || []) {
    if (!discovered.has(model.toLowerCase())) {
      warnings.push({ kind: 'HARDCODED_MODEL_NOT_DISCOVERED', provider, model, detail: 'Hardcoded fallback model is not in the discovered catalog; it stays available as a fallback.' })
    }
  }
  return warnings
}

// ---------------------------------------------------------------------------
// Step 4 — run-result feedback into per-purpose capability flags (pure).
//
// validate() outcomes, OCR-gate outcomes and verifier verdicts feed back
// here: a model that repeatedly fails JSON validation loses its
// extraction/audit flag FOR THAT PURPOSE; a model that repeatedly fails
// the OCR gate loses its ocr flag for VISION. A SUCCESS resets the
// failure counters for that provider:model:purpose. Demotion needs N
// failures (default 3) — one bad call never demotes a model, and demotion
// never touches the key or the model for other purposes. The stored state
// lives in the AI_AUTO_CAPABILITY_FEEDBACK Setting key (JSON); the scorer
// (step 5) merges demoted flags into the catalog capability before
// ranking. Nothing here writes to manual keys.
// ---------------------------------------------------------------------------

export const AI_AUTO_CAPABILITY_FEEDBACK_KEY = 'AI_AUTO_CAPABILITY_FEEDBACK'
export const CAPABILITY_FEEDBACK_DEMOTE_AFTER = 3

export type RunOutcomeKind = 'VALIDATION_REJECTED' | 'JSON_FAILED' | 'OCR_GATE_FAILED' | 'SUCCESS'

export interface RunResultEvent {
  provider: string
  model: string
  purpose: string
  outcome: RunOutcomeKind
}

export interface CapabilityFeedbackState {
  failures: Record<string, number>
  demoted: Record<string, string[]>
}

export interface CapabilityDemotion {
  provider: string
  model: string
  purpose: string
  flag: string
  failures: number
}

export function emptyCapabilityFeedbackState(): CapabilityFeedbackState {
  return { failures: {}, demoted: {} }
}

export function parseCapabilityFeedbackState(raw: unknown): CapabilityFeedbackState {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyCapabilityFeedbackState()
    const record = value as Record<string, unknown>
    const failures = record.failures && typeof record.failures === 'object' && !Array.isArray(record.failures)
      ? Object.fromEntries(Object.entries(record.failures as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 0]).filter(([, v]) => v > 0))
      : {}
    const demoted = record.demoted && typeof record.demoted === 'object' && !Array.isArray(record.demoted)
      ? Object.fromEntries(Object.entries(record.demoted as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []]).filter(([, v]) => v.length > 0))
      : {}
    return { failures, demoted }
  } catch {
    return emptyCapabilityFeedbackState()
  }
}

const FEEDBACK_FLAGS: Record<Exclude<RunOutcomeKind, 'SUCCESS'>, string[]> = {
  VALIDATION_REJECTED: ['extraction', 'audit'],
  JSON_FAILED: ['extraction', 'audit'],
  OCR_GATE_FAILED: ['ocr'],
}

function feedbackScopeKey(event: RunResultEvent): string {
  return `${String(event.provider || '').toUpperCase()}:${String(event.model || '').toLowerCase()}:${String(event.purpose || 'CHAT').toUpperCase()}`
}

export function applyRunResultFeedback(
  state: CapabilityFeedbackState,
  events: RunResultEvent[],
  demoteAfter: number = CAPABILITY_FEEDBACK_DEMOTE_AFTER,
): { state: CapabilityFeedbackState; demotions: CapabilityDemotion[] } {
  const failures: Record<string, number> = { ...state.failures }
  const demoted: Record<string, string[]> = Object.fromEntries(
    Object.entries(state.demoted).map(([k, v]) => [k, [...v]]),
  )
  const demotions: CapabilityDemotion[] = []
  const threshold = Math.max(1, Math.floor(demoteAfter) || CAPABILITY_FEEDBACK_DEMOTE_AFTER)
  for (const event of events) {
    const scope = feedbackScopeKey(event)
    if (event.outcome === 'SUCCESS') {
      for (const key of Object.keys(failures)) {
        if (key.startsWith(`${scope}:`)) delete failures[key]
      }
      continue
    }
    const counterKey = `${scope}:${event.outcome}`
    const count = (failures[counterKey] || 0) + 1
    failures[counterKey] = count
    if (count < threshold) continue
    const flags = FEEDBACK_FLAGS[event.outcome]
    const already = new Set(demoted[scope] || [])
    for (const flag of flags) {
      if (already.has(flag)) continue
      already.add(flag)
      demotions.push({ provider: String(event.provider || '').toUpperCase(), model: event.model, purpose: String(event.purpose || 'CHAT').toUpperCase(), flag, failures: count })
    }
    demoted[scope] = [...already]
  }
  return { state: { failures, demoted }, demotions }
}

export function demotedCapabilityFlags(state: CapabilityFeedbackState, provider: string, model: string, purpose: string): string[] {
  const scope = `${String(provider || '').toUpperCase()}:${String(model || '').toLowerCase()}:${String(purpose || 'CHAT').toUpperCase()}`
  return [...(state.demoted[scope] || [])]
}

// Merge run-result demotions into a catalog capability: a demoted flag is
// forced to false (never deleted, so the dashboard can show why). Flags
// the feedback state does not mention pass through untouched.
export function applyDemotedFlagsToCapability(
  capability: ModelCapability | null | undefined,
  demotedFlags: string[],
): ModelCapability | null {
  if (!capability) return capability ?? null
  if (!demotedFlags.length) return capability
  const out: ModelCapability = { ...capability }
  for (const flag of demotedFlags) {
    if (flag === 'ocr') out.ocr = false
    if (flag === 'extraction') out.extraction = false
    if (flag === 'audit') out.audit = false
  }
  return out
}

// ---------------------------------------------------------------------------
// Step 5 — self-scoring engine (pure).
//
// scoreModelForTask() is the per-task scorer. It reuses the router's
// healthScore() shape (success/json/evidence/latency) but scores ACROSS
// providers for one purpose/task, from per-purpose stats. Design rules,
// all pinned by tests/ai/auto-scoring.test.ts:
// - HTTP 200 alone is NEVER a success: a 200 with garbage/empty output
//   fails validate(), which lands in the stats as a VALIDATION_REJECTED
//   failure and in the quality component below. There is no "200" input.
// - Balance is NEVER assumed: no balance API exists anywhere, so the
//   scorer records balance: 'unknown' and derives quota state only from
//   429/402 counts, cooldowns and the spend ledger (costState).
// - Required capabilities are a HARD filter: a model whose catalog
//   capability explicitly says false for a purpose-required flag is
//   excluded with a reason. UNKNOWN capability (no catalog row) is NOT
//   proof of absence — it passes the filter, exactly like the router's
//   "unknown is not proof of no vision" rule.
// - Paid models are excluded unless allowPaid is true AND the paid
//   budget check passed (costState.budgetOk); free is preferred.
// - Verifier exclusion is a safety invariant: excludeProviders /
//   excludeModelFamilies are applied here too, so auto ranking can
//   never return the generator (provider or family) as verifier.
// ---------------------------------------------------------------------------

export const TEXT_AI_RUN_TIMEOUT = 'TEXT_AI_RUN_TIMEOUT'

export interface AutoModelStatsInput {
  success: number
  fail: Record<string, number>
  avgMs: number
  jsonOk: number
  jsonTotal: number
  evidenceOk: number
  evidenceTotal: number
  // Real output quality, per purpose, from stats + pipeline logs. These
  // are the quality signal: a model can have a high raw success rate
  // and still fail validation / the OCR gate / the verifier.
  validateOk?: number
  validateTotal?: number
  verifierOk?: number
  verifierTotal?: number
  ocrGateOk?: number
  ocrGateTotal?: number
  // Time-decayed recent window (last 24h). When it has >= 3 calls it
  // outweighs the all-time rate; otherwise all-time rules.
  recentSuccess?: number
  recentFail?: number
}

export interface AutoQuotaState {
  cooldownUntilMs?: number
  rate429Count?: number
  noBalance?: boolean
}

export interface AutoCostState {
  allowPaid?: boolean
  costTier?: 'free' | 'paid' | 'unknown'
  // Remaining paid budget the admin approved (USD). Only meaningful
  // when allowPaid is true; never a balance figure — balance is unknown.
  budgetRemainingUsd?: number
  budgetOk?: boolean
}

export interface ScoreModelInput {
  provider: string
  model: string
  purpose: string
  taskType?: string
  taskLevel?: string
  stats?: AutoModelStatsInput | null
  health?: { ok: boolean; latencyMs?: number; checkedAt?: string; status?: number; error?: string } | null
  capability?: ModelCapability | null
  quotaState?: AutoQuotaState | null
  contextNeededTokens?: number
  costState?: AutoCostState | null
  excludeProviders?: readonly string[]
  excludeModelFamilies?: readonly string[]
  modelFamily?: (provider: string, model: string) => string | undefined
}

export interface ScoreComponents {
  quality: number
  recentSuccess: number
  adherence: number
  latency: number
  quota: number
  cost: number
}

export interface ScoredModel {
  provider: string
  model: string
  score: number
  components: ScoreComponents
  excludedReason?: string
  // There is no balance API: the scorer never invents a remaining
  // balance. Any dashboard display must show 'unknown' + last 402/429.
  balance: 'unknown'
}

function rate(ok: number | undefined, total: number | undefined, fallback: number): number {
  if (!Number.isFinite(Number(total)) || Number(total) <= 0) return fallback
  return Math.min(1, Math.max(0, Number(ok || 0) / Number(total)))
}

function totalCalls(stats: AutoModelStatsInput | null | undefined): number {
  if (!stats) return 0
  const fails = Object.values(stats.fail || {}).reduce((sum, n) => sum + (Number(n) || 0), 0)
  return (Number(stats.success) || 0) + fails
}

// Purpose-required capability flags. A flag is required only when the
// catalog row explicitly declares it false does the model fail — see
// capabilityHardFilterReason(). VISION accepts vision OR ocr (a model
// that reads images via either flag qualifies); REVIEW needs audit;
// ANALYSIS/GENERATION need extraction.
export function requiredCapabilityFlags(purpose: string): string[] {
  const p = String(purpose || 'CHAT').toUpperCase()
  if (p === 'VISION') return ['vision', 'ocr']
  if (p === 'REVIEW') return ['audit']
  if (p === 'ANALYSIS' || p === 'GENERATION') return ['extraction']
  return []
}

function capabilityFlagValue(capability: ModelCapability | null | undefined, flag: string): boolean | undefined {
  if (!capability) return undefined
  const value = (capability as unknown as Record<string, unknown>)[flag]
  return typeof value === 'boolean' ? value : undefined
}

// HARD filter. Returns the exclusion reason, or null when the model
// passes. Unknown capability (no row, or no flag) passes — unknown is
// not proof of absence. VISION passes when EITHER vision or ocr is
// true/unknown; it fails only when BOTH are explicitly false.
export function capabilityHardFilterReason(purpose: string, capability: ModelCapability | null | undefined): string | null {
  const required = requiredCapabilityFlags(purpose)
  if (!required.length) return null
  if (String(purpose || '').toUpperCase() === 'VISION') {
    const vision = capabilityFlagValue(capability, 'vision')
    const ocr = capabilityFlagValue(capability, 'ocr')
    if (vision === false && ocr === false) return 'CAPABILITY_MISSING:vision/ocr'
    return null
  }
  for (const flag of required) {
    if (capabilityFlagValue(capability, flag) === false) return `CAPABILITY_MISSING:${flag}`
  }
  return null
}

export function scoreModelForTask(input: ScoreModelInput): ScoredModel {
  const provider = String(input.provider || '').toUpperCase()
  const model = String(input.model || '')
  const purpose = String(input.purpose || 'CHAT').toUpperCase()
  const stats = input.stats || null
  const total = totalCalls(stats)
  const fails = stats ? { ...(stats.fail || {}) } : {}
  const failCount = Object.values(fails).reduce((sum, n) => sum + (Number(n) || 0), 0)
  const allTimeRate = total > 0 ? (Number(stats?.success) || 0) / total : 0.35
  const recentTotal = (Number(stats?.recentSuccess) || 0) + (Number(stats?.recentFail) || 0)
  const recentRate = recentTotal >= 3
    ? 0.7 * (Number(stats?.recentSuccess) / recentTotal) + 0.3 * allTimeRate
    : allTimeRate
  // Quality: validate + verifier + OCR-gate pass rates, per purpose.
  // When none of those signals exist yet, evidenceOk rate is the
  // fallback (it is set false only on VALIDATION_REJECTED); with no
  // signal at all the model is neutral (0.5), never assumed good.
  const qualitySignals: number[] = []
  // Explicit per-purpose rates win; otherwise the router's fail buckets
  // (VALIDATION_REJECTED / schemaFail / ocr_gate_failed, written by
  // recordModelStats on every attempt) derive the same rates, so a
  // model failing the OCR gate drops in VISION rank mid-run.
  if (Number(stats?.validateTotal) > 0) qualitySignals.push(rate(stats?.validateOk, stats?.validateTotal, 0.5))
  else if (total > 0) qualitySignals.push(1 - Math.min(1, ((Number(fails.VALIDATION_REJECTED) || 0) + (Number(fails.schemaFail) || 0)) / total))
  if (Number(stats?.verifierTotal) > 0) qualitySignals.push(rate(stats?.verifierOk, stats?.verifierTotal, 0.5))
  if (purpose === 'VISION') {
    if (Number(stats?.ocrGateTotal) > 0) qualitySignals.push(rate(stats?.ocrGateOk, stats?.ocrGateTotal, 0.5))
    else if (total > 0 && (Number(fails.ocr_gate_failed) || 0) > 0) qualitySignals.push(1 - (Number(fails.ocr_gate_failed) || 0) / total)
  }
  if (!qualitySignals.length && Number(stats?.evidenceTotal) > 0) qualitySignals.push(rate(stats?.evidenceOk, stats?.evidenceTotal, 0.5))
  const quality = qualitySignals.length
    ? qualitySignals.reduce((sum, v) => sum + v, 0) / qualitySignals.length
    : 0.5
  const jsonRate = rate(stats?.jsonOk, stats?.jsonTotal, 0.5)
  const validationRejectedRate = total > 0
    ? ((Number(fails.VALIDATION_REJECTED) || 0) + (Number(fails.schemaFail) || 0) + (Number(fails.ocr_gate_failed) || 0)) / total
    : 0
  const adherence = jsonRate * 0.6 + (1 - validationRejectedRate) * 0.4
  const avgMs = Number(stats?.avgMs) || Number(input.health?.latencyMs) || 0
  const latency = avgMs > 0 ? Math.max(0, 1 - avgMs / 60000) : 0.5
  const quota429 = Number(input.quotaState?.rate429Count) || 0
  const quota = input.quotaState?.noBalance ? 0 : Math.max(0, 1 - Math.min(0.9, quota429 / 10))
  const tier = input.costState?.costTier || 'unknown'
  const cost = tier === 'paid'
    ? (input.costState?.allowPaid ? 0.5 : 0)
    : tier === 'free' ? 1 : 0.8
  // VISION is latency-sensitive (plan risk 5): a slow OCR model can eat
  // the whole budget before the next model is tried, so latency weighs
  // more and quality less for VISION than for other purposes.
  const weights = purpose === 'VISION'
    ? { quality: 0.3, recentSuccess: 0.2, adherence: 0.15, latency: 0.2, quota: 0.1, cost: 0.05 }
    : { quality: 0.35, recentSuccess: 0.2, adherence: 0.15, latency: 0.15, quota: 0.1, cost: 0.05 }
  const components: ScoreComponents = {
    quality: Math.round(quality * 1000) / 1000,
    recentSuccess: Math.round(recentRate * 1000) / 1000,
    adherence: Math.round(adherence * 1000) / 1000,
    latency: Math.round(latency * 1000) / 1000,
    quota: Math.round(quota * 1000) / 1000,
    cost: Math.round(cost * 1000) / 1000,
  }
  const score = Math.round((quality * weights.quality + recentRate * weights.recentSuccess
    + adherence * weights.adherence + latency * weights.latency
    + quota * weights.quota + cost * weights.cost) * 1000) / 1000
  const base: ScoredModel = { provider, model, score, components, balance: 'unknown' }
  // Exclusions, in the order an admin reads them: safety first
  // (verifier exclusion), then capability, context, quota, paid, health.
  if ((input.excludeProviders || []).map((p) => String(p).toUpperCase()).includes(provider)) {
    return { ...base, score: 0, excludedReason: 'EXCLUDED_PROVIDER' }
  }
  const family = input.modelFamily?.(provider, model)
  if (family && (input.excludeModelFamilies || []).map((f) => String(f).toLowerCase()).includes(family.toLowerCase())) {
    return { ...base, score: 0, excludedReason: 'EXCLUDED_FAMILY' }
  }
  const capabilityReason = capabilityHardFilterReason(purpose, input.capability)
  if (capabilityReason) return { ...base, score: 0, excludedReason: capabilityReason }
  const contextLength = Number(input.capability?.contextLength)
  if (Number.isFinite(contextLength) && Number(input.contextNeededTokens) > 0 && contextLength < Number(input.contextNeededTokens)) {
    return { ...base, score: 0, excludedReason: 'CONTEXT_TOO_SMALL' }
  }
  const cooldownUntil = Number(input.quotaState?.cooldownUntilMs)
  if (Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) {
    return { ...base, score: 0, excludedReason: 'QUOTA_COOLDOWN' }
  }
  if (input.quotaState?.noBalance) return { ...base, score: 0, excludedReason: 'NO_BALANCE' }
  if (tier === 'paid' && !input.costState?.allowPaid) return { ...base, score: 0, excludedReason: 'PAID_BLOCKED' }
  if (tier === 'paid' && input.costState?.allowPaid && input.costState?.budgetOk === false) {
    return { ...base, score: 0, excludedReason: 'PAID_BUDGET_EXHAUSTED' }
  }
  if (input.health && !input.health.ok) {
    const status = Number(input.health.status || 0)
    const checkedAt = Date.parse(String(input.health.checkedAt || ''))
    const fresh = Number.isFinite(checkedAt) && Date.now() - checkedAt < 30 * 60 * 1000
    if (fresh && (status === 401 || status === 403 || status === 404)) {
      return { ...base, score: 0, excludedReason: 'HEALTH_SKIP' }
    }
  }
  return base
}

// Rank a candidate set for one purpose: scored models first (best
// score first, ties broken by provider then model for determinism),
// excluded models after, in input order, each carrying its reason.
// A model that ranks differently for VISION vs REVIEW vs CHAT given
// purpose stats is the expected behaviour — the stats input is
// per-purpose, so the same model legitimately scores differently.
export function rankModelsForTask(candidates: ScoreModelInput[]): ScoredModel[] {
  const scored = candidates.map((candidate) => scoreModelForTask(candidate))
  const qualified = scored.filter((m) => !m.excludedReason)
    .sort((a, b) => b.score - a.score || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
  const excluded = scored.filter((m) => m.excludedReason)
  return [...qualified, ...excluded]
}

// Persisted AI_AUTO_RANKING:<purpose> payload. The Setting key stays
// the runtime source of truth (the router reads it via settings());
// excluded models are persisted too, WITH their reason, so the
// dashboard can show why a model lost — but resolveAutoCandidates
// must never re-admit them (see the excludedReason guard there).
export function buildAutoRankingPayload(args: {
  purpose: string
  ranked: ScoredModel[]
  computedAtMs?: number
}): Record<string, unknown> {
  return {
    purpose: String(args.purpose || 'CHAT').toUpperCase(),
    computedAt: new Date(args.computedAtMs ?? Date.now()).toISOString(),
    balance: 'unknown',
    candidates: args.ranked.map((m) => ({
      provider: m.provider,
      model: m.model,
      score: m.score,
      components: m.components,
      ...(m.excludedReason ? { excludedReason: m.excludedReason } : {}),
    })),
  }
}

// ---------------------------------------------------------------------------
// Step 7h — voice / Live / TTS exclusion (by design, NOT auto-selected).
//
// Live models (gemini-*-live*) and TTS models are a different protocol
// (bidirectional audio session / speech synthesis). Auto mode may NEVER
// substitute a text model here, and a text ranking may never inject a
// live/TTS model into text routing either: filterVoiceModelsFromTextRanking
// drops them at the settings() seam in text-ai.ts. The dashboard (step 8)
// surfaces AUTO_VOICE_EXCLUSION_NOTE so an admin sees the exclusion.
// Live-model ranking *within* the live list is a separate, later step —
// only if Haris asks for it.
// ---------------------------------------------------------------------------

export const AUTO_VOICE_EXCLUSION_NOTE = 'voice: native protocol — not auto-selected'

// True for live-voice and TTS model ids. Matches the native chains in
// gemini.ts (SUPERVISOR_LIVE_MODELS / DISCUSSION_LIVE_MODELS / TTS_MODELS)
// by name shape, so a future live/TTS model id is excluded even before
// its list is updated here.
export function isVoiceNativeOnlyModel(model: string): boolean {
  const name = String(model || '').toLowerCase()
  return name.includes('live') || name.includes('tts') || name.includes('native-audio')
}

// Drop live/TTS models from a text ranking. A stored AI_AUTO_RANKING
// row that (wrongly) lists one can never put it on the text path.
export function filterVoiceModelsFromTextRanking(candidates: AutoCandidate[]): AutoCandidate[] {
  return (candidates || []).filter((c) => !isVoiceNativeOnlyModel(c.model))
}

// ---------------------------------------------------------------------------
// Step 7g — ASR selection WITHIN ASR only (never through the text router).
//
// Transcription backends are protocol-specific (Gemini Files API vs a
// Whisper-compatible /audio/transcriptions endpoint), so auto mode ranks
// backends, not text models. The stored order lives in AI_AUTO_RANKING:ASR
// (JSON: { backends: [{ backend: 'GEMINI'|'WHISPER', model?, score? }] }
// or a bare array); the refresh job (step 3/5 machinery) writes it from
// recent transcription success. Selection here only READS it.
// ---------------------------------------------------------------------------

export const AI_AUTO_RANKING_ASR_KEY = 'AI_AUTO_RANKING:ASR'

export type AsrBackendName = 'GEMINI' | 'WHISPER'

export interface AsrRankingEntry {
  backend: AsrBackendName
  model?: string
  score?: number
}

export const DEFAULT_ASR_BACKEND_ORDER: readonly AsrBackendName[] = ['GEMINI', 'WHISPER']

export function parseAsrRanking(raw: unknown): AsrRankingEntry[] {
  let rows: unknown = null
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw
    if (Array.isArray(value)) rows = value
    else if (value && typeof value === 'object') rows = (value as Record<string, unknown>).backends ?? null
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  const out: AsrRankingEntry[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const backend = String((row as Record<string, unknown>).backend || '').toUpperCase()
    if (backend !== 'GEMINI' && backend !== 'WHISPER') continue
    if (seen.has(backend)) continue
    seen.add(backend)
    const entry: AsrRankingEntry = { backend: backend as AsrBackendName }
    const model = (row as Record<string, unknown>).model
    if (typeof model === 'string' && model.trim()) entry.model = model.trim().slice(0, 180)
    const score = Number((row as Record<string, unknown>).score)
    if (Number.isFinite(score)) entry.score = score
    out.push(entry)
  }
  return out
}

// Order in which ASR backends are tried. OFF (or an empty ranking) =
// today's order: Gemini first, Whisper second. ON with a stored ranking
// = the stored order, restricted to backends that are actually available
// (a backend with no key configured is dropped, never attempted).
// A ranking that lists only one backend returns just that one.
export function resolveAsrBackendOrder(args: {
  autoMode: boolean
  ranking: AsrRankingEntry[]
  available: readonly AsrBackendName[]
}): AsrBackendName[] {
  const available = [...new Set(args.available || [])]
  if (!args.autoMode) return DEFAULT_ASR_BACKEND_ORDER.filter((b) => available.includes(b))
  const ranked = (args.ranking || [])
    .map((entry) => entry.backend)
    .filter((b) => available.includes(b))
  const ordered = [...new Set([...ranked, ...DEFAULT_ASR_BACKEND_ORDER])]
  return ordered.filter((b) => available.includes(b))
}

// Pure outcome update for the ASR ranking writer (refresh/dashboard):
// a success moves the backend to the front, a failure moves it to the
// back; scores are nudged, never invented. The writer persists the
// result to AI_AUTO_RANKING:ASR — this function never writes anything.
export function applyAsrOutcomeToRanking(
  ranking: AsrRankingEntry[],
  backend: AsrBackendName,
  ok: boolean,
): AsrRankingEntry[] {
  const entries = (ranking || []).map((e) => ({ ...e }))
  const idx = entries.findIndex((e) => e.backend === backend)
  const entry: AsrRankingEntry = idx >= 0
    ? entries.splice(idx, 1)[0]!
    : { backend }
  entry.score = Math.max(0, Math.min(1, Number(entry.score ?? 0.5) + (ok ? 0.1 : -0.2)))
  return ok ? [entry, ...entries] : [...entries, entry]
}

// ---------------------------------------------------------------------------
// Step 7f — platform-agent attempt order (pure decision, tested directly
// and used by platformPublicAgentComplete / platformAgentComplete).
//
// OFF: today's order — GEMINI_DIRECT first (WhatsApp always; web when
// shouldPreferGemini), then the configured local open-source path, then
// the router (via chatComplete). ON: GEMINI_DIRECT is skipped entirely —
// the router call (with the auto ranking, taskType WHATSAPP/CHAT) is the
// model path; the local open-source path stays exactly as configured
// (AI_AGENT_*), because it is a separate local path, not a router model.
// Human-handoff intents are decided before any model attempt and are
// untouched by this ordering.
// ---------------------------------------------------------------------------

export type PlatformAgentAttemptKind = 'GEMINI_DIRECT' | 'LOCAL_OPEN_SOURCE' | 'ROUTER'

export function resolvePlatformAgentAttemptOrder(args: {
  autoMode: boolean
  channel: string
  shouldPreferGemini: boolean
  useAdminRouterPolicy?: boolean
  localEnabled: boolean
}): PlatformAgentAttemptKind[] {
  const order: PlatformAgentAttemptKind[] = []
  const isWhatsApp = String(args.channel || '').toUpperCase() === 'WHATSAPP'
  if (!args.autoMode) {
    if (isWhatsApp || args.shouldPreferGemini) order.push('GEMINI_DIRECT')
    if (args.localEnabled) order.push('LOCAL_OPEN_SOURCE')
    if (!isWhatsApp && !args.shouldPreferGemini && !args.useAdminRouterPolicy) order.push('GEMINI_DIRECT')
    order.push('ROUTER')
    return [...new Set(order)]
  }
  // Auto ON: no GEMINI_DIRECT anywhere — the router (auto ranking) is
  // the only provider path. Local stays as configured.
  if (args.localEnabled) order.push('LOCAL_OPEN_SOURCE')
  order.push('ROUTER')
  return order
}

export function isAutoRankingStale(payload: unknown, refreshIntervalMinutes: number, nowMs = Date.now()): boolean {
  try {
    const value = typeof payload === 'string' ? JSON.parse(payload || 'null') : payload
    const at = Date.parse(String((value as Record<string, unknown>)?.computedAt || ''))
    if (!Number.isFinite(at)) return true
    return nowMs - at > Math.max(1, Math.floor(refreshIntervalMinutes) || 60) * 60 * 1000
  } catch {
    return true
  }
}

// OCR model selection (step 6a): from the VISION ranking, in rank
// order, the first candidate whose catalog capability does not rule
// out OCR. The ranking itself was computed with the capability hard
// filter, so a candidate with no catalog row still qualifies (unknown
// is not proof of absence); a candidate whose row says ocr:false AND
// vision:false does not. Returns null when the ranking is empty —
// the caller then falls back to today's global order.
export function pickOcrModel(args: {
  ranking: AutoCandidate[]
  capabilityOf?: (provider: string, model: string) => ModelCapability | null | undefined
}): { provider: string; model: string } | null {
  for (const candidate of args.ranking || []) {
    const capability = args.capabilityOf?.(candidate.provider, candidate.model)
    // OCR picking is stricter than the general VISION filter (which
    // accepts vision OR ocr): a model whose catalog — or run-result
    // feedback — says ocr:false must not read pages, even if it still
    // has vision:true for other vision tasks.
    if (capability && capability.ocr === false) continue
    if (capabilityHardFilterReason('VISION', capability)) continue
    return { provider: String(candidate.provider).toUpperCase(), model: candidate.model }
  }
  return null
}

// OCR-gate failure as a run-result feedback event (step 6b): a model
// that fails the OCR quality gate loses its ocr flag for VISION after
// N failures (see applyRunResultFeedback). The book reader calls this
// when transcribeOnce's validate throws OCR_TEXT_FAILED_VERIFICATION /
// OCR_ALL_PAGES_EMPTY, so the model drops in VISION rank mid-run.
export function ocrGateFailureFeedbackEvent(provider: string, model: string): RunResultEvent {
  return { provider: String(provider || '').toUpperCase(), model, purpose: 'VISION', outcome: 'OCR_GATE_FAILED' }
}

// ---------------------------------------------------------------------------
// Step 5 — smart failover (pure classifier + provider-down tracking).
//
// Cooldown levels: MODEL (transient/timeout/quality), KEY (auth /
// explicit key-balance exhaustion), PROVIDER (quota storm /
// provider-down). Two buckets are new here:
// - PROVIDER_DOWN: repeated 5xx / network errors / DNS failures across
//   models of ONE provider → provider-level cooldown, NOT per-model
//   hammering. One 5xx is not enough: recordProviderDownHit() needs
//   3 hits in 60s across >= 2 distinct models before the provider is
//   declared down.
// - OUTPUT_QUALITY: VALIDATION_REJECTED / OCR-gate failure / empty
//   output → skip the model for this purpose, do NOT cool the key.
//   A model that returns garbage is not evidence about its key.
// NEVER hammer: a quota-exhausted provider is excluded from ranking
// until its cooldown expires AND at least one successful probe
// (failoverProviderGate); the router's keyRateAllowed stays the hard
// stop underneath all of this.
// ---------------------------------------------------------------------------

export type AutoFailureKind =
  | 'QUOTA_EXHAUSTED' | 'DEAD_KEY' | 'PROVIDER_DOWN' | 'UNSUPPORTED_CAPABILITY'
  | 'TIMEOUT' | 'OUTPUT_QUALITY' | 'AUTH' | 'NO_BALANCE' | 'SCHEMA'

export type AutoCooldownScope = 'MODEL' | 'KEY' | 'PROVIDER' | 'NONE'

export interface AutoFailureClassification {
  failureKind: AutoFailureKind
  cooldownScope: AutoCooldownScope
  errorCode: string
  // True when only this model should be skipped for this purpose (no
  // key/provider cooldown is warranted).
  skipModelOnly: boolean
}

const NETWORK_ERROR_RE = /fetch failed|network|econnrefused|econnreset|enotfound|eai_again|socket hang up|dns|econnaborted/i

export function isProviderDownLike(error: unknown, status?: number): boolean {
  const msg = String((error as { message?: unknown })?.message || error || '')
  const code = Number(status || (error as { status?: unknown })?.status || 0)
  if (code === 500 || code === 502) return true
  if (code === 504) return false // 504 is a timeout, handled as TIMEOUT.
  if (code >= 500 && code <= 599) return false // 503 is high-demand, not down.
  return NETWORK_ERROR_RE.test(msg)
}

export function classifyAutoFailure(error: unknown, status?: number): AutoFailureClassification {
  const raw = error as { message?: unknown; code?: unknown; status?: unknown } | null
  const msg = String(raw?.message || error || '')
  const lower = msg.toLowerCase()
  const code = String(raw?.code || '').toUpperCase()
  const httpStatus = Number(status ?? raw?.status ?? 0) || undefined
  // Run-deadline errors are TIMEOUT with the distinct run-timeout code,
  // never "all models exhausted": background jobs treat them as
  // pausable/resumable (retryAt preserved), not FAILED.
  if (code === 'TEXT_AI_RUN_TIMEOUT' || code === 'AI_DEADLINE_EXCEEDED' || /ai_deadline_exceeded|text_ai_run_timeout/.test(lower)) {
    return { failureKind: 'TIMEOUT', cooldownScope: 'NONE', errorCode: TEXT_AI_RUN_TIMEOUT, skipModelOnly: false }
  }
  if (code === 'VALIDATION_REJECTED' || /ocr_text_failed_verification|ocr_all_pages_empty/.test(lower)) {
    return { failureKind: 'OUTPUT_QUALITY', cooldownScope: 'MODEL', errorCode: 'OUTPUT_QUALITY', skipModelOnly: true }
  }
  if (/ocr_returned_no_text|empty_batch_after_structural_validation/.test(lower) && code === 'VALIDATION_REJECTED') {
    return { failureKind: 'OUTPUT_QUALITY', cooldownScope: 'MODEL', errorCode: 'OUTPUT_QUALITY', skipModelOnly: true }
  }
  if (httpStatus === 429 || /quota|rate.?limit|resource exhausted|too many requests|insufficient_quota/i.test(lower)) {
    const keyScope = /account|api[_ -]?key|\bkey\b|per day/i.test(lower) && !/per model|model:/i.test(lower)
    return { failureKind: 'QUOTA_EXHAUSTED', cooldownScope: keyScope ? 'KEY' : 'MODEL', errorCode: 'QUOTA_EXHAUSTED', skipModelOnly: false }
  }
  if (httpStatus === 402 || /no balance|no_balance|insufficient (credits|balance)|payment required/.test(lower)) {
    const keyScope = /(account|key).*(balance|credits)|balance.*(account|key)|recharge|top.?up/i.test(lower)
    return { failureKind: 'NO_BALANCE', cooldownScope: keyScope ? 'KEY' : 'MODEL', errorCode: 'NO_BALANCE', skipModelOnly: false }
  }
  if (httpStatus === 401 || httpStatus === 403 || /unauthorized|forbidden|invalid (api )?key|authentication/i.test(lower)) {
    return { failureKind: 'AUTH', cooldownScope: 'KEY', errorCode: 'AUTH', skipModelOnly: false }
  }
  if (httpStatus === 404 && /does not exist|not found|no longer available|model.*not/i.test(lower)) {
    return { failureKind: 'UNSUPPORTED_CAPABILITY', cooldownScope: 'MODEL', errorCode: 'UNSUPPORTED_CAPABILITY', skipModelOnly: true }
  }
  if (isProviderDownLike(error, httpStatus)) {
    return { failureKind: 'PROVIDER_DOWN', cooldownScope: 'PROVIDER', errorCode: 'PROVIDER_DOWN', skipModelOnly: false }
  }
  if (httpStatus === 504 || /timeout|timed out|abort|etimedout|ai_provider_timeout/i.test(lower)) {
    return { failureKind: 'TIMEOUT', cooldownScope: 'MODEL', errorCode: 'AI_PROVIDER_TIMEOUT', skipModelOnly: false }
  }
  if (code === 'INVALID_JSON_RESPONSE' || code === 'SCHEMA_VALIDATION_FAILED' || /invalid_json|schema|zod/i.test(lower)) {
    return { failureKind: 'SCHEMA', cooldownScope: 'MODEL', errorCode: 'SCHEMA', skipModelOnly: true }
  }
  if (/dead key|key.*(revoked|disabled|expired)/i.test(lower)) {
    return { failureKind: 'DEAD_KEY', cooldownScope: 'KEY', errorCode: 'DEAD_KEY', skipModelOnly: false }
  }
  return { failureKind: 'TIMEOUT', cooldownScope: 'MODEL', errorCode: 'UNKNOWN', skipModelOnly: false }
}

export interface ProviderDownState {
  hits: Record<string, { at: number[]; models: string[] }>
}

export const PROVIDER_DOWN_HIT_THRESHOLD = 3
export const PROVIDER_DOWN_WINDOW_MS = 60_000

export function emptyProviderDownState(): ProviderDownState {
  return { hits: {} }
}

// Record one provider-down-like hit (5xx/network/DNS). Returns
// providerDown:true only when the threshold is met inside the window
// across >= 2 distinct models — a single bad model must never cool
// its healthy siblings. The caller applies the provider cooldown;
// this function only counts.
export function recordProviderDownHit(
  state: ProviderDownState,
  provider: string,
  model: string,
  nowMs = Date.now(),
  threshold: number = PROVIDER_DOWN_HIT_THRESHOLD,
  windowMs: number = PROVIDER_DOWN_WINDOW_MS,
): { state: ProviderDownState; providerDown: boolean; hitsInWindow: number; distinctModels: number } {
  const key = String(provider || '').toUpperCase()
  const previous = state.hits[key] || { at: [], models: [] }
  const at = [...previous.at.filter((t) => nowMs - t <= windowMs), nowMs]
  const models = [...new Set([...previous.models, String(model || '')])].filter(Boolean)
  const next: ProviderDownState = { hits: { ...state.hits, [key]: { at, models } } }
  const providerDown = at.length >= Math.max(1, threshold) && models.length >= 2
  return { state: next, providerDown, hitsInWindow: at.length, distinctModels: models.length }
}

// Post-cooldown re-admission gate: a quota-exhausted / provider-down
// provider stays excluded until its cooldown has expired AND at least
// one successful probe ran after the cooldown ended. A probe that ran
// BEFORE the cooldown ended does not count.
export function failoverProviderGate(args: {
  cooldownUntilMs?: number | null
  lastProbeOkAtMs?: number | null
  nowMs?: number
}): { excluded: boolean; reason?: string; needsProbe: boolean } {
  const nowMs = args.nowMs ?? Date.now()
  const cooldownUntil = Number(args.cooldownUntilMs)
  if (Number.isFinite(cooldownUntil) && cooldownUntil > nowMs) {
    return { excluded: true, reason: 'QUOTA_COOLDOWN', needsProbe: false }
  }
  if (Number.isFinite(cooldownUntil) && cooldownUntil > 0) {
    const probeAt = Number(args.lastProbeOkAtMs)
    if (!Number.isFinite(probeAt) || probeAt < cooldownUntil) {
      return { excluded: true, reason: 'PROBE_REQUIRED', needsProbe: true }
    }
  }
  return { excluded: false, needsProbe: false }
}

// ---------------------------------------------------------------------------
// Step 5 — sticky-model conflict (plan risk 3), DECIDED HERE:
// When auto is ON with a non-empty ranking, the sticky-model pin
// (AI_STICKY_ON_SUCCESS) is a HINT, not a pin: the sticky model goes
// first ONLY when it is already the top auto-ranked candidate for the
// purpose. Otherwise the auto ranking order wins and the sticky model
// stays in its ranked position — auto keeps adapting instead of
// freezing on the last good model. When auto is OFF (or ON with an
// empty ranking, where the router falls back to manual behaviour),
// today's sticky behaviour applies unchanged: sticky first.
// ---------------------------------------------------------------------------

export type StickyOrderDecision = 'sticky-first' | 'ranked'

export function stickyOrderUnderAuto(args: {
  autoMode: boolean
  autoOverride: boolean
  autoTop?: AutoCandidate | null
  sticky?: { provider: string; model: string } | null
}): StickyOrderDecision {
  if (!args.autoMode || !args.autoOverride) return 'sticky-first'
  if (!args.sticky) return 'ranked'
  const top = args.autoTop
  if (top && String(top.provider).toUpperCase() === String(args.sticky.provider).toUpperCase()
    && String(top.model).toLowerCase() === String(args.sticky.model).toLowerCase()) {
    return 'sticky-first'
  }
  return 'ranked'
}

// ---------------------------------------------------------------------------
// Step 6 — OCR attempt budget (plan risk 5): the per-attempt deadline
// must leave room for >= 2 attempts. Given the total OCR budget for a
// call, each attempt gets at most half (min 15s, max 90s); the caller
// keeps the remainder for the next model. A slow model can therefore
// never consume the whole budget before failover gets its chance.
// ---------------------------------------------------------------------------

export function splitOcrBudget(totalBudgetMs: number, attempts = 2): { perAttemptMs: number; attempts: number } {
  const total = Math.max(0, Math.floor(Number(totalBudgetMs) || 0))
  const count = Math.max(1, Math.floor(attempts) || 2)
  const perAttemptMs = Math.min(90_000, Math.max(15_000, Math.floor(total / count)))
  return { perAttemptMs, attempts: count }
}

// A run timeout is pausable/resumable, never "all models exhausted".
// Both classifiers already match TIMEOUT/DEADLINE substrings; the
// explicit TEXT_AI_RUN_TIMEOUT term below is the contract, so a
// future rename of the message cannot silently turn a pausable
// timeout into a FAILED job.
export function isRunTimeoutError(message: unknown): boolean {
  return /text_ai_run_timeout|ai_deadline_exceeded/.test(String(message || '').toLowerCase())
}
