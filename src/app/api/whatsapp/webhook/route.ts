import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { ACADEMY_INFO, ADMISSION_FEES, ADMISSION_GUIDE, ACCREDITATION_GUIDE, allSeedPrograms } from '@/lib/academyData'
import { ensureGeminiKey, geminiComplete } from '@/lib/gemini'

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0'
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || ''
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || ''
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || ''
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || ''

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status })
}

function safeEqual(a: string, b: string) {
  try {
    const aa = Buffer.from(a)
    const bb = Buffer.from(b)
    return aa.length === bb.length && timingSafeEqual(aa, bb)
  } catch {
    return false
  }
}

function verifyMetaSignature(raw: string, signature: string | null) {
  if (!APP_SECRET) return true
  if (!signature?.startsWith('sha256=')) return false
  const expected = `sha256=${createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`
  return safeEqual(signature, expected)
}

function academyProgramsDigest(max = 24) {
  return allSeedPrograms.slice(0, max).map((p, i) => {
    const fee = p.price ? ` — الرسوم ${p.price}$` : ''
    const hours = p.hours ? ` — ${p.hours} ساعة` : ''
    return `${i + 1}. ${p.titleAr}${p.titleEn ? ` (${p.titleEn})` : ''}${hours}${fee}`
  }).join('\n')
}

function normalizeReply(text: string) {
  const clean = String(text || '').replace(/\s+$/g, '').trim()
  if (!clean) return 'أهلاً بك في الأكاديمية الأمريكية للاستشارات والتدريب. كيف يمكنني مساعدتك؟'
  // WhatsApp text body limit is high, but keep the assistant practical and readable.
  return clean.length > 3800 ? `${clean.slice(0, 3750)}\n\nللتفصيل أكثر اكتب: أكمل` : clean
}

async function buildAcademyReply(message: string, name?: string) {
  const prompt = String(message || '').trim()
  if (!prompt) return 'أرسل سؤالك عن برامج الأكاديمية أو القبول أو الرسوم أو الشهادات وسأساعدك مباشرة.'

  const system = `أنت وكيل واتساب الذكي الرسمي لمنصة ${ACADEMY_INFO.nameAr}.

مهمتك:
- تجيب عن استفسارات الطلاب والزوار بخصوص الأكاديمية والبرامج والقبول والرسوم والشهادات والتحقق والاعتماد والوكالة.
- لا تدّعي تنفيذ عملية إدارية إن لم تنفذها فعلياً؛ اشرح الخطوة داخل المنصة.
- إذا احتاج الأمر قراراً بشرياً أو دفعاً أو اعتماداً، قل إن القرار النهائي للإدارة.
- اكتب بالعربية المختصرة والواضحة، مناسبة لرسالة واتساب.
- ابدأ بإجابة مباشرة، ثم خطوات عملية عند الحاجة.
- لا تعرض أسراراً تقنية أو مفاتيح أو أسماء جداول.

بيانات رسمية:
- اسم الأكاديمية: ${ACADEMY_INFO.nameAr}.
- البريد: ${ACADEMY_INFO.email}.
- واتساب التواصل: ${ACADEMY_INFO.whatsapp}.
- رسوم تقديم القبول: ${ADMISSION_FEES.applicationFee}$ غير مستردة.
- شروط القبول: ${ADMISSION_GUIDE.conditions.join(' / ')}.
- المستندات المطلوبة: ${ADMISSION_GUIDE.documents.join(' / ')}.
- رسوم تقديم طلب الاعتماد: ${ACCREDITATION_GUIDE.applicationFee}$ غير مستردة.

كتالوج مختصر للبرامج:
${academyProgramsDigest()}

اسم المتواصل إن توفر: ${name || 'غير معروف'}.`

  if (await ensureGeminiKey().catch(() => false)) {
    try {
      const reply = await geminiComplete({
        system,
        history: [{ role: 'user', text: prompt }],
        temperature: 0.35,
        maxOutputTokens: 1100,
      })
      return normalizeReply(reply)
    } catch (e) {
      console.error('whatsapp academy agent gemini failed:', String((e as any)?.message || e).slice(0, 300))
    }
  }

  return normalizeReply(`أهلاً ${name ? name : 'بك'} في ${ACADEMY_INFO.nameAr}.

يمكنني مساعدتك في:
- اختيار البرنامج المناسب.
- شروط القبول والمستندات المطلوبة.
- رسوم التقديم والدفع.
- الشهادات والتحقق.
- الاعتماد والوكالة الدولية.

رسوم تقديم القبول: ${ADMISSION_FEES.applicationFee}$ غير مستردة.
المستندات المطلوبة عادةً: ${ADMISSION_GUIDE.documents.join('، ')}.

اكتب سؤالك بالتفصيل وسأوجهك للخطوة الصحيحة.`)
}

async function sendWhatsAppText(to: string, body: string) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.warn('WhatsApp env not configured: WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID')
    return
  }
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: normalizeReply(body) },
    }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    console.error('WhatsApp send failed:', res.status, err.slice(0, 500))
  }
}

function extractInboundMessages(payload: any) {
  const out: { from: string; id?: string; name?: string; text: string; type: string }[] = []
  const entries = Array.isArray(payload?.entry) ? payload.entry : []
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : []
    for (const change of changes) {
      const value = change?.value || {}
      const contacts = Array.isArray(value.contacts) ? value.contacts : []
      const nameByWaId = new Map<string, string>()
      for (const c of contacts) {
        if (c?.wa_id) nameByWaId.set(String(c.wa_id), String(c?.profile?.name || ''))
      }
      const messages = Array.isArray(value.messages) ? value.messages : []
      for (const m of messages) {
        const from = String(m?.from || '')
        if (!from) continue
        const type = String(m?.type || 'unknown')
        let text = ''
        if (type === 'text') text = String(m?.text?.body || '').trim()
        else if (type === 'button') text = String(m?.button?.text || '').trim()
        else if (type === 'interactive') text = String(m?.interactive?.button_reply?.title || m?.interactive?.list_reply?.title || '').trim()
        else if (type === 'audio') text = 'أرسلت رسالة صوتية عبر واتساب. أجبني بإرشاد واضح، واذكر أن المحادثة الصوتية الحية ثنائية الاتجاه متاحة داخل المنصة من أيقونة واتساب الذكي أو زر الهاتف.'
        else text = `أرسل المستخدم رسالة من نوع ${type}. وجّهه لإرسال نص واضح أو استخدام الوكيل الصوتي داخل المنصة.`
        out.push({ from, id: m?.id, name: nameByWaId.get(from) || '', text, type })
      }
    }
  }
  return out
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge') || ''

  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return new NextResponse(challenge, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } })
  }
  return json({ error: 'WhatsApp webhook verification failed' }, 403)
}

export async function POST(req: NextRequest) {
  const raw = await req.text()
  if (!verifyMetaSignature(raw, req.headers.get('x-hub-signature-256'))) {
    return json({ error: 'Invalid WhatsApp signature' }, 401)
  }

  let payload: any = null
  try {
    payload = JSON.parse(raw || '{}')
  } catch {
    return json({ error: 'Invalid JSON' }, 400)
  }

  const messages = extractInboundMessages(payload)
  // يجب الرد سريعاً لـ Meta، لكن هنا ننتظر الرسائل القصيرة لأن الاستخدام المتوقع محدود. عند التوسع ننقلها إلى queue.
  await Promise.all(messages.slice(0, 5).map(async (m) => {
    try {
      const reply = await buildAcademyReply(m.text, m.name)
      await sendWhatsAppText(m.from, reply)
    } catch (e) {
      console.error('WhatsApp agent message failed:', String((e as any)?.message || e).slice(0, 300))
      await sendWhatsAppText(m.from, 'تعذر على وكيل الأكاديمية معالجة الرسالة الآن. أعد المحاولة بعد قليل أو افتح الوكيل الذكي داخل المنصة للمحادثة الصوتية الحية.')
    }
  }))

  return json({ ok: true, handled: messages.length })
}
