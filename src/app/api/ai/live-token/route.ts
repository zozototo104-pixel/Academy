import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { createGeminiLiveEphemeralToken, ensureGeminiKey, type GeminiLivePurpose } from '@/lib/gemini'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { getGeminiLiveAllowance, reserveGeminiLiveUsage } from '@/lib/live-usage-guard'
import { buildDefenseLiveSystemInstruction, buildDefenseOnlyContextForStudent } from '@/lib/defense-agent-context'

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
    const urlThesisId = req.nextUrl.searchParams.get('thesisId')
    let bodyPurpose: unknown = null
    let bodyThesisId: unknown = null
    if (req.method === 'POST') {
      const body = await req.json().catch(() => null) as any
      bodyPurpose = body?.purpose
      bodyThesisId = body?.thesisId
    }
    const purpose = normalizePurpose(bodyPurpose || urlPurpose)
    const thesisId = String(bodyThesisId || urlThesisId || '').trim() || null
    let systemInstruction: string | undefined
    if (purpose === 'DISCUSSION') {
      const defense = await buildDefenseOnlyContextForStudent(user.id, thesisId)
      if (!defense) return NextResponse.json({ error: 'يجب وجود مناقشة مجدولة مرتبطة ببحثك قبل فتح جلسة المناقشة الصوتية.' }, { status: 409 })
      systemInstruction = buildDefenseLiveSystemInstruction(defense.context)
    }
    await ensureGeminiKey()
    const allowance = await getGeminiLiveAllowance({ userId: user.id, role: user.role, purpose })
    if (!allowance.ok) {
      return NextResponse.json({ error: allowance.message, liveUsage: allowance }, { status: allowance.status })
    }

    const payload = await createGeminiLiveEphemeralToken(purpose, { sessionLimitMinutes: allowance.sessionLimitMinutes, systemInstruction })
    const usage = await reserveGeminiLiveUsage({ userId: user.id, role: user.role, purpose, requestedMinutes: allowance.sessionLimitMinutes })
    if (!usage.ok) {
      return NextResponse.json({ error: usage.message, liveUsage: usage }, { status: usage.status })
    }
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
