import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { audit, notify, AUDIT_ACTIONS } from '@/lib/notify'
import { getSettings, nextInvoiceNo, nextCertSerial } from '@/lib/settings'
import { randomBytes } from 'crypto'
import { emailAdmissionDecision, emailCertificateIssued } from '@/lib/mailer'
import { getServiceFlow } from '@/lib/service-flows'
import { deriveServiceWorkflowState } from '@/lib/service-workflows'
import { inferTotalTuition, tuitionPaidTotal, roundMoney } from '@/lib/tuition-installments'
import { adminPaginationMeta, cleanAdminQuery, parseAdminPagination } from '@/lib/admin-query'
import { evaluateProgramCertificateEligibility } from '@/lib/certificate-eligibility'
import {
  appendAdmissionDocumentReplacement,
  extractAdmissionDocumentReplacement,
  stripAdmissionDocumentReplacement,
} from '@/lib/admission-document-replacement'

// آلة الحالات الرسمية وفق دليل الإجراءات (الترتيب الصحيح):
// AWAITING_FEE (بانتظار سداد رسوم التقديم 30$ عند التقديم) → UNDER_REVIEW (قيد دراسة الإدارة بعد السداد)
// → AWAITING_TUITION (مقبول — بانتظار سداد الرسوم الدراسية كاملة للدخول للبرنامج)
// → THESIS (التسجيل النهائي — قيد إعداد بحث التخرج) → SCHEDULED → RESULT_APPROVED → CERTIFIED | REJECTED
const STATUSES = [
  'AWAITING_FEE', 'UNDER_REVIEW', 'DOCUMENTS_NEED_REPLACEMENT', 'AWAITING_TUITION', 'SUPERVISOR_ASSIGNED',
  'THESIS', 'SCHEDULED', 'RESULT_APPROVED', 'CERTIFIED', 'REJECTED', 'PENDING',
]

export const STATUS_LABEL: Record<string, string> = {
  AWAITING_FEE: 'بانتظار سداد رسوم التقديم (30$)',
  UNDER_REVIEW: 'قيد دراسة الإدارة',
  DOCUMENTS_NEED_REPLACEMENT: 'مطلوب استبدال مستندات',
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
export async function GET(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'ADMIN') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    const sp = req.nextUrl.searchParams
    const { page, pageSize, skip, take } = parseAdminPagination(sp, { pageSize: 10, maxPageSize: 100 })
    const search = cleanAdminQuery(sp.get('search'))
    const status = cleanAdminQuery(sp.get('status'))
    const kind = cleanAdminQuery(sp.get('kind'))
    const filters: any[] = []
    if (status && status !== 'ALL') {
      if (status === 'ACTIVE') filters.push({ status: { notIn: ['REJECTED', 'CERTIFIED'] } })
      else filters.push({ status })
    }
    if (kind === 'SERVICE') filters.push({ programRef: { is: { category: 'SERVICE' } } })
    if (kind === 'STUDY') filters.push({ OR: [{ programId: null }, { programRef: { is: { category: { not: 'SERVICE' } } } }] })
    if (search) {
      filters.push({
        OR: [
          { reference: { contains: search, mode: 'insensitive' } },
          { fullName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
          { country: { contains: search, mode: 'insensitive' } },
          { program: { contains: search, mode: 'insensitive' } },
        ],
      })
    }
    const where: any = filters.length ? { AND: filters } : {}

    const apps = await db.admissionApplication.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
        supervisor: { select: { id: true, name: true } },
        payments: { select: { id: true, invoiceNo: true, purpose: true, status: true, amount: true, method: true, receiptNo: true, cryptoNetwork: true, cryptoWalletAddress: true, cryptoTxHash: true, cryptoVerificationStatus: true, cryptoVerificationNote: true, cryptoVerifiedAt: true } },
        theses: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, title: true } },
        files: { select: { id: true, docType: true, fileName: true, size: true, mimeType: true } },
        deliverables: { orderBy: { createdAt: 'desc' }, select: { id: true, type: true, status: true, title: true, description: true, fileName: true, mimeType: true, size: true, externalUrl: true, certificateId: true, verificationUrl: true, meetingAt: true, expiresAt: true, visibleToStudent: true, createdAt: true } },
      },
    })
    const total = await db.admissionApplication.count({ where })
    const appIds = apps.map((a) => a.id)
    let appeals: any[] = []
    if (appIds.length) {
      try {
        appeals = await db.tuitionInstallmentAppeal.findMany({ where: { admissionId: { in: appIds } }, orderBy: { createdAt: 'desc' } })
      } catch (e) {
        console.warn('tuition installment appeal table is not ready yet; continuing admissions load without appeals:', e)
        appeals = []
      }
    }
    const appealMap = new Map<string, any>()
    for (const appeal of appeals) {
      if (!appealMap.has(appeal.admissionId)) appealMap.set(appeal.admissionId, appeal)
    }

    const programIds = [...new Set(apps.map((a) => a.programId).filter((id): id is string => Boolean(id)))]
    const programs = programIds.length
      ? await db.program.findMany({ where: { id: { in: programIds } }, select: { id: true, slug: true, category: true, titleAr: true } })
      : []
    const programMap = new Map(programs.map((p) => [p.id, p]))
    const enrichedApps = apps.map((app) => {
      const program = app.programId ? programMap.get(app.programId) : null
      const flow = getServiceFlow(program?.slug)
      const isStudyProgram = flow ? flow.isStudyProgram : program?.category !== 'SERVICE'
      const requestKind = flow?.kind || (isStudyProgram ? 'DEGREE_STUDY' : 'SERVICE_REQUEST')
      const tuitionAppeal = appealMap.get(app.id) || null
      const totalTuition = inferTotalTuition(app.payments)
      const paidTuition = tuitionPaidTotal(app.payments)
      const firstSemesterRequiredAmount = roundMoney(Math.max(totalTuition / 2, Number(tuitionAppeal?.firstSemesterRequiredAmount ?? 0)))
      const finalRequiredAmount = roundMoney(Math.max(totalTuition, Number(tuitionAppeal?.finalRequiredAmount ?? 0)))
      const documentReplacementRequest = extractAdmissionDocumentReplacement(app.notes)
      const cleanNotes = stripAdmissionDocumentReplacement(app.notes)
      return {
        ...app,
        notes: cleanNotes,
        documentReplacementRequest,
        programSlug: program?.slug || null,
        requestKind,
        requestLabel: flow?.title || (isStudyProgram ? 'طلب التحاق دراسي' : 'طلب خدمة مهنية'),
        requestActionLabel: flow?.primaryAction || (isStudyProgram ? 'الإقرار بالقبول' : 'متابعة طلب الخدمة'),
        isStudyProgram,
        tuitionAppeal,
        tuitionPlan: isStudyProgram ? {
          totalTuition,
          paidTuition,
          remainingTuition: roundMoney(Math.max(0, totalTuition - paidTuition)),
          firstSemesterRequiredAmount,
          finalRequiredAmount,
          firstSemesterAllowed: totalTuition <= 0 || paidTuition >= firstSemesterRequiredAmount,
          secondSemesterAllowed: totalTuition <= 0 || paidTuition >= finalRequiredAmount,
        } : null,
        serviceWorkflow: isStudyProgram ? null : deriveServiceWorkflowState({
          kind: requestKind,
          status: app.status,
          payments: app.payments,
          deliverables: app.deliverables,
        }),
      }
    })
    // التقييم الذكي المخزّن (aiVerdict/aiScore/aiReviewedAt) يُضمَّن تلقائياً مع الحقول
    const supervisors = await db.user.findMany({
      where: { role: { in: ['ADMIN', 'SUPERVISOR'] } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({ applications: enrichedApps, supervisors, statusLabels: STATUS_LABEL, total, pagination: adminPaginationMeta(page, pageSize, total) })
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
    const owner = app.userId ? await db.user.findUnique({ where: { id: app.userId }, select: { id: true, role: true, name: true, email: true } }) : null
    const ownerIsStudent = !owner || owner.role === 'STUDENT'
    const programForFlow = app.programId
      ? await db.program.findUnique({ where: { id: app.programId }, select: { id: true, slug: true, category: true, price: true } })
      : await db.program.findFirst({ where: { titleAr: { contains: app.program.split(' — ')[0] } }, select: { id: true, slug: true, category: true, price: true } })
    const serviceFlow = getServiceFlow(programForFlow?.slug)
    const isStudyRequest = serviceFlow ? serviceFlow.isStudyProgram : programForFlow?.category !== 'SERVICE'

    if (!isStudyRequest && supervisorId !== undefined) {
      return NextResponse.json({ error: 'طلبات الخدمات العابرة لا تحتاج مشرفاً أكاديمياً. استخدم قسم تنفيذ وتسليم الخدمة بدلاً من مسار الطلاب.' }, { status: 400 })
    }
    if (!isStudyRequest && ['AWAITING_TUITION', 'SUPERVISOR_ASSIGNED', 'THESIS', 'SCHEDULED', 'CERTIFIED'].includes(String(status || ''))) {
      return NextResponse.json({ error: 'هذه خدمة عابرة وليست التحاقاً دراسياً؛ لا يمكن نقلها إلى مسارات الطالب أو إصدار شهادة دراسية. سلّم الناتج من قسم مخرجات الخدمة.' }, { status: 400 })
    }

    if (isStudyRequest && !ownerIsStudent && (supervisorId !== undefined || ['AWAITING_TUITION', 'SUPERVISOR_ASSIGNED', 'THESIS', 'SCHEDULED', 'RESULT_APPROVED', 'CERTIFIED'].includes(String(status || '')))) {
      return NextResponse.json(
        { error: 'هذا الطلب مرتبط بحساب إداري/غير طالب. لا يمكن اعتماده كقيد دراسة. أنشئ حساب طالب منفصل بنفس بيانات الدارس ثم قدّم الطلب من حساب الطالب أو ارفض هذا الطلب كتجريبي.' },
        { status: 400 }
      )
    }

    // تعيين نوع الإشراف الأكاديمي: مشرف ذكي فقط أو مشرف بشري + ذكي
    if (supervisorId !== undefined) {
      if (!supervisorId || supervisorId === 'AI_ONLY') {
        const updated = await db.admissionApplication.update({
          where: { id },
          data: { supervisorId: null, supervisorAt: null, supervisionMode: 'AI', status: app.status },
        })
        await notify(app.userId || null, 'ADMISSION', 'تم ضبط إشرافك الأكاديمي', `تم ضبط طلبك (${app.reference}) على إشراف المشرف الذكي الأكاديمي.`, 'dashboard')
        await audit(user, 'ASSIGN_SUPERVISOR', 'AdmissionApplication', id, `ضبط ${app.fullName} (${app.reference}) على مشرف ذكي فقط`)
        return NextResponse.json({ ok: true, application: updated })
      }
      const sup = await db.user.findUnique({ where: { id: supervisorId } })
      if (!sup) return NextResponse.json({ error: 'المشرف غير موجود' }, { status: 404 })
      const updated = await db.admissionApplication.update({
        where: { id },
        data: {
          supervisorId,
          supervisorAt: new Date(),
          supervisionMode: sup.role === 'SUPERVISOR' ? 'HYBRID' : 'HUMAN',
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

    // ===== اعتماد طلب خدمة مهنية عابرة: إنشاء فاتورة خدمة بدون فتح مسار دراسة/بحث تخرج =====
    if (!isStudyRequest && status === 'RESULT_APPROVED') {
      data.status = 'RESULT_APPROVED'
      if (!app.approvedAt) data.approvedAt = new Date()
      const existingServiceInvoice = await db.payment.findFirst({
        where: { admissionId: id, purpose: 'SERVICE_FEE' },
      })
      if (!existingServiceInvoice) {
        const settings = await getSettings()
        const amount = Number(programForFlow?.price || parseFloat(settings.FEE_SERVICE_DEFAULT || '50') || 50)
        await db.payment.create({
          data: {
            admissionId: id,
            userId: app.userId,
            invoiceNo: await nextInvoiceNo(),
            purpose: 'SERVICE_FEE',
            description: `رسوم تنفيذ الخدمة — ${app.program}`,
            amount,
            payerName: app.fullName,
            payerEmail: app.email,
            payerCountry: app.country,
          },
        })
      }
      const updated = await db.admissionApplication.update({ where: { id }, data })
      await notify(
        app.userId || null,
        'PAYMENT',
        'تم قبول طلب الخدمة — بانتظار السداد',
        `تم قبول طلبك (${app.reference}) لخدمة «${app.program}». يرجى سداد فاتورة الخدمة من تبويب «الدفعات» حتى تتمكن الإدارة من تسليم الشهادة أو الحقيبة أو المخرج النهائي.`,
        'dashboard'
      )
      await audit(user, AUDIT_ACTIONS['APPROVE_ADMISSION'] || 'APPROVE_SERVICE_REQUEST', 'AdmissionApplication', id,
        `اعتماد طلب خدمة ${app.fullName} (${app.reference}) — أُصدرت فاتورة الخدمة`)
      emailAdmissionDecision(app.email, app.fullName, app.reference, app.program, true, 'تم قبول طلب الخدمة. يرجى سداد فاتورة الخدمة من حسابك ليتم تسليم المخرج النهائي.').catch(() => {})
      return NextResponse.json({ ok: true, application: updated })
    }

    let updated: any

    // إصدار الشهادة الرقمية (رقم تسلسلي + QR) عند الوصول لحالة CERTIFIED.
    // لا نحدّث حالة الطلب إلى CERTIFIED قبل إثبات الاستحقاق الأكاديمي والمالي حتى لا تظهر شهادة لطالب غير مستحق.
    if (status === 'CERTIFIED') {
      const allPayments = await db.payment.findMany({ where: { admissionId: id } })
      const nonTuitionUnpaid = allPayments.filter((p) => !['TUITION', 'TUITION_INSTALLMENT'].includes(p.purpose) && p.status !== 'PAID')
      const tuitionTotal = inferTotalTuition(allPayments.map((p) => ({ purpose: p.purpose, status: p.status, amount: p.amount })))
      const tuitionPaid = tuitionPaidTotal(allPayments.map((p) => ({ purpose: p.purpose, status: p.status, amount: p.amount })))
      const tuitionOk = tuitionTotal <= 0 || roundMoney(tuitionPaid) >= roundMoney(tuitionTotal)
      if (nonTuitionUnpaid.length > 0 || !tuitionOk) {
        return NextResponse.json(
          { error: !tuitionOk ? `لا يمكن إصدار الشهادة قبل استكمال الرسوم الدراسية. المسدد ${roundMoney(tuitionPaid)}$ من ${roundMoney(tuitionTotal)}$.` : 'لا يمكن إصدار الشهادة قبل سداد جميع فواتير الطلب غير الدراسية.' },
          { status: 400 }
        )
      }

      const eligibility = await evaluateProgramCertificateEligibility({ userId: app.userId, programId: app.programId, admissionId: id })
      if (!eligibility.ok) {
        return NextResponse.json(
          { error: eligibility.error || 'لا يمكن إصدار الشهادة قبل اكتمال شروط النجاح الأكاديمي.', eligibility },
          { status: 400 }
        )
      }

      const existingCert = await db.certificate.findFirst({ where: { admissionId: id } })
      const cert = existingCert || await db.certificate.create({
        data: {
          serial: await nextCertSerial(),
          qrToken: randomBytes(16).toString('hex'),
          type: 'PROGRAM_COMPLETION',
          holderName: app.fullName,
          program: app.program,
          grade: eligibility.gradeLabel,
          country: app.country,
          userId: app.userId,
          admissionId: id,
        },
      })
      if (!existingCert && app.programId && app.userId) {
        await db.enrollment.updateMany({
          where: { userId: app.userId, programId: app.programId },
          data: { certificateNo: cert.serial, status: 'COMPLETED', ...(eligibility.score !== null ? { finalScore: eligibility.score } : {}) },
        })
      }
      if (!existingCert && app.userId) {
        await notify(
          app.userId,
          'CERTIFICATE',
          'تم إصدار شهادتك المعتمدة',
          `أُصدرت شهادتك لبرنامج «${app.program}» برقم ${cert.serial} — متاحة في بوابة الطالب للطباعة والتحقق.`,
          'dashboard'
        )
        await emailCertificateIssued(app.email, app.fullName, app.program, cert.serial).catch(() => {})
      }

      updated = await db.admissionApplication.update({ where: { id }, data })
    } else {
      updated = await db.admissionApplication.update({ where: { id }, data })
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
