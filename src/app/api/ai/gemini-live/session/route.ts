import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { resolveAiKnowledgeScope, type AiKnowledgeScope } from '@/lib/ai-knowledge-policy'
import {
  geminiActiveLiveModel,
  geminiTTSVoice,
  normalizeGeminiModelName,
  isValidGeminiLiveModel,
  isAuthError,
  isQuotaError,
  isModelUnavailableError,
  isInvalidArgumentError,
} from '@/lib/gemini'
import {
  geminiKeysForLive,
  reportGeminiLiveKeyFailure,
  reportGeminiLiveKeySuccess,
} from '@/lib/text-ai'
import { buildSupervisorContext, mergeContext } from '@/lib/supervisor-ai'
import { buildVoiceSystemPrompt } from '@/lib/voicePrompt'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { getSetting } from '@/lib/settings'
import { redactSecrets } from '@/lib/secret-crypto'
import { getGeminiLiveAllowance, reserveGeminiLiveUsage, type LivePurpose } from '@/lib/live-usage-guard'
import { dialectInstruction, normalizeVoiceDialect, VOICE_DEFAULT_DIALECT } from '@/lib/voice-dialect'

export const runtime = 'nodejs'
export const maxDuration = 30

const LIVE_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained'

type SetupVariant = 'minimal' | 'generationConfig' | 'bare'

function cleanModel(model: unknown): string {
  return normalizeGeminiModelName(model)
}

function cleanVoice(voice: unknown): string {
  const v = String(voice || '').trim()
  return /^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(v) ? v : 'Charon'
}

export function cleanDialect(value: unknown): string {
  return normalizeVoiceDialect(value)
}

function cleanVariant(v: unknown): SetupVariant {
  return v === 'generationConfig' || v === 'bare' ? v : 'minimal'
}

function cleanPurpose(value: unknown): LivePurpose {
  const v = String(value || '').trim().toUpperCase()
  return v === 'DISCUSSION' || v === 'DEFENSE' ? 'DISCUSSION' : 'SUPERVISOR'
}

async function auditLiveKnowledgeSession(args: {
  userId: string
  role?: string | null
  purpose: LivePurpose
  scope: AiKnowledgeScope
  query: string
  contextLength: number
  systemInstructionLength: number
  model: string
  voice: string
}) {
  await db.auditLog.create({
    data: {
      actorId: args.userId,
      actorName: args.role === 'ADMIN' ? 'إدارة النظام' : args.role === 'SUPERVISOR' ? 'مشرف بشري' : 'مشرف ذكي للطالب',
      action: 'AI_KNOWLEDGE_DIAGNOSTICS',
      entity: 'AIKnowledge',
      entityId: args.userId,
      details: JSON.stringify({
        source: 'GEMINI_LIVE_SESSION_CONTEXT',
        scope: args.scope,
        role: args.role || null,
        purpose: args.purpose,
        query: args.query.slice(0, 220),
        contextLength: args.contextLength,
        systemInstructionLength: args.systemInstructionLength,
        model: args.model,
        voice: args.voice,
        returnedReply: false,
        reason: 'live_session_context_prepared',
      }).slice(0, 3900),
    },
  }).catch(() => {})
}

function httpStatusForGeminiError(e: any): number {
  const status = statusFromGeminiError(e)
  if (status === 402) return 402
  if (isAuthError(e)) return 401
  if (isQuotaError(e)) return 429
  if (isModelUnavailableError(e) || isInvalidArgumentError(e)) return 400
  return 502
}

function arabicErrorForGemini(e: any): string {
  const raw = String(e?.message || e || '')
  if (isAuthError(e)) return 'مفتاح Gemini غير صالح أو لا يملك صلاحية Live API'
  if (isQuotaError(e)) return 'وصل Gemini Live إلى حد الحصة الحالية لهذا المشروع — فعّل Billing أو انتظر إعادة الضبط'
  if (isModelUnavailableError(e)) return 'نموذج Gemini Live المختار غير متاح لهذا المشروع'
  if (isInvalidArgumentError(e)) {
    return 'إعدادات Gemini Live غير مقبولة. استخدم gemini-3.1-flash-live-preview، أو جرّب gemini-2.5-flash-live-preview إذا لم تكن 3.1 متاحة لمشروعك'
  }
  return redactSecrets(raw).slice(0, 220) || 'تعذر إنشاء جلسة Gemini Live'
}

type LiveKeyFailureDetail = {
  keyIndex: number
  maskedKey: string
  status?: number
  message: string
}

function statusFromGeminiError(e: any): number | undefined {
  const status = Number(e?.status || e?.code || 0)
  return Number.isFinite(status) && status >= 100 && status <= 599 ? status : undefined
}

function shouldTryNextGeminiLiveKey(e: any): boolean {
  const status = statusFromGeminiError(e)
  return status === 402 || isAuthError(e) || isQuotaError(e)
}

function maskGeminiKey(key: string): string {
  const clean = String(key || '').trim()
  if (!clean) return ''
  if (clean.length <= 8) return `${clean.slice(0, 2)}…${clean.slice(-2)}`
  return `${clean.slice(0, 4)}…${clean.slice(-4)}`
}

function googleErrorMessage(payload: any, status: number): string {
  return redactSecrets(String(
    payload?.error?.message ||
    payload?.message ||
    payload?.raw ||
    `Gemini token HTTP ${status}`
  )).slice(0, 500)
}

function failureDetail(keyIndex: number, key: string, e: any): LiveKeyFailureDetail {
  return {
    keyIndex,
    maskedKey: maskGeminiKey(key),
    status: statusFromGeminiError(e),
    message: redactSecrets(String(e?.googleMessage || e?.message || e || '')).slice(0, 500),
  }
}

function liveTokenError(message: string, status: number, model: string, ms: number): Error & { status: number; model: string; ms: number; googleMessage: string } {
  const err = new Error(message) as Error & { status: number; model: string; ms: number; googleMessage: string }
  err.status = status
  err.model = model
  err.ms = ms
  err.googleMessage = message
  return err
}

async function requestGeminiLiveToken(args: {
  key: string
  model: string
  body: Record<string, unknown>
}): Promise<{ token: string; payload: any; ms: number }> {
  const started = Date.now()
  const upstream = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': args.key,
    },
    body: JSON.stringify(args.body),
  })

  const payload = await upstream.json().catch(() => ({} as any))
  const ms = Date.now() - started
  if (!upstream.ok) {
    throw liveTokenError(googleErrorMessage(payload, upstream.status), upstream.status, args.model, ms)
  }

  const token = String(payload?.name || payload?.token || payload?.authToken?.name || '').trim()
  if (!token) throw liveTokenError('GEMINI_LIVE_TOKEN_EMPTY', 502, args.model, ms)
  return { token, payload, ms }
}

function speechConfigForVoice(voice: string) {
  return {
    voiceConfig: {
      prebuiltVoiceConfig: {
        voiceName: voice,
      },
    },
  }
}

function withDialectInstruction(systemInstruction: string, dialect: string) {
  return `${dialectInstruction(dialect)}\n\n${String(systemInstruction || '')}`.slice(0, 32000)
}

export function buildGeminiLiveSetup(_variant: SetupVariant, model: string, systemInstruction: string, voice: string, dialect: string) {
  const instruction = withDialectInstruction(systemInstruction, dialect)
  return {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: speechConfigForVoice(voice),
      },
      systemInstruction: {
        parts: [{ text: instruction }],
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  }
}

export function buildGeminiLiveSdkConfig(systemInstruction: string, voice: string, dialect: string) {
  return {
    responseModalities: ['AUDIO'],
    speechConfig: speechConfigForVoice(voice),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    systemInstruction: withDialectInstruction(systemInstruction, dialect),
  }
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null)
  if (!user) {
    return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
  }

  const sessionLimit = enforceApiRateLimit(req, 'ai:gemini-live-session', 12, 10 * 60 * 1000, user.id)
  if (sessionLimit) return sessionLimit

  let body: { model?: string; voice?: string; dialect?: string; context?: string; purpose?: string; testOnly?: boolean; setupVariant?: SetupVariant } = {}
  try {
    body = await req.json()
  } catch (error) {
    console.warn('Failed to parse Gemini live session request body JSON.', error)
  }

  const purpose = cleanPurpose(body.purpose)
  const allowance = body.testOnly
    ? null
    : await getGeminiLiveAllowance({ userId: user.id, role: user.role, purpose })
  if (allowance && !allowance.ok) {
    return NextResponse.json({
      error: allowance.message,
      ...(allowance.status === 402 ? { code: 'LIVE_MINUTES_EXHAUSTED' } : {}),
      liveUsage: allowance,
    }, { status: allowance.status })
  }

  const model = cleanModel(body.model) || await geminiActiveLiveModel(purpose)
  if (!isValidGeminiLiveModel(model)) {
    return NextResponse.json(
      { error: 'اسم نموذج Gemini Live غير صحيح، استخدم gemini-3.1-flash-live-preview.', model },
      { status: 400 }
    )
  }

  const voice = cleanVoice(body.voice || await geminiTTSVoice())
  const defaultDialect = await getSetting('VOICE_DEFAULT_DIALECT').catch(() => process.env.VOICE_DEFAULT_DIALECT || 'ar-PS')
  const dialect = cleanDialect(body.dialect || defaultDialect || 'ar-PS')
  const setupVariant = cleanVariant(body.setupVariant)
  const liveScope = resolveAiKnowledgeScope({ role: user.role, purpose })
  const liveQuery = String(body.context || '')
  const ragContext = await buildSupervisorContext(user.id, { scope: liveScope, query: liveQuery })
  const extra =
    'هذه جلسة Gemini Live صوت إلى صوت حقيقية عبر WebSocket. ' +
    'استجب بصوت طبيعي قصير، وتوقف بعد فكرة أو سؤال واحد حتى تمنح الطالب فرصة المقاطعة والرد.'
  const systemInstruction = buildVoiceSystemPrompt(
    mergeContext(ragContext, [body.context, extra].filter(Boolean).join('\n'))
  )

  await auditLiveKnowledgeSession({
    userId: user.id,
    role: user.role,
    purpose,
    scope: liveScope,
    query: liveQuery,
    contextLength: ragContext.length,
    systemInstructionLength: systemInstruction.length,
    model,
    voice,
  })

  const setup = buildGeminiLiveSetup(setupVariant, model, systemInstruction, voice, dialect)
  const sdkConfig = buildGeminiLiveSdkConfig(systemInstruction, voice, dialect)

  const now = Date.now()
  const sessionLimitMinutes = allowance?.sessionLimitMinutes || 10
  const expireTime = new Date(now + sessionLimitMinutes * 60 * 1000).toISOString()
  const newSessionExpireTime = new Date(now + 60 * 1000).toISOString()

  // التوكن المؤقت قصير العمر ويُستخدم مرة واحدة. الإعدادات تُرسل كأول رسالة setup عبر WebSocket.
  const tokenBody = {
    uses: 1,
    expireTime,
    newSessionExpireTime,
  }

  try {
    const liveKeys = await geminiKeysForLive()
    if (!liveKeys.length) {
      return NextResponse.json({ error: 'أدخل مفتاح Gemini API أولاً من لوحة الإدارة أو انتظر انتهاء تبريد مفاتيح Gemini الحالية', details: [] }, { status: 400 })
    }

    const failures: LiveKeyFailureDetail[] = []
    let lastError: any = null
    let token = ''

    for (const { key, keyIndex } of liveKeys) {
      try {
        const result = await requestGeminiLiveToken({ key, model, body: tokenBody })
        token = result.token
        reportGeminiLiveKeySuccess(keyIndex, model, result.ms)
        break
      } catch (e: any) {
        const err: any = e && typeof e === 'object' ? e : new Error(String(e || 'Gemini Live token failure'))
        err.model = err.model || model
        lastError = err
        failures.push(failureDetail(keyIndex, key, err))
        await reportGeminiLiveKeyFailure(keyIndex, err)
        if (shouldTryNextGeminiLiveKey(err)) continue
        return NextResponse.json(
          { error: arabicErrorForGemini(err), details: failures },
          { status: httpStatusForGeminiError(err) }
        )
      }
    }

    if (!token) {
      const e = lastError || new Error('GEMINI_LIVE_NO_AVAILABLE_KEY')
      return NextResponse.json(
        { error: arabicErrorForGemini(e), details: failures },
        { status: httpStatusForGeminiError(e) }
      )
    }

    if (body.testOnly) {
      return NextResponse.json({
        ok: true,
        model,
        voice,
        dialect,
        setupVariant,
        expiresAt: expireTime,
        sessionLimitMinutes,
        liveUsage: allowance,
        setup,
        sdkConfig,
        message: 'تم إنشاء رمز Gemini Live مؤقت بنجاح',
      })
    }

    const reservedUsage = await reserveGeminiLiveUsage({ userId: user.id, role: user.role, purpose, requestedMinutes: Math.min(2, sessionLimitMinutes) })
    if (!reservedUsage.ok) {
      return NextResponse.json({
        error: reservedUsage.message,
        ...(reservedUsage.status === 402 ? { code: 'LIVE_MINUTES_EXHAUSTED' } : {}),
        liveUsage: reservedUsage,
      }, { status: reservedUsage.status })
    }

    return NextResponse.json({
      token,
      model,
      voice,
      dialect,
      setupVariant,
      expiresAt: expireTime,
      sessionLimitMinutes,
      liveUsage: reservedUsage,
      wsUrl: `${LIVE_WS_BASE}?access_token=${encodeURIComponent(token)}`,
      setup,
      sdkConfig,
    })
  } catch (e: any) {
    console.error('gemini-live session error:', redactSecrets(String(e?.message || e)).slice(0, 500))
    return NextResponse.json(
      { error: arabicErrorForGemini(e) },
      { status: httpStatusForGeminiError(e) }
    )
  }
}
