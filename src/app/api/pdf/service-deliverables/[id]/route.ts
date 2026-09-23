import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { deliverableStatusLabel, deliverableTypeLabel } from '@/lib/service-deliverables'
import { pdfDate, pdfResponse, pdfSafeText, renderOfficialPdf } from '@/lib/pdf/official'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser()
    const { id } = await Promise.resolve(context.params)
    if (!id) return NextResponse.json({ error: 'معرّف المخرج مطلوب' }, { status: 400 })

    const deliverable = await db.serviceDeliverable.findUnique({
      where: { id },
      include: {
        admission: {
          select: {
            id: true,
            reference: true,
            fullName: true,
            email: true,
            country: true,
            program: true,
            status: true,
            userId: true,
            payments: { select: { status: true } },
            programRef: { select: { titleAr: true, titleEn: true } },
          },
        },
      },
    })

    if (!deliverable) return NextResponse.json({ error: 'المخرج غير موجود' }, { status: 404 })

    const canView = user.role === 'ADMIN' || deliverable.admission.userId === user.id || deliverable.admission.email === user.email
    if (!canView) return NextResponse.json({ error: 'صلاحيات غير كافية لعرض المخرج' }, { status: 403 })

    const eligible =
      user.role === 'ADMIN' ||
      (deliverable.status === 'PUBLISHED' &&
        deliverable.visibleToStudent &&
        ['RESULT_APPROVED', 'CERTIFIED'].includes(deliverable.admission.status) &&
        deliverable.admission.payments.length > 0 &&
        deliverable.admission.payments.every((p) => p.status === 'PAID'))

    if (!eligible) return NextResponse.json({ error: 'هذا المخرج غير متاح حالياً' }, { status: 403 })

    const program = pdfSafeText(deliverable.admission.programRef?.titleAr || deliverable.admission.program, 'AACT Service')
    const accessValue = deliverable.externalUrl || deliverable.verificationUrl || deliverable.fileUrl || deliverable.fileName || 'متاح من بوابة الطالب'

    const pdf = await renderOfficialPdf({
      title: 'مخرج خدمة رسمي',
      subtitle: 'Official Service Deliverable',
      documentLabel: 'SERVICE DELIVERABLE',
      reference: deliverable.admission.reference,
      issuedAt: deliverable.createdAt,
      status: `${deliverableStatusLabel(deliverable.status)} / ${deliverable.status}`,
      statusTone: deliverable.status === 'PUBLISHED' ? 'success' : deliverable.status === 'DRAFT' ? 'info' : 'warning',
      sections: [
        {
          title: 'بيانات الطلب / Application Details',
          rows: [
            { label: 'مرجع الطلب', value: deliverable.admission.reference, dir: 'ltr' },
            { label: 'اسم المستفيد', value: deliverable.admission.fullName },
            { label: 'البريد', value: deliverable.admission.email, dir: 'ltr' },
            { label: 'الدولة', value: deliverable.admission.country || '—' },
            { label: 'البرنامج / الخدمة', value: program },
          ],
        },
        {
          title: 'بيانات المخرج / Deliverable Details',
          rows: [
            { label: 'العنوان', value: deliverable.title },
            { label: 'النوع', value: `${deliverableTypeLabel(deliverable.type)} / ${deliverable.type}` },
            { label: 'الوصف', value: deliverable.description || '—' },
            { label: 'اسم الملف', value: deliverable.fileName || '—' },
            { label: 'نوع الملف', value: deliverable.mimeType || '—', dir: 'ltr' },
            { label: 'تاريخ النشر', value: pdfDate(deliverable.createdAt), dir: 'ltr' },
            { label: 'تاريخ الانتهاء', value: pdfDate(deliverable.expiresAt), dir: 'ltr' },
          ],
        },
        {
          title: 'الوصول والتحقق / Access & Verification',
          rows: [
            { label: 'رابط/مرجع الوصول', value: accessValue, dir: /^https?:\/\//i.test(accessValue) ? 'ltr' : 'rtl' },
            { label: 'رابط التحقق', value: deliverable.verificationUrl || '—', dir: 'ltr' },
            { label: 'منشئ المخرج', value: deliverable.createdByName || 'AACT Administration' },
          ],
          lines: ['هذه الصفحة تلخص مخرج الخدمة الرسمي كما هو محفوظ في منصة AACT. الملفات الأصلية أو روابط التحميل تبقى متاحة حسب صلاحيات الطالب وحالة السداد.'],
        },
      ],
      footer: 'مخرج الخدمة صادر إلكترونياً من منصة AACT ويخضع لصلاحيات الوصول وحالة الطلب والسداد.',
    })

    return pdfResponse(pdf, `AACT-DELIVERABLE-${deliverable.id}.pdf`)
  } catch (e) {
    console.error('deliverable PDF error:', e)
    if (e instanceof Error && e.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'تسجيل الدخول مطلوب' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر توليد PDF مخرج الخدمة' }, { status: 500 })
  }
}
