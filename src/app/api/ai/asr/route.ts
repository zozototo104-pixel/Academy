import { NextRequest, NextResponse } from 'next/server'
import { transcribeAudioBase64 } from '@/lib/asr'
import { requireUser } from '@/lib/auth'
import { AI_RATE_LIMITS, base64DecodedSize, enforceUserAiRateLimit } from '@/lib/ai-rate-limits'
import { getSetting } from '@/lib/settings'
import { normalizeVoiceDialect, VOICE_DEFAULT_DIALECT } from '@/lib/voice-dialect'

// POST /api/ai/asr — تحويل الصوت المسجل إلى نص (احتياطي عندما لا يتوفر Web Speech API)
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    if (!user) {
      return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    }
    const limited = enforceUserAiRateLimit(req, AI_RATE_LIMITS.asr, user.id)
    if (limited) return limited

    const body = await req.json()
    const audioBase64 = body?.audioBase64
    const mimeType = String(body?.mimeType || body?.mime_type || '')
    const dialect = String(body?.dialect || body?.languageCode || '').trim()
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return NextResponse.json({ error: 'الصوت مطلوب' }, { status: 400 })
    }
    // حد 8MB صوت مسجل (~دقيقتان webm/opus) قبل إرسال الطلب للمزود
    if (base64DecodedSize(audioBase64) > 8 * 1024 * 1024) {
      return NextResponse.json({ error: 'حجم التسجيل كبير جداً — سجل مقطعاً أقصر' }, { status: 413 })
    }

    const defaultDialect = await getSetting('VOICE_DEFAULT_DIALECT').catch(() => process.env.VOICE_DEFAULT_DIALECT || 'ar-PS')
    const safeDialect = /^ar-[A-Z]{2}$/.test(dialect) ? dialect : (/^ar-[A-Z]{2}$/.test(defaultDialect) ? defaultDialect : 'ar-PS')
    const text = await transcribeAudioBase64(audioBase64, { mimeType: mimeType || 'audio/webm', languageCode: safeDialect })

    return NextResponse.json({ text })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    }
    console.error('ASR error:', e)
    return NextResponse.json({ error: 'تعذر تحويل الصوت إلى نص' }, { status: 500 })
  }
}
