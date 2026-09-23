import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import {
  AccessDeniedPdf,
  OfficialPdfDocument,
  PdfField,
  PdfSection,
  PdfTable,
  formatPdfDate,
  statusArabic,
} from '../../_components/OfficialDocument'

export const dynamic = 'force-dynamic'

type PageProps = {
  params: Promise<{ id: string }>
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function canView(user: any, ownerId?: string | null, visible = true, status = 'PUBLISHED'): boolean {
  if (!user) return false
  if (user.role === 'ADMIN') return true
  return Boolean(ownerId && ownerId === user.id && visible && status === 'PUBLISHED')
}

const TYPE_LABEL: Record<string, string> = {
  CERTIFICATE_PDF: 'ملف شهادة PDF',
  EQUIVALENCY_CERTIFICATE: 'شهادة معادلة خبرة',
  PACKAGE_DOWNLOAD: 'رابط تحميل حقيبة تدريبية',
  CONSULTATION_LINK: 'رابط جلسة استشارة',
  CONSULTATION_REPORT: 'تقرير استشارة',
  MEMBERSHIP_CARD: 'بطاقة عضوية',
  ACCREDITATION_CERTIFICATE: 'شهادة اعتماد',
  CUSTOM_PACKAGE_DRAFT: 'مسودة حقيبة تدريبية',
  CUSTOM_PACKAGE_FINAL: 'الحقيبة التدريبية النهائية',
  OTHER: 'مخرج خدمة آخر',
}

export default async function DeliverablePdfPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const query = searchParams ? await searchParams : {}
  const user = await getCurrentUser()
  const deliverable = await db.serviceDeliverable.findUnique({
    where: { id },
    include: {
      admission: {
        select: {
          id: true,
          reference: true,
          userId: true,
          fullName: true,
          email: true,
          phone: true,
          country: true,
          program: true,
          status: true,
          createdAt: true,
        },
      },
    },
  })

  if (!deliverable) notFound()
  if (!canView(user, deliverable.admission.userId, deliverable.visibleToStudent, deliverable.status)) return <AccessDeniedPdf />

  const autoPrint = firstParam(query.print) === '1'
  const accessUrl = deliverable.externalUrl || deliverable.fileUrl || deliverable.verificationUrl || null

  return (
    <OfficialPdfDocument
      title="إفادة تسليم خدمة"
      subtitle="وثيقة رسمية تلخص مخرج الخدمة المنشور للعميل عبر منصة الأكاديمية."
      reference={deliverable.admission.reference}
      status={statusArabic(deliverable.status)}
      issuedAt={deliverable.createdAt}
      autoPrint={autoPrint}
      footerNote="هذه الوثيقة تلخص مخرج الخدمة كما نشرته الإدارة في بوابة العميل. روابط التحميل أو الجلسات تخضع لمدة الصلاحية وسياسة الوصول الموضحة داخل الطلب."
    >
      <PdfSection title="بيانات العميل والطلب">
        <div className="grid gap-3 md:grid-cols-3">
          <PdfField label="اسم العميل" value={deliverable.admission.fullName} />
          <PdfField label="البريد" value={deliverable.admission.email} />
          <PdfField label="الهاتف" value={deliverable.admission.phone} />
          <PdfField label="الدولة" value={deliverable.admission.country} />
          <PdfField label="الخدمة" value={deliverable.admission.program} />
          <PdfField label="تاريخ الطلب" value={formatPdfDate(deliverable.admission.createdAt)} />
        </div>
      </PdfSection>

      <PdfSection title="بيانات مخرج الخدمة">
        <div className="grid gap-3 md:grid-cols-2">
          <PdfField label="نوع المخرج" value={TYPE_LABEL[deliverable.type] || deliverable.type} />
          <PdfField label="العنوان" value={deliverable.title} />
          <PdfField label="حالة النشر" value={statusArabic(deliverable.status)} />
          <PdfField label="ظاهر للعميل" value={deliverable.visibleToStudent ? 'نعم' : 'لا'} />
          <PdfField label="تاريخ النشر" value={formatPdfDate(deliverable.createdAt, true)} />
          <PdfField label="تاريخ الانتهاء" value={deliverable.expiresAt ? formatPdfDate(deliverable.expiresAt, true) : 'لا يوجد'} />
          <PdfField label="موعد الجلسة" value={deliverable.meetingAt ? formatPdfDate(deliverable.meetingAt, true) : 'لا يوجد'} />
          <PdfField label="منشور بواسطة" value={deliverable.createdByName || 'الإدارة'} />
        </div>
        {deliverable.description ? (
          <div className="mt-4 rounded-2xl border border-[#e8edf5] bg-[#fbfcff] p-4 text-sm font-bold leading-relaxed text-slate-700">
            {deliverable.description}
          </div>
        ) : null}
      </PdfSection>

      <PdfSection title="بيانات الملف أو الرابط">
        <PdfTable
          headers={['اسم الملف', 'النوع', 'الحجم', 'الرابط/التحقق']}
          rows={[[
            deliverable.fileName || '—',
            deliverable.mimeType || deliverable.type,
            deliverable.size ? `${Math.round(deliverable.size / 1024)} ك.ب` : '—',
            accessUrl ? <span dir="ltr" className="break-all text-xs">{accessUrl}</span> : 'لا يوجد رابط منشور',
          ]]}
        />
      </PdfSection>

      {(deliverable.certificateId || deliverable.verificationUrl) ? (
        <PdfSection title="بيانات التحقق المرتبطة">
          <div className="grid gap-3 md:grid-cols-2">
            <PdfField label="رقم/معرف الشهادة" value={deliverable.certificateId || '—'} />
            <PdfField label="رابط التحقق" value={deliverable.verificationUrl ? <span dir="ltr" className="text-xs">{deliverable.verificationUrl}</span> : '—'} />
          </div>
        </PdfSection>
      ) : null}
    </OfficialPdfDocument>
  )
}
