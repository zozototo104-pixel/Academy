import { db } from '@/lib/db'

export type TextAiProvider = 'GEMINI' | 'OPENAI' | 'ANTHROPIC' | 'ZAI' | 'AUTO'

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
  activeProvider: Exclude<TextAiProvider, 'GEMINI' | 'AUTO'> | null
  externalConfigured: boolean
  openaiConfigured: boolean
  anthropicConfigured: boolean
  zaiConfigured: boolean
  openaiModel: string
  anthropicModel: string
  zaiModel: string
  message: string
}

const OPENAI_TEXT_MODELS = [
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
]

const ANTHROPIC_TEXT_MODELS = [
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1-20250805',
  'claude-sonnet-4-20250514',
  'claude-3-7-sonnet-20250219',
  'claude-3-5-haiku-20241022',
]

const ZAI_TEXT_MODELS = [
  'glm-4.5',
  'glm-4.5-air',
  'glm-4.5-x',
  'glm-4.5-airx',
]

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
  if (v === 'OPENAI' || v === 'ANTHROPIC' || v === 'ZAI' || v === 'AUTO' || v === 'GEMINI') return v
  return 'GEMINI'
}

function normalizeModel(value: unknown, defaults: string[]): string {
  const v = clean(value)
  if (!v || v === 'auto') return defaults[0]
  if (defaults.includes(v)) return v
  return /^[a-z0-9][a-z0-9_.:-]{2,120}$/i.test(v) ? v : defaults[0]
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
    'AI_TEXT_PROVIDER',
    'OPENAI_API_KEY', 'OPENAI_TEXT_MODEL', 'OPENAI_BASE_URL',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_TEXT_MODEL',
    'ZAI_API_KEY', 'ZAI_TEXT_MODEL', 'ZAI_API_BASE',
  ])
  const provider = normalizeProvider(rows.AI_TEXT_PROVIDER || env('AI_TEXT_PROVIDER') || 'GEMINI')
  const openaiKey = rows.OPENAI_API_KEY || env('OPENAI_API_KEY')
  const anthropicKey = rows.ANTHROPIC_API_KEY || env('ANTHROPIC_API_KEY')
  const zaiKey = rows.ZAI_API_KEY || env('ZAI_API_KEY')
  return {
    provider,
    openaiKey,
    openaiModel: normalizeModel(rows.OPENAI_TEXT_MODEL || env('OPENAI_TEXT_MODEL'), OPENAI_TEXT_MODELS),
    openaiBaseUrl: (rows.OPENAI_BASE_URL || env('OPENAI_BASE_URL') || 'https://api.openai.com/v1').replace(/\/$/, ''),
    anthropicKey,
    anthropicModel: normalizeModel(rows.ANTHROPIC_TEXT_MODEL || env('ANTHROPIC_TEXT_MODEL'), ANTHROPIC_TEXT_MODELS),
    zaiKey,
    zaiModel: normalizeModel(rows.ZAI_TEXT_MODEL || env('ZAI_TEXT_MODEL'), ZAI_TEXT_MODELS),
    zaiBaseUrl: (rows.ZAI_API_BASE || env('ZAI_API_BASE') || 'https://api.z.ai/api/paas/v4').replace(/\/$/, ''),
  }
}

function providerOrder(s: Awaited<ReturnType<typeof settings>>): Array<Exclude<TextAiProvider, 'GEMINI' | 'AUTO'>> {
  if (s.provider === 'OPENAI') return s.openaiKey ? ['OPENAI'] : []
  if (s.provider === 'ANTHROPIC') return s.anthropicKey ? ['ANTHROPIC'] : []
  if (s.provider === 'ZAI') return s.zaiKey ? ['ZAI'] : []
  if (s.provider === 'AUTO') {
    const order: Array<Exclude<TextAiProvider, 'GEMINI' | 'AUTO'>> = []
    if (s.openaiKey) order.push('OPENAI')
    if (s.anthropicKey) order.push('ANTHROPIC')
    if (s.zaiKey) order.push('ZAI')
    return order
  }
  return []
}

export async function hasExternalTextAi(): Promise<boolean> {
  const s = await settings()
  return providerOrder(s).length > 0
}

export async function textAiDiagnostics(): Promise<TextAiDiagnostics> {
  const s = await settings()
  const order = providerOrder(s)
  return {
    selectedProvider: s.provider,
    activeProvider: order[0] || null,
    externalConfigured: order.length > 0,
    openaiConfigured: !!s.openaiKey,
    anthropicConfigured: !!s.anthropicKey,
    zaiConfigured: !!s.zaiKey,
    openaiModel: s.openaiModel,
    anthropicModel: s.anthropicModel,
    zaiModel: s.zaiModel,
    message: order.length
      ? `مزود النصوص الخارجي النشط: ${order[0]}`
      : s.provider === 'GEMINI'
        ? 'مزود النصوص مضبوط على Gemini.'
        : 'مزود النصوص الخارجي المختار غير مكتمل الإعدادات.',
  }
}

function promptWithJsonInstruction(opts: TextAiCallOpts): string {
  return opts.json
    ? `${opts.system}\n\nأعد الناتج بصيغة JSON صالحة فقط بدون Markdown وبدون أي شرح خارج JSON.`
    : opts.system
}

function toChatMessages(opts: TextAiCallOpts): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  return [
    { role: 'system', content: promptWithJsonInstruction(opts) },
    ...opts.history.filter((m) => m.text?.trim()).map((m) => ({
      role: m.role === 'user' ? 'user' as const : 'assistant' as const,
      content: m.text,
    })),
  ]
}

function extractOpenAiText(data: any): string {
  if (typeof data?.output_text === 'string') return data.output_text
  const chunks: string[] = []
  for (const item of data?.output || []) {
    for (const part of item?.content || []) {
      if (typeof part?.text === 'string') chunks.push(part.text)
      if (typeof part?.content === 'string') chunks.push(part.content)
    }
  }
  return chunks.join('\n').trim()
}

async function callOpenAI(s: Awaited<ReturnType<typeof settings>>, model: string, opts: TextAiCallOpts): Promise<string> {
  const response = await fetch(`${s.openaiBaseUrl}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${s.openaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: toChatMessages(opts),
      temperature: opts.temperature ?? (opts.json ? 0.25 : 0.6),
      max_output_tokens: opts.maxOutputTokens ?? (opts.json ? 4096 : 2048),
    }),
  })
  const data: any = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `OpenAI HTTP ${response.status}`)
  const text = extractOpenAiText(data).trim()
  if (!text) throw new Error('OPENAI_EMPTY_RESPONSE')
  return text
}

async function callAnthropic(s: Awaited<ReturnType<typeof settings>>, model: string, opts: TextAiCallOpts): Promise<string> {
  const messages = opts.history.filter((m) => m.text?.trim()).map((m) => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.text,
  }))
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': s.anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      system: promptWithJsonInstruction(opts),
      messages,
      max_tokens: opts.maxOutputTokens ?? (opts.json ? 4096 : 2048),
      temperature: opts.temperature ?? (opts.json ? 0.25 : 0.6),
    }),
  })
  const data: any = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `Anthropic HTTP ${response.status}`)
  const text = (data?.content || []).map((p: any) => p?.text || '').join('\n').trim()
  if (!text) throw new Error('ANTHROPIC_EMPTY_RESPONSE')
  return text
}

async function callZAI(s: Awaited<ReturnType<typeof settings>>, model: string, opts: TextAiCallOpts): Promise<string> {
  const response = await fetch(`${s.zaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${s.zaiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: toChatMessages(opts),
      temperature: opts.temperature ?? (opts.json ? 0.25 : 0.6),
      max_tokens: opts.maxOutputTokens ?? (opts.json ? 4096 : 2048),
      thinking: { type: model.startsWith('glm-4.5') ? 'enabled' : 'disabled' },
      reasoning_effort: model.startsWith('glm-4.5') ? 'max' : undefined,
    }),
  })
  const data: any = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `ZAI HTTP ${response.status}`)
  const text = String(data?.choices?.[0]?.message?.content || '').trim()
  if (!text) throw new Error('ZAI_EMPTY_RESPONSE')
  return text
}

function modelChain(provider: Exclude<TextAiProvider, 'GEMINI' | 'AUTO'>, s: Awaited<ReturnType<typeof settings>>): string[] {
  if (provider === 'OPENAI') return [...new Set([s.openaiModel, ...OPENAI_TEXT_MODELS])]
  if (provider === 'ANTHROPIC') return [...new Set([s.anthropicModel, ...ANTHROPIC_TEXT_MODELS])]
  return [...new Set([s.zaiModel, ...ZAI_TEXT_MODELS])]
}

async function callProvider(provider: Exclude<TextAiProvider, 'GEMINI' | 'AUTO'>, s: Awaited<ReturnType<typeof settings>>, model: string, opts: TextAiCallOpts): Promise<string> {
  if (provider === 'OPENAI') return callOpenAI(s, model, opts)
  if (provider === 'ANTHROPIC') return callAnthropic(s, model, opts)
  return callZAI(s, model, opts)
}

export async function textAiComplete(opts: TextAiCallOpts): Promise<string> {
  const s = await settings()
  const providers = providerOrder(s)
  if (!providers.length) throw new Error('TEXT_AI_EXTERNAL_NOT_CONFIGURED')
  const errors: string[] = []
  for (const provider of providers) {
    for (const model of modelChain(provider, s)) {
      try {
        return await callProvider(provider, s, model, opts)
      } catch (e: any) {
        errors.push(`${provider}/${model}: ${String(e?.message || e).slice(0, 180)}`)
      }
    }
  }
  throw new Error(errors.join(' | ') || 'TEXT_AI_EXTERNAL_FAILED')
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
  if (!providers.length) return { ok: false, error: 'TEXT_AI_EXTERNAL_NOT_CONFIGURED' }
  for (const provider of providers) {
    for (const model of modelChain(provider, s).slice(0, 2)) {
      try {
        const reply = await callProvider(provider, s, model, {
          system: 'أجب بكلمة واحدة فقط.',
          history: [{ role: 'user', text: 'اكتب: جاهز' }],
          temperature: 0.1,
          maxOutputTokens: 32,
        })
        return { ok: true, provider, model, reply }
      } catch (e: any) {
        if (/401|403|invalid api key|permission|unauthorized/i.test(String(e?.message || e))) {
          return { ok: false, provider, model, error: String(e?.message || e).slice(0, 240) }
        }
      }
    }
  }
  return { ok: false, error: 'تعذر اختبار مزود النصوص الخارجي.' }
}
