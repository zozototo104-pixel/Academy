import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { audit, notify } from '@/lib/notify'

export const DEMO_THESIS_STUDENT_EMAIL = 'demo.thesis@student.aact.academy'
export const DEMO_THESIS_STUDENT_PASSWORD = 'Student@2026'
export const DEMO_THESIS_STUDENT_NAME = 'طالب تجريبي للمناقشة'

export const DEMO_THESIS_SUPERVISOR_EMAIL = 'demo.supervisor@aact.academy'
export const DEMO_THESIS_SUPERVISOR_PASSWORD = 'Supervisor@2026'
export const DEMO_THESIS_SUPERVISOR_NAME = 'مشرف أكاديمي تجريبي'

const DEMO_REFERENCE = 'AACT-2026-DEMO-VC'
const DEMO_INVOICE = 'AACT-INV-2026-DEMO-VC'
const DEMO_RECEIPT = 'AACT-REC-2026-DEMO-VC'
const DEMO_PROGRAM_SLUG = 'professional-masters-project-management'

function plusDays(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d
}

function minusMinutes(minutes: number) {
  const d = new Date()
  d.setMinutes(d.getMinutes() - minutes)
  return d
}

async function pickDemoProgram() {
  return (
    (await db.program.findUnique({ where: { slug: DEMO_PROGRAM_SLUG } }).catch(() => null)) ||
    (await db.program.findFirst({ where: { category: 'MASTERS', active: true }, orderBy: { order: 'asc' } })) ||
    (await db.program.findFirst({ where: { active: true }, orderBy: { order: 'asc' } }))
  )
}

export async function ensureDemoThesisStudent(options: { resetDefense?: boolean; actor?: { id?: string | null; name: string } | null } = {}) {
  const program = await pickDemoProgram()
  if (!program) throw new Error('لا يوجد برنامج نشط لربط الطالب التجريبي به')

  const supervisor = await db.user.upsert({
    where: { email: DEMO_THESIS_SUPERVISOR_EMAIL },
    update: {
      password: hashPassword(DEMO_THESIS_SUPERVISOR_PASSWORD),
      name: DEMO_THESIS_SUPERVISOR_NAME,
      role: 'SUPERVISOR',
      country: 'USA',
      phone: '+10000000001',
    },
    create: {
      email: DEMO_THESIS_SUPERVISOR_EMAIL,
      password: hashPassword(DEMO_THESIS_SUPERVISOR_PASSWORD),
      name: DEMO_THESIS_SUPERVISOR_NAME,
      role: 'SUPERVISOR',
      country: 'USA',
      phone: '+10000000001',
    },
  })

  const student = await db.user.upsert({
    where: { email: DEMO_THESIS_STUDENT_EMAIL },
    update: {
      password: hashPassword(DEMO_THESIS_STUDENT_PASSWORD),
      name: DEMO_THESIS_STUDENT_NAME,
      role: 'STUDENT',
      country: 'مصر',
      phone: '+201000000001',
    },
    create: {
      email: DEMO_THESIS_STUDENT_EMAIL,
      password: hashPassword(DEMO_THESIS_STUDENT_PASSWORD),
      name: DEMO_THESIS_STUDENT_NAME,
      role: 'STUDENT',
      country: 'مصر',
      phone: '+201000000001',
    },
  })

  const approvedAt = plusDays(-45)
  const thesisDeadline = plusDays(135)
  const committee = ['د. أحمد سمير — عضو لجنة', 'د. منى عبد الله — عضو لجنة', 'المستشار الذكي AI — خبير مناقشة']

  const admission = await db.admissionApplication.upsert({
    where: { reference: DEMO_REFERENCE },
    update: {
      fullName: DEMO_THESIS_STUDENT_NAME,
      email: DEMO_THESIS_STUDENT_EMAIL,
      phone: '+201000000001',
      country: 'مصر',
      education: 'BACHELOR',
      program: program.titleAr,
      programId: program.id,
      documents: JSON.stringify(['DEGREE', 'TRANSCRIPT', 'ID', 'PHOTO', 'CV']),
      notes: 'طلب تجريبي جاهز لمعاينة قاعة الفيديو كونفرنس ودور المشرف الذكي في مناقشة بحث التخرج.',
      acknowledged: true,
      acknowledgedAt: approvedAt,
      status: 'SCHEDULED',
      userId: student.id,
      supervisorId: supervisor.id,
      supervisorAt: approvedAt,
      approvedAt,
      thesisDeadline,
    },
    create: {
      reference: DEMO_REFERENCE,
      fullName: DEMO_THESIS_STUDENT_NAME,
      email: DEMO_THESIS_STUDENT_EMAIL,
      phone: '+201000000001',
      country: 'مصر',
      education: 'BACHELOR',
      program: program.titleAr,
      programId: program.id,
      documents: JSON.stringify(['DEGREE', 'TRANSCRIPT', 'ID', 'PHOTO', 'CV']),
      notes: 'طلب تجريبي جاهز لمعاينة قاعة الفيديو كونفرنس ودور المشرف الذكي في مناقشة بحث التخرج.',
      acknowledged: true,
      acknowledgedAt: approvedAt,
      status: 'SCHEDULED',
      userId: student.id,
      supervisorId: supervisor.id,
      supervisorAt: approvedAt,
      approvedAt,
      thesisDeadline,
    },
  })

  await db.enrollment.upsert({
    where: { userId_programId: { userId: student.id, programId: program.id } },
    update: { status: 'ACTIVE' },
    create: {
      userId: student.id,
      programId: program.id,
      status: 'ACTIVE',
      completedUnits: '[]',
    },
  })

  await db.payment.upsert({
    where: { invoiceNo: DEMO_INVOICE },
    update: {
      userId: student.id,
      admissionId: admission.id,
      purpose: 'TUITION',
      description: `فاتورة تجريبية مدفوعة لبرنامج ${program.titleAr}`,
      amount: program.price || 700,
      currency: 'USD',
      method: 'SANDBOX',
      status: 'PAID',
      receiptNo: DEMO_RECEIPT,
      provider: 'SANDBOX',
      paidViaWebhook: false,
      paidAt: new Date(),
      payerName: DEMO_THESIS_STUDENT_NAME,
      payerEmail: DEMO_THESIS_STUDENT_EMAIL,
      payerCountry: 'مصر',
    },
    create: {
      userId: student.id,
      admissionId: admission.id,
      invoiceNo: DEMO_INVOICE,
      purpose: 'TUITION',
      description: `فاتورة تجريبية مدفوعة لبرنامج ${program.titleAr}`,
      amount: program.price || 700,
      currency: 'USD',
      method: 'SANDBOX',
      status: 'PAID',
      receiptNo: DEMO_RECEIPT,
      provider: 'SANDBOX',
      paidViaWebhook: false,
      paidAt: new Date(),
      payerName: DEMO_THESIS_STUDENT_NAME,
      payerEmail: DEMO_THESIS_STUDENT_EMAIL,
      payerCountry: 'مصر',
    },
  })

  const title = 'دور المشرف الذكي في تحسين جودة مناقشات بحث التخرج عن بعد'
  const abstract = 'يتناول هذا البحث التجريبي أثر توظيف المشرف الذكي داخل قاعة الفيديو كونفرنس في دعم لجنة المناقشة، من خلال تحليل إجابات الطالب فورياً، وطرح أسئلة متابعة، وتوليد محضر جلسة تلقائي، وتقديم توصية أكاديمية تساعد اللجنة دون أن تلغي دورها البشري. يركّز البحث على جودة التواصل، وضبط زمن المناقشة، وقياس وضوح المشكلة والمنهجية والنتائج والتوصيات.'

  const existingThesis = await db.thesisSubmission.findFirst({
    where: { userId: student.id, admissionId: admission.id },
    orderBy: { createdAt: 'desc' },
  })

  const thesisData = {
    title,
    abstract,
    fileNote: 'بحث تجريبي داخلي لمعاينة الفيديو كونفرنس والمشرف الذكي.',
    status: 'SCHEDULED',
    defenseDate: minusMinutes(1),
    committee: JSON.stringify(committee),
    agentMember: null,
    defenseStatus: null,
    aiScore: null,
    aiRecommendation: null,
    defenseMinutes: null,
    recordingData: null,
    recordingMime: null,
    recordingSize: null,
    recordingDurationSec: null,
    defenseCompletedAt: null,
    resultScore: null,
    passed: null,
    reviewedAt: null,
  }

  const thesis = existingThesis
    ? await db.thesisSubmission.update({ where: { id: existingThesis.id }, data: thesisData })
    : await db.thesisSubmission.create({
        data: {
          userId: student.id,
          admissionId: admission.id,
          ...thesisData,
        },
      })

  if (options.resetDefense) {
    await db.defenseMessage.deleteMany({ where: { thesisId: thesis.id } })
    await db.defenseSignal.deleteMany({ where: { thesisId: thesis.id } })
    await db.defenseParticipant.deleteMany({ where: { thesisId: thesis.id } })
  }

  if (options.resetDefense) {
    await notify(
      student.id,
      'DEFENSE',
      'مناقشة تجريبية جاهزة الآن',
      'تم تجهيز بحث تخرج تجريبي ومناقشته مفتوحة الآن لمعاينة الفيديو كونفرنس ودور المشرف الذكي داخل القاعة.',
      'dashboard'
    ).catch(() => {})
  }

  await audit(options.actor || null, 'CREATE_DEMO_THESIS_STUDENT', 'ThesisSubmission', thesis.id, `${DEMO_THESIS_STUDENT_EMAIL} — ${program.titleAr}`).catch(() => {})

  return {
    student: {
      id: student.id,
      name: DEMO_THESIS_STUDENT_NAME,
      email: DEMO_THESIS_STUDENT_EMAIL,
      password: DEMO_THESIS_STUDENT_PASSWORD,
    },
    supervisor: {
      id: supervisor.id,
      name: DEMO_THESIS_SUPERVISOR_NAME,
      email: DEMO_THESIS_SUPERVISOR_EMAIL,
      password: DEMO_THESIS_SUPERVISOR_PASSWORD,
    },
    admission: {
      id: admission.id,
      reference: admission.reference,
      status: 'SCHEDULED',
      program: program.titleAr,
    },
    thesis: {
      id: thesis.id,
      title: thesis.title,
      status: thesis.status,
      defenseDate: thesis.defenseDate,
    },
  }
}
