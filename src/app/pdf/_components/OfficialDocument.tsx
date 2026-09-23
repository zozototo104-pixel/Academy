import type { ReactNode } from 'react'
import { PrintControls } from './PrintControls'

export function formatPdfDate(value?: Date | string | null, withTime = false): string {
  if (!value) return '—'
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }
  if (withTime) {
    options.hour = '2-digit'
    options.minute = '2-digit'
  }
  return new Intl.DateTimeFormat('ar-EG', options).format(date)
}

export function formatPdfMoney(amount?: number | null, currency = 'USD'): string {
  if (amount == null || Number.isNaN(Number(amount))) return '—'
  return `${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`
}

export function getOfficialBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL
  if (explicit) return explicit.replace(/\/$/, '')
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  return 'https://academy-raqaba.vercel.app'
}

export function statusArabic(status?: string | null): string {
  const map: Record<string, string> = {
    UNPAID: 'غير مسددة',
    PAID: 'مسددة',
    ACTIVE: 'نشط',
    COMPLETED: 'مكتمل',
    SUBMITTED: 'مسلّم',
    GRADED: 'مصحح',
    NEEDS_REVISION: 'يحتاج تعديل',
    PUBLISHED: 'منشور',
    DRAFT: 'مسودة',
    REVOKED: 'ملغي',
    PROGRAM_COMPLETION: 'إتمام برنامج',
    ACCREDITATION: 'اعتماد',
    AGENCY: 'وكالة',
    DIRECT_PAYMENT: 'دفع مباشر',
    USDT: 'USDT',
    SANDBOX: 'تجريبي',
    APPLICATION_FEE: 'رسوم تقديم',
    TUITION: 'رسوم دراسية',
    TUITION_INSTALLMENT: 'دفعة تقسيط',
    SERVICE_FEE: 'رسوم خدمة',
    ACCREDITATION_APP: 'رسوم طلب اعتماد',
  }
  return status ? map[status] || status : '—'
}

export function PdfField({ label, value }: { label: string; value?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-[#e7ddbd] bg-[#fffdf6] p-4">
      <div className="text-[11px] font-black uppercase tracking-wide text-[#9b7b2d]">{label}</div>
      <div className="mt-1 break-words text-sm font-extrabold leading-relaxed text-[#0f2b46]">{value === null || value === undefined || value === '' ? '—' : value}</div>
    </div>
  )
}

export function PdfSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pdf-avoid-break rounded-[28px] border border-[#e8edf5] bg-white p-6 shadow-sm">
      <h2 className="mb-4 border-b border-dashed border-[#d6c690] pb-3 text-xl font-black text-[#0f2b46]">{title}</h2>
      {children}
    </section>
  )
}

export function PdfTable({
  headers,
  rows,
}: {
  headers: string[]
  rows: Array<Array<ReactNode>>
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[#e8edf5]">
      <table className="w-full border-collapse text-right text-sm">
        <thead className="bg-[#0f2b46] text-[#f5f0e1]">
          <tr>
            {headers.map((h) => (
              <th key={h} className="px-3 py-3 font-black">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={headers.length} className="px-3 py-6 text-center font-bold text-slate-400">لا توجد بيانات</td></tr>
          ) : rows.map((row, i) => (
            <tr key={i} className={i % 2 ? 'bg-[#fbfcff]' : 'bg-white'}>
              {row.map((cell, j) => (
                <td key={j} className="border-t border-[#eef1f6] px-3 py-3 align-top font-bold leading-relaxed text-slate-700">{cell === null || cell === undefined || cell === '' ? '—' : cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function OfficialPdfDocument({
  title,
  subtitle,
  reference,
  status,
  issuedAt,
  children,
  footerNote,
  autoPrint = false,
}: {
  title: string
  subtitle?: string
  reference?: string
  status?: string
  issuedAt?: Date | string | null
  children: ReactNode
  footerNote?: string
  autoPrint?: boolean
}) {
  return (
    <main className="min-h-screen bg-[#f4f0e5] px-4 py-8 font-cairo text-[#0f2b46] print:bg-white" dir="rtl">
      <PrintControls autoPrint={autoPrint} />
      <article id="aact-print-page" className="mx-auto max-w-4xl rounded-[34px] border border-[#d7bf62] bg-white p-8 shadow-2xl print:shadow-none">
        <header className="pdf-avoid-break overflow-hidden rounded-[28px] bg-[#0f2b46] text-white">
          <div className="grid gap-5 p-7 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <div className="text-xs font-black tracking-[0.35em] text-[#d7bf62]">AACT OFFICIAL DOCUMENT</div>
              <h1 className="mt-3 text-3xl font-black leading-tight md:text-4xl">{title}</h1>
              {subtitle ? <p className="mt-2 text-sm font-bold leading-relaxed text-slate-200">{subtitle}</p> : null}
            </div>
            <div className="flex h-24 w-24 items-center justify-center rounded-full border border-[#d7bf62]/60 bg-white/10 text-center text-sm font-black leading-tight text-[#d7bf62]">
              AACT<br />2016
            </div>
          </div>
          <div className="grid border-t border-white/10 bg-black/10 md:grid-cols-3">
            <div className="p-4">
              <div className="text-[10px] font-black text-[#d7bf62]">المرجع</div>
              <div className="mt-1 text-sm font-black">{reference || '—'}</div>
            </div>
            <div className="p-4">
              <div className="text-[10px] font-black text-[#d7bf62]">الحالة</div>
              <div className="mt-1 text-sm font-black">{status || '—'}</div>
            </div>
            <div className="p-4">
              <div className="text-[10px] font-black text-[#d7bf62]">تاريخ الإصدار</div>
              <div className="mt-1 text-sm font-black">{formatPdfDate(issuedAt || new Date())}</div>
            </div>
          </div>
        </header>

        <div className="mt-6 space-y-6">{children}</div>

        <footer className="pdf-avoid-break mt-8 rounded-2xl border border-dashed border-[#d7bf62] bg-[#fffaf0] p-4 text-center text-xs font-bold leading-relaxed text-slate-600">
          {footerNote || 'هذه الوثيقة صادرة إلكترونياً من منصة الأكاديمية الأمريكية للاستشارات والتدريب. للتحقق من صحتها استخدم رقم المرجع أو رمز التحقق المرفق عند توفره.'}
        </footer>
      </article>
    </main>
  )
}

export function AccessDeniedPdf() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f4f0e5] p-6 font-cairo" dir="rtl">
      <div className="max-w-xl rounded-[30px] border border-red-100 bg-white p-8 text-center shadow-xl">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-red-50 text-3xl font-black text-red-600">!</div>
        <h1 className="mt-5 text-2xl font-black text-[#0f2b46]">لا يمكن عرض هذه الوثيقة</h1>
        <p className="mt-2 text-sm font-bold leading-relaxed text-slate-500">تأكد من تسجيل الدخول بالحساب صاحب الوثيقة أو بحساب إداري.</p>
      </div>
    </main>
  )
}
