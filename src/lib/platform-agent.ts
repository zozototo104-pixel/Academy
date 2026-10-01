import { db } from '@/lib/db'
import { ACADEMY_INFO, ADMISSION_FEES, ADMISSION_GUIDE, ACCREDITATION_GUIDE, allSeedPrograms } from '@/lib/academyData'
import { chatComplete, type SupervisorPersona } from '@/lib/ai'
import { buildScopedDirectProgramBooksResult, buildScopedProgramCatalogSnapshot } from '@/lib/ai-context-builder'
import { resolveAiKnowledgeScope } from '@/lib/ai-knowledge-policy'
import { buildHumanSupervisorAssignedStudentsContext } from '@/lib/human-supervisor-context'
import { buildSupervisorContext, mergeContext } from '@/lib/supervisor-ai'
import { localAgentConfig, localChatComplete } from '@/lib/open-source-llm'
import { getGatewayConfig, paymentDiagnostics } from '@/lib/payments'
import { ensureGeminiKey, geminiActiveTextModel, geminiComplete, geminiCompleteJson, geminiDiscussionThinkingLevel, type GeminiThinkingLevel } from '@/lib/gemini'

export type PlatformAgentKind =
  | 'ACADEMIC_SUPERVISOR'
  | 'ADMISSIONS'
  | 'EXAMS'
  | 'THESIS_DEFENSE'
  | 'CERTIFICATES'
  | 'ADMIN_QUALITY'
  | 'AGENCY_ACCREDITATION'
  | 'SUPPORT'

export type PlatformAgentEngine = 'LOCAL_RULE' | 'LOCAL_OPEN_SOURCE' | 'GEMINI' | 'MODEL_ROUTER_OR_FALLBACK'

const AGENT_AR: Record<PlatformAgentKind, string> = {
  ACADEMIC_SUPERVISOR: 'المشرف الذكي الأكاديمي',
  ADMISSIONS: 'وكيل القبول والتسجيل',
  EXAMS: 'وكيل الامتحانات والقياس',
  THESIS_DEFENSE: 'وكيل البحث والمناقشة',
  CERTIFICATES: 'وكيل الشهادات والتحقق',
  ADMIN_QUALITY: 'وكيل الإدارة والجودة الأكاديمية',
  AGENCY_ACCREDITATION: 'وكيل الوكالة والاعتماد',
  SUPPORT: 'وكيل الدعم العام',
}

const HUMAN_SUPPORT_REPLY = [
  'أهلًا وسهلًا بك 🌟',
  'يسعدنا خدمتك. إذا كنت ترغب بالتواصل مع موظف حقيقي أو الإدارة مباشرة، يمكنك مراسلتنا عبر واتساب أو الاتصال على أحد الأرقام التالية:',
  '',
  '📞 +972594403737',
  '📞 +970 598 400 510',
  '',
  'اكتب لنا اسمك وموضوعك باختصار، وسيتم توجيهك للموظف المختص بإذن الله.',
].join('\n')

function normalizeArabic(text: string): string {
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

function includesAny(n: string, words: string[]) {
  return words.some((w) => n.includes(normalizeArabic(w)))
}

function wantsHumanSupport(message: string) {
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
    'اريد موظف',
    'بدي موظف',
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

function wantsPaymentMethodsInfo(message: string) {
  const n = normalizeArabic(message)
  if (!n) return false
  const explicitPaymentMethod = includesAny(n, [
    'طرق الدفع',
    'طريقة الدفع',
    'اليه الدفع',
    'الية الدفع',
    'كيف ادفع',
    'كيف اسدد',
    'ادفع كيف',
    'اسدد كيف',
    'الدفع عبر',
    'الدفع ب',
    'ادفع بال',
    'سداد الفاتوره',
    'سداد فاتوره',
    'ادفع الفاتوره',
    'دفع الفاتوره',
    'خيارات الدفع',
    'وسائل الدفع',
    'بوابه الدفع',
    'بوابة الدفع',
    'يو اس دي تي',
    'usdt',
    'tether',
    'تيثر',
    'بايننس',
    'binance',
    'paypal',
    'بايبال',
    'stripe',
    'سترايب',
    'بطاقه',
    'بطاقة',
    'visa',
    'mastercard',
  ])
  // سؤال الرسوم وحده مثل "كم رسوم البرنامج" ليس سؤالاً عن وسيلة الدفع.
  const feesOnly = includesAny(n, ['كم الرسوم', 'رسوم البرنامج', 'سعر البرنامج', 'تكلفه البرنامج', 'تكلفة البرنامج']) && !explicitPaymentMethod
  return explicitPaymentMethod && !feesOnly
}

function paymentMethodReplyLine(method: { id: string; label: string; enabled: boolean; kind: string; reason?: string }, cfg: Awaited<ReturnType<typeof getGatewayConfig>>) {
  const base = `- ${method.label}`
  if (method.id === 'USDT' && method.enabled) {
    const parts = [base]
    if (cfg.usdtNetwork) parts.push(`الشبكة/الآلية: ${cfg.usdtNetwork}`)
    if (cfg.usdtBinancePayUserId) parts.push(`معرف Binance Pay: ${cfg.usdtBinancePayUserId}`)
    if (cfg.usdtBinancePayQrImageUrl) parts.push('يتوفر خيار QR داخل شاشة الدفع في المنصة عند اختيار USDT.')
    return parts.join(' — ')
  }
  if (method.id === 'DIRECT_PAYMENT' && method.enabled) {
    return `${base} — يتم إنشاء/متابعة الفاتورة داخل بوابة الطالب، ثم تؤكد الإدارة السداد يدوياً بعد استلام الإشعار.`
  }
  return base
}

async function buildDynamicPaymentMethodsReply() {
  const cfg = await getGatewayConfig()
  const diag = paymentDiagnostics(cfg)
  const active = diag.methods.filter((m) => m.enabled)
  const inactive = diag.methods.filter((m) => !m.enabled)
  const lines: string[] = [
    'حسب إعدادات الدفع الحالية الظاهرة في المنصة، طرق الدفع المتاحة الآن هي:',
    '',
  ]
  if (active.length) {
    lines.push(...active.map((m) => paymentMethodReplyLine(m, cfg)))
  } else {
    lines.push('- لا توجد وسيلة دفع مفعّلة حالياً في المنصة. يرجى التواصل مع الإدارة قبل إرسال أي مبلغ.')
  }

  lines.push('', 'طريقة الاستخدام: افتح الفاتورة من بوابة الطالب، اختر وسيلة الدفع المتاحة، ثم اتبع التعليمات الظاهرة في نفس شاشة الفاتورة. إذا كانت الوسيلة يدوية مثل الدفع المباشر أو USDT، أرسل إثبات السداد أو رقم العملية من شاشة الفاتورة حتى تراجعه الإدارة.')

  const preparing = inactive.filter((m) => m.reason && /جاري التجهيز|مغلقة|لم يتم ضبط/.test(m.reason)).map((m) => m.label)
  if (preparing.length) {
    lines.push('', `طرق ظاهرة لكنها غير مفعّلة حالياً/قيد التجهيز: ${preparing.join('، ')}. لا تعتمد عليها قبل أن تظهر كخيار مفعّل في الفاتورة.`)
  }
  if (diag.warnings.length) lines.push('', `تنبيهات إعداد الدفع: ${diag.warnings.join(' ')}`)
  if (diag.errors.length) lines.push('', `ملاحظات مهمة: ${diag.errors.join(' ')}`)
  lines.push('', 'للمساعدة أو التأكد من السداد يمكنك التواصل مع الإدارة عبر:', '📞 +972594403737', '📞 +970 598 400 510')
  return lines.join('\n')
}

async function buildPaymentMethodsContext() {
  const cfg = await getGatewayConfig()
  const diag = paymentDiagnostics(cfg)
  const active = diag.methods.filter((m) => m.enabled).map((m) => paymentMethodReplyLine(m, cfg)).join('\n') || 'لا توجد طرق مفعلة حالياً.'
  const inactive = diag.methods.filter((m) => !m.enabled).map((m) => `- ${m.label}: ${m.reason || 'غير مفعلة'}`).join('\n')
  return [
    'حالة الدفع الحالية من إعدادات المنصة. هذه هي مصدر الحقيقة عند أي سؤال عن طريقة الدفع، ولا تذكر وسائل غير ظاهرة هنا كوسائل معتمدة.',
    `طرق الدفع المفعلة:\n${active}`,
    inactive ? `طرق غير مفعلة أو قيد التجهيز:\n${inactive}` : '',
  ].filter(Boolean).join('\n')
}

type ConversationIntentKind =
  | 'HUMAN_HANDOFF'
  | 'PAYMENT_METHODS'
  | 'ADMISSION_REGISTRATION'
  | 'ACADEMIC_PROGRAM_INFO'
  | 'FOLLOWUP_ANSWER'
  | 'SOCIAL_SMALL_TALK'
  | 'GENERAL_SUPPORT'
  | 'UNKNOWN'

type ConversationIntentAnalysis = {
  intent: ConversationIntentKind
  confidence: number
  suggestedAgent?: PlatformAgentKind
  responseDepth?: 'short' | 'normal' | 'detailed'
  shouldGreet?: boolean
  followupOf?: string
  reasoning?: string
}

function clampConfidence(value: unknown) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function parseJsonObject(text: string): any | null {
  const raw = String(text || '').trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch {}
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try { return JSON.parse(match[0]) } catch { return null }
}

function normalizeIntentKind(value: unknown): ConversationIntentKind {
  const v = String(value || '').trim().toUpperCase()
  const allowed: ConversationIntentKind[] = ['HUMAN_HANDOFF', 'PAYMENT_METHODS', 'ADMISSION_REGISTRATION', 'ACADEMIC_PROGRAM_INFO', 'FOLLOWUP_ANSWER', 'SOCIAL_SMALL_TALK', 'GENERAL_SUPPORT', 'UNKNOWN']
  return (allowed as string[]).includes(v) ? v as ConversationIntentKind : 'UNKNOWN'
}

function normalizeSuggestedAgent(value: unknown): PlatformAgentKind | undefined {
  const v = String(value || '').trim().toUpperCase()
  const allowed: PlatformAgentKind[] = ['ACADEMIC_SUPERVISOR', 'ADMISSIONS', 'EXAMS', 'THESIS_DEFENSE', 'CERTIFICATES', 'ADMIN_QUALITY', 'AGENCY_ACCREDITATION', 'SUPPORT']
  return (allowed as string[]).includes(v) ? v as PlatformAgentKind : undefined
}

function fallbackIntentAnalysis(message: string): ConversationIntentAnalysis {
  if (wantsHumanSupport(message)) return { intent: 'HUMAN_HANDOFF', confidence: 0.74, suggestedAgent: 'SUPPORT', responseDepth: 'normal' }
  if (wantsPaymentMethodsInfo(message)) return { intent: 'PAYMENT_METHODS', confidence: 0.76, suggestedAgent: 'ADMISSIONS', responseDepth: 'detailed' }
  const n = normalizeArabic(message)
  const social = n.length <= 40 && includesAny(n, ['كيفك', 'كيف الحال', 'شو اخبارك', 'اخبارك', 'السلام عليكم', 'مرحبا', 'اهلا'])
  if (social) return { intent: 'SOCIAL_SMALL_TALK', confidence: 0.6, responseDepth: 'short', shouldGreet: true }
  return { intent: 'UNKNOWN', confidence: 0.2 }
}

async function analyzeConversationIntent(messages: { role: string; content: string }[], opts?: { channel?: string; role?: string | null }): Promise<ConversationIntentAnalysis> {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content || ''
  const fallback = fallbackIntentAnalysis(last)
  const ready = await ensureGeminiKey().catch(() => false)
  if (!ready) return fallback
  try {
    const recent = messages.slice(-8).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: compactText(m.content, 700),
    }))
    const raw = await withPlatformTimeout(geminiCompleteJson({
      system: [
        'أنت محلل نية محادثة لمنصة أكاديمية. مهمتك فهم المقصود دلالياً من الرسالة الأخيرة ضمن سياق الرسائل السابقة، وليس مطابقة كلمات.',
        'لا تكتب رداً للمستخدم. أرجع JSON فقط.',
        'اعتبر طلب موظف/دعم بشري إذا كان المستخدم يريد نقله لشخص حقيقي أو خدمة العملاء أو الدعم الفني أو الإدارة أو متابعة بشرية، بأي صياغة أو لهجة.',
        'اعتبر FOLLOWUP_ANSWER إذا كانت الرسالة الأخيرة جواباً قصيراً على سؤال سابق من المساعد مثل الاسم، البرنامج المطلوب، الموضوع، البلد، المؤهل، أو بيانات التسجيل.',
        'اعتبر SOCIAL_SMALL_TALK فقط إذا كانت الرسالة مجاملة قصيرة لا تطلب معلومات أكاديمية أو تسجيل أو دفع.',
        'أسئلة البرامج والرسوم والتسجيل والأكاديمية تحتاج تفصيلاً مناسباً، ولا تختصرها لمجرد أنها على واتساب.',
        'لا تعتمد على كلمة واحدة معزولة؛ افهم القصد من السياق الكامل.',
        'القيم المسموحة intent: HUMAN_HANDOFF, PAYMENT_METHODS, ADMISSION_REGISTRATION, ACADEMIC_PROGRAM_INFO, FOLLOWUP_ANSWER, SOCIAL_SMALL_TALK, GENERAL_SUPPORT, UNKNOWN.',
        'القيم المسموحة suggestedAgent: SUPPORT, ADMISSIONS, ACADEMIC_SUPERVISOR, EXAMS, THESIS_DEFENSE, CERTIFICATES, AGENCY_ACCREDITATION, ADMIN_QUALITY.',
        'أرجع JSON بالشكل: {"intent":"...","confidence":0.0,"suggestedAgent":"...","responseDepth":"short|normal|detailed","shouldGreet":true|false,"followupOf":"...","reasoning":"..."}',
      ].join('\n'),
      history: [
        { role: 'user', text: JSON.stringify({ channel: opts?.channel || 'WEB', userRole: opts?.role || 'PUBLIC', recentMessages: recent }, null, 2) },
      ],
      temperature: 0.05,
      maxOutputTokens: 700,
    }), 6500, 'Conversation intent analysis timed out')
    const parsed = parseJsonObject(raw)
    if (!parsed) return fallback
    const intent = normalizeIntentKind(parsed.intent)
    const confidence = clampConfidence(parsed.confidence)
    const suggestedAgent = normalizeSuggestedAgent(parsed.suggestedAgent)
    const responseDepth = ['short', 'normal', 'detailed'].includes(String(parsed.responseDepth)) ? parsed.responseDepth as ConversationIntentAnalysis['responseDepth'] : undefined
    const shouldGreet = typeof parsed.shouldGreet === 'boolean' ? parsed.shouldGreet : undefined
    return {
      intent,
      confidence,
      suggestedAgent,
      responseDepth,
      shouldGreet,
      followupOf: compactText(parsed.followupOf, 180) || undefined,
      reasoning: compactText(parsed.reasoning, 220) || undefined,
    }
  } catch (e: any) {
    console.warn('conversation intent analysis failed:', String(e?.message || e).slice(0, 220))
    return fallback
  }
}

function conversationStyleContext(analysis: ConversationIntentAnalysis, channel?: string) {
  const rules: string[] = [
    `تحليل نية الرسالة الأخيرة: ${analysis.intent} — الثقة ${Math.round((analysis.confidence || 0) * 100)}%.`,
  ]
  if (analysis.followupOf) rules.push(`الرسالة الأخيرة تبدو جواباً على طلب سابق بخصوص: ${analysis.followupOf}. تعامل معها كسياق متابعة ولا تبدأ من الصفر.`)
  if (analysis.shouldGreet === false) rules.push('لا تكرر عبارة الترحيب باسم المستخدم في هذا الرد؛ ادخل مباشرة في جواب السؤال أو الخطوة التالية.')
  if (analysis.shouldGreet === true) rules.push('يمكن بدء الرد بترحيب قصير مرة واحدة فقط إذا كان هذا مناسباً لبداية المحادثة.')
  if (analysis.intent === 'SOCIAL_SMALL_TALK') rules.push('هذه مجاملة قصيرة؛ أجب بلطف وباختصار شديد ثم اسأل كيف يمكن المساعدة، ولا تعرض تفاصيل البرامج إلا إذا طلبها المستخدم.')
  if (analysis.intent === 'ADMISSION_REGISTRATION' || analysis.intent === 'ACADEMIC_PROGRAM_INFO' || analysis.responseDepth === 'detailed') rules.push('السؤال متعلق بالأكاديمية/البرامج/التسجيل؛ أعطِ جواباً مفيداً ومفصلاً بقدر السؤال، ولا تختصره إلى مجاملة عامة.')
  if (analysis.intent === 'FOLLOWUP_ANSWER') rules.push('اربط إجابة المستخدم بالسؤال السابق: إذا أعطى اسماً أو برنامجاً أو موضوعاً، استخدمه للخطوة التالية بدلاً من طلبه مرة أخرى.')
  if (channel === 'WHATSAPP') rules.push('نسّق الرد بما يناسب واتساب: فقرات قصيرة، نقاط واضحة، وتجنّب تكرار التحية في كل رسالة.')
  if (analysis.reasoning) rules.push(`ملاحظة داخلية عن السبب: ${analysis.reasoning}`)
  return rules.join('\n')
}

function hasTokenAny(n: string, words: string[]) {
  const tokens = new Set(n.split(/\s+/).filter(Boolean))
  return words.some((w) => tokens.has(normalizeArabic(w)))
}

function hasThesisDefenseIntent(n: string) {
  return hasTokenAny(n, ['بحث', 'بحثي', 'ابحاث', 'رسالتي', 'رسالة', 'اطروحة', 'اطروحتي', 'مناقشة', 'المناقشة', 'لجنة', 'منهجية', 'المنهجية', 'نتائج', 'النتائج', 'توصيات', 'دفاع'])
    || includesAny(n, ['بحث تخرج', 'مشروع تخرج', 'لجنة مناقشة', 'عضو لجنة', 'عنوان بحثي', 'قبل المناقشة'])
}

function hasStudentAcademicIntent(n: string) {
  return hasTokenAny(n, ['ملفي', 'اكاديمي', 'الاكاديمي', 'برنامجي', 'كتبي', 'كتابي', 'وحداتي', 'وحدات', 'منهجي', 'منهاجي', 'مقرراتي', 'دراستي', 'قراءتي', 'اقرا', 'اراجع'])
    || includesAny(n, ['ملفي الاكاديمي', 'نقاط الضعف', 'خطة قراءة', 'خطة دراسة', 'ما الكتب', 'ما الوحدات'])
}

function compactText(value?: string | null, max = 220): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function platformAiTimeoutMs(fallback = 22_000) {
  const env = Number(process.env.PLATFORM_AGENT_PROVIDER_TIMEOUT_MS || process.env.SUPERVISOR_AI_PROVIDER_TIMEOUT_MS || '')
  if (Number.isFinite(env) && env >= 3_000) return Math.min(Math.floor(env), 58_000)
  return fallback
}

function withPlatformTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function providerStatusFromError(e: any): number | undefined {
  const status = Number(e?.status || e?.code || 0)
  return Number.isFinite(status) && status >= 100 && status <= 599 ? status : undefined
}

function logPlatformProviderAttempt(args: {
  ok: boolean
  provider: string
  model: string
  agent: PlatformAgentKind
  ms: number
  status?: number
  error?: string
}) {
  console.info('[platform-agent-provider]', args.ok ? 'ok' : 'failed', {
    provider: args.provider,
    model: args.model,
    agent: args.agent,
    ms: args.ms,
    status: args.status,
    error: args.error ? args.error.slice(0, 220) : undefined,
  })
}

function expandArabicProgramQuery(query?: string | null): string {
  const raw = String(query || '').toLowerCase()
  const n = normalizeArabic(query || '')
  const aliases: string[] = [n, raw]

  if (includesAny(n, ['دكتوراه', 'دكتوراة', 'دكتورا', 'الدكتوراه', 'الدكتوراة', 'دكتوراء', 'دكتور']) || /doctor|doctorate|phd|doctorado|doutorado/.test(raw)) {
    aliases.push('الدكتوراه المهنيه دكتوراه مهنيه professional doctorate doctorate phd doctorado doutorado')
  }
  if (includesAny(n, ['ماجستير', 'مجستير', 'ماستر', 'الماجستير', 'المجستير']) || /master|masters|maestr|maestría|maestria|mestrado|maestrado/.test(raw)) {
    aliases.push('الماجستير المهني ماجستير مهني master masters maestria maestría maestrado mestrado')
  }
  if (includesAny(n, ['بكالوريوس', 'بكلوريوس', 'باكالوريوس', 'البكالوريوس'])) {
    aliases.push('البكالوريوس bachelor bachelors')
  }
  if (includesAny(n, ['دبلوم', 'دبلومات', 'دبلومه', 'دبلم'])) {
    aliases.push('الدبلومات المهنيه دبلوم مهني diploma')
  }
  if (includesAny(n, ['رسوم', 'سعر', 'اسعار', 'تكلفه', 'كلفه', 'كم'])) {
    aliases.push('رسوم سعر تكلفه price fee tuition')
  }
  if (includesAny(n, ['اعتماد', 'معتمد', 'شهاده', 'شهادة'])) {
    aliases.push('اعتماد شهادة معتمدة certificate accreditation')
  }

  return aliases.join(' ')
}

function queryTokens(query?: string | null): string[] {
  const stop = new Set([
    'هذا', 'هذه', 'هدا', 'هاي', 'في', 'من', 'عن', 'على', 'الى', 'الي', 'إلى', 'شو', 'ما', 'هو', 'هي', 'له', 'لها', 'اليه', 'إليه', 'اللي', 'بدي', 'اسالك', 'اسألك',
    'برنامج', 'برنامح', 'تخصص', 'التخصص', 'كتب', 'الكتب', 'كتاب', 'مخصصه', 'مخصصة', 'مقرره', 'مقررة', 'منهاج', 'منهج', 'مواد', 'المواد', 'المسجله', 'المسجلة',
  ].map(normalizeArabic))
  return Array.from(new Set(
    expandArabicProgramQuery(query)
      .split(' ')
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !stop.has(t))
  )).slice(0, 28)
}

function scoreCatalogProgram(program: any, query?: string | null): number {
  const tokens = queryTokens(query)
  if (!tokens.length) return 0
  const haystack = normalizeArabic([
    program.titleAr,
    program.titleEn,
    program.category,
    program.description,
    ...(program.books || []).flatMap((book: any) => [book.title, book.titleEn, book.author, book.description]),
    ...(program.units || []).flatMap((unit: any) => [unit.title, unit.summary]),
    ...(program.assignments || []).map((assignment: any) => assignment.title),
    ...(program.programExams || []).map((exam: any) => exam.title),
  ].filter(Boolean).join(' '))
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0)
}

function asksAboutProgramBooks(query?: string | null) {
  const raw = String(query || '').toLowerCase()
  const n = normalizeArabic(query || '')
  const asksBooks = includesAny(n, ['كتب', 'الكتب', 'كتاب', 'مراجع', 'المراجع', 'منهاج', 'منهج', 'مواد', 'مقرره', 'مقررة', 'المقرره', 'المقررة']) || /book|books|bibliography|curriculum|syllabus|libros|livros/.test(raw)
  const asksProgram = includesAny(n, ['برنامج', 'برامج', 'تخصص', 'تخصصات', 'ماجستير', 'مجستير', 'ماستر', 'دكتوراه', 'دكتوراة', 'دبلوم', 'بكالوريوس']) || /program|degree|major|specialization|master|masters|maestr|mestrado|maestrado|doctor|doctorate|phd|diploma|bachelor/.test(raw)
  return asksBooks && asksProgram
}

async function buildDirectProgramBooksReply(query?: string | null) {
  if (!asksAboutProgramBooks(query)) return null
  const programs = await db.program.findMany({
    orderBy: [{ active: 'desc' }, { order: 'asc' }, { titleAr: 'asc' }],
    take: 160,
    select: {
      titleAr: true,
      titleEn: true,
      category: true,
      active: true,
      books: { orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], take: 30, select: { title: true, titleEn: true, author: true, semester: true, description: true } },
      units: { orderBy: [{ semester: 'asc' }, { order: 'asc' }], take: 12, select: { title: true, semester: true, status: true } },
    },
  }).catch(() => [])
  if (!programs.length) return null

  const scored = (programs as any[])
    .map((program) => ({ program, score: scoreCatalogProgram(program, query) }))
    .sort((a, b) => (b.score - a.score) || Number(b.program.active) - Number(a.program.active) || String(a.program.titleAr || '').localeCompare(String(b.program.titleAr || ''), 'ar'))
  const focused = scored.filter((item) => item.score > 0)
  const focusedWithBooks = focused.filter((item) => (item.program.books || []).length > 0)
  const selected = (focusedWithBooks.length ? focusedWithBooks : focused).slice(0, 12)

  const lines = selected.map(({ program }, index) => {
    const books = program.books?.length
      ? program.books.map((b: any, bookIndex: number) => `${bookIndex + 1}. ${b.title}${b.titleEn ? ` (${b.titleEn})` : ''}${b.author ? ` — ${b.author}` : ''}${b.semester ? ` — فصل ${b.semester}` : ''}${b.description ? ` — ${compactText(b.description, 140)}` : ''}`).join('\n')
      : 'لا توجد كتب مسجلة لهذا البرنامج في قاعدة البيانات.'
    const units = program.units?.length ? `\nالوحدات المسجلة: ${program.units.map((u: any) => `${u.title}${u.semester ? ` / فصل ${u.semester}` : ''}`).join('، ')}` : ''
    return `${index + 1}. ${program.titleAr}${program.titleEn ? ` (${program.titleEn})` : ''} — ${program.category}${program.active ? '' : ' — غير نشط'}\nالكتب المسجلة حرفياً:\n${books}${units}`
  })

  return [
    'حسب قاعدة بيانات المنصة الحالية، هذه الكتب/المراجع المسجلة للبرامج المطابقة لسؤالك:',
    '',
    lines.join('\n\n'),
    '',
    'إذا كنت تقصد برنامج ماجستير محدد بالاسم، اذكر اسمه وسأعرض كتبه فقط من نفس قاعدة البيانات.',
  ].join('\n')
}

function routeAgent(message: string, role?: string | null): PlatformAgentKind {
  const n = normalizeArabic(message)
  if (role === 'ADMIN' && includesAny(n, ['احصائيات', 'تقرير', 'جودة', 'طلاب', 'طالب', 'طلبات', 'قبول', 'مدفوعات', 'اشراف', 'مشرفين', 'متعثرين', 'اعتراضات', 'لوحة', 'مؤشرات', 'منهاج', 'منهج', 'كتب', 'برنامج', 'تخصص', 'ماجستير', 'مجستير', 'ماستر', 'دكتوراه', 'دكتوراة', 'بكالوريوس', 'بكلوريوس', 'دبلوم'])) return 'ADMIN_QUALITY'
  if (role === 'SUPERVISOR' && includesAny(n, ['طلابي', 'طلاب', 'طالب', 'بحث', 'ابحاث', 'مناقشة', 'منهجيه', 'متابعة', 'متعثر'])) return 'THESIS_DEFENSE'

  // نية البحث/المناقشة أعلى من القبول؛ كلمة «تخصصي» لا يجب أن تسحب سؤال المناقشة إلى القبول.
  if (hasThesisDefenseIntent(n)) return 'THESIS_DEFENSE'

  if (includesAny(n, ['امتحان', 'اختبار', 'سؤال', 'اسئلة', 'تصحيح', 'درجة', 'اعتراض', 'قياس', 'تقويم'])) return 'EXAMS'

  // الطالب عندما يسأل عن ملفه/برنامجه/كتبه فهو يحتاج المشرف الأكاديمي لا وكيل القبول العام.
  if (role === 'STUDENT' && hasStudentAcademicIntent(n)) return 'ACADEMIC_SUPERVISOR'

  if (includesAny(n, ['برامج', 'برنامج', 'تخصص', 'دبلوم', 'دبلومات', 'دبلم', 'ماجستير', 'مجستير', 'ماستر', 'دكتوراه', 'دكتوراة', 'دكتورا', 'بكالوريوس', 'بكلوريوس'])) return 'ADMISSIONS'
  if (includesAny(n, ['قبول', 'التحاق', 'تسجيل', 'مرفقات', 'وثائق', 'طلب', 'دفع رسوم التقديم', 'استكمال'])) return 'ADMISSIONS'
  if (includesAny(n, ['شهادة', 'شهادتي', 'تحقق', 'qr', 'سجل اكاديمي', 'رقم شهادة'])) return 'CERTIFICATES'
  if (includesAny(n, ['وكالة', 'وكيل', 'اعتماد', 'جهة اعتماد', 'مدرب معتمد', 'مستشار معتمد'])) return 'AGENCY_ACCREDITATION'
  if (includesAny(n, ['كتاب', 'كتب', 'منهج', 'منهاج', 'دراسة', 'اشرح', 'مفهوم', 'واجب', 'محاضرة', 'تخصصي', 'برنامجي'])) return 'ACADEMIC_SUPERVISOR'
  return role === 'STUDENT' ? 'ACADEMIC_SUPERVISOR' : 'SUPPORT'
}

function personaForAgent(agent: PlatformAgentKind): SupervisorPersona {
  if (agent === 'EXAMS') return 'EXAM'
  if (agent === 'THESIS_DEFENSE') return 'DEFENSE'
  return 'CHAT'
}

function staticProgramsDigest(max = 40): string {
  return allSeedPrograms.slice(0, max).map((p, i) => {
    const fee = p.price ? ` — رسوم تقريبية ${p.price} دولار` : ''
    const hours = p.hours ? ` — ${p.hours} ساعة` : ''
    return `${i + 1}. ${p.titleAr}${p.titleEn ? ` (${p.titleEn})` : ''} — ${p.category}${hours}${fee}`
  }).join('\n')
}

function publicQueryIntentNote(query?: string | null): string {
  const n = normalizeArabic(query || '')
  const notes: string[] = []
  if (includesAny(n, ['دكتوراه', 'دكتوراة', 'دكتورا', 'الدكتوراه', 'الدكتوراة', 'دكتور'])) {
    notes.push('نية السؤال: المستخدم يقصد الدكتوراه المهنية حتى لو كتبها دكتوراة/دكتورا/دكتور. ابحث في برامج الدكتوراه المهنية، ولا تعرض نطاقاً عاماً إذا وجدت رسوماً محددة في البيانات.')
  }
  if (includesAny(n, ['ماجستير', 'مجستير', 'ماستر', 'الماجستير', 'المجستير'])) {
    notes.push('نية السؤال: المستخدم يقصد الماجستير المهني حتى لو كتب مجستير/ماستر. ابحث في برامج الماجستير المهنية.')
  }
  if (includesAny(n, ['بكالوريوس', 'بكلوريوس', 'باكالوريوس'])) {
    notes.push('نية السؤال: المستخدم يقصد البكالوريوس حتى لو أخطأ في الكتابة.')
  }
  if (includesAny(n, ['رسوم', 'سعر', 'اسعار', 'تكلفه', 'كلفه', 'كم'])) {
    notes.push('المطلوب غالباً رسوم/تكلفة: اذكر الرسوم الرقمية الموجودة لكل برنامج مطابق. إذا لم يحدد المستخدم اسم البرنامج، قل إن الرسوم تختلف حسب البرنامج ثم اعرض البرامج المطابقة ورسوم كل منها من البيانات.')
  }
  return notes.join('\n')
}

async function buildPublicPlatformSnapshot(query?: string | null): Promise<string> {
  try {
    const programs = await db.program.findMany({
      where: { active: true },
      orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
      take: 120,
      select: {
        titleAr: true,
        titleEn: true,
        category: true,
        hours: true,
        price: true,
        description: true,
        registrationStatus: true,
        academicReadinessStatus: true,
        books: { orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], take: 8, select: { title: true, titleEn: true, author: true, semester: true, description: true } },
        units: { orderBy: [{ semester: 'asc' }, { order: 'asc' }], take: 8, select: { title: true, semester: true, summary: true, status: true } },
        _count: { select: { books: true, units: true, assignments: true, programExams: true, enrollments: true } },
      },
    }).catch(() => [])

    const source = programs.length
      ? programs
      : allSeedPrograms.slice(0, 80).map((p: any) => ({
        titleAr: p.titleAr,
        titleEn: p.titleEn,
        category: p.category,
        hours: p.hours,
        price: p.price,
        description: p.description,
        registrationStatus: 'OPEN',
        academicReadinessStatus: 'SEED',
        books: [],
        units: [],
        _count: { books: 0, units: 0, assignments: 0, programExams: 0, enrollments: 0 },
      }))

    const scored = (source as any[])
      .map((program) => ({ program, score: scoreCatalogProgram(program, query) }))
      .sort((a, b) => (b.score - a.score) || String(a.program.category || '').localeCompare(String(b.program.category || ''), 'ar') || String(a.program.titleAr || '').localeCompare(String(b.program.titleAr || ''), 'ar'))

    const focused = scored.filter((item) => item.score > 0).slice(0, 12)
    const general = scored.slice(0, 50)

    function publicProgramLine(item: { program: any; score?: number }, index: number) {
      const p = item.program
      const books = p.books?.length ? ` كتب مقررة/مراجع: ${p.books.slice(0, 4).map((b: any) => `«${b.title || b.titleEn}»${b.author ? ` — ${b.author}` : ''}`).join('، ')}.` : ''
      const units = p.units?.length ? ` وحدات/محاور: ${p.units.slice(0, 4).map((u: any) => u.title).join('، ')}.` : ''
      const fee = p.price ? ` الرسوم التقريبية: ${p.price}$.` : ''
      const hours = p.hours ? ` الساعات: ${p.hours}.` : ''
      const status = p.registrationStatus ? ` حالة التسجيل: ${p.registrationStatus}.` : ''
      const counts = p._count ? ` محتوى المنصة: ${p._count.books || 0} كتب، ${p._count.units || 0} وحدات، ${p._count.assignments || 0} واجبات، ${p._count.programExams || 0} امتحانات.` : ''
      return `${index + 1}. ${p.titleAr || p.titleEn}${p.titleEn ? ` (${p.titleEn})` : ''} — ${p.category || 'برنامج أكاديمي/مهني'}.${hours}${fee}${status}\n   الوصف: ${compactText(p.description, 240) || 'غير متاح'}${books}${units}${counts}`
    }

    const focusedLines = focused.map((item, i) => publicProgramLine(item, i)).join('\n')
    const generalLines = general.map((item, i) => publicProgramLine(item, i)).join('\n')

    const intentNote = publicQueryIntentNote(query)
    const paymentContext = await buildPaymentMethodsContext().catch(() => '')

    return [
      'سياق عام من قاعدة بيانات المنصة للزائر. هذا السياق هو المصدر العملي عند أي سؤال عام عن البرامج أو التسجيل أو الكتب أو الرسوم. لا تكتفِ بسؤال توضيحي إذا كان يمكن إعطاء إجابة مفيدة من هذا الفهرس. إذا كان السؤال عن رسوم درجة عامة مثل الدكتوراه المهنية أو الماجستير المهني فاعرض البرامج المطابقة ورسومها المحددة من البيانات بدلاً من إعطاء نطاق عام.',
      paymentContext,
      intentNote ? `تحليل السؤال الحالي:\n${intentNote}` : '',
      focusedLines ? `مطابقات مباشرة لسؤال الزائر الحالي "${compactText(query, 160)}":\n${focusedLines}` : '',
      `فهرس البرامج والخدمات النشطة المتاحة للزائر:\n${generalLines || staticProgramsDigest(50)}`,
      `قواعد القبول العامة: ${ADMISSION_GUIDE.conditions.join(' / ')}. الوثائق المطلوبة: ${ADMISSION_GUIDE.documents.join(' / ')}. رسوم تقديم القبول: ${ADMISSION_FEES.applicationFee}$ غير مستردة.`,
    ].filter(Boolean).join('\n\n').slice(0, 36000)
  } catch (error: any) {
    console.error('public platform snapshot error:', String(error?.message || error).slice(0, 400))
    return `فهرس البرامج الثابت:\n${staticProgramsDigest(50)}`
  }
}

function formatAdminProgramLine(p: any, i: number): string {
  const books = p.books?.length
    ? p.books.map((b: any) => `«${b.title}»${b.titleEn ? ` (${b.titleEn})` : ''}${b.author ? ` — ${b.author}` : ''}${b.semester ? ` — ف${b.semester}` : ''}${b.description ? ` — ${compactText(b.description, 140)}` : ''}`).join('\n      ')
    : 'لا توجد كتب مسجلة في قاعدة البيانات لهذا البرنامج'
  const units = p.units?.length ? p.units.slice(0, 8).map((u: any) => `${u.title} — ف${u.semester}/${u.status}${u.summary ? ` — ${compactText(u.summary, 100)}` : ''}`).join(' | ') : ''
  const assignments = p.assignments?.length ? p.assignments.map((a: any) => `${a.title} — ف${a.semester} — ${a.type}`).join(' | ') : ''
  const programExams = p.programExams?.length ? p.programExams.map((e: any) => `${e.title} — ف${e.semester}/${e.status} — حد النجاح ${e.passScore}%`).join(' | ') : ''
  return [
    `${i + 1}. ${p.titleAr}${p.titleEn ? ` (${p.titleEn})` : ''} — ${p.active ? 'نشط' : 'غير نشط'} — ${p.category}${p.hours ? ` — ${p.hours} ساعة` : ''}${p.price ? ` — ${p.price} دولار` : ''} — جاهزية ${p.academicReadinessStatus} — تسجيل ${p.registrationStatus}`,
    `   الوصف: ${compactText(p.description, 260) || 'غير متاح'}`,
    `   عدادات: كتب ${p._count.books}، وحدات ${p._count.units}، بنك معرفة ${p._count.knowledgeItems}، أسئلة ${p._count.questionBankItems}، واجبات ${p._count.assignments}، امتحانات ${p._count.programExams}، ملتحقون ${p._count.enrollments}`,
    `   الكتب المسجلة حرفياً:\n      ${books}`,
    units ? `   الوحدات: ${units}` : null,
    assignments ? `   الواجبات: ${assignments}` : null,
    programExams ? `   الامتحانات: ${programExams}` : null,
  ].filter(Boolean).join('\n')
}

async function buildAdminSnapshot(query?: string | null): Promise<string> {
  try {
    const [users, admissions, programs, payments, theses, exams, programCatalog] = await Promise.all([
      db.user.groupBy({ by: ['role'], _count: { _all: true } }).catch(() => []),
      db.admissionApplication.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
      db.program.count({ where: { active: true } }).catch(() => 0),
      db.payment.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }).catch(() => []),
      db.thesisSubmission.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
      db.programExam.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
      db.program.findMany({
        orderBy: [{ active: 'desc' }, { order: 'asc' }, { titleAr: 'asc' }],
        take: 120,
        select: {
          titleAr: true,
          titleEn: true,
          category: true,
          active: true,
          hours: true,
          price: true,
          description: true,
          academicReadinessStatus: true,
          registrationStatus: true,
          books: { orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], take: 20, select: { title: true, titleEn: true, author: true, semester: true, description: true } },
          units: { orderBy: [{ semester: 'asc' }, { order: 'asc' }], take: 12, select: { title: true, semester: true, status: true, summary: true } },
          assignments: { where: { status: 'PUBLISHED' }, orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }], take: 8, select: { title: true, type: true, semester: true, points: true } },
          programExams: { orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }], take: 8, select: { title: true, semester: true, status: true, passScore: true, booksUsed: true } },
          _count: { select: { books: true, units: true, knowledgeItems: true, questionBankItems: true, assignments: true, programExams: true, enrollments: true } },
        },
      }).catch(() => []),
    ])

    const scored = (programCatalog as any[])
      .map((program) => ({ program, score: scoreCatalogProgram(program, query) }))
      .sort((a, b) => (b.score - a.score) || Number(b.program.active) - Number(a.program.active) || a.program.titleAr.localeCompare(b.program.titleAr, 'ar'))
    const focused = scored.filter((item) => item.score > 0).slice(0, 8)
    const general = scored.slice(0, 45).map((item) => item.program)

    const focusedLines = focused.map((item, index) => `مطابقة ${index + 1} — درجة المطابقة ${item.score}\n${formatAdminProgramLine(item.program, index)}`)
    const generalLines = general.map((p, i) => formatAdminProgramLine(p, i))

    return [
      `مؤشرات إدارية مختصرة: البرامج النشطة ${programs}.`,
      `المستخدمون حسب الدور: ${users.map((x: any) => `${x.role}: ${x._count._all}`).join(' | ') || 'غير متاح'}.`,
      `طلبات القبول: ${admissions.map((x: any) => `${x.status}: ${x._count._all}`).join(' | ') || 'غير متاح'}.`,
      `المدفوعات: ${payments.map((x: any) => `${x.status}: ${x._count._all} / ${x._sum.amount || 0} دولار`).join(' | ') || 'غير متاح'}.`,
      `الأبحاث: ${theses.map((x: any) => `${x.status}: ${x._count._all}`).join(' | ') || 'غير متاح'}.`,
      `الامتحانات: ${exams.map((x: any) => `${x.status}: ${x._count._all}`).join(' | ') || 'غير متاح'}.`,
      focusedLines.length
        ? `برامج مطابقة مباشرة لسؤال الإدارة الحالي: "${compactText(query, 180)}". عند السؤال عن الكتب/المنهاج ابدأ بهذه المطابقات واذكر الكتب حرفياً:\n${focusedLines.join('\n\n')}`
        : `لم أجد مطابقة قوية مباشرة لسؤال الإدارة الحالي: "${compactText(query, 180)}". استخدم الفهرس العام أدناه ولا تخترع كتباً.`,
      generalLines.length ? `فهرس إداري عام من قاعدة بيانات المنصة — إذا ظهرت كتب هنا فهي المصدر الرسمي:\n${generalLines.join('\n\n')}` : '',
    ].filter(Boolean).join('\n\n')
  } catch (error: any) {
    console.error('admin platform snapshot error:', String(error?.message || error).slice(0, 400))
    return ''
  }
}

async function buildAcademicProgramCatalogSnapshot(query?: string | null): Promise<string> {
  const centralCatalog = await buildScopedProgramCatalogSnapshot({ scope: 'HUMAN_SUPERVISOR', query }).catch(() => '')
  if (centralCatalog) return centralCatalog
  try {
    const programCatalog = await db.program.findMany({
      where: { active: true },
      orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
      take: 120,
      select: {
        titleAr: true,
        titleEn: true,
        category: true,
        active: true,
        hours: true,
        price: true,
        description: true,
        academicReadinessStatus: true,
        registrationStatus: true,
        books: { orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], take: 20, select: { title: true, titleEn: true, author: true, semester: true, description: true } },
        units: { orderBy: [{ semester: 'asc' }, { order: 'asc' }], take: 12, select: { title: true, semester: true, status: true, summary: true } },
        assignments: { where: { status: 'PUBLISHED' }, orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }], take: 8, select: { title: true, type: true, semester: true, points: true } },
        programExams: { orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }], take: 8, select: { title: true, semester: true, status: true, passScore: true, booksUsed: true } },
        _count: { select: { books: true, units: true, knowledgeItems: true, questionBankItems: true, assignments: true, programExams: true, enrollments: true } },
      },
    }).catch(() => [])

    if (!programCatalog.length) return ''
    const scored = (programCatalog as any[])
      .map((program) => ({ program, score: scoreCatalogProgram(program, query) }))
      .sort((a, b) => (b.score - a.score) || String(a.program.category || '').localeCompare(String(b.program.category || ''), 'ar') || String(a.program.titleAr || '').localeCompare(String(b.program.titleAr || ''), 'ar'))
    const focused = scored.filter((item) => item.score > 0).slice(0, 10)
    const general = scored.slice(0, 28).map((item) => item.program)
    const focusedLines = focused.map((item, index) => `مطابقة ${index + 1} — درجة المطابقة ${item.score}\n${formatAdminProgramLine(item.program, index)}`)
    const generalLines = general.map((p, i) => formatAdminProgramLine(p, i))
    return [
      'فهرس أكاديمي رسمي من قاعدة بيانات المنصة للبرامج النشطة والكتب والوحدات. عند سؤال المشرف عن كتب/تخصصات/منهاج برنامج، ابدأ من هذا الفهرس واذكر أسماء الكتب المسجلة حرفياً ولا تخترع كتباً.',
      focusedLines.length ? `مطابقات مباشرة للسؤال الحالي "${compactText(query, 180)}":\n${focusedLines.join('\n\n')}` : '',
      generalLines.length ? `فهرس عام للبرامج النشطة:\n${generalLines.join('\n\n')}` : '',
    ].filter(Boolean).join('\n\n').slice(0, 30000)
  } catch (error: any) {
    console.error('academic catalog snapshot error:', String(error?.message || error).slice(0, 400))
    return ''
  }
}

async function buildUserSnapshot(userId: string, agent: PlatformAgentKind, query?: string | null): Promise<string> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, phone: true, country: true, createdAt: true },
  }).catch(() => null)
  if (!user) return ''

  const base = `المستخدم الحالي: ${user.name} — الدور ${user.role} — البريد ${user.email}${user.country ? ` — الدولة ${user.country}` : ''}.`
  const blocks = [base]

  const userScope = resolveAiKnowledgeScope({ role: user.role })
  if (user.role === 'ADMIN') {
    blocks.push(await buildAdminSnapshot(query))
    blocks.push(await buildScopedProgramCatalogSnapshot({ scope: userScope, query }).catch(() => ''))
  }
  if (user.role === 'SUPERVISOR') {
    blocks.push(await buildHumanSupervisorAssignedStudentsContext(user.id, query).catch(() => ''))
    blocks.push(await buildScopedProgramCatalogSnapshot({ scope: userScope, query }).catch(() => ''))
  }

  if (user.role === 'STUDENT') {
    const supervisorContext = await buildSupervisorContext(user.id, { scope: 'STUDENT_SUPERVISOR', query }).catch(() => '')
    if (supervisorContext) blocks.push(supervisorContext)
  }

  return blocks.filter(Boolean).join('\n\n').slice(0, 32000)
}

function buildPlatformAgentSystem(agent: PlatformAgentKind, context: string): string {
  return `أنت "الوكيل الذكي المتكامل" لمنصة ${ACADEMY_INFO.nameAr}.

الشخصية النشطة الآن: ${AGENT_AR[agent]}.
المشرف الذكي الأكاديمي ليس ملغى؛ هو شخصية متخصصة داخلك تستخدمها عند أي سؤال دراسي أو بحثي أو امتحاني.

هويتك التشغيلية:
- أنت مساعد منصة أكاديمية مهنية، وليست منصة دورات عادية.
- تفهم رحلة الطالب كاملة: قبول، برنامج/تخصص، كتب مقررة، بنك معرفة، مشرف ذكي، امتحانات، بحث تخرج، مناقشة، شهادة قابلة للتحقق.
- تجيب حسب صلاحية المستخدم: الطالب يرى ملفه فقط، المشرف يرى طلابه فقط، الإدارة ترى المؤشرات العامة والإدارية وتفاصيل البرامج والمناهج.
- لا تخترع قرارات إدارية أو مالية. إذا احتاج الأمر اعتماداً بشرياً، قل إن القرار النهائي للإدارة.
- إذا سُئلت عن تنفيذ عملية لم تُعطَ لك أداة مباشرة لها، اشرح الخطوات داخل المنصة ولا تدّعِ أنك نفذتها.
- إذا طلب المستخدم موظفاً حقيقياً أو الإدارة أو رقماً للتواصل أو واتساب بشري، أعطه مباشرة وبأسلوب ترحيبي الأرقام: +972594403737 و +970 598 400 510، ولا تطلب منه إعادة صياغة الطلب.

توجيه الشخصيات وعدم خلط الأدوار:
- القبول: اشرح حالة الطلب، المرفقات، الرسوم، وخطوة الاستكمال. لا تجب كعضو لجنة مناقشة.
- المشرف الأكاديمي: اشرح الكتب والمنهج ونقاط الضعف وخطة الدراسة من ملف الطالب. لا تستبدل ملف الطالب بكتالوج عام.
- الامتحانات: اربط التقييم بالكتاب وبنك المعرفة ومخرجات التعلم، ولا تكشف إجابات امتحان لم يُسلَّم.
- البحث والمناقشة: ناقش المنهجية والنتائج والحدود والتوصيات، واسأل أسئلة لجنة مرتبطة بعنوان البحث وسياقه لا أسئلة قبول عامة.
- الإدارة والجودة: لخّص المؤشرات والمخاطر التشغيلية واقترح إجراءات.
- الشهادات: اشرح رقم الشهادة، QR، السجل الأكاديمي، والتحقق.
- الوكالة والاعتماد: اشرح الطلبات والعقود والإلغاء والضوابط.
- إذا كان السياق يحتوي ملف طالب أو بحثاً أو كتباً، ابدأ منه حرفياً قبل أي معلومات عامة.

معلومات رسمية ثابتة:
- البريد: ${ACADEMY_INFO.email} — واتساب: ${ACADEMY_INFO.whatsapp}.
- رسوم تقديم القبول: ${ADMISSION_FEES.applicationFee} دولار غير مستردة.
- شروط القبول: ${ADMISSION_GUIDE.conditions.join(' / ')}.
- الوثائق المطلوبة: ${ADMISSION_GUIDE.documents.join(' / ')}.
- الاعتماد: رسوم تقديم طلب الاعتماد ${ACCREDITATION_GUIDE.applicationFee} دولار غير مستردة.

كتالوج مختصر للبرامج:
${staticProgramsDigest()}

قواعد الإجابة:
- اكتب بالعربية الواضحة المناسبة للهجات المستخدم.
- كن مباشراً ومهنياً؛ لا تطل إلا إذا طلب المستخدم التفصيل.
- لا تعرض أكواد داخلية أو أسماء حقول برمجية للمستخدم.
- عند عدم اليقين قل ذلك ووجّه المستخدم للوحة/القسم الصحيح.
- إذا كان المستخدم إدارة وسأل عن كتب/منهاج/وحدات برنامج معين، استخدم أولاً قسم "برامج مطابقة مباشرة لسؤال الإدارة الحالي" في السياق، واذكر أسماء الكتب المسجلة حرفياً. لا تجب بإجابة عامة عن "المعادلة والخبرة" إذا كانت أسماء الكتب موجودة.
- إذا كان المستخدم مشرفاً بشرياً وسأل عن كتب/تخصصات/منهاج برنامج، استخدم أولاً "فهرس أكاديمي رسمي من قاعدة بيانات المنصة" في السياق، واذكر الكتب والوحدات المسجلة حرفياً قبل أي شرح عام.
- إذا لم تجد كتباً في البرنامج المطابق، قل: "لا توجد كتب مسجلة لهذا البرنامج في قاعدة البيانات" ولا تعمم على بقية البرامج.
- إذا سأل زائر واتساب أو الويب عن "برامجكم" أو "البرامج بشكل عام"، فابدأ بعرض تصنيفات البرامج والأمثلة المتاحة من الكتالوج المختصر، ثم اسأله أي مسار يناسبه. لا ترد بسؤال توضيحي فقط قبل إعطائه ملخص البرامج.
- إذا سأل الطالب عن الكتب أو المراجع أو ما يجب قراءته، فابدأ أولاً بأسماء الكتب المقررة الموجودة في سياق الطالب حرفياً. لا تكتفِ بإجابة عامة عن خطة القراءة إذا كانت أسماء الكتب متاحة.
- إذا ناقش الطالب واجباً أو امتحاناً سلّمه بالفعل، استخدم مراجعة إجاباته المحفوظة ومعيار التصحيح والإجابة الصحيحة/النموذجية لشرح الخطأ ولماذا كانت الإجابة الصحيحة أفضل.
- لا تكشف مفاتيح إجابات الامتحانات الجاهزة التي لم يسلّمها الطالب بعد؛ استخدمها فقط بعد التسليم أو في تلخيص داخلي للمراجعة، ويمكنك بدلاً من ذلك تدريبه بأسئلة مشابهة من الكتب وبنك المعرفة.

سياق آمن من قاعدة بيانات المنصة وصلاحيات المستخدم:
${context || 'لا يوجد سياق إضافي متاح.'}`
}

function annotateReply(agent: PlatformAgentKind, text: string, engine: string): string {
  const clean = String(text || '').trim()
  if (!clean) return clean
  return clean
}

function buildPublicVisitorContext(channel?: string) {
  return [
    `نوع المستخدم: زائر عام من ${channel === 'WHATSAPP' ? 'واتساب' : 'زر واتساب الذكي داخل الموقع'}.`,
    'لا يوجد تسجيل دخول أو ملف طالب خاص في هذا السياق؛ أجب من معلومات المنصة العامة فقط.',
    'لا تطلب من المستخدم إرسال مستندات أو معلومات حساسة داخل الدردشة العامة؛ وجّهه إلى نموذج طلب الالتحاق أو الإدارة عند الحاجة.',
    `رقم واتساب الأكاديمية الرسمي: ${ACADEMY_INFO.whatsappDisplay || ACADEMY_INFO.whatsapp}.`,
  ].join('\n')
}

async function auditAiKnowledgeDiagnostics(args: {
  actorId?: string | null
  actorName: string
  diagnostics: any
  entityId?: string | null
}) {
  await db.auditLog.create({
    data: {
      actorId: args.actorId || null,
      actorName: args.actorName,
      action: 'AI_KNOWLEDGE_DIAGNOSTICS',
      entity: 'AIKnowledge',
      entityId: args.entityId || null,
      details: JSON.stringify(args.diagnostics).slice(0, 3900),
    },
  }).catch(() => {})
}

export async function platformPublicAgentComplete(opts: {
  messages: { role: string; content: string }[]
  channel?: 'WEB_WIDGET' | 'WHATSAPP' | string
  uiContext?: string
}): Promise<{ reply: string; agent: PlatformAgentKind; engine: PlatformAgentEngine }> {
  const last = [...opts.messages].reverse().find((m) => m.role === 'user')?.content || ''
  const intentAnalysis = await analyzeConversationIntent(opts.messages, { channel: opts.channel, role: 'PUBLIC' })
  if (intentAnalysis.intent === 'HUMAN_HANDOFF' && intentAnalysis.confidence >= 0.58) return { reply: HUMAN_SUPPORT_REPLY, agent: 'SUPPORT', engine: 'GEMINI' }
  if (intentAnalysis.intent !== 'HUMAN_HANDOFF' && wantsHumanSupport(last)) return { reply: HUMAN_SUPPORT_REPLY, agent: 'SUPPORT', engine: 'LOCAL_RULE' }
  if (intentAnalysis.intent === 'PAYMENT_METHODS' && intentAnalysis.confidence >= 0.55) return { reply: await buildDynamicPaymentMethodsReply(), agent: 'ADMISSIONS', engine: 'GEMINI' }
  if (wantsPaymentMethodsInfo(last)) return { reply: await buildDynamicPaymentMethodsReply(), agent: 'ADMISSIONS', engine: 'LOCAL_RULE' }
  const publicScope = resolveAiKnowledgeScope({ channel: opts.channel, role: 'PUBLIC' })
  const directBooksResult = await buildScopedDirectProgramBooksResult(last, publicScope).catch(() => null)
  if (directBooksResult?.diagnostics && directBooksResult.diagnostics.reason !== 'query_not_program_books') {
    await auditAiKnowledgeDiagnostics({
      actorName: opts.channel === 'WHATSAPP' ? 'زائر واتساب' : 'زائر عام',
      entityId: opts.channel || 'PUBLIC',
      diagnostics: { ...directBooksResult.diagnostics, channel: opts.channel || 'WEB_WIDGET' },
    })
  }
  if (directBooksResult?.reply) return { reply: directBooksResult.reply, agent: 'ADMISSIONS', engine: 'LOCAL_RULE' }
  const agent = intentAnalysis.suggestedAgent || routeAgent(last, null)
  const persona = personaForAgent(agent)
  const centralCatalogSnapshot = await buildScopedProgramCatalogSnapshot({ scope: publicScope, query: last }).catch(() => '')
  const legacyPlatformSnapshot = await buildPublicPlatformSnapshot(last)
  const platformSnapshot = mergeContext(centralCatalogSnapshot, legacyPlatformSnapshot)
  const baseContext = mergeContext(buildPublicVisitorContext(opts.channel), platformSnapshot)
  const context = mergeContext(mergeContext(baseContext, conversationStyleContext(intentAnalysis, opts.channel)), opts.uiContext)
  const system = buildPlatformAgentSystem(agent, context)
  const isWhatsApp = opts.channel === 'WHATSAPP'
  const timeoutMs = platformAiTimeoutMs(isWhatsApp ? 52_000 : 22_000)

  const runGemini = async () => {
    const geminiReady = await ensureGeminiKey().catch(() => false)
    if (!geminiReady) return null
    const model = await geminiActiveTextModel().catch(() => 'unknown')
    const started = Date.now()
    try {
      const reply = await withPlatformTimeout(geminiComplete({
        system,
        history: opts.messages.slice(-12).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'model' as const, text: m.content })),
        temperature: 0.35,
        maxOutputTokens: isWhatsApp ? 900 : 1100,
      }), timeoutMs, 'Gemini public platform agent timed out')
      logPlatformProviderAttempt({ ok: true, provider: 'GEMINI_DIRECT', model, agent, ms: Date.now() - started })
      return { reply: annotateReply(agent, reply, 'GEMINI'), agent, engine: 'GEMINI' as const }
    } catch (e: any) {
      logPlatformProviderAttempt({ ok: false, provider: 'GEMINI_DIRECT', model, agent, ms: Date.now() - started, status: providerStatusFromError(e), error: String(e?.message || e) })
      throw e
    }
  }

  if (isWhatsApp) {
    try {
      const geminiReply = await runGemini()
      if (geminiReply) return geminiReply
    } catch (e: any) {
      console.error('Gemini public WhatsApp agent failed:', String(e?.message || e).slice(0, 400))
    }
  }

  const localCfg = await localAgentConfig().catch(() => null)
  if (localCfg?.enabled) {
    try {
      const reply = await withPlatformTimeout(localChatComplete({
        messages: [
          { role: 'system', content: system },
          ...opts.messages.slice(-12).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.content })),
        ],
        temperature: 0.35,
        maxTokens: isWhatsApp ? 900 : 1100,
      }), timeoutMs, 'Local public platform agent timed out')
      return { reply: annotateReply(agent, reply, 'LOCAL_OPEN_SOURCE'), agent, engine: 'LOCAL_OPEN_SOURCE' }
    } catch (e: any) {
      console.error('Local public platform agent failed:', String(e?.message || e).slice(0, 400))
    }
  }

  if (!isWhatsApp) {
    try {
      const geminiReply = await runGemini()
      if (geminiReply) return geminiReply
    } catch (e: any) {
      console.error('Gemini public platform agent failed:', String(e?.message || e).slice(0, 400))
    }
  }

  const reply = await chatComplete(opts.messages, context, persona, { skipGemini: true, timeoutMs })
  return { reply: annotateReply(agent, reply, 'MODEL_ROUTER_OR_FALLBACK'), agent, engine: 'MODEL_ROUTER_OR_FALLBACK' }
}

export async function platformAgentComplete(opts: {
  userId: string
  messages: { role: string; content: string }[]
  uiContext?: string
  mode?: 'TEXT' | 'VOICE' | string
}): Promise<{ reply: string; agent: PlatformAgentKind; engine: PlatformAgentEngine }> {
  const last = [...opts.messages].reverse().find((m) => m.role === 'user')?.content || ''
  const user = await db.user.findUnique({ where: { id: opts.userId }, select: { role: true } }).catch(() => null)
  if (user?.role === 'ADMIN' || user?.role === 'SUPERVISOR') {
    const scope = resolveAiKnowledgeScope({ role: user.role, mode: opts.mode })
    const directBooksResult = await buildScopedDirectProgramBooksResult(last, scope).catch(() => null)
    if (directBooksResult?.diagnostics && directBooksResult.diagnostics.reason !== 'query_not_program_books') {
      await auditAiKnowledgeDiagnostics({
        actorId: opts.userId,
        actorName: user.role === 'ADMIN' ? 'إدارة النظام' : 'مشرف بشري',
        entityId: opts.userId,
        diagnostics: { ...directBooksResult.diagnostics, role: user.role, mode: opts.mode || 'TEXT' },
      })
    }
    const directBooksReply = directBooksResult?.reply || await buildDirectProgramBooksReply(last).catch(() => null)
    if (directBooksReply) return { reply: directBooksReply, agent: 'ADMIN_QUALITY', engine: 'LOCAL_RULE' }
  }
  const intentAnalysis = await analyzeConversationIntent(opts.messages, { channel: opts.mode || 'WEB', role: user?.role })
  if (intentAnalysis.intent === 'HUMAN_HANDOFF' && intentAnalysis.confidence >= 0.58) return { reply: HUMAN_SUPPORT_REPLY, agent: 'SUPPORT', engine: 'GEMINI' }
  if (intentAnalysis.intent !== 'HUMAN_HANDOFF' && wantsHumanSupport(last)) return { reply: HUMAN_SUPPORT_REPLY, agent: 'SUPPORT', engine: 'LOCAL_RULE' }
  if (intentAnalysis.intent === 'PAYMENT_METHODS' && intentAnalysis.confidence >= 0.55) return { reply: await buildDynamicPaymentMethodsReply(), agent: 'ADMISSIONS', engine: 'GEMINI' }
  if (wantsPaymentMethodsInfo(last)) return { reply: await buildDynamicPaymentMethodsReply(), agent: 'ADMISSIONS', engine: 'LOCAL_RULE' }
  const agent = intentAnalysis.suggestedAgent || routeAgent(last, user?.role)
  const persona = personaForAgent(agent)
  const dataContext = await buildUserSnapshot(opts.userId, agent, last)
  const context = mergeContext(mergeContext(dataContext, conversationStyleContext(intentAnalysis, opts.mode)), opts.uiContext)
  const system = buildPlatformAgentSystem(agent, context)
  const timeoutMs = platformAiTimeoutMs(opts.mode === 'VOICE' ? 40_000 : 48_000)
  const shouldPreferGemini = user?.role === 'STUDENT'
    || agent === 'ACADEMIC_SUPERVISOR'
    || agent === 'EXAMS'
    || agent === 'THESIS_DEFENSE'
    || String(opts.uiContext || '').includes('Launch Quality Probe')

  const runGemini = async () => {
    const geminiReady = await ensureGeminiKey().catch(() => false)
    if (!geminiReady) return null
    const model = await geminiActiveTextModel().catch(() => 'unknown')
    const started = Date.now()
    const thinkingLevel: GeminiThinkingLevel | undefined = agent === 'THESIS_DEFENSE'
      ? await geminiDiscussionThinkingLevel().catch(() => 'high' as GeminiThinkingLevel)
      : agent === 'EXAMS' || agent === 'ADMIN_QUALITY'
        ? 'medium'
        : undefined
    try {
      const reply = await withPlatformTimeout(geminiComplete({
        system,
        history: opts.messages.slice(-18).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'model' as const, text: m.content })),
        temperature: agent === 'ADMIN_QUALITY' ? 0.25 : 0.4,
        thinkingLevel,
        maxOutputTokens: opts.mode === 'VOICE' ? 1100 : 1800,
      }), timeoutMs, 'Gemini platform agent timed out')
      logPlatformProviderAttempt({ ok: true, provider: 'GEMINI_DIRECT', model, agent, ms: Date.now() - started })
      return { reply: annotateReply(agent, reply, 'GEMINI'), agent, engine: 'GEMINI' as const }
    } catch (e: any) {
      logPlatformProviderAttempt({ ok: false, provider: 'GEMINI_DIRECT', model, agent, ms: Date.now() - started, status: providerStatusFromError(e), error: String(e?.message || e) })
      throw e
    }
  }

  if (shouldPreferGemini) {
    try {
      const geminiReply = await runGemini()
      if (geminiReply) return geminiReply
    } catch (e: any) {
      console.error('Gemini preferred platform agent failed:', String(e?.message || e).slice(0, 400))
    }
  }

  const localCfg = await localAgentConfig().catch(() => null)
  if (localCfg?.enabled) {
    try {
      const reply = await withPlatformTimeout(localChatComplete({
        messages: [
          { role: 'system', content: system },
          ...opts.messages.slice(-18).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.content })),
        ],
        temperature: agent === 'ADMIN_QUALITY' ? 0.2 : 0.35,
        maxTokens: opts.mode === 'VOICE' ? 1100 : 1800,
      }), timeoutMs, 'Local platform agent timed out')
      return { reply: annotateReply(agent, reply, 'LOCAL_OPEN_SOURCE'), agent, engine: 'LOCAL_OPEN_SOURCE' }
    } catch (e: any) {
      console.error('Local platform agent failed:', String(e?.message || e).slice(0, 400))
    }
  }

  if (!shouldPreferGemini) {
    try {
      const geminiReply = await runGemini()
      if (geminiReply) return geminiReply
    } catch (e: any) {
      console.error('Gemini platform agent failed:', String(e?.message || e).slice(0, 400))
    }
  }

  const reply = await chatComplete(opts.messages, context, persona, {
    skipGemini: true,
    timeoutMs,
    requireModelResponse: shouldPreferGemini,
  })
  return { reply: annotateReply(agent, reply, 'MODEL_ROUTER_OR_FALLBACK'), agent, engine: 'MODEL_ROUTER_OR_FALLBACK' }
}
