import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { audit, notify, AUDIT_ACTIONS } from '@/lib/notify'
import { getSettings, nextInvoiceNo, nextCertSerial } from '@/lib/settings'
import { randomBytes } from 'crypto'
import { emailAdmissionDecision, emailCertificateIssued } from '@/lib/mailer'

// آلة الحالات الرسمية وفق دليل الإجراءات (الترتيب الصحيح):
// AWAITING_FEE (بانتظار سداد رسوم التقديم 30$ عند التقديم) → UNDER_REVIEW (قيد دراسة الإدارة بعد السداد)
// → AWAITING_TUITION (مقبول — بانتظار سداد الرسوم الدراسية كاملة للدخول للبرنامج)
// → THESIS (التسجيل النهائي — قيد إعداد بحث التخرج) → SCHEDULED → RESULT_APPROVED → CERTIFIED | REJECTED
const STATUSES = [
  'AWAITING_FEE', 'UNDER_REVIEW', 'AWAITING_TUITION', 'SUPERVISOR_ASSIGNED',
  'THESIS', 'SCHEDULED', 'RESULT_APPROVED', 'CERTIFIED', 'REJECTED', 'PENDING',
]

export const STATUS_LABEL: Record<string, string> = {
  AWAITING_FEE: 'بانتظار سداد رسوم التقديم (30$)',
  UNDER_REVIEW: 'قيد دراسة الإدارة',
  AWAITING_TUITION: 'مقبول — بانتظار سداد الرسوم الدراسية',
  SUPERVISOR_ASSIGNED: 'تم تعيين مشرف',
  THESIS: 'التسجيل النهائي — قيد إعداد بحث التخرج',
  SCHEDULED: 'مجدول للمناقشة',
  RESULT_APPROVED: 'تم اعتماد النتيجة',
  CERTIFIED: 'تم إصدار الشهادة',
  REJECTED: 'غير مقبول',
  PENDING: 'تم التقديم',
}

// GET /api/admin/admissions — قائمة طلبات الالتحاق (للإدارة فقط)
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    const apps = await db.admissionApplication.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        supervisor: { select: { id: true, name: true } },
        payments: { select: { id: true, purpose: true, status: true, amount: true } },
        theses: { orderBy: { createdAt: 'desc' }, take: 1 },
        files: { select: { id: true, docType: true, fileName: true, size: true, mimeType: true } },
      },
    })
    // التقييم الذكي المخزّن (aiVerdict/aiScore/aiReviewedAt) يُضمَّن تلقائياً مع الحقول
    const supervisors = await db.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPERVISOR'] } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ applications: apps, supervisors, statusLabels: STATUS_LABEL })
  } catch (e: any) {
    console.error('admin admissions GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل طلبات الالتحاق' }, { status: 500 })
  }
}

// PATCH /api/admin/admissions — تحديث حالة طلب / تعيين مشرف / الإقرار بالقبول
export async function PATCH(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    const body = await req.json()
    const { id, status, supervisorId } = body

    const app = await db.admissionApplication.findUnique({ where: { id } })
    if (!app) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 })

    // تعيين مشرف أكاديمي (في أي مرحلة قبل الشهادة)
    if (supervisorId !== undefined) {
      const sup = await db.user.findUnique({ where: { id: supervisorId } })
      if (!sup) return NextResponse.json({ error: 'المشرف غير موجود' }, { status: 404 })
      const updated = await db.admissionApplication.update({
        where: { id },
        data: {
          supervisorId,
          supervisorAt: new Date(),
          // إذا كان الطلب قيد الدراسة فالتعيين لا يغيّر حالته — يبقى بانتظار الإقرار بالقبول
          status: app.status,
        },
      })
      await notify(
        app.userId || null,
        'ADMISSION',
        'تم تعيين مشرفك الأكاديمي',
        `تم تعيين ${sup.name} مشرفاً أكاديمياً لطلبك (${app.reference}) — بإشرافه تُدرس ملفك ويمكنك مراسلته عبر المشرف الذكي في أي وقت.`,
        'dashboard'
      )
      await audit(user, 'ASSIGN_SUPERVISOR', 'AdmissionApplication', id, `تعيين ${sup.name} مشرفاً لـ ${app.fullName} (${app.reference})`)
      return NextResponse.json({ ok: true, application: updated })
    }

    if (!id || !STATUSES.includes(status)) {
      return NextResponse.json({ error: 'بيانات غير صحيحة' }, { status: 400 })
    }

    const data: any = { status }

    // ===== الإقرار بالقبول (دراسة الملف وتعيين المشرف ثم إصدار فاتورة الرسوم الدراسية) =====
    if (status === 'AWAITING_TUITION' || status === 'SUPERVISOR_ASSIGNED') {
      // قاعدة إلزامية: لا إقرار بالقبول قبل سداد الطالب رسوم التقديم (30$)
      const feePaid = await db.payment.findFirst({
        where: { admissionId: id, purpose: 'APPLICATION_FEE', status: 'PAID' },
      })
      if (!feePaid) {
        return NextResponse.json(
          { error: 'لا يمكن الإقرار بالقبول قبل سداد المتقدم رسوم التقديم وحجز المقعد (30$) — الطلب لا يزال في مرحلة انتظار السداد' },
          { status: 400 }
        )
      }

      // التاريخ ومهلة بحث التخرج (6 أشهر كحد أقصى من القبول)
      if (!app.approvedAt) {
        const settings = await getSettings()
        const deadline = new Date()
        deadline.setMonth(deadline.getMonth() + parseInt(settings.THESIS_MAX_MONTHS || '6'))
        data.approvedAt = new Date()
        data.thesisDeadline = deadline
      }
      // الحالة النهائية بعد الإقرار: بانتظار سداد الرسوم الدراسية
      data.status = 'AWAITING_TUITION'

      // إصدار فاتورة الرسوم الدراسية الكاملة (فاتورة رسوم التقديم صدرت وسُددت عند التقديم)
      const tuitionExists = await db.payment.findFirst({
        where: { admissionId: id, purpose: 'TUITION' },
      })
      if (!tuitionExists) {
        const settings = await getSettings()
        const program = app.programId
          ? await db.program.findUnique({ where: { id: app.programId } })
          : await db.program.findFirst({ where: { titleAr: { contains: app.program.split(' — ')[0] } } })
        let tuition = 0
        if (program?.price) tuition = program.price
        else if (app.program.includes('دكتوراة') || app.program.includes('دكتوراه')) tuition = parseFloat(settings.FEE_DOCTORATE || '1300')
        else if (app.education === 'MASTER') tuition = parseFloat(settings.FEE_MASTERS || '700')
        else tuition = parseFloat(settings.FEE_DIPLOMAS_MAX || '350')
        await db.payment.create({
          data: {
            admissionId: id,
            userId: app.userId,
            invoiceNo: await nextInvoiceNo(),
            purpose: 'TUITION',
            description: `الرسوم الدراسية الكاملة للدخول للبرنامج — ${app.program}`,
            amount: tuition,
            payerName: app.fullName,
            payerEmail: app.email,
            payerCountry: app.country,
          },
        })
      }
      const updated = await db.admissionApplication.update({ where: { id }, data })

      await notify(
        app.userId || null,
        'ADMISSION',
        'مبروك — تم الإقرار بقبول طلبك!',
        `بعد دراسة ملفك تم الإقرار بقبول طلبك (${app.reference}) ببرنامج «${app.program}». لمتابعة التسجيل النهائي والدخول للبرنامج سدد الرسوم الدراسية الكاملة من تبويب «الدفعات» في بوابتك — وسيُفعَّل تسجيلك تلقائياً فور السداد.`,
        'dashboard'
      )
      await audit(user, AUDIT_ACTIONS['APPROVE_ADMISSION'] || 'APPROVE_ADMISSION', 'AdmissionApplication', id,
        `الإقرار بقبول ${app.fullName} (${app.reference}) — أُصدرت فاتورة الرسوم الدراسية`)
      // بريد قرار القبول مع دعوة لسداد الرسوم الدراسية
      emailAdmissionDecision(app.email, app.fullName, app.reference, app.program, true).catch(() => {})
      return NextResponse.json({ ok: true, application: updated })
    }

    const updated = await db.admissionApplication.update({ where: { id }, data })

    // إصدار الشهادة الرقمية (رقم تسلسلي + QR) عند الوصول لحالة CERTIFIED
    // بشرط رسمي: سداد جميع فواتير الطلب كاملة — مع نسخ درجة المناقشة للشهادة
    if (status === 'CERTIFIED') {
      const allPayments = await db.payment.findMany({ where: { admissionId: id } })
      const allPaid = allPayments.length === 0 || allPayments.every((p) => p.status === 'PAID')
      if (!allPaid) {
        return NextResponse.json(
          { error: 'لا يمكن إصدار الشهادة قبل سداد جميع فواتير الطلب — تبقى فاتورة غير مسددة' },
          { status: 400 }
        )
      }
      const existingCert = await db.certificate.findFirst({ where: { admissionId: id } })
      if (!existingCert) {
        const lastThesis = await db.thesisSubmission.findFirst({
          where: { admissionId: id, resultScore: { not: null } },
          orderBy: { updatedAt: 'desc' },
          select: { resultScore: true },
        })
        const cert = await db.certificate.create({
          data: {
            serial: await nextCertSerial(),
            qrToken: randomBytes(16).toString('hex'),
            type: 'PROGRAM_COMPLETION',
            holderName: app.fullName,
            program: app.program,
            grade: lastThesis?.resultScore ? `${lastThesis.resultScore}%` : null,
            country: app.country,
            userId: app.userId,
            admissionId: id,
          },
        })
        if (app.programId && app.userId) {
          await db.enrollment.updateMany({
            where: { userId: app.userId, programId: app.programId },
            data: { certificateNo: cert.serial, status: 'COMPLETED' },
          })
        }
        if (app.userId) {
          await notify(
            app.userId,
            'CERTIFICATE',
            'تم إصدار شهادتك المعتمدة',
            `أُصدرت شهادتك لبرنامج «${app.program}» برقم ${cert.serial} — متاحة في بوابة الطالب للطباعة والتحقق.`,
            'dashboard'
          )
          await emailCertificateIssued(app.email, app.fullName, app.program, cert.serial).catch(() => {})
        }
      }
    }

    if (status === 'REJECTED') {
      await notify(
        app.userId || null,
        'ADMISSION',
        'نتيجة طلب الالتحاق',
        `نأسف — لم يُقبَل طلب الالتحاق (${app.reference}) بعد دراسته. يمكنك التواصل مع الإدارة لمعرفة التفاصيل.`
      )
      // بريد قرار الرفض
      emailAdmissionDecision(app.email, app.fullName, app.reference, app.program, false).catch(() => {})
      await audit(user, AUDIT_ACTIONS['REJECT_ADMISSION'] || 'REJECT_ADMISSION', 'AdmissionApplication', id, `رفض ${app.fullName} (${app.reference})`)
      return NextResponse.json({ ok: true, application: updated })
    }

    await audit(user, AUDIT_ACTIONS[`UPDATE_ADMISSION_STATUS`] || 'تحديث حالة طلب', 'AdmissionApplication', id,
      `${app.reference}: ${STATUS_LABEL[app.status] || app.status} ← ${STATUS_LABEL[status] || status}`)

    return NextResponse.json({ ok: true, application: updated })
  } catch (e: any) {
    console.error('admin admissions PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تحديث الطلب' }, { status: 500 })
  }
}
