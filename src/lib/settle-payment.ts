import { db } from '@/lib/db'
import { nextCertSerial, nextReceiptNo } from '@/lib/settings'
import { notify, audit } from '@/lib/notify'
import { emailCertificateIssued, emailPaymentReceipt, emailFinalRegistration } from '@/lib/mailer'
import { getAdmissionTuitionPlan } from '@/lib/tuition-installments'
import { grantGeminiLiveCredit } from '@/lib/live-usage-guard'
import { paymentAmountDollars } from '@/lib/money'
import { captureEnrollmentSnapshot } from '@/lib/rules-snapshot'
import { ensureSemesterStates } from '@/lib/semester-lifecycle'
import { randomBytes } from 'crypto'

const ACC_TYPE_LABEL_SETTLE: Record<string, string> = {
  COMPANY: 'اعتماد هيئة تدريبية (شركة/مؤسسة/مركز)',
  CONSULTANT: 'اعتماد مستشار دولي',
  TRAINER: 'اعتماد مدرب دولي معتمد',
  QUALITY: 'اعتماد الجودة',
}

// حارس نطاق إصدار الشهادة عند السداد — دالة نقية قابلة للاختبار:
// الشهادة تُصدر فقط لفاتورة رسوم فئة اعتماد على طلب معتمد بلا شهادة.
// مدفوعات الطلاب (تقديم/رسوم دراسية) ورسوم تقديم الاعتماد نفسها لا
// تصدر شهادة أبداً؛ شهادات الطلاب من المسار الأكاديمي فقط.
export function accreditationCertificateDue(
  payment: { purpose?: string | null; agentId?: string | null },
  agent: { status?: string | null; kind?: string | null; certificates?: unknown[] | null } | null,
): boolean {
  return (
    payment.purpose === 'ACCREDITATION' &&
    !!payment.agentId &&
    !!agent &&
    agent.status === 'APPROVED' &&
    agent.kind === 'ACCREDITATION' &&
    !(agent.certificates && agent.certificates.length > 0)
  )
}

// ===== تسوية فاتورة: تُستخدم من تأكيد الدفع داخل المنصة ومن Webhook المزودين =====
// تُطبق آثار السداد الكاملة: الإيصال + تحويل حالة طلب الالتحاق + تفعيل التسجيل + الإشعارات والبريد

export interface SettleResult {
  ok: boolean
  error?: string
  payment?: any
  receiptNo?: string
}

type FinalizeAdmissionAfterSettlementOptions = {
  source: 'PAYMENT' | 'WAIVER'
  actor?: { id?: string | null; name: string } | null
  payment?: any
  receiptNo?: string
  amountDollars?: number
  // استئناف بعد عطل سابق: تُنفَّذ انتقالات الحالة المحروسة فقط، وتُتخطّى
  // إشعارات/رسائل الإيصال حتى لا تتكرر على الطالب.
  resume?: boolean
}

// A freshly activated student must carry a durable ENROLLMENT snapshot:
// the progression gate uses its provenance even when a program has no
// configured semester windows. Never silently treat a failed write as a
// grandfathered legacy enrollment; payment settlement can retry its effects.
async function initializeAcademicEnrollment(tx: any, enrollment: {
  id: string; userId: string; programId: string; createdAt: Date | string; extensionDays?: number | null
}) {
  const snapshot = await captureEnrollmentSnapshot(tx, enrollment, 'ENROLLMENT')
  if (!snapshot) throw new Error('ENROLLMENT_RULES_SNAPSHOT_REQUIRED')
  const program = await tx.program.findUnique({
    where: { id: enrollment.programId },
    select: { category: true, maxStudyDays: true, semestersCount: true },
  })
  if (!program) throw new Error('ENROLLMENT_PROGRAM_NOT_FOUND')
  await ensureSemesterStates(tx, enrollment, program)
}

// إنشاء الالتحاق متسامح مع سباق الإنشاء: مسارا تسوية (تأكيد دفع نقدي
// واعتماد إعفاء) قد يصلا إلى تفعيل نفس القبول في اللحظة نفسها، فيجد كلٌّ
// منهما «لا التحاق» ثم يصطدم إنشاء الخاسر بقيد تفرد (userId, programId)
// فيرمي P2002 — وفي مسار الإعفاء يُستدعى التفعيل بعد التزام المعاملة بلا
// أي صيد، فيرى المشرف خطأ 500 رغم أن المال التزم والالتحاق موجود من
// الفائز. عند الاصطدام نعيد قراءة صف الفائز ونكمل بقية آثار التفعيل
// عليه (اللقطة وحالات الفصول محروسة بـcreate-once فلا تتكرر). كل
// المستدعين الحاليين يمررون عميل الجذر (db) في وضع الالتزام التلقائي،
// فإعادة القراءة بعد الاصطدام آمنة؛ داخل معاملة تفاعلية حقيقية تُبطل
// PostgreSQL المعاملة عند P2002 ولا يصلح معها إلا إعادة تنفيذها كلها.
async function createEnrollmentAfterRace(tx: any, userId: string, programId: string) {
  try {
    return await tx.enrollment.create({ data: { userId, programId, status: 'ACTIVE' } })
  } catch (error: any) {
    if (error?.code !== 'P2002') throw error
    const winner = await tx.enrollment.findUnique({ where: { userId_programId: { userId, programId } } })
    if (!winner) throw error
    return winner
  }
}

export async function finalizeAdmissionAfterSettlement(tx: any, admissionId: string, opts: FinalizeAdmissionAfterSettlementOptions = { source: 'PAYMENT' }) {
  const app = await tx.admissionApplication.findUnique({ where: { id: admissionId } })
  if (!app) return null

  let linkedUserId = app.userId
  if (!linkedUserId && app.email) {
    const matchedUser = await tx.user.findUnique({ where: { email: app.email.trim().toLowerCase() }, select: { id: true, role: true } }).catch(() => null)
    if (matchedUser?.role === 'STUDENT') {
      linkedUserId = matchedUser.id
      await tx.admissionApplication.update({ where: { id: app.id }, data: { userId: linkedUserId } }).catch(() => {})
    }
  }
  if (linkedUserId) {
    await tx.payment.updateMany({ where: { admissionId: app.id, OR: [{ userId: null }, { NOT: { userId: linkedUserId } }] }, data: { userId: linkedUserId } }).catch(() => {})
  }

  const all = await tx.payment.findMany({ where: { admissionId: app.id } })
  const isSettled = (status?: string | null) => status === 'PAID' || status === 'WAIVED'
  const allSettled = all.length > 0 && all.every((p: any) => isSettled(p.status))
  const feeSettled = all.some((p: any) => p.purpose === 'APPLICATION_FEE' && isSettled(p.status))
  const tuitionSettled = all.some((p: any) => ['TUITION', 'TUITION_INSTALLMENT'].includes(p.purpose) && isSettled(p.status))

  if (opts.source === 'PAYMENT') {
    const payment = opts.payment
    const receiptNo = opts.receiptNo || payment?.receiptNo || ''
    const amountDollars = opts.amountDollars ?? (payment ? paymentAmountDollars(payment) : 0)
    const amountLabel = amountDollars.toFixed(2)
    const tuitionPlan = await getAdmissionTuitionPlan(app.id)
    const installmentActivationReady =
      tuitionPlan?.appealStatus === 'APPROVED' &&
      app.status === 'AWAITING_TUITION' &&
      tuitionPlan.approvedInitialAmount !== null &&
      tuitionPlan.paidTuition >= tuitionPlan.approvedInitialAmount
    let newStatus = app.status
    let finalRegistration = false
    let installmentRegistration = false

    // 1) بعد سداد رسوم التقديم (30$): الملف يُحوَّل تلقائياً للإدارة للدراسة والإقرار
    if (feeSettled && app.status === 'AWAITING_FEE') {
      newStatus = 'UNDER_REVIEW'
      const admins = await tx.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
      for (const a of admins) {
        await notify(
          a.id,
          'ADMISSION',
          'طلب التحاق بانتظار دراستكم وإقراركم',
          `المتقدم ${app.fullName} (${app.country}) سدد رسوم التقديم لطلب (${app.reference}) — برنامج: ${app.program}. الملف مكتمل بالمستندات — راجعه ووافق لإصدار فاتورة الرسوم الدراسية الكاملة.`,
          'admin'
        )
      }
    }

    // 2) بعد موافقة الإدارة وسداد الرسوم الدراسية كاملة، أو قبول التقسيط وسداد الدفعة الأولى المعتمدة: تفعيل الالتحاق
    if ((all.every((p: any) => isSettled(p.status)) || installmentActivationReady) && app.status === 'AWAITING_TUITION') {
      newStatus = app.supervisorId ? 'THESIS' : 'SUPERVISOR_ASSIGNED'
      finalRegistration = true
      installmentRegistration = !!installmentActivationReady && !all.every((p: any) => isSettled(p.status))
      if (app.programId && linkedUserId) {
        const existingEnrollment = await tx.enrollment.findUnique({
          where: { userId_programId: { userId: linkedUserId, programId: app.programId } },
        })
        const activeEnrollment = existingEnrollment || await createEnrollmentAfterRace(tx, linkedUserId, app.programId)
        await initializeAcademicEnrollment(tx, activeEnrollment)
      }
    }

    if (newStatus !== app.status) {
      await tx.admissionApplication.update({ where: { id: app.id }, data: { status: newStatus } })
    }
    if (payment && receiptNo && !opts.resume) {
      await notify(
        linkedUserId,
        'PAYMENT',
        'تم استلام دفعتك بنجاح',
        `سُددت فاتورة «${payment.description}» بمبلغ ${amountLabel}$ — رقم الإيصال ${receiptNo}.`,
        'dashboard'
      )
      if (app.email) {
        await emailPaymentReceipt(app.email, app.fullName, payment.invoiceNo, payment.description, amountDollars, receiptNo)
      }
      if (payment.purpose === 'SERVICE_FEE') {
        const admins = await tx.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
        for (const admin of admins) {
          await notify(
            admin.id,
            'SERVICE',
            'الخدمة مدفوعة وجاهزة للتنفيذ والتسليم',
            `تم سداد فاتورة خدمة «${app.program}» للعميل ${app.fullName} (${app.reference}) — رقم الإيصال ${receiptNo}. يمكن الآن رفع المخرج من قسم تنفيذ وتسليم الخدمة.`,
            'admin'
          )
        }
        await audit(opts.actor || null, 'SERVICE_READY_FOR_DELIVERY', 'AdmissionApplication', app.id, `${app.reference} — خدمة مدفوعة وجاهزة للتسليم`)
      }
    }
    if (finalRegistration && linkedUserId) {
      await notify(
        linkedUserId,
        'ADMISSION',
        installmentRegistration ? 'تم تفعيل تسجيلك وفق خطة التقسيط المعتمدة' : 'التسجيل النهائي مكتمل — أهلاً بك في برنامجك!',
        installmentRegistration
          ? `تم تفعيل تسجيلك في «${app.program}» بعد سداد الدفعة الأولى المعتمدة. تذكير: لا يفتح امتحان الفصل الأول قبل سداد نصف الرسوم، ولا يفتح امتحان الفصل الثاني قبل سداد كامل المتبقي.`
          : `مبروك! بعد سداد الرسوم الدراسية كاملة أصبح تسجيلك النهائي في «${app.program}» فعالاً — يمكنك الآن الدخول لبوابة الطالب وقراءة الكتب المقررة والبدء مع مشرفك الذكي${app.supervisorId ? ' ومشرفك الأكاديمي' : ''}.`,
        'dashboard'
      )
      const student = await tx.user.findUnique({ where: { id: linkedUserId }, select: { email: true, name: true } })
      if (student) await emailFinalRegistration(student.email, student.name, app.program)
      await audit(
        { id: linkedUserId, name: app.fullName },
        'FINAL_REGISTRATION',
        'Enrollment',
        app.id,
        `تسجيل نهائي فعّال: ${app.fullName} — ${app.program} (${app.reference}) — ${receiptNo}`
      )
    }
    return { admissionId: app.id, userId: linkedUserId, allSettled, feeSettled, tuitionSettled, finalRegistration }
  }

  if (feeSettled && app.status === 'AWAITING_FEE' && !tuitionSettled) {
    await tx.admissionApplication.update({ where: { id: app.id }, data: { status: 'AWAITING_TUITION' } })
  }

  if (allSettled && tuitionSettled && ['AWAITING_FEE', 'UNDER_REVIEW', 'AWAITING_TUITION'].includes(String(app.status || ''))) {
    const newStatus = app.supervisorId ? 'THESIS' : 'SUPERVISOR_ASSIGNED'
    // ترتيب الآثار (بند 7 — مرآة فرع PAYMENT): الالتحاق يُنشأ ويُهيَّأ
    // أولًا، وحالة القبول تُكتب بعده. كتابة الحالة أولًا كانت تجعل أي
    // عطل منتصف التفعيل (إنشاء الالتحاق مثلًا) يترك القبول متقدمًا بلا
    // التحاق وشرط دخول هذا الفرع منتفيًا — فلا ترى إعادة المحاولة
    // شيئًا تستأنفه ويضيع التفعيل بصمت رغم التزام المال.
    let activated = false
    if (app.programId && linkedUserId) {
      const existingEnrollment = await tx.enrollment.findUnique({ where: { userId_programId: { userId: linkedUserId, programId: app.programId } } })
      const foundEnrollment = existingEnrollment || await createEnrollmentAfterRace(tx, linkedUserId, app.programId)
      const activeEnrollment = !['ACTIVE', 'COMPLETED'].includes(foundEnrollment.status)
        ? await tx.enrollment.update({ where: { id: foundEnrollment.id }, data: { status: 'ACTIVE' } })
        : foundEnrollment
      await initializeAcademicEnrollment(tx, activeEnrollment)
      activated = true
    }
    await tx.admissionApplication.update({ where: { id: app.id }, data: { status: newStatus } })
    if (activated && linkedUserId) {
      await notify(linkedUserId, 'ADMISSION', 'تم تفعيل تسجيلك بمنحة/إعفاء', `أصبح تسجيلك في «${app.program}» فعالاً.`, 'dashboard')
      const student = await tx.user.findUnique({ where: { id: linkedUserId }, select: { email: true, name: true } }).catch(() => null)
      if (student) await emailFinalRegistration(student.email, student.name, app.program)
    }
    await audit(opts.actor || { name: opts.source }, 'FINAL_REGISTRATION_BY_WAIVER', 'AdmissionApplication', app.id, `${app.reference} — ${app.program}`)
  }

  const waived = all.find((p: any) => p.status === 'WAIVED' && !p.receiptNo)
  if (waived) {
    const receiptNo = await nextReceiptNo()
    await tx.payment.update({ where: { id: waived.id }, data: { receiptNo, method: 'WAIVER', paidAt: new Date() } }).catch(() => null)
    if (linkedUserId) await notify(linkedUserId, 'PAYMENT', 'تم اعتماد الإعفاء/المنحة', `تمت تسوية الفاتورة ${waived.invoiceNo} كإعفاء/منحة بقيمة 0$ — رقم الإيصال ${receiptNo}.`, 'dashboard')
  }
  return { admissionId: app.id, userId: linkedUserId, allSettled, feeSettled, tuitionSettled }
}

// آثار قلب الفاتورة إلى PAID: إنهاء الالتحاق، تفعيل التسجيل، رصيد الصوت،
// تنبيهات الوكالة/الاعتماد وإصدار شهادتها، والتدقيق الختامي. كل أثر محروس
// بحالته فلا يتكرر عند إعادة التشغيل — وهذا هو إصلاح فخ «مدفوعة بلا تفعيل»:
// إن تعطّلت الآثار بعد قلب الفاتورة في محاولة أولى، تستأنفها إعادة المحاولة
// (وضع resume: انتقالات الحالة فقط، بلا تكرار إشعارات/رسائل الإيصال).
async function applySettlementEffects(args: {
  payment: any
  updated: any
  receiptNo: string
  method: string
  actor: { id?: string | null; name: string }
  viaWebhook?: boolean
  resume: boolean
}): Promise<SettleResult> {
  const { payment, updated, receiptNo, method, actor, viaWebhook, resume } = args
  const amountDollars = paymentAmountDollars(payment)
  const amountLabel = amountDollars.toFixed(2)

  if (payment.admissionId) {
    await finalizeAdmissionAfterSettlement(db, payment.admissionId, {
      source: 'PAYMENT',
      actor,
      payment,
      receiptNo,
      amountDollars,
      resume,
    })
  }

  // تفعيل التسجيل المباشر في البرنامج بعد سداد فاتورته
  if (payment.enrollmentId) {
    const enrollment = await db.enrollment.findUnique({
      where: { id: payment.enrollmentId },
      include: { program: { select: { titleAr: true } } },
    })
    if (enrollment && enrollment.status === 'PENDING_PAYMENT') {
      await initializeAcademicEnrollment(db, enrollment)
      await db.enrollment.update({ where: { id: enrollment.id }, data: { status: 'ACTIVE' } })
      await notify(
        enrollment.userId,
        'PAYMENT',
        'تم تفعيل تسجيلك في البرنامج',
        `مبروك! بعد سداد الفاتورة أصبح تسجيلك في «${enrollment.program.titleAr}» فعالاً — يمكنك الآن الوصول لجميع الوحدات والاختبارات والمشرف الذكي.`,
        'dashboard'
      )
      const student = await db.user.findUnique({ where: { id: enrollment.userId }, select: { email: true, name: true } })
      if (student) await emailFinalRegistration(student.email, student.name, enrollment.program.titleAr)
      await audit(actor, 'ACTIVATE_ENROLLMENT', 'Enrollment', enrollment.id, `${enrollment.program.titleAr} — ${receiptNo}`)
    }
  }

  // آثار سداد باقة دقائق الصوت: إضافة الرصيد تلقائياً لحساب المستخدم
  if (payment.purpose === 'AI_LIVE_CREDIT' && updated.userId) {
    const minutesFromDescription = Number((payment.description.match(/(\d+)\s*دقيقة/) || [])[1] || 0)
    const minutes = minutesFromDescription > 0 ? minutesFromDescription : Math.max(1, Math.floor(amountDollars * 6))
    const credit = await grantGeminiLiveCredit({
      userId: updated.userId,
      minutes,
      source: 'PURCHASE',
      paymentId: updated.id,
      note: `فاتورة ${updated.invoiceNo} — ${payment.description}`,
    })
    if (credit.newlyGranted) {
      await notify(
        updated.userId,
        'PAYMENT',
        'تم تفعيل باقة دقائق الصوت',
        `تمت إضافة ${minutes} دقيقة صوت إضافية إلى رصيدك بعد سداد فاتورة ${updated.invoiceNo}. يمكنك الآن تشغيل المحادثة الصوتية مع المشرف الذكي.`,
        'chat'
      ).catch(() => {})
    }
  }

  // آثار السداد على طلب وكالة/اعتماد: إشعار صاحب الطلب + بريد الإيصال.
  // (إصلاح: الإشعار كان يُمرَّر له مستخدم فارغ فلا يصل لأحد — الآن يُحل
  // صاحب الطلب من بريده فيُرسل له فعلاً.)
  if (payment.agentId) {
    const agent = await db.agentApplication.findUnique({ where: { id: payment.agentId }, include: { certificates: true } })
    if (agent) {
      const agentOwner = agent.email ? await db.user.findUnique({ where: { email: agent.email }, select: { id: true } }).catch(() => null) : null
      if (!resume) {
        await notify(
          agentOwner?.id || null,
          'PAYMENT',
          'تم استلام دفعة اعتماد بنجاح',
          `سُددت فاتورة «${payment.description}» بمبلغ ${amountLabel}$ — رقم الإيصال ${receiptNo} — لطلب ${agent.kind === 'AGENCY' ? 'وكالة' : 'اعتماد'}: ${agent.orgName}.`,
          'agent'
        ).catch(() => {})
        if (agent.email) {
          await emailPaymentReceipt(agent.email, agent.repName, payment.invoiceNo, payment.description, amountDollars, receiptNo)
        }
      }
      // إصدار شهادة الاعتماد عند سداد رسوم الفئة فقط — نطاق الحارس أعلاه.
      if (accreditationCertificateDue(payment, agent)) {
        // الرقم التسلسلي محسوب من عدّ الشهادات الحالية: تسويتان متزامنتان
        // قد تحسبان الرقم نفسه فيصطدم الإنشاء بقيد تفرد serial ويُجهض بقية
        // آثار التسوية رغم أن الفاتورة قُلبت PAID. أعد حساب الرقم والمحاولة
        // (حتى 3 مرات) عند الاصطدام فقط — الفائز المتزامن يرفع العدّ فينجح
        // الرقم التالي — وأعد رمي أي خطأ آخر كما هو.
        let serial = ''
        let lastSerialError: any = null
        for (let attempt = 0; attempt < 3 && !serial; attempt++) {
          const candidate = await nextCertSerial()
          try {
            await db.certificate.create({
              data: {
                serial: candidate,
                qrToken: randomBytes(16).toString('hex'),
                type: 'ACCREDITATION',
                holderName: agent.orgName,
                program: ACC_TYPE_LABEL_SETTLE[agent.accreditationType || ''] || 'اعتماد دولي',
                country: agent.country,
                agentId: agent.id,
              },
            })
            serial = candidate
          } catch (error: any) {
            if (error?.code !== 'P2002') throw error
            lastSerialError = error
          }
        }
        if (!serial) throw lastSerialError || new Error('CERT_SERIAL_COLLISION')
        if (agentOwner?.id) {
          await notify(
            agentOwner.id,
            'AGENT',
            'تم إصدار شهادة اعتمادك',
            `تم إصدار شهادة الاعتماد رقم ${serial} باسم ${agent.orgName} بعد سداد رسوم الفئة. راجع بوابتك أو صفحة التحقق.`,
            'agent'
          ).catch(() => {})
        }
        if (agent.email) {
          await emailCertificateIssued(agent.email, agent.repName, ACC_TYPE_LABEL_SETTLE[agent.accreditationType || ''] || 'اعتماد دولي', serial).catch(() => {})
        }
      }
    }
  }

  await audit(actor, resume ? 'PAYMENT_SETTLEMENT_RESUMED' : 'PAYMENT_RECEIVED', 'Payment', updated.id, `${receiptNo} — ${payment.description} (${amountLabel}$ عبر ${method})${viaWebhook ? ' [Webhook]' : ''}`)

  return { ok: true, payment: updated, receiptNo }
}

export async function markInvoicePaid(
  invoiceNo: string,
  method: string,
  opts?: { viaWebhook?: boolean; actor?: { id?: string | null; name: string } | null }
): Promise<SettleResult> {
  const payment = await db.payment.findUnique({ where: { invoiceNo } })
  if (!payment) return { ok: false, error: 'الفاتورة غير موجودة' }
  if (payment.status === 'PAID') {
    // قُلبت PAID في محاولة سابقة وربما تعطّلت آثارها بعد القلب — إعادة
    // المحاولة تستأنف الآثار المحروسة بدل إعلان نجاح كاذب بلا تفعيل.
    await applySettlementEffects({
      payment,
      updated: payment,
      receiptNo: payment.receiptNo || '',
      method: payment.method || method,
      actor: opts?.actor || { name: payment.payerName || 'دافع' },
      viaWebhook: opts?.viaWebhook,
      resume: true,
    })
    return { ok: true, payment, receiptNo: payment.receiptNo || '' }
  }
  if (payment.status === 'WAIVED') return { ok: false, error: 'لا يمكن تحويل فاتورة معفاة إلى مدفوعة. ألغِ الإعفاء أولاً إذا أردت إعادة فتح الفاتورة.' }

  const receiptNo = await nextReceiptNo()
  const paidAt = new Date()
  const settled = await db.payment.updateMany({
    where: { id: payment.id, status: 'UNPAID' },
    data: {
      status: 'PAID',
      method: String(method),
      receiptNo,
      paidAt,
      paidViaWebhook: !!opts?.viaWebhook,
      // لا نربط الفاتورة بمستخدم الإدارة الذي أكد الدفع. سيتم ربطها بصاحب الطلب أدناه عند توفر حساب مطابق.
      userId: payment.userId || null,
    },
  })
  if (settled.count === 0) {
    const alreadyPaid = await db.payment.findUnique({ where: { id: payment.id } })
    if (alreadyPaid?.status === 'PAID') return { ok: true, payment: alreadyPaid, receiptNo: alreadyPaid.receiptNo || '' }
    return { ok: false, error: 'تعذر تأكيد السداد لأن حالة الفاتورة تغيرت أثناء المعالجة' }
  }
  const updated = await db.payment.findUnique({ where: { id: payment.id } })
  if (!updated) return { ok: false, error: 'تعذر قراءة الفاتورة بعد تأكيد السداد' }
  return applySettlementEffects({
    payment,
    updated,
    receiptNo,
    method,
    actor: opts?.actor || { name: payment.payerName || 'دافع' },
    viaWebhook: opts?.viaWebhook,
    resume: false,
  })
}
