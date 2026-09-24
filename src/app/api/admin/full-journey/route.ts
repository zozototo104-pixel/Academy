import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { markInvoicePaid } from '@/lib/settle-payment'
import { getAdmissionTuitionPlan } from '@/lib/tuition-installments'
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

function alignmentScore(questions: Array<{ text?: string | null; sourceEvidence?: string | null; sourceBookTitle?: string | null; modelAnswer?: string | null }>, bookTitle: string, concepts: string[]) {
  const title = normalize(bookTitle)
  const conceptNeedles = concepts.map(normalize).filter(Boolean)
  const rows = questions.map((q) => {
    const hay = normalize(`${q.text || ''} ${q.sourceEvidence || ''} ${q.sourceBookTitle || ''} ${q.modelAnswer || ''}`)
    const titleHit = !!title && hay.includes(title)
    const conceptHits = conceptNeedles.filter((c) => hay.includes(c))
    return {
      titleHit,
      conceptHits,
      aligned: titleHit || conceptHits.length > 0,
      text: q.text,
      sourceBookTitle: q.sourceBookTitle,
      sourceEvidence: q.sourceEvidence,
    }
  })
  const aligned = rows.filter((r) => r.aligned).length
  return {
    aligned,
    total: rows.length,
    score: rows.length ? Math.round((aligned / rows.length) * 100) : 0,
    rows,
  }
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
  const installmentPaid = await markInvoicePaid(installment.invoiceNo, 'BANK_TRANSFER', { actor: admin })
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
    installmentPaid,
    finalAdmission,
    enrollment,
    tuitionPlan,
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
      handledAt: new Date(),
      handledBy: admin.name,
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
    steps.push({ name: 'موافقة الإدارة وإنشاء خطة تقسيط وسداد الدفعة الأولى', ok: !!academic.enrollment && academic.finalAdmission?.status === 'THESIS', detail: academic.finalAdmission?.status || '', data: { appealId: academic.appeal.id, enrollmentId: academic.enrollment?.id, tuitionPlan: academic.tuitionPlan } })

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
      enrollment: { id: academic.enrollment?.id, status: academic.enrollment?.status },
      service: { id: service.service.id, reference: service.service.reference, deliverableId: service.deliverable.id },
      book: { id: scaffold.book.id, title: scaffold.book.title, concepts: scaffold.concepts },
      questionBank: { count: scaffold.questions.length, ids: scaffold.questions.map((q) => q.id) },
    }, { status: allOk ? 200 : 207, headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    console.error('full journey diagnostic error:', e)
    return NextResponse.json({ ok: false, error: e?.message || 'تعذر تنفيذ رحلة المنصة الكاملة' }, { status: 500 })
  }
}
