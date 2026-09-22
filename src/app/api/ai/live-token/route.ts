import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { createGeminiLiveEphemeralToken, ensureGeminiKey, type GeminiLivePurpose } from '@/lib/gemini'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { getGeminiLiveAllowance, reserveGeminiLiveUsage } from '@/lib/live-usage-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function normalizePurpose(value: unknown): GeminiLivePurpose {
  const v = String(value || '').trim().toUpperCase()
  return v === 'DISCUSSION' || v === 'DEFENSE' ? 'DISCUSSION' : 'SUPERVISOR'
}

async function handler(req: NextRequest) {
  try {
    const user = await requireUser()
    const liveLimit = enforceApiRateLimit(req, 'ai:live-token', 20, 10 * 60 * 1000, user.id)
    if (liveLimit) return liveLimit

    const urlPurpose = req.nextUrl.searchParams.get('purpose')
    let bodyPurpose: unknown = null
    if (req.method === 'POST') {
      const body = await req.json().catch(() => null) as any
      bodyPurpose = body?.purpose
    }
    const purpose = normalizePurpose(bodyPurpose || urlPurpose)
    await ensureGeminiKey()
    const usage = await reserveGeminiLiveUsage({ userId: user.id, role: user.role, purpose })
    if (!usage.ok) {
      return NextResponse.json({ error: usage.message, liveUsage: usage }, { status: usage.status })
    }

    const payload = await createGeminiLiveEphemeralToken(purpose, { sessionLimitMinutes: usage.sessionLimitMinutes })
    return NextResponse.json({ ...payload, liveUsage: usage, sessionLimitMinutes: usage.sessionLimitMinutes })
  } catch (e: any) {
    const msg = String(e?.message || e || '')
    if (msg === 'UNAUTHORIZED') return NextResponse.json({ error: 'يلزم تسجيل الدخول قبل إنشاء جلسة Gemini Live' }, { status: 401 })
    if (msg === 'GEMINI_NOT_CONFIGURED') return NextResponse.json({ error: 'مفتاح Gemini غير مضبوط في إعدادات المنصة أو Vercel' }, { status: 400 })
    console.error('Gemini live token error:', msg.slice(0, 400))
    return NextResponse.json({ error: 'تعذر إنشاء رمز جلسة Gemini Live المؤقت' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  return handler(req)
}

export async function POST(req: NextRequest) {
  return handler(req)
}
