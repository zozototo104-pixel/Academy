import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { ADMISSION_FEES } from '@/lib/academyData'
import { getSettingNum, nextInvoiceNo } from '@/lib/settings'
import { notify, audit } from '@/lib/notify'
import { emailAdmissionSubmitted, emailServiceRequestSubmitted } from '@/lib/mailer'
import { getServiceDocumentOptions, getServiceFlow } from '@/lib/service-flows'
import { resolveRules } from '@/lib/admission-ai'
const REQUIRED_DOCS: { type: string; label: string }[] = [
  { type: 'DEGREE', label: 'صورة عن الشهادة الجامعية وكشف العلامات (أو الثانوية للدبلومات)' },
  { type: 'ID', label: 'صورة عن الهوية الشخصية أو جواز السفر' },
  { type: 'PHOTO', label: 'صورة شخصية حديثة' },
  { type: 'CV', label: 'صورة عن السيرة الذاتية (C.V)' },
]

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const applicationId = String(body.applicationId || '').trim()
    const reference = String(body.reference || '').trim()
    if (!applicationId && !reference) {
      return NextResponse.json({ error: 'معرّف الطلب أو كود التتبع مطلوب لإكمال التقديم' }, { status: 400 })
    }

    const app = await db.admissionApplication.findFirst({
      where: applicationId ? { id: applicationId } : { reference },
      include: {
        programRef: { select: { id: true, titleAr: true, category: true, slug: true, admissionRules: true } },
        files: { select: { id: true, docType: true, fileName: true, size: true } },
        payments: { select: { id: true, invoiceNo: true, purpose: true, amount: true, status: true, description: true } },
        user: { select: { id: true, name: true, email: true, role: true } },
      },
    })
    if (!app) return NextResponse.json({ error: 'لم يتم العثور على طلب الالتحاق' }, { status: 404 })

    const me = await getCurrentUser().catch(() => null)
    if (me && me.role === 'STUDENT' && app.userId && app.userId !== me.id) {
      return NextResponse.json({ error: 'لا تملك صلاحية إكمال هذا الطلب' }, { status: 403 })
    }

    const serviceFlow = getServiceFlow(app.programRef?.slug)
    const isServiceRequest = serviceFlow ? !serviceFlow.isStudyProgram : app.programRef?.category === 'SERVICE'
    const uploadedTypes = new Set((app.files || []).map((f) => f.docType))
    const rules = resolveRules(app.programRef?.category || 'DIPLOMA', app.programRef?.admissionRules, !isServiceRequest)
    const serviceDocMap = new Map(getServiceDocumentOptions(serviceFlow).map((d) => [d.type, d.label]))
    const requiredDocList = isServiceRequest
      ? (rules.requiredDocuments || []).map((type) => ({ type, label: serviceDocMap.get(type) || type }))
      : REQUIRED_DOCS
    const missing = requiredDocList.filter((d) => !uploadedTypes.has(d.type))
    if (missing.length > 0) {
      return NextResponse.json({
        error: isServiceRequest ? 'لا يمكن إكمال طلب الخدمة: مرفقات الخدمة المطلوبة غير مكتملة' : 'لا يمكن إكمال الطلب: المستندات المطلوبة غير مكتملة. ارفع المستندات الناقصة أولاً',
        missing: missing.map((m) => m.label),
      }, { status: 400 })
    }

    const owner = app.user || (app.email ? await db.user.findUnique({ where: { email: app.email.trim().toLowerCase() } }) : null)
    const selectedTitle = app.programRef?.titleAr || app.program
    const nextStatus = isServiceRequest ? 'UNDER_REVIEW' : 'AWAITING_FEE'
    const appFee = isServiceRequest ? 0 : await getSettingNum('FEE_APPLICATION')

    const existingFee = app.payments.find((p) => p.purpose === 'APPLICATION_FEE') || null
    const feeInvoice = isServiceRequest ? null : (existingFee || await db.payment.create({
      data: {
        admissionId: app.id,
        userId: owner?.id || null,
        invoiceNo: await nextInvoiceNo(),
        purpose: 'APPLICATION_FEE',
        description: `رسوم التقديم وحجز المقعد (غير مستردة) — ${selectedTitle}`,
        amount: appFee,
        payerName: app.fullName,
        payerEmail: app.email,
        payerCountry: app.country,
      },
    }))

    await db.admissionApplication.update({
      where: { id: app.id },
      data: {
        status: nextStatus,
        documents: JSON.stringify((app.files || []).map((f) => f.docType)),
        userId: owner?.id || app.userId || null,
      },
    })

    if (owner?.id) {
      await notify(
        owner.id,
        'ADMISSION',
        isServiceRequest ? 'تم استلام طلب الخدمة — قيد دراسة الإدارة' : 'تم استلام طلب الالتحاق — سدد رسوم التقديم (30$)',
        isServiceRequest
          ? `طلبك (${app.reference}) لخدمة «${selectedTitle}» وصل للإدارة مع ${(app.files || []).length} ملف/مرفق. ستصلك تعليمات المتابعة أو التسعير أو الموعد بعد المراجعة.`
          : `طلبك (${app.reference}) ببرنامج «${selectedTitle}» مكتمل بالبيانات والمستندات (${(app.files || []).length}/4) والإقرار. سدد رسوم التقديم وحجز المقعد ${appFee}$ (غير مستردة) ليُحوَّل ملفك للإدارة للدراسة.`,
        'apply'
      )
    }

    if (isServiceRequest) {
      emailServiceRequestSubmitted(app.email, app.fullName, app.reference, selectedTitle).catch(() => {})
    } else {
      emailAdmissionSubmitted(app.email, app.fullName, app.reference, selectedTitle, appFee).catch(() => {})
    }
    await audit(
      owner ? { id: owner.id, name: owner.name } : { name: app.fullName },
      isServiceRequest ? 'SUBMIT_SERVICE_REQUEST' : 'SUBMIT_ADMISSION',
      'AdmissionApplication',
      app.id,
      isServiceRequest
        ? `${app.reference} — طلب خدمة: ${selectedTitle} — مرفقات: ${(app.files || []).length} + إقرار`
        : `${app.reference} — ${selectedTitle} — مستندات: ${(app.files || []).length}/4 + إقرار — فاتورة رسوم تقديم ${appFee}$`
    )

    return NextResponse.json({
      message: isServiceRequest
        ? `تم استلام طلب الخدمة! كود التتبع: ${app.reference} — ستقوم الإدارة بمراجعة الطلب وتحديد الخطوة التالية`
        : `تم استلام طلبك مع البيانات الكاملة والمستندات (${(app.files || []).length}/4) والإقرار! كود تتبع طلبك: ${app.reference} — سدد رسوم التقديم (${appFee}$) ليُحوَّل ملفك للإدارة`,
      reference: app.reference,
      applicationFee: isServiceRequest ? 0 : ADMISSION_FEES.applicationFee,
      documentsCount: (app.files || []).length,
      invoice: feeInvoice ? {
        invoiceNo: feeInvoice.invoiceNo,
        amount: feeInvoice.amount,
        purpose: feeInvoice.purpose,
        description: feeInvoice.description,
      } : null,
    })
  } catch (e: any) {
    console.error('admissions finalize error:', e)
    return NextResponse.json({ error: 'تعذر إكمال تقديم الطلب، حاول مرة أخرى' }, { status: 500 })
  }
}
