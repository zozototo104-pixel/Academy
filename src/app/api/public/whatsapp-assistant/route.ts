import { NextRequest, NextResponse } from 'next/server'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { platformPublicAgentComplete } from '@/lib/platform-agent'

export const dynamic = 'force-dynamic'
export const maxDuration = 45

type PublicMessage = { role: string; content: string }

function safeMessages(input: unknown): PublicMessage[] {
  if (!Array.isArray(input)) return []
  return input
    .map((m: any) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content || '').trim().slice(0, 1200) }))
    .filter((m) => m.content)
    .slice(-10)
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const message = String(body?.message || '').trim()
    if (!message) return NextResponse.json({ error: 'الرسالة فارغة' }, { status: 400 })

    const limited = enforceApiRateLimit(req, 'public-whatsapp-assistant', 10, 60 * 1000, body?.visitorId || req.headers.get('x-forwarded-for') || 'visitor')
    if (limited) return limited

    const history = safeMessages(body?.history)
    const messages = [...history, { role: 'user', content: message.slice(0, 1200) }]
    const result = await platformPublicAgentComplete({
      messages,
      channel: 'WEB_WIDGET',
      uiContext: 'الزائر يستخدم زر واتساب العائم ويريد معلومات عامة عن الأكاديمية وبرامجها ورسومها وشروطها.',
    })

    return NextResponse.json({ ok: true, reply: result.reply, agent: result.agent, engine: result.engine })
  } catch (e: any) {
    console.error('Public WhatsApp assistant error:', String(e?.message || e).slice(0, 500))
    return NextResponse.json({ error: 'تعذر تشغيل وكيل واتساب الذكي مؤقتاً. يمكنك فتح واتساب المباشر والتواصل مع الإدارة.' }, { status: 500 })
  }
}
