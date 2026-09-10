import { db } from '@/lib/db'
import { getProgramKnowledgeItems } from '@/lib/knowledge-bank'

const KNOWLEDGE_CATEGORY_AR: Record<string, string> = {
  CONCEPT: 'مفهوم',
  THEORY: 'نظرية أو إطار',
  METHOD: 'منهجية',
  CASE: 'حالة تطبيقية',
  DEFINITION: 'تعريف',
  QUESTION_SEED: 'محور سؤال',
  SUMMARY: 'ملخص محوري',
}

export type SupervisorPersona = 'CHAT' | 'EXAM' | 'DEFENSE'

type StudentMemorySignalKind = 'CHAT' | 'EXAM' | 'DEFENSE' | 'FILE' | 'THESIS'

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

function labelKnowledgeCategory(category: string) {
  return KNOWLEDGE_CATEGORY_AR[String(category || '').toUpperCase()] || 'محور معرفي'
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

function compactText(value?: string | null, max = 240): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function cleanMemoryItem(value: unknown, max = 220): string | null {
  const text = compactText(String(value || ''), max)
  return text.length >= 3 ? text : null
}

function mergeJsonList(existing?: string | null, additions: unknown[] = [], max = 12): string {
  const merged: string[] = []
  for (const item of [...parseArray(existing), ...additions]) {
    const clean = cleanMemoryItem(item)
    if (clean && !merged.some((x) => x.toLowerCase() === clean.toLowerCase())) merged.push(clean)
  }
  return JSON.stringify(merged.slice(-max))
}

function formatJsonList(title: string, value?: string | null, max = 8): string | null {
  const items = parseArray(value).slice(-max)
  return items.length ? `${title}: ${items.join(' | ')}` : null
}

function formatAcademicMemory(memory: any): string {
  const rows = [
    memory.profileDigest ? `ملخص الملف الأكاديمي: ${compactText(memory.profileDigest, 500)}` : null,
    formatJsonList('نقاط القوة المتكررة', memory.strengths),
    formatJsonList('نقاط الضعف/الفجوات', memory.weaknesses),
    formatJsonList('مفاهيم يجب مراجعتها', memory.conceptsToReview),
    formatJsonList('خطوات التعلم المقترحة', memory.recommendedNextActions),
    memory.lastConversationSummary ? `آخر خلاصة محادثة: ${compactText(memory.lastConversationSummary, 520)}` : null,
    formatJsonList('إشارات الاختبارات', memory.examSignals, 6),
    formatJsonList('إشارات البحث/المناقشة', memory.thesisSignals, 6),
    memory.lastFileAnalysis ? `آخر تحليل ملف: ${compactText(memory.lastFileAnalysis, 420)}` : null,
  ].filter(Boolean)
  return rows.join('\n')
}

/**
 * 12.1 — قاعدة معرفة خاصة بكل طالب (RAG)
 * تبني سياقاً تخصصياً حقيقياً من: كتالوج البرامج النشطة + برامج الطالب الفعّالة +
 * وحداتها الدراسية + الكتب المقررة المعتمدة + تقدمه ونتائجه + بحث تخرجه ومواعيده.
 */
export async function buildSupervisorContext(userId: string): Promise<string> {
  try {
    const [enrollments, thesis, admission, activePrograms] = await Promise.all([
      db.enrollment.findMany({
        where: { userId, status: { in: ['ACTIVE', 'COMPLETED'] } },
        include: {
          program: {
            include: {
              units: { orderBy: { order: 'asc' }, select: { title: true, summary: true, objectives: true } },
              books: {
                orderBy: { createdAt: 'asc' },
                select: { title: true, titleEn: true, author: true, description: true, semester: true, textContent: true },
              },
              studyGuides: {
                where: { status: 'PUBLISHED' },
                orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
                select: { title: true, overview: true, objectives: true, keyTerms: true, discussionQuestions: true, semester: true },
              },
              programExams: { select: { id: true, title: true, semester: true, status: true, passScore: true } },
            },
          },
        },
      }),
      db.thesisSubmission.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }),
      db.admissionApplication.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: { reference: true, program: true, status: true, thesisDeadline: true },
      }),
      db.program.findMany({
        where: { active: true },
        orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
        take: 100,
        select: {
          titleAr: true,
          titleEn: true,
          category: true,
          hours: true,
          price: true,
          description: true,
          books: {
            orderBy: { createdAt: 'asc' },
            take: 3,
            select: { title: true, titleEn: true, author: true, description: true, textContent: true },
          },
        },
      }),
    ])

    const [academicMemory, recentMessages, latestAssignments] = await Promise.all([
      db.studentAcademicMemory.findUnique({ where: { userId } }).catch(() => null),
      db.chatMessage.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { role: true, content: true, mode: true, kind: true, createdAt: true },
      }).catch(() => []),
      db.assignmentSubmission.findMany({
        where: { userId },
        orderBy: { submittedAt: 'desc' },
        take: 5,
        include: { assignment: { select: { title: true, type: true, semester: true, program: { select: { titleAr: true } } } } },
      }).catch(() => []),
    ])

    const parts: string[] = []

    if (academicMemory) {
      const memoryBlock = formatAcademicMemory(academicMemory)
      if (memoryBlock) parts.push(`ذاكرة المشرف الذكي المتراكمة عن الطالب:\n${memoryBlock}`)
    }

    if (recentMessages.length > 0) {
      const chatDigest = recentMessages
        .slice()
        .reverse()
        .map((m) => `${m.role === 'assistant' ? 'المشرف' : 'الطالب'}${m.mode === 'VOICE' ? ' (صوت)' : ''}: ${compactText(m.content, 180)}`)
        .join('\n')
      parts.push(`آخر محادثات محفوظة في ملف الطالب (لا تكررها؛ استخدمها لفهم السياق):\n${chatDigest}`)
    }

    if (latestAssignments.length > 0) {
      parts.push(
        `آخر الواجبات/المشاريع التطبيقية:\n${latestAssignments.map((a) => {
          const status = a.score != null ? ` — الدرجة ${a.score}` : ` — الحالة ${a.status}`
          return `- ${a.assignment.title} (${a.assignment.program.titleAr}، فصل ${a.assignment.semester})${status}${a.feedback ? ` — ملاحظة: ${compactText(a.feedback, 160)}` : ''}`
        }).join('\n')}`
      )
    }

    if (activePrograms.length > 0) {
      const programLines = activePrograms.map((p, i) => {
        const hours = p.hours ? ` — ${p.hours} ساعة` : ''
        const price = p.price ? ` — ${p.price}$` : ''
        const desc = p.description ? ` — ${p.description.replace(/\s+/g, ' ').slice(0, 120)}` : ''
        const books = p.books.length
          ? `\n   كتب/مراجع مرتبطة: ${p.books.map((b) => {
              const snippet = (b.textContent || b.description || '').replace(/\s+/g, ' ').trim().slice(0, 180)
              return `«${b.title}»${b.author ? ` (${b.author})` : ''}${snippet ? `: ${snippet}` : ''}`
            }).join(' | ')}`
          : ''
        return `${i + 1}. ${p.titleAr}${p.titleEn ? ` (${p.titleEn})` : ''} — ${p.category}${hours}${price}${desc}${books}`
      })
      parts.push(`ذاكرة كتالوج البرامج النشطة في النظام (${activePrograms.length} برنامج):\n${programLines.join('\n')}`)
    }

    if (enrollments.length === 0 && !thesis && !admission) {
      parts.push('الطالب لم يسجل في أي برنامج بعد — ركّز على تقديم المشورة حول برامج الأكاديمية وإجراءات الالتحاق، وابدأ بذكر البرامج عندما يسأل عنها.')
    }

    if (admission) {
      const deadline = admission.thesisDeadline
        ? new Date(admission.thesisDeadline).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' })
        : null
      const daysLeft = deadline
        ? Math.ceil((new Date(admission.thesisDeadline as any).getTime() - Date.now()) / 86400000)
        : null
      parts.push(
        `ملف طلب الالتحاق: رقم ${admission.reference} — البرنامج: ${admission.program} — الحالة: ${admission.status}` +
          (deadline ? ` — مهلة تسليم بحث التخرج تنتهي في ${deadline}${daysLeft != null ? ` (متبقٍ ${daysLeft} يوم)` : ''}` : '')
      )
    }

    if (thesis) {
      parts.push(
        `بحث التخرج: «${thesis.title}» — الحالة: ${thesis.status}` +
          (thesis.defenseDate ? ` — موعد المناقشة: ${new Date(thesis.defenseDate).toLocaleDateString('ar-EG')}` : '') +
          (thesis.resultScore != null ? ` — نتيجة المناقشة النهائية: ${thesis.resultScore}` : '') +
          (thesis.aiScore != null ? ` — تقييم الخبير الذكي في الجلسة: ${thesis.aiScore}/100` : '')
      )
    }

    for (const enr of enrollments) {
      const p = enr.program
      const totalUnits = p.units.length
      const done = enr.completedUnits ? JSON.parse(enr.completedUnits) : []
      const pct = totalUnits ? Math.round((done.length / totalUnits) * 100) : 0

      const unitLines = p.units
        .slice(0, 12)
        .map((u, i) => {
          const obj = u.objectives
            ? (() => {
                try {
                  const a = JSON.parse(u.objectives)
                  return Array.isArray(a) ? ` — أهدافه: ${a.slice(0, 3).join('؛ ')}` : ''
                } catch {
                  return ''
                }
              })()
            : ''
          return `${i + 1}. ${u.title}${u.summary ? `: ${u.summary.slice(0, 140)}` : ''}${obj}`
        })

      parts.push(
        `البرنامج المسجل به: «${p.titleAr}» (${p.category}) — تقدم الطالب: ${done.length}/${totalUnits} وحدة (${pct}%)` +
          (enr.finalScore != null ? ` — النتيجة النهائية: ${enr.finalScore}` : '') +
          `\nوحدات المنهج:\n${unitLines.join('\n')}`
      )

      if (p.books.length > 0) {
        const bookBlocks = p.books.slice(0, 6).map((b) => {
          const excerpt = (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1100)
          return `- «${b.title}»${b.author ? ` (${b.author})` : ''}${b.semester ? ` — فصل ${b.semester === 1 ? 'أول' : 'ثانٍ'}` : ''}${b.description ? ` — ${b.description.slice(0, 110)}` : ''}${excerpt ? `\n  مقتطف من محتواه: «${excerpt}…»` : ''}`
        })
        parts.push(`الكتب المقررة المعتمدة لهذا التخصص (يُمتحَن بها الطالب):\n${bookBlocks.join('\n')}`)
      }

      const knowledgeItems = await getProgramKnowledgeItems(p.id, undefined, 30).catch(() => [])
      if (knowledgeItems.length > 0) {
        parts.push(
          `بنك المعرفة الأكاديمي المستخرج من كتب هذا التخصص (استخدمه في الشرح والأسئلة والمناقشة):\n${knowledgeItems
            .slice(0, 24)
            .map((k, i) => `${i + 1}. ${labelKnowledgeCategory(k.category)} — ${k.title}: ${k.summary.slice(0, 260)}${k.bookTitle ? ` — من «${k.bookTitle}»` : ''}`)
            .join('\n')}`
        )
      }

      if (p.studyGuides.length > 0) {
        const guides = p.studyGuides.slice(0, 3).map((g) => {
          const objectives = parseArray(g.objectives).slice(0, 4)
          const terms = parseArray(g.keyTerms).slice(0, 6)
          const qs = parseArray(g.discussionQuestions).slice(0, 4)
          return `- ${g.title} — ${g.semester === 2 ? 'الفصل الثاني' : g.semester === 3 ? 'البحث/المشروع' : 'الفصل الأول'}: ${g.overview.slice(0, 360)}${objectives.length ? `\n  أهداف: ${objectives.join('؛ ')}` : ''}${terms.length ? `\n  مصطلحات: ${terms.join('، ')}` : ''}${qs.length ? `\n  أسئلة نقاش: ${qs.join(' | ')}` : ''}`
        })
        parts.push(`أدلة الدراسة المنشورة للطالب (استند إليها في توجيه القراءة والمناقشة):\n${guides.join('\n')}`)
      }

      const readyExams = p.programExams.filter((e) => e.status === 'READY')
      if (readyExams.length > 0) {
        parts.push(
          `الامتحانات: ${readyExams.map((e) => `${e.title} (فصل ${e.semester === 2 ? 'ثانٍ' : 'أول'} — حد النجاح ${e.passScore}%)`).join(' | ')}`
        )
      }
    }

    const attempts = await db.programExamAttempt.findMany({
      where: { userId },
      include: { exam: { select: { title: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    })

    if (attempts.length > 0) {
      parts.push(
        `آخر محاولاته في الامتحانات الشاملة: ${attempts
          .map((a) => `${a.exam.title}: ${a.score != null ? `${a.score}%` : 'قيد التصحيح'}${a.appealStatus === 'PENDING' ? ' (اعتراض قيد المراجعة)' : ''}`)
          .join(' | ')}`
      )
    }

    let ctx = parts.join('\n\n')
    if (ctx.length > 16000) ctx = ctx.slice(0, 16000) + '…'
    return ctx
  } catch (e) {
    console.error('supervisor-ai context error:', e)
    return ''
  }
}

/** يبني رسالة النظام للمشرف الذكي متضمنة سياق الطالب التخصصي */
export function mergeContext(ragContext: string, uiContext?: string): string {
  const blocks: string[] = []
  if (ragContext) blocks.push(`ملف الطالب ومعرفته التخصصية (من قاعدة معرفة الأكاديمية — استند إليها في إجاباتك):\n${ragContext}`)
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
    return compactText(
      `مناقشة بحث ${signal.thesisTitle ? `«${signal.thesisTitle}»` : 'التخرج'}: ${signal.score != null ? `${signal.score}/100` : 'دون درجة'}${signal.summary ? ` — ${signal.summary}` : ''}`,
      700
    )
  }
  if (signal.kind === 'CHAT') {
    return compactText(
      `آخر تفاعل ${signal.mode === 'VOICE' ? 'صوتي' : 'نصي'}: الطالب قال «${compactText(signal.userMessage, 240)}» — ورد المشرف: «${compactText(signal.assistantReply, 260)}»`,
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
  const next = bits.join(' — ')
  return next ? compactText(next, 900) : previous ? compactText(previous, 900) : null
}

/**
 * يحدّث ذاكرة أكاديمية مركزية للطالب بدون استدعاء نموذج إضافي.
 * هذه الذاكرة تجعل المشرف الذكي يستحضر نقاط القوة والضعف وآخر الامتحانات والمناقشة في كل سياق لاحق.
 */
export async function updateStudentAcademicMemory(userId: string, signal: StudentMemorySignal): Promise<void> {
  try {
    const memoryStore = (db as any).studentAcademicMemory
    if (!memoryStore) return

    const now = new Date()
    const existing = await memoryStore.findUnique({ where: { userId } })
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

    await memoryStore.upsert({
      where: { userId },
      create: createData,
      update: updateData,
    })
  } catch (e) {
    console.error('student academic memory update error:', e)
  }
}
