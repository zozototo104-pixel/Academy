import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { decryptSecret, isEncryptedSecret, isSecretKeyName, keyHashForRateLimit, redactSecrets } from '@/lib/secret-crypto'

export type TextAiProvider =
  | 'GEMINI'
  | 'OPENAI'
  | 'ANTHROPIC'
  | 'ZAI'
  | 'GROQ'
  | 'OPENROUTER'
  | 'DEEPINFRA'
  | 'TOGETHER'
  | 'UNOROUTER'
  | 'RELAYROUTER'
  | 'TOPTOOLS'
  | 'OPENAI_COMPAT'
  | 'AUTO'

export type TextAiRouterPolicy = 'primary_first' | 'balanced' | 'quality_first' | 'cost_saver' | 'fallback_only'
export type TextAiTaskLevel = 'GENERAL' | 'ACADEMIC_DRAFT' | 'ACADEMIC_CRITICAL'
export type TextAiProviderTier = 'FREE' | 'PAID'
export type TextAiPaidUsageMode = 'off' | 'last_resort' | 'critical_first'
export type TextAiPurpose = 'CHAT' | 'ANALYSIS' | 'GENERATION' | 'GRADING' | 'VISION' | 'LONG_CONTEXT' | 'REVIEW'

export interface TextAiTurn {
  role: 'user' | 'model'
  text: string
}

export interface TextAiCallOpts {
  system: string
  history: TextAiTurn[]
  temperature?: number
  maxOutputTokens?: number
  json?: boolean
  routerPolicy?: TextAiRouterPolicy
  taskLevel?: TextAiTaskLevel
  purpose?: TextAiPurpose
  excludeProviders?: TextAiProvider[]
  excludeModelFamilies?: string[]
  deadlineMs?: number
  stickyScope?: string
  validate?: (text: string, context?: { provider: string; model: string }) => void
}

export interface TextAiCompletionResult {
  text: string
  provider: Exclude<TextAiProvider, 'AUTO'>
  model: string
}

export interface TextAiAttemptDiagnostics {
  provider: string
  model: string
  keyIndex: number
  ok: boolean
  ms: number
  status?: number
  error?: string
  at: string
}

export interface TextAiDiagnostics {
  selectedProvider: TextAiProvider
  activeProvider: Exclude<TextAiProvider, 'AUTO'> | null
  policy: TextAiRouterPolicy
  externalConfigured: boolean
  geminiConfigured: boolean
  openaiConfigured: boolean
  anthropicConfigured: boolean
  zaiConfigured: boolean
  groqConfigured: boolean
  openrouterConfigured: boolean
  deepinfraConfigured: boolean
  togetherConfigured: boolean
  unorouterConfigured: boolean
  relayrouterConfigured: boolean
  topToolsConfigured: boolean
  openaiCompatConfigured: boolean
  geminiModel: string
  openaiModel: string
  anthropicModel: string
  zaiModel: string
  groqModel: string
  openrouterModel: string
  deepinfraModel: string
  togetherModel: string
  unorouterModel: string
  relayrouterModel: string
  topToolsModel: string
  openaiCompatModel: string
  keyCounts: Record<string, number>
  cooldowns: Array<{ provider: string; key: string; until: string; reason: string }>
  lastResult: { provider: string; model: string; ok: boolean; error?: string; at: string } | null
  recentAttempts: TextAiAttemptDiagnostics[]
  message: string
}

const OPENAI_TEXT_MODELS = ['gpt-5.1', 'gpt-5', 'gpt-5-mini']
const ANTHROPIC_TEXT_MODELS = ['claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022']
const ZAI_TEXT_MODELS = ['glm-4.5', 'glm-4.5-air', 'glm-4.5-x', 'glm-4.5-airx']
const GEMINI_TEXT_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash']
const GROQ_TEXT_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']
const OPENROUTER_TEXT_MODELS = ['openrouter/auto', 'meta-llama/llama-3.1-8b-instruct:free']
const DEEPINFRA_TEXT_MODELS = ['meta-llama/Llama-3.3-70B-Instruct', 'meta-llama/Meta-Llama-3.1-8B-Instruct']
const TOGETHER_TEXT_MODELS = ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo']
const UNOROUTER_TEXT_MODELS = [
  'gpt-5.6-sol:free',
  'gpt-5.4:free',
  'gpt-5.2:free',
  'gpt-oss-120b:free',
  'gpt-oss-120b-turbo:free',
  'gpt-oss-20b:free',
  'gpt-oss-20b-turbo:free',
  'glm-5.3-search:free',
  'glm-5.3-flash-search:free',
  'glm-5.3-flash-think-search:free',
  'glm-5.1-thinking:free',
  'glm-5.1:free',
  'gemini-3.8-flash-free:free',
  'gemini-3.7-flash-free:free',
  'nemotron-3-super-120b-a12b:free',
  'llama-4-maverick-17b-128e-instruct:free',
  'llama-4-scout:free',
  'llama-3.1-8b:free',
  'minimax-m2.5:free',
  'deepseek/deepseek-v3.2:free',
  'deepseek/deepseek-chat:free',
  'gpt-3.5-turbo:free',
  'gpt-4-turbo:free',
  'agnes-2.0-flash:free',
  'agnes-1.5-flash:free',
  'allam-2-7b:free',
  'bielik-11b-v3.0-instruct:free',
  'muse-glimmer-30b:free',
  'ox-alpha:free',
  'ling-3.0-flash-fin:free',
]
const RELAYROUTER_TEXT_MODELS = ['relayrouter/auto', 'claude-opus-4-8', 'gpt-5.5', 'gemini-3.5-flash']
const TOPTOOLS_TEXT_MODELS = ['top-tools-ai']
const OPENAI_COMPAT_TEXT_MODELS = ['auto']

const cooldowns = new Map<string, { until: number; reason: string; status?: number; model?: string }>()
let roundRobin = 0
let lastResult: TextAiDiagnostics['lastResult'] = null
let recentAttempts: TextAiAttemptDiagnostics[] = []
type ModelCapability = { contextLength?: number; vision?: boolean; modalities?: string[]; supportedParameters?: string[] }
const freeModelsCache = new Map<string, { at: number; models: string[]; capabilities?: Record<string, ModelCapability> }>()

type TextAiSettingStore = {
  read(keys: string[]): Promise<Record<string, string>>
  write(key: string, value: string): Promise<void>
  delete?(key: string): Promise<void>
  increment?(key: string, amount: number): Promise<number>
  scan?(prefix: string): Promise<Record<string, string>>
}

let injectedStore: TextAiSettingStore | null = null
let persistentCooldownCache: { at: number; values: Record<string, string> } | null = null
let routerRequestSeq = 0
const stickyModels = new Map<string, { provider: ConcreteProvider; model: string; at: number }>()

function hasDatabaseUrl(): boolean {
  return !!String(process.env.DATABASE_URL || '').trim()
}

function defaultSettingStore(): TextAiSettingStore {
  return {
    async read(keys) {
      if (!hasDatabaseUrl()) return Object.fromEntries(keys.map((k) => [k, '']))
      const rows = await db.setting.findMany({ where: { key: { in: keys } } })
      const out: Record<string, string> = Object.fromEntries(keys.map((k) => [k, '']))
      for (const row of rows) out[row.key] = String(row.value || '')
      return out
    },
    async write(key, value) {
      if (!hasDatabaseUrl()) return
      await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } })
    },
    async delete(key) {
      if (!hasDatabaseUrl()) return
      await db.setting.delete({ where: { key } }).catch(() => {})
    },
    async increment(key, amount) {
      if (!hasDatabaseUrl()) throw new Error('AI_SETTING_STORE_UNAVAILABLE')
      await db.$executeRaw`
        INSERT INTO "Setting" ("key", "value", "updatedAt")
        VALUES (${key}, ${String(amount)}, NOW())
        ON CONFLICT ("key") DO UPDATE
        SET "value" = ((COALESCE(NULLIF("Setting"."value", ''), '0'))::numeric + ${amount})::text,
            "updatedAt" = NOW()
      `
      const row = await db.setting.findUnique({ where: { key } })
      return Number(row?.value || 0) || 0
    },
    async scan(prefix) {
      if (!hasDatabaseUrl()) return {}
      const rows = await db.setting.findMany({ where: { key: { startsWith: prefix } }, take: 300 })
      return Object.fromEntries(rows.map((row) => [row.key, String(row.value || '')]))
    },
  }
}

function settingStore(): TextAiSettingStore {
  return injectedStore || defaultSettingStore()
}

export function __setTextAiSettingStoreForTests(store: TextAiSettingStore | null) {
  injectedStore = store
  persistentCooldownCache = null
}

export function __resetTextAiStateForTests() {
  cooldowns.clear()
  roundRobin = 0
  lastResult = null
  recentAttempts = []
  freeModelsCache.clear()
  persistentCooldownCache = null
  routerRequestSeq = 0
  stickyModels.clear()
}

function env(name: string): string {
  try {
    return process.env[name]?.trim() || ''
  } catch {
    return ''
  }
}

function clean(value: unknown): string {
  return String(value || '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[?&#].*$/, '')
    .trim()
}

function normalizeProvider(value: unknown): TextAiProvider {
  const v = clean(value).toUpperCase()
  const allowed: TextAiProvider[] = ['GEMINI', 'OPENAI', 'ANTHROPIC', 'ZAI', 'GROQ', 'OPENROUTER', 'DEEPINFRA', 'TOGETHER', 'UNOROUTER', 'RELAYROUTER', 'TOPTOOLS', 'OPENAI_COMPAT', 'AUTO']
  return allowed.includes(v as TextAiProvider) ? (v as TextAiProvider) : 'GEMINI'
}

function normalizePolicy(value: unknown): TextAiRouterPolicy {
  const v = clean(value).toLowerCase()
  if (v === 'balanced' || v === 'quality_first' || v === 'cost_saver' || v === 'fallback_only') return v
  return 'primary_first'
}

function normalizeModel(value: unknown, defaults: string[]): string {
  const v = clean(value)
  if (!v || v === 'auto') return defaults[0]
  if (defaults.includes(v)) return v
  return /^[a-z0-9][a-z0-9_./:-]{1,160}$/i.test(v) ? v : defaults[0]
}

const DEFAULT_ACADEMIC_ALLOWLIST = 'GEMINI:gemini-3.5-flash,GEMINI:gemini-3.8-flash'

export function parseAcademicAllowlist(value: unknown): Array<{ provider: ConcreteProvider; model: string }> {
  const out: Array<{ provider: ConcreteProvider; model: string }> = []
  for (const raw of String(value || DEFAULT_ACADEMIC_ALLOWLIST).split(',')) {
    const item = raw.trim()
    const separator = item.indexOf(':')
    if (separator <= 0) {
      if (item) console.warn('[text-ai-router] ignoring invalid academic allowlist item', { item, reason: 'MISSING_PROVIDER_SEPARATOR' })
      continue
    }
    const providerText = clean(item.slice(0, separator)).toUpperCase()
    const provider = normalizeProvider(providerText)
    const model = clean(item.slice(separator + 1))
    if (!providerText || provider === 'AUTO' || provider !== providerText || !model) {
      console.warn('[text-ai-router] ignoring invalid academic allowlist item', { item, reason: 'INVALID_PROVIDER_OR_MODEL' })
      continue
    }
    if (!validModelName(model) || /(^|[\/:.-])auto($|[\/:.-])/i.test(model)) {
      console.warn('[text-ai-router] ignoring invalid academic allowlist item', { item, reason: 'INVALID_MODEL_NAME' })
      continue
    }
    out.push({ provider: provider as ConcreteProvider, model })
  }
  return out
}

function parseKeys(...values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    for (const raw of String(value || '').split(/[\n,]+/)) {
      const key = raw.trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

function keyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 10)
}

function cooldownId(provider: string, key: string): string {
  return `${provider}:${keyHash(key)}`
}

function persistentCooldownKey(provider: string, keyIndex: number, model?: string): string {
  return `AI_COOLDOWN:${provider}:${keyIndex}${model ? `:${model}` : ''}`
}

function modelDeadKey(provider: string, model: string): string {
  return `AI_MODEL_DEAD:${provider}:${model}`
}

function noBalanceKey(provider: string, keyIndex: number): string {
  return `AI_NO_BALANCE:${provider}:${keyIndex}`
}

function routerStatePayload(daysOrMs: number, reason: string, status?: number): string {
  const ms = daysOrMs > 1000 ? daysOrMs : daysOrMs * 24 * 60 * 60 * 1000
  return JSON.stringify({ until: new Date(Date.now() + ms).toISOString(), reason: reason.slice(0, 180), status: status || null })
}

function parseCooldown(value: unknown): { until: number; reason: string; status?: number } | null {
  try {
    const parsed = JSON.parse(String(value || '{}'))
    const until = Date.parse(String(parsed.until || '')) || Number(parsed.until || 0)
    if (!Number.isFinite(until) || until <= Date.now()) return null
    return { until, reason: String(parsed.reason || 'cooldown').slice(0, 180), status: Number(parsed.status || 0) || undefined }
  } catch {
    return null
  }
}

async function loadPersistentCooldowns(): Promise<Record<string, string>> {
  if (persistentCooldownCache && Date.now() - persistentCooldownCache.at < 30_000) return persistentCooldownCache.values
  try {
    const store = settingStore()
    const values = {
      ...(await store.scan?.('AI_COOLDOWN:') || {}),
      ...(await store.scan?.('AI_MODEL_DEAD:') || {}),
      ...(await store.scan?.('AI_NO_BALANCE:') || {}),
    }
    persistentCooldownCache = { at: Date.now(), values }
    for (const [key, value] of Object.entries(values)) {
      if (!parseCooldown(value)) settingStore().delete?.(key).catch(() => {})
    }
    return values
  } catch {
    return {}
  }
}

function persistentCooldown(values: Record<string, string>, provider: string, keyIndex: number, model: string): { until: number; reason: string; status?: number } | null {
  return parseCooldown(values[persistentCooldownKey(provider, keyIndex, model)]) || parseCooldown(values[persistentCooldownKey(provider, keyIndex)])
}

function isPersistentCooling(values: Record<string, string>, provider: string, keyIndex: number, model: string): boolean {
  return !!persistentCooldown(values, provider, keyIndex, model)
}

function isPersistentModelDead(values: Record<string, string>, provider: string, model: string): boolean {
  return !!parseCooldown(values[modelDeadKey(provider, model)])
}

function isPersistentNoBalance(values: Record<string, string>, provider: string, keyIndex: number): boolean {
  return !!parseCooldown(values[noBalanceKey(provider, keyIndex)])
}

async function markPersistentModelDead(provider: string, model: string, reason: string, status?: number): Promise<void> {
  try {
    await settingStore().write(modelDeadKey(provider, model), routerStatePayload(7, reason, status))
    persistentCooldownCache = null
  } catch {
    // Persistent dead-model state is best-effort.
  }
}

async function markPersistentNoBalance(provider: string, keyIndex: number, reason: string, status?: number): Promise<void> {
  try {
    await settingStore().write(noBalanceKey(provider, keyIndex), routerStatePayload(24 * 60 * 60 * 1000, reason, status))
    persistentCooldownCache = null
  } catch {
    // Persistent no-balance state is best-effort.
  }
}

async function markPersistentCooldown(provider: string, keyIndex: number, model: string, reason: string, status?: number, minutes?: number): Promise<void> {
  const fallback = Number(env('AI_ROUTER_COOLDOWN_MINUTES')) || 15
  const ttl = Math.max(1, Math.floor(minutes || fallback))
  const until = Date.now() + ttl * 60 * 1000
  const payload = JSON.stringify({ until: new Date(until).toISOString(), reason: reason.slice(0, 180), status: status || null })
  try {
    await settingStore().write(persistentCooldownKey(provider, keyIndex, model), payload)
    persistentCooldownCache = null
  } catch {
    // Persistent cooldown storage is best-effort; keep in-memory routing behavior if DB/storage fails.
  }
}

function isCooling(provider: string, key: string): boolean {
  const item = cooldowns.get(cooldownId(provider, key))
  if (!item) return false
  if (item.until <= Date.now()) {
    cooldowns.delete(cooldownId(provider, key))
    return false
  }
  return true
}

function markCooldown(provider: string, key: string, reason: string, minutes?: number) {
  const fallback = Number(env('AI_ROUTER_COOLDOWN_MINUTES')) || 15
  const ttl = Math.max(1, Math.floor(minutes || fallback))
  cooldowns.set(cooldownId(provider, key), { until: Date.now() + ttl * 60 * 1000, reason: reason.slice(0, 180) })
}

function aiProviderTimeoutMs(taskLevel: TextAiTaskLevel = 'GENERAL'): number {
  const defaults: Record<TextAiTaskLevel, number> = { GENERAL: 20_000, ACADEMIC_DRAFT: 40_000, ACADEMIC_CRITICAL: 55_000 }
  const configured = Number(env('AI_PROVIDER_TIMEOUT_MS'))
  const base = Number.isFinite(configured) && configured >= 3000 ? Math.floor(configured) : defaults[taskLevel]
  return Math.min(base, defaults[taskLevel])
}

function aiDiscoveryTimeoutMs(): number {
  const configured = Number(env('AI_DISCOVERY_TIMEOUT_MS'))
  if (Number.isFinite(configured) && configured >= 1500) return Math.min(Math.floor(configured), 15000)
  return 5000
}

function deadlineExceeded(): Error {
  const err: any = new Error('AI_DEADLINE_EXCEEDED')
  err.code = 'AI_DEADLINE_EXCEEDED'
  err.status = 504
  return err
}

function remainingTimeoutMs(deadlineMs?: number, defaultTimeoutMs = aiProviderTimeoutMs()): number {
  if (!Number.isFinite(deadlineMs || NaN)) return defaultTimeoutMs
  const remaining = Math.floor(Number(deadlineMs) - Date.now())
  if (remaining <= 0) throw deadlineExceeded()
  return Math.max(1, Math.min(defaultTimeoutMs, remaining))
}

async function fetchWithTimeout(provider: string, url: string, init: RequestInit = {}, timeoutMs = aiProviderTimeoutMs(), deadlineMs?: number): Promise<Response> {
  const effectiveTimeoutMs = remainingTimeoutMs(deadlineMs, timeoutMs)
  let timer: ReturnType<typeof setTimeout> | null = null
  const fallbackController = new AbortController()
  const signal = typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(effectiveTimeoutMs)
    : fallbackController.signal
  if (signal === fallbackController.signal) timer = setTimeout(() => fallbackController.abort(), effectiveTimeoutMs)
  try {
    return await fetch(url, { ...init, signal })
  } catch (e: any) {
    if (e?.name === 'AbortError' || e?.name === 'TimeoutError' || signal.aborted) {
      const err: any = new Error(`${provider}_PROVIDER_TIMEOUT_${effectiveTimeoutMs}ms`)
      err.status = 504
      err.code = 'AI_PROVIDER_TIMEOUT'
      throw err
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function isTimeoutLike(e: any): boolean {
  const msg = String(e?.message || e || '').toLowerCase()
  const status = Number(e?.status || e?.code || 0)
  return status === 504 || /timeout|timed out|abort|deadline|etimedout|ai_provider_timeout/i.test(msg)
}

function isDeadModelLike(e: any): boolean {
  const msg = String(e?.message || e || '').toLowerCase()
  const status = Number(e?.status || e?.code || 0)
  return status === 404 && /no longer available|does not exist|not found/i.test(msg)
}

function isNoBalanceLike(e: any): boolean {
  const msg = String(e?.message || e || '').toLowerCase()
  const status = Number(e?.status || e?.code || 0)
  return status === 402 || /balance|recharge|top.?up|top up|insufficient credits|payment required|no credits|credit balance/i.test(msg)
}

function isHighDemandLike(e: any): boolean {
  const msg = String(e?.message || e || '').toLowerCase()
  const status = Number(e?.status || e?.code || 0)
  return status === 503 || /high demand|overloaded|temporarily unavailable|server busy|try again later|capacity/i.test(msg)
}

function isQuotaLike(e: any): boolean {
  const msg = String(e?.message || e || '').toLowerCase()
  const status = Number(e?.status || e?.code || 0)
  return status === 429 || /quota|rate.?limit|resource exhausted|too many requests|insufficient_quota|insufficient balance|no resource package/i.test(msg)
}

function isAuthLike(e: any): boolean {
  const msg = String(e?.message || e || '').toLowerCase()
  const status = Number(e?.status || e?.code || 0)
  return status === 401 || status === 403 || /api key|unauthorized|permission|forbidden|invalid key/i.test(msg)
}

function isSchemaFailureLike(e: any): boolean {
  const code = String(e?.code || '').toUpperCase()
  const msg = String(e?.message || e || '').toLowerCase()
  if (code === 'VALIDATION_REJECTED' && !/empty_batch_after_structural_validation|invalid_type|invalid_json|schema|zod/i.test(msg)) return false
  return code === 'INVALID_JSON_RESPONSE' || code === 'SCHEMA_VALIDATION_FAILED'
    || /invalid_json|invalid json|invalid_type|empty_batch_after_structural_validation|schema|zod|questions\.|correctanswer/i.test(msg)
}

const STRICT_ENCRYPTED_SETTING_PROVIDERS = new Set(['GROQ', 'OPENROUTER', 'DEEPINFRA', 'TOGETHER', 'UNOROUTER', 'RELAYROUTER', 'TOPTOOLS', 'OPENAI_COMPAT'])
const LEGACY_PLAINTEXT_SETTING_PROVIDERS = new Set(['GEMINI', 'OPENAI', 'ANTHROPIC', 'ZAI'])

function providerFromSettingKey(key: string): string {
  for (const provider of [...STRICT_ENCRYPTED_SETTING_PROVIDERS, ...LEGACY_PLAINTEXT_SETTING_PROVIDERS]) if (key.startsWith(`${provider}_`)) return provider
  return ''
}

function decryptSettingValue(key: string, raw: string): string {
  const value = String(raw || '').trim()
  if (!value || !isSecretKeyName(key)) return value
  if (isEncryptedSecret(value)) return decryptSecret(value).trim()
  const provider = providerFromSettingKey(key)
  if (STRICT_ENCRYPTED_SETTING_PROVIDERS.has(provider)) return ''
  return value
}

async function readSettings(keys: string[]): Promise<Record<string, string>> {
  try {
    const values = await settingStore().read(keys)
    const out: Record<string, string> = {}
    for (const key of keys) out[key] = decryptSettingValue(key, String(values[key] || ''))
    return out
  } catch {
    return Object.fromEntries(keys.map((k) => [k, '']))
  }
}

async function settings() {
  const rows = await readSettings([
    'AI_TEXT_PROVIDER', 'AI_ROUTER_POLICY', 'AI_ROUTER_ALLOW_PUBLIC_GATEWAYS', 'AI_ACADEMIC_ALLOWLIST',
    'AI_PAID_USAGE_MODE', 'AI_PAID_MODELS', 'AI_PAID_DAILY_LIMIT_USD', 'AI_PAID_MONTHLY_LIMIT_USD', 'AI_PROVIDER_TIER_OPENAI_COMPAT',
    'GEMINI_API_KEY', 'GEMINI_API_KEYS', 'GEMINI_TEXT_MODEL',
    'OPENAI_API_KEY', 'OPENAI_API_KEYS', 'OPENAI_TEXT_MODEL', 'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEYS', 'ANTHROPIC_TEXT_MODEL',
    'ZAI_API_KEY', 'ZAI_API_KEYS', 'ZAI_TEXT_MODEL', 'ZAI_API_BASE',
    'GROQ_API_KEY', 'GROQ_API_KEYS', 'GROQ_TEXT_MODEL', 'GROQ_API_BASE',
    'OPENROUTER_API_KEY', 'OPENROUTER_API_KEYS', 'OPENROUTER_TEXT_MODEL', 'OPENROUTER_BASE_URL',
    'DEEPINFRA_API_KEY', 'DEEPINFRA_API_KEYS', 'DEEPINFRA_TEXT_MODEL', 'DEEPINFRA_BASE_URL',
    'TOGETHER_API_KEY', 'TOGETHER_API_KEYS', 'TOGETHER_TEXT_MODEL', 'TOGETHER_BASE_URL',
    'UNOROUTER_API_KEY', 'UNOROUTER_API_KEYS', 'UNOROUTER_TEXT_MODEL', 'UNOROUTER_BASE_URL',
    'RELAYROUTER_API_KEY', 'RELAYROUTER_API_KEYS', 'RELAYROUTER_TEXT_MODEL', 'RELAYROUTER_BASE_URL',
    'TOPTOOLS_API_KEY', 'TOPTOOLS_API_KEYS', 'TOPTOOLS_TEXT_MODEL', 'TOPTOOLS_BASE_URL',
    'OPENAI_COMPAT_API_KEY', 'OPENAI_COMPAT_API_KEYS', 'OPENAI_COMPAT_TEXT_MODEL', 'OPENAI_COMPAT_BASE_URL',
  ])
  const provider = normalizeProvider(rows.AI_TEXT_PROVIDER || env('AI_TEXT_PROVIDER') || 'GEMINI')
  const policy = normalizePolicy(rows.AI_ROUTER_POLICY || env('AI_ROUTER_POLICY') || 'primary_first')
  return {
    provider,
    policy,
    allowPublicGateways: ['1', 'true', 'yes', 'on'].includes(String(rows.AI_ROUTER_ALLOW_PUBLIC_GATEWAYS || env('AI_ROUTER_ALLOW_PUBLIC_GATEWAYS') || '').toLowerCase()),
    academicAllowlist: parseAcademicAllowlist(rows.AI_ACADEMIC_ALLOWLIST || env('AI_ACADEMIC_ALLOWLIST') || DEFAULT_ACADEMIC_ALLOWLIST),
    paidUsageMode: (['last_resort', 'critical_first'].includes(String(rows.AI_PAID_USAGE_MODE || env('AI_PAID_USAGE_MODE')).toLowerCase()) ? String(rows.AI_PAID_USAGE_MODE || env('AI_PAID_USAGE_MODE')).toLowerCase() : 'off') as TextAiPaidUsageMode,
    paidModels: parseKeys(rows.AI_PAID_MODELS || env('AI_PAID_MODELS')).filter((model) => validModelName(model) && academicModelAllowed('OPENAI_COMPAT', model)),
    paidDailyLimitUsd: Math.max(0, Number(rows.AI_PAID_DAILY_LIMIT_USD || env('AI_PAID_DAILY_LIMIT_USD') || 0) || 0),
    paidMonthlyLimitUsd: Math.max(0, Number(rows.AI_PAID_MONTHLY_LIMIT_USD || env('AI_PAID_MONTHLY_LIMIT_USD') || 0) || 0),
    openaiCompatTier: String(rows.AI_PROVIDER_TIER_OPENAI_COMPAT || env('AI_PROVIDER_TIER_OPENAI_COMPAT') || 'FREE').toUpperCase() === 'PAID' ? 'PAID' as TextAiProviderTier : 'FREE' as TextAiProviderTier,
    // الأولوية: إعدادات المنصة المشفرة أولاً، ثم Vercel Environment Variables كاحتياط.
    geminiKeys: parseKeys(rows.GEMINI_API_KEY, rows.GEMINI_API_KEYS, env('GEMINI_API_KEY'), env('GEMINI_API_KEYS')),
    geminiModel: normalizeModel(rows.GEMINI_TEXT_MODEL || env('GEMINI_TEXT_MODEL'), GEMINI_TEXT_MODELS),
    openaiKeys: parseKeys(rows.OPENAI_API_KEY, rows.OPENAI_API_KEYS, env('OPENAI_API_KEY'), env('OPENAI_API_KEYS')),
    openaiModel: normalizeModel(rows.OPENAI_TEXT_MODEL || env('OPENAI_TEXT_MODEL'), OPENAI_TEXT_MODELS),
    openaiBaseUrl: (rows.OPENAI_BASE_URL || env('OPENAI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/$/, ''),
    anthropicKeys: parseKeys(rows.ANTHROPIC_API_KEY, rows.ANTHROPIC_API_KEYS, env('ANTHROPIC_API_KEY'), env('ANTHROPIC_API_KEYS')),
    anthropicModel: normalizeModel(rows.ANTHROPIC_TEXT_MODEL || env('ANTHROPIC_TEXT_MODEL'), ANTHROPIC_TEXT_MODELS),
    zaiKeys: parseKeys(rows.ZAI_API_KEY, rows.ZAI_API_KEYS, env('ZAI_API_KEY'), env('ZAI_API_KEYS')),
    zaiModel: normalizeModel(rows.ZAI_TEXT_MODEL || env('ZAI_TEXT_MODEL'), ZAI_TEXT_MODELS),
    zaiBaseUrl: (rows.ZAI_API_BASE || env('ZAI_API_BASE') || 'https://api.z.ai/api/paas/v4').replace(/\/$/, ''),
    groqKeys: parseKeys(rows.GROQ_API_KEY, rows.GROQ_API_KEYS, env('GROQ_API_KEY'), env('GROQ_API_KEYS')),
    groqModel: normalizeModel(rows.GROQ_TEXT_MODEL || env('GROQ_TEXT_MODEL'), GROQ_TEXT_MODELS),
    groqBaseUrl: (rows.GROQ_API_BASE || env('GROQ_API_BASE') || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    openrouterKeys: parseKeys(rows.OPENROUTER_API_KEY, rows.OPENROUTER_API_KEYS, env('OPENROUTER_API_KEY'), env('OPENROUTER_API_KEYS')),
    openrouterModel: normalizeModel(rows.OPENROUTER_TEXT_MODEL || env('OPENROUTER_TEXT_MODEL'), OPENROUTER_TEXT_MODELS),
    openrouterBaseUrl: (rows.OPENROUTER_BASE_URL || env('OPENROUTER_BASE_URL') || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    deepinfraKeys: parseKeys(rows.DEEPINFRA_API_KEY, rows.DEEPINFRA_API_KEYS, env('DEEPINFRA_API_KEY'), env('DEEPINFRA_API_KEYS')),
    deepinfraModel: normalizeModel(rows.DEEPINFRA_TEXT_MODEL || env('DEEPINFRA_TEXT_MODEL'), DEEPINFRA_TEXT_MODELS),
    deepinfraBaseUrl: (rows.DEEPINFRA_BASE_URL || env('DEEPINFRA_BASE_URL') || 'https://api.deepinfra.com/v1').replace(/\/$/, ''),
    togetherKeys: parseKeys(rows.TOGETHER_API_KEY, rows.TOGETHER_API_KEYS, env('TOGETHER_API_KEY'), env('TOGETHER_API_KEYS')),
    togetherModel: normalizeModel(rows.TOGETHER_TEXT_MODEL || env('TOGETHER_TEXT_MODEL'), TOGETHER_TEXT_MODELS),
    togetherBaseUrl: (rows.TOGETHER_BASE_URL || env('TOGETHER_BASE_URL') || 'https://api.together.ai/v1').replace(/\/$/, ''),
    unorouterKeys: parseKeys(rows.UNOROUTER_API_KEY, rows.UNOROUTER_API_KEYS, env('UNOROUTER_API_KEY'), env('UNOROUTER_API_KEYS')),
    unorouterModel: normalizeModel(rows.UNOROUTER_TEXT_MODEL || env('UNOROUTER_TEXT_MODEL'), UNOROUTER_TEXT_MODELS),
    unorouterBaseUrl: (rows.UNOROUTER_BASE_URL || env('UNOROUTER_BASE_URL') || 'https://api.unorouter.com/v1').replace(/\/$/, ''),
    relayrouterKeys: parseKeys(rows.RELAYROUTER_API_KEY, rows.RELAYROUTER_API_KEYS, env('RELAYROUTER_API_KEY'), env('RELAYROUTER_API_KEYS')),
    relayrouterModel: normalizeModel(rows.RELAYROUTER_TEXT_MODEL || env('RELAYROUTER_TEXT_MODEL'), RELAYROUTER_TEXT_MODELS),
    relayrouterBaseUrl: (rows.RELAYROUTER_BASE_URL || env('RELAYROUTER_BASE_URL') || 'https://relayrouter.io/v1').replace(/\/$/, ''),
    topToolsKeys: parseKeys(rows.TOPTOOLS_API_KEY, rows.TOPTOOLS_API_KEYS, env('TOPTOOLS_API_KEY'), env('TOPTOOLS_API_KEYS')),
    topToolsModel: normalizeModel(rows.TOPTOOLS_TEXT_MODEL || env('TOPTOOLS_TEXT_MODEL'), TOPTOOLS_TEXT_MODELS),
    topToolsBaseUrl: (rows.TOPTOOLS_BASE_URL || env('TOPTOOLS_BASE_URL') || 'https://top-tools-ai.com/v1').replace(/\/$/, ''),
    openaiCompatKeys: parseKeys(rows.OPENAI_COMPAT_API_KEY, rows.OPENAI_COMPAT_API_KEYS, env('OPENAI_COMPAT_API_KEY'), env('OPENAI_COMPAT_API_KEYS')),
    openaiCompatModel: normalizeModel(rows.OPENAI_COMPAT_TEXT_MODEL || env('OPENAI_COMPAT_TEXT_MODEL'), OPENAI_COMPAT_TEXT_MODELS),
    openaiCompatBaseUrl: (rows.OPENAI_COMPAT_BASE_URL || env('OPENAI_COMPAT_BASE_URL') || '').replace(/\/$/, ''),
  }
}

type Settings = Awaited<ReturnType<typeof settings>>
type ConcreteProvider = Exclude<TextAiProvider, 'AUTO'>

function providerKeys(s: Settings, provider: ConcreteProvider): string[] {
  switch (provider) {
    case 'GEMINI': return s.geminiKeys
    case 'OPENAI': return s.openaiKeys
    case 'ANTHROPIC': return s.anthropicKeys
    case 'ZAI': return s.zaiKeys
    case 'GROQ': return s.groqKeys
    case 'OPENROUTER': return s.openrouterKeys
    case 'DEEPINFRA': return s.deepinfraKeys
    case 'TOGETHER': return s.togetherKeys
    case 'UNOROUTER': return s.unorouterKeys
    case 'RELAYROUTER': return s.relayrouterKeys
    case 'TOPTOOLS': return s.topToolsKeys
    case 'OPENAI_COMPAT': return s.openaiCompatBaseUrl ? s.openaiCompatKeys : []
  }
}

function modelFor(s: Settings, provider: ConcreteProvider): string {
  switch (provider) {
    case 'GEMINI': return s.geminiModel
    case 'OPENAI': return s.openaiModel
    case 'ANTHROPIC': return s.anthropicModel
    case 'ZAI': return s.zaiModel
    case 'GROQ': return s.groqModel
    case 'OPENROUTER': return s.openrouterModel
    case 'DEEPINFRA': return s.deepinfraModel
    case 'TOGETHER': return s.togetherModel
    case 'UNOROUTER': return s.unorouterModel
    case 'RELAYROUTER': return s.relayrouterModel
    case 'TOPTOOLS': return s.topToolsModel
    case 'OPENAI_COMPAT': return s.openaiCompatModel
  }
}

function baseFor(s: Settings, provider: ConcreteProvider): string {
  switch (provider) {
    case 'OPENAI': return s.openaiBaseUrl
    case 'ZAI': return s.zaiBaseUrl
    case 'GROQ': return s.groqBaseUrl
    case 'OPENROUTER': return s.openrouterBaseUrl
    case 'DEEPINFRA': return s.deepinfraBaseUrl
    case 'TOGETHER': return s.togetherBaseUrl
    case 'UNOROUTER': return s.unorouterBaseUrl
    case 'RELAYROUTER': return s.relayrouterBaseUrl
    case 'TOPTOOLS': return s.topToolsBaseUrl
    case 'OPENAI_COMPAT': return s.openaiCompatBaseUrl
    default: return ''
  }
}

function cacheKeyForFreeModels(provider: ConcreteProvider, baseUrl: string, key?: string): string {
  const keyHash = key ? createHash('sha256').update(key).digest('hex').slice(0, 12) : 'anonymous'
  return `${provider}:${(baseUrl || '').replace(/\/$/, '')}:${keyHash}`
}

function persistentModelsCacheKey(cacheKey: string): string {
  return `AI_MODELS_AVAILABLE:${cacheKey}`
}

function apiRootFromBase(baseUrl: string, fallback: string): string {
  return (baseUrl || fallback).replace(/\/$/, '').replace(/\/v1$/, '')
}

function validModelName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_.\/:-]{1,180}$/i.test(name)
}

function modelId(row: any): string {
  return String(row?.id || row?.model_name || row?.model || row?.name || '').trim()
}

function isTextLikeModel(row: any): boolean {
  const id = modelId(row).toLowerCase()
  const type = String(row?.type || row?.modality || row?.architecture?.modality || row?.input_modalities?.join?.(',') || 'text').toLowerCase()
  if (/image|vision-only|video|audio|embedding|embed|moderation|guard|rerank|ocr-only|tts|stt|whisper/.test(`${type} ${id}`)) return false
  const contextLength = Number(row?.context_length ?? row?.contextLength ?? row?.context_window ?? row?.max_context_length ?? row?.max_tokens ?? NaN)
  if (Number.isFinite(contextLength) && contextLength > 0 && contextLength < 32000) return false
  const endpoints = Array.isArray(row?.supported_endpoint_types) ? row.supported_endpoint_types : []
  return endpoints.length === 0 || endpoints.includes('openai') || endpoints.includes('chat') || endpoints.includes('chat/completions')
}

function capabilityFromModelRow(row: any): ModelCapability {
  const contextLength = Number(row?.context_length ?? row?.contextLength ?? row?.context_window ?? row?.max_context_length ?? row?.max_tokens ?? NaN)
  const modalities = [
    ...(Array.isArray(row?.modalities) ? row.modalities : []),
    ...(Array.isArray(row?.input_modalities) ? row.input_modalities : []),
    ...(Array.isArray(row?.supported_modalities) ? row.supported_modalities : []),
    row?.architecture?.input_modalities,
    row?.architecture?.modality,
  ].flat().filter(Boolean).map((v: unknown) => String(v).toLowerCase())
  const supportedParameters = [
    ...(Array.isArray(row?.supported_parameters) ? row.supported_parameters : []),
    ...(Array.isArray(row?.supportedParameters) ? row.supportedParameters : []),
  ].map((v: unknown) => String(v))
  const haystack = `${modelId(row)} ${modalities.join(' ')}`.toLowerCase()
  return {
    contextLength: Number.isFinite(contextLength) ? contextLength : undefined,
    vision: /vision|image|multimodal|input_image|image_url/.test(haystack),
    modalities,
    supportedParameters,
  }
}

function zeroish(value: unknown): boolean {
  if (value === 0) return true
  const n = Number(String(value ?? '').replace(/[^0-9.e-]/gi, ''))
  return Number.isFinite(n) && n === 0
}

function isFreeModel(row: any, id: string): boolean {
  if (!id) return false
  if (id.endsWith(':free') || /(^|[-_/:])free($|[-_/:])/.test(id)) return true
  if (row?.is_free === true || row?.free === true) return true
  const pricing = row?.pricing || row?.price || row?.cost || {}
  const prompt = pricing.prompt ?? pricing.input ?? pricing.prompt_tokens ?? pricing.input_tokens
  const completion = pricing.completion ?? pricing.output ?? pricing.completion_tokens ?? pricing.output_tokens
  return (prompt !== undefined || completion !== undefined) && zeroish(prompt) && zeroish(completion)
}

function isStrongTopToolsTextModel(row: any, id: string): boolean {
  const haystack = `${id} ${row?.name || ''} ${row?.owned_by || ''} ${row?.provider || ''}`.toLowerCase()
  if (/embedding|moderation|rerank|whisper|tts|stt|audio|image|vision|dall|sdxl|stable-diffusion/.test(haystack)) return false
  return /gpt|claude|gemini|grok|deepseek|qwen|llama|mistral|mixtral|glm|kimi|command|nova|sonar|minimax|nemotron|yi-|phi-4|openai|anthropic|google|x-ai|cohere/.test(haystack)
}

function topToolsModelRank(id: string): number {
  const n = id.toLowerCase()
  if (/gpt-5|claude-opus|gemini-3|grok-4/.test(n)) return 1
  if (/gpt-4|claude-sonnet|gemini-2\.5|deepseek|qwen|llama-4|glm-5|kimi/.test(n)) return 2
  if (/mistral|mixtral|llama-3|command|nova|sonar|minimax|nemotron/.test(n)) return 3
  return 9
}

function rowsFromModelPayload(data: any): any[] {
  if (Array.isArray(data?.models)) return data.models
  if (Array.isArray(data?.data)) return data.data
  if (Array.isArray(data?.results)) return data.results
  if (Array.isArray(data)) return data
  return []
}

function normalizeFreeModelName(provider: ConcreteProvider, name: string): string {
  if (provider === 'UNOROUTER' && name && !name.endsWith(':free')) return `${name}:free`
  return name
}

async function fetchOpenAiCompatibleFreeModels(provider: ConcreteProvider, baseUrl: string, key?: string): Promise<string[]> {
  if (!baseUrl) return []
  try {
    const response = await fetchWithTimeout(provider, `${baseUrl.replace(/\/$/, '')}/models`, {
      cache: 'no-store',
      headers: key ? { Authorization: `Bearer ${key}` } : undefined,
    }, aiDiscoveryTimeoutMs())
    const data = await response.json().catch(() => ({}))
    const rows = rowsFromModelPayload(data)
      .filter((m) => m?.online !== false)
      .filter(isTextLikeModel)
      .map((m) => ({ raw: m, id: normalizeFreeModelName(provider, modelId(m)) }))
      .filter(({ raw, id }) => validModelName(id) && (provider === 'TOPTOOLS' ? isStrongTopToolsTextModel(raw, id) : isFreeModel(raw, id)))
    const orderedRows = provider === 'TOPTOOLS'
      ? rows.sort((a, b) => topToolsModelRank(a.id) - topToolsModelRank(b.id) || a.id.localeCompare(b.id))
      : rows
    const models = orderedRows.map(({ id }) => id)
    const capabilities = Object.fromEntries(orderedRows.map(({ raw, id }) => [id, capabilityFromModelRow(raw)]))
    freeModelsCache.set(cacheKeyForFreeModels(provider, baseUrl, key), { at: Date.now(), models, capabilities })
    return models
  } catch {
    return []
  }
}

async function liveFreeModels(provider: ConcreteProvider, s: Settings): Promise<string[]> {
  const baseUrl = baseFor(s, provider)
  const key = providerKeys(s, provider)[0]
  const cacheKey = cacheKeyForFreeModels(provider, baseUrl, key)
  const now = Date.now()
  const cached = freeModelsCache.get(cacheKey)
  if (cached && now - cached.at < 30 * 60 * 1000) return cached.models
  try {
    const persisted = (await settingStore().read([persistentModelsCacheKey(cacheKey)]))[persistentModelsCacheKey(cacheKey)]
    const parsed = persisted ? JSON.parse(persisted) : null
    if (Array.isArray(parsed?.models) && Number(parsed.at || 0) > 0 && now - Number(parsed.at) < 24 * 60 * 60 * 1000) {
      const models = parsed.models.map(String).filter(validModelName)
      const capabilities = parsed.capabilities && typeof parsed.capabilities === 'object' ? parsed.capabilities as Record<string, ModelCapability> : undefined
      freeModelsCache.set(cacheKey, { at: now, models, capabilities })
      return models
    }
  } catch {
    // Persistent model discovery cache is best-effort.
  }

  let models: string[] = []
  if (provider === 'UNOROUTER') {
    const root = apiRootFromBase(s.unorouterBaseUrl, 'https://api.unorouter.com/v1')
    try {
      const response = await fetchWithTimeout(provider, `${root}/api/pricing/catalog`, { cache: 'no-store' }, aiDiscoveryTimeoutMs())
      const data: any = await response.json().catch(() => ({}))
      const rows = rowsFromModelPayload(data)
        .filter((m) => m?.is_free === true)
        .filter((m) => m?.online !== false)
        .filter(isTextLikeModel)
        .map((m) => ({ raw: m, id: normalizeFreeModelName(provider, modelId(m)) }))
        .filter(({ id }) => validModelName(id))
      models = rows.map(({ id }) => id)
      freeModelsCache.set(cacheKey, { at: now, models, capabilities: Object.fromEntries(rows.map(({ raw, id }) => [id, capabilityFromModelRow(raw)])) })
    } catch {
      models = []
    }
  } else if (['OPENROUTER', 'DEEPINFRA', 'TOGETHER', 'UNOROUTER', 'RELAYROUTER', 'TOPTOOLS', 'OPENAI_COMPAT', 'GROQ', 'ZAI'].includes(provider)) {
    models = await fetchOpenAiCompatibleFreeModels(provider, baseUrl, key)
  }

  models = [...new Set(models)]
  const cachedWithCapabilities = freeModelsCache.get(cacheKey)
  const capabilities = cachedWithCapabilities?.capabilities
  freeModelsCache.set(cacheKey, { at: now, models, capabilities })
  if (models.length) {
    settingStore().write(persistentModelsCacheKey(cacheKey), JSON.stringify({ at: now, models, capabilities })).catch(() => {})
  }
  return models
}

function academicModelAllowed(provider: ConcreteProvider, model: string): boolean {
  const id = model.toLowerCase()
  if (!id || /(^|\/|-)auto$/i.test(id) || id === 'auto') return false
  if (/dall-e|image|embedding|rerank|whisper|tts|stt|audio|moderation/.test(id)) return false
  if (/\b(?:7b|8b|9b|11b|13b|14b|20b|22b|24b|27b)\b/i.test(id)) return false
  if (/gpt-3\.5/.test(id)) return false
  if (provider === 'TOPTOOLS' && topToolsModelRank(model) > 2) return false
  return true
}

function academicModelRank(model: string): number {
  const id = model.toLowerCase()
  if (/gemini-(?:3\.8|3\.5)-flash/.test(id)) return 1
  if (/gpt-oss-120b|deepseek.*v3\.2|glm-5|llama-4-maverick|nemotron.*120b/.test(id)) return 2
  if (/claude-(?:opus|sonnet)|gpt-[45]|gemini-2\.5|qwen.*(?:32b|70b|72b)|llama.*70b|mistral.*large/.test(id)) return 3
  return 9
}

function modelCapabilityAllowed(model: string): boolean {
  const id = model.toLowerCase()
  if (/image|vision-only|audio|tts|whisper|embed|embedding|moderation|guard|rerank|ocr-only/.test(id)) return false
  return true
}

function modelCapabilitiesFor(provider: ConcreteProvider, s: Settings, model: string): ModelCapability | null {
  const cacheKey = cacheKeyForFreeModels(provider, baseFor(s, provider), providerKeys(s, provider)[0])
  return freeModelsCache.get(cacheKey)?.capabilities?.[model] || null
}

export function modelAllowedForPurpose(model: string, purpose?: TextAiPurpose, capability?: ModelCapability | null): boolean {
  if (!purpose) return true
  if (purpose === 'VISION') {
    if (!capability) return true
    return capability.vision !== false && (capability.vision === true || capability.modalities?.some((m) => /image|vision/.test(m)))
  }
  if (purpose === 'LONG_CONTEXT') {
    if (!capability || !capability.contextLength) return true
    return capability.contextLength >= 64_000
  }
  return true
}

type ModelStats = { success: number; fail: Record<string, number>; avgMs: number; jsonOk: number; jsonTotal: number; evidenceOk: number; evidenceTotal: number }

function modelStatsKey(provider: string, model: string): string {
  return `AI_MODEL_STATS:${provider}:${model}`
}

function purposeModelStatsKey(purpose: TextAiPurpose | undefined, provider: string, model: string): string {
  return purpose ? `AI_MODEL_STATS:${purpose}:${provider}:${model}` : modelStatsKey(provider, model)
}

function modelHealthKey(provider: string, model: string): string {
  return `AI_MODEL_HEALTH:${provider}:${model}`
}

type ModelHealth = { ok: boolean; latencyMs?: number; checkedAt?: string; error?: string }

function parseModelHealth(raw: unknown): ModelHealth | null {
  try {
    const parsed = JSON.parse(String(raw || '{}'))
    if (typeof parsed.ok !== 'boolean') return null
    return { ok: parsed.ok, latencyMs: Number(parsed.latencyMs || 0) || undefined, checkedAt: String(parsed.checkedAt || ''), error: String(parsed.error || '').slice(0, 240) }
  } catch {
    return null
  }
}

function recentFailedHealth(health: ModelHealth | null): boolean {
  if (!health || health.ok) return false
  const checkedAt = Date.parse(String(health.checkedAt || ''))
  return Number.isFinite(checkedAt) && Date.now() - checkedAt < 30 * 60 * 1000
}

async function readModelHealth(provider: ConcreteProvider, models: string[]): Promise<Map<string, ModelHealth | null>> {
  try {
    const keys = models.map((model) => modelHealthKey(provider, model))
    const rows = await settingStore().read(keys)
    return new Map(models.map((model) => [model, parseModelHealth(rows[modelHealthKey(provider, model)])]))
  } catch {
    return new Map(models.map((model) => [model, null]))
  }
}

function parseModelStats(raw: unknown): ModelStats {
  try {
    const parsed = JSON.parse(String(raw || '{}'))
    return {
      success: Number(parsed.success || 0) || 0,
      fail: typeof parsed.fail === 'object' && parsed.fail ? parsed.fail : {},
      avgMs: Number(parsed.avgMs || 0) || 0,
      jsonOk: Number(parsed.jsonOk || 0) || 0,
      jsonTotal: Number(parsed.jsonTotal || 0) || 0,
      evidenceOk: Number(parsed.evidenceOk || 0) || 0,
      evidenceTotal: Number(parsed.evidenceTotal || 0) || 0,
    }
  } catch {
    return { success: 0, fail: {}, avgMs: 0, jsonOk: 0, jsonTotal: 0, evidenceOk: 0, evidenceTotal: 0 }
  }
}

function healthScore(stats: ModelStats): number {
  const failCount = Object.values(stats.fail || {}).reduce((sum, n) => sum + (Number(n) || 0), 0)
  const total = stats.success + failCount
  if (!total) return 0.35
  const successRate = stats.success / total
  const jsonRate = stats.jsonTotal ? stats.jsonOk / stats.jsonTotal : 0.5
  const evidenceRate = stats.evidenceTotal ? stats.evidenceOk / stats.evidenceTotal : 0.5
  const latencyPenalty = stats.avgMs ? Math.min(0.25, stats.avgMs / 120000) : 0.05
  return successRate * 0.55 + jsonRate * 0.2 + evidenceRate * 0.2 - latencyPenalty
}

async function readModelStats(provider: ConcreteProvider, models: readonly string[], purpose?: TextAiPurpose): Promise<Map<string, ModelStats>> {
  if (!models.length) return new Map()
  try {
    const purposeKeys = models.map((model) => purposeModelStatsKey(purpose, provider, model))
    const generalKeys = models.map((model) => modelStatsKey(provider, model))
    const rows = await settingStore().read([...purposeKeys, ...generalKeys])
    return new Map(models.map((model) => {
      const purposeStats = parseModelStats(rows[purposeModelStatsKey(purpose, provider, model)])
      const total = purposeStats.success + Object.values(purposeStats.fail || {}).reduce((sum, n) => sum + (Number(n) || 0), 0)
      return [model, total >= 5 ? purposeStats : parseModelStats(rows[modelStatsKey(provider, model)])]
    }))
  } catch {
    return new Map(models.map((model) => [model, parseModelStats('')]))
  }
}

async function recordModelStats(provider: ConcreteProvider, model: string, result: { ok: boolean; reason?: string; ms: number; jsonOk?: boolean; evidenceOk?: boolean }, purpose?: TextAiPurpose): Promise<void> {
  const updateStats = (current: ModelStats) => {
    const fail = { ...(current.fail || {}) }
    if (result.ok) current.success += 1
    else fail[result.reason || 'other'] = (fail[result.reason || 'other'] || 0) + 1
    current.fail = fail
    current.avgMs = current.avgMs ? Math.round(current.avgMs * 0.8 + result.ms * 0.2) : result.ms
    if (typeof result.jsonOk === 'boolean') {
      current.jsonTotal += 1
      if (result.jsonOk) current.jsonOk += 1
    }
    if (typeof result.evidenceOk === 'boolean') {
      current.evidenceTotal += 1
      if (result.evidenceOk) current.evidenceOk += 1
    }
    return current
  }
  try {
    const keys = [modelStatsKey(provider, model), ...(purpose ? [purposeModelStatsKey(purpose, provider, model)] : [])]
    const rows = await settingStore().read(keys)
    for (const key of keys) await settingStore().write(key, JSON.stringify(updateStats(parseModelStats(rows[key]))))
  } catch {
    // Model health stats are best-effort and must not affect routing.
  }
}

async function orderModelsByHealth(provider: ConcreteProvider, models: string[], taskLevel: TextAiTaskLevel, explore: boolean, purpose?: TextAiPurpose): Promise<string[]> {
  const stats = await readModelStats(provider, models, purpose)
  const sorted = [...models].sort((a, b) => {
    const scoreDiff = healthScore(stats.get(b) || parseModelStats('')) - healthScore(stats.get(a) || parseModelStats(''))
    if (Math.abs(scoreDiff) > 0.03) return scoreDiff
    if (taskLevel !== 'GENERAL') return academicModelRank(a) - academicModelRank(b)
    return 0
  })
  if (explore) {
    const unseen = sorted.find((model) => {
      const s = stats.get(model) || parseModelStats('')
      return s.success === 0 && Object.values(s.fail || {}).reduce((sum, n) => sum + (Number(n) || 0), 0) === 0
    })
    if (unseen) return [unseen, ...sorted.filter((model) => model !== unseen)]
  }
  return sorted
}

async function modelFallbacks(s: Settings, provider: ConcreteProvider, taskLevel: TextAiTaskLevel = 'GENERAL', explore = false, purpose?: TextAiPurpose): Promise<string[]> {
  const selected = modelFor(s, provider)
  const staticDefaults: string[] =
    provider === 'GEMINI' ? GEMINI_TEXT_MODELS :
    provider === 'OPENAI' ? OPENAI_TEXT_MODELS :
    provider === 'ANTHROPIC' ? ANTHROPIC_TEXT_MODELS :
    provider === 'ZAI' ? ZAI_TEXT_MODELS :
    provider === 'GROQ' ? GROQ_TEXT_MODELS :
    provider === 'OPENROUTER' ? OPENROUTER_TEXT_MODELS :
    provider === 'DEEPINFRA' ? DEEPINFRA_TEXT_MODELS :
    provider === 'TOGETHER' ? TOGETHER_TEXT_MODELS :
    provider === 'UNOROUTER' ? UNOROUTER_TEXT_MODELS :
    provider === 'RELAYROUTER' ? RELAYROUTER_TEXT_MODELS :
    provider === 'TOPTOOLS' ? TOPTOOLS_TEXT_MODELS :
    OPENAI_COMPAT_TEXT_MODELS
  const discoveredFree = await liveFreeModels(provider, s)
  const selectedIsAuto = /(^|\/|-)auto$/i.test(selected) || selected === 'auto'
  const selectedPart = selected && !selectedIsAuto ? [selected] : []
  const academicPreferred = taskLevel === 'GENERAL' ? [] : s.academicAllowlist.filter((item) => item.provider === provider).map((item) => item.model)
  const discoveredOrFallback = discoveredFree.length ? discoveredFree : staticDefaults
  const models = [...new Set([...academicPreferred, ...selectedPart, ...discoveredOrFallback].filter(Boolean))]
    .filter(modelCapabilityAllowed)
    .filter((model) => modelAllowedForPurpose(model, purpose, modelCapabilitiesFor(provider, s, model)))
  const allowed = taskLevel === 'GENERAL' ? models : models.filter((model) => academicModelAllowed(provider, model))
  return orderModelsByHealth(provider, allowed, taskLevel, explore, purpose)
}

const ACADEMY_PRIMARY_TEXT_PROVIDER_ORDER: ConcreteProvider[] = [
  'GEMINI',
  'UNOROUTER',
  'OPENROUTER',
  'TOPTOOLS',
  'OPENAI',
  'ANTHROPIC',
  'ZAI',
  'GROQ',
  'RELAYROUTER',
  'DEEPINFRA',
  'TOGETHER',
  'OPENAI_COMPAT',
]

function selectedFirst(selected: ConcreteProvider | null, order: ConcreteProvider[]): ConcreteProvider[] {
  return selected ? [selected, ...order.filter((provider) => provider !== selected)] : order
}

function baseOrder(s: Settings): ConcreteProvider[] {
  const selected = s.provider === 'AUTO' ? null : s.provider
  const quality: ConcreteProvider[] = ['ANTHROPIC', 'OPENAI', 'GEMINI', 'UNOROUTER', 'OPENROUTER', 'RELAYROUTER', 'TOPTOOLS', 'ZAI', 'GROQ', 'DEEPINFRA', 'TOGETHER', 'OPENAI_COMPAT']
  const cost: ConcreteProvider[] = ['GROQ', 'ZAI', 'UNOROUTER', 'OPENROUTER', 'RELAYROUTER', 'TOPTOOLS', 'DEEPINFRA', 'TOGETHER', 'OPENAI_COMPAT', 'GEMINI', 'OPENAI', 'ANTHROPIC']
  const primary: ConcreteProvider[] = ACADEMY_PRIMARY_TEXT_PROVIDER_ORDER
  if (s.policy === 'quality_first') return quality
  if (s.policy === 'cost_saver') return cost
  if (s.policy === 'fallback_only' && selected) return [selected]
  if (s.policy === 'balanced') return primary.slice(roundRobin++ % Math.max(1, primary.length)).concat(primary.slice(0, (roundRobin - 1) % Math.max(1, primary.length)))
  return primary
}

function providerOrder(s: Settings, taskLevel: TextAiTaskLevel = 'GENERAL'): ConcreteProvider[] {
  if (taskLevel !== 'GENERAL') {
    const preferred = [...new Set(s.academicAllowlist.map((item) => item.provider))]
    const rest = baseOrder(s).filter((provider) => !preferred.includes(provider))
    const ordered = [...preferred, ...rest].filter((provider) => providerKeys(s, provider).length > 0)
    return ordered.includes('OPENAI') ? [...ordered.filter((provider) => provider !== 'OPENAI'), 'OPENAI'] : ordered
  }
  const publicGateways = new Set<ConcreteProvider>(['OPENROUTER', 'DEEPINFRA', 'TOGETHER', 'UNOROUTER', 'RELAYROUTER', 'TOPTOOLS', 'OPENAI_COMPAT'])
  const academyAlwaysAllowed = new Set<ConcreteProvider>(['UNOROUTER', 'OPENROUTER', 'TOPTOOLS'])
  return baseOrder(s).filter((provider) => {
    if (!providerKeys(s, provider).length) return false
    if (publicGateways.has(provider) && !s.allowPublicGateways && s.provider !== provider && !academyAlwaysAllowed.has(provider)) return false
    return true
  })
}

export async function hasExternalTextAi(): Promise<boolean> {
  const s = await settings()
  return providerOrder(s).length > 0
}

function cooldownList() {
  const now = Date.now()
  return [...cooldowns.entries()]
    .filter(([, v]) => v.until > now)
    .map(([id, v]) => ({ provider: id.split(':')[0], key: id.split(':')[1], until: new Date(v.until).toISOString(), reason: v.reason }))
}

export async function textAiFreeModelsForProvider(providerValue: unknown): Promise<{ provider: string; models: string[]; discoveredCount: number; staticCount: number; message: string }> {
  const s = await settings()
  const provider = normalizeProvider(providerValue)
  if (provider === 'AUTO') {
    const providers = providerOrder(s)
    const models = providers.map((p) => `${p}:${modelFor(s, p) || 'auto'}`)
    return {
      provider: 'AUTO',
      models,
      discoveredCount: 0,
      staticCount: models.length,
      message: models.length
        ? 'وضع AUTO يعرض المزودات النشطة فقط. اختر مزوداً محدداً لتحميل كتالوج نماذجه.'
        : 'لا توجد مزودات متاحة في وضع AUTO حالياً.',
    }
  }
  const concrete = provider as ConcreteProvider
  const staticDefaults: string[] =
    concrete === 'GEMINI' ? GEMINI_TEXT_MODELS :
    concrete === 'OPENAI' ? OPENAI_TEXT_MODELS :
    concrete === 'ANTHROPIC' ? ANTHROPIC_TEXT_MODELS :
    concrete === 'ZAI' ? ZAI_TEXT_MODELS :
    concrete === 'GROQ' ? GROQ_TEXT_MODELS :
    concrete === 'OPENROUTER' ? OPENROUTER_TEXT_MODELS :
    concrete === 'DEEPINFRA' ? DEEPINFRA_TEXT_MODELS :
    concrete === 'TOGETHER' ? TOGETHER_TEXT_MODELS :
    concrete === 'UNOROUTER' ? UNOROUTER_TEXT_MODELS :
    concrete === 'RELAYROUTER' ? RELAYROUTER_TEXT_MODELS :
    concrete === 'TOPTOOLS' ? TOPTOOLS_TEXT_MODELS :
    OPENAI_COMPAT_TEXT_MODELS
  const discovered = await liveFreeModels(concrete, s)
  const selected = modelFor(s, concrete)
  const selectedPart = selected && !/(^|\/|-)auto$/i.test(selected) && selected !== 'auto' ? [selected] : []
  const models = [...new Set([...selectedPart, ...discovered, ...staticDefaults].filter(Boolean))]
  const catalogLabel = concrete === 'TOPTOOLS' ? 'نموذج متاح' : 'نموذج مجاني'
  return {
    provider: concrete,
    models,
    discoveredCount: discovered.length,
    staticCount: staticDefaults.length,
    message: discovered.length
      ? `تم اكتشاف ${discovered.length} ${catalogLabel} من المزود.`
      : concrete === 'TOPTOOLS'
        ? 'لم يعرض Top Tools AI نماذج عبر /models، لذلك يظهر النموذج الاحتياطي فقط.'
        : 'لم يعرض المزود نماذج مجانية عبر API، لذلك تظهر القائمة الاحتياطية الثابتة فقط.',
  }
}

export async function textAiCheckAllModelHealth(): Promise<{ checked: number; results: Array<{ provider: string; model: string; ok: boolean; latencyMs?: number; error?: string }> }> {
  const s = await settings()
  const results: Array<{ provider: string; model: string; ok: boolean; latencyMs?: number; error?: string }> = []
  for (const provider of providerOrder(s)) {
    const key = providerKeys(s, provider)[0]
    if (!key) continue
    for (const model of (await modelFallbacks(s, provider, 'GENERAL', false)).slice(0, 3)) {
      const started = Date.now()
      try {
        await callProvider(provider, s, key, model, { system: 'أجب بكلمة واحدة.', history: [{ role: 'user', text: 'اكتب: ok' }], maxOutputTokens: 8, deadlineMs: Date.now() + 15_000 })
        const result = { provider, model, ok: true, latencyMs: Date.now() - started }
        results.push(result)
        await settingStore().write(modelHealthKey(provider, model), JSON.stringify({ ...result, checkedAt: new Date().toISOString() }))
      } catch (e: any) {
        const result = { provider, model, ok: false, latencyMs: Date.now() - started, error: redactSecrets(e?.message || e).slice(0, 240) }
        results.push(result)
        await settingStore().write(modelHealthKey(provider, model), JSON.stringify({ ...result, checkedAt: new Date().toISOString() }))
      }
    }
  }
  return { checked: results.length, results }
}

export async function textAiModelHealthSnapshot(): Promise<Array<{ provider: string; model: string; status: string; health?: ModelHealth | null; stats?: ModelStats | null; purposeScores?: Record<string, number> }>> {
  const rows = await settingStore().scan?.('AI_MODEL_') || {}
  const models = new Map<string, { provider: string; model: string; health?: ModelHealth | null; stats?: ModelStats | null; purposeScores?: Record<string, number> }>()
  const ensure = (provider: string, model: string) => {
    const id = `${provider}:${model}`
    if (!models.has(id)) models.set(id, { provider, model, purposeScores: {} })
    return models.get(id)!
  }
  for (const [key, value] of Object.entries(rows)) {
    if (key.startsWith('AI_MODEL_HEALTH:')) {
      const [, provider, ...modelParts] = key.split(':')
      ensure(provider, modelParts.join(':')).health = parseModelHealth(value)
    } else if (key.startsWith('AI_MODEL_STATS:')) {
      const parts = key.split(':')
      if (['CHAT', 'ANALYSIS', 'GENERATION', 'GRADING', 'VISION', 'LONG_CONTEXT', 'REVIEW'].includes(parts[1])) {
        const [, purpose, provider, ...modelParts] = parts
        ensure(provider, modelParts.join(':')).purposeScores![purpose] = healthScore(parseModelStats(value))
      } else {
        const [, provider, ...modelParts] = parts
        ensure(provider, modelParts.join(':')).stats = parseModelStats(value)
      }
    } else if (key.startsWith('AI_MODEL_DEAD:')) {
      const [, , provider, ...modelParts] = key.split(':')
      ensure(provider, modelParts.join(':')).status = 'ميت'
    }
  }
  return [...models.values()].map((row) => ({ ...row, status: row.status || (recentFailedHealth(row.health || null) ? 'فشل الفحص' : 'شغّال') }))
}

export async function textAiDiagnostics(): Promise<TextAiDiagnostics> {
  const s = await settings()
  const order = providerOrder(s)
  const counts: Record<string, number> = {
    GEMINI: s.geminiKeys.length,
    OPENAI: s.openaiKeys.length,
    ANTHROPIC: s.anthropicKeys.length,
    ZAI: s.zaiKeys.length,
    GROQ: s.groqKeys.length,
    OPENROUTER: s.openrouterKeys.length,
    DEEPINFRA: s.deepinfraKeys.length,
    TOGETHER: s.togetherKeys.length,
    UNOROUTER: s.unorouterKeys.length,
    RELAYROUTER: s.relayrouterKeys.length,
    TOPTOOLS: s.topToolsKeys.length,
    OPENAI_COMPAT: s.openaiCompatKeys.length,
  }
  return {
    selectedProvider: s.provider,
    activeProvider: order[0] || null,
    policy: s.policy,
    externalConfigured: order.length > 0,
    geminiConfigured: counts.GEMINI > 0,
    openaiConfigured: counts.OPENAI > 0,
    anthropicConfigured: counts.ANTHROPIC > 0,
    zaiConfigured: counts.ZAI > 0,
    groqConfigured: counts.GROQ > 0,
    openrouterConfigured: counts.OPENROUTER > 0,
    deepinfraConfigured: counts.DEEPINFRA > 0,
    togetherConfigured: counts.TOGETHER > 0,
    unorouterConfigured: counts.UNOROUTER > 0,
    relayrouterConfigured: counts.RELAYROUTER > 0,
    topToolsConfigured: counts.TOPTOOLS > 0,
    openaiCompatConfigured: counts.OPENAI_COMPAT > 0,
    geminiModel: s.geminiModel,
    openaiModel: s.openaiModel,
    anthropicModel: s.anthropicModel,
    zaiModel: s.zaiModel,
    groqModel: s.groqModel,
    openrouterModel: s.openrouterModel,
    deepinfraModel: s.deepinfraModel,
    togetherModel: s.togetherModel,
    unorouterModel: s.unorouterModel,
    relayrouterModel: s.relayrouterModel,
    topToolsModel: s.topToolsModel,
    openaiCompatModel: s.openaiCompatModel,
    keyCounts: counts,
    cooldowns: cooldownList(),
    lastResult,
    recentAttempts,
    message: order.length ? `AI Router جاهز. المزود التالي: ${order[0]} — السياسة: ${s.policy}` : 'لا يوجد مزود نصوص مضبوط حالياً أو أن البوابات العامة غير مسموحة.',
  }
}

function promptWithJsonInstruction(opts: TextAiCallOpts): string {
  return opts.json ? `${opts.system}\n\nأعد الناتج بصيغة JSON صالحة فقط بدون Markdown وبدون أي شرح خارج JSON.` : opts.system
}

function toChatMessages(opts: TextAiCallOpts): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  return [
    { role: 'system', content: promptWithJsonInstruction(opts) },
    ...opts.history.filter((m) => m.text?.trim()).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.text })),
  ]
}

function toGeminiContents(opts: TextAiCallOpts) {
  return opts.history.filter((m) => m.text?.trim()).map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.text }],
  }))
}

async function parseResponse(response: Response): Promise<any> {
  const text = await response.text().catch(() => '')
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { raw: text }
  }
}

function throwHttp(provider: string, status: number, data: any): never {
  const err: any = new Error(data?.error?.message || data?.message || data?.raw || `${provider} HTTP ${status}`)
  err.status = status
  throw err
}

function statusFromError(e: any): number | undefined {
  const status = Number(e?.status || e?.code || 0)
  return Number.isFinite(status) && status >= 100 && status <= 599 ? status : undefined
}

function recordAttempt(attempt: TextAiAttemptDiagnostics) {
  recentAttempts = [...recentAttempts, attempt].slice(-50)
  const label = attempt.ok ? 'ok' : 'failed'
  const error = attempt.error ? redactSecrets(attempt.error).slice(0, 220) : undefined
  console.info('[text-ai-router]', label, {
    provider: attempt.provider,
    model: attempt.model,
    keyIndex: attempt.keyIndex,
    ms: attempt.ms,
    status: attempt.status,
    error,
  })
}

async function callGemini(key: string, model: string, opts: TextAiCallOpts): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`
  const response = await fetchWithTimeout('Gemini', url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: toGeminiContents(opts),
      systemInstruction: { parts: [{ text: promptWithJsonInstruction(opts) }] },
      generationConfig: {
        maxOutputTokens: opts.maxOutputTokens ?? (opts.json ? 4096 : 2048),
        responseMimeType: opts.json ? 'application/json' : undefined,
      },
    }),
  }, aiProviderTimeoutMs(opts.taskLevel || 'GENERAL'), opts.deadlineMs)
  const data = await parseResponse(response)
  if (!response.ok) throwHttp('Gemini', response.status, data)
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p: any) => p?.text || '').join('\n').trim()
  if (!text) throw new Error('GEMINI_EMPTY_RESPONSE')
  return text
}

function extractOpenAiText(data: any): string {
  if (typeof data?.output_text === 'string') return data.output_text
  const chunks: string[] = []
  for (const item of data?.output || []) for (const part of item?.content || []) {
    if (typeof part?.text === 'string') chunks.push(part.text)
    if (typeof part?.content === 'string') chunks.push(part.content)
  }
  return chunks.join('\n').trim()
}

async function callOpenAIResponses(s: Settings, key: string, model: string, opts: TextAiCallOpts): Promise<string> {
  const response = await fetchWithTimeout('OpenAI', `${s.openaiBaseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: toChatMessages(opts), max_output_tokens: opts.maxOutputTokens ?? (opts.json ? 4096 : 2048) }),
  }, aiProviderTimeoutMs(opts.taskLevel || 'GENERAL'), opts.deadlineMs)
  const data = await parseResponse(response)
  if (!response.ok) throwHttp('OpenAI', response.status, data)
  const text = extractOpenAiText(data)
  if (!text) throw new Error('OPENAI_EMPTY_RESPONSE')
  return text
}

async function callAnthropic(key: string, model: string, opts: TextAiCallOpts): Promise<string> {
  const messages = opts.history.filter((m) => m.text?.trim()).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
  const response = await fetchWithTimeout('Anthropic', 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, system: promptWithJsonInstruction(opts), messages, max_tokens: opts.maxOutputTokens ?? (opts.json ? 4096 : 2048) }),
  }, aiProviderTimeoutMs(opts.taskLevel || 'GENERAL'), opts.deadlineMs)
  const data = await parseResponse(response)
  if (!response.ok) throwHttp('Anthropic', response.status, data)
  const text = (data?.content || []).map((p: any) => p?.text || '').join('\n').trim()
  if (!text) throw new Error('ANTHROPIC_EMPTY_RESPONSE')
  return text
}

async function callChatCompletions(provider: string, baseUrl: string, key: string, model: string, opts: TextAiCallOpts): Promise<string> {
  const response = await fetchWithTimeout(provider, `${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...(provider === 'OPENROUTER' ? { 'HTTP-Referer': env('NEXT_PUBLIC_APP_URL') || 'https://academy.local', 'X-Title': 'AACT Academy' } : {}),
    },
    body: JSON.stringify({
      model,
      messages: toChatMessages(opts),
      max_tokens: opts.maxOutputTokens ?? (opts.json ? 4096 : 2048),
      temperature: opts.temperature ?? (opts.json ? 0.2 : 0.6),
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      ...(provider === 'ZAI' ? { thinking: { type: model.startsWith('glm-4.5') ? 'enabled' : 'disabled' }, reasoning_effort: model.startsWith('glm-4.5') ? 'max' : undefined } : {}),
    }),
  }, aiProviderTimeoutMs(opts.taskLevel || 'GENERAL'), opts.deadlineMs)
  const data = await parseResponse(response)
  if (!response.ok) throwHttp(provider, response.status, data)
  const text = String(data?.choices?.[0]?.message?.content || '').trim()
  if (!text) throw new Error(`${provider}_EMPTY_RESPONSE`)
  return text
}

async function callProvider(provider: ConcreteProvider, s: Settings, key: string, model: string, opts: TextAiCallOpts): Promise<string> {
  if (provider === 'GEMINI') return callGemini(key, model, opts)
  if (provider === 'OPENAI') return callOpenAIResponses(s, key, model, opts)
  if (provider === 'ANTHROPIC') return callAnthropic(key, model, opts)
  return callChatCompletions(provider, baseFor(s, provider), key, model, opts)
}

function tryRepairJsonText(raw: string): { ok: true; text: string } | { ok: false; reason: string } {
  const source = String(raw || '').trim()
  const candidates: string[] = []
  const stripped = source
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim()
  candidates.push(stripped)
  const firstObject = stripped.indexOf('{')
  const lastObject = stripped.lastIndexOf('}')
  if (firstObject >= 0 && lastObject > firstObject) candidates.push(stripped.slice(firstObject, lastObject + 1))
  const firstArray = stripped.indexOf('[')
  const lastArray = stripped.lastIndexOf(']')
  if (firstArray >= 0 && lastArray > firstArray) candidates.push(stripped.slice(firstArray, lastArray + 1))
  for (const candidate of candidates) {
    const normalized = candidate
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1')
      .trim()
    try {
      return { ok: true, text: JSON.stringify(JSON.parse(normalized)) }
    } catch {
      // Try the next extracted candidate before failing the JSON response.
    }
  }
  return { ok: false, reason: 'INVALID_JSON_RESPONSE' }
}

async function callProviderWithJsonRepair(provider: ConcreteProvider, s: Settings, key: string, model: string, opts: TextAiCallOpts): Promise<{ text: string; jsonOk?: boolean; retriedJson?: boolean }> {
  const first = await callProvider(provider, s, key, model, opts)
  if (!opts.json) return { text: first }
  const repaired = tryRepairJsonText(first)
  if (repaired.ok) return { text: repaired.text, jsonOk: true }

  const retry = await callProvider(provider, s, key, model, {
    ...opts,
    system: `${opts.system}\n\nإعادة إلزامية: الرد السابق لم يكن JSON صالحاً. أعد JSON فقط بدون أي نص تمهيدي أو Markdown أو شرح.`,
    history: [
      ...opts.history,
      { role: 'model', text: first.slice(0, 2000) },
      { role: 'user', text: 'أعد نفس المطلوب بصيغة JSON صالحة فقط، بدون أي نص خارج JSON.' },
    ],
  })
  const repairedRetry = tryRepairJsonText(retry)
  if (repairedRetry.ok) return { text: repairedRetry.text, jsonOk: true, retriedJson: true }
  const error: any = new Error('INVALID_JSON_RESPONSE')
  error.code = 'INVALID_JSON_RESPONSE'
  throw error
}

function candidateKeys(provider: ConcreteProvider, s: Settings): string[] {
  const keys = providerKeys(s, provider)
  const available = keys.filter((key) => !isCooling(provider, key))
  return available.length ? available : keys
}

function routerReasonBucket(attempt: TextAiAttemptDiagnostics): string {
  const msg = String(attempt.error || '').toLowerCase()
  if (attempt.status === 404 && /no longer available|does not exist|not found/.test(msg)) return 'dead_model'
  if (attempt.status === 402 || /balance|recharge|top.?up|payment required/.test(msg)) return 'no_balance'
  if (attempt.status === 504 || /timeout|deadline|abort/.test(msg)) return 'timeout'
  if (attempt.status === 503 || /high demand|overloaded|capacity/.test(msg)) return 'high_demand'
  if (/validation_rejected|invalid_json|invalid json|invalid_type|empty_batch_after_structural_validation|schema|zod/.test(msg)) return 'schemaFail'
  if (/invalid|json/.test(msg)) return 'invalid_response'
  return attempt.ok ? 'ok' : 'other'
}

function logRouterSummary(attempts: TextAiAttemptDiagnostics[], ok: boolean): void {
  const counts: Record<string, number> = {}
  for (const attempt of attempts) counts[routerReasonBucket(attempt)] = (counts[routerReasonBucket(attempt)] || 0) + 1
  console.info('[text-ai-router] summary', { ok, attempts: attempts.length, counts })
}

function academicProviderUnavailable(attempts: TextAiAttemptDiagnostics[]): Error {
  const activeCooldowns = [...cooldowns.values()].filter((item) => item.until > Date.now())
  const err: any = new Error('AI_ACADEMIC_PROVIDER_UNAVAILABLE')
  err.code = 'AI_ACADEMIC_PROVIDER_UNAVAILABLE'
  err.retryAt = activeCooldowns.length ? new Date(Math.min(...activeCooldowns.map((item) => item.until))).toISOString() : null
  err.attempts = attempts
  return err
}

function verifierUnavailable(attempts: TextAiAttemptDiagnostics[]): Error {
  const err: any = new Error('AI_VERIFIER_UNAVAILABLE')
  err.code = 'AI_VERIFIER_UNAVAILABLE'
  err.attempts = attempts
  return err
}

function verifierSameFamilyUnavailable(attempts: TextAiAttemptDiagnostics[]): Error {
  const err: any = new Error('AI_VERIFIER_SAME_FAMILY')
  err.code = 'AI_VERIFIER_SAME_FAMILY'
  err.attempts = attempts
  return err
}

export function modelFamily(model: string): string {
  const raw = String(model || '').trim().toLowerCase()
  const normalized = raw
    .replace(/^models\//, '')
    .replace(/^google\//, '')
    .replace(/^anthropic\//, '')
    .replace(/^openai\//, '')
    .replace(/^meta-llama\//, '')
    .replace(/^qwen\//, '')
    .replace(/^deepseek\//, '')
    .replace(/^mistralai\//, '')
    .replace(/^moonshotai\//, '')
    .replace(/^cohere\//, '')
  if (/gemini|gemma/.test(normalized)) return 'gemini'
  if (/gpt[-_]?oss|\bgpt[-_]?|o\d(?:[-_]|$)|chatgpt/.test(normalized)) return 'gpt'
  if (/claude/.test(normalized)) return 'claude'
  if (/llama|codellama/.test(normalized)) return 'llama'
  if (/qwen/.test(normalized)) return 'qwen'
  if (/deepseek/.test(normalized)) return 'deepseek'
  if (/mistral|mixtral/.test(normalized)) return 'mistral'
  if (/glm/.test(normalized)) return 'glm'
  if (/nemotron/.test(normalized)) return 'nemotron'
  if (/minimax/.test(normalized)) return 'minimax'
  if (/kimi|moonshot/.test(normalized)) return 'kimi'
  if (/grok/.test(normalized)) return 'grok'
  if (/phi(?:[-_\d]|$)/.test(normalized)) return 'phi'
  if (/command|cohere/.test(normalized)) return 'cohere'
  if (/\byi(?:[-_\d]|$)/.test(normalized)) return 'yi'
  if (/ernie/.test(normalized)) return 'ernie'
  if (/hunyuan/.test(normalized)) return 'hunyuan'
  if (/\bling(?:[-_\d.]|$)/.test(normalized)) return 'ling'
  return 'unknown'
}

function excludedConcreteProviders(excludeProviders?: readonly TextAiProvider[]): Set<ConcreteProvider> {
  return new Set((excludeProviders || []).filter((provider): provider is ConcreteProvider => provider !== 'AUTO'))
}

function excludedModelFamilies(excludeModelFamilies?: readonly string[]): Set<string> {
  return new Set((excludeModelFamilies || []).map(modelFamily).filter(Boolean))
}

function modelFamilyAllowed(model: string, excludedFamilies: Set<string>): boolean {
  return !excludedFamilies.has(modelFamily(model))
}

function isVerifierCall(opts: TextAiCallOpts): boolean {
  return (opts.excludeProviders || []).some((provider) => provider !== 'AUTO')
}

function utcDateKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function utcMonthKey(): string {
  return new Date().toISOString().slice(0, 7)
}

function estimatedPaidCostUsd(opts: TextAiCallOpts): number {
  const configured = Number(env('AI_PAID_DEFAULT_CALL_COST_USD'))
  if (Number.isFinite(configured) && configured > 0) return configured
  const approxInput = opts.history.reduce((sum, item) => sum + String(item.text || '').length, 0) / 4
  const approxOutput = Number(opts.maxOutputTokens || (opts.json ? 4096 : 2048))
  return Math.max(0.002, ((approxInput + approxOutput) / 1000) * 0.01)
}

async function paidBudgetAvailable(s: Settings, estimatedCost: number): Promise<boolean> {
  if (s.paidUsageMode === 'off') return false
  if (s.openaiCompatTier !== 'PAID') return true
  const dayKey = `AI_PAID_SPEND:DAY:${utcDateKey()}`
  const monthKey = `AI_PAID_SPEND:MONTH:${utcMonthKey()}`
  try {
    const values = await settingStore().read([dayKey, monthKey])
    const day = Number(values[dayKey] || 0) || 0
    const month = Number(values[monthKey] || 0) || 0
    if (s.paidDailyLimitUsd > 0 && day + estimatedCost > s.paidDailyLimitUsd) return false
    if (s.paidMonthlyLimitUsd > 0 && month + estimatedCost > s.paidMonthlyLimitUsd) return false
    return true
  } catch {
    return false
  }
}

async function recordPaidSpend(s: Settings, estimatedCost: number): Promise<void> {
  if (s.openaiCompatTier !== 'PAID' || estimatedCost <= 0) return
  try {
    await settingStore().increment?.(`AI_PAID_SPEND:DAY:${utcDateKey()}`, estimatedCost)
    await settingStore().increment?.(`AI_PAID_SPEND:MONTH:${utcMonthKey()}`, estimatedCost)
  } catch {
    // Paid spend accounting is best-effort and must not fail a successful AI response.
  }
}

function rateWindowStart(window: 'rpm' | 'rpd') {
  const now = new Date()
  if (window === 'rpm') return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes()))
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

async function keyRateAllowed(provider: ConcreteProvider, key: string): Promise<boolean> {
  try {
    if (!hasDatabaseUrl()) return true
    const settingKey = `AI_KEY_LIMIT:${provider}`
    const raw = (await settingStore().read([settingKey]))[settingKey]
    if (!raw) return true
    const limits = JSON.parse(raw)
    const hash = keyHashForRateLimit(key)
    for (const window of ['rpm', 'rpd'] as const) {
      const max = Number(limits?.[window] || 0)
      if (!Number.isFinite(max) || max <= 0) continue
      const windowStart = rateWindowStart(window)
      await db.keyRateWindow.upsert({
        where: { keyHash_window_windowStart: { keyHash: hash, window, windowStart } },
        create: { keyHash: hash, window, windowStart, count: 1 },
        update: { count: { increment: 1 } },
      })
      const row = await db.keyRateWindow.findUnique({ where: { keyHash_window_windowStart: { keyHash: hash, window, windowStart } }, select: { count: true } })
      if ((row?.count || 0) > max) return false
    }
  } catch {
    return true
  }
  return true
}

export async function textAiComplete(opts: TextAiCallOpts): Promise<string> {
  const baseSettings = await settings()
  const s: Settings = opts.routerPolicy ? { ...baseSettings, policy: opts.routerPolicy } : baseSettings
  const taskLevel = opts.taskLevel || 'GENERAL'
  const excluded = excludedConcreteProviders(opts.excludeProviders)
  const excludedFamilies = excludedModelFamilies(opts.excludeModelFamilies)
  const sticky = opts.stickyScope ? stickyModels.get(opts.stickyScope) : null
  const orderedProviders = providerOrder(s, taskLevel).filter((provider) => !excluded.has(provider))
  const providers = sticky && orderedProviders.includes(sticky.provider)
    ? [sticky.provider, ...orderedProviders.filter((provider) => provider !== sticky.provider)]
    : orderedProviders
  if (!providers.length) {
    if (isVerifierCall(opts)) throw verifierUnavailable([])
    if (taskLevel === 'ACADEMIC_CRITICAL') throw academicProviderUnavailable([])
    throw new Error('TEXT_AI_ROUTER_NOT_CONFIGURED')
  }
  const errors: string[] = []
  const attempts: TextAiAttemptDiagnostics[] = []
  const persistentCooldowns = await loadPersistentCooldowns()
  const exploreModels = ++routerRequestSeq % 5 === 0
  const estimatedPaidCost = estimatedPaidCostUsd(opts)
  let paidAvailable: boolean | null = null
  let skippedCooldownUntil: number | null = null
  let onlySameFamilyModelsExcluded = false
  const skipModelsThisRequest = new Set<string>()

  for (const provider of providers) {
    if (provider === 'OPENAI_COMPAT' && s.openaiCompatTier === 'PAID') {
      if (paidAvailable == null) paidAvailable = await paidBudgetAvailable(s, estimatedPaidCost)
      if (!paidAvailable) continue
    }
    const candidateModels = await modelFallbacks(s, provider, taskLevel, exploreModels, opts.purpose)
    const baseModels = candidateModels.filter((model) => modelFamilyAllowed(model, excludedFamilies))
    const orderedModels = sticky && sticky.provider === provider && baseModels.includes(sticky.model)
      ? [sticky.model, ...baseModels.filter((model) => model !== sticky.model)]
      : baseModels
    const health = await readModelHealth(provider, orderedModels)
    const healthFilteredModels = orderedModels.filter((model) => !recentFailedHealth(health.get(model) || null))
    const models = healthFilteredModels.length ? healthFilteredModels : orderedModels
    if (isVerifierCall(opts) && candidateModels.length > 0 && models.length === 0) onlySameFamilyModelsExcluded = true
    for (const model of models) {
      if (skipModelsThisRequest.has(`${provider}:${model}`) || isPersistentModelDead(persistentCooldowns, provider, model)) continue
      for (const key of candidateKeys(provider, s)) {
        const keyIndex = Math.max(1, providerKeys(s, provider).indexOf(key) + 1)
        const persistedCooldown = persistentCooldown(persistentCooldowns, provider, keyIndex, model)
        if (isPersistentNoBalance(persistentCooldowns, provider, keyIndex)) continue
        if (isCooling(provider, key) || persistedCooldown) {
          if (persistedCooldown) skippedCooldownUntil = skippedCooldownUntil == null ? persistedCooldown.until : Math.min(skippedCooldownUntil, persistedCooldown.until)
          continue
        }
        if (!(await keyRateAllowed(provider, key))) continue
        if (Number.isFinite(opts.deadlineMs || NaN) && Date.now() >= Number(opts.deadlineMs)) throw deadlineExceeded()
        const started = Date.now()
        try {
          const providerResult = await callProviderWithJsonRepair(provider, s, key, model, opts)
          const text = providerResult.text
          opts.validate?.(text, { provider, model })
          const at = new Date().toISOString()
          const ms = Date.now() - started
          await recordModelStats(provider, model, { ok: true, ms, jsonOk: providerResult.jsonOk, evidenceOk: true }, opts.purpose)
          lastResult = { provider, model, ok: true, at }
          if (opts.stickyScope) stickyModels.set(opts.stickyScope, { provider, model, at: Date.now() })
          const attempt = { provider, model, keyIndex, ok: true, ms, at }
          attempts.push(attempt)
          recordAttempt(attempt)
          if (provider === 'OPENAI_COMPAT' && s.openaiCompatTier === 'PAID') await recordPaidSpend(s, estimatedPaidCost)
          if (provider === 'OPENAI' && taskLevel !== 'GENERAL') console.warn('paid fallback used: OPENAI academic router')
          logRouterSummary(attempts, true)
          return text
        } catch (e: any) {
          const at = new Date().toISOString()
          const ms = Date.now() - started
          const msg = redactSecrets(e?.message || e).slice(0, 240)
          const status = statusFromError(e)
          lastResult = { provider, model, ok: false, error: msg, at }
          const attempt = { provider, model, keyIndex, ok: false, ms, status, error: msg, at }
          attempts.push(attempt)
          recordAttempt(attempt)
          errors.push(`${provider}/${model}/key#${keyIndex}: ${msg}`)
          await recordModelStats(provider, model, { ok: false, reason: routerReasonBucket(attempt), ms, jsonOk: opts.json ? false : undefined, evidenceOk: e?.code === 'VALIDATION_REJECTED' ? false : undefined }, opts.purpose)
          if (isSchemaFailureLike(e)) {
            skipModelsThisRequest.add(`${provider}:${model}`)
            break
          }
          if (isDeadModelLike(e)) {
            skipModelsThisRequest.add(`${provider}:${model}`)
            await markPersistentModelDead(provider, model, msg, status)
            break
          }
          if (isNoBalanceLike(e)) {
            markCooldown(provider, key, msg, 24 * 60)
            await markPersistentNoBalance(provider, keyIndex, msg, status)
            continue
          }
          if (isHighDemandLike(e)) {
            skipModelsThisRequest.add(`${provider}:${model}`)
            markCooldown(provider, key, msg, 1)
            await markPersistentCooldown(provider, keyIndex, model, msg, status, 1)
            break
          }
          if (isTimeoutLike(e)) {
            markCooldown(provider, key, msg, 2)
            if (status === 503 || status === 504) await markPersistentCooldown(provider, keyIndex, model, msg, status, 2)
          }
          if (isQuotaLike(e)) {
            markCooldown(provider, key, msg)
            await markPersistentCooldown(provider, keyIndex, model, msg, status)
          }
          if (isAuthLike(e)) {
            markCooldown(provider, key, msg, 60)
            await markPersistentCooldown(provider, keyIndex, model, msg, status, 60)
          }
        }
      }
    }
  }

  logRouterSummary(attempts, false)
  if (Number.isFinite(opts.deadlineMs || NaN) && Date.now() >= Number(opts.deadlineMs)) throw deadlineExceeded()
  if (isVerifierCall(opts) && attempts.length === 0 && onlySameFamilyModelsExcluded) throw verifierSameFamilyUnavailable(attempts)
  if (isVerifierCall(opts)) throw verifierUnavailable(attempts)
  if (taskLevel === 'ACADEMIC_CRITICAL') {
    const err: any = academicProviderUnavailable(attempts)
    if (skippedCooldownUntil) err.retryAt = new Date(skippedCooldownUntil).toISOString()
    throw err
  }
  throw new Error(errors.join(' | ') || 'TEXT_AI_ROUTER_FAILED')
}

export async function textAiCompleteWithMetadata(opts: TextAiCallOpts): Promise<TextAiCompletionResult> {
  let context: { provider?: string; model?: string } = {}
  const text = await textAiComplete({
    ...opts,
    validate: (output, providerContext) => {
      opts.validate?.(output, providerContext)
      context = providerContext || {}
    },
  })
  if (!context.provider || !context.model) throw new Error('TEXT_AI_ROUTER_MISSING_PROVIDER_METADATA')
  return { text, provider: context.provider as ConcreteProvider, model: context.model }
}

export async function textAiCompleteJsonWithMetadata(opts: Omit<TextAiCallOpts, 'json'>): Promise<TextAiCompletionResult> {
  return textAiCompleteWithMetadata({ ...opts, json: true })
}

export async function textAiCompleteJson(opts: Omit<TextAiCallOpts, 'json'>): Promise<string> {
  return textAiComplete({ ...opts, json: true })
}

export async function* textAiStreamText(opts: TextAiCallOpts): AsyncGenerator<string> {
  yield await textAiComplete(opts)
}

export async function textAiTestConnection(): Promise<{ ok: boolean; provider?: string; model?: string; reply?: string; error?: string }> {
  const s = await settings()
  const providers = providerOrder(s)
  if (!providers.length) return { ok: false, error: 'TEXT_AI_ROUTER_NOT_CONFIGURED' }
  const errors: string[] = []
  for (const provider of providers) {
    for (const model of await modelFallbacks(s, provider)) {
      for (const key of candidateKeys(provider, s).slice(0, 2)) {
        const started = Date.now()
        const keyIndex = Math.max(1, providerKeys(s, provider).indexOf(key) + 1)
        try {
          const reply = await callProvider(provider, s, key, model, { system: 'أجب بكلمة واحدة فقط.', history: [{ role: 'user', text: 'اكتب: جاهز' }], maxOutputTokens: 32 })
          const at = new Date().toISOString()
          const ms = Date.now() - started
          lastResult = { provider, model, ok: true, at }
          recordAttempt({ provider, model, keyIndex, ok: true, ms, at })
          return { ok: true, provider, model, reply }
        } catch (e: any) {
          const at = new Date().toISOString()
          const ms = Date.now() - started
          const msg = String(e?.message || e).slice(0, 260)
          const status = statusFromError(e)
          lastResult = { provider, model, ok: false, error: msg, at }
          recordAttempt({ provider, model, keyIndex, ok: false, ms, status, error: msg, at })
          errors.push(`${provider}/${model}/key#${keyIndex}: ${msg}`)
          if (isTimeoutLike(e)) markCooldown(provider, key, msg, 2)
          if (isQuotaLike(e)) markCooldown(provider, key, msg)
          if (isAuthLike(e)) markCooldown(provider, key, msg, 60)
        }
      }
    }
  }
  return { ok: false, error: errors.slice(0, 4).join(' | ') || 'تعذر اختبار أي مزود نصوص متاح. راجع المفاتيح أو النماذج أو حالة cooldown.' }
}
