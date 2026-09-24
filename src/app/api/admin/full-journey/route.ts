import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { markInvoicePaid } from '@/lib/settle-payment'
import { enforceSemesterTuitionGate, getAdmissionTuitionPlan } from '@/lib/tuition-installments'
import { calculateSemesterReadiness, markSemesterReady } from '@/lib/semester-readiness'
import { calculateFinalGrade } from '@/lib/final-grade'
import { nextAdmissionRef, nextInvoiceNo } from '@/lib/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function runStamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

function qaPassword(stamp: string) {
  return `AACT-QA-${stamp}!42a`
}

function normalize(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ة]/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function round1(n: number) {
  return Math.round(n * 10) / 10
}

function avg(nums: number[]) {
  return nums.length ? round1(nums.reduce((sum, n) => sum + n, 0) / nums.length) : 0
}

function programQuestionPoints(type: string | null | undefined) {
  const t = String(type || '').toUpperCase()
  if (t === 'ESSAY') return 20
  if (t === 'SHORT') return 10
  return 5
}

async function createProgramScaffold(admin: { id: string; name: string }, stamp: string) {
  const slug = `qa-full-journey-${stamp}`
  const program = await db.program.create({
    data: {
      slug,
      titleAr: `برنامج جودة رحلة كاملة QA ${stamp}`,
      titleEn: `QA Full Journey Program ${stamp}`,
      description: 'برنامج اختباري آلي لفحص رحلة المنصة كاملة من التسجيل والقبول والدفع والتقسيط وحتى الامتحان المتوافق مع الكتاب.',
      category: 'MASTERS',
      hours: 120,
      price: 1200,
      icon: 'graduation-cap',
      features: JSON.stringify(['QA journey', 'curriculum alignment', 'installments', 'exam generation']),
      admissionRules: { requiredDocuments: [] },
      active: true,
      order: 9999,
      semestersCount: 2,
      academicReadinessStatus: 'APPROVED',
      registrationStatus: 'OPEN',
      academicApproved: true,
      academicApprovedAt: new Date(),
      academicApprovedById: admin.id,
    },
  })

  const unit = await db.unit.create({
    data: {
      programId: program.id,
      order: 1,
      semester: 1,
      status: 'APPROVED',
      title: 'وحدة الحوكمة وإدارة المخاطر في الجودة المؤسسية',
      summary: 'وحدة اختبارية تربط الكتاب ببنك المعرفة والأسئلة.',
      content: JSON.stringify([
        { heading: 'الحوكمة', body: 'تعرّف الحوكمة بأنها إطار ضبط القرار والرقابة والمساءلة داخل المؤسسة.' },
        { heading: 'إدارة المخاطر', body: 'تحدد إدارة المخاطر الاحتمالية والأثر وخطة المعالجة والمتابعة.' },
      ]),
      objectives: JSON.stringify(['تمييز مبادئ الحوكمة', 'تحليل المخاطر', 'ربط مؤشرات الأداء بالرقابة']),
    },
  })

  const bookTitle = `كتاب QA الحوكمة والمخاطر ${stamp}`
  const concepts = ['الحوكمة', 'إدارة المخاطر', 'مؤشرات الأداء', 'الرقابة الداخلية', 'خطة المعالجة']
  const bookText = 'يركز هذا الكتاب على الحوكمة وإدارة المخاطر ومؤشرات الأداء والرقابة الداخلية. يشرح الكتاب كيف يتم تحديد المخاطر وتحليل الاحتمالية والأثر وبناء خطة المعالجة وربطها بنظام مؤشرات الأداء.'
  const book = await db.book.create({
    data: {
      programId: program.id,
      title: bookTitle,
      titleEn: `QA Governance and Risk ${stamp}`,
      author: 'AACT QA Engine',
      year: String(new Date().getFullYear()),
      description: 'كتاب اختباري لضمان أن الامتحان الناتج مرتبط بمحتوى الكتاب فعلاً.',
      textContent: bookText,
      semester: 1,
      levelPolicy: 'يناسب فحص الجودة الآلي لبرامج الماجستير المهنية.',
      readingDepth: 'قراءة تحليلية تربط المفاهيم بالتطبيق العملي.',
      assessmentOrientation: 'أسئلة تقيس الفهم والتحليل والتطبيق من النص.',
      linkReadStatus: 'TEXT_EXTRACTED',
      linkReadNote: 'نص اختبار داخلي محفوظ لفحص توافق الامتحان مع الكتاب.',
      source: 'ADMIN',
    },
  })

  const knowledge = await db.bookKnowledgeItem.create({
    data: {
      programId: program.id,
      bookId: book.id,
      semester: 1,
      category: 'CONCEPT',
      title: 'العلاقة بين الحوكمة وإدارة المخاطر ومؤشرات الأداء',
      summary: 'تساعد الحوكمة على ضبط القرار، وتحدد إدارة المخاطر الأولويات، وتقيس مؤشرات الأداء فعالية الرقابة والمعالجة.',
      excerpt: bookText,
      keywords: JSON.stringify(concepts),
      importance: 95,
      sourceNote: bookTitle,
    },
  })

  const qData = [
    {
      type: 'MCQ', difficulty: 'EASY', text: `وفق ${bookTitle}، ما الهدف الأساسي من الحوكمة داخل المؤسسة؟`,
      options: JSON.stringify(['زيادة الفوضى', 'ضبط القرار والرقابة والمساءلة', 'إلغاء المخاطر', 'تقليل التدريب فقط']), correctAnswer: '1', modelAnswer: null,
      evidence: 'الحوكمة إطار ضبط القرار والرقابة والمساءلة داخل المؤسسة.', skill: 'فهم', rationale: 'لأن الحوكمة تضبط القرار والرقابة والمساءلة.',
    },
    {
      type: 'MCQ', difficulty: 'MEDIUM', text: `أي عنصر يربط إدارة المخاطر في ${bookTitle} بالمتابعة الإدارية؟`,
      options: JSON.stringify(['مؤشرات الأداء', 'إلغاء التقارير', 'الصدفة', 'العقود فقط']), correctAnswer: '0', modelAnswer: null,
      evidence: 'يربط الكتاب خطة معالجة المخاطر بنظام مؤشرات الأداء.', skill: 'تحليل', rationale: 'مؤشرات الأداء تقيس فعالية المعالجة والمتابعة.',
    },
    {
      type: 'TF', difficulty: 'EASY', text: `يعرض ${bookTitle} إدارة المخاطر باعتبارها تحديد الاحتمالية والأثر وخطة المعالجة.`,
      options: JSON.stringify(['صح', 'خطأ']), correctAnswer: '0', modelAnswer: null,
      evidence: 'تحدد إدارة المخاطر الاحتمالية والأثر وخطة المعالجة والمتابعة.', skill: 'استرجاع', rationale: 'العبارة مطابقة لمحتوى الكتاب.',
    },
    {
      type: 'SHORT', difficulty: 'MEDIUM', text: `اشرح باختصار كيف تساعد الرقابة الداخلية في متابعة خطة المعالجة حسب ${bookTitle}.`,
      options: null, correctAnswer: null, modelAnswer: 'تساعد الرقابة الداخلية على قياس تنفيذ خطة المعالجة ومراجعة فعالية الإجراءات وربط النتائج بمؤشرات الأداء.',
      evidence: 'يركز الكتاب على الرقابة الداخلية وربطها بمؤشرات الأداء وخطة المعالجة.', skill: 'تطبيق', rationale: 'الإجابة الجيدة تربط الرقابة بالمعالجة والمؤشرات.',
    },
    {
      type: 'ESSAY', difficulty: 'ADVANCED', text: `حلل العلاقة بين الحوكمة وإدارة المخاطر ومؤشرات الأداء كما وردت في ${bookTitle}.`,
      options: null, correctAnswer: null, modelAnswer: 'العلاقة تكاملية: الحوكمة تضع إطار القرار والمساءلة، إدارة المخاطر تحدد الأولويات والاحتمالية والأثر، ومؤشرات الأداء تقيس مدى نجاح الرقابة وخطة المعالجة.',
      evidence: 'تجتمع الحوكمة وإدارة المخاطر ومؤشرات الأداء لضبط القرار وقياس فعالية الرقابة والمعالجة.', skill: 'تحليل وتركيب', rationale: 'السؤال يقيس فهم العلاقة بين المفاهيم الثلاثة.',
    },
    {
      type: 'MCQ', difficulty: 'MEDIUM', text: `ما المقصود بخطة المعالجة في سياق إدارة المخاطر في ${bookTitle}؟`,
      options: JSON.stringify(['تجاهل المخاطر', 'إجراءات للحد من الاحتمالية أو الأثر ومتابعتها', 'حذف المؤشرات', 'منع الحوكمة']), correctAnswer: '1', modelAnswer: null,
      evidence: 'خطة المعالجة تحدد الإجراءات والمتابعة للحد من المخاطر.', skill: 'فهم تطبيقي', rationale: 'الخطة تعالج الاحتمالية أو الأثر وتتابع التنفيذ.',
    },
  ]

  const questions = await Promise.all(qData.map((q) => db.questionBankItem.create({
    data: {
      programId: program.id,
      knowledgeItemId: knowledge.id,
      bookId: book.id,
      unitId: unit.id,
      semester: 1,
      type: q.type,
      text: q.text,
      options: q.options,
      correctAnswer: q.correctAnswer,
      modelAnswer: q.modelAnswer,
      sourceEvidence: `${q.evidence} — المصدر: ${bookTitle}`,
      sourceBookTitle: bookTitle,
      sourceLocator: 'QA chapter 1',
      cognitiveSkill: q.skill,
      difficulty: q.difficulty,
      correctRationale: q.rationale,
      qualityFlags: JSON.stringify(['QA_FULL_JOURNEY', 'BOOK_ALIGNED']),
      status: 'APPROVED',
      generatedBy: 'QA_FULL_JOURNEY',
      qualityScore: 96,
      approvedBy: admin.name,
      approvedAt: new Date(),
    },
  })))

  return { program, unit, book, knowledge, questions, concepts }
}

async function createStudentAndAdmission(admin: { id: string; name: string }, stamp: string, program: { id: string; titleAr: string; price: number | null }) {
  const email = `qa.fulljourney.${stamp}@aact.test`
  const password = qaPassword(stamp)
  const student = await db.user.create({
    data: {
      email,
      password: await hashPassword(password),
      name: `طالب رحلة كاملة QA ${stamp}`,
      phone: '+10000000000',
      country: 'QA',
      role: 'STUDENT',
      status: 'ACTIVE',
    },
  })

  const admission = await db.admissionApplication.create({
    data: {
      reference: await nextAdmissionRef(),
      fullName: student.name,
      email: student.email,
      phone: student.phone || '+10000000000',
      country: student.country || 'QA',
      nationalId: `QA-${stamp}`,
      birthDate: new Date('1990-01-01T00:00:00.000Z'),
      address: 'QA automated full journey address',
      education: 'BACHELOR',
      program: program.titleAr,
      programId: program.id,
      documents: JSON.stringify(['QA_DOCUMENTS_BYPASSED_FOR_AUTOMATED_FULL_JOURNEY']),
      notes: 'QA_FULL_JOURNEY automated admission simulation',
      acknowledged: true,
      acknowledgedAt: new Date(),
      userId: student.id,
      status: 'AWAITING_FEE',
      supervisionMode: 'AI',
    },
  })

  const appFee = await db.payment.create({
    data: {
      admissionId: admission.id,
      userId: student.id,
      invoiceNo: await nextInvoiceNo(),
      purpose: 'APPLICATION_FEE',
      description: `QA رسوم تقديم — ${program.titleAr}`,
      amount: 30,
      payerName: student.name,
      payerEmail: student.email,
      payerCountry: student.country,
      method: 'BANK_TRANSFER',
    },
  })

  const appFeePaid = await markInvoicePaid(appFee.invoiceNo, 'BANK_TRANSFER', { actor: admin })
  const afterFee = await db.admissionApplication.findUnique({ where: { id: admission.id } })

  const tuition = await db.payment.create({
    data: {
      admissionId: admission.id,
      userId: student.id,
      invoiceNo: await nextInvoiceNo(),
      purpose: 'TUITION',
      description: `QA الرسوم الدراسية الكاملة — ${program.titleAr}`,
      amount: Number(program.price || 1200),
      payerName: student.name,
      payerEmail: student.email,
      payerCountry: student.country,
      method: 'BANK_TRANSFER',
    },
  })

  const approvedAt = new Date()
  await db.admissionApplication.update({
    where: { id: admission.id },
    data: {
      status: 'AWAITING_TUITION',
      approvedAt,
      thesisDeadline: new Date(approvedAt.getTime() + 180 * 24 * 60 * 60 * 1000),
    },
  })
  await audit(admin, 'QA_APPROVE_ADMISSION', 'AdmissionApplication', admission.id, `Full journey approved ${admission.reference}`)

  const appeal = await db.tuitionInstallmentAppeal.create({
    data: {
      admissionId: admission.id,
      userId: student.id,
      programId: program.id,
      status: 'APPROVED',
      requestedInitialAmount: 300,
      approvedInitialAmount: 300,
      firstSemesterRequiredAmount: 300,
      finalRequiredAmount: Number(program.price || 1200),
      proposedSchedule: JSON.stringify([{ label: 'initial', amount: 300 }, { label: 'remaining', amount: Number(program.price || 1200) - 300 }]),
      reason: 'QA_FULL_JOURNEY installment request simulation',
      adminNote: 'Approved by automated full journey test',
      decidedById: admin.id,
      decidedAt: new Date(),
    },
  })

  const installment = await db.payment.create({
    data: {
      admissionId: admission.id,
      userId: student.id,
      invoiceNo: await nextInvoiceNo(),
      purpose: 'TUITION_INSTALLMENT',
      description: `QA الدفعة الأولى وفق التقسيط — ${program.titleAr}`,
      amount: 300,
      payerName: student.name,
      payerEmail: student.email,
      payerCountry: student.country,
      method: 'BANK_TRANSFER',
    },
  })
  const firstSemesterGateBeforeInitialPayment = await enforceSemesterTuitionGate(student.id, program.id, 1)
  const installmentPaid = await markInvoicePaid(installment.invoiceNo, 'BANK_TRANSFER', { actor: admin })
  const firstSemesterGateAfterInitialPayment = await enforceSemesterTuitionGate(student.id, program.id, 1)
  const finalAdmission = await db.admissionApplication.findUnique({ where: { id: admission.id } })
  const enrollment = await db.enrollment.findUnique({ where: { userId_programId: { userId: student.id, programId: program.id } } })
  const tuitionPlan = await getAdmissionTuitionPlan(admission.id)

  await db.studentAcademicMemory.upsert({
    where: { userId: student.id },
    create: {
      userId: student.id,
      profileDigest: `QA student enrolled in ${program.titleAr}. Admission ${admission.reference}.`,
      lastConversationSummary: 'QA full journey verified registration, installment activation, curriculum access, and exam alignment.',
      lastFileAnalysis: 'QA synthetic file analysis connected to governance, risk management, KPIs, internal control, and treatment plan.',
      interactionsCount: 1,
    },
    update: {
      profileDigest: `QA student enrolled in ${program.titleAr}. Admission ${admission.reference}.`,
      lastConversationSummary: 'QA full journey verified registration, installment activation, curriculum access, and exam alignment.',
      lastFileAnalysis: 'QA synthetic file analysis connected to governance, risk management, KPIs, internal control, and treatment plan.',
      interactionsCount: { increment: 1 },
      lastInteractionAt: new Date(),
    },
  })

  return {
    student,
    password,
    admission,
    appFee,
    appFeePaid,
    afterFee,
    tuition,
    appeal,
    installment,
    firstSemesterGateBeforeInitialPayment,
    installmentPaid,
    firstSemesterGateAfterInitialPayment,
    finalAdmission,
    enrollment,
    tuitionPlan,
  }
}

async function createAcademicAndFinancialJourney(
  admin: { id: string; name: string },
  stamp: string,
  scaffold: Awaited<ReturnType<typeof createProgramScaffold>>,
  academic: Awaited<ReturnType<typeof createStudentAndAdmission>>,
) {
  const userId = academic.student.id
  const programId = scaffold.program.id
  const admissionId = academic.admission.id
  const bookTitle = scaffold.book.title

  const semester1GateBefore = await enforceSemesterTuitionGate(userId, programId, 1)
  const semester2GateBeforeFinalPayment = await enforceSemesterTuitionGate(userId, programId, 2)

  const sem1Assignment = await db.programAssignment.create({
    data: {
      programId,
      semester: 1,
      title: `QA واجب الفصل الأول ${stamp}`,
      description: `حلل الحوكمة وإدارة المخاطر بالاستناد إلى ${bookTitle}.`,
      type: 'CASE_STUDY',
      points: 100,
      weight: 20,
      rubric: JSON.stringify(['الربط بالكتاب', 'تحليل المخاطر', 'مؤشرات الأداء']),
      status: 'PUBLISHED',
    },
  })
  const sem1AssignmentSubmission = await db.assignmentSubmission.create({
    data: {
      assignmentId: sem1Assignment.id,
      userId,
      answerText: 'إجابة QA للفصل الأول تربط الحوكمة بالمخاطر ومؤشرات الأداء.',
      status: 'GRADED',
      score: 88,
      feedback: 'اجتياز جيد للواجب مع ربط واضح بالكتاب.',
      gradedBy: admin.name,
      gradedAt: new Date(),
    },
  })

  const unit1Exam = await db.exam.create({ data: { unitId: scaffold.unit.id, title: `QA اختبار وحدة الفصل الأول ${stamp}`, passScore: 60 } })
  const unit1Question = await db.question.create({
    data: {
      examId: unit1Exam.id,
      order: 1,
      type: 'MCQ',
      text: `حسب ${bookTitle} ما وظيفة الحوكمة؟`,
      options: JSON.stringify(['المساءلة والرقابة', 'إلغاء الرقابة', 'تجاهل المخاطر', 'تقليل الجودة']),
      correctAnswer: '0',
      points: 100,
    },
  })
  const unit1Attempt = await db.examAttempt.create({
    data: {
      userId,
      examId: unit1Exam.id,
      score: 90,
      passed: true,
      status: 'GRADED',
      aiGraded: true,
      feedback: JSON.stringify({ summary: 'اجتاز اختبار الوحدة الأولى.' }),
      answers: { create: [{ questionId: unit1Question.id, selectedOption: 0, isCorrect: true, points: 100, maxPoints: 100 }] },
    },
  })

  const readiness1BeforeMark = await calculateSemesterReadiness(userId, programId, 1)
  const readiness1AfterMark = await markSemesterReady(userId, programId, 1)

  const sem1ProgramQuestionRows = [
    {
      order: 1,
      type: 'MCQ',
      text: `يربط ${bookTitle} الحوكمة بأي عنصر إداري؟`,
      options: JSON.stringify(['الرقابة والمساءلة', 'الإلغاء', 'العشوائية', 'الصدفة']),
      correctAnswer: '0',
      modelAnswer: null,
      sourceEvidence: `الحوكمة إطار ضبط القرار والرقابة والمساءلة — ${bookTitle}`,
    },
    {
      order: 2,
      type: 'TF',
      text: `يعرض ${bookTitle} إدارة المخاطر بوصفها تحديد الاحتمالية والأثر وخطة المعالجة.`,
      options: JSON.stringify(['صح', 'خطأ']),
      correctAnswer: '0',
      modelAnswer: null,
      sourceEvidence: `تحدد إدارة المخاطر الاحتمالية والأثر وخطة المعالجة والمتابعة — ${bookTitle}`,
    },
    {
      order: 3,
      type: 'MCQ',
      text: `أي عنصر يقيس فعالية الرقابة الداخلية في ${bookTitle}؟`,
      options: JSON.stringify(['مؤشرات الأداء', 'الحفظ النظري', 'إلغاء التقارير', 'العشوائية']),
      correctAnswer: '0',
      modelAnswer: null,
      sourceEvidence: `يربط الكتاب الرقابة الداخلية بمؤشرات الأداء وخطة المعالجة — ${bookTitle}`,
    },
    {
      order: 4,
      type: 'SHORT',
      text: `اشرح علاقة مؤشرات الأداء بخطة المعالجة حسب ${bookTitle}.`,
      options: null,
      correctAnswer: null,
      modelAnswer: 'تقيس مؤشرات الأداء فعالية تنفيذ خطة المعالجة والرقابة الداخلية.',
      sourceEvidence: `يربط الكتاب خطة المعالجة بمؤشرات الأداء — ${bookTitle}`,
    },
    {
      order: 5,
      type: 'SHORT',
      text: `اذكر دور الرقابة الداخلية في متابعة المخاطر كما ورد في ${bookTitle}.`,
      options: null,
      correctAnswer: null,
      modelAnswer: 'تتابع الرقابة الداخلية تنفيذ خطة المعالجة وتقيس النتائج وتدعم المساءلة.',
      sourceEvidence: `يركز الكتاب على الرقابة الداخلية ومتابعة خطة المعالجة — ${bookTitle}`,
    },
    {
      order: 6,
      type: 'ESSAY',
      text: `حلل التكامل بين الحوكمة وإدارة المخاطر ومؤشرات الأداء في ${bookTitle}.`,
      options: null,
      correctAnswer: null,
      modelAnswer: 'التكامل يبدأ بإطار الحوكمة للقرار والمساءلة، ثم تحديد المخاطر، ثم قياس فعالية المعالجة بمؤشرات الأداء.',
      sourceEvidence: `تجتمع الحوكمة وإدارة المخاطر ومؤشرات الأداء لضبط القرار وقياس فعالية الرقابة والمعالجة — ${bookTitle}`,
    },
  ]
  const sem1ExamTotalPoints = sem1ProgramQuestionRows.reduce((sum, q) => sum + programQuestionPoints(q.type), 0)
  const sem1Exam = await db.programExam.create({
    data: {
      programId,
      semester: 1,
      title: `QA امتحان الفصل الأول ${stamp}`,
      status: 'READY',
      durationMin: 120,
      passScore: 60,
      totalPoints: sem1ExamTotalPoints,
      booksUsed: bookTitle,
      generatedBy: 'QA_FULL_JOURNEY',
      questions: {
        create: sem1ProgramQuestionRows.map((q) => ({
          ...q,
          points: programQuestionPoints(q.type),
          status: 'PUBLISHED',
          sourceBookTitle: bookTitle,
        })),
      },
    },
    include: { questions: true },
  })
  const sem1ExamAttempt = await db.programExamAttempt.create({
    data: {
      examId: sem1Exam.id,
      userId,
      score: 86,
      finalScore: 86,
      passed: true,
      status: 'GRADED',
      feedback: JSON.stringify({ summary: 'اجتياز امتحان الفصل الأول.' }),
      durationUsedMin: 88,
      submittedAt: new Date(),
      answers: {
        create: sem1Exam.questions.map((q) => ({ questionId: q.id, answerText: 'إجابة QA صحيحة مرتبطة بالكتاب.', selectedOption: q.type === 'MCQ' || q.type === 'TF' ? 0 : null, isCorrect: true, points: Number(q.points || 0), maxPoints: Number(q.points || 0) })),
      },
    },
  })

  const unit2 = await db.unit.create({
    data: {
      programId,
      order: 2,
      semester: 2,
      status: 'APPROVED',
      title: 'وحدة التطبيق والتحليل في الرقابة المؤسسية',
      summary: 'وحدة اختبارية للفصل الثاني تفحص الالتزام المالي قبل فتح الامتحان.',
      content: JSON.stringify([{ heading: 'التطبيق', body: 'تطبيق الحوكمة وإدارة المخاطر على حالة مؤسسية.' }]),
      objectives: JSON.stringify(['تطبيق الحوكمة', 'تحليل الرقابة', 'تقييم خطة المعالجة']),
    },
  })

  const planBeforeFinal = await getAdmissionTuitionPlan(admissionId)
  const finalInstallment = await db.payment.create({
    data: {
      admissionId,
      userId,
      invoiceNo: await nextInvoiceNo(),
      purpose: 'TUITION_INSTALLMENT',
      description: `QA سداد بقية الرسوم قبل امتحان الفصل الثاني — ${scaffold.program.titleAr}`,
      amount: planBeforeFinal?.remainingTuition || 900,
      payerName: academic.student.name,
      payerEmail: academic.student.email,
      payerCountry: academic.student.country,
      method: 'BANK_TRANSFER',
    },
  })
  const finalInstallmentPaid = await markInvoicePaid(finalInstallment.invoiceNo, 'BANK_TRANSFER', { actor: admin })
  const planAfterFinal = await getAdmissionTuitionPlan(admissionId)
  const semester2GateAfterFinalPayment = await enforceSemesterTuitionGate(userId, programId, 2)

  const sem2Assignment = await db.programAssignment.create({
    data: {
      programId,
      semester: 2,
      title: `QA واجب الفصل الثاني ${stamp}`,
      description: `طبّق مفاهيم الرقابة الداخلية وخطة المعالجة من ${bookTitle}.`,
      type: 'PROJECT',
      points: 100,
      weight: 20,
      rubric: JSON.stringify(['التطبيق', 'التحليل', 'الاستنتاج']),
      status: 'PUBLISHED',
    },
  })
  const sem2AssignmentSubmission = await db.assignmentSubmission.create({
    data: {
      assignmentId: sem2Assignment.id,
      userId,
      answerText: 'إجابة QA للفصل الثاني تطبق الرقابة ومؤشرات الأداء.',
      status: 'GRADED',
      score: 92,
      feedback: 'اجتياز ممتاز للواجب التطبيقي.',
      gradedBy: admin.name,
      gradedAt: new Date(),
    },
  })

  const unit2Exam = await db.exam.create({ data: { unitId: unit2.id, title: `QA اختبار وحدة الفصل الثاني ${stamp}`, passScore: 60 } })
  const unit2Question = await db.question.create({
    data: {
      examId: unit2Exam.id,
      order: 1,
      type: 'MCQ',
      text: 'ما دور خطة المعالجة في إدارة المخاطر؟',
      options: JSON.stringify(['تقليل الاحتمالية أو الأثر ومتابعة التنفيذ', 'حذف المؤشرات', 'إلغاء الحوكمة', 'تجاهل الرقابة']),
      correctAnswer: '0',
      points: 100,
    },
  })
  const unit2Attempt = await db.examAttempt.create({
    data: {
      userId,
      examId: unit2Exam.id,
      score: 94,
      passed: true,
      status: 'GRADED',
      aiGraded: true,
      feedback: JSON.stringify({ summary: 'اجتاز اختبار وحدة الفصل الثاني.' }),
      answers: { create: [{ questionId: unit2Question.id, selectedOption: 0, isCorrect: true, points: 100, maxPoints: 100 }] },
    },
  })

  const readiness2BeforeMark = await calculateSemesterReadiness(userId, programId, 2)
  const readiness2AfterMark = await markSemesterReady(userId, programId, 2)

  const sem2Exam = await db.programExam.create({
    data: {
      programId,
      semester: 2,
      title: `QA امتحان الفصل الثاني ${stamp}`,
      status: 'READY',
      durationMin: 120,
      passScore: 60,
      totalPoints: 100,
      booksUsed: bookTitle,
      generatedBy: 'QA_FULL_JOURNEY',
      questions: {
        create: [
          {
            order: 1,
            type: 'MCQ',
            text: `ما العنصر الذي يقيس فعالية المعالجة في ${bookTitle}؟`,
            options: JSON.stringify(['مؤشرات الأداء', 'إلغاء القياس', 'العقوبة فقط', 'الحفظ النظري']),
            correctAnswer: '0',
            points: 50,
            status: 'PUBLISHED',
            sourceBookTitle: bookTitle,
            sourceEvidence: `تقيس مؤشرات الأداء فعالية الرقابة والمعالجة — ${bookTitle}`,
          },
          {
            order: 2,
            type: 'ESSAY',
            text: `حلل التكامل بين الحوكمة وإدارة المخاطر والرقابة الداخلية كما ورد في ${bookTitle}.`,
            modelAnswer: 'التكامل يبدأ بإطار الحوكمة، ثم تحديد المخاطر، ثم متابعة المعالجة والرقابة بمؤشرات أداء.',
            points: 50,
            status: 'PUBLISHED',
            sourceBookTitle: bookTitle,
            sourceEvidence: `الحوكمة وإدارة المخاطر ومؤشرات الأداء تعمل معاً لضبط القرار — ${bookTitle}`,
          },
        ],
      },
    },
    include: { questions: true },
  })
  const sem2ExamAttempt = await db.programExamAttempt.create({
    data: {
      examId: sem2Exam.id,
      userId,
      score: 90,
      finalScore: 90,
      passed: true,
      status: 'GRADED',
      feedback: JSON.stringify({ summary: 'اجتياز امتحان الفصل الثاني.' }),
      durationUsedMin: 91,
      submittedAt: new Date(),
      answers: {
        create: sem2Exam.questions.map((q) => ({ questionId: q.id, answerText: 'إجابة QA صحيحة للفصل الثاني.', selectedOption: q.type === 'MCQ' ? 0 : undefined, isCorrect: true, points: q.points, maxPoints: q.points })),
      },
    },
  })

  const sem1Average = avg([Number(sem1AssignmentSubmission.score), Number(unit1Attempt.score), Number(sem1ExamAttempt.finalScore || sem1ExamAttempt.score)])
  const sem2Average = avg([Number(sem2AssignmentSubmission.score), Number(unit2Attempt.score), Number(sem2ExamAttempt.finalScore || sem2ExamAttempt.score)])
  const thesisEligible = readiness1AfterMark.complete && readiness2AfterMark.complete && !!sem1ExamAttempt.passed && !!sem2ExamAttempt.passed && semester2GateAfterFinalPayment.ok

  const thesis = await db.thesisSubmission.create({
    data: {
      userId,
      admissionId,
      title: `QA بحث التخرج في الحوكمة وإدارة المخاطر ${stamp}`,
      abstract: 'بحث اختباري يتحقق من فتح مرحلة البحث بعد اجتياز الفصلين والالتزام المالي.',
      fileNote: 'QA synthetic thesis file linked to full journey test.',
      status: 'RESULT_APPROVED',
      defenseDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      committee: JSON.stringify(['QA Committee Chair', 'AI Academic Reviewer']),
      defenseStatus: 'COMPLETED',
      aiScore: 88,
      aiRecommendation: 'البحث مؤهل ومقبول ضمن رحلة الاختبار.',
      defenseCompletedAt: new Date(),
      defenseMinutes: 'محضر QA يؤكد معرفة الطالب بالمنهج والبحث.',
      resultScore: 91,
      passed: true,
      reviewedAt: new Date(),
    },
  })
  await db.thesisReviewNote.create({
    data: {
      thesisId: thesis.id,
      stage: 'RESULT',
      action: 'RESULT_NOTE',
      note: 'QA: الطالب مؤهل لبحث التخرج بعد استيفاء الفصلين والالتزام المالي.',
      authorId: admin.id,
      authorName: admin.name,
      visibleToStudent: true,
    },
  })

  const finalGrade = await calculateFinalGrade({ userId, programId, admissionId })
  const enrollmentAfterGrade = await db.enrollment.update({
    where: { userId_programId: { userId, programId } },
    data: { finalScore: finalGrade.score, status: finalGrade.score != null && finalGrade.score >= 60 ? 'COMPLETED' : 'ACTIVE' },
  })

  return {
    tuitionGate: {
      semester1Before: semester1GateBefore,
      semester2BeforeFinalPayment: semester2GateBeforeFinalPayment,
      semester2AfterFinalPayment: semester2GateAfterFinalPayment,
      planBeforeFinal,
      planAfterFinal,
      finalInstallmentPaid,
    },
    semesters: {
      semester1: {
        assignmentScore: sem1AssignmentSubmission.score,
        unitQuizScore: unit1Attempt.score,
        examScore: sem1ExamAttempt.finalScore || sem1ExamAttempt.score,
        average: sem1Average,
        readinessBeforeMark: readiness1BeforeMark,
        readinessAfterMark: readiness1AfterMark,
        passed: sem1Average >= 60 && !!sem1ExamAttempt.passed,
      },
      semester2: {
        assignmentScore: sem2AssignmentSubmission.score,
        unitQuizScore: unit2Attempt.score,
        examScore: sem2ExamAttempt.finalScore || sem2ExamAttempt.score,
        average: sem2Average,
        readinessBeforeMark: readiness2BeforeMark,
        readinessAfterMark: readiness2AfterMark,
        passed: sem2Average >= 60 && !!sem2ExamAttempt.passed,
      },
    },
    thesis: { id: thesis.id, title: thesis.title, eligible: thesisEligible, status: thesis.status, passed: thesis.passed, aiScore: thesis.aiScore, resultScore: thesis.resultScore },
    finalGrade,
    enrollmentAfterGrade: { id: enrollmentAfterGrade.id, status: enrollmentAfterGrade.status, finalScore: enrollmentAfterGrade.finalScore },
  }
}

async function createServiceAndContact(admin: { id: string; name: string }, stamp: string, student: { id: string; name: string; email: string; phone?: string | null; country?: string | null }) {
  const service = await db.admissionApplication.create({
    data: {
      reference: await nextAdmissionRef(),
      fullName: student.name,
      email: student.email,
      phone: student.phone || '+10000000000',
      country: student.country || 'QA',
      education: 'OTHER',
      program: `QA خدمة مهنية عابرة ${stamp}`,
      documents: JSON.stringify(['SERVICE_QA_REQUEST']),
      notes: 'QA_FULL_JOURNEY service request simulation',
      acknowledged: true,
      acknowledgedAt: new Date(),
      userId: student.id,
      status: 'UNDER_REVIEW',
    },
  })
  const serviceInvoice = await db.payment.create({
    data: {
      admissionId: service.id,
      userId: student.id,
      invoiceNo: await nextInvoiceNo(),
      purpose: 'SERVICE_FEE',
      description: `QA رسوم خدمة عابرة — ${service.program}`,
      amount: 50,
      payerName: student.name,
      payerEmail: student.email,
      payerCountry: student.country,
      method: 'BANK_TRANSFER',
    },
  })
  const servicePaid = await markInvoicePaid(serviceInvoice.invoiceNo, 'BANK_TRANSFER', { actor: admin })
  const deliverable = await db.serviceDeliverable.create({
    data: {
      admissionId: service.id,
      type: 'CONSULTATION_REPORT',
      status: 'PUBLISHED',
      title: `QA مخرج الخدمة ${stamp}`,
      description: 'مخرج اختباري منشور للتحقق من رحلة الخدمة العابرة.',
      externalUrl: 'https://example.com/qa-service-deliverable',
      visibleToStudent: true,
      createdById: admin.id,
      createdByName: admin.name,
    },
  })
  await db.admissionApplication.update({ where: { id: service.id }, data: { status: 'COMPLETED' } }).catch(() => {})

  const contact = await db.contactMessage.create({
    data: {
      name: student.name,
      email: student.email,
      phone: student.phone || '+10000000000',
      subject: `QA_FULL_JOURNEY_CONTACT_${stamp}`,
      message: 'رسالة اختبارية للتأكد من أن الإدارة تستطيع استقبال الرسالة والرد عليها/معالجتها.',
      handled: true,
    },
  })

  return { service, serviceInvoice, servicePaid, deliverable, contact }
}

export async function GET() {
  try {
    await requireAdmin()
    const recent = await db.auditLog.findMany({
      where: { action: { startsWith: 'QA_' } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
    return NextResponse.json({ ok: true, recent }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    return NextResponse.json({ error: 'تعذر تحميل حالة رحلة الاختبار' }, { status: 500 })
  }
}

export async function POST() {
  try {
    const adminUser = await requireAdmin()
    const admin = { id: adminUser.id, name: adminUser.name || 'QA Admin' }
    const stamp = runStamp()
    const startedAt = Date.now()
    const steps: Array<{ name: string; ok: boolean; detail?: string; data?: any }> = []

    const scaffold = await createProgramScaffold(admin, stamp)
    steps.push({ name: 'إنشاء برنامج وكتاب وبنك معرفة وأسئلة معتمدة', ok: true, detail: scaffold.program.titleAr, data: { programId: scaffold.program.id, bookId: scaffold.book.id, questions: scaffold.questions.length } })

    const academic = await createStudentAndAdmission(admin, stamp, scaffold.program)
    steps.push({ name: 'إنشاء طالب وطلب التحاق وسداد رسوم التقديم', ok: academic.appFeePaid.ok && academic.afterFee?.status === 'UNDER_REVIEW', detail: academic.admission.reference, data: { admissionStatusAfterFee: academic.afterFee?.status, invoice: academic.appFee.invoiceNo } })
    const firstSemesterReady = !!academic.enrollment && !!academic.tuitionPlan?.firstSemesterAllowed && Number(academic.tuitionPlan?.paidTuition || 0) >= Number(academic.tuitionPlan?.halfRequired || 0)
    steps.push({ name: 'موافقة الإدارة وإنشاء خطة تقسيط وسداد الدفعة الأولى', ok: firstSemesterReady, detail: academic.finalAdmission?.status || '', data: { appealId: academic.appeal.id, enrollmentId: academic.enrollment?.id, tuitionPlan: academic.tuitionPlan } })

    const academicJourney = await createAcademicAndFinancialJourney(admin, stamp, scaffold, academic)
    const sem2BeforeGate: any = academicJourney.tuitionGate.semester2BeforeFinalPayment
    const sem2AfterGate: any = academicJourney.tuitionGate.semester2AfterFinalPayment
    steps.push({ name: 'منع امتحان الفصل الثاني قبل اكتمال الالتزام المالي', ok: sem2BeforeGate.ok === false && sem2BeforeGate.code === 'TUITION_FULL_REQUIRED', detail: sem2BeforeGate.code || 'OK', data: sem2BeforeGate })
    steps.push({ name: 'السماح بامتحان الفصل الثاني بعد سداد بقية التقسيط', ok: sem2AfterGate.ok === true, detail: `paid=${academicJourney.tuitionGate.planAfterFinal?.paidTuition || 0}`, data: academicJourney.tuitionGate.planAfterFinal })
    steps.push({ name: 'اجتياز واجب وامتحان الفصل الأول وحساب المعدل', ok: academicJourney.semesters.semester1.passed && academicJourney.semesters.semester1.average >= 60, detail: `${academicJourney.semesters.semester1.average}%`, data: academicJourney.semesters.semester1 })
    steps.push({ name: 'اجتياز واجب وامتحان الفصل الثاني وحساب المعدل', ok: academicJourney.semesters.semester2.passed && academicJourney.semesters.semester2.average >= 60, detail: `${academicJourney.semesters.semester2.average}%`, data: academicJourney.semesters.semester2 })
    steps.push({ name: 'التأهل لبحث التخرج وحساب المعدل النهائي', ok: academicJourney.thesis.eligible && !!academicJourney.thesis.passed && (academicJourney.finalGrade.score || 0) >= 60, detail: `final=${academicJourney.finalGrade.score ?? 'N/A'}`, data: { thesis: academicJourney.thesis, finalGrade: academicJourney.finalGrade } })

    const service = await createServiceAndContact(admin, stamp, academic.student)
    steps.push({ name: 'طلب خدمة عابرة وسدادها وتسليم مخرجها', ok: service.servicePaid.ok && !!service.deliverable.id, detail: service.service.reference, data: { serviceStatus: 'COMPLETED', deliverableId: service.deliverable.id } })
    steps.push({ name: 'رسالة تواصل ومعالجة إدارية', ok: service.contact.handled === true, detail: service.contact.subject, data: { contactId: service.contact.id } })

    await audit(admin, 'QA_FULL_JOURNEY_SETUP', 'Program', scaffold.program.id, `Full platform journey scaffold ${stamp}`)

    const allOk = steps.every((s) => s.ok)
    return NextResponse.json({
      ok: allOk,
      stamp,
      durationMs: Date.now() - startedAt,
      steps,
      student: { id: academic.student.id, email: academic.student.email, password: academic.password, name: academic.student.name },
      program: { id: scaffold.program.id, slug: scaffold.program.slug, title: scaffold.program.titleAr },
      admission: { id: academic.admission.id, reference: academic.admission.reference, status: academic.finalAdmission?.status },
      enrollment: { id: academicJourney.enrollmentAfterGrade.id, status: academicJourney.enrollmentAfterGrade.status, finalScore: academicJourney.enrollmentAfterGrade.finalScore },
      academicJourney,
      service: { id: service.service.id, reference: service.service.reference, deliverableId: service.deliverable.id },
      book: { id: scaffold.book.id, title: scaffold.book.title, concepts: scaffold.concepts },
      questionBank: { count: scaffold.questions.length, ids: scaffold.questions.map((q) => q.id) },
    }, { status: allOk ? 200 : 207, headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    console.error('full journey diagnostic error:', e)
    return NextResponse.json({ ok: false, error: e?.message || 'تعذر تنفيذ رحلة المنصة الكاملة' }, { status: 500 })
  }
}
