import { NextRequest, NextResponse } from 'next/server'
import { performance } from 'perf_hooks'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { hashPassword } from '@/lib/password'
import { buildSupervisorContext } from '@/lib/supervisor-ai'
import { platformAgentComplete } from '@/lib/platform-agent'
import {
  ensureGeminiKey,
  geminiActiveLiveModel,
  geminiActiveTextModel,
  geminiApiKey,
  geminiDiscussionThinkingLevel,
  geminiTTSVoice,
  isValidGeminiLiveModel,
  type GeminiLivePurpose,
} from '@/lib/gemini'
import { appVersion, serviceConfigurationStatus } from '@/lib/monitoring'
import { textAiDiagnostics } from '@/lib/text-ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type ProbeKind = 'PROFILE' | 'CURRICULUM' | 'THESIS' | 'DEFENSE'
const ALL_PROBE_KINDS: ProbeKind[] = ['PROFILE', 'CURRICULUM', 'THESIS', 'DEFENSE']

function selectedProbeKinds(body: any): ProbeKind[] {
  const raw = Array.isArray(body?.probeKinds) ? body.probeKinds : body?.probeKind ? [body.probeKind] : ALL_PROBE_KINDS
  const selected = raw.filter((kind: unknown): kind is ProbeKind => ALL_PROBE_KINDS.includes(kind as ProbeKind))
  return selected.length ? selected : ALL_PROBE_KINDS
}

function normalizeArabic(text: string) {
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

function compact(value: unknown, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function keywordHits(reply: string, expected: string[]) {
  const n = normalizeArabic(reply)
  const filtered = expected.map((x) => compact(x, 80)).filter((x) => x.length >= 3)
  const hits = filtered.filter((x) => n.includes(normalizeArabic(x)))
  return {
    expected: filtered,
    hits,
    missed: filtered.filter((x) => !hits.includes(x)),
    score: filtered.length ? Math.round((hits.length / filtered.length) * 100) : 100,
  }
}

function isGenericFallbackReply(reply: string) {
  const n = normalizeArabic(reply)
  return [
    'وضح لي هل سوالك عن برنامج',
    'ساعطيك جوابا مباشرا',
    'هل سوالك عن برنامج معين الرسوم الشهاده الاعتماد او خطوات التسجيل',
  ].some((phrase) => n.includes(normalizeArabic(phrase)))
}

function expectedAgentForProbe(kind: ProbeKind) {
  if (kind === 'PROFILE' || kind === 'CURRICULUM') return 'ACADEMIC_SUPERVISOR'
  if (kind === 'THESIS' || kind === 'DEFENSE') return 'THESIS_DEFENSE'
  return null
}

function hasGroundingForProbe(kind: ProbeKind, reply: string, student: Awaited<ReturnType<typeof findDiagnosticStudent>>) {
  if (!student) return false
  const n = normalizeArabic(reply)
  const enrollment = student.enrollments[0]
  const program = enrollment?.program
  const thesis = student.theses[0]
  const admission = student.ownedAdmissions[0]
  const programTitle = program?.titleAr ? normalizeArabic(program.titleAr) : ''
  const firstBook = program?.books?.[0]?.title ? normalizeArabic(program.books[0].title) : ''
  const firstUnit = program?.units?.[0]?.title ? normalizeArabic(program.units[0].title) : ''
  const thesisTitle = thesis?.title ? normalizeArabic(thesis.title) : ''
  const reference = admission?.reference ? normalizeArabic(admission.reference) : ''

  if (kind === 'PROFILE') return [normalizeArabic(student.name || ''), programTitle, reference].filter(Boolean).some((x) => n.includes(x))
  if (kind === 'CURRICULUM') return [programTitle, firstBook, firstUnit].filter(Boolean).some((x) => n.includes(x))
  if (kind === 'THESIS') return !!thesisTitle && (n.includes(thesisTitle) || (n.includes('منهجيه') && n.includes('نتائج')))
  if (kind === 'DEFENSE') return !!thesisTitle && (
    n.includes(thesisTitle)
    || n.includes('موشرات المخاطر')
    || n.includes('الحوكمه الموسسيه')
    || n.includes('الحوكمه المؤسسيه')
  )
  return false
}

function elapsed(start: number) {
  return Math.round(performance.now() - start)
}

const diagnosticStudentInclude = {
  enrollments: {
    where: { status: { in: ['ACTIVE', 'COMPLETED'] } },
    take: 3,
    orderBy: { updatedAt: 'desc' as const },
    include: {
      program: {
        include: {
          units: { take: 12, orderBy: { order: 'asc' as const }, select: { title: true } },
          books: { take: 8, orderBy: { createdAt: 'asc' as const }, select: { title: true, author: true } },
          studyGuides: { take: 4, where: { status: 'PUBLISHED' }, select: { title: true } },
        },
      },
    },
  },
  theses: { take: 1, orderBy: { updatedAt: 'desc' as const }, select: { title: true, status: true, resultScore: true, aiScore: true, defenseDate: true } },
  ownedAdmissions: { take: 1, orderBy: { createdAt: 'desc' as const }, select: { reference: true, program: true, status: true, thesisDeadline: true } },
  academicMemory: true,
}

function diagnosticStudentScore(student: any): number {
  const enrollmentScores = (student.enrollments || []).map((enr: any) => {
    const p = enr.program
    if (!p) return 0
    return 60 + Math.min((p.units || []).length, 12) * 12 + Math.min((p.books || []).length, 8) * 18 + Math.min((p.studyGuides || []).length, 4) * 14
  })
  const enrollmentScore = enrollmentScores.length ? Math.max(...enrollmentScores) : 0
  const thesisScore = student.theses?.[0] ? 45 : 0
  const admissionScore = student.ownedAdmissions?.[0] ? 10 : 0
  const memory = student.academicMemory
  const memoryScore = memory
    ? [memory.profileDigest, memory.lastConversationSummary, memory.lastFileAnalysis, memory.examSignals, memory.thesisSignals].filter(Boolean).length * 8
    : 0
  return enrollmentScore + thesisScore + admissionScore + memoryScore
}

function chooseBestDiagnosticStudent<T extends any>(students: T[]): T | null {
  if (!students.length) return null
  return students
    .slice()
    .sort((a: any, b: any) => diagnosticStudentScore(b) - diagnosticStudentScore(a) || new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())[0]
}

const LAUNCH_QUALITY_EMAIL = 'launch.quality.student@aact.test'
const LAUNCH_QUALITY_PROGRAM_SLUG = 'launch-quality-diagnostic-program'
const LAUNCH_QUALITY_REFERENCE = 'AACT-LAUNCH-QUALITY'

async function ensureLaunchQualityDiagnosticStudent() {
  const password = hashPassword(`launch-quality-${process.env.NEXTAUTH_SECRET || 'local'}`)
  const program = await db.program.upsert({
    where: { slug: LAUNCH_QUALITY_PROGRAM_SLUG },
    update: {
      titleAr: 'برنامج فحص جاهزية الإطلاق في الحوكمة وإدارة المخاطر',
      titleEn: 'Launch Quality Diagnostic Program',
      description: 'برنامج داخلي ثابت لفحص قدرة المشرف الذكي على قراءة ملف الطالب والمنهج والكتب والبحث قبل الإطلاق. لا يظهر كتخصص مفتوح للتسجيل العام.',
      category: 'DIPLOMA',
      hours: 60,
      price: 0,
      active: false,
      registrationStatus: 'CLOSED',
      academicReadinessStatus: 'APPROVED',
      academicApproved: true,
      semestersCount: 2,
    },
    create: {
      slug: LAUNCH_QUALITY_PROGRAM_SLUG,
      titleAr: 'برنامج فحص جاهزية الإطلاق في الحوكمة وإدارة المخاطر',
      titleEn: 'Launch Quality Diagnostic Program',
      description: 'برنامج داخلي ثابت لفحص قدرة المشرف الذكي على قراءة ملف الطالب والمنهج والكتب والبحث قبل الإطلاق. لا يظهر كتخصص مفتوح للتسجيل العام.',
      category: 'DIPLOMA',
      hours: 60,
      price: 0,
      icon: 'shield-check',
      features: JSON.stringify(['حوكمة المخاطر', 'اختبار سياق المشرف الذكي', 'تحقق من البحث والمناقشة']),
      order: 9999,
      active: false,
      registrationStatus: 'CLOSED',
      academicReadinessStatus: 'APPROVED',
      academicApproved: true,
      semestersCount: 2,
    },
  })

  const [book, unit1, unit2] = await Promise.all([
    db.book.findFirst({ where: { programId: program.id, title: 'دليل الحوكمة وإدارة المخاطر المؤسسية' } }).then((existing) => existing || db.book.create({
      data: {
        programId: program.id,
        title: 'دليل الحوكمة وإدارة المخاطر المؤسسية',
        titleEn: 'Governance and Enterprise Risk Management Guide',
        author: 'AACT Academic Quality Office',
        year: '2026',
        semester: 1,
        description: 'كتاب مقرر يشرح مبادئ الحوكمة، سجل المخاطر، الضوابط الداخلية، ومؤشرات قياس فعالية الرقابة.',
        textContent: 'يركز الكتاب على ربط الحوكمة بإدارة المخاطر المؤسسية عبر تحديد السياق، بناء سجل مخاطر، تقييم الاحتمالية والأثر، تصميم الضوابط، ثم متابعة مؤشرات الأداء والمخاطر الرئيسية. يجب على الطالب فهم الفرق بين الخطر المتأصل والخطر المتبقي، وكيفية صياغة خطة معالجة واقعية.',
        levelPolicy: 'مناسب لفحص جاهزية المشرف الذكي على مستوى دبلوم مهني تطبيقي.',
        readingDepth: 'يركز الطالب على المفاهيم الأساسية، أمثلة سجل المخاطر، ومبررات اختيار الضوابط.',
        assessmentOrientation: 'الأسئلة تقيس الفهم والتطبيق والتحليل في حالة حوكمة عملية.',
        linkReadStatus: 'TEXT_EXTRACTED',
        linkReadNote: 'محتوى تشخيصي داخلي محفوظ نصياً للفحص.',
        source: 'ADMIN',
      },
    })),
    db.unit.findFirst({ where: { programId: program.id, title: 'مدخل إلى الحوكمة وإدارة المخاطر' } }).then((existing) => existing || db.unit.create({
      data: {
        programId: program.id,
        order: 1,
        semester: 1,
        status: 'APPROVED',
        title: 'مدخل إلى الحوكمة وإدارة المخاطر',
        summary: 'تعرّف الوحدة الطالب بمبادئ الحوكمة، أدوار المسؤولية، وخريطة المخاطر المؤسسية.',
        content: JSON.stringify([{ heading: 'الحوكمة والمخاطر', body: 'الحوكمة تحدد المسؤوليات، وإدارة المخاطر تحول عدم اليقين إلى قرارات قابلة للقياس.' }]),
        objectives: JSON.stringify(['يميز بين الحوكمة والإدارة التشغيلية', 'يبني وصفاً أولياً لسجل المخاطر', 'يفسر أثر الضوابط على الخطر المتبقي']),
      },
    })),
    db.unit.findFirst({ where: { programId: program.id, title: 'تحليل الضوابط ومؤشرات المخاطر' } }).then((existing) => existing || db.unit.create({
      data: {
        programId: program.id,
        order: 2,
        semester: 1,
        status: 'APPROVED',
        title: 'تحليل الضوابط ومؤشرات المخاطر',
        summary: 'تركز الوحدة على تصميم الضوابط، مؤشرات الإنذار المبكر، وربطها بالتوصيات العملية.',
        content: JSON.stringify([{ heading: 'الضوابط والمؤشرات', body: 'الضابط الجيد يملك مالكاً واضحاً ومؤشر قياس وحداً للتصعيد عند الانحراف.' }]),
        objectives: JSON.stringify(['يصمم مؤشرات مخاطر رئيسية', 'يربط الضوابط بالتوصيات', 'يقيم فعالية خطة المعالجة']),
      },
    })),
  ])

  await db.bookKnowledgeItem.findFirst({ where: { programId: program.id, title: 'الخطر المتأصل والخطر المتبقي' } }).then((existing) => existing || db.bookKnowledgeItem.create({
    data: {
      programId: program.id,
      bookId: book.id,
      semester: 1,
      category: 'CONCEPT',
      title: 'الخطر المتأصل والخطر المتبقي',
      summary: 'الخطر المتأصل هو مستوى الخطر قبل الضوابط، أما الخطر المتبقي فهو ما يبقى بعد تطبيق الضوابط وخطط المعالجة.',
      excerpt: 'ينبغي عدم الخلط بين تقييم الخطر قبل الضوابط وبعدها عند بناء سجل المخاطر.',
      keywords: JSON.stringify(['الحوكمة', 'الخطر المتأصل', 'الخطر المتبقي', 'الضوابط']),
      importance: 92,
      sourceNote: 'مستخلص من دليل الحوكمة وإدارة المخاطر المؤسسية.',
    },
  }))

  await (db.programStudyGuide as any).upsert({
    where: { programId_semester: { programId: program.id, semester: 1 } },
    update: {
      title: 'دليل دراسة الفصل الأول: الحوكمة والمخاطر',
      overview: 'يركز هذا الدليل على قراءة الكتاب المقرر، فهم سجل المخاطر، وتطبيق الضوابط على حالة عملية.',
      objectives: JSON.stringify(['تلخيص مفاهيم الحوكمة', 'تحليل سجل مخاطر', 'اقتراح ضوابط قابلة للقياس']),
      keyTerms: JSON.stringify(['الحوكمة', 'سجل المخاطر', 'الخطر المتبقي', 'مؤشرات المخاطر']),
      sections: JSON.stringify(['مفاهيم أساسية', 'تطبيقات عملية', 'أسئلة مراجعة']),
      discussionQuestions: JSON.stringify(['لماذا لا يكفي وجود ضابط دون مؤشر قياس؟', 'كيف تشرح الفرق بين الخطر المتأصل والمتبقي؟']),
      status: 'PUBLISHED',
    },
    create: {
      programId: program.id,
      semester: 1,
      title: 'دليل دراسة الفصل الأول: الحوكمة والمخاطر',
      overview: 'يركز هذا الدليل على قراءة الكتاب المقرر، فهم سجل المخاطر، وتطبيق الضوابط على حالة عملية.',
      objectives: JSON.stringify(['تلخيص مفاهيم الحوكمة', 'تحليل سجل مخاطر', 'اقتراح ضوابط قابلة للقياس']),
      keyTerms: JSON.stringify(['الحوكمة', 'سجل المخاطر', 'الخطر المتبقي', 'مؤشرات المخاطر']),
      sections: JSON.stringify(['مفاهيم أساسية', 'تطبيقات عملية', 'أسئلة مراجعة']),
      activities: JSON.stringify(['ارسم سجل مخاطر مختصر', 'اكتب توصية رقابية قابلة للتنفيذ']),
      discussionQuestions: JSON.stringify(['لماذا لا يكفي وجود ضابط دون مؤشر قياس؟', 'كيف تشرح الفرق بين الخطر المتأصل والمتبقي؟']),
      status: 'PUBLISHED',
      generatedBy: 'ADMIN',
    },
  })

  const unitExam = await (db.exam as any).upsert({
    where: { unitId: unit1.id },
    update: { title: 'اختبار وحدة الحوكمة والمخاطر', passScore: 60 },
    create: { unitId: unit1.id, title: 'اختبار وحدة الحوكمة والمخاطر', passScore: 60 },
  })
  const unitQuestion = await db.question.findFirst({ where: { examId: unitExam.id, order: 1 } }).then((existing) => existing || db.question.create({
    data: {
      examId: unitExam.id,
      order: 1,
      type: 'MCQ',
      text: 'ما الفرق الصحيح بين الخطر المتأصل والخطر المتبقي؟',
      options: JSON.stringify(['الخطر المتأصل بعد الضوابط والمتبقي قبلها', 'الخطر المتأصل قبل الضوابط والمتبقي بعد تطبيق الضوابط', 'لا فرق بينهما', 'الخطر المتبقي لا يقاس']),
      correctAnswer: '1',
      modelAnswer: 'الخطر المتأصل يسبق الضوابط، والخطر المتبقي هو مستوى الخطر بعد تطبيق الضوابط وخطط المعالجة.',
      points: 10,
    },
  }))

  const assignment = await db.programAssignment.findFirst({ where: { programId: program.id, title: 'تحليل حالة سجل مخاطر' } }).then((existing) => existing || db.programAssignment.create({
    data: {
      programId: program.id,
      title: 'تحليل حالة سجل مخاطر',
      description: 'حلل حالة مؤسسة لديها تأخر في متابعة الضوابط، وحدد ثلاثة مخاطر وضابطاً ومؤشر قياس لكل خطر.',
      semester: 1,
      type: 'CASE_STUDY',
      points: 20,
      weight: 10,
      dueDays: 14,
      rubric: JSON.stringify(['وضوح وصف الخطر', 'دقة الربط بين الضابط والخطر', 'قابلية مؤشر القياس للتطبيق']),
      status: 'PUBLISHED',
    },
  }))

  const programExam = await db.programExam.findFirst({ where: { programId: program.id, title: 'امتحان شامل في الحوكمة وإدارة المخاطر' } }).then((existing) => existing || db.programExam.create({
    data: {
      programId: program.id,
      title: 'امتحان شامل في الحوكمة وإدارة المخاطر',
      status: 'READY',
      semester: 1,
      durationMin: 120,
      passScore: 60,
      totalPoints: 20,
      booksUsed: 'دليل الحوكمة وإدارة المخاطر المؤسسية',
      generatedBy: 'ADMIN',
    },
  }))
  const programQuestion = await db.programQuestion.findFirst({ where: { examId: programExam.id, order: 1 } }).then((existing) => existing || db.programQuestion.create({
    data: {
      examId: programExam.id,
      order: 1,
      type: 'MCQ',
      text: 'أي عبارة تشرح دور مؤشرات المخاطر الرئيسية في الحوكمة؟',
      options: JSON.stringify(['هي بديل عن الضوابط', 'تساعد على الإنذار المبكر وقياس فعالية الضوابط', 'تستخدم فقط بعد وقوع الخطر', 'لا علاقة لها بمتابعة المخاطر']),
      correctAnswer: '1',
      modelAnswer: 'مؤشرات المخاطر الرئيسية تستخدم للإنذار المبكر وقياس اتجاه الخطر وفعالية الضوابط قبل تفاقم المشكلة.',
      sourceEvidence: 'الكتاب يربط بين الضوابط، المالك المسؤول، وحد التصعيد عند الانحراف.',
      sourceBookTitle: 'دليل الحوكمة وإدارة المخاطر المؤسسية',
      sourceChapter: 'الضوابط والمؤشرات',
      sourceLocator: 'قسم مؤشرات المخاطر',
      cognitiveSkill: 'APPLY',
      difficulty: 'MEDIUM',
      correctRationale: 'لأن المؤشر لا يستبدل الضابط، بل يقيس فعاليته ويوفر إنذاراً مبكراً.',
      points: 20,
      status: 'PUBLISHED',
    },
  }))

  const user = await db.user.upsert({
    where: { email: LAUNCH_QUALITY_EMAIL },
    update: { name: 'طالب فحص جاهزية الإطلاق', role: 'STUDENT', status: 'ACTIVE', country: 'QA', phone: '+0000000000' },
    create: { email: LAUNCH_QUALITY_EMAIL, password, name: 'طالب فحص جاهزية الإطلاق', role: 'STUDENT', status: 'ACTIVE', country: 'QA', phone: '+0000000000' },
  })

  await (db.enrollment as any).upsert({
    where: { userId_programId: { userId: user.id, programId: program.id } },
    update: { status: 'ACTIVE', completedUnits: JSON.stringify([unit1.id]), examReadiness: JSON.stringify([1]), finalScore: 88 },
    create: { userId: user.id, programId: program.id, status: 'ACTIVE', completedUnits: JSON.stringify([unit1.id]), examReadiness: JSON.stringify([1]), finalScore: 88 },
  })

  const admission = await db.admissionApplication.upsert({
    where: { reference: LAUNCH_QUALITY_REFERENCE },
    update: {
      fullName: user.name,
      email: user.email,
      phone: user.phone || '+0000000000',
      country: user.country || 'QA',
      education: 'BACHELOR',
      program: program.titleAr,
      programId: program.id,
      status: 'THESIS',
      userId: user.id,
      acknowledged: true,
      acknowledgedAt: new Date(),
      thesisDeadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 120),
      documents: JSON.stringify(['هوية تشخيصية داخلية', 'شهادة قبول تجريبية']),
    },
    create: {
      reference: LAUNCH_QUALITY_REFERENCE,
      fullName: user.name,
      email: user.email,
      phone: user.phone || '+0000000000',
      country: user.country || 'QA',
      education: 'BACHELOR',
      program: program.titleAr,
      programId: program.id,
      status: 'THESIS',
      userId: user.id,
      documents: JSON.stringify(['هوية تشخيصية داخلية', 'شهادة قبول تجريبية']),
      notes: 'طلب داخلي ثابت لفحص جودة الوكيل الذكي قبل الإطلاق.',
      acknowledged: true,
      acknowledgedAt: new Date(),
      thesisDeadline: new Date(Date.now() + 1000 * 60 * 60 * 24 * 120),
    },
  })

  await db.assignmentSubmission.upsert({
    where: { assignmentId_userId: { assignmentId: assignment.id, userId: user.id } },
    update: {
      answerText: 'حددت ثلاثة مخاطر: ضعف متابعة الضوابط، غياب مؤشر إنذار مبكر، وعدم وضوح مالك الخطر. أوصي بتعيين مالك لكل ضابط وبناء مؤشر تصعيد شهري.',
      status: 'GRADED',
      score: 17,
      feedback: 'إجابة جيدة، لكنها تحتاج توضيحاً أكبر للفرق بين مؤشر الأداء ومؤشر الخطر.',
      gradedBy: 'AI',
      gradedAt: new Date(),
    },
    create: {
      assignmentId: assignment.id,
      userId: user.id,
      answerText: 'حددت ثلاثة مخاطر: ضعف متابعة الضوابط، غياب مؤشر إنذار مبكر، وعدم وضوح مالك الخطر. أوصي بتعيين مالك لكل ضابط وبناء مؤشر تصعيد شهري.',
      status: 'GRADED',
      score: 17,
      feedback: 'إجابة جيدة، لكنها تحتاج توضيحاً أكبر للفرق بين مؤشر الأداء ومؤشر الخطر.',
      gradedBy: 'AI',
      gradedAt: new Date(),
    },
  })

  const existingUnitAttempt = await db.examAttempt.findFirst({ where: { userId: user.id, examId: unitExam.id } })
  if (!existingUnitAttempt) {
    const attempt = await db.examAttempt.create({ data: { userId: user.id, examId: unitExam.id, score: 100, passed: true, status: 'GRADED', feedback: 'فهم جيد للتمييز بين الخطر المتأصل والمتبقي.', aiGraded: true } })
    await db.answer.create({ data: { attemptId: attempt.id, questionId: unitQuestion.id, selectedOption: 1, isCorrect: true, points: 10, maxPoints: 10, aiFeedback: 'إجابة صحيحة لأن الضوابط تقلل الخطر المتبقي ولا تغيّر تعريف الخطر المتأصل.' } })
  }

  const existingProgramAttempt = await db.programExamAttempt.findFirst({ where: { userId: user.id, examId: programExam.id } })
  if (!existingProgramAttempt) {
    const attempt = await db.programExamAttempt.create({ data: { userId: user.id, examId: programExam.id, score: 85, finalScore: 85, passed: true, status: 'GRADED', feedback: 'الطالب يفهم وظيفة مؤشرات المخاطر، ويحتاج مزيداً من أمثلة التصعيد العملي.', durationUsedMin: 42, submittedAt: new Date() } })
    await db.programAnswer.create({ data: { attemptId: attempt.id, questionId: programQuestion.id, selectedOption: 1, isCorrect: true, points: 20, maxPoints: 20, aiFeedback: 'صحيح؛ المؤشر يقيس اتجاه الخطر وفعالية الضوابط ولا يستبدلها.' } })
  }

  await db.thesisSubmission.findFirst({ where: { userId: user.id, title: 'أثر مؤشرات المخاطر الرئيسية على فعالية الحوكمة المؤسسية' } }).then((existing) => existing || db.thesisSubmission.create({
    data: {
      userId: user.id,
      admissionId: admission.id,
      title: 'أثر مؤشرات المخاطر الرئيسية على فعالية الحوكمة المؤسسية',
      abstract: 'يحلل البحث كيف تساعد مؤشرات المخاطر الرئيسية في تحسين قرارات الحوكمة وتوجيه الضوابط الداخلية قبل تفاقم المخاطر.',
      fileNote: 'بحث تشخيصي داخلي لفحص سياق المشرف الذكي.',
      status: 'RESULT_APPROVED',
      defenseDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
      committee: JSON.stringify(['خبير الحوكمة', 'خبير إدارة المخاطر', 'المستشار الذكي']),
      aiScore: 88,
      aiRecommendation: 'يوصى بالنجاح مع تحسين ربط المؤشرات بخطة التصعيد.',
      defenseStatus: 'COMPLETED',
      defenseCompletedAt: new Date(),
      defenseMinutes: 'ناقشت اللجنة الفرق بين مؤشرات الأداء ومؤشرات المخاطر، وطلبت أمثلة تطبيقية على حدود التصعيد.',
      resultScore: 87,
      passed: true,
      reviewedAt: new Date(),
    },
  }))

  await db.studentAcademicMemory.upsert({
    where: { userId: user.id },
    update: {
      profileDigest: 'طالب تشخيصي في برنامج الحوكمة وإدارة المخاطر، يركز على فهم الكتب المقررة والواجبات والبحث قبل الإطلاق.',
      strengths: JSON.stringify(['يفهم مفهوم الضوابط', 'يربط المؤشرات بالتوصيات']),
      weaknesses: JSON.stringify(['يحتاج أمثلة أكثر على حدود التصعيد', 'يميل للخلط بين KPI وKRI']),
      conceptsToReview: JSON.stringify(['الخطر المتأصل والمتبقي', 'مؤشرات المخاطر الرئيسية', 'تصعيد الضوابط']),
      recommendedNextActions: JSON.stringify(['مراجعة الكتاب المقرر', 'حل حالة سجل مخاطر إضافية', 'تحضير إجابة مناقشة حول KRI']),
      lastConversationSummary: 'سأل الطالب عن الكتب والوحدات وخطة التركيز، وأوصاه المشرف بمراجعة دليل الحوكمة وإدارة المخاطر المؤسسية.',
      examSignals: JSON.stringify(['نجح في اختبار الوحدة', 'أجاب صحيحاً على دور مؤشرات المخاطر']),
      thesisSignals: JSON.stringify(['بحثه عن أثر مؤشرات المخاطر على الحوكمة', 'نتيجة البحث معتمدة']),
      lastFileAnalysis: 'الملف البحثي يتضمن ملخصاً ومنهجية تطبيقية ومقترحات تحسين للضوابط.',
      lastInteractionAt: new Date(),
      lastExamAt: new Date(),
      lastDefenseAt: new Date(),
      interactionsCount: 4,
    },
    create: {
      userId: user.id,
      profileDigest: 'طالب تشخيصي في برنامج الحوكمة وإدارة المخاطر، يركز على فهم الكتب المقررة والواجبات والبحث قبل الإطلاق.',
      strengths: JSON.stringify(['يفهم مفهوم الضوابط', 'يربط المؤشرات بالتوصيات']),
      weaknesses: JSON.stringify(['يحتاج أمثلة أكثر على حدود التصعيد', 'يميل للخلط بين KPI وKRI']),
      conceptsToReview: JSON.stringify(['الخطر المتأصل والمتبقي', 'مؤشرات المخاطر الرئيسية', 'تصعيد الضوابط']),
      recommendedNextActions: JSON.stringify(['مراجعة الكتاب المقرر', 'حل حالة سجل مخاطر إضافية', 'تحضير إجابة مناقشة حول KRI']),
      lastConversationSummary: 'سأل الطالب عن الكتب والوحدات وخطة التركيز، وأوصاه المشرف بمراجعة دليل الحوكمة وإدارة المخاطر المؤسسية.',
      examSignals: JSON.stringify(['نجح في اختبار الوحدة', 'أجاب صحيحاً على دور مؤشرات المخاطر']),
      thesisSignals: JSON.stringify(['بحثه عن أثر مؤشرات المخاطر على الحوكمة', 'نتيجة البحث معتمدة']),
      lastFileAnalysis: 'الملف البحثي يتضمن ملخصاً ومنهجية تطبيقية ومقترحات تحسين للضوابط.',
      lastInteractionAt: new Date(),
      lastExamAt: new Date(),
      lastDefenseAt: new Date(),
      interactionsCount: 4,
    },
  })

  return db.user.findFirst({ where: { id: user.id, role: 'STUDENT' }, include: diagnosticStudentInclude })
}

async function findDiagnosticStudent(studentId?: string) {
  if (studentId) {
    return db.user.findFirst({
      where: { id: studentId, role: 'STUDENT' },
      include: diagnosticStudentInclude,
    })
  }

  const stableStudent = await ensureLaunchQualityDiagnosticStudent().catch((error) => {
    console.error('launch-quality diagnostic fixture error:', String(error?.message || error).slice(0, 500))
    return null
  })
  if (stableStudent) return stableStudent

  const richStudents = await db.user.findMany({
    where: {
      role: 'STUDENT',
      enrollments: {
        some: {
          status: { in: ['ACTIVE', 'COMPLETED'] },
          program: {
            is: {
              OR: [
                { units: { some: {} } },
                { books: { some: {} } },
                { studyGuides: { some: { status: 'PUBLISHED' } } },
              ],
            },
          },
        },
      },
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    take: 50,
    include: diagnosticStudentInclude,
  })
  const rich = chooseBestDiagnosticStudent(richStudents)
  if (rich) return rich

  const enrolledStudents = await db.user.findMany({
    where: {
      role: 'STUDENT',
      enrollments: { some: { status: { in: ['ACTIVE', 'COMPLETED'] } } },
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    take: 50,
    include: diagnosticStudentInclude,
  })
  const enrolled = chooseBestDiagnosticStudent(enrolledStudents)
  if (enrolled) return enrolled

  const fallbackStudents = await db.user.findMany({
    where: {
      role: 'STUDENT',
      OR: [
        { theses: { some: {} } },
        { ownedAdmissions: { some: {} } },
        { academicMemory: { isNot: null } },
      ],
    },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
    take: 25,
    include: diagnosticStudentInclude,
  })
  return chooseBestDiagnosticStudent(fallbackStudents)
}

function buildContextCoverage(student: Awaited<ReturnType<typeof findDiagnosticStudent>>, context: string) {
  if (!student) return null
  const enrollment = student.enrollments[0]
  const program = enrollment?.program
  const thesis = student.theses[0]
  const admission = student.ownedAdmissions[0]
  return {
    studentId: student.id,
    studentName: student.name,
    role: student.role,
    program: program ? { id: program.id, title: program.titleAr, units: program.units.length, books: program.books.length, studyGuides: program.studyGuides.length } : null,
    admission: admission ? { reference: admission.reference, program: admission.program, status: admission.status, hasThesisDeadline: !!admission.thesisDeadline } : null,
    thesis: thesis ? { title: thesis.title, status: thesis.status, hasDefenseDate: !!thesis.defenseDate, hasScores: thesis.resultScore != null || thesis.aiScore != null } : null,
    memory: student.academicMemory ? {
      hasProfileDigest: !!student.academicMemory.profileDigest,
      hasConversationSummary: !!student.academicMemory.lastConversationSummary,
      hasFileAnalysis: !!student.academicMemory.lastFileAnalysis,
    } : null,
    contextChars: context.length,
    contextIncludes: {
      studentName: context.includes(student.name),
      programTitle: program ? context.includes(program.titleAr) : false,
      firstBook: program?.books[0]?.title ? context.includes(program.books[0].title) : false,
      firstUnit: program?.units[0]?.title ? context.includes(program.units[0].title) : false,
      thesisTitle: thesis?.title ? context.includes(thesis.title) : false,
      admissionReference: admission?.reference ? context.includes(admission.reference) : false,
    },
  }
}

function expectedForProbe(kind: ProbeKind, student: Awaited<ReturnType<typeof findDiagnosticStudent>>) {
  if (!student) return []
  const enrollment = student.enrollments[0]
  const program = enrollment?.program
  const thesis = student.theses[0]
  const admission = student.ownedAdmissions[0]
  const books = program?.books?.slice(0, 2).map((b) => b.title) || []
  const units = program?.units?.slice(0, 2).map((u) => u.title) || []
  if (kind === 'PROFILE') return [student.name, program?.titleAr, admission?.reference].filter(Boolean) as string[]
  if (kind === 'CURRICULUM') return [program?.titleAr, ...books, ...units].filter(Boolean) as string[]
  if (kind === 'THESIS') return [thesis?.title, 'منهجية', 'نتائج'].filter(Boolean) as string[]
  if (kind === 'DEFENSE') return [thesis?.title || program?.titleAr || 'مناقشة', 'مؤشرات المخاطر الرئيسية', 'الحوكمة المؤسسية'].filter(Boolean) as string[]
  return []
}

function questionForProbe(kind: ProbeKind, student: Awaited<ReturnType<typeof findDiagnosticStudent>>) {
  const thesis = student?.theses?.[0]
  if (kind === 'PROFILE') return 'عرّفني على ملفي الأكاديمي الحالي: اسمي، برنامجي، حالة طلبي، وما الذي يجب أن أركز عليه الآن؟'
  if (kind === 'CURRICULUM') return 'ما الكتب والوحدات الأساسية في منهجي الحالي؟ اذكر أسماء الكتب والوحدات كما هي في ملفي ثم أعطني خطة قراءة قصيرة.'
  if (kind === 'THESIS') return thesis
    ? 'ما عنوان بحثي الحالي؟ ناقش لي المنهجية والنتائج المتوقعة ونقاط الضعف التي يجب أن أراجعها قبل المناقشة.'
    : 'ليس لدي بحث مسجل فيما يبدو؛ اشرح لي كيف أجهز خطة بحث تخرج مناسبة لتخصصي الحالي.'
  return 'تصرف كعضو لجنة مناقشة. اسألني سؤالاً ذكياً عن بحثي أو تخصصي ثم وضّح لماذا هذا السؤال مهم.'
}

function launchQualityAiTimeoutMs() {
  const configured = Number(process.env.LAUNCH_QUALITY_AI_TIMEOUT_MS || '')
  if (Number.isFinite(configured) && configured >= 10_000) return Math.min(Math.floor(configured), 48_000)
  return 48_000
}

function timeoutAfter<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function runAiProbe(kind: ProbeKind, student: Awaited<ReturnType<typeof findDiagnosticStudent>>, context: string) {
  const started = performance.now()
  if (!student) return { kind, skipped: true, reason: 'لا يوجد طالب مناسب للفحص' }
  const question = questionForProbe(kind, student)
  const expected = expectedForProbe(kind, student)

  try {
    const result = await timeoutAfter(platformAgentComplete({
      userId: student.id,
      mode: kind === 'DEFENSE' ? 'VOICE' : 'TEXT',
      uiContext: `Launch Quality Probe: افحص معرفة الوكيل بسياق الطالب. لا تخترع بيانات غير موجودة.\n\n${context.slice(0, 12000)}`,
      messages: [{ role: 'user', content: question }],
    }), launchQualityAiTimeoutMs(), `LAUNCH_QUALITY_AI_PROBE_TIMEOUT_${kind}`)

    const hits = keywordHits(result.reply, expected)
    const minScore = kind === 'THESIS' && !student.theses[0] ? 0 : expected.length ? 40 : 0
    const expectedAgent = expectedAgentForProbe(kind)
    const agentMatches = expectedAgent ? result.agent === expectedAgent : true
    const genericFallback = isGenericFallbackReply(result.reply)
    const grounded = hasGroundingForProbe(kind, result.reply, student)
    const passed = !genericFallback && agentMatches && grounded && hits.score >= minScore && result.reply.length >= 80
    return {
      kind,
      question,
      agent: result.agent,
      expectedAgent,
      agentMatches,
      engine: result.engine,
      ms: elapsed(started),
      replyChars: result.reply.length,
      replySample: result.reply.slice(0, 900),
      expected,
      keywordScore: genericFallback ? 0 : hits.score,
      hits: genericFallback ? [] : hits.hits,
      missed: genericFallback ? expected : hits.missed,
      genericFallback,
      grounded,
      passed,
    }
  } catch (e: any) {
    const error = String(e?.message || e).slice(0, 900)
    return {
      kind,
      question,
      agent: 'ERROR',
      engine: 'AI_PROVIDER_ROUTER_ERROR',
      ms: elapsed(started),
      replyChars: 0,
      replySample: '',
      expected,
      keywordScore: 0,
      hits: [],
      missed: expected,
      passed: false,
      error,
    }
  }
}

async function liveReadiness(runToken: boolean, purpose: GeminiLivePurpose) {
  const started = performance.now()
  const hasKey = await ensureGeminiKey().catch(() => false)
  const model = await geminiActiveLiveModel(purpose).catch(() => '')
  const voice = await geminiTTSVoice().catch(() => '')
  const thinkingLevel = purpose === 'DISCUSSION' ? await geminiDiscussionThinkingLevel().catch(() => 'high') : undefined
  const modelValid = isValidGeminiLiveModel(model)
  const basicOk = hasKey && modelValid && !!voice

  if (!runToken) {
    return { purpose, hasKey, model, modelValid, voice, thinkingLevel, tokenCreated: false, skippedToken: true, ms: elapsed(started), ok: basicOk }
  }

  try {
    // نفس منطق اختبار لوحة الإدارة: اختبار auth token العام بدون فرض liveConnectConstraints.
    // بعض نماذج Gemini Live تقبل token العام ثم تُطبّق إعدادات الجلسة عند connect من المتصفح.
    const apiKey = await geminiApiKey()
    const now = Date.now()
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      }),
    })
    const d: any = await r.json().catch(() => ({}))
    if (!r.ok) {
      const message = d?.error?.message || d?.message || `Gemini Live HTTP ${r.status}`
      return { purpose, hasKey, model, modelValid, voice, thinkingLevel, tokenCreated: false, ms: elapsed(started), ok: false, httpStatus: r.status, error: String(message).slice(0, 300) }
    }
    return { purpose, hasKey, model, modelValid, voice, thinkingLevel, tokenCreated: true, tokenName: String(d?.name || '').slice(0, 40), ms: elapsed(started), ok: basicOk }
  } catch (e: any) {
    return { purpose, hasKey, model, modelValid, voice, thinkingLevel, tokenCreated: false, ms: elapsed(started), ok: false, error: String(e?.message || e).slice(0, 300) }
  }
}

export async function GET() {
  try {
    await requireAdmin()
    const student = await findDiagnosticStudent()
    const context = student ? await buildSupervisorContext(student.id).catch(() => '') : ''
    const textModel = await geminiActiveTextModel().catch(() => '')
    const providerDiagnostics = await textAiDiagnostics().catch((error: any) => ({ error: String(error?.message || error).slice(0, 240) }))
    const voice = await liveReadiness(false, 'SUPERVISOR')
    const discussion = await liveReadiness(false, 'DISCUSSION')
    return NextResponse.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      version: appVersion(),
      configured: serviceConfigurationStatus(),
      textModel,
      providerDiagnostics,
      voiceReadiness: { supervisor: voice, discussion },
      studentContext: buildContextCoverage(student, context),
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('launch-quality GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل فحص الجودة' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const runAi = body.runAi !== false
    const runVoiceToken = body.runVoiceToken === true
    const includeVoice = body.includeVoice !== false
    const probeKinds = selectedProbeKinds(body)
    const studentId = typeof body.studentId === 'string' ? body.studentId : undefined
    const started = performance.now()
    const student = await findDiagnosticStudent(studentId)
    const context = student ? await buildSupervisorContext(student.id).catch(() => '') : ''
    const contextCoverage = buildContextCoverage(student, context)

    const voiceSupervisor = includeVoice ? await liveReadiness(runVoiceToken, 'SUPERVISOR') : null
    const voiceDiscussion = includeVoice ? await liveReadiness(runVoiceToken, 'DISCUSSION') : null

    const probes: Array<Awaited<ReturnType<typeof runAiProbe>>> = []
    if (runAi && student) {
      for (const kind of probeKinds) probes.push(await runAiProbe(kind, student, context))
    }

    const passedProbes = probes.filter((p: any) => p.passed).length
    const skippedProbes = probes.filter((p: any) => p.skipped).length
    const failedProbes = probes.filter((p: any) => !p.passed && !p.skipped).map((p: any) => ({
      kind: p.kind,
      agent: p.agent,
      expectedAgent: p.expectedAgent,
      genericFallback: !!p.genericFallback,
      grounded: !!p.grounded,
      keywordScore: p.keywordScore ?? 0,
      error: p.error,
      missed: p.missed,
    }))
    const score = probes.length ? Math.round((passedProbes / probes.length) * 100) : 0
    const hasUsefulContext = !!contextCoverage && contextCoverage.contextChars > 500 && (
      contextCoverage.contextIncludes.programTitle || contextCoverage.contextIncludes.firstBook || contextCoverage.contextIncludes.thesisTitle
    )
    const aiStatus = !runAi ? 'skipped' : score >= 75 && hasUsefulContext ? 'ok' : score >= 50 ? 'warn' : 'fail'

    return NextResponse.json({
      status: aiStatus,
      timestamp: new Date().toISOString(),
      durationMs: elapsed(started),
      runAi,
      runVoiceToken,
      includeVoice,
      probeKinds,
      version: appVersion(),
      studentContext: contextCoverage,
      voiceReadiness: { supervisor: voiceSupervisor, discussion: voiceDiscussion },
      probes,
      summary: {
        score,
        hasUsefulContext,
        passedProbes,
        skippedProbes,
        failedProbes,
        totalProbes: probes.length,
        recommendation: !runAi
          ? 'لم يتم تشغيل فحوص الذكاء في هذا الطلب؛ هذا ليس دليلاً على نجاح المشرف أو المناقش.'
          : !student
            ? 'لا يوجد طالب ببيانات كافية للفحص. أنشئ طالباً تجريبياً مع برنامج و/أو بحث.'
            : !hasUsefulContext
              ? 'سياق الطالب ضعيف. تأكد من وجود برنامج، وحدات، كتب، بحث أو ذاكرة أكاديمية.'
              : failedProbes.length
                ? `فشلت فحوص: ${failedProbes.map((p: any) => p.kind).join(', ')}. راجع التوجيه، الردود العامة، وأسباب فشل المزوّدين.`
                : 'المشرف الذكي يسترجع سياق الطالب والمنهج والبحث بدرجة مناسبة.',
      },
    }, { headers: { 'Cache-Control': 'no-store, max-age=0' } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    console.error('launch-quality POST error:', e)
    return NextResponse.json({ error: 'تعذر تنفيذ فحص الجودة', detail: String(e?.message || e).slice(0, 300) }, { status: 500 })
  }
}
