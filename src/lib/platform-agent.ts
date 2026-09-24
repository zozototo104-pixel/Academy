import { db } from '@/lib/db'
import { ACADEMY_INFO, ADMISSION_FEES, ADMISSION_GUIDE, ACCREDITATION_GUIDE, allSeedPrograms } from '@/lib/academyData'
import { chatComplete, type SupervisorPersona } from '@/lib/ai'
import { buildSupervisorContext, mergeContext } from '@/lib/supervisor-ai'
import { localAgentConfig, localChatComplete } from '@/lib/open-source-llm'
import { ensureGeminiKey, geminiComplete, geminiDiscussionThinkingLevel, type GeminiThinkingLevel } from '@/lib/gemini'

export type PlatformAgentKind =
  | 'ACADEMIC_SUPERVISOR'
  | 'ADMISSIONS'
  | 'EXAMS'
  | 'THESIS_DEFENSE'
  | 'CERTIFICATES'
  | 'ADMIN_QUALITY'
  | 'AGENCY_ACCREDITATION'
  | 'SUPPORT'

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

function routeAgent(message: string, role?: string | null): PlatformAgentKind {
  const n = normalizeArabic(message)
  if (role === 'ADMIN' && includesAny(n, ['احصائيات', 'تقرير', 'جودة', 'طلاب', 'طالب', 'طلبات', 'قبول', 'مدفوعات', 'اشراف', 'مشرفين', 'متعثرين', 'اعتراضات', 'لوحة', 'مؤشرات'])) return 'ADMIN_QUALITY'
  if (role === 'SUPERVISOR' && includesAny(n, ['طلابي', 'طلاب', 'طالب', 'بحث', 'ابحاث', 'مناقشة', 'منهجيه', 'متابعة', 'متعثر'])) return 'THESIS_DEFENSE'
  if (includesAny(n, ['قبول', 'التحاق', 'تسجيل', 'مرفقات', 'وثائق', 'طلب', 'دفع رسوم التقديم', 'استكمال'])) return 'ADMISSIONS'
  if (includesAny(n, ['امتحان', 'اختبار', 'سؤال', 'اسئلة', 'تصحيح', 'درجة', 'اعتراض', 'قياس', 'تقويم'])) return 'EXAMS'
  if (includesAny(n, ['بحث', 'رسالة', 'اطروحة', 'مشروع تخرج', 'مناقشة', 'لجنة', 'منهجية', 'نتائج'])) return 'THESIS_DEFENSE'
  if (includesAny(n, ['شهادة', 'شهادتي', 'تحقق', 'qr', 'سجل اكاديمي', 'رقم شهادة'])) return 'CERTIFICATES'
  if (includesAny(n, ['وكالة', 'وكيل', 'اعتماد', 'جهة اعتماد', 'مدرب معتمد', 'مستشار معتمد'])) return 'AGENCY_ACCREDITATION'
  if (includesAny(n, ['كتاب', 'كتب', 'منهج', 'دراسة', 'اشرح', 'مفهوم', 'واجب', 'محاضرة', 'تخصصي', 'برنامجي'])) return 'ACADEMIC_SUPERVISOR'
  return role === 'STUDENT' ? 'ACADEMIC_SUPERVISOR' : 'SUPPORT'
}

function personaForAgent(agent: PlatformAgentKind): SupervisorPersona {
  if (agent === 'EXAMS') return 'EXAM'
  if (agent === 'THESIS_DEFENSE') return 'DEFENSE'
  return 'CHAT'
}

function staticProgramsDigest(max = 40): string {
  return allSeedPrograms.slice(0, max).map((p, i) => {
    const fee = p.price ? ` — رسوم تقريبية ${p.price}$` : ''
    const hours = p.hours ? ` — ${p.hours} ساعة` : ''
    return `${i + 1}. ${p.titleAr}${p.titleEn ? ` (${p.titleEn})` : ''} — ${p.category}${hours}${fee}`
  }).join('\n')
}

async function buildAdminSnapshot(): Promise<string> {
  try {
    const [users, admissions, programs, payments, theses, exams] = await Promise.all([
      db.user.groupBy({ by: ['role'], _count: { _all: true } }).catch(() => []),
      db.admissionApplication.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
      db.program.count({ where: { active: true } }).catch(() => 0),
      db.payment.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }).catch(() => []),
      db.thesisSubmission.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
      db.programExam.groupBy({ by: ['status'], _count: { _all: true } }).catch(() => []),
    ])
    return [
      `مؤشرات إدارية مختصرة: البرامج النشطة ${programs}.`,
      `المستخدمون حسب الدور: ${users.map((x: any) => `${x.role}: ${x._count._all}`).join(' | ') || 'غير متاح'}.`,
      `طلبات القبول: ${admissions.map((x: any) => `${x.status}: ${x._count._all}`).join(' | ') || 'غير متاح'}.`,
      `المدفوعات: ${payments.map((x: any) => `${x.status}: ${x._count._all} / ${x._sum.amount || 0}$`).join(' | ') || 'غير متاح'}.`,
      `الأبحاث: ${theses.map((x: any) => `${x.status}: ${x._count._all}`).join(' | ') || 'غير متاح'}.`,
      `الامتحانات: ${exams.map((x: any) => `${x.status}: ${x._count._all}`).join(' | ') || 'غير متاح'}.`,
    ].join('\n')
  } catch {
    return ''
  }
}

async function buildSupervisorSnapshot(userId: string): Promise<string> {
  try {
    const rows = await db.admissionApplication.findMany({
      where: { supervisorId: userId },
      orderBy: [{ supervisorAt: 'desc' }, { createdAt: 'desc' }],
      take: 25,
      select: {
        reference: true,
        fullName: true,
        program: true,
        status: true,
        thesisDeadline: true,
        theses: { orderBy: { updatedAt: 'desc' }, take: 3, select: { title: true, status: true, updatedAt: true } },
      },
    })
    if (!rows.length) return 'لا يوجد طلاب معيّنون لهذا المشرف حالياً.'
    return `طلاب المشرف البشري المعيّنون له:\n${rows.map((r) => `- ${r.fullName} (${r.reference}) — ${r.program} — ${r.status}${r.thesisDeadline ? ` — مهلة البحث ${new Date(r.thesisDeadline).toLocaleDateString('ar-EG')}` : ''}${r.theses.length ? ` — أبحاث: ${r.theses.map((t) => `${t.title}/${t.status}`).join(' | ')}` : ''}`).join('\n')}`
  } catch {
    return ''
  }
}

async function buildUserSnapshot(userId: string, agent: PlatformAgentKind): Promise<string> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, phone: true, country: true, createdAt: true },
  }).catch(() => null)
  if (!user) return ''

  const base = `المستخدم الحالي: ${user.name} — الدور ${user.role} — البريد ${user.email}${user.country ? ` — الدولة ${user.country}` : ''}.`
  const blocks = [base]

  if (user.role === 'ADMIN') blocks.push(await buildAdminSnapshot())
  if (user.role === 'SUPERVISOR') blocks.push(await buildSupervisorSnapshot(user.id))

  if (user.role === 'STUDENT' || agent === 'ACADEMIC_SUPERVISOR' || agent === 'ADMISSIONS' || agent === 'EXAMS' || agent === 'THESIS_DEFENSE') {
    const supervisorContext = await buildSupervisorContext(user.id).catch(() => '')
    if (supervisorContext) blocks.push(supervisorContext)
  }

  return blocks.filter(Boolean).join('\n\n').slice(0, 18000)
}

function buildPlatformAgentSystem(agent: PlatformAgentKind, context: string): string {
  return `أنت "الوكيل الذكي المتكامل" لمنصة ${ACADEMY_INFO.nameAr}.

الشخصية النشطة الآن: ${AGENT_AR[agent]}.
المشرف الذكي الأكاديمي ليس ملغى؛ هو شخصية متخصصة داخلك تستخدمها عند أي سؤال دراسي أو بحثي أو امتحاني.

هويتك التشغيلية:
- أنت مساعد منصة أكاديمية مهنية، وليست منصة دورات عادية.
- تفهم رحلة الطالب كاملة: قبول، برنامج/تخصص، كتب مقررة، بنك معرفة، مشرف ذكي، امتحانات، بحث تخرج، مناقشة، شهادة قابلة للتحقق.
- تجيب حسب صلاحية المستخدم: الطالب يرى ملفه فقط، المشرف يرى طلابه فقط، الإدارة ترى المؤشرات العامة والإدارية.
- لا تخترع قرارات إدارية أو مالية. إذا احتاج الأمر اعتماداً بشرياً، قل إن القرار النهائي للإدارة.
- إذا سُئلت عن تنفيذ عملية لم تُعطَ لك أداة مباشرة لها، اشرح الخطوات داخل المنصة ولا تدّعِ أنك نفذتها.

توجيه الشخصيات:
- القبول: اشرح حالة الطلب، المرفقات، الرسوم، وخطوة الاستكمال.
- المشرف الأكاديمي: اشرح الكتب والمنهج ونقاط الضعف وخطة الدراسة.
- الامتحانات: اربط التقييم بالكتاب وبنك المعرفة ومخرجات التعلم.
- البحث والمناقشة: ناقش المنهجية والنتائج والحدود والتوصيات.
- الإدارة والجودة: لخّص المؤشرات والمخاطر التشغيلية واقترح إجراءات.
- الشهادات: اشرح رقم الشهادة، QR، السجل الأكاديمي، والتحقق.
- الوكالة والاعتماد: اشرح الطلبات والعقود والإلغاء والضوابط.

معلومات رسمية ثابتة:
- البريد: ${ACADEMY_INFO.email} — واتساب: ${ACADEMY_INFO.whatsapp}.
- رسوم تقديم القبول: ${ADMISSION_FEES.applicationFee}$ غير مستردة.
- شروط القبول: ${ADMISSION_GUIDE.conditions.join(' / ')}.
- الوثائق المطلوبة: ${ADMISSION_GUIDE.documents.join(' / ')}.
- الاعتماد: رسوم تقديم طلب الاعتماد ${ACCREDITATION_GUIDE.applicationFee}$ غير مستردة.

كتالوج مختصر للبرامج:
${staticProgramsDigest()}

قواعد الإجابة:
- اكتب بالعربية الواضحة المناسبة للهجات المستخدم.
- كن مباشراً ومهنياً؛ لا تطل إلا إذا طلب المستخدم التفصيل.
- لا تعرض أكواد داخلية أو أسماء حقول برمجية للمستخدم.
- عند عدم اليقين قل ذلك ووجّه المستخدم للوحة/القسم الصحيح.
- إذا سأل الطالب عن الكتب أو المراجع أو ما يجب قراءته، فابدأ أولاً بأسماء الكتب المقررة الموجودة في سياق الطالب حرفياً. لا تكتفِ بإجابة عامة عن خطة القراءة إذا كانت أسماء الكتب متاحة.

سياق آمن من قاعدة بيانات المنصة وصلاحيات المستخدم:
${context || 'لا يوجد سياق إضافي متاح.'}`
}

function annotateReply(agent: PlatformAgentKind, text: string, engine: string): string {
  const clean = String(text || '').trim()
  if (!clean) return clean
  // لا نثقل الطالب بتفاصيل تقنية، لكن نترك إشارة خفيفة عند سؤال القدرات أو عند الإدارة فقط من خلال النص نفسه إذا لزم.
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

export async function platformPublicAgentComplete(opts: {
  messages: { role: string; content: string }[]
  channel?: 'WEB_WIDGET' | 'WHATSAPP' | string
  uiContext?: string
}): Promise<{ reply: string; agent: PlatformAgentKind; engine: 'LOCAL_OPEN_SOURCE' | 'GEMINI_OR_FALLBACK' }> {
  const last = [...opts.messages].reverse().find((m) => m.role === 'user')?.content || ''
  const agent = routeAgent(last, null)
  const persona = personaForAgent(agent)
  const context = mergeContext(buildPublicVisitorContext(opts.channel), opts.uiContext)
  const system = buildPlatformAgentSystem(agent, context)

  const localCfg = await localAgentConfig().catch(() => null)
  if (localCfg?.enabled) {
    try {
      const reply = await localChatComplete({
        messages: [
          { role: 'system', content: system },
          ...opts.messages.slice(-12).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.content })),
        ],
        temperature: 0.35,
        maxTokens: opts.channel === 'WHATSAPP' ? 650 : 1100,
      })
      return { reply: annotateReply(agent, reply, 'LOCAL_OPEN_SOURCE'), agent, engine: 'LOCAL_OPEN_SOURCE' }
    } catch (e: any) {
      console.error('Local public platform agent failed:', String(e?.message || e).slice(0, 400))
    }
  }

  const geminiReady = await ensureGeminiKey().catch(() => false)
  if (geminiReady) {
    try {
      const reply = await geminiComplete({
        system,
        history: opts.messages.slice(-12).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'model' as const, text: m.content })),
        temperature: 0.35,
        maxOutputTokens: opts.channel === 'WHATSAPP' ? 650 : 1100,
      })
      return { reply: annotateReply(agent, reply, 'GEMINI_OR_FALLBACK'), agent, engine: 'GEMINI_OR_FALLBACK' }
    } catch (e: any) {
      console.error('Gemini public platform agent failed:', String(e?.message || e).slice(0, 400))
    }
  }

  const reply = await chatComplete(opts.messages, context, persona)
  return { reply: annotateReply(agent, reply, 'GEMINI_OR_FALLBACK'), agent, engine: 'GEMINI_OR_FALLBACK' }
}

export async function platformAgentComplete(opts: {
  userId: string
  messages: { role: string; content: string }[]
  uiContext?: string
  mode?: 'TEXT' | 'VOICE' | string
}): Promise<{ reply: string; agent: PlatformAgentKind; engine: 'LOCAL_OPEN_SOURCE' | 'GEMINI_OR_FALLBACK' }> {
  const last = [...opts.messages].reverse().find((m) => m.role === 'user')?.content || ''
  const user = await db.user.findUnique({ where: { id: opts.userId }, select: { role: true } }).catch(() => null)
  const agent = routeAgent(last, user?.role)
  const persona = personaForAgent(agent)
  const dataContext = await buildUserSnapshot(opts.userId, agent)
  const context = mergeContext(dataContext, opts.uiContext)
  const system = buildPlatformAgentSystem(agent, context)

  const localCfg = await localAgentConfig().catch(() => null)
  if (localCfg?.enabled) {
    try {
      const reply = await localChatComplete({
        messages: [
          { role: 'system', content: system },
          ...opts.messages.slice(-18).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'assistant' as const, content: m.content })),
        ],
        temperature: agent === 'ADMIN_QUALITY' ? 0.2 : 0.35,
        maxTokens: opts.mode === 'VOICE' ? 900 : 1700,
      })
      return { reply: annotateReply(agent, reply, 'LOCAL_OPEN_SOURCE'), agent, engine: 'LOCAL_OPEN_SOURCE' }
    } catch (e: any) {
      console.error('Local platform agent failed:', String(e?.message || e).slice(0, 400))
    }
  }

  const geminiReady = await ensureGeminiKey().catch(() => false)
  if (geminiReady) {
    try {
      const thinkingLevel: GeminiThinkingLevel | undefined = agent === 'THESIS_DEFENSE'
        ? await geminiDiscussionThinkingLevel().catch(() => 'high' as GeminiThinkingLevel)
        : agent === 'EXAMS' || agent === 'ADMIN_QUALITY'
          ? 'medium'
          : undefined
      const reply = await geminiComplete({
        system,
        history: opts.messages.slice(-18).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'model' as const, text: m.content })),
        temperature: agent === 'ADMIN_QUALITY' ? 0.25 : 0.4,
        thinkingLevel,
        maxOutputTokens: opts.mode === 'VOICE' ? 900 : 1700,
      })
      return { reply: annotateReply(agent, reply, 'GEMINI_OR_FALLBACK'), agent, engine: 'GEMINI_OR_FALLBACK' }
    } catch (e: any) {
      console.error('Gemini platform agent failed:', String(e?.message || e).slice(0, 400))
    }
  }

  // احتياط أخير: نستخدم المشرف الذكي الحالي حتى لا تتوقف الدردشة لو لم يتوفر النموذج المحلي أو Gemini.
  const reply = await chatComplete(opts.messages, context, persona)
  return { reply: annotateReply(agent, reply, 'GEMINI_OR_FALLBACK'), agent, engine: 'GEMINI_OR_FALLBACK' }
}
