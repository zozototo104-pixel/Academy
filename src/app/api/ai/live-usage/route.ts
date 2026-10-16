import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { getGeminiLiveAllowance, settleGeminiLiveUsage, type LivePurpose } from '@/lib/live-usage-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function normalizePurpose(value: unknown): LivePurpose {
  const v = String(value || '').trim().toUpperCase()
  return v === 'DISCUSSION' || v === 'DEFENSE' ? 'DISCUSSION' : 'SUPERVISOR'
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const purpose = normalizePurpose(req.nextUrl.searchParams.get('purpose'))
    const liveUsage = await getGeminiLiveAllowance({ userId: user.id, role: user.role, purpose })
    return NextResponse.json({ liveUsage })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحميل استهلاك Gemini Live' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireUser()
    const body = await req.json().catch(() => ({})) as any
    const sessionId = String(body.sessionId || '').trim()
    if (!sessionId) return NextResponse.json({ error: 'sessionId مطلوب لإنهاء جلسة الصوت.' }, { status: 400 })
    const result = await settleGeminiLiveUsage({ sessionId, actualSeconds: Number(body.actualSeconds || 0), actualMinutes: Number(body.actualMinutes || 0) || undefined })
    return NextResponse.json({ liveUsageSettlement: result }, { status: result.status || 200 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر إنهاء جلسة Gemini Live' }, { status: 500 })
  }
}
