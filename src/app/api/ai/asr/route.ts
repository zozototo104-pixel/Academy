import { NextRequest, NextResponse } from 'next/server'
import { getZAI } from '@/lib/ai'
import { requireUser } from '@/lib/auth'
import { AI_RATE_LIMITS, base64DecodedSize, enforceUserAiRateLimit } from '@/lib/ai-rate-limits'

// POST /api/ai/asr — تحويل الصوت المسجل إلى نص (احتياطي عندما لا يتوفر Web Speech API)
export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    if (!user) {
      return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    }
    const limited = enforceUserAiRateLimit(req, AI_RATE_LIMITS.asr, user.id)
    if (limited) return limited

    const { audioBase64 } = await req.json()
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return NextResponse.json({ error: 'الصوت مطلوب' }, { status: 400 })
    }
    // حد 8MB صوت مسجل (~دقيقتان webm/opus) قبل إرسال الطلب للمزود
    if (base64DecodedSize(audioBase64) > 8 * 1024 * 1024) {
      return NextResponse.json({ error: 'حجم التسجيل كبير جداً — سجل مقطعاً أقصر' }, { status: 413 })
    }

    const zai = await getZAI()
    const response = await zai.audio.asr.create({ file_base64: audioBase64 })
    const text = response.text || ''

    return NextResponse.json({ text })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    }
    console.error('ASR error:', e)
    return NextResponse.json({ error: 'تعذر تحويل الصوت إلى نص' }, { status: 500 })
  }
}
