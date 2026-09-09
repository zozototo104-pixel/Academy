import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import {
  ensureGeminiKey,
  geminiApiKey,
  geminiActiveLiveModel,
  geminiTTSVoice,
  normalizeGeminiModelName,
  isValidGeminiLiveModel,
  isAuthError,
  isQuotaError,
  isModelUnavailableError,
  isInvalidArgumentError,
} from '@/lib/gemini'
import { buildSupervisorContext, mergeContext } from '@/lib/supervisor-ai'
import { buildVoiceSystemPrompt } from '@/lib/voicePrompt'

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

function cleanVariant(v: unknown): SetupVariant {
  return v === 'generationConfig' || v === 'bare' ? v : 'minimal'
}

function httpStatusForGeminiError(e: any): number {
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
  return raw.slice(0, 220) || 'تعذر إنشاء جلسة Gemini Live'
}

function buildSetup(variant: SetupVariant, model: string, systemInstruction: string) {
  const instruction = systemInstruction.slice(0, 32000)

  if (variant === 'bare') {
    return {
      setup: {
        model: `models/${model}`,
        responseModalities: ['AUDIO'],
      },
    }
  }

  if (variant === 'generationConfig') {
    return {
      setup: {
        model: `models/${model}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
        },
        systemInstruction: {
          parts: [{ text: instruction }],
        },
      },
    }
  }

  return {
    setup: {
      model: `models/${model}`,
      responseModalities: ['AUDIO'],
      systemInstruction: {
        parts: [{ text: instruction }],
      },
    },
  }
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null)
  if (!user) {
    return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
  }

  await ensureGeminiKey()
  const apiKey = await geminiApiKey()
  if (!apiKey) {
    return NextResponse.json({ error: 'أدخل مفتاح Gemini API أولاً من لوحة الإدارة' }, { status: 400 })
  }

  let body: { model?: string; voice?: string; context?: string; testOnly?: boolean; setupVariant?: SetupVariant } = {}
  try {
    body = await req.json()
  } catch {}

  const model = cleanModel(body.model) || await geminiActiveLiveModel()
  if (!isValidGeminiLiveModel(model)) {
    return NextResponse.json(
      { error: 'اسم نموذج Gemini Live غير صحيح، استخدم gemini-3.1-flash-live-preview.', model },
      { status: 400 }
    )
  }

  const voice = cleanVoice(body.voice || await geminiTTSVoice())
  const setupVariant = cleanVariant(body.setupVariant)
  const ragContext = await buildSupervisorContext(user.id)
  const extra =
    'هذه جلسة Gemini Live صوت إلى صوت حقيقية عبر WebSocket. ' +
    'استجب بصوت طبيعي قصير، وتوقف بعد فكرة أو سؤال واحد حتى تمنح الطالب فرصة المقاطعة والرد.'
  const systemInstruction = buildVoiceSystemPrompt(
    mergeContext(ragContext, [body.context, extra].filter(Boolean).join('\n'))
  )

  const setup = buildSetup(setupVariant, model, systemInstruction)

  const now = Date.now()
  const expireTime = new Date(now + 30 * 60 * 1000).toISOString()
  const newSessionExpireTime = new Date(now + 60 * 1000).toISOString()

  // التوكن المؤقت قصير العمر ويُستخدم مرة واحدة. الإعدادات تُرسل كأول رسالة setup عبر WebSocket.
  const tokenBody = {
    uses: 1,
    expireTime,
    newSessionExpireTime,
  }

  try {
    const upstream = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(tokenBody),
    })

    const payload = await upstream.json().catch(() => ({} as any))
    if (!upstream.ok) {
      const msg =
        payload?.error?.message ||
        payload?.message ||
        `Gemini token HTTP ${upstream.status}`
      const err: any = new Error(msg)
      err.status = upstream.status
      return NextResponse.json(
        { error: arabicErrorForGemini(err), details: msg.slice(0, 500) },
        { status: httpStatusForGeminiError(err) }
      )
    }

    const token = String(payload?.name || payload?.token || payload?.authToken?.name || '').trim()
    if (!token) {
      return NextResponse.json({ error: 'لم يرجع Gemini رمز جلسة Live صالحاً' }, { status: 502 })
    }

    if (body.testOnly) {
      return NextResponse.json({
        ok: true,
        model,
        voice,
        setupVariant,
        expiresAt: expireTime,
        message: 'تم إنشاء رمز Gemini Live مؤقت بنجاح',
      })
    }

    return NextResponse.json({
      token,
      model,
      voice,
      setupVariant,
      expiresAt: expireTime,
      wsUrl: `${LIVE_WS_BASE}?access_token=${encodeURIComponent(token)}`,
      setup,
    })
  } catch (e: any) {
    console.error('gemini-live session error:', String(e?.message || e).slice(0, 500))
    return NextResponse.json(
      { error: arabicErrorForGemini(e) },
      { status: httpStatusForGeminiError(e) }
    )
  }
}
