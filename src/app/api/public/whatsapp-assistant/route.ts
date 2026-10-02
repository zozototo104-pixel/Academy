import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { platformPublicAgentComplete } from '@/lib/platform-agent'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type PublicMessage = { role: string; content: string }

function safeMessages(input: unknown): PublicMessage[] {
  if (!Array.isArray(input)) return []
  return input
    .map((m: any) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content || '').trim().slice(0, 1200) }))
    .filter((m) => m.content)
    .slice(-10)
}

function looksLikeProgramsQuestion(message: string) {
  return /برامج|برنامج|دبلوم|ماجستير|دكتوراه|رسوم|تسجيل|تخصص|الدورات|الكورسات/i.test(message)
}

async function groundedProgramFallbackReply(message: string) {
  if (!looksLikeProgramsQuestion(message)) return null
  const programs = await db.program.findMany({
    where: { active: true, registrationStatus: 'OPEN' },
    select: { titleAr: true, category: true, price: true, hours: true },
    orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
    take: 10,
  })
  if (!programs.length) return null
  const categoryLabel: Record<string, string> = {
    DIPLOMA: 'دبلومات مهنية',
    MASTERS: 'ماجستير مهني',
    DOCTORATE: 'دكتوراه مهنية',
    ACCREDITATION: 'اعتمادات وتدريب مدربين',
  }
  const grouped = programs.reduce<Record<string, typeof programs>>((acc, program) => {
    const key = categoryLabel[program.category] || program.category || 'برامج أخرى'
    acc[key] = acc[key] || []
    acc[key].push(program)
    return acc
  }, {})
  const lines = Object.entries(grouped).slice(0, 4).map(([category, items]) => {
    const sample = items.slice(0, 3).map((p) => {
      const price = typeof p.price === 'number' ? ` — ${p.price}import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { platformPublicAgentComplete } from '@/lib/platform-agent'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type PublicMessage = { role: string; content: string }

 : ''
      return `${p.titleAr}${price}`
    }).join('، ')
    return `• ${category}: ${sample}`
  })
  return [
    'أهلاً بك 👋 هذه لمحة سريعة عن البرامج المفتوحة حالياً في الأكاديمية:',
    ...lines,
    '',
    'اكتب لي المجال الذي تريده أو اسم البرنامج، وسأعطيك التفاصيل المناسبة للتسجيل والرسوم والشروط.',
  ].join('\n')
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
      channel: 'WHATSAPP',
      uiContext: [
        'المستخدم يتواصل عبر واجهة وكيل واتساب الذكي داخل الموقع، ويجب أن تكون الإجابة بنفس جودة وأسلوب وكيل واتساب الرسمي.',
        'لا ترد برد عام مقتضب إذا كان السؤال عن البرامج؛ اسأل سؤال متابعة عند الحاجة أو اعرض أهم المسارات والرسوم بإيجاز مرتب.',
        'لا تخترع أرقاماً أو وعوداً غير موجودة في بيانات المنصة. استخدم كتالوج البرامج وإعدادات الدفع كمصدر حقيقة.',
        'إذا كان السؤال قصيراً مثل "شو برامجكم" فاعرض تصنيفات البرامج الرئيسية مع أمثلة قليلة ودعوة لاختيار المجال المطلوب.',
      ].join(' '),
    })

    return NextResponse.json({ ok: true, reply: result.reply, agent: result.agent, engine: result.engine })
  } catch (e: any) {
    console.error('Public WhatsApp assistant error:', String(e?.message || e).slice(0, 500))
    return NextResponse.json({ error: 'تعذر تشغيل وكيل واتساب الذكي مؤقتاً. يمكنك فتح واتساب المباشر والتواصل مع الإدارة.' }, { status: 500 })
  }
}
