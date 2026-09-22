import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { getGeminiLiveAllowance, type LivePurpose } from '@/lib/live-usage-guard'

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
