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

export type PlatformAgentEngine = 'LOCAL_OPEN_SOURCE' | 'GEMINI' | 'MODEL_ROUTER_OR_FALLBACK'

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

function expandArabicProgramQuery(query?: string | null): string {
  const n = normalizeArabic(query || '')
  const aliases: string[] = [n]

  if (includesAny(n, ['دكتوراه', 'دكتوراة', 'دكتورا', 'الدكتوراه', 'الدكتوراة', 'دكتوراء', 'دكتور'])) {
    aliases.push('الدكتوراه المهنيه دكتوراه مهنيه professional doctorate doctorate phd')
  }
  if (includesAny(n, ['ماجستير', 'مجستير', 'ماستر', 'الماجستير', 'المجستير'])) {
    aliases.push('الماجستير المهني ماجستير مهني master masters')
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

    return [
      'سياق عام من قاعدة بيانات المنصة للزائر. هذا السياق هو المصدر العملي عند أي سؤال عام عن البرامج أو التسجيل أو الكتب أو الرسوم. لا تكتفِ بسؤال توضيحي إذا كان يمكن إعطاء إجابة مفيدة من هذا الفهرس. إذا كان السؤال عن رسوم درجة عامة مثل الدكتوراه المهنية أو الماجستير المهني فاعرض البرامج المطابقة ورسومها المحددة من البيانات بدلاً من إعطاء نطاق عام.',
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

async function buildUserSnapshot(userId: string, agent: PlatformAgentKind, query?: string | null): Promise<string> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, role: true, phone: true, country: true, createdAt: true },
  }).catch(() => null)
  if (!user) return ''

  const base = `المستخدم الحالي: ${user.name} — الدور ${user.role} — البريد ${user.email}${user.country ? ` — الدولة ${user.country}` : ''}.`
  const blocks = [base]

  if (user.role === 'ADMIN') blocks.push(await buildAdminSnapshot(query))
  if (user.role === 'SUPERVISOR') blocks.push(await buildSupervisorSnapshot(user.id))

  if (user.role === 'STUDENT' || agent === 'ACADEMIC_SUPERVISOR' || agent === 'ADMISSIONS' || agent === 'EXAMS' || agent === 'THESIS_DEFENSE') {
    const supervisorContext = await buildSupervisorContext(user.id).catch(() => '')
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

export async function platformPublicAgentComplete(opts: {
  messages: { role: string; content: string }[]
  channel?: 'WEB_WIDGET' | 'WHATSAPP' | string
  uiContext?: string
}): Promise<{ reply: string; agent: PlatformAgentKind; engine: PlatformAgentEngine }> {
  const last = [...opts.messages].reverse().find((m) => m.role === 'user')?.content || ''
  const agent = routeAgent(last, null)
  const persona = personaForAgent(agent)
  const platformSnapshot = await buildPublicPlatformSnapshot(last)
  const baseContext = mergeContext(buildPublicVisitorContext(opts.channel), platformSnapshot)
  const context = mergeContext(baseContext, opts.uiContext)
  const system = buildPlatformAgentSystem(agent, context)
  const isWhatsApp = opts.channel === 'WHATSAPP'
  const timeoutMs = platformAiTimeoutMs(isWhatsApp ? 52_000 : 22_000)

  const runGemini = async () => {
    const geminiReady = await ensureGeminiKey().catch(() => false)
    if (!geminiReady) return null
    const reply = await withPlatformTimeout(geminiComplete({
      system,
      history: opts.messages.slice(-12).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'model' as const, text: m.content })),
      temperature: 0.35,
      maxOutputTokens: isWhatsApp ? 900 : 1100,
    }), timeoutMs, 'Gemini public platform agent timed out')
    return { reply: annotateReply(agent, reply, 'GEMINI_OR_FALLBACK'), agent, engine: 'GEMINI_OR_FALLBACK' as const }
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
  return { reply: annotateReply(agent, reply, 'GEMINI_OR_FALLBACK'), agent, engine: 'GEMINI_OR_FALLBACK' }
}

export async function platformAgentComplete(opts: {
  userId: string
  messages: { role: string; content: string }[]
  uiContext?: string
  mode?: 'TEXT' | 'VOICE' | string
}): Promise<{ reply: string; agent: PlatformAgentKind; engine: PlatformAgentEngine }> {
  const last = [...opts.messages].reverse().find((m) => m.role === 'user')?.content || ''
  const user = await db.user.findUnique({ where: { id: opts.userId }, select: { role: true } }).catch(() => null)
  const agent = routeAgent(last, user?.role)
  const persona = personaForAgent(agent)
  const dataContext = await buildUserSnapshot(opts.userId, agent, last)
  const context = mergeContext(dataContext, opts.uiContext)
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
    const thinkingLevel: GeminiThinkingLevel | undefined = agent === 'THESIS_DEFENSE'
      ? await geminiDiscussionThinkingLevel().catch(() => 'high' as GeminiThinkingLevel)
      : agent === 'EXAMS' || agent === 'ADMIN_QUALITY'
        ? 'medium'
        : undefined
    const reply = await withPlatformTimeout(geminiComplete({
      system,
      history: opts.messages.slice(-18).map((m) => ({ role: m.role === 'user' ? 'user' as const : 'model' as const, text: m.content })),
      temperature: agent === 'ADMIN_QUALITY' ? 0.25 : 0.4,
      thinkingLevel,
      maxOutputTokens: opts.mode === 'VOICE' ? 1100 : 1800,
    }), timeoutMs, 'Gemini platform agent timed out')
    return { reply: annotateReply(agent, reply, 'GEMINI_OR_FALLBACK'), agent, engine: 'GEMINI_OR_FALLBACK' as const }
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
  return { reply: annotateReply(agent, reply, 'GEMINI_OR_FALLBACK'), agent, engine: 'GEMINI_OR_FALLBACK' }
}
