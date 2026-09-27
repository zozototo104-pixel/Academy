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

function formatRubric(value?: string | null, max = 420): string | null {
  if (!value) return null
  const items = parseArray(value).slice(0, 6)
  if (items.length) return items.map((x, i) => `${i + 1}) ${compactText(x, 140)}`).join('؛ ')
  const text = compactText(value, max)
  return text || null
}

function optionText(optionsJson: string | null | undefined, index?: number | null): string | null {
  if (index == null || Number.isNaN(Number(index))) return null
  const options = parseArray(optionsJson)
  return options[Number(index)] ? `${Number(index) + 1}) ${compactText(options[Number(index)], 160)}` : String(index)
}

function expectedAnswerForQuestion(question: any): string | null {
  const q = question || {}
  const options = parseArray(q.options)
  const rawCorrect = q.correctAnswer != null ? String(q.correctAnswer).trim() : ''
  const correctIndex = rawCorrect !== '' ? Number(rawCorrect) : Number.NaN
  const correct = rawCorrect
    ? Number.isFinite(correctIndex) && options[correctIndex]
      ? `${correctIndex + 1}) ${compactText(options[correctIndex], 220)}`
      : compactText(rawCorrect, 220)
    : ''
  const model = compactText(q.modelAnswer, 360)
  const rationale = compactText(q.correctRationale, 300)
  const evidence = compactText(q.sourceEvidence, 340)
  return [
    correct ? `الإجابة الصحيحة: ${correct}` : null,
    model ? `الإجابة النموذجية/معيار القبول: ${model}` : null,
    rationale ? `سبب الصحة: ${rationale}` : null,
    evidence ? `الدليل الأكاديمي: ${evidence}` : null,
  ].filter(Boolean).join(' — ') || null
}

function studentAnswerForRecord(answer: any): string {
  const selected = optionText(answer?.question?.options, answer?.selectedOption)
  const text = compactText(answer?.answerText, 360)
  return selected || text || 'لم يقدّم إجابة نصية محفوظة'
}

function formatAnswerReview(answer: any, index: number): string {
  const q = answer?.question || {}
  const question = compactText(q.text, 420)
  const verdict = answer?.isCorrect === true ? 'صحيحة' : answer?.isCorrect === false ? 'خاطئة/ناقصة' : 'بحاجة مراجعة'
  const points = answer?.points != null || answer?.maxPoints != null ? ` — الدرجة ${answer?.points ?? '؟'}/${answer?.maxPoints ?? q.points ?? '؟'}` : ''
  const expected = expectedAnswerForQuestion(q)
  const feedback = compactText(answer?.aiFeedback, 360)
  const source = compactText([q.sourceBookTitle, q.sourceChapter, q.sourceLocator].filter(Boolean).join(' / '), 180)
  return `${index + 1}. ${question}${q.type ? ` — نوع السؤال ${q.type}` : ''}${source ? ` — المصدر: ${source}` : ''}\n   إجابة الطالب: ${studentAnswerForRecord(answer)} — الحكم: ${verdict}${points}${expected ? `\n   ${expected}` : ''}${feedback ? `\n   ملاحظة التصحيح: ${feedback}` : ''}`
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

function parseCompletedUnits(value?: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
  } catch {
    return []
  }
}

/**
 * 12.1 — قاعدة معرفة خاصة بكل طالب (RAG)
 * تبني سياقاً تخصصياً حقيقياً من: كتالوج البرامج النشطة + برامج الطالب الفعّالة +
 * وحداتها الدراسية + الكتب المقررة المعتمدة + تقدمه ونتائجه + بحث تخرجه ومواعيده.
 */
export async function buildSupervisorContext(userId: string): Promise<string> {
  try {
    const [studentProfile, enrollments, thesis, admission, activePrograms] = await Promise.all([
      db.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, phone: true, country: true, role: true, createdAt: true },
      }),
      db.enrollment.findMany({
        where: { userId, status: { in: ['ACTIVE', 'COMPLETED'] } },
        include: {
          program: {
            include: {
              units: {
                orderBy: { order: 'asc' },
                select: {
                  title: true,
                  summary: true,
                  objectives: true,
                  semester: true,
                  status: true,
                  exam: {
                    select: {
                      title: true,
                      passScore: true,
                      questions: {
                        orderBy: { order: 'asc' },
                        take: 12,
                        select: { id: true, order: true, type: true, text: true, options: true, correctAnswer: true, modelAnswer: true, points: true },
                      },
                    },
                  },
                },
              },
              books: {
                orderBy: { createdAt: 'asc' },
                select: { title: true, titleEn: true, author: true, description: true, semester: true, textContent: true, levelPolicy: true, readingDepth: true, assessmentOrientation: true },
              },
              studyGuides: {
                where: { status: 'PUBLISHED' },
                orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
                select: { title: true, overview: true, objectives: true, keyTerms: true, discussionQuestions: true, semester: true },
              },
              assignments: {
                where: { status: 'PUBLISHED' },
                orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
                take: 12,
                select: { id: true, title: true, description: true, type: true, semester: true, points: true, weight: true, dueDays: true, rubric: true },
              },
              programExams: {
                orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
                take: 8,
                select: {
                  id: true,
                  title: true,
                  semester: true,
                  status: true,
                  passScore: true,
                  totalPoints: true,
                  durationMin: true,
                  booksUsed: true,
                  questions: {
                    where: { status: 'PUBLISHED' },
                    orderBy: { order: 'asc' },
                    take: 24,
                    select: { id: true, order: true, type: true, text: true, options: true, correctAnswer: true, modelAnswer: true, sourceEvidence: true, sourceBookTitle: true, sourceChapter: true, sourceLocator: true, cognitiveSkill: true, difficulty: true, correctRationale: true, points: true },
                  },
                },
              },
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

    const [academicMemory, recentMessages, latestAssignments, supervisorMessages, privateAssessments, recentProgramAttempts, recentUnitAttempts] = await Promise.all([
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
        take: 6,
        select: {
          answerText: true,
          status: true,
          score: true,
          feedback: true,
          fileName: true,
          submittedAt: true,
          assignment: { select: { title: true, description: true, type: true, semester: true, points: true, rubric: true, program: { select: { titleAr: true } } } },
        },
      }).catch(() => []),
      db.supervisorChannelMessage.findMany({
        where: { studentId: userId },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { senderRole: true, mode: true, content: true, createdAt: true },
      }).catch(() => []),
      db.supervisorAssessment.findMany({
        where: { studentId: userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { attempts: { where: { studentId: userId }, orderBy: { submittedAt: 'desc' }, take: 1 } },
      }).catch(() => []),
    ])

    const parts: string[] = []

    if (studentProfile) {
      parts.push(
        `بطاقة ملف الطالب الأساسية: الاسم ${studentProfile.name} — البريد ${studentProfile.email}` +
          (studentProfile.phone ? ` — الهاتف ${studentProfile.phone}` : '') +
          (studentProfile.country ? ` — الدولة ${studentProfile.country}` : '') +
          ` — الدور ${studentProfile.role} — تاريخ إنشاء الملف ${new Date(studentProfile.createdAt).toLocaleDateString('ar-EG')}`
      )
    }

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

    if (supervisorMessages.length > 0) {
      parts.push(
        `آخر مراسلات المشرف البشري مع الطالب:\n${supervisorMessages
          .slice()
          .reverse()
          .map((m) => `${m.senderRole}${m.mode === 'VOICE' ? ' (صوت)' : ''}: ${compactText(m.content, 180)}`)
          .join('\n')}`
      )
    }

    if (privateAssessments.length > 0) {
      parts.push(
        `اختبارات/تكليفات خاصة من المشرف لهذا الطالب:\n${privateAssessments.map((a: any) => {
          const attempt = a.attempts?.[0]
          return `- ${a.title} (${a.type}) — ${a.status} — ${a.totalPoints} نقطة${attempt ? ` — آخر نتيجة: ${attempt.score ?? 'بانتظار التصحيح'}% — ${attempt.feedback ? compactText(attempt.feedback, 180) : attempt.status}` : ' — لم يسلّم بعد'}`
        }).join('\n')}`
      )
    }

    if (enrollments.length === 0 && !thesis && !admission && activePrograms.length > 0) {
      const programLines = activePrograms.slice(0, 40).map((p, i) => {
        const hours = p.hours ? ` — ${p.hours} ساعة` : ''
        const price = p.price ? ` — ${p.price}$` : ''
        const desc = p.description ? ` — ${p.description.replace(/\s+/g, ' ').slice(0, 90)}` : ''
        const books = p.books.length ? ` — أمثلة مراجع: ${p.books.map((b) => `«${b.title}»`).join('، ')}` : ''
        return `${i + 1}. ${p.titleAr}${p.titleEn ? ` (${p.titleEn})` : ''} — ${p.category}${hours}${price}${desc}${books}`
      })
      parts.push(`كتالوج البرامج النشطة في النظام للزائر/الطالب غير الملتحق (${activePrograms.length} برنامج):\n${programLines.join('\n')}`)
    }

    if (enrollments.length === 0 && !thesis && !admission) {
      parts.push('الطالب لم يسجل في أي برنامج بعد — ركّز على تقديم المشورة حول برامج الأكاديمية وإجراءات الالتحاق، وابدأ بذكر البرامج عندما يسأل عنها.')
    }

    if (admission) {
      const deadline = admission.thesisDeadline
        ? new Date(admission.thesisDeadline).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' })
        : null
      const daysLeft = admission.thesisDeadline
        ? Math.ceil((new Date(admission.thesisDeadline).getTime() - Date.now()) / 86400000)
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
      const done = parseCompletedUnits(enr.completedUnits)
      const pct = totalUnits ? Math.round((done.length / totalUnits) * 100) : 0

      const unitLines = p.units.slice(0, 12).map((u, i) => {
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
        const bookNames = p.books.map((b, i) => `${i + 1}. «${b.title}»${b.author ? ` — ${b.author}` : ''}${b.semester ? ` — الفصل ${b.semester === 1 ? 'الأول' : b.semester === 2 ? 'الثاني' : b.semester}` : ' — عام'}`)
        const bookBlocks = p.books.slice(0, 8).map((b) => {
          const excerpt = (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500)
          return `- «${b.title}»${b.author ? ` (${b.author})` : ''}${b.semester ? ` — فصل ${b.semester === 1 ? 'أول' : 'ثانٍ'}` : ' — عام'}${b.description ? ` — ${b.description.slice(0, 140)}` : ''}${excerpt ? `\n  مقتطف قصير من محتواه: «${excerpt}…»` : ''}`
        })
        parts.push(`قائمة أسماء الكتب المقررة الحالية لهذا الطالب في تخصص «${p.titleAr}» — عند سؤال الطالب عن الكتب أو المراجع اذكر هذه الأسماء صراحة قبل أي شرح:\n${bookNames.join('\n')}\n\nتفاصيل مختصرة عن الكتب المقررة المعتمدة لهذا التخصص (يُمتحَن بها الطالب):\n${bookBlocks.join('\n')}`)
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

function dateToIso(value?: Date | string | null): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
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
  } catch (e) {
    console.error('student academic memory snapshot error:', e)
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
