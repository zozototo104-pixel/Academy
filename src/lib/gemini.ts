import { GoogleGenAI } from '@google/genai'
import { db } from '@/lib/db'
import { hasExternalTextAi, textAiCompleteJson, textAiStreamText } from '@/lib/text-ai'

export interface GeminiTurn {
  role: 'user' | 'model'
  text: string
}

interface GeminiCallOpts {
  system: string
  history: GeminiTurn[]
  temperature?: number
  thinkingBudget?: number
  thinkingLevel?: GeminiThinkingLevel
  maxOutputTokens?: number
}

const TEXT_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-2.5-flash',
]

const TTS_MODELS = [
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts',
]

export type GeminiLivePurpose = 'SUPERVISOR' | 'DISCUSSION'
export type GeminiThinkingLevel = 'low' | 'medium' | 'high'

const SUPERVISOR_LIVE_MODELS = [
  // المشرف اليومي: أقل تأخير للمحادثة الصوتية المباشرة.
  'gemini-3.8-live',
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-2.5-flash-live-preview',
]

const DISCUSSION_LIVE_MODELS = [
  // المناقشة الأكاديمية: تفكير أعمق أثناء الحوار الحي.
  'gemini-3.8-live-extended-thinking',
  'gemini-3.8-live',
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
]

const VISION_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
]

export const GEMINI_LIVE_MODEL_FALLBACKS = SUPERVISOR_LIVE_MODELS
export const GEMINI_DISCUSSION_LIVE_MODEL_FALLBACKS = DISCUSSION_LIVE_MODELS

let dbFetchedAt = 0
let dbInflight: Promise<void> | null = null
let dbKeyCache = ''
let dbVoiceCache = ''
let dbTextModelCache = ''
let dbTtsModelCache = ''
let dbLiveModelCache = ''
let dbSupervisorLiveModelCache = ''
let dbDiscussionLiveModelCache = ''
let dbDiscussionThinkingLevelCache = ''
let geminiInstance: GoogleGenAI | null = null
let instanceKey = ''
let activeTextModel: string | null = null
let activeTtsModel: string | null = null
let activeSupervisorLiveModel: string | null = null
let activeDiscussionLiveModel: string | null = null

async function readSetting(key: string): Promise<string> {
  try {
    const row = await db.setting.findUnique({ where: { key } })
    return String(row?.value || '').trim()
  } catch {
    return ''
  }
}

async function refreshFromDb(force = false): Promise<void> {
  if (!force && Date.now() - dbFetchedAt < 15_000) return
  if (dbInflight) return dbInflight
  dbInflight = (async () => {
    try {
      const [key, voice, textModel, ttsModel, liveModel, supervisorLiveModel, discussionLiveModel, discussionThinkingLevel] = await Promise.all([
        readSetting('GEMINI_API_KEY'),
        readSetting('GEMINI_TTS_VOICE'),
        readSetting('GEMINI_TEXT_MODEL'),
        readSetting('GEMINI_TTS_MODEL'),
        readSetting('GEMINI_LIVE_MODEL'),
        readSetting('GEMINI_SUPERVISOR_LIVE_MODEL'),
        readSetting('GEMINI_DISCUSSION_LIVE_MODEL'),
        readSetting('GEMINI_DISCUSSION_THINKING_LEVEL'),
      ])
      dbKeyCache = key
      dbVoiceCache = voice
      dbTextModelCache = normalizeGeminiModelName(textModel)
      dbTtsModelCache = normalizeGeminiModelName(ttsModel)
      dbLiveModelCache = normalizeGeminiModelName(liveModel)
      dbSupervisorLiveModelCache = normalizeGeminiModelName(supervisorLiveModel)
      dbDiscussionLiveModelCache = normalizeGeminiModelName(discussionLiveModel)
      dbDiscussionThinkingLevelCache = normalizeGeminiThinkingLevel(discussionThinkingLevel)
      dbFetchedAt = Date.now()
    } finally {
      dbInflight = null
    }
  })()
  return dbInflight
}

void refreshFromDb()

export function normalizeGeminiModelName(value: unknown): string {
  let v = String(value || '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/^models\//, '')
    .replace(/[?&#].*$/, '')
    .trim()
  if (!v || v === 'auto') return ''
  if (v === 'gemini-2.5-flash-lite') return 'gemini-3.5-flash-lite'
  if (v === 'gemini-2.5-flash-live-preview') return 'gemini-2.5-flash-native-audio-preview-12-2025'
  const known = [...TEXT_MODELS, ...TTS_MODELS, ...SUPERVISOR_LIVE_MODELS, ...DISCUSSION_LIVE_MODELS, ...VISION_MODELS]
  if (known.includes(v)) return v
  for (const model of known) {
    if (v.includes(model) || v.endsWith(model.slice(2)) || v.endsWith(model.slice(4))) return model
  }
  const m = v.match(/gemini-[a-z0-9_.-]*(?:flash|pro|live|tts)[a-z0-9_.-]*/i)
  if (m) return m[0]
  return /^[a-z0-9][a-z0-9_.-]{2,90}$/i.test(v) ? v : ''
}

export function normalizeGeminiThinkingLevel(value: unknown): GeminiThinkingLevel {
  const v = String(value || '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .toLowerCase()
  return v === 'low' || v === 'medium' || v === 'high' ? v : 'high'
}

export function isValidGeminiLiveModel(value: unknown): boolean {
  const v = normalizeGeminiModelName(value)
  return SUPERVISOR_LIVE_MODELS.includes(v) || DISCUSSION_LIVE_MODELS.includes(v) || /^gemini-[\w.-]*live[\w.-]*$/i.test(v)
}

function resolvedKey(): string {
  // مفتاح لوحة الإدارة له الأولوية حتى يستطيع المدير تبديل المفتاح فوراً عند انتهاء الحصة.
  // إذا تُركت الخانة فارغة أو حُذف المفتاح من الإعدادات، يعود النظام تلقائياً إلى مفتاح البيئة في Vercel.
  return dbKeyCache || process.env.GEMINI_API_KEY?.trim() || ''
}

export async function ensureGeminiKey(): Promise<boolean> {
  await refreshFromDb()
  return resolvedKey().length > 0
}

export function hasGemini(): boolean {
  return resolvedKey().length > 0
}

export function geminiKeySource(): 'env' | 'db' | 'none' {
  if (dbKeyCache) return 'db'
  if (process.env.GEMINI_API_KEY?.trim()) return 'env'
  return 'none'
}

export async function geminiKeyDiagnostics(): Promise<{ source: 'env' | 'db' | 'none'; adminKeySet: boolean; envKeySet: boolean; activeMask: string }> {
  await refreshFromDb(true)
  const key = resolvedKey()
  const maskKey = (v: string) => v ? `${v.slice(0, 4)}••••${v.slice(-4)}` : ''
  return {
    source: geminiKeySource(),
    adminKeySet: !!dbKeyCache,
    envKeySet: !!process.env.GEMINI_API_KEY?.trim(),
    activeMask: maskKey(key),
  }
}

export function invalidateGeminiKeyCache(): void {
  dbFetchedAt = 0
  void refreshFromDb(true)
}

export async function geminiApiKey(): Promise<string> {
  await refreshFromDb()
  return resolvedKey()
}

export function getGemini(): GoogleGenAI | null {
  const key = resolvedKey()
  if (!key) return null
  if (!geminiInstance || instanceKey !== key) {
    geminiInstance = new GoogleGenAI({ apiKey: key })
    instanceKey = key
  }
  return geminiInstance
}

async function textModelChain(): Promise<string[]> {
  await refreshFromDb()
  // إعدادات لوحة الإدارة لها الأولوية على متغيرات البيئة حتى يستطيع المدير تغيير النموذج دون إعادة نشر.
  const custom = normalizeGeminiModelName(dbTextModelCache || process.env.GEMINI_TEXT_MODEL)
  return [...new Set([custom, activeTextModel, ...TEXT_MODELS].filter(Boolean) as string[])]
}

async function ttsModelChain(): Promise<string[]> {
  await refreshFromDb()
  const custom = normalizeGeminiModelName(dbTtsModelCache || process.env.GEMINI_TTS_MODEL)
  return [...new Set([custom, activeTtsModel, ...TTS_MODELS].filter(Boolean) as string[])]
}

export async function geminiActiveTextModel(): Promise<string> {
  return (await textModelChain())[0]
}

export async function geminiActiveTTSModel(): Promise<string> {
  return (await ttsModelChain())[0]
}

export async function geminiLiveModelChain(purpose: GeminiLivePurpose = 'SUPERVISOR'): Promise<string[]> {
  await refreshFromDb()
  const specificDb = purpose === 'DISCUSSION' ? dbDiscussionLiveModelCache : dbSupervisorLiveModelCache
  const specificEnv = purpose === 'DISCUSSION' ? process.env.GEMINI_DISCUSSION_LIVE_MODEL : process.env.GEMINI_SUPERVISOR_LIVE_MODEL
  const custom = normalizeGeminiModelName(specificDb || specificEnv || dbLiveModelCache || process.env.GEMINI_LIVE_MODEL)
  const active = purpose === 'DISCUSSION' ? activeDiscussionLiveModel : activeSupervisorLiveModel
  const defaults = purpose === 'DISCUSSION' ? DISCUSSION_LIVE_MODELS : SUPERVISOR_LIVE_MODELS
  return [...new Set([custom, active, ...defaults].filter(Boolean) as string[])]
}

export async function geminiActiveLiveModel(purpose: GeminiLivePurpose = 'SUPERVISOR'): Promise<string> {
  return (await geminiLiveModelChain(purpose))[0]
}

export function rememberGeminiLiveModel(model: string, purpose: GeminiLivePurpose = 'SUPERVISOR'): void {
  const normalized = normalizeGeminiModelName(model)
  if (!normalized) return
  if (purpose === 'DISCUSSION') activeDiscussionLiveModel = normalized
  else activeSupervisorLiveModel = normalized
}

export async function geminiDiscussionThinkingLevel(): Promise<GeminiThinkingLevel> {
  await refreshFromDb()
  return normalizeGeminiThinkingLevel(dbDiscussionThinkingLevelCache || process.env.GEMINI_DISCUSSION_THINKING_LEVEL || 'high')
}

export async function geminiLiveConnectConfig(
  purpose: GeminiLivePurpose = 'SUPERVISOR',
  modelName?: string
): Promise<Record<string, unknown>> {
  const voice = await geminiTTSVoice()
  const model = normalizeGeminiModelName(modelName || await geminiActiveLiveModel(purpose))
  const config: Record<string, unknown> = {
    responseModalities: ['AUDIO'],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    realtimeInputConfig: { automaticActivityDetection: { disabled: false } },
  }

  // مميزات Live الحديثة تُفعّل فقط مع عائلة Gemini 3 لتجنب INVALID_ARGUMENT عند الرجوع إلى بدائل 2.5.
  const isGemini3Live = /^gemini-3\./i.test(model) && /live/i.test(model)
  const isGemini25Live = /^gemini-2\.5/i.test(model) && /live/i.test(model)
  if (isGemini3Live) {
    config.enableAffectiveDialog = true
    if (purpose === 'SUPERVISOR') config.proactivity = { proactiveAudio: true }
  }
  if (purpose === 'DISCUSSION' && !isGemini25Live) {
    config.thinkingConfig = { thinkingLevel: await geminiDiscussionThinkingLevel() }
  }
  return config
}

export interface GeminiLiveTokenPayload {
  token: string
  name: string
  model: string
  purpose: GeminiLivePurpose
  config: Record<string, unknown>
  expireTime: string
  newSessionExpireTime: string
  apiVersion: 'v1beta'
}

export async function createGeminiLiveEphemeralToken(purpose: GeminiLivePurpose = 'SUPERVISOR'): Promise<GeminiLiveTokenPayload> {
  await refreshFromDb()
  const key = resolvedKey()
  if (!key) throw new Error('GEMINI_NOT_CONFIGURED')
  const model = await geminiActiveLiveModel(purpose)
  const config = await geminiLiveConnectConfig(purpose, model)
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString()
  const client = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: 'v1beta' } } as any)
  const token = await (client as any).authTokens.create({
    config: {
      uses: 1,
      expireTime,
      newSessionExpireTime,
      liveConnectConstraints: { model, config },
    },
  })
  const name = String(token?.name || token?.token || '')
  if (!name) throw new Error('GEMINI_LIVE_TOKEN_EMPTY')
  rememberGeminiLiveModel(model, purpose)
  return { token: name, name, model, purpose, config, expireTime, newSessionExpireTime, apiVersion: 'v1beta' }
}

export async function geminiModelSource(): Promise<'custom' | 'auto'> {
  await refreshFromDb()
  return dbTextModelCache || process.env.GEMINI_TEXT_MODEL?.trim() ? 'custom' : 'auto'
}

export async function geminiTTSVoice(): Promise<string> {
  await refreshFromDb()
  const v = dbVoiceCache || process.env.GEMINI_TTS_VOICE?.trim() || 'Charon'
  return /^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(v) ? v : 'Charon'
}

function buildContents(history: GeminiTurn[]) {
  return history.filter((t) => t.text?.trim()).map((t) => ({ role: t.role, parts: [{ text: t.text }] }))
}

function textConfig(opts: GeminiCallOpts, json = false, modelName?: string): Record<string, unknown> {
  const model = normalizeGeminiModelName(modelName)
  const config: Record<string, unknown> = {
    systemInstruction: opts.system,
    temperature: opts.temperature ?? (json ? 0.35 : 0.85),
    maxOutputTokens: opts.maxOutputTokens ?? (json ? 2048 : 4096),
  }
  const thinkingConfig: Record<string, unknown> = {}
  if (opts.thinkingLevel && /^gemini-3\./i.test(model)) {
    thinkingConfig.thinkingLevel = opts.thinkingLevel
  } else if (typeof opts.thinkingBudget === 'number' && /^gemini-2\.5/i.test(model)) {
    thinkingConfig.thinkingBudget = opts.thinkingBudget
  }
  if (Object.keys(thinkingConfig).length) config.thinkingConfig = thinkingConfig
  if (json) config.responseMimeType = 'application/json'
  return config
}

export function isModelUnavailableError(e: any): boolean {
  const status = e?.status ?? e?.code
  const msg = String(e?.message || e || '')
  return status === 404 || /NOT_FOUND|not found|no longer available|unsupported model|not available|does not exist/i.test(msg)
}

export function isInvalidArgumentError(e: any): boolean {
  const status = e?.status ?? e?.code
  const msg = String(e?.message || e || '')
  return status === 400 || /INVALID_ARGUMENT|invalid argument/i.test(msg)
}

export function isAuthError(e: any): boolean {
  const status = e?.status ?? e?.code
  const msg = String(e?.message || e || '')
  return status === 401 || status === 403 || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED|permission denied/i.test(msg)
}

export function isQuotaError(e: any): boolean {
  const status = e?.status ?? e?.code
  const msg = String(e?.message || e || '')
  return status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit|exceed your current quota/i.test(msg)
}

export function isTransientGeminiError(e: any): boolean {
  const status = e?.status ?? e?.code
  const msg = String(e?.message || e || '')
  return status === 500 || status === 502 || status === 503 || status === 504 || /UNAVAILABLE|overloaded|high demand|service unavailable|temporar|try again|timeout|deadline/i.test(msg)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function* geminiStreamText(opts: GeminiCallOpts): AsyncGenerator<string> {
  const ai = getGemini()
  if (!ai) throw new Error('GEMINI_NOT_CONFIGURED')
  const contents = buildContents(opts.history)
  let lastErr: any
  for (const model of await textModelChain()) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const stream = await ai.models.generateContentStream({ model, contents, config: textConfig(opts, false, model) })
        for await (const chunk of stream) {
          const text = (chunk as any).text as string | undefined
          if (text) yield text
        }
        activeTextModel = model
        return
      } catch (e) {
        lastErr = e
        if (isAuthError(e)) throw e
        if (isTransientGeminiError(e)) {
          if (attempt < 2) await wait(700 * attempt)
          continue
        }
        if (isModelUnavailableError(e) || isInvalidArgumentError(e) || isQuotaError(e)) break
        throw e
      }
    }
  }
  throw lastErr
}

export async function geminiComplete(opts: GeminiCallOpts): Promise<string> {
  let out = ''
  for await (const x of geminiStreamText(opts)) out += x
  if (!out.trim()) throw new Error('EMPTY_AI_RESPONSE')
  return out.trim()
}

export async function geminiCompleteJson(opts: GeminiCallOpts): Promise<string> {
  const ai = getGemini()
  if (!ai) throw new Error('GEMINI_NOT_CONFIGURED')
  const contents = buildContents(opts.history)
  let lastErr: any
  for (const model of await textModelChain()) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({ model, contents, config: textConfig(opts, true, model) })
        const text = String((response as any).text || '').trim()
        if (!text) throw new Error('EMPTY_AI_RESPONSE')
        activeTextModel = model
        return text
      } catch (e) {
        lastErr = e
        if (isAuthError(e)) throw e
        if (isTransientGeminiError(e)) {
          if (attempt < 2) await wait(700 * attempt)
          continue
        }
        if (isModelUnavailableError(e) || isInvalidArgumentError(e) || isQuotaError(e)) break
        throw e
      }
    }
  }
  throw lastErr
}

export async function geminiVisionJson(opts: {
  system?: string
  prompt: string
  images: { mimeType: string; dataBase64: string }[]
  temperature?: number
  maxOutputTokens?: number
}): Promise<string> {
  const ai = getGemini()
  if (!ai) throw new Error('GEMINI_NOT_CONFIGURED')
  const parts: any[] = [{ text: opts.prompt }]
  for (const img of opts.images) {
    parts.push({ inlineData: { mimeType: img.mimeType || 'image/jpeg', data: img.dataBase64 } })
  }
  const contents = [{ role: 'user', parts }]
  const customTextModels = (await textModelChain()).filter((m) => !/live|tts/i.test(m))
  const chain = [...new Set([...VISION_MODELS, ...customTextModels])]
  let lastErr: any
  for (const model of chain) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            systemInstruction: opts.system || 'أنت قارئ مستندات بصري دقيق. أرجع JSON صالحاً فقط.',
            temperature: opts.temperature ?? 0.1,
            maxOutputTokens: opts.maxOutputTokens ?? 2048,
            responseMimeType: 'application/json',
          },
        })
        const text = String((response as any).text || '').trim()
        if (!text) throw new Error('EMPTY_VISION_RESPONSE')
        activeTextModel = model
        return text
      } catch (e) {
        lastErr = e
        if (isAuthError(e)) throw e
        if (isTransientGeminiError(e)) {
          if (attempt < 2) await wait(900 * attempt)
          continue
        }
        if (isModelUnavailableError(e) || isInvalidArgumentError(e) || isQuotaError(e)) break
        throw e
      }
    }
  }
  throw lastErr
}

export async function geminiTestConnection(): Promise<{ ok: boolean; model?: string; reply?: string; error?: string; quotaExhausted?: boolean }> {
  const ai = getGemini()
  if (!ai) return { ok: false, error: 'GEMINI_NOT_CONFIGURED' }
  const errors: string[] = []
  let sawQuota = false
  for (const model of await textModelChain()) {
    try {
      const resp = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: 'أجب بكلمة واحدة فقط: جاهز' }] }],
        config: { maxOutputTokens: 32 },
      })
      const reply = String((resp as any).text || '').trim()
      activeTextModel = model
      return { ok: true, model, reply }
    } catch (e: any) {
      errors.push(`${model}: ${String(e?.message || e).slice(0, 160)}`)
      if (isAuthError(e)) break
      if (isQuotaError(e)) sawQuota = true
    }
  }
  return { ok: false, error: errors.join(' | '), quotaExhausted: sawQuota }
}

export function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44)
  const byteRate = (sampleRate * channels * bitsPerSample) / 8
  const blockAlign = (channels * bitsPerSample) / 8
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function amplifyPcm16(pcm: Buffer, gain = 1.8): Buffer {
  const out = Buffer.from(pcm)
  for (let i = 0; i + 1 < out.length; i += 2) {
    const sample = out.readInt16LE(i)
    const boosted = Math.max(-32768, Math.min(32767, Math.round(sample * gain)))
    out.writeInt16LE(boosted, i)
  }
  return out
}

async function generateAudio(text: string): Promise<Buffer> {
  const ai = getGemini()
  if (!ai) throw new Error('GEMINI_NOT_CONFIGURED')
  const voice = await geminiTTSVoice()
  let lastErr: any
  for (const model of await ttsModelChain()) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: `اقرأ بصوت أستاذ جامعي طبيعي ودافئ، بسرعة أعلى قليلاً وبدون إطالة أو توقفات كثيرة:\n${text}` }] }],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        })
        const parts = (response as any).candidates?.[0]?.content?.parts || []
        const buffers = parts.map((p: any) => p?.inlineData?.data).filter(Boolean).map((b64: string) => Buffer.from(b64, 'base64'))
        if (!buffers.length) throw new Error('GEMINI_TTS_EMPTY')
        activeTtsModel = model
        return pcmToWav(amplifyPcm16(Buffer.concat(buffers), 1.85))
      } catch (e) {
        lastErr = e
        if (isAuthError(e)) throw e
        if (isTransientGeminiError(e)) {
          if (attempt < 2) await wait(700 * attempt)
          continue
        }
        if (isModelUnavailableError(e) || isInvalidArgumentError(e) || isQuotaError(e)) break
        throw e
      }
    }
  }
  throw lastErr
}

export async function geminiTTSWav(text: string, _opts?: { speed?: number }): Promise<Buffer> {
  return generateAudio(text)
}

export async function* geminiTTSWavStream(text: string, _opts?: { speed?: number }): AsyncGenerator<Buffer> {
  yield await generateAudio(text)
}
