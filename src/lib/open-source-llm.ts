import { db } from '@/lib/db'

type ChatRole = 'system' | 'user' | 'assistant'

export interface LocalChatMessage {
  role: ChatRole
  content: string
}

export interface LocalAgentConfig {
  enabled: boolean
  provider: 'LOCAL_OPENAI' | 'GEMINI' | 'AUTO'
  baseUrl: string
  model: string
  apiKey: string
  source: 'settings' | 'env' | 'none'
}

function cleanBaseUrl(v: string): string {
  return String(v || '').trim().replace(/\/+$/, '')
}

async function settingValue(key: string): Promise<string> {
  return (await db.setting.findUnique({ where: { key } }).catch(() => null))?.value?.trim() || ''
}

export async function localAgentConfig(): Promise<LocalAgentConfig> {
  const provider = ((await settingValue('AI_AGENT_PROVIDER')) || process.env.AI_AGENT_PROVIDER || 'AUTO').trim().toUpperCase()
  const settingsBase = await settingValue('AI_AGENT_BASE_URL')
  const settingsModel = await settingValue('AI_AGENT_MODEL')
  const settingsKey = await settingValue('AI_AGENT_API_KEY')
  const envBase = process.env.AI_AGENT_BASE_URL || process.env.OPENAI_COMPATIBLE_BASE_URL || process.env.OLLAMA_BASE_URL || ''
  const envModel = process.env.AI_AGENT_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct'
  const baseUrl = cleanBaseUrl(settingsBase || envBase)
  const model = (settingsModel || envModel || '').trim()
  const apiKey = settingsKey || process.env.AI_AGENT_API_KEY || process.env.OPENAI_COMPATIBLE_API_KEY || 'ollama'
  const effectiveProvider = provider === 'LOCAL_OPENAI' || provider === 'GEMINI' ? provider : 'AUTO'
  return {
    enabled: !!baseUrl && !!model && effectiveProvider !== 'GEMINI',
    provider: effectiveProvider as LocalAgentConfig['provider'],
    baseUrl,
    model,
    apiKey,
    source: settingsBase || settingsModel || settingsKey ? 'settings' : baseUrl ? 'env' : 'none',
  }
}

export async function localAgentDiagnostics() {
  const c = await localAgentConfig()
  return {
    enabled: c.enabled,
    provider: c.provider,
    source: c.source,
    baseUrl: c.baseUrl ? c.baseUrl.replace(/:\/\/.*@/, '://••••@') : '',
    model: c.model,
  }
}

function endpoint(baseUrl: string): string {
  const b = cleanBaseUrl(baseUrl)
  if (b.endsWith('/v1')) return `${b}/chat/completions`
  if (b.endsWith('/v1/chat/completions')) return b
  return `${b}/v1/chat/completions`
}

export async function localChatComplete(opts: {
  messages: LocalChatMessage[]
  temperature?: number
  maxTokens?: number
}): Promise<string> {
  const cfg = await localAgentConfig()
  if (!cfg.enabled) throw new Error('LOCAL_AGENT_NOT_CONFIGURED')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 45_000)
  try {
    const res = await fetch(endpoint(cfg.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey || 'ollama'}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: opts.messages,
        temperature: opts.temperature ?? 0.35,
        max_tokens: opts.maxTokens ?? 1800,
        stream: false,
      }),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`LOCAL_AGENT_HTTP_${res.status}: ${text.slice(0, 500)}`)
    let json: any
    try { json = JSON.parse(text) } catch { throw new Error(`LOCAL_AGENT_BAD_JSON: ${text.slice(0, 300)}`) }
    const out = json?.choices?.[0]?.message?.content || json?.message?.content || json?.response || ''
    if (!String(out).trim()) throw new Error('LOCAL_AGENT_EMPTY_RESPONSE')
    return String(out).trim()
  } finally {
    clearTimeout(timeout)
  }
}

export async function testLocalAgentConnection(): Promise<{ ok: boolean; message: string; model?: string; error?: string }> {
  try {
    const cfg = await localAgentConfig()
    if (!cfg.enabled) return { ok: false, message: 'لم يتم ضبط نموذج محلي/مفتوح المصدر بعد.' }
    const reply = await localChatComplete({ messages: [{ role: 'user', content: 'أجب بكلمة واحدة فقط: جاهز' }], maxTokens: 32, temperature: 0 })
    return { ok: true, message: reply, model: cfg.model }
  } catch (e: any) {
    return { ok: false, message: 'فشل اختبار النموذج المحلي', error: String(e?.message || e).slice(0, 500) }
  }
}
