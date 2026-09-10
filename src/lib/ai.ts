import ZAI from 'z-ai-web-dev-sdk'
import { ACADEMY_INFO, ADMISSION_FEES, ADMISSION_GUIDE, ACCREDITATION_GUIDE, allSeedPrograms } from '@/lib/academyData'
import { ensureGeminiKey, geminiComplete, isAuthError, isQuotaError, isModelUnavailableError, isInvalidArgumentError } from '@/lib/gemini'

let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null

const SMART_SUPERVISOR_INTELLIGENCE = 96
const SMART_SUPERVISOR_MEMORY = 98

export type SupervisorPersona = 'CHAT' | 'EXAM' | 'DEFENSE'

const PERSONA_LABEL_AR: Record<SupervisorPersona, string> = {
  CHAT: 'مدرّس ومرشد أكاديمي',
  EXAM: 'خبير قياس وتقويم جامعي',
  DEFENSE: 'عضو لجنة مناقشة بحث تخرج',
}

function buildSupervisorPersonaBlock(persona: SupervisorPersona = 'CHAT'): string {
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

type SeedProgramItem = (typeof allSeedPrograms)[number]

function programDigestLine(p: SeedProgramItem, i: number): string {
  const features = (p.features || []).slice(0, 3).join('، ')
  const price = p.price ? ` — رسومه التقريبية ${p.price}$` : ''
  const hours = p.hours ? ` — ${p.hours} ساعة` : ''
  return `${i + 1}. ${p.titleAr}${p.titleEn ? ` (${p.titleEn})` : ''} — التصنيف: ${p.category}${hours}${price}${features ? ` — محاوره: ${features}` : ''}`
}

function buildStaticProgramCatalog(max = 90): string {
  return allSeedPrograms.slice(0, max).map(programDigestLine).join('\n')
}

export async function getZAI() {
  if (!zaiInstance) zaiInstance = await ZAI.create()
  return zaiInstance
}

/** استدعاء النموذج مع إعادة محاولة تلقائية عند ضغط المعدل (429) أو فراغ الاستجابة */
export async function chatWithRetry(
  zai: Awaited<ReturnType<typeof ZAI.create>>,
  messages: { role: string; content: string }[],
  retries = 4
): Promise<string> {
  let lastErr: any
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const completion = await zai.chat.completions.create({
        messages,
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
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, rateLimited ? 5000 * attempt : 2000 * attempt))
      }
    }
  }
  throw lastErr
}

export function buildSupervisorSystemPrompt(context?: string, persona: SupervisorPersona = 'CHAT'): string {
  return `أنت "المشرف الذكي" — المرشد الأكاديمي المعتمد لطلاب ${ACADEMY_INFO.nameAr} (${ACADEMY_INFO.nameEn})، تأسست ${ACADEMY_INFO.founded}.

${buildSupervisorPersonaBlock(persona)}

ملف الذكاء والذاكرة التشغيلية:
- مؤشر فهم نية الطالب الداخلي: ${SMART_SUPERVISOR_INTELLIGENCE}%.
- مؤشر تغطية الذاكرة المعرفية الرسمية: ${SMART_SUPERVISOR_MEMORY}% من معلومات المنصة المتاحة لك.
- لا تذكر هذه النسب للطالب إلا إذا سألك عن قدراتك مباشرة.
- ذاكرتك تشمل كتالوج البرامج، شروط القبول، الرسوم، الشهادات، الاعتمادات، ملف الطالب، وحداته، كتبه، تقدمه، محاولات الاختبار، وبحث التخرج عند توفرها في السياق.

هويتك ودورك:
- مشرف أكاديمي ودود ومحترف يرافق كل طالب في رحلته التدريبية.
- تجيب على استفسارات الطلاب حول: البرامج، التخصصات، محتوى الوحدات التدريبية، مفاهيم الاستشارة المهنية، إجراءات الالتحاق، الرسوم، الشهادات، الاعتمادات، ونظام الوكلاء الدوليين.
- تفهم العربية الفصحى واللهجات الشائعة مثل: بدي، شو، إيش، عايز، حاب، عندكم، في برامج.
- إذا سأل الطالب: "شو في برامج؟" أو "بدي أعرف البرامج" فابدأ بالبرامج والتخصصات، ولا تجب عن الرسوم إلا إذا طلب السعر أو التكلفة صراحة.
- اشرح بأسلوب تعليمي مبسط مع أمثلة عملية من الواقع، وشجع الطالب واقترح خطوة تالية.

معلومات الأكاديمية:
- الشعار: "${ACADEMY_INFO.taglineAr}" (${ACADEMY_INFO.taglineEn})
- البريد: ${ACADEMY_INFO.email} | واتساب: ${ACADEMY_INFO.whatsapp}
- البرامج: ${ACADEMY_INFO.programs}
- الشهادات تُصدر خلال ${ACADEMY_INFO.certificateDays} يوماً من استلام كشوف الدرجات والرسوم.
- الوكلاء الدوليون: نسبة ${ACADEMY_INFO.agentCommission} من إيرادات منطقة التمثيل + ${ACADEMY_INFO.researchFee} عن كل بحث تخرج يشارك الوكيل في لجنة مناقشته.

دليل إجراءات وشروط الالتحاق:
- شروط القبول: ${ADMISSION_GUIDE.conditions.join(' / ')}
- الوثائق المطلوبة: ${ADMISSION_GUIDE.documents.join(' / ')}
- خطوات التسجيل: ${ADMISSION_GUIDE.steps.join(' ← ')}
- رسوم تقديم الطلب وحجز المقعد: ${ADMISSION_FEES.applicationFee}$ غير مستردة.
- التكلفة المالية: الدكتوراه المهنية (معادلة خبرات) ${ADMISSION_FEES.doctorate}$ — الماجستير المهني (معادلة خبرات) ${ADMISSION_FEES.masters}$ — الدبلومات والبرامج الدولية من ${ADMISSION_FEES.diplomasRange}$ حسب البرنامج.
- متطلبات التخرج: ${ADMISSION_GUIDE.graduation.join(' / ')}
- مدة بحث التخرج: من 3 إلى 6 شهور كحد أقصى، وتتم مناقشته من قبل لجنة متخصصة.
- ملاحظة رسمية: ${ADMISSION_GUIDE.note}

دليل الاعتمادات الدولية:
- رسوم تقديم طلب الاعتماد: ${ACCREDITATION_GUIDE.applicationFee}$ غير مستردة.
- أنواع الاعتماد ورسومها: الهيئات التدريبية 1000$ — المستشارون 350$ — المدرب الدولي المعتمد 200$ — اعتماد الجودة حسب طبيعة الاعتماد.
- مميزات الاعتماد: ${ACCREDITATION_GUIDE.benefits.join(' / ')}

كتالوج البرامج الرسمي المتاح في ذاكرة المشرف:
${buildStaticProgramCatalog()}

تعليمات مهمة:
- إذا سأل الطالب عن البرامج، اعرض البرامج أو المجالات أولاً، ثم اسأله عن المجال الذي يريده. لا تبدأ بالرسوم.
- إذا سأل عن الرسوم أو السعر أو التكلفة، اذكر الرسوم باختصار ثم اسأله عن اسم البرنامج.
- إذا سأل عن حالة إدارية خاصة غير متوفرة لديك، اطلب التواصل مع الإدارة عبر البريد ${ACADEMY_INFO.email}.
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
  return (
    hasAnyWord(q, ['برنامج', 'برامج', 'دبلوم', 'دبلومات', 'ماجستير', 'دكتوراه', 'دكتوراة', 'تدريب', 'تدريبيه', 'تدريبي', 'تخصص', 'تخصصات', 'كورس', 'كورسات', 'دوره', 'دورات']) ||
    hasAnyPhrase(q, ['شو في', 'ايش في', 'اي برامج', 'في برامج', 'عندكم برامج', 'بدي اعرف البرامج', 'بدي اسال شو في', 'تحكي لي شو في'])
  )
}

function isFeesIntent(q: string): boolean {
  return (
    hasAnyWord(q, ['رسوم', 'الرسم', 'السعر', 'سعر', 'تكلفه', 'التكلفه', 'دفع', 'قسط', 'اقساط', 'دولار', 'فلوس', 'مصاري']) ||
    hasAnyPhrase(q, ['كم سعر', 'كم رسوم', 'كم التكلفه', 'كم تكلف', 'شو السعر', 'ايش السعر', 'كم بدفع'])
  )
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

function pickRelevantPrograms(q: string, limit = 7): SeedProgramItem[] {
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

  if (wanted.length === 0) {
    const priority = ['DOCTORATE', 'MASTERS', 'DIPLOMA', 'ACCREDITATION']
    const selected: SeedProgramItem[] = []
    for (const cat of priority) {
      const group = allSeedPrograms.filter((p) => p.category === cat).slice(0, cat === 'DIPLOMA' ? 4 : 2)
      for (const p of group) if (!selected.includes(p)) selected.push(p)
    }
    return selected.slice(0, limit)
  }

  const scored = allSeedPrograms
    .map((p) => {
      const blob = normalizeArabicQuestion([p.titleAr, p.titleEn, p.category, p.description, ...(p.features || [])].join(' '))
      const score = wanted.reduce((s, k) => s + (blob.includes(k) ? 1 : 0), 0)
      return { p, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return scored.length ? scored.map((x) => x.p) : allSeedPrograms.slice(0, limit)
}

function formatProgramList(programs: SeedProgramItem[]): string {
  return programs
    .map((p, i) => {
      const hours = p.hours ? `، ${p.hours} ساعة` : ''
      return `${i + 1}. ${p.titleAr}${hours}`
    })
    .join('\n')
}

function programCategoriesSummary(): string {
  return 'المجالات الرئيسية عندنا: الدبلومات المهنية، الماجستير المهني، الدكتوراه المهنية، الاعتمادات الدولية، الموارد البشرية، الجودة، إدارة المشاريع، التسويق، الذكاء الاصطناعي، وإعداد المدربين TOT.'
}

function localSupervisorFallback(messages: { role: string; content: string }[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
  const q = normalizeArabicQuestion(last)
  const programIntent = isProgramIntent(q)
  const feesIntent = isFeesIntent(q)

  if (isCapabilityIntent(q)) {
    return `أنا مشرفك الذكي بذاكرة معرفية داخلية تغطي تقريباً ${SMART_SUPERVISOR_MEMORY}% من معلومات المنصة المتاحة، ومؤشر فهم للنية حوالي ${SMART_SUPERVISOR_INTELLIGENCE}%. أستطيع مساعدتك في البرامج، الرسوم، التسجيل، الشهادات، الاعتمادات، تقدمك الدراسي، الكتب، الاختبارات، وبحث التخرج.`
  }

  if (isGreeting(q)) {
    return 'وعليكم السلام ورحمة الله، أهلاً بك. اسألني عن البرامج، الرسوم، التسجيل، الشهادات، أو أي موضوع أكاديمي تحتاجه.'
  }

  // سؤال البرامج له أولوية على الرسوم، حتى لا تلتقط كلمة مثل «عندكم» وتُفهم كـ «كم».
  if (programIntent && !feesIntent) {
    const programs = pickRelevantPrograms(q)
    return `أكيد. ${programCategoriesSummary()}\n\nأمثلة من البرامج المتاحة:\n${formatProgramList(programs)}\n\nقل لي المجال الذي يهمك أو اسم البرنامج، وأنا أعطيك تفاصيله وشروطه وخطة البدء.`
  }

  if (feesIntent) {
    return `أكيد. الرسوم تعتمد على نوع البرنامج: الدبلومات والبرامج الدولية غالباً بين ${ADMISSION_FEES.diplomasRange}$، والماجستير المهني ${ADMISSION_FEES.masters}$، والدكتوراه المهنية ${ADMISSION_FEES.doctorate}$. إذا ذكرت اسم البرنامج أعطيك تفاصيله بدقة.`
  }

  if (isCertificateIntent(q)) {
    return `الشهادة تُصدر عادة خلال ${ACADEMY_INFO.certificateDays} يوماً بعد استكمال المتطلبات والرسوم. إن كنت تسأل عن شهادة برنامج محدد، اكتب اسم البرنامج وسأوضح لك آلية الإصدار والاعتماد.`
  }

  if (isAdmissionIntent(q)) {
    return `خطوات التسجيل بسيطة: تختار البرنامج، ترسل بياناتك ووثائقك الأساسية، ثم يتم تثبيت القبول ودفع رسوم حجز المقعد. اكتب اسم البرنامج الذي يهمك وسأرشدك للخطوة التالية.`
  }

  if (programIntent) {
    const programs = pickRelevantPrograms(q)
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
  persona: SupervisorPersona = 'CHAT'
): Promise<string> {
  const systemPrompt = buildSupervisorSystemPrompt(context, persona)
  const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content || ''

  // أسئلة المنصة العامة نجيب عليها فورياً من بيانات الأكاديمية حتى لا ينتظر الطالب Gemini طويلاً.
  if (shouldAnswerLocally(lastUserText)) {
    return localSupervisorFallback(messages)
  }

  const geminiReady = await ensureGeminiKey().catch(() => false)

  if (geminiReady) {
    try {
      const history = messages.map((m) => ({
        role: m.role === 'user' ? 'user' as const : 'model' as const,
        text: m.content,
      }))
      return await geminiComplete({
        system: systemPrompt,
        history,
        temperature: 0.45,
        maxOutputTokens: 900,
      })
    } catch (e: any) {
      const msg = String(e?.message || e || '')
      console.error('Gemini chatComplete failed:', msg.slice(0, 300))
      if (isQuotaError(e)) return localSupervisorFallback(messages)
      if (isAuthError(e)) return 'مفتاح Gemini غير صالح أو لا يملك الصلاحية المطلوبة. يرجى مراجعة إعدادات Gemini في لوحة الإدارة.'
      if (!isModelUnavailableError(e) && !isInvalidArgumentError(e)) {
        // نكمل إلى Z-AI كاحتياط قبل الرجوع للرد المحلي.
      }
    }
  }

  try {
    const zai = await getZAI()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content,
        })),
      ],
      thinking: { type: 'disabled' },
    })
    const content = completion.choices[0]?.message?.content
    if (!content || !content.trim()) throw new Error('EMPTY_AI_RESPONSE')
    return content.trim()
  } catch (e: any) {
    console.error('ZAI chatComplete failed:', String(e?.message || e).slice(0, 300))
    return localSupervisorFallback(messages)
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

export async function gradeEssayAnswer(
  questionText: string,
  modelAnswer: string,
  studentAnswer: string,
  maxPoints: number,
  studentAcademicContext?: string
): Promise<GradedAnswer> {
  const zai = await getZAI()
  const prompt = `${buildSupervisorPersonaBlock('EXAM')}

${studentAcademicContext ? `سياق ملف الطالب للقياس العادل لا للمجاملة:\n${studentAcademicContext.slice(0, 6000)}\n` : ''}
أنت مصحح أكاديمي محترف في ${ACADEMY_INFO.nameAr}. صحح إجابة مقالية لطالب وفق المعايير التالية:

السؤال: ${questionText}

الإجابة النموذجية (المرجع): ${modelAnswer}

إجابة الطالب: ${studentAnswer || '(لم يجب)'}

قواعد التصحيح:
- قيّم من ${maxPoints} نقطة كحد أقصى
- قارن إجابة الطالب بالإجابة النموذجية: الدقة العلمية، الاكتمال، التطبيق العملي
- لا تمنح نقاطاً لإجابة فارغة أو عشوائية غير ذات صلة
- كن منصفاً: إجابة جزئية صحيحة تستحق نقاطاً جزئية
- اكتب تغذية راجعة بنّاءة بالعربية (2-3 جمل): ما أصاب الطالب وما ينقصه وكيف يتحسن

أجب بصيغة JSON فقط بدون أي نص إضافي:
{"points": <رقم من 0 إلى ${maxPoints}>, "feedback": "<التغذية الراجعة بالعربية>"}`

  const raw = await chatWithRetry(zai, [
    { role: 'assistant', content: 'أنت مصحح أكاديمي دقيق يرجع بـ JSON فقط.' },
    { role: 'user', content: prompt },
  ])

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('NO_JSON')
    const parsed = JSON.parse(jsonMatch[0])
    const points = Math.max(0, Math.min(maxPoints, Number(parsed.points) || 0))
    return {
      index: -1,
      points,
      maxPoints,
      feedback: String(parsed.feedback || '').slice(0, 1500),
    }
  } catch {
    return {
      index: -1,
      points: 0,
      maxPoints,
      feedback: 'تعذر تقييم الإجابة آلياً — سيراجعها المشرف الأكاديمي يدوياً.',
    }
  }
}

export async function generateOverallFeedback(
  programTitle: string,
  percentage: number,
  passed: boolean,
  weakPoints: string[]
): Promise<{ summary: string; strengths: string[]; improvements: string[] }> {
  const zai = await getZAI()
  const prompt = `${buildSupervisorPersonaBlock('EXAM')}

أنت مشرف أكاديمي في ${ACADEMY_INFO.nameAr}. طالب أنهى اختبار دورة "${programTitle}" بنتيجة ${percentage.toFixed(0)}% (${passed ? 'ناجح' : 'لم يجتز'}).

نقاط الضعف الملاحظة في إجاباته:
${weakPoints.map((w) => `- ${w}`).join('\n') || 'لا توجد نقاط ضعف كبيرة'}

اكتب تقييماً عاماً تحفيزياً وبنّاءً بالعربية بصيغة JSON فقط:
{"summary": "<ملخص الأداء 2-3 جمل>", "strengths": ["<نقطة قوة 1>", "<نقطة قوة 2>"], "improvements": ["<توصية تحسين 1>", "<توصية تحسين 2>"]}`

  try {
    const completion = await zai.chat.completions.create({
      messages: [
        { role: 'assistant', content: 'أنت مشرف أكاديمي يرجع بـ JSON فقط.' },
        { role: 'user', content: prompt },
      ],
      thinking: { type: 'disabled' },
    })
    const raw = completion.choices[0]?.message?.content || ''
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('NO_JSON')
    const parsed = JSON.parse(jsonMatch[0])
    return {
      summary: String(parsed.summary || '').slice(0, 800),
      strengths: (parsed.strengths || []).slice(0, 4).map(String),
      improvements: (parsed.improvements || []).slice(0, 4).map(String),
    }
  } catch {
    return {
      summary: passed
        ? 'مبروك! لقد اجتزت الاختبار بنجاح. استمر في التميز.'
        : 'لم تجتز الاختبار هذه المرة، لكن كل محاولة خطوة نحو الاحتراف. راجع الملاحظات وأعد المحاولة.',
      strengths: ['الالتزام بإكمال الاختبار'],
      improvements: ['مراجعة محتوى الوحدة التدريبية', 'التواصل مع المشرف الذكي لأي استفسار'],
    }
  }
}
