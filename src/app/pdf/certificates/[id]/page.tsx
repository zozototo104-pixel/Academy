import { notFound } from 'next/navigation'
import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import {
  AccessDeniedPdf,
  OfficialPdfDocument,
  PdfField,
  PdfSection,
  formatPdfDate,
  getOfficialBaseUrl,
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

const TYPE_LABEL: Record<string, string> = {
  PROGRAM_COMPLETION: 'شهادة إتمام برنامج تدريبي',
  ACCREDITATION: 'شهادة اعتماد دولي',
  AGENCY: 'شهادة وكالة وتمثيل دولي',
}

export default async function CertificatePdfPage({ params, searchParams }: PageProps) {
  const { id } = await params
  const query = searchParams ? await searchParams : {}
  const user = await getCurrentUser()
  const certificate = await db.certificate.findFirst({
    where: { OR: [{ id }, { serial: id }, { qrToken: id }] },
    include: {
      admission: { select: { id: true, reference: true, userId: true, fullName: true, email: true, country: true, program: true } },
      agent: { select: { id: true, userId: true, orgName: true, repName: true, email: true, country: true, kind: true, accreditationType: true } },
    },
  })

  if (!certificate) notFound()

  const ownerId = certificate.userId || certificate.admission?.userId || certificate.agent?.userId || null
  if (!canView(user, ownerId)) return <AccessDeniedPdf />

  const verifyParam = certificate.qrToken
    ? `token=${encodeURIComponent(certificate.qrToken)}`
    : `serial=${encodeURIComponent(certificate.serial)}`
  const verifyUrl = `${getOfficialBaseUrl()}/?view=verify&${verifyParam}`
  const qr = await QRCode.toDataURL(verifyUrl, { margin: 1, width: 260 })
  const autoPrint = firstParam(query.print) === '1'

  return (
    <OfficialPdfDocument
      title={TYPE_LABEL[certificate.type] || 'شهادة رسمية'}
      subtitle="وثيقة تحقق رسمية صادرة من الأكاديمية الأمريكية للاستشارات والتدريب."
      reference={certificate.serial}
      status={certificate.valid ? 'صالحة' : 'ملغاة'}
      issuedAt={certificate.issuedAt}
      autoPrint={autoPrint}
      footerNote="يمكن التحقق من صحة هذه الشهادة عبر رمز QR أو الرقم التسلسلي. أي تعديل خارج منصة الأكاديمية يجعل الوثيقة غير معتمدة."
    >
      <section className="pdf-avoid-break relative overflow-hidden rounded-[34px] border-4 border-[#d7bf62] bg-[#fffdf5] p-8 text-center">
        <div className="pointer-events-none absolute inset-4 rounded-[26px] border border-[#0f2b46]/25" />
        <div className="relative">
          <div className="mx-auto flex h-24 w-24 items-center justify-center rounded-full border border-[#d7bf62] bg-[#0f2b46] text-lg font-black leading-tight text-[#d7bf62]">
            AACT<br />2016
          </div>
          <p className="mt-4 text-xs font-black tracking-[0.32em] text-[#9b7b2d]">AMERICAN ACADEMY FOR CONSULTING AND TRAINING</p>
          <h2 className="mt-2 text-2xl font-black text-[#0f2b46]">الأكاديمية الأمريكية للاستشارات والتدريب</h2>
          <div className="mx-auto mt-5 h-px w-56 bg-gradient-to-l from-transparent via-[#d7bf62] to-transparent" />
          <p className="mt-6 text-sm font-bold text-slate-500">تشهد الأكاديمية بأن</p>
          <h3 className="mx-auto mt-2 max-w-2xl border-b-2 border-[#d7bf62]/70 pb-3 text-4xl font-black leading-tight text-[#0f2b46]">{certificate.holderName}</h3>
          <p className="mt-5 text-sm font-bold text-slate-500">قد أتمّ / استحقّ متطلبات</p>
          <p className="mx-auto mt-2 max-w-2xl text-2xl font-black leading-relaxed text-[#9b7b2d]">{certificate.program}</p>
          {certificate.grade ? <p className="mt-4 text-sm font-black text-[#0f2b46]">النتيجة / التقدير: {certificate.grade}</p> : null}

          <div className="mt-10 grid items-end gap-6 md:grid-cols-3">
            <div className="text-center">
              <div className="mx-auto mb-2 h-12 w-36 border-b-2 border-[#0f2b46]/50" />
              <p className="text-xs font-black text-[#0f2b46]">رئيس مجلس الإدارة</p>
              <p className="text-[10px] text-slate-400">Chairman of the Board</p>
            </div>
            <div className="flex flex-col items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="رمز تحقق الشهادة" className="h-28 w-28 rounded-2xl border border-slate-200 bg-white p-2" />
              <p className="font-mono text-[11px] font-black text-[#0f2b46]" dir="ltr">{certificate.serial}</p>
            </div>
            <div className="text-center">
              <div className="mx-auto mb-2 h-12 w-36 border-b-2 border-[#0f2b46]/50" />
              <p className="text-xs font-black text-[#0f2b46]">المدير الأكاديمي</p>
              <p className="text-[10px] text-slate-400">Academic Director</p>
            </div>
          </div>
          <p className="mt-6 text-xs font-bold text-slate-500">تاريخ الإصدار: {formatPdfDate(certificate.issuedAt)} {certificate.country ? `— ${certificate.country}` : ''}</p>
        </div>
      </section>

      <PdfSection title="بيانات التحقق">
        <div className="grid gap-3 md:grid-cols-2">
          <PdfField label="الرقم التسلسلي" value={certificate.serial} />
          <PdfField label="نوع الشهادة" value={statusArabic(certificate.type)} />
          <PdfField label="رمز QR" value={certificate.qrToken || '—'} />
          <PdfField label="رابط التحقق" value={<span dir="ltr" className="text-xs">{verifyUrl}</span>} />
        </div>
      </PdfSection>
    </OfficialPdfDocument>
  )
}
