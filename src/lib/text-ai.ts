import { createHash } from 'crypto'
import { db } from '@/lib/db'

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
  | 'OPENAI_COMPAT'
  | 'AUTO'

export type TextAiRouterPolicy = 'primary_first' | 'balanced' | 'quality_first' | 'cost_saver' | 'fallback_only'

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
  openaiCompatModel: string
  keyCounts: Record<string, number>
  cooldowns: Array<{ provider: string; key: string; until: string; reason: string }>
  lastResult: { provider: string; model: string; ok: boolean; error?: string; at: string } | null
  message: string
}

const OPENAI_TEXT_MODELS = ['gpt-5.1', 'gpt-5', 'gpt-5-mini']
const ANTHROPIC_TEXT_MODELS = ['claude-opus-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022']
const ZAI_TEXT_MODELS = ['glm-4.5', 'glm-4.5-air', 'glm-4.5-x', 'glm-4.5-airx']
const GEMINI_TEXT_MODELS = ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.0-flash']
const GROQ_TEXT_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']
const OPENROUTER_TEXT_MODELS = ['openrouter/auto', 'meta-llama/llama-3.1-8b-instruct:free']
const DEEPINFRA_TEXT_MODELS = ['meta-llama/Llama-3.3-70B-Instruct', 'meta-llama/Meta-Llama-3.1-8B-Instruct']
const TOGETHER_TEXT_MODELS = ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo']
const UNOROUTER_TEXT_MODELS = ['gpt-oss-120b:free', 'deepseek/deepseek-chat:free']
const RELAYROUTER_TEXT_MODELS = ['relayrouter/auto', 'claude-opus-4-8', 'gpt-5.5', 'gemini-3.5-flash']
const OPENAI_COMPAT_TEXT_MODELS = ['auto']

const cooldowns = new Map<string, { until: number; reason: string }>()
let roundRobin = 0
let lastResult: TextAiDiagnostics['lastResult'] = null

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
  const allowed: TextAiProvider[] = ['GEMINI', 'OPENAI', 'ANTHROPIC', 'ZAI', 'GROQ', 'OPENROUTER', 'DEEPINFRA', 'TOGETHER', 'UNOROUTER', 'RELAYROUTER', 'OPENAI_COMPAT', 'AUTO']
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

function isQuotaLike(e: any): boolean {
  const msg = String(e?.message || e || '').toLowerCase()
  const status = Number(e?.status || e?.code || 0)
  return status === 429 || /quota|rate.?limit|resource exhausted|too many requests|insufficient_quota|capacity/i.test(msg)
}

function isAuthLike(e: any): boolean {
  const msg = String(e?.message || e || '').toLowerCase()
  const status = Number(e?.status || e?.code || 0)
  return status === 401 || status === 403 || /api key|unauthorized|permission|forbidden|invalid key/i.test(msg)
}

async function readSettings(keys: string[]): Promise<Record<string, string>> {
  try {
    const rows = await db.setting.findMany({ where: { key: { in: keys } } })
    const out: Record<string, string> = {}
    for (const key of keys) out[key] = ''
    for (const row of rows) out[row.key] = String(row.value || '').trim()
    return out
  } catch {
    return Object.fromEntries(keys.map((k) => [k, '']))
  }
}

async function settings() {
  const rows = await readSettings([
    'AI_TEXT_PROVIDER', 'AI_ROUTER_POLICY', 'AI_ROUTER_ALLOW_PUBLIC_GATEWAYS',
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
    'OPENAI_COMPAT_API_KEY', 'OPENAI_COMPAT_API_KEYS', 'OPENAI_COMPAT_TEXT_MODEL', 'OPENAI_COMPAT_BASE_URL',
  ])
  const provider = normalizeProvider(rows.AI_TEXT_PROVIDER || env('AI_TEXT_PROVIDER') || 'GEMINI')
  const policy = normalizePolicy(rows.AI_ROUTER_POLICY || env('AI_ROUTER_POLICY') || 'primary_first')
  return {
    provider,
    policy,
    allowPublicGateways: ['1', 'true', 'yes', 'on'].includes(String(rows.AI_ROUTER_ALLOW_PUBLIC_GATEWAYS || env('AI_ROUTER_ALLOW_PUBLIC_GATEWAYS') || '').toLowerCase()),
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
    case 'OPENAI_COMPAT': return s.openaiCompatBaseUrl
    default: return ''
  }
}

function baseOrder(s: Settings): ConcreteProvider[] {
  const selected = s.provider === 'AUTO' ? null : s.provider
  const quality: ConcreteProvider[] = ['ANTHROPIC', 'OPENAI', 'GEMINI', 'RELAYROUTER', 'ZAI', 'GROQ', 'OPENROUTER', 'DEEPINFRA', 'TOGETHER', 'UNOROUTER', 'OPENAI_COMPAT']
  const cost: ConcreteProvider[] = ['GROQ', 'ZAI', 'RELAYROUTER', 'OPENROUTER', 'DEEPINFRA', 'TOGETHER', 'UNOROUTER', 'OPENAI_COMPAT', 'GEMINI', 'OPENAI', 'ANTHROPIC']
  const primary: ConcreteProvider[] = selected
    ? [selected, ...quality.filter((p) => p !== selected)]
    : ['GEMINI', 'OPENAI', 'ANTHROPIC', 'ZAI', 'GROQ', 'RELAYROUTER', 'OPENROUTER', 'DEEPINFRA', 'TOGETHER', 'UNOROUTER', 'OPENAI_COMPAT']
  if (s.policy === 'quality_first') return quality
  if (s.policy === 'cost_saver') return cost
  if (s.policy === 'fallback_only' && selected) return [selected]
  if (s.policy === 'balanced') return primary.slice(roundRobin++ % Math.max(1, primary.length)).concat(primary.slice(0, (roundRobin - 1) % Math.max(1, primary.length)))
  return primary
}

function providerOrder(s: Settings): ConcreteProvider[] {
  const publicGateways = new Set<ConcreteProvider>(['OPENROUTER', 'DEEPINFRA', 'TOGETHER', 'UNOROUTER', 'RELAYROUTER', 'OPENAI_COMPAT'])
  return baseOrder(s).filter((provider) => {
    if (!providerKeys(s, provider).length) return false
    if (publicGateways.has(provider) && !s.allowPublicGateways && s.provider !== provider) return false
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
    openaiCompatModel: s.openaiCompatModel,
    keyCounts: counts,
    cooldowns: cooldownList(),
    lastResult,
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

async function callGemini(key: string, model: string, opts: TextAiCallOpts): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`
  const response = await fetch(url, {
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
  })
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
  const response = await fetch(`${s.openaiBaseUrl}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: toChatMessages(opts), max_output_tokens: opts.maxOutputTokens ?? (opts.json ? 4096 : 2048) }),
  })
  const data = await parseResponse(response)
  if (!response.ok) throwHttp('OpenAI', response.status, data)
  const text = extractOpenAiText(data)
  if (!text) throw new Error('OPENAI_EMPTY_RESPONSE')
  return text
}

async function callAnthropic(key: string, model: string, opts: TextAiCallOpts): Promise<string> {
  const messages = opts.history.filter((m) => m.text?.trim()).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }))
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, system: promptWithJsonInstruction(opts), messages, max_tokens: opts.maxOutputTokens ?? (opts.json ? 4096 : 2048) }),
  })
  const data = await parseResponse(response)
  if (!response.ok) throwHttp('Anthropic', response.status, data)
  const text = (data?.content || []).map((p: any) => p?.text || '').join('\n').trim()
  if (!text) throw new Error('ANTHROPIC_EMPTY_RESPONSE')
  return text
}

async function callChatCompletions(provider: string, baseUrl: string, key: string, model: string, opts: TextAiCallOpts): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
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
      ...(provider === 'ZAI' ? { thinking: { type: model.startsWith('glm-4.5') ? 'enabled' : 'disabled' }, reasoning_effort: model.startsWith('glm-4.5') ? 'max' : undefined } : {}),
    }),
  })
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

function candidateKeys(provider: ConcreteProvider, s: Settings): string[] {
  const keys = providerKeys(s, provider)
  const available = keys.filter((key) => !isCooling(provider, key))
  return available.length ? available : keys
}

export async function textAiComplete(opts: TextAiCallOpts): Promise<string> {
  const s = await settings()
  const providers = providerOrder(s)
  if (!providers.length) throw new Error('TEXT_AI_ROUTER_NOT_CONFIGURED')
  const errors: string[] = []

  for (const provider of providers) {
    const model = modelFor(s, provider)
    for (const key of candidateKeys(provider, s)) {
      if (isCooling(provider, key)) continue
      try {
        const text = await callProvider(provider, s, key, model, opts)
        lastResult = { provider, model, ok: true, at: new Date().toISOString() }
        return text
      } catch (e: any) {
        const msg = String(e?.message || e).slice(0, 240)
        lastResult = { provider, model, ok: false, error: msg, at: new Date().toISOString() }
        errors.push(`${provider}/${model}/${keyHash(key)}: ${msg}`)
        if (isQuotaLike(e)) markCooldown(provider, key, msg)
        if (isAuthLike(e)) markCooldown(provider, key, msg, 60)
      }
    }
  }

  throw new Error(errors.join(' | ') || 'TEXT_AI_ROUTER_FAILED')
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
  for (const provider of providers) {
    const model = modelFor(s, provider)
    for (const key of candidateKeys(provider, s).slice(0, 2)) {
      try {
        const reply = await callProvider(provider, s, key, model, { system: 'أجب بكلمة واحدة فقط.', history: [{ role: 'user', text: 'اكتب: جاهز' }], maxOutputTokens: 32 })
        lastResult = { provider, model, ok: true, at: new Date().toISOString() }
        return { ok: true, provider, model, reply }
      } catch (e: any) {
        const msg = String(e?.message || e).slice(0, 240)
        lastResult = { provider, model, ok: false, error: msg, at: new Date().toISOString() }
        if (isQuotaLike(e)) markCooldown(provider, key, msg)
        if (isAuthLike(e)) markCooldown(provider, key, msg, 60)
      }
    }
  }
  return { ok: false, error: 'تعذر اختبار أي مزود نصوص متاح. راجع المفاتيح أو النماذج أو حالة cooldown.' }
}
