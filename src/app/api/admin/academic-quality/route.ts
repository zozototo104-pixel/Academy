import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const dynamic = 'force-dynamic'

function parseList(value: unknown): string[] {
  if (!value) return []
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    return Array.isArray(parsed) ? parsed.map((x) => String(x || '').trim()).filter(Boolean) : []
  } catch {
    return []
  }
}

function normalizeQuestion(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[؟?.,،؛:;!\-ـ"'()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0
}

function avg(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 10) / 10 : null
}

function qualityBand(score: number): 'STRONG' | 'GOOD' | 'NEEDS_ATTENTION' | 'CRITICAL' {
  if (score >= 82) return 'STRONG'
  if (score >= 65) return 'GOOD'
  if (score >= 42) return 'NEEDS_ATTENTION'
  return 'CRITICAL'
}

function hasAcademicAssessmentMetadata(q: any): boolean {
  const hasSource = String(q.sourceEvidence || '').trim().length >= 12 &&
    String(q.sourceBookTitle || '').trim().length >= 2 &&
    String(q.sourceLocator || '').trim().length >= 8
  const hasMeasurement = ['UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE'].includes(String(q.cognitiveSkill || '')) &&
    ['EASY', 'MEDIUM', 'ADVANCED'].includes(String(q.difficulty || '')) &&
    String(q.correctRationale || '').trim().length >= 12
  const hasDistractors = q.type === 'MCQ' || q.type === 'TF'
    ? parseList(q.distractorRationales).length > 0
    : true
  return hasSource && hasMeasurement && hasDistractors
}

function detectWeakSupervisorReply(content: string): string | null {
  const text = String(content || '').replace(/\s+/g, ' ').trim()
  if (!text) return 'رد فارغ أو غير محفوظ'
  if (text.length < 60) return 'رد قصير جداً لا يكفي لتوجيه أكاديمي'
  const vaguePatterns = ['لا أعرف', 'لا استطيع', 'لا أستطيع', 'غير قادر', 'حدث خطأ', 'عذراً', 'عذرا', 'لا تتوفر لدي معلومات', 'تواصل مع الإدارة', 'راجع الإدارة']
  if (vaguePatterns.some((p) => text.includes(p))) return 'رد عام أو اعتذاري يحتاج مراجعة بشرية'
  const academicSignals = ['كتاب', 'برنامج', 'تخصص', 'مفهوم', 'مخرج', 'تعلم', 'امتحان', 'بحث', 'منهج', 'واجب', 'خطة', 'مصدر', 'دليل', 'تطبيق', 'مهارة', 'فصل']
  if (text.length > 140 && !academicSignals.some((p) => text.includes(p))) return 'رد طويل لكنه لا يحمل ربطاً أكاديمياً واضحاً'
  return null
}

function smartSupervisorLabel(mode?: string | null, kind?: string | null): string {
  if (kind === 'THESIS_REVIEW') return 'مشرف مراجعة البحث'
  if (mode === 'VOICE') return 'المشرف الصوتي'
  return 'المشرف النصي'
}

function responseTimeMetrics(chats: any[]) {
  const sorted = [...chats].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  const pending = new Map<string, Date>()
  const durations: number[] = []
  for (const msg of sorted) {
    const userId = String(msg.userId || '')
    if (!userId) continue
    const at = new Date(msg.createdAt)
    if (Number.isNaN(at.getTime())) continue
    if (msg.role === 'user') {
      pending.set(userId, at)
    } else if (msg.role === 'assistant' && pending.has(userId)) {
      const started = pending.get(userId)!
      const seconds = Math.round((at.getTime() - started.getTime()) / 1000)
      if (seconds >= 0 && seconds <= 24 * 60 * 60) durations.push(seconds)
      pending.delete(userId)
    }
  }
  return {
    averageSeconds: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    pairs: durations.length,
  }
}

export async function GET() {
  try {
    await requireAdmin()

    const memoryStore = (db as any).studentAcademicMemory
    const microCredentialStore = (db as any).microCredential
    const microCredentialAwardStore = (db as any).userMicroCredential

    const [studentsCount, programs, books, exams, questions, programAttempts, unitAttempts, chats, admissions, theses, memories, microCredentialsCount, microCredentialAwardsCount] = await Promise.all([
      db.user.count({ where: { role: 'STUDENT' } }),
      db.program.findMany({
        where: { active: true },
        orderBy: { order: 'asc' },
        select: {
          id: true,
          titleAr: true,
          category: true,
          _count: {
            select: {
              enrollments: true,
              books: true,
              knowledgeItems: true,
              studyGuides: true,
              assignments: true,
              programExams: true,
              admissions: true,
            },
          },
        },
      }),
      db.book.findMany({
        take: 400,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          semester: true,
          textContent: true,
          program: { select: { id: true, titleAr: true } },
          _count: { select: { knowledgeItems: true } },
        },
      }),
      db.programExam.findMany({
        take: 300,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          programId: true,
          title: true,
          status: true,
          semester: true,
          questions: { select: { id: true, status: true, type: true, sourceEvidence: true, sourceBookTitle: true, sourceLocator: true, cognitiveSkill: true, difficulty: true, correctRationale: true, distractorRationales: true } },
          attempts: { select: { score: true, passed: true, appealStatus: true } },
        },
      }),
      db.programQuestion.findMany({
        take: 1200,
        orderBy: { order: 'asc' },
        select: {
          id: true,
          examId: true,
          text: true,
          type: true,
          sourceEvidence: true,
          sourceBookTitle: true,
          sourceLocator: true,
          cognitiveSkill: true,
          difficulty: true,
          correctRationale: true,
          distractorRationales: true,
          status: true,
          exam: { select: { title: true, programId: true, program: { select: { titleAr: true } } } },
        },
      }),
      db.programExamAttempt.findMany({
        take: 300,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          score: true,
          passed: true,
          status: true,
          appealStatus: true,
          submittedAt: true,
          user: { select: { id: true, name: true, email: true } },
          exam: { select: { title: true, program: { select: { titleAr: true } } } },
        },
      }),
      db.examAttempt.findMany({
        take: 300,
        orderBy: { submittedAt: 'desc' },
        select: {
          id: true,
          score: true,
          passed: true,
          status: true,
          submittedAt: true,
          user: { select: { id: true, name: true, email: true } },
          exam: { select: { title: true, unit: { select: { program: { select: { titleAr: true } } } } } },
        },
      }),
      db.chatMessage.findMany({
        take: 500,
        orderBy: { createdAt: 'desc' },
        select: { id: true, userId: true, role: true, mode: true, content: true, createdAt: true },
      }),
      db.admissionApplication.findMany({
        take: 300,
        orderBy: { createdAt: 'desc' },
        select: { id: true, programId: true, program: true, status: true, aiScore: true, aiVerdict: true, createdAt: true },
      }),
      db.thesisSubmission.findMany({
        take: 300,
        orderBy: { updatedAt: 'desc' },
        select: { id: true, title: true, status: true, aiScore: true, resultScore: true, passed: true, defenseStatus: true, updatedAt: true },
      }),
      memoryStore?.findMany
        ? memoryStore.findMany({
            take: 300,
            orderBy: { updatedAt: 'desc' },
            include: { user: { select: { id: true, name: true, email: true } } },
          }).catch(() => [])
        : Promise.resolve([]),
      microCredentialStore?.count ? microCredentialStore.count({ where: { active: true } }).catch(() => 0) : Promise.resolve(0),
      microCredentialAwardStore?.count ? microCredentialAwardStore.count({ where: { valid: true } }).catch(() => 0) : Promise.resolve(0),
    ])

    const duplicateGroups = new Map<string, typeof questions>()
    for (const q of questions) {
      const key = normalizeQuestion(q.text)
      if (key.length < 18) continue
      const list = duplicateGroups.get(key) || []
      list.push(q)
      duplicateGroups.set(key, list)
    }
    const duplicateQuestions = Array.from(duplicateGroups.values())
      .filter((group) => group.length > 1)
      .slice(0, 12)
      .map((group) => ({
        text: group[0].text.slice(0, 220),
        count: group.length,
        exams: group.map((q) => q.exam.title).filter(Boolean).slice(0, 4),
        programs: Array.from(new Set(group.map((q) => q.exam.program.titleAr).filter(Boolean))).slice(0, 4),
      }))

    const questionSourceCoverage = pct(
      questions.filter((q) => String(q.sourceEvidence || '').trim().length >= 12).length,
      questions.length
    )
    const assessmentMetadataCoverage = pct(
      questions.filter((q) => hasAcademicAssessmentMetadata(q)).length,
      questions.length
    )

    const readyExams = exams.filter((e) => e.status === 'READY')
    const publishedQuestions = questions.filter((q) => q.status !== 'REJECTED')
    const programCards = programs.map((p) => {
      const programExams = exams.filter((e) => e.programId === p.id)
      const programQuestions = questions.filter((q) => q.exam.programId === p.id)
      const programReadyExams = programExams.filter((e) => e.status === 'READY')
      const programAttempts = programExams.flatMap((e) => e.attempts || [])
      const sourceCoverage = pct(programQuestions.filter((q) => String(q.sourceEvidence || '').trim().length >= 12).length, programQuestions.length)
      const metadataCoverage = pct(programQuestions.filter((q) => hasAcademicAssessmentMetadata(q)).length, programQuestions.length)
      const examPassRate = pct(programAttempts.filter((a) => a.passed === true).length, programAttempts.filter((a) => a.passed != null).length)
      const contentScore = Math.min(30, p._count.books * 8 + Math.min(14, p._count.knowledgeItems))
      const assessmentScore = Math.min(30, programReadyExams.length * 8 + Math.round(sourceCoverage / 7) + Math.round(metadataCoverage / 8))
      const supportScore = Math.min(20, p._count.studyGuides * 8 + p._count.assignments * 3)
      const demandScore = Math.min(20, p._count.enrollments * 3 + p._count.admissions * 2)
      const qualityScore = Math.max(0, Math.min(100, contentScore + assessmentScore + supportScore + demandScore))
      const warnings = [
        p._count.books === 0 ? 'لا توجد كتب مقررة' : null,
        p._count.knowledgeItems < 8 ? 'بنك المعرفة ضعيف' : null,
        programReadyExams.length === 0 ? 'لا يوجد امتحان جاهز' : null,
        sourceCoverage < 70 && programQuestions.length > 0 ? 'مصادر الأسئلة غير مكتملة' : null,
        metadataCoverage < 70 && programQuestions.length > 0 ? 'حقول القياس والتعليل غير مكتملة' : null,
        p._count.studyGuides === 0 ? 'لا يوجد دليل دراسة منشور' : null,
      ].filter(Boolean) as string[]
      return {
        id: p.id,
        titleAr: p.titleAr,
        category: p.category,
        enrollments: p._count.enrollments,
        admissions: p._count.admissions,
        books: p._count.books,
        knowledgeItems: p._count.knowledgeItems,
        studyGuides: p._count.studyGuides,
        assignments: p._count.assignments,
        exams: programExams.length,
        readyExams: programReadyExams.length,
        questions: programQuestions.length,
        sourceCoverage,
        metadataCoverage,
        examPassRate,
        qualityScore,
        band: qualityBand(qualityScore),
        warnings,
      }
    })

    const weakBooks = books
      .filter((b) => !b.textContent || b.textContent.trim().length < 1200 || b._count.knowledgeItems < 5)
      .slice(0, 12)
      .map((b) => ({
        id: b.id,
        title: b.title,
        program: b.program.titleAr,
        semester: b.semester,
        knowledgeItems: b._count.knowledgeItems,
        hasText: !!b.textContent && b.textContent.trim().length >= 1200,
        reason: !b.textContent || b.textContent.trim().length < 1200
          ? 'لم يتحول إلى نص معرفي كافٍ بعد'
          : 'عدد عناصر بنك المعرفة المستخرجة قليل',
      }))

    const appealsCount = programAttempts.filter((a) => a.appealStatus === 'PENDING').length
    const allAttemptScores = [...programAttempts.map((a) => a.score), ...unitAttempts.map((a) => a.score)]
    const failedProgramAttempts = programAttempts.filter((a) => a.passed === false || (typeof a.score === 'number' && a.score < 60)).slice(0, 8)
    const failedUnitAttempts = unitAttempts.filter((a) => a.passed === false || (typeof a.score === 'number' && a.score < 60)).slice(0, 8)

    const memoryRisks = (memories as any[])
      .map((m) => ({
        userId: m.userId,
        student: m.user?.name || 'طالب',
        email: m.user?.email || '',
        weaknesses: parseList(m.weaknesses),
        concepts: parseList(m.conceptsToReview),
        nextActions: parseList(m.recommendedNextActions),
        interactionsCount: m.interactionsCount || 0,
        lastInteractionAt: m.lastInteractionAt,
      }))
      .filter((m) => m.weaknesses.length > 0 || m.concepts.length > 0)
      .slice(0, 10)

    const atRiskStudents = [
      ...failedProgramAttempts.map((a) => ({
        userId: a.user.id,
        student: a.user.name,
        email: a.user.email,
        reason: `تعثر في ${a.exam.title}`,
        program: a.exam.program.titleAr,
        score: a.score,
        nextAction: 'جلسة علاجية قصيرة مع المشرف الذكي ثم إعادة تدريب من مصدر السؤال',
      })),
      ...failedUnitAttempts.map((a) => ({
        userId: a.user.id,
        student: a.user.name,
        email: a.user.email,
        reason: `تعثر في ${a.exam.title}`,
        program: a.exam.unit.program.titleAr,
        score: a.score,
        nextAction: 'مراجعة الوحدة قبل إعادة الاختبار',
      })),
      ...memoryRisks.map((m) => ({
        userId: m.userId,
        student: m.student,
        email: m.email,
        reason: m.weaknesses[0] || m.concepts[0] || 'ذاكرة الطالب تشير إلى حاجة متابعة',
        program: '',
        score: null,
        nextAction: m.nextActions.slice(-1)[0] || 'متابعة مخصصة مع المشرف الأكاديمي',
      })),
    ].slice(0, 12)

    const totalAssistantMessages = chats.filter((c) => c.role === 'assistant').length
    const totalUserMessages = chats.filter((c) => c.role === 'user').length
    const voiceMessages = chats.filter((c) => c.mode === 'VOICE').length
    const memoryCoverage = pct((memories as any[]).length, studentsCount)
    const avgMemoryInteractions = avg((memories as any[]).map((m) => Number(m.interactionsCount || 0))) || 0

    const admissionScores = admissions.map((a) => a.aiScore)
    const thesisScores = theses.map((t) => t.resultScore ?? t.aiScore)

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      overview: {
        activePrograms: programs.length,
        strongPrograms: programCards.filter((p) => p.band === 'STRONG').length,
        programsNeedingAttention: programCards.filter((p) => p.band === 'NEEDS_ATTENTION' || p.band === 'CRITICAL').length,
        booksNeedingKnowledge: weakBooks.length,
        readyExams: readyExams.length,
        totalQuestions: publishedQuestions.length,
        questionSourceCoverage,
        assessmentMetadataCoverage,
        duplicateQuestionGroups: duplicateQuestions.length,
        atRiskStudents: atRiskStudents.length,
        pendingAppeals: appealsCount,
        supervisorMemoryCoverage: memoryCoverage,
        microCredentials: Number(microCredentialsCount || 0),
        microCredentialAwards: Number(microCredentialAwardsCount || 0),
        avgAttemptScore: avg(allAttemptScores),
        avgAdmissionFit: avg(admissionScores),
        avgThesisScore: avg(thesisScores),
      },
      programs: programCards.sort((a, b) => a.qualityScore - b.qualityScore),
      weakBooks,
      duplicateQuestions,
      atRiskStudents,
      supervisor: {
        totalUserMessages,
        totalAssistantMessages,
        voiceMessages,
        memoryCoverage,
        avgMemoryInteractions,
        studentsWithMemory: (memories as any[]).length,
      },
      recommendations: [
        weakBooks.length > 0 ? 'ابدأ بتحويل الكتب الضعيفة إلى نص وبنك معرفة قبل توليد امتحانات جديدة.' : null,
        questionSourceCoverage < 80 ? 'راجع الأسئلة التي لا تحمل sourceEvidence واضحاً قبل نشر الامتحانات.' : null,
        assessmentMetadataCoverage < 80 ? 'استكمل حقول المهارة والصعوبة وتعليل الإجابة وأسباب خطأ الخيارات قبل نشر أي امتحان جامع.' : null,
        duplicateQuestions.length > 0 ? 'استخدم تقرير التكرار لتنظيف بنك الأسئلة ومنع تكرار الأسئلة بين الامتحانات.' : null,
        atRiskStudents.length > 0 ? 'حوّل الطلاب المتعثرين إلى خطة علاجية مع المشرف الذكي وربطها بالمفاهيم الناقصة.' : null,
        memoryCoverage < 60 ? 'شجع الطلاب على استخدام المشرف الذكي بعد كل امتحان ومهمة لزيادة تغطية الذاكرة الأكاديمية.' : null,
      ].filter(Boolean),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('academic quality error:', e)
    return NextResponse.json({ error: 'تعذر تحميل مركز الجودة الأكاديمي' }, { status: 500 })
  }
}
