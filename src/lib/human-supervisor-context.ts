import { db } from '@/lib/db'

type AssignedAdmissionRow = any

function compactText(value?: string | null, max = 240): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
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

function scoreAssignedStudent(row: AssignedAdmissionRow, query?: string | null): number {
  const q = normalizeArabic(query)
  if (!q) return 0
  const haystack = normalizeArabic([
    row.reference,
    row.fullName,
    row.email,
    row.phone,
    row.program,
    row.programRef?.titleAr,
    row.programRef?.titleEn,
    row.user?.name,
    row.user?.email,
  ].filter(Boolean).join(' '))
  return q.split(/\s+/).filter((token) => token.length >= 3).reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0)
}

function formatJsonArray(value?: string | null, max = 8): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((x) => compactText(String(x || ''), 180)).filter(Boolean).slice(-max) : []
  } catch {
    return []
  }
}

function formatBook(book: any, index: number): string {
  const title = book?.title || book?.titleEn || 'كتاب بلا عنوان'
  const desc = book?.description ? ` — وصف: ${compactText(book.description, 180)}` : ''
  const depth = book?.readingDepth ? ` — قراءة: ${compactText(book.readingDepth, 180)}` : ''
  const assessment = book?.assessmentOrientation ? ` — تقييم: ${compactText(book.assessmentOrientation, 180)}` : ''
  const knowledge = Array.isArray(book?.knowledgeItems) && book.knowledgeItems.length
    ? ` — معرفة: ${book.knowledgeItems.slice(0, 4).map((k: any) => `${k.title}: ${compactText(k.summary || k.excerpt, 100)}`).join(' | ')}`
    : ''
  return `${index + 1}. «${title}»${book.author ? ` — ${book.author}` : ''}${book.semester ? ` — فصل ${book.semester}` : ''}${desc}${depth}${assessment}${knowledge}`
}

function formatProgramAcademicContext(program: any): string {
  if (!program) return ''
  const books = Array.isArray(program.books) && program.books.length
    ? `الكتب المقررة:\n${program.books.slice(0, 14).map(formatBook).join('\n')}`
    : 'الكتب المقررة: لا توجد كتب مربوطة بهذا البرنامج في قاعدة البيانات.'
  const units = Array.isArray(program.units) && program.units.length
    ? `الوحدات/المواد:\n${program.units.slice(0, 12).map((u: any, i: number) => `${i + 1}. ${u.title}${u.semester ? ` — فصل ${u.semester}` : ''}${u.summary ? ` — ${compactText(u.summary, 140)}` : ''}${u.objectives ? ` — أهداف: ${compactText(u.objectives, 120)}` : ''}`).join('\n')}`
    : ''
  const guides = Array.isArray(program.studyGuides) && program.studyGuides.length
    ? `أدلة الدراسة:\n${program.studyGuides.slice(0, 6).map((g: any, i: number) => `${i + 1}. ${g.title} — فصل ${g.semester}: ${compactText(g.overview, 180)}${g.objectives ? ` — أهداف: ${compactText(g.objectives, 140)}` : ''}${g.keyTerms ? ` — مصطلحات: ${compactText(g.keyTerms, 120)}` : ''}`).join('\n')}`
    : ''
  const knowledge = Array.isArray(program.knowledgeItems) && program.knowledgeItems.length
    ? `قاعدة المعرفة:\n${program.knowledgeItems.slice(0, 12).map((k: any, i: number) => `${i + 1}. ${k.title}: ${compactText(k.summary, 170)}${k.book?.title ? ` — كتاب: ${k.book.title}` : ''}${k.importance != null ? ` — أهمية ${k.importance}` : ''}`).join('\n')}`
    : ''
  const safeExamSignals = Array.isArray(program.questionBankItems) && program.questionBankItems.length
    ? `مؤشرات قراءة للامتحان بلا إجابات:\n${program.questionBankItems.slice(0, 10).map((q: any) => `- ${q.sourceBookTitle || q.sourceLocator || q.type || 'مؤشر'}${q.cognitiveSkill ? ` — مهارة ${q.cognitiveSkill}` : ''}${q.difficulty ? ` — صعوبة ${q.difficulty}` : ''}${q.sourceEvidence ? ` — دليل: ${compactText(q.sourceEvidence, 120)}` : ''}`).join('\n')}`
    : ''
  return [books, units, guides, knowledge, safeExamSignals].filter(Boolean).join('\n')
}

function formatStudentMemory(memory: any): string {
  if (!memory) return ''
  const lines = [
    memory.profileDigest ? `ملخص أكاديمي: ${compactText(memory.profileDigest, 320)}` : '',
    formatJsonArray(memory.strengths).length ? `نقاط قوة: ${formatJsonArray(memory.strengths).join(' | ')}` : '',
    formatJsonArray(memory.weaknesses).length ? `نقاط ضعف: ${formatJsonArray(memory.weaknesses).join(' | ')}` : '',
    formatJsonArray(memory.conceptsToReview).length ? `مفاهيم للمراجعة: ${formatJsonArray(memory.conceptsToReview).join(' | ')}` : '',
    formatJsonArray(memory.recommendedNextActions).length ? `خطوات مقترحة: ${formatJsonArray(memory.recommendedNextActions).join(' | ')}` : '',
    memory.lastConversationSummary ? `آخر خلاصة محادثة: ${compactText(memory.lastConversationSummary, 260)}` : '',
    formatJsonArray(memory.examSignals).length ? `إشارات امتحانية: ${formatJsonArray(memory.examSignals).join(' | ')}` : '',
    formatJsonArray(memory.thesisSignals).length ? `إشارات بحث/مناقشة: ${formatJsonArray(memory.thesisSignals).join(' | ')}` : '',
  ].filter(Boolean)
  return lines.length ? lines.join('\n') : ''
}

async function loadSupervisorAssessments(studentIds: string[], supervisorId: string) {
  if (!studentIds.length) return []
  return db.supervisorAssessment.findMany({
    where: { studentId: { in: studentIds }, OR: [{ supervisorId }, { supervisorId: null }] },
    orderBy: { updatedAt: 'desc' },
    take: 20,
    select: {
      title: true,
      type: true,
      semester: true,
      status: true,
      passScore: true,
      totalPoints: true,
      studentId: true,
      attempts: {
        orderBy: { submittedAt: 'desc' },
        take: 3,
        select: { status: true, score: true, passed: true, feedback: true, submittedAt: true, gradedAt: true },
      },
    },
  }).catch(() => [])
}

async function loadSupervisorMessages(studentIds: string[], supervisorId: string) {
  if (!studentIds.length) return []
  return db.supervisorChannelMessage.findMany({
    where: { studentId: { in: studentIds }, OR: [{ supervisorId }, { supervisorId: null }] },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { studentId: true, senderRole: true, mode: true, content: true, createdAt: true },
  }).catch(() => [])
}

export async function buildHumanSupervisorAssignedStudentsContext(supervisorId: string, query?: string | null): Promise<string> {
  const admissions = await db.admissionApplication.findMany({
    where: { supervisorId },
    orderBy: [{ supervisorAt: 'desc' }, { createdAt: 'desc' }],
    take: 40,
    select: {
      id: true,
      reference: true,
      fullName: true,
      email: true,
      phone: true,
      country: true,
      education: true,
      program: true,
      status: true,
      userId: true,
      supervisorAt: true,
      thesisDeadline: true,
      approvedAt: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          country: true,
          academicMemory: true,
          chatMessages: { orderBy: { createdAt: 'desc' }, take: 6, select: { role: true, content: true, mode: true, createdAt: true } },
          examAttempts: { orderBy: { submittedAt: 'desc' }, take: 6, select: { score: true, passed: true, status: true, feedback: true, submittedAt: true, exam: { select: { title: true, unit: { select: { title: true } } } } } },
          programExamAttempts: { orderBy: { createdAt: 'desc' }, take: 6, select: { score: true, passed: true, status: true, feedback: true, finalScore: true, appealStatus: true, submittedAt: true, exam: { select: { title: true, semester: true, booksUsed: true } } } },
          assignmentSubmissions: { orderBy: { submittedAt: 'desc' }, take: 6, select: { status: true, score: true, feedback: true, submittedAt: true, assignment: { select: { title: true, type: true, semester: true } } } },
          theses: { orderBy: { updatedAt: 'desc' }, take: 3, select: { title: true, status: true, aiScore: true, resultScore: true, passed: true, reviewNote: true, updatedAt: true } },
        },
      },
      programRef: {
        select: {
          titleAr: true,
          titleEn: true,
          category: true,
          books: {
            orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
            take: 16,
            select: { title: true, titleEn: true, author: true, semester: true, description: true, readingDepth: true, assessmentOrientation: true, levelPolicy: true, knowledgeItems: { orderBy: [{ importance: 'desc' }, { createdAt: 'asc' }], take: 6, select: { title: true, summary: true, excerpt: true, importance: true } } },
          },
          units: { orderBy: [{ semester: 'asc' }, { order: 'asc' }], take: 14, select: { title: true, semester: true, summary: true, objectives: true, status: true } },
          studyGuides: { where: { status: 'PUBLISHED' }, orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }], take: 8, select: { title: true, semester: true, overview: true, objectives: true, keyTerms: true } },
          knowledgeItems: { orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }], take: 16, select: { title: true, summary: true, excerpt: true, importance: true, category: true, book: { select: { title: true } } } },
          questionBankItems: { where: { status: 'APPROVED' }, orderBy: [{ qualityScore: 'desc' }, { updatedAt: 'desc' }], take: 14, select: { sourceEvidence: true, sourceBookTitle: true, sourceLocator: true, cognitiveSkill: true, difficulty: true, type: true } },
        },
      },
      theses: { orderBy: { updatedAt: 'desc' }, take: 3, select: { title: true, status: true, aiScore: true, resultScore: true, passed: true, reviewNote: true, updatedAt: true } },
    },
  }).catch(() => [])

  if (!admissions.length) return 'لا يوجد طلاب معيّنون لهذا المشرف البشري حالياً.'

  const ranked = [...admissions]
    .map((row) => ({ row, score: scoreAssignedStudent(row, query) }))
    .sort((a, b) => (b.score - a.score) || String(a.row.fullName || '').localeCompare(String(b.row.fullName || ''), 'ar'))
  const selected = ranked.filter((item) => item.score > 0).slice(0, 6)
  const rows = (selected.length ? selected : ranked.slice(0, 8)).map((item) => item.row)
  const studentIds = rows.map((row) => row.userId).filter(Boolean) as string[]
  const [assessments, messages] = await Promise.all([
    loadSupervisorAssessments(studentIds, supervisorId),
    loadSupervisorMessages(studentIds, supervisorId),
  ])

  const blocks = rows.map((row, index) => {
    const studentId = row.userId
    const user = row.user
    const program = row.programRef
    const memory = formatStudentMemory(user?.academicMemory)
    const examAttempts = user?.examAttempts?.length
      ? `امتحانات الوحدات المسلّمة:\n${user.examAttempts.map((a: any) => `- ${a.exam?.title || 'امتحان'} / ${a.exam?.unit?.title || 'وحدة'} — ${a.status}${a.score != null ? ` — ${a.score}` : ''}${a.passed != null ? ` — ${a.passed ? 'ناجح' : 'غير ناجح'}` : ''}${a.feedback ? ` — تغذية: ${compactText(a.feedback, 180)}` : ''}`).join('\n')}`
      : ''
    const programAttempts = user?.programExamAttempts?.length
      ? `امتحانات البرنامج بعد التسليم:\n${user.programExamAttempts.map((a: any) => `- ${a.exam?.title || 'امتحان برنامج'} — فصل ${a.exam?.semester || 'غير محدد'} — ${a.status}${a.score != null ? ` — الدرجة ${a.score}` : ''}${a.finalScore != null ? ` — النهائية ${a.finalScore}` : ''}${a.passed != null ? ` — ${a.passed ? 'ناجح' : 'غير ناجح'}` : ''}${a.feedback ? ` — تغذية: ${compactText(a.feedback, 180)}` : ''}${a.appealStatus && a.appealStatus !== 'NONE' ? ` — اعتراض: ${a.appealStatus}` : ''}`).join('\n')}`
      : ''
    const assignments = user?.assignmentSubmissions?.length
      ? `الواجبات المسلّمة:\n${user.assignmentSubmissions.map((s: any) => `- ${s.assignment?.title || 'واجب'} (${s.assignment?.type || 'نوع'}) — ${s.status}${s.score != null ? ` — ${s.score}` : ''}${s.feedback ? ` — تغذية: ${compactText(s.feedback, 160)}` : ''}`).join('\n')}`
      : ''
    const humanAssessments = assessments.filter((a: any) => a.studentId === studentId)
    const assessmentBlock = humanAssessments.length
      ? `اختبارات/تقييمات المشرف البشري دون مفاتيح إجابات:\n${humanAssessments.map((a: any) => `- ${a.title} (${a.type}) — ${a.status} — نجاح من ${a.passScore}%${a.attempts?.length ? ` — آخر محاولات: ${a.attempts.map((t: any) => `${t.status}${t.score != null ? `/${t.score}` : ''}${t.passed != null ? `/${t.passed ? 'ناجح' : 'غير ناجح'}` : ''}`).join(' | ')}` : ''}`).join('\n')}`
      : ''
    const messageBlock = messages.filter((m: any) => m.studentId === studentId).slice(0, 6).length
      ? `آخر رسائل قناة الإشراف:\n${messages.filter((m: any) => m.studentId === studentId).slice(0, 6).map((m: any) => `- ${m.senderRole}${m.mode === 'VOICE' ? ' صوت' : ''}: ${compactText(m.content, 180)}`).join('\n')}`
      : ''
    const theses = (row.theses?.length ? row.theses : user?.theses || []).length
      ? `بحث التخرج:\n${(row.theses?.length ? row.theses : user?.theses || []).map((t: any) => `- ${t.title} — ${t.status}${t.resultScore != null ? ` — نتيجة ${t.resultScore}` : ''}${t.aiScore != null ? ` — تقييم ذكي ${t.aiScore}` : ''}${t.reviewNote ? ` — ملاحظة: ${compactText(t.reviewNote, 160)}` : ''}`).join('\n')}`
      : ''

    return [
      `طالب معيّن ${index + 1}: ${row.fullName} — مرجع ${row.reference} — حالة الطلب ${row.status}`,
      `بيانات التواصل: ${row.email}${row.phone ? ` — ${row.phone}` : ''}${row.country ? ` — ${row.country}` : ''}`,
      `البرنامج: ${row.programRef?.titleAr || row.program}${row.programRef?.category ? ` — ${row.programRef.category}` : ''}${row.thesisDeadline ? ` — مهلة البحث ${new Date(row.thesisDeadline).toLocaleDateString('ar-EG')}` : ''}`,
      `حدود الوصول: هذا الطالب ظاهر لأن admission.supervisorId يساوي حساب المشرف الحالي. لا تستخدم بيانات طلاب آخرين غير واردين هنا. لا تكشف مفاتيح إجابات أو إجابات نموذجية قبل التسليم.`,
      program ? formatProgramAcademicContext(program) : '',
      memory ? `ذاكرة الطالب الأكاديمية:\n${memory}` : '',
      examAttempts,
      programAttempts,
      assignments,
      assessmentBlock,
      theses,
      messageBlock,
    ].filter(Boolean).join('\n')
  })

  return [
    'سياق المشرف البشري الآمن: المعلومات التالية تخص فقط الطلاب المعيّنين لهذا المشرف في AdmissionApplication.supervisorId. يمنع استخدامها لتعميم الوصول إلى طلاب آخرين أو لكشف مفاتيح الإجابات.',
    `عدد الطلاب المعيّنين المحمّلين في هذا السياق: ${rows.length} من أصل ${admissions.length}.`,
    blocks.join('\n\n---\n\n'),
  ].join('\n\n').slice(0, 36000)
}
