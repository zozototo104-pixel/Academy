import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { audit } from '@/lib/notify'

const PROVIDERS = new Set(['OPENAI', 'ANTHROPIC', 'GOOGLE', 'DEEPSEEK', 'OPENROUTER', 'OPENAI_COMPAT', 'TOPTOOLS'])

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    const body = await req.json().catch(() => ({}))
    const provider = String(body.provider || '').trim().toUpperCase()
    if (!PROVIDERS.has(provider)) return NextResponse.json({ error: 'مزود غير معروف' }, { status: 400 })

    const [cooldown, noBalance] = await Promise.all([
      db.setting.deleteMany({ where: { key: { startsWith: `AI_COOLDOWN:${provider}:` } } }),
      db.setting.deleteMany({ where: { key: { startsWith: `AI_NO_BALANCE:${provider}:` } } }),
    ])
    const count = (cooldown.count || 0) + (noBalance.count || 0)
    await audit(user, 'CLEAR_AI_PROVIDER_COOLDOWN', 'Setting', null, `${provider} — deleted ${count} AI_COOLDOWN/AI_NO_BALANCE entries`)
    return NextResponse.json({ ok: true, provider, count })
  } catch (error) {
    console.error('clear ai provider cooldown error:', error)
    return NextResponse.json({ error: 'تعذر مسح تبريد مزود الذكاء' }, { status: 500 })
  }
}
