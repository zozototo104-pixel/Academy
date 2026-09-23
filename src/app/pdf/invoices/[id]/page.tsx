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
  formatPdfMoney,
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

function canView(user: any, ownerId?: string | null): boolean {
  if (!user) return false
  if (user.role === 'ADMIN') return true
  return Boolean(ownerId && ownerId === user.id)
}

export default async function InvoicePdfPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const query = searchParams ? await searchParams : {}
  const user = await getCurrentUser()
  const payment = await db.payment.findFirst({
    where: { OR: [{ id }, { invoiceNo: id }] },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, country: true } },
      admission: { select: { id: true, reference: true, fullName: true, email: true, phone: true, country: true, program: true, userId: true, status: true } },
      enrollment: { include: { user: { select: { id: true, name: true, email: true, phone: true, country: true } }, program: { select: { titleAr: true, category: true, price: true } } } },
      agent: { select: { id: true, userId: true, orgName: true, repName: true, email: true, phone: true, country: true, kind: true, accreditationType: true } },
    },
  })

  if (!payment) notFound()

  const ownerId = payment.userId || payment.user?.id || payment.admission?.userId || payment.enrollment?.userId || payment.agent?.userId || null
  if (!canView(user, ownerId)) return <AccessDeniedPdf />

  const payerName = payment.payerName || payment.user?.name || payment.admission?.fullName || payment.enrollment?.user?.name || payment.agent?.repName || '—'
  const payerEmail = payment.payerEmail || payment.user?.email || payment.admission?.email || payment.enrollment?.user?.email || payment.agent?.email || '—'
  const payerPhone = payment.user?.phone || payment.admission?.phone || payment.enrollment?.user?.phone || payment.agent?.phone || '—'
  const payerCountry = payment.payerCountry || payment.user?.country || payment.admission?.country || payment.enrollment?.user?.country || payment.agent?.country || '—'
  const programName = payment.admission?.program || payment.enrollment?.program?.titleAr || payment.agent?.orgName || '—'
  const autoPrint = firstParam(query.print) === '1'

  const cryptoRows = payment.provider === 'USDT' || payment.method === 'USDT'
    ? [[
        payment.cryptoNetwork || '—',
        payment.cryptoTxHash || 'لم يرسل بعد',
        payment.cryptoVerificationStatus ? statusArabic(payment.cryptoVerificationStatus) : 'بانتظار التحقق',
        payment.cryptoVerifiedAt ? formatPdfDate(payment.cryptoVerifiedAt, true) : '—',
      ]]
    : []

  return (
    <OfficialPdfDocument
      title={payment.status === 'PAID' ? 'إيصال سداد رسمي' : 'فاتورة رسوم رسمية'}
      subtitle="الأكاديمية الأمريكية للاستشارات والتدريب — وثيقة مالية إلكترونية قابلة للطباعة والحفظ بصيغة PDF."
      reference={payment.invoiceNo}
      status={statusArabic(payment.status)}
      issuedAt={payment.paidAt || payment.createdAt}
      autoPrint={autoPrint}
      footerNote="تظهر هذه الوثيقة وفق سجلات المنصة المالية. في حال كانت طريقة الدفع مباشرة أو USDT، يبقى تأكيد الإدارة أو التحقق المالي هو المرجع النهائي للسداد."
    >
      <PdfSection title="بيانات الفاتورة">
        <div className="grid gap-3 md:grid-cols-3">
          <PdfField label="رقم الفاتورة" value={payment.invoiceNo} />
          <PdfField label="رقم الإيصال" value={payment.receiptNo || 'لم يصدر بعد'} />
          <PdfField label="نوع الرسوم" value={statusArabic(payment.purpose)} />
          <PdfField label="المبلغ" value={formatPdfMoney(payment.amount, payment.currency)} />
          <PdfField label="طريقة الدفع" value={statusArabic(payment.method || payment.provider || '—')} />
          <PdfField label="تاريخ السداد" value={payment.paidAt ? formatPdfDate(payment.paidAt, true) : 'غير مسددة بعد'} />
        </div>
      </PdfSection>

      <PdfSection title="بيانات العميل / الطالب">
        <div className="grid gap-3 md:grid-cols-2">
          <PdfField label="الاسم" value={payerName} />
          <PdfField label="البريد الإلكتروني" value={payerEmail} />
          <PdfField label="الهاتف" value={payerPhone} />
          <PdfField label="الدولة" value={payerCountry} />
          <PdfField label="البرنامج / الخدمة" value={programName} />
          <PdfField label="كود الطلب" value={payment.admission?.reference || payment.enrollmentId || payment.agentId || '—'} />
        </div>
      </PdfSection>

      <PdfSection title="تفاصيل العملية">
        <PdfTable
          headers={['الوصف', 'القيمة', 'الحالة', 'تاريخ الإنشاء']}
          rows={[[
            payment.description,
            formatPdfMoney(payment.amount, payment.currency),
            statusArabic(payment.status),
            formatPdfDate(payment.createdAt, true),
          ]]}
        />
      </PdfSection>

      {cryptoRows.length > 0 ? (
        <PdfSection title="بيانات التحقق من USDT">
          <PdfTable headers={['الشبكة', 'TxID', 'حالة التحقق', 'وقت التحقق']} rows={cryptoRows} />
          {payment.cryptoWalletAddress ? (
            <p className="mt-3 break-words rounded-2xl bg-[#f7f4eb] p-3 text-xs font-bold text-slate-600">عنوان المحفظة: {payment.cryptoWalletAddress}</p>
          ) : null}
        </PdfSection>
      ) : null}
    </OfficialPdfDocument>
  )
}
