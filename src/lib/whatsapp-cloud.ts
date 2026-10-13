import crypto from 'crypto'
import { db } from '@/lib/db'
import { platformPublicAgentComplete } from '@/lib/platform-agent'
import { DEFAULT_OFFICIAL_CONTACT, DEFAULT_SETTINGS, getOfficialContact, getSettings } from '@/lib/settings'
import { wrapUntrustedUiContext } from '@/lib/untrusted-context'
import { hashWhatsAppId } from '@/lib/whatsapp-conversations'
import { unsignedWebhookTestsAllowed } from '@/lib/prod-safety'

type WhatsAppConfig = {
  accessToken: string
  phoneNumberId: string
  graphVersion: string
}

export type WhatsAppInboundMessage = {
  id: string
  from: string
  text: string
  name?: string
  phoneNumberId?: string
  rawType?: string
  mediaId?: string
  mediaMimeType?: string
  mediaSha256?: string
  mediaFileSize?: number
  isVoice?: boolean
  originKind?: 'TEXT' | 'VOICE'
}

function trim(value: unknown) {
  return String(value || '').trim()
}

function compactText(value: unknown, max = 1200) {
  return trim(value).replace(/\s+/g, ' ').slice(0, max)
}

const WHATSAPP_CUSTOMER_CARE_WINDOW_MS = 24 * 60 * 60 * 1000

type WhatsAppFaqDeps = {
  getSettings: () => Promise<Record<string, string>>
  getOfficialContact: () => Promise<any>
  listPrograms: () => Promise<Array<{ titleAr: string; titleEn?: string | null; category?: string | null; price?: number | null; hours?: number | null }>>
}

const DEFAULT_SETTING_VALUES = Object.fromEntries(DEFAULT_SETTINGS.map((item) => [item.key, item.value])) as Record<string, string>

function normalizeWhatsAppFaqText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function includesFaqAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term))
}

type WhatsAppDirectReplyContext = {
  from?: string | null
  recentMessages?: Array<{ role?: string; direction?: string; sender?: string; text?: string; content?: string }>
}

type WhatsAppDirectIntent = 'PAYMENT' | 'FEES' | 'CONTACT' | 'PROGRAMS' | 'CERTIFICATE' | 'ACCREDITATION'

function faqWords(text: string) {
  return text.split(/\s+/).map((word) => word.trim()).filter(Boolean)
}

function normalizeReadyReplyText(value: string) {
  return normalizeWhatsAppFaqText(value).replace(/\s+/g, ' ').trim()
}

function isStandaloneGenericFaqToken(q: string) {
  return new Set(['رقم', 'واتساب', 'واتس', 'تواصل', 'التواصل', 'الشهاده', 'الشهادة', 'تحويل', 'سعر', 'رسوم']).has(q)
}

function classifyWhatsAppDirectSettingsIntent(q: string): WhatsAppDirectIntent | null {
  const words = faqWords(q)
  if (!q || words.length > 10 || isStandaloneGenericFaqToken(q)) return null
  if (/(?:بخصوص|بشان|بشأن|حول|عن|خصوص).{0,30}(?:التسجيل|تسجيل|القبول|طلب|برنامج)/.test(q)) return null
  if (/(?:كيف|شو|ما|ماهي|ما هي|ايش|اريد|بدي|ممكن|اعطيني|اين|وين|كم)/.test(q) || words.length <= 5) {
    if (/(?:طرق الدفع|طريقه الدفع|طريقة الدفع|كيف ادفع|كيف الدفع|الدفع|usdt|بينانس|binance)/i.test(q) && !/^(?:تحويل|الدفع)$/.test(q)) return 'PAYMENT'
    if (/(?:كم الرسوم|شو الرسوم|ما الرسوم|رسوم التسجيل|رسوم البرنامج|كم السعر|شو السعر|ما السعر|تكلفه|تكلفة|كم بدفع|الاقساط|اقساط|قسط)/.test(q) || /(?:سعر|رسوم).{0,16}(?:الدكتوراه|الماجستير|الدبلوم|البرنامج|التسجيل)/.test(q)) return 'FEES'
    if (/(?:رقم التواصل|ارقام التواصل|بيانات التواصل|طرق التواصل|وسائل التواصل|رقمكم|ارقامكم|واتسابكم|واتسكم|رقم الاكاديميه|رقم الاكاديمية|هاتفكم|ايميلكم|بريدكم|كيف اتواصل معكم|كيف اتواصل وياكم|معلومات التواصل)/.test(q)) return 'CONTACT'
    if (/(?:ما البرامج|شو البرامج|البرامج المتاحه|البرامج المتاحة|التخصصات المتاحه|التخصصات المتاحة|ما التخصصات|شو التخصصات|قائمه البرامج|قائمة البرامج)/.test(q)) return 'PROGRAMS'
    if (/(?:مده الشهاده|مدة الشهادة|متى تصدر|اصدار الشهاده|اصدار الشهادة|إصدار الشهادة|موعد الشهاده|موعد الشهادة)/.test(q)) return 'CERTIFICATE'
    if (/(?:الاعتماد|اعتماد|معتمده|معتمدة|ترخيص|توثيق).{0,30}(?:الاكاديميه|الاكاديمية|الشهاده|الشهادة|البرنامج|الدبلوم|الماجستير|الدكتوراه)?/.test(q) && !/^(?:اعتماد|الاعتماد|توثيق|ترخيص)$/.test(q)) return 'ACCREDITATION'
  }
  return null
}

async function directReplyWasRecentlySent(reply: string, context: WhatsAppDirectReplyContext = {}) {
  const target = normalizeReadyReplyText(reply)
  if (!target) return false
  const contextMessages = (context.recentMessages || []).slice(-10)
  if (contextMessages.some((message) => {
    const role = String(message.role || '').toLowerCase()
    const direction = String(message.direction || '').toUpperCase()
    const sender = String(message.sender || '').toUpperCase()
    const text = String(message.text || message.content || '')
    return (role === 'assistant' || direction === 'OUTBOUND' || sender === 'BOT') && normalizeReadyReplyText(text) === target
  })) return true
  const from = String(context.from || '').trim()
  if (!from) return false
  const conversation = await db.whatsAppConversation.findUnique({
    where: { waIdHash: hashWhatsAppId(from) },
    select: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { direction: true, sender: true, text: true },
      },
    },
  }).catch(() => null)
  return Boolean((conversation?.messages || []).some((message) => message.direction === 'OUTBOUND' && message.sender === 'BOT' && normalizeReadyReplyText(message.text) === target))
}

async function suppressRepeatedDirectReply(reply: string, context?: WhatsAppDirectReplyContext) {
  if (await directReplyWasRecentlySent(reply, context)) return null
  return reply
}

function settingValue(values: Record<string, string>, key: string) {
  return String(values[key] ?? DEFAULT_SETTING_VALUES[key] ?? '').trim()
}

function usd(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? `${n}$` : 'غير مضبوط حالياً'
}

async function listPublicProgramsForWhatsApp() {
  return db.program.findMany({
    where: { active: true },
    orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
    take: 8,
    select: { titleAr: true, titleEn: true, category: true, price: true, hours: true },
  })
}

export async function resolveWhatsAppDirectSettingsReply(text: string, deps: WhatsAppFaqDeps = { getSettings, getOfficialContact, listPrograms: listPublicProgramsForWhatsApp }, context: WhatsAppDirectReplyContext = {}) {
  const q = normalizeWhatsAppFaqText(text)
  const intent = classifyWhatsAppDirectSettingsIntent(q)
  if (!intent) return null
  const values = await deps.getSettings().catch(() => DEFAULT_SETTING_VALUES)
  const contact = await deps.getOfficialContact().catch(() => DEFAULT_OFFICIAL_CONTACT)

  if (intent === 'PAYMENT') {
    const mode = settingValue(values, 'PAYMENT_MODE') || 'DIRECT_PAYMENT'
    const usdt = settingValue(values, 'USDT_WALLET_ADDRESS')
    const network = settingValue(values, 'USDT_NETWORK')
    const parts = [`طرق الدفع المتاحة تضبطها الإدارة من لوحة المنصة. الوضع الحالي: ${mode}.`]
    if (usdt) parts.push(`USDT: ${usdt}${network ? ` — الشبكة: ${network}` : ''}`)
    parts.push('بعد إنشاء الطلب أو الفاتورة من بوابة الطالب، تُراجع الإدارة السداد وتؤكده.')
    return suppressRepeatedDirectReply(parts.join('\n'), context)
  }

  if (intent === 'FEES') {
    return suppressRepeatedDirectReply([
      `رسوم التقديم: ${usd(settingValue(values, 'FEE_APPLICATION'))}.`,
      `الدبلومات عادة من ${usd(settingValue(values, 'FEE_DIPLOMAS_MIN'))} إلى ${usd(settingValue(values, 'FEE_DIPLOMAS_MAX'))}.`,
      `الماجستير المهني يبدأ من ${usd(settingValue(values, 'FEE_MASTERS'))}.`,
      `الدكتوراه المهنية تبدأ من ${usd(settingValue(values, 'FEE_DOCTORATE'))}.`,
      'إذا ذكرت اسم البرنامج أعطيك السعر المحدد له من إعدادات القبول.',
    ].join('\n'), context)
  }

  if (intent === 'CONTACT') {
    const phones = Array.from(new Set([contact.phone, ...(contact.phones || []), contact.whatsapp, ...(contact.whatsapps || [])].filter(Boolean))).join(' / ') || 'غير مضبوط'
    return suppressRepeatedDirectReply(`بيانات التواصل الرسمية:\nالهاتف/واتساب: ${phones}\nالبريد: ${contact.email || 'غير مضبوط'}\nالعنوان: ${contact.address || 'غير مضبوط'}`, context)
  }

  if (intent === 'PROGRAMS') {
    const programs = await deps.listPrograms().catch(() => [])
    if (!programs.length) return suppressRepeatedDirectReply('البرامج المتاحة تظهر من كتالوج المنصة، لكن القائمة غير متاحة الآن. اكتب المجال المطلوب وسأوجهك للتسجيل أو التواصل مع الإدارة.', context)
    return suppressRepeatedDirectReply(`من البرامج المتاحة حالياً:\n${programs.map((p, i) => `${i + 1}. ${p.titleAr || p.titleEn || 'برنامج'}${p.hours ? ` — ${p.hours} ساعة` : ''}${p.price ? ` — ${p.price}import crypto from 'crypto'
import { db } from '@/lib/db'
import { platformPublicAgentComplete } from '@/lib/platform-agent'
import { DEFAULT_OFFICIAL_CONTACT, DEFAULT_SETTINGS, getOfficialContact, getSettings } from '@/lib/settings'
import { wrapUntrustedUiContext } from '@/lib/untrusted-context'
import { hashWhatsAppId } from '@/lib/whatsapp-conversations'
import { unsignedWebhookTestsAllowed } from '@/lib/prod-safety'

type WhatsAppConfig = {
  accessToken: string
  phoneNumberId: string
  graphVersion: string
}

export type WhatsAppInboundMessage = {
  id: string
  from: string
  text: string
  name?: string
  phoneNumberId?: string
  rawType?: string
  mediaId?: string
  mediaMimeType?: string
  mediaSha256?: string
  mediaFileSize?: number
  isVoice?: boolean
  originKind?: 'TEXT' | 'VOICE'
}

function trim(value: unknown) {
  return String(value || '').trim()
}

function compactText(value: unknown, max = 1200) {
  return trim(value).replace(/\s+/g, ' ').slice(0, max)
}

const WHATSAPP_CUSTOMER_CARE_WINDOW_MS = 24 * 60 * 60 * 1000

type WhatsAppFaqDeps = {
  getSettings: () => Promise<Record<string, string>>
  getOfficialContact: () => Promise<any>
  listPrograms: () => Promise<Array<{ titleAr: string; titleEn?: string | null; category?: string | null; price?: number | null; hours?: number | null }>>
}

const DEFAULT_SETTING_VALUES = Object.fromEntries(DEFAULT_SETTINGS.map((item) => [item.key, item.value])) as Record<string, string>

function normalizeWhatsAppFaqText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function includesFaqAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term))
}

type WhatsAppDirectReplyContext = {
  from?: string | null
  recentMessages?: Array<{ role?: string; direction?: string; sender?: string; text?: string; content?: string }>
}

type WhatsAppDirectIntent = 'PAYMENT' | 'FEES' | 'CONTACT' | 'PROGRAMS' | 'CERTIFICATE' | 'ACCREDITATION'

function faqWords(text: string) {
  return text.split(/\s+/).map((word) => word.trim()).filter(Boolean)
}

function normalizeReadyReplyText(value: string) {
  return normalizeWhatsAppFaqText(value).replace(/\s+/g, ' ').trim()
}

function isStandaloneGenericFaqToken(q: string) {
  return new Set(['رقم', 'واتساب', 'واتس', 'تواصل', 'التواصل', 'الشهاده', 'الشهادة', 'تحويل', 'سعر', 'رسوم']).has(q)
}

function classifyWhatsAppDirectSettingsIntent(q: string): WhatsAppDirectIntent | null {
  const words = faqWords(q)
  if (!q || words.length > 10 || isStandaloneGenericFaqToken(q)) return null
  if (/(?:بخصوص|بشان|بشأن|حول|عن|خصوص).{0,30}(?:التسجيل|تسجيل|القبول|طلب|برنامج)/.test(q)) return null
  if (/(?:كيف|شو|ما|ماهي|ما هي|ايش|اريد|بدي|ممكن|اعطيني|اين|وين|كم)/.test(q) || words.length <= 5) {
    if (/(?:طرق الدفع|طريقه الدفع|طريقة الدفع|كيف ادفع|كيف الدفع|الدفع|usdt|بينانس|binance)/i.test(q) && !/^(?:تحويل|الدفع)$/.test(q)) return 'PAYMENT'
    if (/(?:كم الرسوم|شو الرسوم|ما الرسوم|رسوم التسجيل|رسوم البرنامج|كم السعر|شو السعر|ما السعر|تكلفه|تكلفة|كم بدفع|الاقساط|اقساط|قسط)/.test(q) || /(?:سعر|رسوم).{0,16}(?:الدكتوراه|الماجستير|الدبلوم|البرنامج|التسجيل)/.test(q)) return 'FEES'
    if (/(?:رقم التواصل|ارقام التواصل|بيانات التواصل|طرق التواصل|وسائل التواصل|رقمكم|ارقامكم|واتسابكم|واتسكم|رقم الاكاديميه|رقم الاكاديمية|هاتفكم|ايميلكم|بريدكم|كيف اتواصل معكم|كيف اتواصل وياكم|معلومات التواصل)/.test(q)) return 'CONTACT'
    if (/(?:ما البرامج|شو البرامج|البرامج المتاحه|البرامج المتاحة|التخصصات المتاحه|التخصصات المتاحة|ما التخصصات|شو التخصصات|قائمه البرامج|قائمة البرامج)/.test(q)) return 'PROGRAMS'
    if (/(?:مده الشهاده|مدة الشهادة|متى تصدر|اصدار الشهاده|اصدار الشهادة|إصدار الشهادة|موعد الشهاده|موعد الشهادة)/.test(q)) return 'CERTIFICATE'
    if (/(?:الاعتماد|اعتماد|معتمده|معتمدة|ترخيص|توثيق).{0,30}(?:الاكاديميه|الاكاديمية|الشهاده|الشهادة|البرنامج|الدبلوم|الماجستير|الدكتوراه)?/.test(q) && !/^(?:اعتماد|الاعتماد|توثيق|ترخيص)$/.test(q)) return 'ACCREDITATION'
  }
  return null
}

async function directReplyWasRecentlySent(reply: string, context: WhatsAppDirectReplyContext = {}) {
  const target = normalizeReadyReplyText(reply)
  if (!target) return false
  const contextMessages = (context.recentMessages || []).slice(-10)
  if (contextMessages.some((message) => {
    const role = String(message.role || '').toLowerCase()
    const direction = String(message.direction || '').toUpperCase()
    const sender = String(message.sender || '').toUpperCase()
    const text = String(message.text || message.content || '')
    return (role === 'assistant' || direction === 'OUTBOUND' || sender === 'BOT') && normalizeReadyReplyText(text) === target
  })) return true
  const from = String(context.from || '').trim()
  if (!from) return false
  const conversation = await db.whatsAppConversation.findUnique({
    where: { waIdHash: hashWhatsAppId(from) },
    select: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { direction: true, sender: true, text: true },
      },
    },
  }).catch(() => null)
  return Boolean((conversation?.messages || []).some((message) => message.direction === 'OUTBOUND' && message.sender === 'BOT' && normalizeReadyReplyText(message.text) === target))
}

async function suppressRepeatedDirectReply(reply: string, context?: WhatsAppDirectReplyContext) {
  if (await directReplyWasRecentlySent(reply, context)) return null
  return reply
}

function settingValue(values: Record<string, string>, key: string) {
  return String(values[key] ?? DEFAULT_SETTING_VALUES[key] ?? '').trim()
}

function usd(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? `${n}$` : 'غير مضبوط حالياً'
}

async function listPublicProgramsForWhatsApp() {
  return db.program.findMany({
    where: { active: true },
    orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
    take: 8,
    select: { titleAr: true, titleEn: true, category: true, price: true, hours: true },
  })
}

export async function resolveWhatsAppDirectSettingsReply(text: string, deps: WhatsAppFaqDeps = { getSettings, getOfficialContact, listPrograms: listPublicProgramsForWhatsApp }, context: WhatsAppDirectReplyContext = {}) {
  const q = normalizeWhatsAppFaqText(text)
  const intent = classifyWhatsAppDirectSettingsIntent(q)
  if (!intent) return null
  const values = await deps.getSettings().catch(() => DEFAULT_SETTING_VALUES)
  const contact = await deps.getOfficialContact().catch(() => DEFAULT_OFFICIAL_CONTACT)

  if (intent === 'PAYMENT') {
    const mode = settingValue(values, 'PAYMENT_MODE') || 'DIRECT_PAYMENT'
    const usdt = settingValue(values, 'USDT_WALLET_ADDRESS')
    const network = settingValue(values, 'USDT_NETWORK')
    const parts = [`طرق الدفع المتاحة تضبطها الإدارة من لوحة المنصة. الوضع الحالي: ${mode}.`]
    if (usdt) parts.push(`USDT: ${usdt}${network ? ` — الشبكة: ${network}` : ''}`)
    parts.push('بعد إنشاء الطلب أو الفاتورة من بوابة الطالب، تُراجع الإدارة السداد وتؤكده.')
    return suppressRepeatedDirectReply(parts.join('\n'), context)
  }

  if (intent === 'FEES') {
    return suppressRepeatedDirectReply([
      `رسوم التقديم: ${usd(settingValue(values, 'FEE_APPLICATION'))}.`,
      `الدبلومات عادة من ${usd(settingValue(values, 'FEE_DIPLOMAS_MIN'))} إلى ${usd(settingValue(values, 'FEE_DIPLOMAS_MAX'))}.`,
      `الماجستير المهني يبدأ من ${usd(settingValue(values, 'FEE_MASTERS'))}.`,
      `الدكتوراه المهنية تبدأ من ${usd(settingValue(values, 'FEE_DOCTORATE'))}.`,
      'إذا ذكرت اسم البرنامج أعطيك السعر المحدد له من إعدادات القبول.',
    ].join('\n'), context)
  }

  if (intent === 'CONTACT') {
    const phones = Array.from(new Set([contact.phone, ...(contact.phones || []), contact.whatsapp, ...(contact.whatsapps || [])].filter(Boolean))).join(' / ') || 'غير مضبوط'
    return suppressRepeatedDirectReply(`بيانات التواصل الرسمية:\nالهاتف/واتساب: ${phones}\nالبريد: ${contact.email || 'غير مضبوط'}\nالعنوان: ${contact.address || 'غير مضبوط'}`, context)
  }

  if (intent === 'PROGRAMS') {
    const programs = await deps.listPrograms().catch(() => [])
    if (!programs.length) return suppressRepeatedDirectReply('البرامج المتاحة تظهر من كتالوج المنصة، لكن القائمة غير متاحة الآن. اكتب المجال المطلوب وسأوجهك للتسجيل أو التواصل مع الإدارة.', context)
 : ''}`).join('\n')}`, context)
    /*
import { db } from '@/lib/db'
import { platformPublicAgentComplete } from '@/lib/platform-agent'
import { DEFAULT_OFFICIAL_CONTACT, DEFAULT_SETTINGS, getOfficialContact, getSettings } from '@/lib/settings'
import { wrapUntrustedUiContext } from '@/lib/untrusted-context'
import { hashWhatsAppId } from '@/lib/whatsapp-conversations'
import { unsignedWebhookTestsAllowed } from '@/lib/prod-safety'

type WhatsAppConfig = {
  accessToken: string
  phoneNumberId: string
  graphVersion: string
}

export type WhatsAppInboundMessage = {
  id: string
  from: string
  text: string
  name?: string
  phoneNumberId?: string
  rawType?: string
  mediaId?: string
  mediaMimeType?: string
  mediaSha256?: string
  mediaFileSize?: number
  isVoice?: boolean
  originKind?: 'TEXT' | 'VOICE'
}

function trim(value: unknown) {
  return String(value || '').trim()
}

function compactText(value: unknown, max = 1200) {
  return trim(value).replace(/\s+/g, ' ').slice(0, max)
}

const WHATSAPP_CUSTOMER_CARE_WINDOW_MS = 24 * 60 * 60 * 1000

type WhatsAppFaqDeps = {
  getSettings: () => Promise<Record<string, string>>
  getOfficialContact: () => Promise<any>
  listPrograms: () => Promise<Array<{ titleAr: string; titleEn?: string | null; category?: string | null; price?: number | null; hours?: number | null }>>
}

const DEFAULT_SETTING_VALUES = Object.fromEntries(DEFAULT_SETTINGS.map((item) => [item.key, item.value])) as Record<string, string>

function normalizeWhatsAppFaqText(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function includesFaqAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term))
}

type WhatsAppDirectReplyContext = {
  from?: string | null
  recentMessages?: Array<{ role?: string; direction?: string; sender?: string; text?: string; content?: string }>
}

type WhatsAppDirectIntent = 'PAYMENT' | 'FEES' | 'CONTACT' | 'PROGRAMS' | 'CERTIFICATE' | 'ACCREDITATION'

function faqWords(text: string) {
  return text.split(/\s+/).map((word) => word.trim()).filter(Boolean)
}

function normalizeReadyReplyText(value: string) {
  return normalizeWhatsAppFaqText(value).replace(/\s+/g, ' ').trim()
}

function isStandaloneGenericFaqToken(q: string) {
  return new Set(['رقم', 'واتساب', 'واتس', 'تواصل', 'التواصل', 'الشهاده', 'الشهادة', 'تحويل', 'سعر', 'رسوم']).has(q)
}

function classifyWhatsAppDirectSettingsIntent(q: string): WhatsAppDirectIntent | null {
  const words = faqWords(q)
  if (!q || words.length > 10 || isStandaloneGenericFaqToken(q)) return null
  if (/(?:بخصوص|بشان|بشأن|حول|عن|خصوص).{0,30}(?:التسجيل|تسجيل|القبول|طلب|برنامج)/.test(q)) return null
  if (/(?:كيف|شو|ما|ماهي|ما هي|ايش|اريد|بدي|ممكن|اعطيني|اين|وين|كم)/.test(q) || words.length <= 5) {
    if (/(?:طرق الدفع|طريقه الدفع|طريقة الدفع|كيف ادفع|كيف الدفع|الدفع|usdt|بينانس|binance)/i.test(q) && !/^(?:تحويل|الدفع)$/.test(q)) return 'PAYMENT'
    if (/(?:كم الرسوم|شو الرسوم|ما الرسوم|رسوم التسجيل|رسوم البرنامج|كم السعر|شو السعر|ما السعر|تكلفه|تكلفة|كم بدفع|الاقساط|اقساط|قسط)/.test(q) || /(?:سعر|رسوم).{0,16}(?:الدكتوراه|الماجستير|الدبلوم|البرنامج|التسجيل)/.test(q)) return 'FEES'
    if (/(?:رقم التواصل|ارقام التواصل|بيانات التواصل|طرق التواصل|وسائل التواصل|رقمكم|ارقامكم|واتسابكم|واتسكم|رقم الاكاديميه|رقم الاكاديمية|هاتفكم|ايميلكم|بريدكم|كيف اتواصل معكم|كيف اتواصل وياكم|معلومات التواصل)/.test(q)) return 'CONTACT'
    if (/(?:ما البرامج|شو البرامج|البرامج المتاحه|البرامج المتاحة|التخصصات المتاحه|التخصصات المتاحة|ما التخصصات|شو التخصصات|قائمه البرامج|قائمة البرامج)/.test(q)) return 'PROGRAMS'
    if (/(?:مده الشهاده|مدة الشهادة|متى تصدر|اصدار الشهاده|اصدار الشهادة|إصدار الشهادة|موعد الشهاده|موعد الشهادة)/.test(q)) return 'CERTIFICATE'
    if (/(?:الاعتماد|اعتماد|معتمده|معتمدة|ترخيص|توثيق).{0,30}(?:الاكاديميه|الاكاديمية|الشهاده|الشهادة|البرنامج|الدبلوم|الماجستير|الدكتوراه)?/.test(q) && !/^(?:اعتماد|الاعتماد|توثيق|ترخيص)$/.test(q)) return 'ACCREDITATION'
  }
  return null
}

async function directReplyWasRecentlySent(reply: string, context: WhatsAppDirectReplyContext = {}) {
  const target = normalizeReadyReplyText(reply)
  if (!target) return false
  const contextMessages = (context.recentMessages || []).slice(-10)
  if (contextMessages.some((message) => {
    const role = String(message.role || '').toLowerCase()
    const direction = String(message.direction || '').toUpperCase()
    const sender = String(message.sender || '').toUpperCase()
    const text = String(message.text || message.content || '')
    return (role === 'assistant' || direction === 'OUTBOUND' || sender === 'BOT') && normalizeReadyReplyText(text) === target
  })) return true
  const from = String(context.from || '').trim()
  if (!from) return false
  const conversation = await db.whatsAppConversation.findUnique({
    where: { waIdHash: hashWhatsAppId(from) },
    select: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { direction: true, sender: true, text: true },
      },
    },
  }).catch(() => null)
  return Boolean((conversation?.messages || []).some((message) => message.direction === 'OUTBOUND' && message.sender === 'BOT' && normalizeReadyReplyText(message.text) === target))
}

async function suppressRepeatedDirectReply(reply: string, context?: WhatsAppDirectReplyContext) {
  if (await directReplyWasRecentlySent(reply, context)) return null
  return reply
}

function settingValue(values: Record<string, string>, key: string) {
  return String(values[key] ?? DEFAULT_SETTING_VALUES[key] ?? '').trim()
}

function usd(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? `${n}$` : 'غير مضبوط حالياً'
}

async function listPublicProgramsForWhatsApp() {
  return db.program.findMany({
    where: { active: true },
    orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
    take: 8,
    select: { titleAr: true, titleEn: true, category: true, price: true, hours: true },
  })
}

    */
  }

  if (intent === 'CERTIFICATE') {
    const days = settingValue(values, 'CERTIFICATE_ISSUE_DAYS') || '30'
    return suppressRepeatedDirectReply(`تصدر الشهادة عادة خلال ${days} يوماً بعد استكمال متطلبات البرنامج والرسوم ومراجعة كشوف الدرجات.`, context)
  }

  if (intent === 'ACCREDITATION') {
    let accreditation: any = {}
    try { accreditation = JSON.parse(settingValue(values, 'ACCREDITATION_PAGE') || '{}') } catch { accreditation = {} }
    const trust = settingValue(values, 'TRUST_BANNER_TEXT')
    const license = accreditation?.licenseNumber ? `رقم الترخيص/الاعتماد: ${accreditation.licenseNumber}.` : ''
    const verify = accreditation?.licenseVerifyUrl ? `رابط التحقق: ${accreditation.licenseVerifyUrl}` : ''
    return suppressRepeatedDirectReply([trust || 'برامج الأكاديمية تدريب مهني، وقبول الشهادة يعود للجهة المستقبلة أو جهة العمل.', license, verify].filter(Boolean).join('\n'), context)
  }

  return null
}

async function assertWhatsAppFreeformWindowOpen(to: string) {
  const waIdHash = hashWhatsAppId(to)
  const conversation = await db.whatsAppConversation.findUnique({
    where: { waIdHash },
    select: { lastInboundAt: true },
  })
  const lastInboundAt = conversation?.lastInboundAt?.getTime() || 0
  if (!lastInboundAt || Date.now() - lastInboundAt > WHATSAPP_CUSTOMER_CARE_WINDOW_MS) {
    throw new Error('WHATSAPP_24H_WINDOW_CLOSED: free-form messages require a customer message within the last 24 hours; use an approved template message instead.')
  }
}

export function officialWhatsAppConfigured() {
  return Boolean(
    process.env.WHATSAPP_ACCESS_TOKEN?.trim() &&
    process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() &&
    process.env.WHATSAPP_VERIFY_TOKEN?.trim()
  )
}

export function getWhatsAppCloudConfig(fallbackPhoneNumberId?: string): WhatsAppConfig | null {
  const accessToken = trim(process.env.WHATSAPP_ACCESS_TOKEN)
  const inboundPhoneNumberId = trim(fallbackPhoneNumberId)
  const phoneNumberId = inboundPhoneNumberId || trim(process.env.WHATSAPP_PHONE_NUMBER_ID)
  if (!accessToken || !phoneNumberId) return null
  return {
    accessToken,
    phoneNumberId,
    graphVersion: trim(process.env.WHATSAPP_GRAPH_VERSION) || 'v22.0',
  }
}

export function verifyWhatsAppSignature(rawBody: string, signatureHeader: string | null, appSecret = process.env.WHATSAPP_APP_SECRET) {
  const secret = trim(appSecret)
  if (!secret) return unsignedWebhookTestsAllowed()
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false
  try {
    const provided = Buffer.from(signatureHeader.replace(/^sha256=/, ''), 'hex')
    const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex')
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
  } catch {
    return false
  }
}

function textFromWhatsAppMessage(message: any) {
  if (message?.type === 'text') return compactText(message?.text?.body)
  if (message?.type === 'button') return compactText(message?.button?.text || message?.button?.payload)
  if (message?.type === 'interactive') {
    return compactText(
      message?.interactive?.button_reply?.title ||
      message?.interactive?.button_reply?.id ||
      message?.interactive?.list_reply?.title ||
      message?.interactive?.list_reply?.id
    )
  }
  return ''
}

function mediaFromWhatsAppMessage(message: any) {
  if (message?.type !== 'audio') return {}
  const audio = message?.audio || {}
  return {
    mediaId: trim(audio?.id),
    mediaMimeType: trim(audio?.mime_type),
    mediaSha256: trim(audio?.sha256),
    isVoice: Boolean(audio?.voice),
  }
}

export function extractWhatsAppInboundMessages(payload: any): WhatsAppInboundMessage[] {
  const inbound: WhatsAppInboundMessage[] = []
  for (const entry of Array.isArray(payload?.entry) ? payload.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {}
      const contacts = Array.isArray(value?.contacts) ? value.contacts : []
      const phoneNumberId = trim(value?.metadata?.phone_number_id)
      for (const message of Array.isArray(value?.messages) ? value.messages : []) {
        const from = trim(message?.from)
        const id = trim(message?.id)
        if (!from || !id) continue
        const contact = contacts.find((c: any) => trim(c?.wa_id) === from) || contacts[0]
        const text = textFromWhatsAppMessage(message)
        const media = mediaFromWhatsAppMessage(message)
        inbound.push({
          id,
          from,
          text,
          name: compactText(contact?.profile?.name, 120),
          phoneNumberId,
          rawType: trim(message?.type) || 'unknown',
          originKind: message?.type === 'audio' ? 'VOICE' : 'TEXT',
          ...media,
        })
      }
    }
  }
  return inbound
}

async function recentWhatsAppAgentMessages(message: WhatsAppInboundMessage) {
  const waIdHash = hashWhatsAppId(message.from)
  const conversation = await db.whatsAppConversation.findUnique({
    where: { waIdHash },
    select: {
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { direction: true, sender: true, text: true, whatsappMessageId: true },
      },
    },
  }).catch(() => null)
  const history = (conversation?.messages || [])
    .reverse()
    .filter((m) => String(m.text || '').trim())
    .map((m) => ({
      role: m.direction === 'INBOUND' ? 'user' : 'assistant',
      content: String(m.text || '').slice(0, 1200),
    }))
  const currentText = message.text.slice(0, 1200)
  const hasCurrent = history.some((m) => m.role === 'user' && m.content === currentText)
  if (!hasCurrent) history.push({ role: 'user', content: currentText })
  return history.slice(-12)
}

export async function createOfficialWhatsAppAgentReply(message: WhatsAppInboundMessage, deadlineMs?: number) {
  if (!message.text) {
    return 'أهلاً بك في الأكاديمية الأمريكية للاستشارات والتدريب. حالياً أستطيع قراءة الرسائل النصية فقط. اكتب سؤالك نصاً عن البرامج، الرسوم، التسجيل، الشهادات، أو الاعتماد وسأجيبك فوراً.'
  }

  const directReply = await resolveWhatsAppDirectSettingsReply(message.text, undefined, { from: message.from }).catch(() => null)
  if (directReply) return directReply

  const messages = await recentWhatsAppAgentMessages(message)
  const contact = await getOfficialContact().catch(() => ({} as any))
  const officialNumbers = Array.from(new Set([contact.whatsapp, ...(contact.whatsapps || []), contact.phone, ...(contact.phones || [])].map((v: unknown) => String(v || '').trim()).filter(Boolean))).join(' / ') || 'غير مضبوط في الإعدادات'
  const result = await platformPublicAgentComplete({
    messages,
    channel: 'WHATSAPP',
    deadlineMs,
    uiContext: wrapUntrustedUiContext([
      'المستخدم يتواصل عبر واتساب الرسمي للأكاديمية، وليس عبر نافذة الموقع.',
      `اسم جهة الاتصال إن وجد: ${message.name || 'غير متاح'}.`,
      `رقم واتساب الرسمي للإدارة من الإعدادات: ${officialNumbers}.`,
      'لا تكرر الترحيب بالاسم في كل رد؛ يكفي في بداية المحادثة أو بعد انقطاع واضح. إذا كانت الرسالة مجاملة قصيرة فأجب باختصار. إذا كان السؤال عن الأكاديمية أو البرامج أو الرسوم أو التسجيل فأعطِ تفصيلاً مفيداً حسب السؤال.',
      'إذا كانت الرسالة عن شركة تدريب أو تعاون أو شراكة أو وكالة أو اعتماد، عالجها كطلب تعاون مؤسسي واجمع معلومات الجهة وهدف التعاون؛ لا تعرض تحويل موظف إلا إذا طلب المستخدم ذلك صراحة.',
    ].join(' ')),
  })

  return result.reply || 'أهلاً بك، كيف يمكنني مساعدتك في برامج الأكاديمية؟'
}

export function buildOfficialWhatsAppImmediateGreeting(message: WhatsAppInboundMessage) {
  const name = compactText(message.name, 60)
  const displayName = name || 'ضيفنا الكريم'
  return `أهلاً وسهلاً بك ${displayName} في الأكاديمية الأمريكية للاستشارات والتدريب.\nأنا هنا لمساعدتك في أي شيء يخص المنصة التعليمية AACT، وسأجهز لك الرد المناسب الآن.`
}

async function sendOfficialWhatsAppMessageStatus(message: WhatsAppInboundMessage, includeTyping: boolean) {
  const config = getWhatsAppCloudConfig(message.phoneNumberId)
  if (!config) {
    throw new Error('WhatsApp Cloud API is not configured. Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.')
  }

  const body: any = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: message.id,
  }
  if (includeTyping) body.typing_indicator = { type: 'text' }

  const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const errorMessage = data?.error?.message || data?.error?.code || `WhatsApp message status failed with status ${response.status}`
    throw new Error(String(errorMessage).slice(0, 500))
  }

  return data
}

export async function sendOfficialWhatsAppReadReceipt(message: WhatsAppInboundMessage) {
  return sendOfficialWhatsAppMessageStatus(message, false)
}

export async function sendOfficialWhatsAppTypingIndicator(message: WhatsAppInboundMessage) {
  return sendOfficialWhatsAppMessageStatus(message, true)
}

export function splitOfficialWhatsAppText(text: string, maxLength = 3600): string[] {
  const raw = String(text || '').trim()
  if (!raw) return []
  if (raw.length <= maxLength) return [raw]
  const chunks: string[] = []
  let rest = raw
  while (rest.length > maxLength && chunks.length < 5) {
    const windowText = rest.slice(0, maxLength)
    const splitAt = Math.max(
      windowText.lastIndexOf('\n\n'),
      windowText.lastIndexOf('\n'),
      windowText.lastIndexOf('. '),
      windowText.lastIndexOf('، '),
      windowText.lastIndexOf(' ')
    )
    const cut = splitAt > 1200 ? splitAt : maxLength
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) chunks.push(rest.slice(0, maxLength).trim())
  return chunks.filter(Boolean)
}

export async function sendOfficialWhatsAppText(to: string, text: string, options?: { phoneNumberId?: string; replyToMessageId?: string }) {
  await assertWhatsAppFreeformWindowOpen(to)
  const config = getWhatsAppCloudConfig(options?.phoneNumberId)
  if (!config) {
    throw new Error('WhatsApp Cloud API is not configured. Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.')
  }

  const chunks = splitOfficialWhatsAppText(text)
  if (!chunks.length) throw new Error('WhatsApp text is empty.')
  const sentMessages: any[] = []
  let lastData: any = null

  for (let i = 0; i < chunks.length; i += 1) {
    const body: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: {
        preview_url: false,
        body: chunks[i],
      },
    }

    if (i === 0 && options?.replyToMessageId) {
      body.context = { message_id: options.replyToMessageId }
    }

    const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const message = data?.error?.message || data?.error?.code || `WhatsApp send failed with status ${response.status}`
      throw new Error(String(message).slice(0, 500))
    }
    lastData = data
    if (Array.isArray(data?.messages)) sentMessages.push(...data.messages)
  }

  return { ...(lastData || {}), messages: sentMessages.length ? sentMessages : lastData?.messages }
}

export async function sendOfficialWhatsAppHumanFollowup(
  to: string,
  customerName: string,
  options?: { phoneNumberId?: string; imageUrl?: string },
) {
  const config = getWhatsAppCloudConfig(options?.phoneNumberId)
  if (!config) {
    throw new Error('WhatsApp Cloud API is not configured. Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID.')
  }

  const normalizedName = compactText(customerName, 120) || 'عميلنا الكريم'
  const appUrl = trim(process.env.NEXT_PUBLIC_APP_URL || 'https://aactacademy.com').replace(/\/$/, '')
  const imageUrl = trim(options?.imageUrl) || `${appUrl}/logo.png`
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: 'human_followup_ar',
      language: { code: 'ar' },
      components: [
        {
          type: 'header',
          parameters: [{ type: 'image', image: { link: imageUrl } }],
        },
        {
          type: 'body',
          parameters: [{ type: 'text', parameter_name: 'customer_name', text: normalizedName }],
        },
      ],
    },
  }

  const response = await fetch(`https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = data?.error?.message || data?.error?.code || `WhatsApp template send failed with status ${response.status}`
    throw new Error(String(message).slice(0, 500))
  }
  return data
}
