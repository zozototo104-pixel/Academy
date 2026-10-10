import { buildScopedProgramCatalogSnapshot } from '@/lib/ai-context-builder'
import type { AiKnowledgeScope } from '@/lib/ai-knowledge-policy'
import { db } from '@/lib/db'

export type SupervisorPersona = 'CHAT' | 'EXAM' | 'DEFENSE'

type StudentMemorySignalKind = 'CHAT' | 'EXAM' | 'DEFENSE' | 'FILE' | 'THESIS'

const PERSONA_LABEL_AR: Record<SupervisorPersona, string> = {
  CHAT: 'مدرّس ومرشد أكاديمي',
  EXAM: 'خبير قياس وتقويم جامعي',
  DEFENSE: 'عضو لجنة مناقشة بحث تخرج',
}

function compactText(value?: string | null, max = 240): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function stripContactData(value: unknown): string {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[بريد محجوب]')
    .replace(/(?:\+|00)?\d[\d\s().-]{6,}\d/g, '[رقم محجوب]')
}

function firstNameOnly(value: unknown): string {
  const name = stripContactData(value).replace(/\s+/g, ' ').trim()
  return name.split(' ')[0] || 'غير محدد'
}

function safeContextText(value: unknown, max = 240): string {
  return compactText(stripContactData(value), max)
}

function parseArray(value?: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((x) => String(x || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function mergeJsonList(existing?: string | null, additions: unknown[] = [], max = 12): string {
  const merged: string[] = []
  for (const item of [...parseArray(existing), ...additions]) {
    const clean = compactText(String(item || ''), 220)
    if (clean && !merged.some((x) => x.toLowerCase() === clean.toLowerCase())) merged.push(clean)
  }
  return JSON.stringify(merged.slice(-max))
}

function formatJsonList(title: string, value?: string | null, max = 8): string | null {
  const items = parseArray(value).slice(-max)
  return items.length ? `${title}: ${items.join(' | ')}` : null
}

function dateToIso(value?: Date | string | null): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeArabic(value?: string | null): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function looksLikeMastersProgram(program: any): boolean {
  const text = normalizeArabic([program?.titleAr, program?.titleEn, program?.category, program?.description].filter(Boolean).join(' '))
  const raw = [program?.titleAr, program?.titleEn, program?.category, program?.description].filter(Boolean).join(' ').toLowerCase()
  return text.includes('ماجستير') || text.includes('مجستير') || text.includes('ماستر') || /master|masters|maestr|mestrado|maestrado/.test(raw)
}

function formatBooksForProgram(program: any): string {
  const books = Array.isArray(program?.books) ? program.books : []
  if (!books.length) return 'لا توجد كتب مسجلة لهذا البرنامج في قاعدة البيانات.'
  return books.map((book: any, index: number) => {
    const title = book?.title || book?.titleEn || 'كتاب بلا عنوان'
    const titleEn = book?.titleEn && book.titleEn !== title ? ` (${book.titleEn})` : ''
    const author = book?.author ? ` — ${book.author}` : ''
    const semester = book?.semester ? ` — فصل ${book.semester}` : ''
    const description = book?.description ? ` — وصف الكتاب: ${compactText(book.description, 180)}` : ''
    const readingDepth = book?.readingDepth ? `\n   طريقة القراءة المناسبة: ${compactText(book.readingDepth, 240)}` : ''
    const assessment = book?.assessmentOrientation ? `\n   كيف يدخل في التقييم: ${compactText(book.assessmentOrientation, 240)}` : ''
    const levelPolicy = book?.levelPolicy ? `\n   سياسة المستوى: ${compactText(book.levelPolicy, 200)}` : ''
    const extracted = book?.textContent ? `\n   مقتطف محدود من النص المستخرج: ${compactText(book.textContent, 520)}` : ''
    const knowledge = Array.isArray(book?.knowledgeItems) && book.knowledgeItems.length
      ? `\n   عناصر معرفة مرتبطة بهذا الكتاب: ${book.knowledgeItems.slice(0, 6).map((k: any) => `${k.title}: ${compactText(k.summary || k.excerpt, 170)}`).join(' | ')}`
      : ''
    return `${index + 1}. «${title}»${titleEn}${author}${semester}${description}${readingDepth}${assessment}${levelPolicy}${extracted}${knowledge}`
  }).join('\n')
}

function formatStudyGuides(program: any): string {
  const guides = Array.isArray(program?.studyGuides) ? program.studyGuides : []
  if (!guides.length) return ''
  return guides.slice(0, 6).map((guide: any, i: number) => {
    const objectives = guide.objectives ? ` — الأهداف: ${compactText(guide.objectives, 240)}` : ''
    const terms = guide.keyTerms ? ` — مصطلحات: ${compactText(guide.keyTerms, 180)}` : ''
    const sections = guide.sections ? ` — المحاور: ${compactText(guide.sections, 260)}` : ''
    const activities = guide.activities ? ` — أنشطة قراءة: ${compactText(guide.activities, 220)}` : ''
    const discussions = guide.discussionQuestions ? ` — أسئلة نقاش: ${compactText(guide.discussionQuestions, 220)}` : ''
    return `${i + 1}. ${guide.title} — فصل ${guide.semester}: ${compactText(guide.overview, 280)}${objectives}${terms}${sections}${activities}${discussions}`
  }).join('\n')
}

function formatProgramKnowledge(program: any): string {
  const items = Array.isArray(program?.knowledgeItems) ? program.knowledgeItems : []
  if (!items.length) return ''
  return items.slice(0, 18).map((item: any, i: number) => {
    const book = item.book?.title ? ` — من كتاب: ${item.book.title}` : ''
    const importance = item.importance != null ? ` — أهمية ${item.importance}/100` : ''
    const excerpt = item.excerpt ? ` — مقتطف: ${compactText(item.excerpt, 180)}` : ''
    return `${i + 1}. [${item.category || 'CONCEPT'}] ${item.title}: ${compactText(item.summary, 240)}${book}${importance}${excerpt}`
  }).join('\n')
}

function formatExamReadingSignals(program: any): string {
  const bankItems = Array.isArray(program?.questionBankItems) ? program.questionBankItems : []
  const exams = Array.isArray(program?.programExams) ? program.programExams : []
  const signals: string[] = []
  for (const item of bankItems.slice(0, 16)) {
    const source = item.sourceBookTitle || item.book?.title || item.knowledgeItem?.title || item.unit?.title || 'مصدر غير محدد'
    signals.push(`- مصدر/محور: ${source}${item.sourceLocator ? ` — موضع: ${item.sourceLocator}` : ''}${item.cognitiveSkill ? ` — مهارة: ${item.cognitiveSkill}` : ''}${item.difficulty ? ` — صعوبة: ${item.difficulty}` : ''}${item.sourceEvidence ? ` — دليل دراسي: ${compactText(item.sourceEvidence, 170)}` : ''}`)
  }
  for (const exam of exams.slice(0, 6)) {
    const qSignals = Array.isArray(exam.questions) ? exam.questions.slice(0, 8).map((q: any) => {
      const source = q.sourceBookTitle || q.sourceChapter || q.sourceLocator || q.sourceEvidence || q.type || 'مؤشر سؤال'
      return `${compactText(source, 150)}${q.cognitiveSkill ? ` / ${q.cognitiveSkill}` : ''}${q.difficulty ? ` / ${q.difficulty}` : ''}`
    }).join(' | ') : ''
    signals.push(`- امتحان ${exam.title} — فصل ${exam.semester} — كتب مستخدمة: ${exam.booksUsed || 'غير محددة'}${qSignals ? ` — مؤشرات الأسئلة: ${qSignals}` : ''}`)
  }
  return signals.length ? signals.join('\n') : ''
}

function formatProgramCatalog(programs: any[]): string {
  if (!programs.length) return ''
  const sorted = [...programs].sort((a, b) => {
    const aMasters = looksLikeMastersProgram(a) ? 1 : 0
    const bMasters = looksLikeMastersProgram(b) ? 1 : 0
    const aBooks = Array.isArray(a?.books) && a.books.length ? 1 : 0
    const bBooks = Array.isArray(b?.books) && b.books.length ? 1 : 0
    return (bMasters - aMasters) || (bBooks - aBooks) || String(a?.titleAr || '').localeCompare(String(b?.titleAr || ''), 'ar')
  })

  return sorted.slice(0, 80).map((program: any, index: number) => {
    const hours = program?.hours ? ` — ${program.hours} ساعة` : ''
    const price = program?.price ? ` — الرسوم ${program.price}$` : ''
    const status = program?.active === false ? ' — غير نشط' : ''
    const units = Array.isArray(program?.units) && program.units.length
      ? `\nالوحدات/المواد: ${program.units.slice(0, 10).map((u: any) => `${u.title}${u.semester ? ` / فصل ${u.semester}` : ''}`).join('، ')}`
      : ''
    return `${index + 1}. ${program?.titleAr || 'برنامج بلا عنوان'}${program?.titleEn ? ` (${program.titleEn})` : ''} — ${program?.category || 'تصنيف غير محدد'}${hours}${price}${status}\nالكتب/المراجع المسجلة حرفياً:\n${formatBooksForProgram(program)}${units}`
  }).join('\n\n')
}

function formatAcademicMemory(memory: any): string {
  const rows = [
    memory?.profileDigest ? `ملخص الملف الأكاديمي: ${compactText(memory.profileDigest, 500)}` : null,
    formatJsonList('نقاط القوة المتكررة', memory?.strengths),
    formatJsonList('نقاط الضعف/الفجوات', memory?.weaknesses),
    formatJsonList('مفاهيم يجب مراجعتها', memory?.conceptsToReview),
    formatJsonList('خطوات التعلم المقترحة', memory?.recommendedNextActions),
    memory?.lastConversationSummary ? `آخر خلاصة محادثة: ${compactText(memory.lastConversationSummary, 520)}` : null,
    formatJsonList('إشارات الاختبارات', memory?.examSignals, 6),
    formatJsonList('إشارات البحث/المناقشة', memory?.thesisSignals, 6),
    memory?.lastFileAnalysis ? `آخر تحليل ملف: ${compactText(memory.lastFileAnalysis, 420)}` : null,
  ].filter(Boolean)
  return rows.join('\n')
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
- إذا سأل المستخدم عن كتاب معين، اشرح موضوعه من وصفه، نصه المستخرج، قاعدة معرفته، أدلة الدراسة، والوحدات المرتبطة به؛ وإذا لم تتوفر بيانات كافية فصرّح بذلك ولا تخترع محتوى غير موجود.
- إذا سأل الطالب عمّا يركز عليه للامتحان، استخرج خطة قراءة من الكتب، أدلة الدراسة، الوحدات، مؤشرات الأسئلة، ونقاط ضعفه السابقة، دون كشف إجابات الامتحان.
- لا تكشف مفاتيح إجابات الامتحانات أو الإجابات النموذجية قبل تسليم الطالب؛ قدّم تلميحات وخطة مذاكرة وأسئلة تدريبية مشابهة فقط.
- بعد تسليم الامتحان أو الواجب، اشرح التغذية الراجعة والأخطاء من الملخصات والدرجات المتاحة دون عرض بنك الإجابات كقائمة جاهزة.
- قدّم إجابات قصيرة مفيدة، ثم اقترح خطوة تعلم أو قراءة أو تدريب واحدة.`
}

/**
 * يبني سياق المشرف الذكي من قاعدة بيانات المنصة.
 * يشمل ملف المستخدم، ذاكرته الأكاديمية، آخر المحادثات، وفهرس البرامج النشطة مع الكتب المسجلة حرفياً.
 */
export async function buildSupervisorContext(userId: string, options?: { scope?: AiKnowledgeScope; query?: string | null }): Promise<string> {
  try {
    const userStore = (db as any).user
    const enrollmentStore = (db as any).enrollment
    const programStore = (db as any).program
    const memoryStore = (db as any).studentAcademicMemory
    const chatStore = (db as any).chatMessage
    const admissionStore = (db as any).admissionApplication
    const thesisStore = (db as any).thesisSubmission

    const [profile, memory, recentMessages, admission, thesis, enrollments, activePrograms] = await Promise.all([
      userStore?.findUnique({
        where: { id: userId },
        select: { name: true, role: true, createdAt: true },
      }).catch(() => null),
      memoryStore?.findUnique({ where: { userId } }).catch(() => null),
      chatStore?.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { role: true, content: true, mode: true, createdAt: true },
      }).catch(() => []) || [],
      admissionStore?.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { reference: true, program: true, status: true, thesisDeadline: true },
      }).catch(() => null),
      thesisStore?.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { title: true, status: true, defenseDate: true, resultScore: true, aiScore: true },
      }).catch(() => null),
      enrollmentStore?.findMany({
        where: { userId, status: { in: ['ACTIVE', 'COMPLETED'] } },
        include: {
          program: {
            include: {
              books: {
                orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
                select: {
                  title: true,
                  titleEn: true,
                  author: true,
                  semester: true,
                  description: true,
                  textContent: true,
                  readingDepth: true,
                  assessmentOrientation: true,
                  levelPolicy: true,
                  knowledgeItems: {
                    orderBy: [{ importance: 'desc' }, { createdAt: 'asc' }],
                    take: 8,
                    select: { title: true, summary: true, excerpt: true, category: true, importance: true, pageStart: true, pageEnd: true },
                  },
                },
              },
              units: {
                orderBy: [{ semester: 'asc' }, { order: 'asc' }],
                take: 20,
                select: { title: true, semester: true, summary: true, status: true, objectives: true, content: true },
              },
              assignments: {
                where: { status: 'PUBLISHED' },
                orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
                take: 12,
                select: { title: true, description: true, type: true, semester: true, points: true, rubric: true },
              },
              studyGuides: {
                where: { status: 'PUBLISHED' },
                orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
                take: 8,
                select: { title: true, semester: true, overview: true, objectives: true, keyTerms: true, sections: true, activities: true, discussionQuestions: true },
              },
              knowledgeItems: {
                orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }],
                take: 24,
                select: { title: true, summary: true, excerpt: true, category: true, importance: true, semester: true, book: { select: { title: true } } },
              },
              questionBankItems: {
                where: { status: 'APPROVED' },
                orderBy: [{ qualityScore: 'desc' }, { updatedAt: 'desc' }],
                take: 24,
                select: {
                  sourceEvidence: true,
                  sourceBookTitle: true,
                  sourceLocator: true,
                  cognitiveSkill: true,
                  difficulty: true,
                  semester: true,
                  type: true,
                },
              },
              programExams: {
                orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
                take: 8,
                select: {
                  title: true,
                  semester: true,
                  status: true,
                  passScore: true,
                  booksUsed: true,
                  questions: {
                    where: { status: 'PUBLISHED' },
                    orderBy: { order: 'asc' },
                    take: 12,
                    select: { type: true, sourceEvidence: true, sourceBookTitle: true, sourceChapter: true, sourceLocator: true, cognitiveSkill: true, difficulty: true },
                  },
                },
              },
            },
          },
        },
      }).catch(() => []) || [],
      programStore?.findMany({
        where: { active: true },
        orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
        take: 140,
        select: {
          titleAr: true,
          titleEn: true,
          category: true,
          active: true,
          hours: true,
          price: true,
          description: true,
          books: {
            orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
            take: 20,
            select: { title: true, titleEn: true, author: true, semester: true, description: true },
          },
          units: {
            orderBy: [{ semester: 'asc' }, { order: 'asc' }],
            take: 12,
            select: { title: true, semester: true, status: true, summary: true },
          },
        },
      }).catch(() => []) || [],
    ])

    const parts: string[] = []

    if (profile) {
      parts.push(`بطاقة المستخدم: الاسم الأول ${firstNameOnly(profile.name)} — الدور ${profile.role || 'غير محدد'}`)
    }

    if (memory) {
      const memoryBlock = formatAcademicMemory(memory)
      if (memoryBlock) parts.push(`ذاكرة المشرف الذكي المتراكمة:\n${memoryBlock}`)
    }

    if (Array.isArray(recentMessages) && recentMessages.length) {
      parts.push(
        `آخر محادثات محفوظة لفهم السياق فقط:\n${recentMessages
          .slice()
          .reverse()
          .map((m: any) => `${m.role === 'assistant' ? 'المشرف' : 'المستخدم'}${m.mode === 'VOICE' ? ' (صوت)' : ''}: ${safeContextText(m.content, 180)}`)
          .join('\n')}`
      )
    }

    if (admission) {
      parts.push(`طلب الالتحاق الأخير: رقم ${admission.reference || 'غير محدد'} — البرنامج: ${admission.program || 'غير محدد'} — الحالة: ${admission.status || 'غير محددة'}`)
    }

    if (thesis) {
      parts.push(`بحث التخرج: «${thesis.title || 'غير محدد'}» — الحالة: ${thesis.status || 'غير محددة'}${thesis.resultScore != null ? ` — النتيجة ${thesis.resultScore}` : ''}${thesis.aiScore != null ? ` — تقييم الذكاء ${thesis.aiScore}/100` : ''}`)
    }

    if (Array.isArray(enrollments) && enrollments.length) {
      const enrollmentLines = enrollments.map((enr: any, index: number) => {
        const program = enr.program || {}
        const books = formatBooksForProgram(program)
        const units = Array.isArray(program.units) && program.units.length
          ? `\nالوحدات: ${program.units.slice(0, 14).map((u: any) => `${u.title}${u.semester ? ` / فصل ${u.semester}` : ''}${u.summary ? ` — ${compactText(u.summary, 120)}` : ''}${u.objectives ? ` — أهداف: ${compactText(u.objectives, 120)}` : ''}`).join('، ')}`
          : ''
        const guides = formatStudyGuides(program)
        const knowledge = formatProgramKnowledge(program)
        const examSignals = formatExamReadingSignals(program)
        const assignments = Array.isArray(program.assignments) && program.assignments.length
          ? `\nواجبات/تدريبات منشورة تساعد على توجيه القراءة: ${program.assignments.slice(0, 8).map((a: any) => `${a.title} (${a.type}) — فصل ${a.semester}: ${compactText(a.description, 130)}`).join(' | ')}`
          : ''
        return [
          `${index + 1}. الطالب مسجل في «${program.titleAr || 'برنامج غير محدد'}» (${program.category || 'تصنيف غير محدد'}) — الحالة ${enr.status || 'غير محددة'}`,
          `الكتب المقررة لهذا التسجيل:\n${books}`,
          units,
          guides ? `أدلة الدراسة المنشورة:\n${guides}` : '',
          knowledge ? `قاعدة المعرفة المرتبطة بالبرنامج والكتب:\n${knowledge}` : '',
          examSignals ? `مؤشرات القراءة للامتحانات دون مفاتيح إجابات:\n${examSignals}` : '',
          assignments,
        ].filter(Boolean).join('\n')
      }).join('\n\n')
      parts.push(`برامج المستخدم المسجل بها ومراجعها المعتمدة:\n${enrollmentLines}`)
    }

    const catalogScope = options?.scope || 'STUDENT_SUPERVISOR'
    const centralProgramCatalog = await buildScopedProgramCatalogSnapshot({ scope: catalogScope, query: options?.query || 'كتب الماجستير البرامج النشطة' }).catch(() => '')
    if (centralProgramCatalog) {
      parts.push(centralProgramCatalog)
    } else if (Array.isArray(activePrograms) && activePrograms.length) {
      parts.push(
        `فهرس البرامج النشطة الرسمي من قاعدة بيانات المنصة. عند السؤال عن كتب الماجستير أو أي برنامج، استخرج الأسماء من هذه القائمة ولا تعطِ جواباً عاماً:\n${formatProgramCatalog(activePrograms)}`
      )
    }

    if (!enrollments?.length && !admission && !thesis) {
      parts.push('لا يظهر لهذا المستخدم تسجيل طالب فعّال؛ عند الأسئلة العامة عن البرامج أو كتب الماجستير استخدم فهرس البرامج النشطة الرسمي أعلاه.')
    }

    const ctx = parts.filter(Boolean).join('\n\n')
    return ctx.length > 32000 ? `${ctx.slice(0, 32000)}…` : ctx
  } catch (error) {
    console.error('supervisor-ai context error:', error)
    return ''
  }
}

/** يبني رسالة النظام للمشرف الذكي متضمنة سياق الطالب التخصصي */
export function mergeContext(ragContext: string, uiContext?: string): string {
  const blocks: string[] = []
  if (ragContext) blocks.push(`ملف المستخدم ومعرفته التخصصية من قاعدة بيانات الأكاديمية — استند إليها في إجاباتك ولا تخترع معلومات غير موجودة:\n${ragContext}`)
  if (uiContext) blocks.push(`سياق إضافي من الواجهة:\n${uiContext}`)
  return blocks.join('\n\n')
}

export interface StudentMemorySignal {
  kind: StudentMemorySignalKind
  persona?: SupervisorPersona
  mode?: 'TEXT' | 'VOICE' | string
  summary?: string
  userMessage?: string
  assistantReply?: string
  programTitle?: string
  examTitle?: string
  score?: number
  passed?: boolean
  weakPoints?: string[]
  strengths?: string[]
  weaknesses?: string[]
  concepts?: string[]
  nextActions?: string[]
  thesisTitle?: string
  fileAnalysis?: string
}

function defaultNextActions(signal: StudentMemorySignal): string[] {
  if (signal.kind === 'EXAM') {
    return signal.passed
      ? ['تثبيت المفاهيم التي ظهرت في الامتحان وربطها بتطبيق عملي أو واجب قصير']
      : ['مراجعة الأسئلة التي فقد فيها الطالب درجات ثم إعادة تدريبه على أمثلة تطبيقية من الكتب المقررة']
  }
  if (signal.kind === 'DEFENSE') {
    return (signal.score || 0) >= 60
      ? ['تحويل ملاحظات المناقشة إلى تحسينات نهائية في البحث قبل اعتماد اللجنة']
      : ['إعداد جلسة علاجية مركزة حول المشكلة والمنهجية والنتائج قبل إعادة المناقشة أو المراجعة']
  }
  if (signal.kind === 'FILE') return ['مراجعة نتيجة تحليل الملف وربطها بمتطلبات القبول أو التخصص']
  return ['اقتراح قراءة أو نشاط قصير مرتبط بسؤال الطالب الحالي']
}

function buildSignalSummary(signal: StudentMemorySignal): string | null {
  if (signal.summary) return compactText(signal.summary, 700)
  if (signal.kind === 'EXAM') {
    return compactText(
      `امتحان ${signal.examTitle || 'شامل'}${signal.programTitle ? ` في ${signal.programTitle}` : ''}: ${signal.score != null ? `${signal.score}%` : 'قيد التقييم'} — ${signal.passed ? 'اجتاز' : 'يحتاج متابعة'}${signal.weakPoints?.length ? ` — نقاط تحتاج مراجعة: ${signal.weakPoints.slice(0, 4).join(' | ')}` : ''}`,
      700
    )
  }
  if (signal.kind === 'DEFENSE') {
    return compactText(`مناقشة بحث ${signal.thesisTitle ? `«${signal.thesisTitle}»` : 'التخرج'}: ${signal.score != null ? `${signal.score}/100` : 'دون درجة'}`, 700)
  }
  if (signal.kind === 'CHAT') {
    return compactText(
      `آخر تفاعل ${signal.mode === 'VOICE' ? 'صوتي' : 'نصي'}: المستخدم قال «${compactText(signal.userMessage, 240)}» — ورد المشرف: «${compactText(signal.assistantReply, 260)}»`,
      700
    )
  }
  return null
}

function buildProfileDigest(signal: StudentMemorySignal, previous?: string | null): string | null {
  const persona = signal.persona ? PERSONA_LABEL_AR[signal.persona] : null
  const bits = [
    signal.programTitle ? `السياق الأكاديمي: ${signal.programTitle}` : null,
    signal.thesisTitle ? `بحث التخرج: ${signal.thesisTitle}` : null,
    signal.examTitle ? `آخر امتحان: ${signal.examTitle}` : null,
    signal.score != null ? `آخر مؤشر أداء: ${signal.score}${signal.kind === 'DEFENSE' ? '/100' : '%'}` : null,
    persona ? `آخر وضع للمشرف: ${persona}` : null,
  ].filter(Boolean)
  return bits.length ? compactText(bits.join(' — '), 900) : previous ? compactText(previous, 900) : null
}

/** يحدّث ذاكرة أكاديمية مركزية للطالب بدون استدعاء نموذج إضافي. */
export async function updateStudentAcademicMemory(userId: string, signal: StudentMemorySignal): Promise<void> {
  try {
    const memoryStore = (db as any).studentAcademicMemory
    if (!memoryStore) return

    const now = new Date()
    const existing = await memoryStore.findUnique({ where: { userId } }).catch(() => null)
    const summary = buildSignalSummary(signal)
    const strengths = [...(signal.strengths || [])]
    const weaknesses = [...(signal.weaknesses || [])]
    const concepts = [...(signal.concepts || [])]
    const nextActions = [...(signal.nextActions || []), ...defaultNextActions(signal)]
    const examSignals: string[] = []
    const thesisSignals: string[] = []

    if (signal.kind === 'EXAM') {
      if (signal.passed) strengths.push(`اجتاز ${signal.examTitle || 'امتحاناً شاملاً'} بدرجة ${signal.score != null ? `${signal.score}%` : 'مقبولة'}`)
      if (!signal.passed) weaknesses.push(`تعثر في ${signal.examTitle || 'امتحان شامل'} ويحتاج مراجعة موجهة`)
      for (const w of signal.weakPoints || []) {
        weaknesses.push(w)
        concepts.push(w)
      }
      if (summary) examSignals.push(summary)
    }

    if (signal.kind === 'DEFENSE') {
      if ((signal.score || 0) >= 80) strengths.push('أداء قوي في مناقشة بحث التخرج')
      if ((signal.score || 0) < 60) weaknesses.push('أداء المناقشة يحتاج دعماً في المنهجية والنتائج والربط التطبيقي')
      if (summary) thesisSignals.push(summary)
    }

    if (signal.kind === 'FILE' && signal.fileAnalysis) {
      nextActions.push('متابعة نواقص الملف أو الوثيقة قبل قرار الإدارة النهائي')
    }

    const profileDigest = buildProfileDigest(signal, existing?.profileDigest)
    const createData: any = {
      userId,
      profileDigest,
      strengths: mergeJsonList(null, strengths),
      weaknesses: mergeJsonList(null, weaknesses),
      conceptsToReview: mergeJsonList(null, concepts),
      recommendedNextActions: mergeJsonList(null, nextActions),
      lastConversationSummary: signal.kind === 'CHAT' ? summary : null,
      examSignals: mergeJsonList(null, examSignals),
      thesisSignals: mergeJsonList(null, thesisSignals),
      lastFileAnalysis: signal.fileAnalysis ? compactText(signal.fileAnalysis, 900) : null,
      lastInteractionAt: now,
      interactionsCount: 1,
    }
    if (signal.kind === 'EXAM') createData.lastExamAt = now
    if (signal.kind === 'DEFENSE') createData.lastDefenseAt = now

    const updateData: any = {
      profileDigest,
      strengths: mergeJsonList(existing?.strengths, strengths),
      weaknesses: mergeJsonList(existing?.weaknesses, weaknesses),
      conceptsToReview: mergeJsonList(existing?.conceptsToReview, concepts),
      recommendedNextActions: mergeJsonList(existing?.recommendedNextActions, nextActions),
      lastInteractionAt: now,
      interactionsCount: { increment: 1 },
    }
    if (signal.kind === 'CHAT') updateData.lastConversationSummary = summary
    if (signal.kind === 'EXAM') {
      updateData.examSignals = mergeJsonList(existing?.examSignals, examSignals, 10)
      updateData.lastExamAt = now
    }
    if (signal.kind === 'DEFENSE') {
      updateData.thesisSignals = mergeJsonList(existing?.thesisSignals, thesisSignals, 10)
      updateData.lastDefenseAt = now
    }
    if (signal.fileAnalysis) updateData.lastFileAnalysis = compactText(signal.fileAnalysis, 900)

    await memoryStore.upsert({ where: { userId }, create: createData, update: updateData })
  } catch (error) {
    console.error('student academic memory update error:', error)
  }
}

export async function getStudentAcademicMemorySnapshot(userId: string) {
  try {
    const memoryStore = (db as any).studentAcademicMemory
    if (!memoryStore) {
      return {
        exists: false,
        profileDigest: null,
        strengths: [],
        weaknesses: [],
        conceptsToReview: [],
        recommendedNextActions: [],
        lastConversationSummary: null,
        examSignals: [],
        thesisSignals: [],
        lastFileAnalysis: null,
        interactionsCount: 0,
        lastInteractionAt: null,
        lastExamAt: null,
        lastDefenseAt: null,
        updatedAt: null,
      }
    }

    const memory = await memoryStore.findUnique({ where: { userId } })
    if (!memory) {
      return {
        exists: false,
        profileDigest: null,
        strengths: [],
        weaknesses: [],
        conceptsToReview: [],
        recommendedNextActions: ['ابدأ محادثة مع المشرف الذكي أو اجتز أول امتحان لبناء ذاكرة أكاديمية شخصية.'],
        lastConversationSummary: null,
        examSignals: [],
        thesisSignals: [],
        lastFileAnalysis: null,
        interactionsCount: 0,
        lastInteractionAt: null,
        lastExamAt: null,
        lastDefenseAt: null,
        updatedAt: null,
      }
    }

    return {
      exists: true,
      profileDigest: memory.profileDigest || null,
      strengths: parseArray(memory.strengths),
      weaknesses: parseArray(memory.weaknesses),
      conceptsToReview: parseArray(memory.conceptsToReview),
      recommendedNextActions: parseArray(memory.recommendedNextActions),
      lastConversationSummary: memory.lastConversationSummary || null,
      examSignals: parseArray(memory.examSignals),
      thesisSignals: parseArray(memory.thesisSignals),
      lastFileAnalysis: memory.lastFileAnalysis || null,
      interactionsCount: memory.interactionsCount || 0,
      lastInteractionAt: dateToIso(memory.lastInteractionAt),
      lastExamAt: dateToIso(memory.lastExamAt),
      lastDefenseAt: dateToIso(memory.lastDefenseAt),
      updatedAt: dateToIso(memory.updatedAt),
    }
  } catch (error) {
    console.error('student academic memory snapshot error:', error)
    return {
      exists: false,
      profileDigest: null,
      strengths: [],
      weaknesses: [],
      conceptsToReview: [],
      recommendedNextActions: [],
      lastConversationSummary: null,
      examSignals: [],
      thesisSignals: [],
      lastFileAnalysis: null,
      interactionsCount: 0,
      lastInteractionAt: null,
      lastExamAt: null,
      lastDefenseAt: null,
      updatedAt: null,
    }
  }
}
