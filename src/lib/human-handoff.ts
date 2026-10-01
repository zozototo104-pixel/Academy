import { db } from '@/lib/db'
import { ensureGeminiKey, geminiCompleteJson } from '@/lib/gemini'
import { makeBasicEmailHtml, sendMail } from '@/lib/mail'

export const HUMAN_SUPPORT_REPLY = [
  'أهلًا وسهلًا بك 🌟',
  'يسعدنا خدمتك. إذا كنت ترغب بالتواصل مع موظف حقيقي أو الإدارة مباشرة، يمكنك مراسلتنا عبر واتساب أو الاتصال على أحد الأرقام التالية:',
  '',
  '📞 +972594403737',
  '📞 +970 598 400 510',
  '',
  'اكتب لنا اسمك وموضوعك باختصار، وسيتم توجيهك للموظف المختص بإذن الله.',
].join('\n')

export const HUMAN_HANDOFF_CONFIRMATION_REPLY = [
  'تم استلام طلبك وتحويله لفريق الإدارة 🌟',
  '',
  'وصلنا اسمك وموضوعك، وسيقوم موظف مختص بمراجعة الطلب والتواصل معك عبر الأرقام الرسمية أو من خلال بيانات التواصل المسجلة لديك.',
  '',
  'للاستعجال يمكنك أيضًا مراسلة الإدارة مباشرة على:',
  '📞 +972594403737',
  '📞 +970 598 400 510',
].join('\n')

export const HUMAN_HANDOFF_ACTIVE_NOTE = '\n\nملاحظة: طلبك السابق للتواصل مع الإدارة ما زال مسجلاً لدى الفريق، ويمكنك متابعة أسئلتك هنا إلى حين تواصل الموظف المختص معك.'

function normalizeArabic(text: string): string {
  return text
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u065F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function includesAny(n: string, words: string[]) {
  return words.some((w) => n.includes(normalizeArabic(w)))
}

function hasHandoffAction(n: string) {
  return includesAny(n, [
    'اريد',
    'بدي',
    'ابي',
    'ابغي',
    'ابغى',
    'احتاج',
    'محتاج',
    'ممكن',
    'لو سمحت',
    'حولني',
    'حوّلني',
    'وجهني',
    'وجّهني',
    'وصلني',
    'اكلم',
    'احكي',
    'اتواصل',
    'كلم',
    'راسل',
    'مراسله',
    'مراسلة',
    'رقم',
    'واتساب',
  ])
}

function hasHumanSupportTarget(n: string) {
  return includesAny(n, [
    'موظف حقيقي',
    'موظف بشري',
    'الموظف',
    'موظف',
    'شخص حقيقي',
    'انسان حقيقي',
    'الدعم البشري',
    'دعم بشري',
    'الدعم الانساني',
    'دعم انساني',
    'الاداره',
    'اداره',
    'الادمن',
    'ادمن',
    'فريق الدعم',
    'الدعم',
  ])
}

function looksLikeEmployeeLearningContext(n: string) {
  const learningContext = includesAny(n, [
    'حقوق الموظف',
    'واجبات الموظف',
    'مهام الموظف',
    'تدريب الموظف',
    'تدريب الموظفين',
    'اداره الموظفين',
    'ادارة الموظفين',
    'موارد بشريه',
    'موارد بشرية',
    'دوره للموظفين',
    'دورة للموظفين',
    'حقيبه تدريبيه للموظفين',
    'حقيبة تدريبية للموظفين',
  ])
  const explicitHandoff = includesAny(n, ['حولني', 'وجهني', 'اكلم', 'احكي', 'اتواصل', 'رقم', 'واتساب', 'الدعم البشري', 'دعم بشري'])
  return learningContext && !explicitHandoff
}

export function wantsHumanSupport(message: string) {
  const n = normalizeArabic(message)
  if (!n) return false
  if (looksLikeEmployeeLearningContext(n)) return false

  const explicitHumanPhrase = includesAny(n, [
    'موظف حقيقي',
    'موظف بشري',
    'شخص حقيقي',
    'انسان حقيقي',
    'الدعم البشري',
    'دعم بشري',
    'الدعم الانساني',
    'دعم انساني',
    'تواصل بشري',
  ])
  if (explicitHumanPhrase && hasHandoffAction(n)) return true

  return hasHandoffAction(n) && hasHumanSupportTarget(n)
}

function looksLikeQuestion(message: string) {
  const n = normalizeArabic(message)
  return /[؟?]/.test(message) || includesAny(n, [
    'كم',
    'متي',
    'متى',
    'كيف',
    'هل',
    'شو',
    'ما هو',
    'ما هي',
    'اين',
    'وين',
    'ليش',
    'لماذا',
    'ما الذي',
  ])
}

export function looksLikeHumanHandoffDetails(message: string) {
  const raw = String(message || '').trim()
  const n = normalizeArabic(raw)
  if (raw.length < 8) return false
  if (looksLikeQuestion(raw)) return false
  if (wantsHumanSupport(raw) && raw.length >= 24) return true
  if (includesAny(n, ['اسمي', 'انا اسمي', 'الاسم', 'اسمي هو', 'انا اسمي هو'])) return true
  if (includesAny(n, ['موضوعي', 'الموضوع', 'بخصوص', 'بشان', 'بشأن', 'خصوص التسجيل', 'خصوص الدفع', 'خصوص الرسوم'])) return true
  return raw.length >= 28
}

type HumanHandoffIntentDecision = {
  wantsHumanSupport: boolean
  isHandoffDetails: boolean
  isAcademicOrServiceQuestion: boolean
  confidence: number
  reason?: string
}

function parseJsonObject(text: string): any | null {
  const raw = String(text || '').trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch {}
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function normalizeConfidence(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function fallbackHumanHandoffIntent(message: string, context?: { promptActive?: boolean }): HumanHandoffIntentDecision {
  const wants = wantsHumanSupport(message)
  const question = looksLikeQuestion(message)
  return {
    wantsHumanSupport: wants,
    isHandoffDetails: Boolean(context?.promptActive && !question && looksLikeHumanHandoffDetails(message)),
    isAcademicOrServiceQuestion: question,
    confidence: wants ? 0.72 : 0.35,
    reason: 'fallback-rule',
  }
}

export async function analyzeHumanHandoffIntent(message: string, context?: {
  promptActive?: boolean
  handoffOpen?: boolean
  recentMessages?: Array<{ role: string; content: string }>
}) {
  const raw = String(message || '').trim()
  const fallback = fallbackHumanHandoffIntent(raw, context)
  if (!raw) return fallback
  const ready = await ensureGeminiKey().catch(() => false)
  if (!ready) return fallback
  try {
    const recent = (context?.recentMessages || []).slice(-8).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 700),
    }))
    const result = await geminiCompleteJson({
      system: [
        'أنت مصنّف نية دلالي لمحادثة واتساب في منصة أكاديمية. لا تكتب رداً للمستخدم؛ أرجع JSON فقط.',
        'حلل الرسالة الأخيرة ضمن سياق المحادثة، ولا تعتمد على كلمة منفردة مثل بخصوص أو دعم أو موظف دون فهم الجملة.',
        'wantsHumanSupport=true فقط إذا كان المستخدم يريد بوضوح نقله إلى إنسان/خدمة عملاء/دعم فني/إدارة/موظف يتابع معه.',
        'isHandoffDetails=true فقط إذا كان المستخدم يكتب اسمه وموضوعه/بياناته بعد أن طُلب منه ذلك، وليس إذا كان يسأل سؤالاً معرفياً أو أكاديمياً.',
        'إذا كانت الرسالة سؤالاً عن البرامج أو التخصصات أو الرسوم أو التسجيل أو الشهادات، اجعل isAcademicOrServiceQuestion=true و isHandoffDetails=false حتى لو احتوت كلمة مثل بخصوص.',
        'أمثلة للفهم فقط لا للحفظ: "حولني للدعم الفني" طلب موظف. "طيب بخصوص الماجستير شو التخصصات الموجودة" سؤال أكاديمي وليس تفاصيل تحويل.',
        'أرجع JSON بالشكل: {"wantsHumanSupport":boolean,"isHandoffDetails":boolean,"isAcademicOrServiceQuestion":boolean,"confidence":0.0,"reason":"..."}',
      ].join('\n'),
      history: [{
        role: 'user',
        text: JSON.stringify({
          promptActive: Boolean(context?.promptActive),
          handoffOpen: Boolean(context?.handoffOpen),
          recentMessages: recent,
          lastMessage: raw,
        }, null, 2),
      }],
      temperature: 0,
      maxOutputTokens: 400,
    })
    const parsed = parseJsonObject(result)
    if (!parsed) return fallback
    const decision: HumanHandoffIntentDecision = {
      wantsHumanSupport: Boolean(parsed.wantsHumanSupport),
      isHandoffDetails: Boolean(parsed.isHandoffDetails),
      isAcademicOrServiceQuestion: Boolean(parsed.isAcademicOrServiceQuestion),
      confidence: normalizeConfidence(parsed.confidence),
      reason: String(parsed.reason || '').slice(0, 220) || undefined,
    }
    if (decision.isAcademicOrServiceQuestion) decision.isHandoffDetails = false
    return decision
  } catch (error: any) {
    console.warn('human handoff intent analysis failed:', String(error?.message || error).slice(0, 220))
    return fallback
  }
}

export function withHumanHandoffActiveNote(reply: string) {
  if (!reply.trim()) return reply
  if (reply.includes('طلبك السابق للتواصل مع الإدارة')) return reply
  return `${reply.trim()}${HUMAN_HANDOFF_ACTIVE_NOTE}`
}

export async function hasOpenHumanHandoffRequest(args: {
  userId?: string | null
  sourceRef?: string | null
  email?: string | null
  phone?: string | null
  days?: number
}) {
  const days = args.days ?? 7
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const refs = Array.from(new Set([args.sourceRef, args.userId].filter((v): v is string => Boolean(v))))
  const or: any[] = []
  if (args.userId) or.push({ requesterId: args.userId })
  for (const ref of refs) or.push({ sourceRef: ref })
  if (args.email) or.push({ email: args.email })
  if (args.phone) or.push({ phone: args.phone })
  if (!or.length) return false

  const open = await db.humanHandoffRequest.findFirst({
    where: {
      status: { in: ['NEW', 'IN_PROGRESS'] },
      createdAt: { gte: since },
      OR: or,
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null)
  if (open) return true

  // احتياط مؤقت إذا لم يكن جدول HumanHandoffRequest موجوداً في قاعدة الإنتاج بعد.
  const fallbackOr: any[] = []
  for (const ref of refs) fallbackOr.push({ message: { contains: `مرجع المحادثة: ${ref}` } })
  if (args.email) fallbackOr.push({ email: args.email })
  if (args.phone) fallbackOr.push({ phone: args.phone })
  if (!fallbackOr.length) return false
  const fallback = await db.contactMessage.findFirst({
    where: {
      subject: 'طلب تواصل بشري من الوكيل الذكي',
      handled: false,
      createdAt: { gte: since },
      OR: fallbackOr,
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null)
  return !!fallback
}

export async function hasRecentHumanHandoffRequest(userId: string, days = 7) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, phone: true },
  }).catch(() => null)
  return hasOpenHumanHandoffRequest({
    userId,
    sourceRef: userId,
    email: user?.email || null,
    phone: user?.phone || null,
    days,
  })
}

export function hadRecentHumanSupportPrompt(messages: Array<{ role: string; content: string }>) {
  const recent = messages.slice(-8)
  const lastSubmittedIdx = recent.findLastIndex((m) => m.role === 'assistant' && m.content.includes('تم استلام طلبك وتحويله لفريق الإدارة'))
  const afterSubmit = lastSubmittedIdx >= 0 ? recent.slice(lastSubmittedIdx + 1) : recent
  return afterSubmit.some((m) =>
    (m.role === 'user' && wantsHumanSupport(m.content)) ||
    (m.role === 'assistant' && m.content.includes('+972594403737') && m.content.includes('+970 598 400 510'))
  )
}

export async function createHumanHandoffRequest(args: {
  user: { id?: string | null; name?: string | null; email?: string | null; phone?: string | null; role?: string | null }
  message: string
  source: 'CHAT' | 'WHATSAPP'
  sourceRef?: string | null
}) {
  const subject = String(args.message || '').trim().slice(0, 1500)
  if (!subject) return { ok: false, created: false }

  const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true, email: true } }).catch(() => [])
  const displayName = args.user.name || (args.source === 'WHATSAPP' ? 'زائر واتساب' : 'مستخدم غير محدد الاسم')
  const contact = [args.user.email, args.user.phone].filter(Boolean).join(' / ') || 'لا توجد بيانات تواصل مسجلة'
  const link = args.source === 'CHAT' && args.user.id ? `/admin?userId=${encodeURIComponent(args.user.id)}` : '/admin?tab=messages'
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || process.env.NEXTAUTH_URL || '').replace(/\/$/, '')
  const absoluteLink = appUrl ? `${appUrl}${link}` : link
  const body = [
    `طلب المستخدم ${displayName} التواصل مع موظف بشري.`,
    `المصدر: ${args.source === 'CHAT' ? 'محادثة الوكيل داخل المنصة' : 'واتساب الرسمي'}.`,
    `بيانات التواصل: ${contact}.`,
    args.sourceRef ? `مرجع المحادثة: ${args.sourceRef}.` : '',
    '',
    `موضوع المستخدم: ${subject}`,
  ].filter(Boolean).join('\n')

  const contactMessage = await db.contactMessage.create({
    data: {
      name: displayName.slice(0, 120),
      email: (args.user.email || 'human-handoff@aactacademy.local').slice(0, 180),
      phone: args.user.phone || null,
      subject: 'طلب تواصل بشري من الوكيل الذكي',
      message: body.slice(0, 3000),
    },
    select: { id: true },
  }).catch(() => null)

  const handoffRequest = await db.humanHandoffRequest.create({
    data: {
      requesterId: args.user.id || null,
      source: args.source,
      sourceRef: args.sourceRef || args.user.id || null,
      name: displayName.slice(0, 120),
      email: args.user.email || null,
      phone: args.user.phone || null,
      subject: 'طلب تواصل بشري من الوكيل الذكي',
      message: subject,
      status: 'NEW',
      contactMessageId: contactMessage?.id || null,
    },
    select: { id: true },
  }).catch(() => null)

  if (admins.length) {
    await db.notification.createMany({
      data: admins.map((admin) => ({
        userId: admin.id,
        type: 'AGENT',
        title: 'طلب تواصل بشري من الوكيل الذكي',
        body: body.slice(0, 1800),
        link,
      })),
    }).catch(() => {})
  }

  const adminEmails = Array.from(new Set(admins.map((admin) => admin.email).filter((email): email is string => Boolean(email))))
  if (adminEmails.length) {
    const mailSubject = 'طلب تواصل بشري من الوكيل الذكي'
    const html = makeBasicEmailHtml(mailSubject, body, absoluteLink)
    const result: any = await sendMail({ to: adminEmails, subject: mailSubject, html, text: body }).catch((e: any) => ({ ok: false, error: e?.message || 'mail failed' }))
    await db.emailLog.create({
      data: {
        to: adminEmails.join(','),
        subject: mailSubject,
        event: 'HUMAN_HANDOFF_REQUEST',
        status: result?.ok ? (result?.skipped ? 'SKIPPED' : 'SENT') : 'FAILED',
        error: result?.ok ? null : (result?.error || 'mail failed'),
      },
    }).catch(() => {})
  }

  await db.auditLog.create({
    data: {
      actorId: args.user.id || null,
      actorName: displayName,
      action: 'HUMAN_HANDOFF_REQUEST_SUBMITTED',
      entity: 'HumanHandoff',
      entityId: args.sourceRef || args.user.id || null,
      details: JSON.stringify({ source: args.source, contact, subject }).slice(0, 3000),
    },
  }).catch(() => {})

  return { ok: true, created: true, id: handoffRequest?.id || null }
}
