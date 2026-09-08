import { PrismaClient } from '@prisma/client'
import { allSeedPrograms } from '../src/lib/academyData'

const prisma = new PrismaClient()

async function hashPassword(password: string): Promise<string> {
  const { randomBytes, scryptSync } = await import('crypto')
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

async function main() {
  console.log('🌱 Seeding AACT database...')

  for (const p of allSeedPrograms) {
    const program = await prisma.program.upsert({
      where: { slug: p.slug },
      update: {
        titleAr: p.titleAr,
        titleEn: p.titleEn,
        description: p.description,
        category: p.category,
        hours: p.hours,
        price: p.price,
        icon: p.icon,
        features: JSON.stringify(p.features),
        order: p.order,
      },
      create: {
        slug: p.slug,
        titleAr: p.titleAr,
        titleEn: p.titleEn,
        description: p.description,
        category: p.category,
        hours: p.hours,
        price: p.price,
        icon: p.icon,
        features: JSON.stringify(p.features),
        order: p.order,
      },
    })
    console.log(`  ✓ Program: ${p.titleAr}`)

    for (const u of p.units) {
      const existing = await prisma.unit.findFirst({
        where: { programId: program.id, order: u.order },
      })
      const unitData = {
        programId: program.id,
        order: u.order,
        title: u.title,
        summary: u.summary,
        content: JSON.stringify(u.content),
        objectives: JSON.stringify(u.objectives),
      }
      const unit = existing
        ? await prisma.unit.update({ where: { id: existing.id }, data: unitData })
        : await prisma.unit.create({ data: unitData })
      console.log(`    ✓ Unit ${u.order}: ${u.title}`)

      // Exam
      const existingExam = await prisma.exam.findUnique({ where: { unitId: unit.id } })
      const examData = { unitId: unit.id, title: u.exam.title, passScore: u.exam.passScore }
      const exam = existingExam
        ? await prisma.exam.update({ where: { id: existingExam.id }, data: examData })
        : await prisma.exam.create({ data: examData })

      // Clear and recreate questions
      await prisma.question.deleteMany({ where: { examId: exam.id } })
      for (let i = 0; i < u.exam.questions.length; i++) {
        const q = u.exam.questions[i]
        await prisma.question.create({
          data: {
            examId: exam.id,
            order: i + 1,
            type: q.type,
            text: q.text,
            options: q.options ? JSON.stringify(q.options) : null,
            correctAnswer: q.correctAnswer,
            modelAnswer: q.modelAnswer,
            points: q.points,
          },
        })
      }
      console.log(`      ✓ Exam with ${u.exam.questions.length} questions`)
    }
  }

  // Admin account
  const adminEmail = 'admin@aact.academy'
  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } })
  if (!existingAdmin) {
    await prisma.user.create({
      data: {
        email: adminEmail,
        password: await hashPassword('Admin@2026'),
        name: 'إدارة الأكاديمية',
        role: 'ADMIN',
        country: 'USA',
      },
    })
    console.log('  ✓ Admin account: admin@aact.academy / Admin@2026')
  } else {
    console.log('  ℹ Admin account already exists')
  }

  // Demo student account
  const demoEmail = 'student@demo.com'
  const existingDemo = await prisma.user.findUnique({ where: { email: demoEmail } })
  if (!existingDemo) {
    const demo = await prisma.user.create({
      data: {
        email: demoEmail,
        password: await hashPassword('Demo@2026'),
        name: 'طالب تجريبي',
        role: 'STUDENT',
        country: 'EG',
      },
    })
    const firstProgram = await prisma.program.findUnique({
      where: { slug: 'professional-consulting-skills' },
    })
    if (firstProgram) {
      await prisma.enrollment.create({
        data: { userId: demo.id, programId: firstProgram.id },
      })
    }
    console.log('  ✓ Demo student: student@demo.com / Demo@2026')
  } else {
    console.log('  ℹ Demo student already exists')
  }

  // ===== بيانات تجريبية للوحدات الجديدة =====
  const demo = await prisma.user.findUnique({ where: { email: demoEmail } })
  const admin = await prisma.user.findUnique({ where: { email: adminEmail } })

  // طلب التحقق المعتمد للطالب التجريبي (مع مشرف ومهلة بحث)
  if (demo && !(await prisma.admissionApplication.findFirst({ where: { email: demoEmail } }))) {
    const approvedAt = new Date()
    approvedAt.setMonth(approvedAt.getMonth() - 2) // قبل شهرين
    const deadline = new Date(approvedAt)
    deadline.setMonth(deadline.getMonth() + 6)
    const admission = await prisma.admissionApplication.create({
      data: {
        reference: 'AACT-2026-1001',
        fullName: 'طالب تجريبي',
        email: demoEmail,
        phone: '+201000000000',
        country: 'مصر',
        education: 'BACHELOR',
        program: 'دبلوم مهارات الاستشاري المحترف',
        documents: JSON.stringify(['بكالوريوس', 'كشف العلامات', 'الهوية', 'صورة شخصية']),
        status: 'SUPERVISOR_ASSIGNED',
        userId: demo.id,
        supervisorId: admin?.id,
        supervisorAt: new Date(),
        approvedAt,
        thesisDeadline: deadline,
      },
    })
    // فاتورتان: رسوم تقديم مسددة + رسوم دراسية معلقة
    await prisma.payment.create({
      data: {
        userId: demo.id,
        admissionId: admission.id,
        invoiceNo: 'AACT-INV-2026-1001',
        purpose: 'APPLICATION_FEE',
        description: 'رسوم التقديم وحجز المقعد (غير مستردة) — دبلوم مهارات الاستشاري المحترف',
        amount: 30,
        status: 'PAID',
        method: 'PAYMOB',
        receiptNo: 'AACT-REC-2026-1001',
        paidAt: new Date(),
        payerName: 'طالب تجريبي',
        payerEmail: demoEmail,
        payerCountry: 'مصر',
      },
    })
    await prisma.payment.create({
      data: {
        userId: demo.id,
        admissionId: admission.id,
        invoiceNo: 'AACT-INV-2026-1002',
        purpose: 'TUITION',
        description: 'الرسوم الدراسية الكاملة — دبلوم مهارات الاستشاري المحترف',
        amount: 350,
        payerName: 'طالب تجريبي',
        payerEmail: demoEmail,
        payerCountry: 'مصر',
      },
    })
    // إشعارات ترحيبية
    await prisma.notification.createMany({
      data: [
        {
          userId: demo.id,
          type: 'ADMISSION',
          title: 'تم تعيين مشرفك الأكاديمي',
          body: 'تم تعيين إدارة الأكاديمية مشرفاً أكاديمياً لطلبك (AACT-2026-1001) — يمكنك مراسلة المشرف الذكي في أي وقت.',
        },
        {
          userId: demo.id,
          type: 'PAYMENT',
          title: 'تذكير بسداد الرسوم الدراسية',
          body: 'تبقى سداد الرسوم الدراسية الكاملة (350$) لطلبك AACT-2026-1001 لاستكمال التسجيل النهائي.',
        },
      ],
    })
    console.log('  ✓ Demo admission + invoices + notifications')
  }

  // وكيل دولي معتمد تجريبي مرتبط بحساب الطالب التجريبي (لبوابة الوكيل)
  if (demo && !(await prisma.agentApplication.findFirst({ where: { email: demoEmail } }))) {
    const start = new Date()
    start.setMonth(start.getMonth() - 4)
    const end = new Date(start)
    end.setFullYear(end.getFullYear() + 1)
    const agent = await prisma.agentApplication.create({
      data: {
        kind: 'AGENCY',
        orgName: 'مؤسسة الشراكة الدولية للتدريب',
        repName: 'طالب تجريبي',
        email: demoEmail,
        phone: '+201000000000',
        country: 'مصر',
        territory: 'جمهورية مصر العربية',
        experience: 'خبرة 8 سنوات في تنفيذ البرامج التدريبية وإدارة مراكز التدريب المعتمدة.',
        status: 'APPROVED',
        contractNo: 'AACT-AG-2026-001',
        commissionRate: 25,
        committeeFee: 100,
        exclusive: true,
        startDate: start,
        endDate: end,
      },
    })
    // عمولة برامج + مستحق لجنة
    const due1 = new Date()
    due1.setDate(due1.getDate() + 10)
    await prisma.revenueShareTransaction.createMany({
      data: [
        {
          agentId: agent.id,
          type: 'REVENUE_SHARE',
          description: 'عمولة 25% عن دبلومة إدارة المشاريع المنفذة بالقاهرة (12 متدرباً)',
          amount: 1050,
          dueDate: due1,
          programCountry: 'مصر',
        },
        {
          agentId: agent.id,
          type: 'COMMITTEE_FEE',
          description: 'مشاركة في لجنة مناقشة بحث «أثر التدريب التنفيذي على الأداء القيادي» — 100$ وفق العقد',
          amount: 100,
          status: 'PAID',
          dueDate: new Date(),
          paidAt: new Date(),
          programCountry: 'مصر',
        },
      ],
    })
    console.log('  ✓ Demo approved agent + revenue shares')
  }

  // اعتماد مستشار معتمد (يظهر في الدليل العام وصفحة التحقق)
  if (!(await prisma.agentApplication.findFirst({ where: { orgName: 'د. سارة الحربي — استشارات إدارية' } }))) {
    const agent2 = await prisma.agentApplication.create({
      data: {
        kind: 'ACCREDITATION',
        accreditationType: 'CONSULTANT',
        orgName: 'د. سارة الحربي — استشارات إدارية',
        repName: 'د. سارة الحربي',
        email: 'sara@example.com',
        phone: '+966500000000',
        country: 'السعودية',
        experience: 'دكتوراه في الإدارة، خبرة 12 عاماً في الاستشارات الإدارية وريادة الأعمال.',
        status: 'APPROVED',
      },
    })
    await prisma.certificate.create({
      data: {
        serial: 'AACT-C-2026-00001',
        qrToken: 'demo-qr-token-sarah-consultant-2026',
        type: 'ACCREDITATION',
        holderName: 'د. سارة الحربي — استشارات إدارية',
        program: 'اعتماد مستشار دولي (إداري ومالي)',
        country: 'السعودية',
        agentId: agent2.id,
      },
    })
    console.log('  ✓ Demo accreditation certificate (directory + verify)')
  }

  // إعدادات الرسوم الافتراضية (تحفظ في قاعدة البيانات للتعديل بدون كود)
  const { DEFAULT_SETTINGS } = await import('../src/lib/settings')
  for (const s of DEFAULT_SETTINGS) {
    await prisma.setting.upsert({
      where: { key: s.key },
      create: { key: s.key, value: s.value },
      update: {},
    })
  }
  console.log('  ✓ Default settings seeded')

  console.log('✅ Seeding complete!')
}

main()
  .catch((e) => {
    console.error('❌ Seed error:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
