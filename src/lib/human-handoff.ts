import { db } from '@/lib/db'

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

export function wantsHumanSupport(message: string) {
  const n = normalizeArabic(message)
  return includesAny(n, [
    'موظف حقيقي',
    'موظف بشري',
    'شخص حقيقي',
    'انسان حقيقي',
    'تواصل بشري',
    'دعم بشري',
    'اكلم موظف',
    'احكي مع موظف',
    'احكي لموظف',
    'اريد موظف',
    'بدي موظف',
    'ابي موظف',
    'اريد الادمن',
    'بدي الادمن',
    'كلم الاداره',
    'اكلم الاداره',
    'رقم الاداره',
    'رقم واتساب',
    'رقم التواصل',
    'اتواصل مع الاداره',
    'التواصل مع الاداره',
    'واتساب الاداره',
    'تحويل لموظف',
    'حولني لموظف',
    'مراسله موظف',
    'مراسلة موظف',
  ])
}

function looksLikeQuestion(message: string) {
  const n = normalizeArabic(message)
  return /\?/.test(message) || includesAny(n, [
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
  if (wantsHumanSupport(raw) && raw.length >= 24) return true
  if (includesAny(n, ['اسمي', 'انا اسمي', 'الاسم', 'اسمي هو', 'انا اسمي هو'])) return true
  if (includesAny(n, ['موضوعي', 'الموضوع', 'بخصوص', 'بشان', 'بشأن', 'خصوص التسجيل', 'خصوص الدفع', 'خصوص الرسوم'])) return true
  if (looksLikeQuestion(raw)) return false
  return raw.length >= 28
}

export function withHumanHandoffActiveNote(reply: string) {
  if (!reply.trim()) return reply
  if (reply.includes('طلبك السابق للتواصل مع الإدارة')) return reply
  return `${reply.trim()}${HUMAN_HANDOFF_ACTIVE_NOTE}`
}

export async function hasRecentHumanHandoffRequest(userId: string, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const found = await db.auditLog.findFirst({
    where: {
      actorId: userId,
      action: 'HUMAN_HANDOFF_REQUEST_SUBMITTED',
      entity: 'HumanHandoff',
      createdAt: { gte: since },
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  }).catch(() => null)
  return !!found
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
  user: { id: string; name?: string | null; email?: string | null; phone?: string | null; role?: string | null }
  message: string
  source: 'CHAT' | 'WHATSAPP'
  sourceRef?: string | null
}) {
  const subject = String(args.message || '').trim().slice(0, 1500)
  if (!subject) return { ok: false, created: false }

  const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } }).catch(() => [])
  const displayName = args.user.name || 'مستخدم غير محدد الاسم'
  const contact = [args.user.email, args.user.phone].filter(Boolean).join(' / ') || 'لا توجد بيانات تواصل مسجلة'
  const link = args.source === 'CHAT' ? `/admin?userId=${encodeURIComponent(args.user.id)}` : undefined
  const body = [
    `طلب المستخدم ${displayName} التواصل مع موظف بشري.`,
    `المصدر: ${args.source === 'CHAT' ? 'محادثة الوكيل داخل المنصة' : 'واتساب الرسمي'}.`,
    `بيانات التواصل: ${contact}.`,
    args.sourceRef ? `مرجع المحادثة: ${args.sourceRef}.` : '',
    '',
    `موضوع المستخدم: ${subject}`,
  ].filter(Boolean).join('\n')

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

  await db.auditLog.create({
    data: {
      actorId: args.user.id,
      actorName: displayName,
      action: 'HUMAN_HANDOFF_REQUEST_SUBMITTED',
      entity: 'HumanHandoff',
      entityId: args.sourceRef || args.user.id,
      details: JSON.stringify({ source: args.source, contact, subject }).slice(0, 3000),
    },
  }).catch(() => {})

  return { ok: true, created: true }
}
