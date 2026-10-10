import ZAI from 'z-ai-web-dev-sdk'
import { ensureGeminiKey, geminiComplete, isAuthError, isQuotaError, isModelUnavailableError, isInvalidArgumentError } from '@/lib/gemini'
import { textAiComplete, textAiCompleteJson, type TextAiRouterPolicy } from '@/lib/text-ai'
import { db } from '@/lib/db'
import { getSettings } from '@/lib/settings'

let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null

export const OFFICIAL_INFO_UNAVAILABLE_REPLY = 'هاي المعلومة مش متوفرة عندي هلأ، تواصل مع الإدارة'
const SMART_SUPERVISOR_PROFILE = 'مشرف ذكي يعتمد على سياق البرنامج وقواعد القبول والإعدادات الرسمية وملف الطالب عند توفره.'

export type SupervisorPersona = 'CHAT' | 'EXAM' | 'DEFENSE'

interface ChatCompleteOptions {
  skipGemini?: boolean
  timeoutMs?: number
  requireModelResponse?: boolean
  routerPolicy?: TextAiRouterPolicy
}

interface ProgramCatalogItem {
  id: string
  slug: string
  titleAr: string
  titleEn?: string | null
  description?: string | null
  category: string
  hours?: number | null
  price?: number | null
  features: string[]
}

interface SupervisorRuntimeContext {
  programCatalog: ProgramCatalogItem[]
  programCatalogText: string
  applicationFee: number
  doctorateStartsFrom: number
  mastersStartsFrom: number
  diplomaStartsFrom: number
  accreditationApplicationFee: number
  accreditationCompanyFee: number
  accreditationConsultantFee: number
  accreditationTrainerFee: number
  certificateIssueDays: number
  thesisMinMonths: number
  thesisMaxMonths: number
  agentCommissionRate: number
  committeeMemberFee: number
  contactEmail: string
  contactWhatsapp: string
  academyNameAr: string
  academyNameEn: string
  academyFounded: string
  academyTaglineAr: string
  academyTaglineEn: string
  academyProgramsText: string
  admissionConditionsText: string
  admissionDocumentsText: string
  admissionStepsText: string
  admissionGraduationText: string
  admissionNoteText: string
  accreditationBenefitsText: string
}

export function officialValueOrUnavailable(value: unknown): string {
  const text = String(value || '').trim()
  return text ? text : OFFICIAL_INFO_UNAVAILABLE_REPLY
}

function aiTimeoutMs(configured: number | undefined, fallback: number) {
  if (Number.isFinite(configured || NaN) && (configured || 0) >= 3_000) return Math.min(Math.floor(configured || fallback), 45_000)
  const env = Number(process.env.SUPERVISOR_AI_PROVIDER_TIMEOUT_MS || '')
  if (Number.isFinite(env) && env >= 3_000) return Math.min(Math.floor(env), 45_000)
  return fallback
}

function withAiTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

const PERSONA_LABEL_AR: Record<SupervisorPersona, string> = {
  CHAT: 'مدرّس ومرشد أكاديمي',
  EXAM: 'خبير قياس وتقويم جامعي',
  DEFENSE: 'عضو لجنة مناقشة بحث تخرج',
}

export function buildSupervisorPersonaBlock(persona: SupervisorPersona = 'CHAT'): string {
  if (persona === 'EXAM') {
    return `شخصية المشرف الحالية: ${PERSONA_LABEL_AR.EXAM}.
- قيّم الإجابات وفق مخرجات التعلم، المهارة المطلوبة، مستوى الصعوبة، والدليل الأكاديمي.
- لا تعتبر السؤال صحيحاً لمجرد التشابه اللفظي؛ ابحث عن الفهم والتطبيق والتحليل.
- عند التغذية الراجعة اربط الخلل بمفهوم أو فصل أو مهارة، واذكر خطوة مراجعة عملية.`
  }
  if (persona === 'DEFENSE') {
    return `شخصية المشرف الحالية: ${PERSONA_LABEL_AR.DEFENSE}.
- تصرّف كعضو لجنة محترف: اسأل، قاطع بلطف عند التشتت، اطلب توضيحاً، واربط كلام الطالب بالمنهجية والنتائج.
- القرار النهائي للجنة البشرية والإدارة، ودورك استشاري موثق في المحضر.
- لا تكتفِ بالسؤال التالي؛ علّق على إجابة الطالب وانقل النقاش إلى مستوى أكاديمي أعلى.`
  }
  return `شخصية المشرف الحالية: ${PERSONA_LABEL_AR.CHAT}.
- درّس ووجّه الطالب بناءً على ملفه الأكاديمي وكتبه ونتائجه وسياق آخر محادثاته.
- قدّم إجابات قصيرة مفيدة، ثم اقترح خطوة تعلم أو قراءة أو تدريب واحدة.
- إذا ظهر ضعف متكرر، عالجه تربوياً دون لوم الطالب.`
}

function parseFeatures(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((x) => String(x)).filter(Boolean) : []
  } catch {
    return []
  }
}

function parseSettingsJson<T>(raw: string | undefined, fallback: T): T {
  try {
    return raw ? JSON.parse(raw) as T : fallback
  } catch {
    return fallback
  }
}

function settingNum(settings: Record<string, string>, key: string, fallback = 0) {
  const n = Number(settings[key])
  return Number.isFinite(n) ? n : fallback
}

function contactList(primary?: unknown, list?: unknown): string[] {
  const values = [primary, ...(Array.isArray(list) ? list : [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  return Array.from(new Set(values))
}

function money(n: number | null | undefined): string {
  const value = Number(n || 0)
  return Number.isFinite(value) && value > 0 ? `${value} دولار` : OFFICIAL_INFO_UNAVAILABLE_REPLY
}

function isInternalQaProgram(p: { slug?: string | null; titleAr?: string | null; titleEn?: string | null }) {
  const slug = String(p.slug || '')
  const titleAr = String(p.titleAr || '')
  const titleEn = String(p.titleEn || '')
  return slug.startsWith('qa-full-journey-')
    || slug === 'launch-quality-diagnostic-program'
    || titleAr.startsWith('برنامج جودة رحلة كاملة QA')
    || titleEn.startsWith('QA Full Journey Program')
}

function minCatalogPrice(programs: ProgramCatalogItem[], categories: string[], fallback: number) {
  const prices = programs
    .filter((p) => categories.includes(p.category))
    .map((p) => Number(p.price || 0))
    .filter((price) => Number.isFinite(price) && price > 0)
  return prices.length ? Math.min(...prices) : fallback
}

function programDigestLine(p: ProgramCatalogItem, i: number): string {
  const features = (p.features || []).slice(0, 3).join('، ')
  const price = p.price ? ` — رسومه ${money(p.price)}` : ''
  const hours = p.hours ? ` — ${p.hours} ساعة` : ''
  return `${i + 1}. ${p.titleAr}${p.titleEn ? ` (${p.titleEn})` : ''} — التصنيف: ${p.category}${hours}${price}${features ? ` — محاوره: ${features}` : ''}`
}

async function loadPublicProgramCatalog(max = 90): Promise<ProgramCatalogItem[]> {
  const rows = await db.program.findMany({
    where: { active: true },
    orderBy: [{ category: 'asc' }, { order: 'asc' }, { titleAr: 'asc' }],
    select: {
      id: true,
      slug: true,
      titleAr: true,
      titleEn: true,
      description: true,
      category: true,
      hours: true,
      price: true,
      features: true,
    },
    take: max,
  })
  return rows
    .filter((p) => !isInternalQaProgram(p))
    .map((p) => ({ ...p, features: parseFeatures(p.features) }))
}

async function buildSupervisorRuntimeContext(): Promise<SupervisorRuntimeContext> {
  const [settings, programCatalog] = await Promise.all([
    getSettings(),
    loadPublicProgramCatalog(),
  ])
  const officialContact = parseSettingsJson<Record<string, unknown>>(settings.OFFICIAL_CONTACT, {})
  const officialNumbers = Array.from(new Set([
    ...contactList(officialContact.whatsapp, officialContact.whatsapps),
    ...contactList(officialContact.phone, officialContact.phones),
  ]))
  const officialText = (key: string) => officialValueOrUnavailable(settings[key])
  const doctorateDefault = settingNum(settings, 'FEE_DOCTORATE', 0)
  const mastersDefault = settingNum(settings, 'FEE_MASTERS', 0)
  const diplomaDefault = settingNum(settings, 'FEE_DIPLOMAS_MIN', 0)

  return {
    programCatalog,
    programCatalogText: programCatalog.map(programDigestLine).join('\n'),
    applicationFee: settingNum(settings, 'FEE_APPLICATION', 0),
    doctorateStartsFrom: minCatalogPrice(programCatalog, ['DOCTORATE'], doctorateDefault),
    mastersStartsFrom: minCatalogPrice(programCatalog, ['MASTERS'], mastersDefault),
    diplomaStartsFrom: minCatalogPrice(programCatalog, ['DIPLOMA', 'INTL_CERT'], diplomaDefault),
    accreditationApplicationFee: settingNum(settings, 'FEE_ACC_APPLICATION', 0),
    accreditationCompanyFee: settingNum(settings, 'FEE_ACC_COMPANY', 0),
    accreditationConsultantFee: settingNum(settings, 'FEE_ACC_CONSULTANT', 0),
    accreditationTrainerFee: settingNum(settings, 'FEE_ACC_TRAINER', 0),
    certificateIssueDays: settingNum(settings, 'CERTIFICATE_ISSUE_DAYS', 0),
    thesisMinMonths: settingNum(settings, 'THESIS_MIN_MONTHS', 0),
    thesisMaxMonths: settingNum(settings, 'THESIS_MAX_MONTHS', 0),
    agentCommissionRate: settingNum(settings, 'AGENT_COMMISSION_RATE', 0),
    committeeMemberFee: settingNum(settings, 'COMMITTEE_MEMBER_FEE', 0),
    contactEmail: String(officialContact.email || OFFICIAL_INFO_UNAVAILABLE_REPLY),
    contactWhatsapp: officialNumbers.length ? officialNumbers.join(' / ') : OFFICIAL_INFO_UNAVAILABLE_REPLY,
    academyNameAr: officialText('ACADEMY_NAME_AR'),
    academyNameEn: officialText('ACADEMY_NAME_EN'),
    academyFounded: officialText('ACADEMY_FOUNDED'),
    academyTaglineAr: officialText('ACADEMY_TAGLINE_AR'),
    academyTaglineEn: officialText('ACADEMY_TAGLINE_EN'),
    academyProgramsText: officialText('ACADEMY_PROGRAMS_TEXT'),
    admissionConditionsText: officialText('ADMISSION_CONDITIONS_TEXT'),
    admissionDocumentsText: officialText('ADMISSION_DOCUMENTS_TEXT'),
    admissionStepsText: officialText('ADMISSION_STEPS_TEXT'),
    admissionGraduationText: officialText('ADMISSION_GRADUATION_TEXT'),
    admissionNoteText: officialText('ADMISSION_NOTE_TEXT'),
    accreditationBenefitsText: officialText('ACCREDITATION_BENEFITS_TEXT'),
  }
}

export async function getZAI() {
  if (!zaiInstance) zaiInstance = await ZAI.create()
  return zaiInstance
}

export async function chatWithRetry(
  zai: Awaited<ReturnType<typeof ZAI.create>>,
  messages: { role: string; content: string }[],
  retries = 4
): Promise<string> {
  let lastErr: any
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const completion = await zai.chat.completions.create({
        messages: messages as any,
        thinking: { type: 'disabled' },
      })
      const content = completion.choices[0]?.message?.content
      if (!content || !content.trim()) throw new Error('EMPTY_AI_RESPONSE')
      return content.trim()
    } catch (e: any) {
      lastErr = e
      const msg = String(e?.message || '')
      const rateLimited = msg.includes('429') || msg.toLowerCase().includes('too many')
      console.error(`AI attempt ${attempt}/${retries} failed:`, msg.slice(0, 120))
      if (attempt < retries) await new Promise((r) => setTimeout(r, rateLimited ? 5000 * attempt : 2000 * attempt))
    }
  }
  throw lastErr
}

export function buildSupervisorSystemPrompt(
  context?: string,
  persona: SupervisorPersona = 'CHAT',
  runtime?: SupervisorRuntimeContext
): string {
  const contactEmail = runtime?.contactEmail || OFFICIAL_INFO_UNAVAILABLE_REPLY
  const contactWhatsapp = runtime?.contactWhatsapp || OFFICIAL_INFO_UNAVAILABLE_REPLY
  const programCatalogText = runtime?.programCatalogText || OFFICIAL_INFO_UNAVAILABLE_REPLY
  const academyNameAr = runtime?.academyNameAr || OFFICIAL_INFO_UNAVAILABLE_REPLY
  const academyNameEn = runtime?.academyNameEn || OFFICIAL_INFO_UNAVAILABLE_REPLY

  return `أنت "المشرف الذكي" — المرشد الأكاديمي المعتمد لطلاب ${academyNameAr} (${academyNameEn})، تأسست ${runtime?.academyFounded || OFFICIAL_INFO_UNAVAILABLE_REPLY}.

${buildSupervisorPersonaBlock(persona)}

ملف الذكاء والذاكرة التشغيلية:
- ${SMART_SUPERVISOR_PROFILE}
- لا تذكر أي نسب أو أرقام تقييم للذكاء أو الذاكرة، لأنها مؤشرات داخلية غير موثقة للطالب.
- ذاكرتك تشمل كتالوج البرامج، شروط القبول، الرسوم، الشهادات، الاعتمادات، ملف الطالب، وحداته، كتبه، تقدمه، محاولات الاختبار، وبحث التخرج عند توفرها في السياق.

معلومات الأكاديمية من الإعدادات:
- الشعار: "${runtime?.academyTaglineAr || OFFICIAL_INFO_UNAVAILABLE_REPLY}" (${runtime?.academyTaglineEn || OFFICIAL_INFO_UNAVAILABLE_REPLY})
- البريد: ${contactEmail} | أرقام التواصل الرسمية: ${contactWhatsapp}
- البرامج: ${runtime?.academyProgramsText || OFFICIAL_INFO_UNAVAILABLE_REPLY}
- الشهادات تُصدر خلال ${runtime?.certificateIssueDays ? `${runtime.certificateIssueDays} يوماً` : OFFICIAL_INFO_UNAVAILABLE_REPLY}.
- الوكلاء الدوليون: نسبة ${runtime?.agentCommissionRate || OFFICIAL_INFO_UNAVAILABLE_REPLY} من إيرادات منطقة التمثيل + ${money(runtime?.committeeMemberFee)} عن كل بحث تخرج يشارك الوكيل في لجنة مناقشته.

دليل إجراءات وشروط الالتحاق من الإعدادات:
- شروط القبول: ${runtime?.admissionConditionsText || OFFICIAL_INFO_UNAVAILABLE_REPLY}
- الوثائق المطلوبة: ${runtime?.admissionDocumentsText || OFFICIAL_INFO_UNAVAILABLE_REPLY}
- خطوات التسجيل: ${runtime?.admissionStepsText || OFFICIAL_INFO_UNAVAILABLE_REPLY}
- رسوم تقديم الطلب وحجز المقعد: ${money(runtime?.applicationFee)} غير مستردة.
- التكلفة المالية الافتراضية عند عدم وجود سعر خاص للبرنامج: الدكتوراه المهنية تبدأ من ${money(runtime?.doctorateStartsFrom)} — الماجستير المهني يبدأ من ${money(runtime?.mastersStartsFrom)} — الدبلومات والبرامج الدولية تبدأ من ${money(runtime?.diplomaStartsFrom)} حسب البرنامج.
- متطلبات التخرج: ${runtime?.admissionGraduationText || OFFICIAL_INFO_UNAVAILABLE_REPLY}
- مدة بحث التخرج: ${runtime?.thesisMinMonths && runtime?.thesisMaxMonths ? `من ${runtime.thesisMinMonths} إلى ${runtime.thesisMaxMonths} شهور كحد أقصى` : OFFICIAL_INFO_UNAVAILABLE_REPLY}.
- ملاحظة رسمية: ${runtime?.admissionNoteText || OFFICIAL_INFO_UNAVAILABLE_REPLY}

دليل الاعتمادات الدولية من الإعدادات:
- رسوم تقديم طلب الاعتماد: ${money(runtime?.accreditationApplicationFee)} غير مستردة.
- أنواع الاعتماد ورسومها: الهيئات التدريبية ${money(runtime?.accreditationCompanyFee)} — المستشارون ${money(runtime?.accreditationConsultantFee)} — المدرب الدولي المعتمد ${money(runtime?.accreditationTrainerFee)} — اعتماد الجودة حسب طبيعة الاعتماد.
- مميزات الاعتماد: ${runtime?.accreditationBenefitsText || OFFICIAL_INFO_UNAVAILABLE_REPLY}

كتالوج البرامج الرسمي المتاح في ذاكرة المشرف من قاعدة البيانات:
${programCatalogText}

تعليمات مهمة:
- إذا سأل الطالب عن معلومة غير موجودة في الإعدادات أو سجل البرنامج، قل حرفياً: ${OFFICIAL_INFO_UNAVAILABLE_REPLY}.
- إذا سأل الطالب عن البرامج، اعرض البرامج أو المجالات أولاً، ثم اسأله عن المجال الذي يريده. لا تبدأ بالرسوم.
- إذا سأل عن الرسوم أو السعر أو التكلفة، اذكر الرسوم باختصار ثم اسأله عن اسم البرنامج.
- أبقِ إجاباتك موجزة ومركزة لأنها قد تُقرأ صوتياً: 2-5 جمل غالباً.
- لا تستخدم جداول Markdown أو عناوين معقدة.

${context ? `سياق إضافي من قاعدة معرفة الطالب والمنصة:\n${context}` : ''}`
}

function normalizeArabicQuestion(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[ـًٌٍَُِّْ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function wordsOf(q: string): string[] {
  return q.split(/\s+/).filter(Boolean)
}

function hasAnyWord(q: string, words: string[]): boolean {
  const set = new Set(wordsOf(q))
  return words.some((w) => set.has(w))
}

function hasAnyPhrase(q: string, phrases: string[]): boolean {
  return phrases.some((p) => q.includes(p))
}

function isProgramIntent(q: string): boolean {
  return hasAnyWord(q, ['برنامج', 'برامج', 'دبلوم', 'دبلومات', 'ماجستير', 'دكتوراه', 'دكتوراة', 'تدريب', 'تدريبيه', 'تدريبي', 'تخصص', 'تخصصات', 'كورس', 'كورسات', 'دوره', 'دورات'])
    || hasAnyPhrase(q, ['شو في', 'ايش في', 'اي برامج', 'في برامج', 'عندكم برامج', 'بدي اعرف البرامج', 'بدي اسال شو في', 'تحكي لي شو في'])
}

function isFeesIntent(q: string): boolean {
  return hasAnyWord(q, ['رسوم', 'الرسم', 'السعر', 'سعر', 'تكلفه', 'التكلفه', 'دفع', 'قسط', 'اقساط', 'دولار', 'فلوس', 'مصاري'])
    || hasAnyPhrase(q, ['كم سعر', 'كم رسوم', 'كم التكلفه', 'كم تكلف', 'شو السعر', 'ايش السعر', 'كم بدفع'])
}

function isCertificateIntent(q: string): boolean {
  return hasAnyWord(q, ['شهاده', 'شهادات', 'تصدر', 'تخرج', 'موثقه', 'اعتماد', 'اعتمادات'])
}

function isAdmissionIntent(q: string): boolean {
  return hasAnyWord(q, ['تسجيل', 'التحاق', 'قبول', 'وثائق', 'مستندات', 'اوراق', 'ابدا', 'ابدأ', 'اسجل'])
}

function isCapabilityIntent(q: string): boolean {
  return hasAnyPhrase(q, ['نسبة ذكاء', 'نسبه ذكاء', 'قدراتك', 'ذاكرتك', 'ذاكره معرفيه', 'شو بتعرف', 'ماذا تعرف'])
}

function isGreeting(q: string): boolean {
  return hasAnyPhrase(q, ['السلام عليكم', 'سلام عليكم', 'مرحبا', 'اهلا', 'اهلين', 'هلا']) && q.length < 60
}

function pickRelevantPrograms(q: string, catalog: ProgramCatalogItem[], limit = 7): ProgramCatalogItem[] {
  const keywordGroups: string[][] = [
    ['اداره', 'قياده', 'اعمال', 'اداري', 'اداريه'],
    ['موارد', 'بشريه', 'hr'],
    ['جوده', 'iso', 'ايزو'],
    ['مشاريع', 'pmp', 'project'],
    ['تسويق', 'مبيعات', 'سوشيال'],
    ['ذكاء', 'اصطناعي', 'ai'],
    ['تدريب', 'مدربين', 'tot'],
    ['استشاري', 'استشارات', 'استشارة', 'استشاره'],
  ]
  const wanted = keywordGroups.flat().filter((k) => q.includes(k))
  if (wanted.length === 0) return catalog.slice(0, limit)
  const scored = catalog
    .map((p) => {
      const blob = normalizeArabicQuestion([p.titleAr, p.titleEn, p.category, p.description, ...(p.features || [])].join(' '))
      const score = wanted.reduce((s, k) => s + (blob.includes(k) ? 1 : 0), 0)
      return { p, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return scored.length ? scored.map((x) => x.p) : catalog.slice(0, limit)
}

function formatProgramList(programs: ProgramCatalogItem[]): string {
  return programs
    .map((p, i) => {
      const hours = p.hours ? `، ${p.hours} ساعة` : ''
      const price = p.price ? `، ${money(p.price)}` : ''
      return `${i + 1}. ${p.titleAr}${hours}${price}`
    })
    .join('\n')
}

function programCategoriesSummary(): string {
  return 'المجالات الرئيسية عندنا: الدبلومات المهنية، الماجستير المهني، الدكتوراه المهنية، الاعتمادات الدولية، الموارد البشرية، الجودة، إدارة المشاريع، التسويق، الذكاء الاصطناعي، وإعداد المدربين TOT.'
}

function localSupervisorFallback(messages: { role: string; content: string }[], runtime?: SupervisorRuntimeContext): string {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
  const q = normalizeArabicQuestion(last)
  const programIntent = isProgramIntent(q)
  const feesIntent = isFeesIntent(q)
  const catalog = runtime?.programCatalog || []

  if (isCapabilityIntent(q)) return `أنا مشرفك الذكي. ${SMART_SUPERVISOR_PROFILE} أستطيع مساعدتك في البرامج، الرسوم، التسجيل، الشهادات، الاعتمادات، تقدمك الدراسي، الكتب، الاختبارات، وبحث التخرج عند توفر بياناتها في السياق.`
  if (isGreeting(q)) return 'وعليكم السلام ورحمة الله، أهلاً بك. اسألني عن البرامج، الرسوم، التسجيل، الشهادات، أو أي موضوع أكاديمي تحتاجه.'
  if (programIntent && !feesIntent) {
    if (!catalog.length) return OFFICIAL_INFO_UNAVAILABLE_REPLY
    const programs = pickRelevantPrograms(q, catalog)
    return `أكيد. ${programCategoriesSummary()}\n\nأمثلة من البرامج المتاحة:\n${formatProgramList(programs)}\n\nقل لي المجال الذي يهمك أو اسم البرنامج، وأنا أعطيك تفاصيله وشروطه وخطة البدء.`
  }
  if (feesIntent) return `أكيد. الرسوم تعتمد على سعر البرنامج الحالي في قاعدة البيانات: الدبلومات والبرامج الدولية تبدأ من ${money(runtime?.diplomaStartsFrom)}، والماجستير المهني يبدأ من ${money(runtime?.mastersStartsFrom)}، والدكتوراه المهنية تبدأ من ${money(runtime?.doctorateStartsFrom)}. رسوم التقديم الحالية ${money(runtime?.applicationFee)}. إذا ذكرت اسم البرنامج أعطيك تفاصيله بدقة.`
  if (isCertificateIntent(q)) return `الشهادة تُصدر عادة خلال ${runtime?.certificateIssueDays ? `${runtime.certificateIssueDays} يوماً` : OFFICIAL_INFO_UNAVAILABLE_REPLY} بعد استكمال المتطلبات والرسوم. إن كنت تسأل عن شهادة برنامج محدد، اكتب اسم البرنامج وسأوضح لك آلية الإصدار والاعتماد.`
  if (isAdmissionIntent(q)) return `خطوات التسجيل: ${runtime?.admissionStepsText || OFFICIAL_INFO_UNAVAILABLE_REPLY}. رسوم حجز المقعد ${money(runtime?.applicationFee)}.`
  if (programIntent) {
    if (!catalog.length) return OFFICIAL_INFO_UNAVAILABLE_REPLY
    const programs = pickRelevantPrograms(q, catalog)
    return `تمام، هذه بعض البرامج المناسبة:\n${formatProgramList(programs)}\n\nاختر واحداً منها لأشرح لك المحتوى والرسوم وشروط الالتحاق.`
  }
  return `تمام، فهمت عليك. وضّح لي هل سؤالك عن برنامج معيّن، الرسوم، الشهادة، الاعتماد، أو خطوات التسجيل؟ سأعطيك جواباً مباشراً.`
}

function shouldAnswerLocally(last: string): boolean {
  const q = normalizeArabicQuestion(last)
  return isGreeting(q) || isCapabilityIntent(q) || isProgramIntent(q) || isFeesIntent(q) || isCertificateIntent(q) || isAdmissionIntent(q)
}

export async function chatComplete(
  messages: { role: string; content: string }[],
  context?: string,
  persona: SupervisorPersona = 'CHAT',
  options: ChatCompleteOptions = {}
): Promise<string> {
  let runtime: SupervisorRuntimeContext | undefined
  try {
    runtime = await buildSupervisorRuntimeContext()
  } catch (e: any) {
    console.error('Supervisor runtime context failed:', String(e?.message || e).slice(0, 300))
  }

  const systemPrompt = buildSupervisorSystemPrompt(context, persona, runtime)
  const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
  const timeoutMs = aiTimeoutMs(options.timeoutMs, 22_000)

  if (!options.requireModelResponse && shouldAnswerLocally(lastUserText)) return localSupervisorFallback(messages, runtime)

  const geminiReady = !options.skipGemini && await ensureGeminiKey().catch(() => false)
  if (geminiReady) {
    try {
      const history = messages.map((m) => ({ role: m.role === 'user' ? 'user' as const : 'model' as const, text: m.content }))
      return await withAiTimeout(geminiComplete({ system: systemPrompt, history, temperature: 0.45, maxOutputTokens: 900 }), timeoutMs, 'Gemini chatComplete timed out')
    } catch (e: any) {
      const msg = String(e?.message || e || '')
      console.error('Gemini chatComplete failed:', msg.slice(0, 300))
      if (isAuthError(e) || isQuotaError(e) || isModelUnavailableError(e) || isInvalidArgumentError(e)) {
        // Continue to router.
      }
    }
  }

  try {
    return await withAiTimeout(textAiComplete({
      system: systemPrompt,
      history: messages.map((m) => ({ role: m.role === 'user' ? 'user' as const : 'model' as const, text: m.content })),
      temperature: 0.45,
      maxOutputTokens: 900,
      routerPolicy: options.routerPolicy,
    }), timeoutMs, 'Text AI router chatComplete timed out')
  } catch (e: any) {
    console.error('Text AI router chatComplete failed:', String(e?.message || e).slice(0, 500))
  }

  try {
    const zai = await getZAI()
    const completion = await withAiTimeout(zai.chat.completions.create({
      messages: ([{ role: 'assistant', content: systemPrompt }, ...messages.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))] as any),
      thinking: { type: 'disabled' },
    }), timeoutMs, 'ZAI chatComplete timed out')
    const content = completion.choices[0]?.message?.content
    if (!content || !content.trim()) throw new Error('EMPTY_AI_RESPONSE')
    return content.trim()
  } catch (e: any) {
    console.error('ZAI chatComplete failed:', String(e?.message || e).slice(0, 300))
    if (options.requireModelResponse) throw new Error('AI_PROVIDER_UNAVAILABLE: all configured model providers failed before local fallback')
    return localSupervisorFallback(messages, runtime)
  }
}

export interface GradedAnswer {
  index: number
  points: number
  maxPoints: number
  feedback: string
}

export interface GradeResult {
  totalScore: number
  maxTotal: number
  percentage: number
  passed: boolean
  answers: GradedAnswer[]
  summary: string
  strengths: string[]
  improvements: string[]
}

export async function gradeEssayAnswer(questionText: string, modelAnswer: string, studentAnswer: string, maxPoints: number, studentAcademicContext?: string): Promise<GradedAnswer> {
  const prompt = `${buildSupervisorPersonaBlock('EXAM')}

${studentAcademicContext ? `سياق ملف الطالب للقياس العادل لا للمجاملة:\n${studentAcademicContext.slice(0, 6000)}\n` : ''}
صحح إجابة مقالية لطالب وفق السؤال والإجابة النموذجية.
السؤال: ${questionText}
الإجابة النموذجية: ${modelAnswer}
إجابة الطالب: ${studentAnswer || '(لم يجب)'}
أجب JSON فقط: {"points": <0-${maxPoints}>, "feedback": "..."}`
  const raw = await textAiCompleteJson({
    system: 'أنت مصحح أكاديمي دقيق يرجع بـ JSON فقط.',
    history: [{ role: 'user', text: prompt }],
    temperature: 0.1,
    maxOutputTokens: 1200,
    taskLevel: 'ACADEMIC_CRITICAL',
  })
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('NO_JSON')
    const parsed = JSON.parse(jsonMatch[0])
    const points = Math.max(0, Math.min(maxPoints, Number(parsed.points) || 0))
    return { index: -1, points, maxPoints, feedback: String(parsed.feedback || '').slice(0, 1500) }
  } catch (e: any) {
    const err: any = new Error('ESSAY_GRADING_NEEDS_REVIEW')
    err.code = e?.code || 'ESSAY_GRADING_NEEDS_REVIEW'
    err.retryAt = e?.retryAt || null
    err.cause = e
    throw err
  }
}

export async function generateOverallFeedback(programTitle: string, percentage: number, passed: boolean, weakPoints: string[], studentAcademicContext?: string): Promise<{ summary: string; strengths: string[]; improvements: string[] }> {
  const zai = await getZAI()
  const prompt = `${buildSupervisorPersonaBlock('EXAM')}
${studentAcademicContext ? `سياق ملف الطالب لتخصيص التغذية الراجعة:\n${studentAcademicContext.slice(0, 6000)}\n` : ''}
طالب أنهى اختبار دورة "${programTitle}" بنتيجة ${percentage.toFixed(0)}% (${passed ? 'ناجح' : 'لم يجتز'}).
نقاط الضعف: ${weakPoints.map((w) => `- ${w}`).join('\n') || 'لا توجد نقاط ضعف كبيرة'}
أجب JSON فقط: {"summary":"...","strengths":["..."],"improvements":["..."]}`
  try {
    const completion = await zai.chat.completions.create({
      messages: [{ role: 'assistant', content: 'أنت مشرف أكاديمي يرجع بـ JSON فقط.' }, { role: 'user', content: prompt }],
      thinking: { type: 'disabled' },
    })
    const raw = completion.choices[0]?.message?.content || ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('NO_JSON')
    const parsed = JSON.parse(jsonMatch[0])
    return { summary: String(parsed.summary || '').slice(0, 800), strengths: (parsed.strengths || []).slice(0, 4).map(String), improvements: (parsed.improvements || []).slice(0, 4).map(String) }
  } catch {
    return { summary: passed ? 'مبروك! لقد اجتزت الاختبار بنجاح. استمر في التميز.' : 'لم تجتز الاختبار هذه المرة، لكن كل محاولة خطوة نحو الاحتراف. راجع الملاحظات وأعد المحاولة.', strengths: ['الالتزام بإكمال الاختبار'], improvements: ['مراجعة محتوى الوحدة التدريبية', 'التواصل مع المشرف الذكي لأي استفسار'] }
  }
}
