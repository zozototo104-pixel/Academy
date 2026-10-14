import type { Metadata } from 'next'
import { db } from '@/lib/db'
import { serializeRepresentativePublicCard } from '@/lib/academy-representatives'
import ExpandedRepresentativeVerifier from './ExpandedRepresentativeVerifier'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type PageProps = { params: Promise<{ token: string }> }

function appOrigin() {
  return String(process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/+$/, '')
}

async function findRepresentative(token: string) {
  return db.academyRepresentative.findFirst({
    where: { qrToken: token, deletedAt: null },
    include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
  }).catch(() => null)
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params
  const rep = await findRepresentative(token)
  const title = rep ? `تحقق من ممثل الأكاديمية — ${rep.fullName}` : 'رمز ممثل غير مسجل لدى الأكاديمية'
  return {
    title,
    description: rep ? `بطاقة تحقق عامة لممثل الأكاديمية ${rep.fullName}` : 'هذا الرمز غير مسجل لدى الأكاديمية',
    openGraph: {
      title,
      description: rep ? `بطاقة تحقق عامة لممثل الأكاديمية ${rep.fullName}` : 'هذا الرمز غير مسجل لدى الأكاديمية',
      images: rep?.officialCardUrl ? [rep.officialCardUrl] : undefined,
    },
  }
}

function Info({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className="rounded-2xl border border-white/10 bg-white/10 p-3">
      <p className="text-[10px] font-black uppercase tracking-wide text-[#f4d77d]">{label}</p>
      <p className="mt-1 text-sm font-bold leading-6 text-white">{value}</p>
    </div>
  )
}

function DigitalRepresentativeCard({ rep }: { rep: any }) {
  return (
    <div className="relative overflow-hidden rounded-[2rem] border border-[#c9a227]/35 bg-gradient-to-br from-[#0a1f36] via-[#12365c] to-[#bf1646] p-6 text-white shadow-2xl">
      <div className="absolute left-6 top-6 rounded-full border border-[#c9a227]/50 px-4 py-1 text-[10px] font-black text-[#f4d77d]">AACT OFFICIAL REPRESENTATIVE</div>
      <div className="mt-14 grid gap-6 sm:grid-cols-[150px_1fr] sm:items-center">
        <div className="flex aspect-square items-center justify-center overflow-hidden rounded-[2rem] border-4 border-[#c9a227] bg-white/10">
          {rep.profilePhotoUrl ? <img src={rep.profilePhotoUrl} alt={rep.fullName} className="h-full w-full object-cover" /> : <span className="text-5xl font-black">AA</span>}
        </div>
        <div>
          <h2 className="text-3xl font-black leading-tight">{rep.fullName}</h2>
          <p className="mt-2 text-sm font-black text-[#f4d77d]">{rep.displayTitle || 'ممثل الأكاديمية'}</p>
          <p className="mt-1 text-sm font-bold text-white/80">{rep.academicRank || rep.degreeTitle}</p>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <Info label="الدولة" value={rep.country} />
            <Info label="المنطقة" value={rep.region} />
            <Info label="النطاق" value={rep.territory || rep.city} />
            <Info label="مجال التمثيل" value={rep.specialization} />
            <Info label="نوع التمثيل" value={rep.representativeRole} />
          </div>
        </div>
      </div>
    </div>
  )
}

export default async function RepresentativeVerifyPage({ params }: PageProps) {
  const { token } = await params
  const row = await findRepresentative(token)

  if (!row) {
    return (
      <main dir="rtl" className="min-h-screen bg-[#f4f7fb] px-4 py-10 text-[#0f2b46]">
        <section className="mx-auto max-w-2xl rounded-[2rem] border border-red-100 bg-white p-8 text-center shadow-xl">
          <p className="text-5xl">❌</p>
          <h1 className="mt-4 text-2xl font-black">هذا الرمز غير مسجل لدى الأكاديمية</h1>
          <p className="mt-3 text-sm font-bold text-slate-500">تأكد من الرابط أو امسح رمز QR الرسمي مرة أخرى.</p>
        </section>
      </main>
    )
  }

  const rep = serializeRepresentativePublicCard(row, appOrigin())
  const verifiedAt = new Intl.DateTimeFormat('ar', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(rep.verifiedAt))

  return (
    <main dir="rtl" className="min-h-screen bg-[#f4f7fb] px-4 py-10 text-[#0f2b46]">
      <section className="mx-auto max-w-5xl overflow-hidden rounded-[2rem] border border-[#0f2b46]/10 bg-white shadow-2xl shadow-slate-200/80">
        <div className="bg-[#0a1f36] px-6 py-8 text-white">
          <p className="text-xs font-black text-[#d2ad5a]">AACT Secure Representative ID</p>
          <h1 className="mt-2 text-3xl font-black">بطاقة التحقق العامة لممثل الأكاديمية</h1>
          <div className={`mt-4 inline-flex rounded-full px-4 py-2 text-sm font-black ${rep.active ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}`}>
            {rep.statusLabel}
          </div>
        </div>

        <div className="p-6">
          {rep.officialCardUrl ? (
            <div className="overflow-hidden rounded-[2rem] border border-[#c9a227]/30 bg-slate-100">
              <img src={rep.officialCardUrl} alt={`الكرنيه الرسمي — ${rep.fullName}`} className="mx-auto max-h-[82vh] w-full object-contain" />
            </div>
          ) : (
            <DigitalRepresentativeCard rep={rep} />
          )}

          <div className="mt-6 rounded-[2rem] border border-slate-100 bg-slate-50 p-4">
            <h2 className="text-lg font-black text-[#0f2b46]">البيانات العامة المعتمدة</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl bg-white p-3"><p className="text-[11px] font-black text-slate-500">الاسم</p><p className="mt-1 text-sm font-bold">{rep.fullName}</p></div>
              <div className="rounded-2xl bg-white p-3"><p className="text-[11px] font-black text-slate-500">المسمى</p><p className="mt-1 text-sm font-bold">{rep.displayTitle || 'ممثل الأكاديمية'}</p></div>
              <div className="rounded-2xl bg-white p-3"><p className="text-[11px] font-black text-slate-500">الرتبة أو الدرجة</p><p className="mt-1 text-sm font-bold">{rep.academicRank || rep.degreeTitle || 'غير محدد'}</p></div>
              <div className="rounded-2xl bg-white p-3"><p className="text-[11px] font-black text-slate-500">الدولة والمنطقة</p><p className="mt-1 text-sm font-bold">{rep.country} — {rep.region}</p></div>
              <div className="rounded-2xl bg-white p-3"><p className="text-[11px] font-black text-slate-500">النطاق</p><p className="mt-1 text-sm font-bold">{rep.territory || rep.city || 'غير محدد'}</p></div>
              <div className="rounded-2xl bg-white p-3"><p className="text-[11px] font-black text-slate-500">مجال التمثيل</p><p className="mt-1 text-sm font-bold">{rep.specialization || 'غير محدد'}</p></div>
              <div className="rounded-2xl bg-white p-3"><p className="text-[11px] font-black text-slate-500">نوع التمثيل</p><p className="mt-1 text-sm font-bold">{rep.representativeRole || 'غير محدد'}</p></div>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-[11px] font-black text-slate-500">تاريخ التحقق الحالي</p>
              <p className="mt-1 text-sm font-bold text-[#0f2b46]">{verifiedAt}</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <p className="text-[11px] font-black text-slate-500">الأكاديمية</p>
              <a href={rep.academy.url || 'https://aact.academy'} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-sm font-black text-[#bf1646]">
                {rep.academy.name}
              </a>
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-amber-100 bg-amber-50 p-4 text-sm font-bold leading-7 text-amber-900">
            هذه الصفحة تعرض البيانات العامة المسموح نشرها فقط. لا تعرض الجوال أو الإيميل أو واتساب أو الملفات إلا بعد التحقق الموسّع.
          </div>

          <ExpandedRepresentativeVerifier token={token} />
        </div>
      </section>
    </main>
  )
}
