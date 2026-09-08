import { db } from '@/lib/db'
import { nextReceiptNo } from '@/lib/settings'
import { notify, audit } from '@/lib/notify'
import { emailPaymentReceipt, emailFinalRegistration } from '@/lib/mailer'

// ===== تسوية فاتورة: تُستخدم من تأكيد الدفع داخل المنصة ومن Webhook المزودين =====
// تُطبق آثار السداد الكاملة: الإيصال + تحويل حالة طلب الالتحاق + تفعيل التسجيل + الإشعارات والبريد

export interface SettleResult {
  ok: boolean
  error?: string
  payment?: any
  receiptNo?: string
}

export async function markInvoicePaid(
  invoiceNo: string,
  method: string,
  opts?: { viaWebhook?: boolean; actor?: { id?: string | null; name: string } | null }
): Promise<SettleResult> {
  const payment = await db.payment.findUnique({ where: { invoiceNo } })
  if (!payment) return { ok: false, error: 'الفاتورة غير موجودة' }
  if (payment.status === 'PAID') return { ok: true, payment, receiptNo: payment.receiptNo || '' }

  const receiptNo = await nextReceiptNo()
  const updated = await db.payment.update({
    where: { id: payment.id },
    data: {
      status: 'PAID',
      method: String(method),
      receiptNo,
      paidAt: new Date(),
      paidViaWebhook: !!opts?.viaWebhook,
      userId: payment.userId || opts?.actor?.id || null,
    },
  })
  const actor = opts?.actor || { name: payment.payerName || 'دافع' }

  // آثار السداد على طلب الالتحاق (وفق ترتيب دليل الإجراءات الرسمي)
  if (payment.admissionId) {
    const app = await db.admissionApplication.findUnique({ where: { id: payment.admissionId } })
    if (app) {
      const all = await db.payment.findMany({ where: { admissionId: app.id } })
      const allPaid = all.every((p) => p.status === 'PAID')
      const feePaid = all.some((p) => p.purpose === 'APPLICATION_FEE' && p.status === 'PAID')
      let newStatus = app.status
      let finalRegistration = false

      // 1) بعد سداد رسوم التقديم (30$): الملف يُحوَّل تلقائياً للإدارة للدراسة والإقرار
      if (feePaid && app.status === 'AWAITING_FEE') {
        newStatus = 'UNDER_REVIEW'
        const admins = await db.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } })
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

      // 2) بعد موافقة الإدارة وسداد الرسوم الدراسية كاملة: التسجيل النهائي وتفعيل الالتحاق
      if (allPaid && app.status === 'AWAITING_TUITION') {
        newStatus = app.supervisorId ? 'THESIS' : 'SUPERVISOR_ASSIGNED'
        finalRegistration = true
        if (app.programId && app.userId) {
          const existingEnrollment = await db.enrollment.findUnique({
            where: { userId_programId: { userId: app.userId, programId: app.programId } },
          })
          if (!existingEnrollment) {
            await db.enrollment.create({
              data: { userId: app.userId, programId: app.programId, status: 'ACTIVE' },
            })
          }
        }
      }

      if (newStatus !== app.status) {
        await db.admissionApplication.update({ where: { id: app.id }, data: { status: newStatus } })
      }
      await notify(
        app.userId,
        'PAYMENT',
        'تم استلام دفعتك بنجاح',
        `سُددت فاتورة «${payment.description}» بمبلغ ${payment.amount}$ — رقم الإيصال ${receiptNo}.`,
        'dashboard'
      )
      if (app.email) {
        await emailPaymentReceipt(app.email, app.fullName, payment.invoiceNo, payment.description, payment.amount, receiptNo)
      }
      if (finalRegistration && app.userId) {
        await notify(
          app.userId,
          'ADMISSION',
          'التسجيل النهائي مكتمل — أهلاً بك في برنامجك!',
          `مبروك! بعد سداد الرسوم الدراسية كاملة أصبح تسجيلك النهائي في «${app.program}» فعالاً — يمكنك الآن الدخول لبوابة الطالب وقراءة الكتب المقررة والبدء مع مشرفك الذكي${app.supervisorId ? ' ومشرفك الأكاديمي' : ''}.`,
          'dashboard'
        )
        const student = await db.user.findUnique({ where: { id: app.userId }, select: { email: true, name: true } })
        if (student) await emailFinalRegistration(student.email, student.name, app.program)
        await audit(
          { id: app.userId, name: app.fullName },
          'FINAL_REGISTRATION',
          'Enrollment',
          app.id,
          `تسجيل نهائي فعّال: ${app.fullName} — ${app.program} (${app.reference}) — ${receiptNo}`
        )
      }
    }
  }

  // تفعيل التسجيل المباشر في البرنامج بعد سداد فاتورته
  if (payment.enrollmentId) {
    const enrollment = await db.enrollment.findUnique({
      where: { id: payment.enrollmentId },
      include: { program: { select: { titleAr: true } } },
    })
    if (enrollment && enrollment.status === 'PENDING_PAYMENT') {
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

  // آثار السداد على طلب اعتماد شركة/مؤسسة: إشعار صاحب الطلب + بريد الإيصال
  if (payment.agentId) {
    const agent = await db.agentApplication.findUnique({ where: { id: payment.agentId } })
    if (agent) {
      await notify(
        null,
        'PAYMENT',
        'تم استلام دفعة اعتماد بنجاح',
        `سُددت فاتورة «${payment.description}» بمبلغ ${payment.amount}$ — رقم الإيصال ${receiptNo} — لطلب اعتماد: ${agent.orgName}.`,
        'agent'
      ).catch(() => {})
      if (agent.email) {
        await emailPaymentReceipt(agent.email, agent.repName, payment.invoiceNo, payment.description, payment.amount, receiptNo)
      }
    }
  }

  await audit(actor, 'PAYMENT_RECEIVED', 'Payment', updated.id, `${receiptNo} — ${payment.description} (${payment.amount}$ عبر ${method})${opts?.viaWebhook ? ' [Webhook]' : ''}`)

  return { ok: true, payment: updated, receiptNo }
}
