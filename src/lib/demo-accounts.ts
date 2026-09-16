import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { notify, audit } from '@/lib/notify'
import {
  ensureDemoThesisStudent,
  DEMO_THESIS_STUDENT_EMAIL,
  DEMO_THESIS_STUDENT_PASSWORD,
  DEMO_THESIS_STUDENT_NAME,
  DEMO_THESIS_SUPERVISOR_EMAIL,
  DEMO_THESIS_SUPERVISOR_PASSWORD,
  DEMO_THESIS_SUPERVISOR_NAME,
} from '@/lib/demo-thesis'

export const DEMO_ADMIN_EMAIL = 'admin@aact.academy'
export const DEMO_ADMIN_PASSWORD = 'Admin@2026'

export const DEMO_ACTIVE_STUDENT_EMAIL = 'demo.learning@student.aact.academy'
export const DEMO_ACTIVE_STUDENT_PASSWORD = 'Student@2026'
export const DEMO_ACTIVE_STUDENT_NAME = 'طالب تجريبي قيد الدراسة'

export const DEMO_ACCOUNTS = {
  admin: {
    email: DEMO_ADMIN_EMAIL,
    password: DEMO_ADMIN_PASSWORD,
    role: 'ADMIN',
    note: 'حساب الإدارة الكامل',
  },
  activeStudent: {
    email: DEMO_ACTIVE_STUDENT_EMAIL,
    password: DEMO_ACTIVE_STUDENT_PASSWORD,
    role: 'STUDENT',
    note: 'طالب لا يزال يدرس وفيه تقدم جزئي داخل البرنامج',
  },
  thesisStudent: {
    email: DEMO_THESIS_STUDENT_EMAIL,
    password: DEMO_THESIS_STUDENT_PASSWORD,
    role: 'STUDENT',
    note: 'طالب واصل لمرحلة بحث التخرج والمناقشة عبر الفيديو كونفرنس',
  },
  supervisor: {
    email: DEMO_THESIS_SUPERVISOR_EMAIL,
    password: DEMO_THESIS_SUPERVISOR_PASSWORD,
    role: 'SUPERVISOR',
    note: 'مشرف أكاديمي لتجربة الإشراف والمناقشة',
  },
}

function plusDays(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d
}

async function pickActiveLearningProgram() {
  return (
    (await db.program.findUnique({ where: { slug: 'professional-consulting-skills' } }).catch(() => null)) ||
    (await db.program.findFirst({ where: { active: true, units: { some: {} } }, orderBy: { order: 'asc' } }).catch(() => null)) ||
    (await db.program.findFirst({ where: { active: true }, orderBy: { order: 'asc' } }).catch(() => null))
  )
}

async function ensurePassedUnitAttempts(userId: string, programId: string, mode: 'partial' | 'all') {
  const units = await db.unit.findMany({
    where: { programId },
    include: { exam: { include: { questions: { orderBy: { order: 'asc' } } } } },
    orderBy: { order: 'asc' },
  })

  const selectedUnits = mode === 'all'
    ? units
    : units.slice(0, Math.max(0, Math.min(units.length - 1, Math.ceil(units.length / 2))))

  for (const unit of selectedUnits) {
    if (!unit.exam) continue
    const existing = await db.examAttempt.findFirst({
      where: { userId, examId: unit.exam.id, passed: true },
      select: { id: true },
    })
    if (existing) continue
    await db.examAttempt.create({
      data: {
        userId,
        examId: unit.exam.id,
        score: mode === 'all' ? 92 : 84,
        passed: true,
        status: 'GRADED',
        aiGraded: true,
        feedback: JSON.stringify({
          summary: mode === 'all'
            ? 'محاولة تجريبية ناجحة لفتح مرحلة البحث والمناقشة.'
            : 'محاولة تجريبية ناجحة ضمن تقدم الطالب قيد الدراسة.',
          strengths: ['فهم جيد للمحاور الأساسية', 'ربط المعرفة بالتطبيق المهني'],
          improvements: ['الاستمرار في دراسة الوحدات التالية'],
        }),
        submittedAt: plusDays(mode === 'all' ? -35 : -7),
      },
    })
  }

  return selectedUnits.map((u) => u.id)
}

export async function ensureActiveLearningStudent() {
  const program = await pickActiveLearningProgram()
  if (!program) throw new Error('لا يوجد برنامج نشط لإنشاء الطالب التجريبي قيد الدراسة')

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
    where: { email: DEMO_ACTIVE_STUDENT_EMAIL },
    update: {
      password: hashPassword(DEMO_ACTIVE_STUDENT_PASSWORD),
      name: DEMO_ACTIVE_STUDENT_NAME,
      role: 'STUDENT',
      country: 'الأردن',
      phone: '+962790000000',
    },
    create: {
      email: DEMO_ACTIVE_STUDENT_EMAIL,
      password: hashPassword(DEMO_ACTIVE_STUDENT_PASSWORD),
      name: DEMO_ACTIVE_STUDENT_NAME,
      role: 'STUDENT',
      country: 'الأردن',
      phone: '+962790000000',
    },
  })

  const completedUnitIds = await ensurePassedUnitAttempts(student.id, program.id, 'partial')

  await db.enrollment.upsert({
    where: { userId_programId: { userId: student.id, programId: program.id } },
    update: {
      status: 'ACTIVE',
      completedUnits: JSON.stringify(completedUnitIds),
      finalScore: null,
      certificateNo: null,
    },
    create: {
      userId: student.id,
      programId: program.id,
      status: 'ACTIVE',
      completedUnits: JSON.stringify(completedUnitIds),
    },
  })

  const reference = 'AACT-2026-DEMO-STUDY'
  const approvedAt = plusDays(-14)
  const admission = await db.admissionApplication.upsert({
    where: { reference },
    update: {
      fullName: DEMO_ACTIVE_STUDENT_NAME,
      email: DEMO_ACTIVE_STUDENT_EMAIL,
      phone: '+962790000000',
      country: 'الأردن',
      education: 'BACHELOR',
      program: program.titleAr,
      programId: program.id,
      documents: JSON.stringify(['DEGREE', 'ID', 'CV']),
      notes: 'طالب تجريبي لا يزال يدرس لاختبار بوابة الطالب والوحدات والامتحانات والدفعات والإشراف.',
      acknowledged: true,
      acknowledgedAt: approvedAt,
      status: 'SUPERVISOR_ASSIGNED',
      userId: student.id,
      supervisorId: supervisor.id,
      supervisorAt: approvedAt,
      approvedAt,
      thesisDeadline: plusDays(166),
    },
    create: {
      reference,
      fullName: DEMO_ACTIVE_STUDENT_NAME,
      email: DEMO_ACTIVE_STUDENT_EMAIL,
      phone: '+962790000000',
      country: 'الأردن',
      education: 'BACHELOR',
      program: program.titleAr,
      programId: program.id,
      documents: JSON.stringify(['DEGREE', 'ID', 'CV']),
      notes: 'طالب تجريبي لا يزال يدرس لاختبار بوابة الطالب والوحدات والامتحانات والدفعات والإشراف.',
      acknowledged: true,
      acknowledgedAt: approvedAt,
      status: 'SUPERVISOR_ASSIGNED',
      userId: student.id,
      supervisorId: supervisor.id,
      supervisorAt: approvedAt,
      approvedAt,
      thesisDeadline: plusDays(166),
    },
  })

  await db.payment.upsert({
    where: { invoiceNo: 'AACT-INV-2026-DEMO-STUDY-APP' },
    update: {
      userId: student.id,
      admissionId: admission.id,
      purpose: 'APPLICATION_FEE',
      description: `رسوم تقديم تجريبية مدفوعة لبرنامج ${program.titleAr}`,
      amount: 30,
      status: 'PAID',
      method: 'SANDBOX',
      receiptNo: 'AACT-REC-2026-DEMO-STUDY-APP',
      paidAt: plusDays(-14),
      payerName: DEMO_ACTIVE_STUDENT_NAME,
      payerEmail: DEMO_ACTIVE_STUDENT_EMAIL,
      payerCountry: 'الأردن',
    },
    create: {
      userId: student.id,
      admissionId: admission.id,
      invoiceNo: 'AACT-INV-2026-DEMO-STUDY-APP',
      purpose: 'APPLICATION_FEE',
      description: `رسوم تقديم تجريبية مدفوعة لبرنامج ${program.titleAr}`,
      amount: 30,
      status: 'PAID',
      method: 'SANDBOX',
      receiptNo: 'AACT-REC-2026-DEMO-STUDY-APP',
      paidAt: plusDays(-14),
      payerName: DEMO_ACTIVE_STUDENT_NAME,
      payerEmail: DEMO_ACTIVE_STUDENT_EMAIL,
      payerCountry: 'الأردن',
    },
  })

  await notify(
    student.id,
    'GENERAL',
    'حسابك التجريبي قيد الدراسة جاهز',
    'هذا الحساب مخصص لاختبار بوابة الطالب أثناء الدراسة: الوحدات، الامتحانات، الدفعات، الإشراف والمشرف الذكي.',
    'dashboard'
  ).catch(() => {})

  await audit(null, 'ENSURE_DEMO_ACTIVE_STUDENT', 'User', student.id, `${DEMO_ACTIVE_STUDENT_EMAIL} — ${program.titleAr}`).catch(() => {})

  return {
    student: {
      id: student.id,
      name: DEMO_ACTIVE_STUDENT_NAME,
      email: DEMO_ACTIVE_STUDENT_EMAIL,
      password: DEMO_ACTIVE_STUDENT_PASSWORD,
    },
    program: { id: program.id, title: program.titleAr },
    completedUnitIds,
  }
}

export async function ensurePlatformDemoAccounts(options: { resetDefense?: boolean } = {}) {
  const activeStudent = await ensureActiveLearningStudent()
  const thesisStudent = await ensureDemoThesisStudent({ resetDefense: !!options.resetDefense, actor: null })
  return {
    accounts: DEMO_ACCOUNTS,
    activeStudent,
    thesisStudent,
  }
}
