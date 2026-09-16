import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { DEMO_ACCOUNTS, ensurePlatformDemoAccounts } from '@/lib/demo-accounts'

export async function GET() {
  try {
    await requireAdmin()
    return NextResponse.json({ accounts: DEMO_ACCOUNTS })
  } catch {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }
}

export async function POST() {
  try {
    await requireAdmin()
    const result = await ensurePlatformDemoAccounts({ resetDefense: true })
    return NextResponse.json({ ok: true, ...result })
  } catch (e: any) {
    console.error('demo accounts refresh failed:', e)
    const status = e?.message === 'UNAUTHORIZED' ? 401 : 500
    return NextResponse.json({ error: status === 401 ? 'UNAUTHORIZED' : 'تعذر تجهيز الحسابات التجريبية' }, { status })
  }
}
