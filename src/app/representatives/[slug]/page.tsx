import Link from 'next/link'
import QRCode from 'qrcode'
import { db } from '@/lib/db'
import { DEMO_REPRESENTATIVES, representativeVerifyUrl, serializeRepresentative, type RepresentativePublicProfile } from '@/lib/academy-representatives'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadRepresentative(slug: string): Promise<{ rep: RepresentativePublicProfile | null; demo: boolean }> {
  try {
    const row = await db.academyRepresentative.findFirst({
      where: { slug, deletedAt: null, status: 'ACTIVE' },
      include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
    })
    if (row) return { rep: serializeRepresentative(row, null, true), demo: false }
  } catch {}
  const demo = DEMO_REPRESENTATIVES.find((item) => item.slug === slug) || null
  return { rep: demo, demo: !!demo }
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('') || 'AA'
}

async function makeQr(token?: string | null) {
  if (!token) return null
  try {
    return await QRCode.toDataURL(representativeVerifyUrl(token), { width: 240, margin: 1, color: { dark: '#0f2b46', light: '#ffffff' } })
  } catch {
    return null
  }
}

export default async function RepresentativeProfilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const { rep, demo } = await loadRepresentative(slug)
  if (!rep) {
    return <main dir="rtl" className="min-h-screen bg-slate-50 p-8 text-center text-[#0f2b46]"><h1 className="text-3xl font-black">لم يتم العثور على الممثل</h1><Link href="/representatives" className="mt-6 inline-block rounded-full bg-[#0f2b46] px-6 py-3 text-sm font-black text-white">العودة للقائمة</Link></main>
  }
  const qr = await makeQr(rep.qrToken)
  return (
    <main dir="rtl" className="min-h-screen bg-[#f4f7fb] text-[#0f2b46]">
      <section className="relative overflow-hidden bg-[#0a1f36] px-4 py-12 text-white sm:py-16">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(201,162,39,.28),transparent_30%),radial-gradient(circle_at_80%_10%,rgba(191,22,70,.2),transparent_35%)]" />
        <div className="relative mx-auto grid max-w-7xl gap-8 lg:grid-cols-[360px_1fr] lg:items-center">
          <div className="overflow-hidden rounded-[2.5rem] border border-white/15 bg-white/10 p-3 shadow-2xl">
            <div className="flex aspect-[4/5] items-center justify-center overflow-hidden rounded-[2rem] bg-gradient-to-br from-[#12365c] to-[#bf1646]">
              {rep.profilePhotoUrl ? <img src={rep.profilePhotoUrl} alt={rep.fullName} className="h-full w-full object-cover" /> : <span className="text-7xl font-black text-[#f5f0e1]">{initials(rep.fullName)}</span>}
            </div>
          </div>
          <div>
            {demo && <p className="mb-3 inline-flex rounded-full bg-amber-300/15 px-4 py-1 text-xs font-black text-amber-100">بيانات تجريبية للعرض</p>}
            <p className="text-sm font-black text-[#d2ad5a]">{rep.displayTitle || 'ممثل الأكاديمية'}</p>
            <h1 className="mt-3 text-4xl font-black leading-tight sm:text-6xl">{rep.fullName}</h1>
            <div className="mt-5 flex flex-wrap gap-2 text-xs font-black">
              <span className="rounded-full bg-white/12 px-4 py-2">{rep.country}</span>
              <span className="rounded-full bg-white/12 px-4 py-2">{rep.region}</span>
              {rep.academicRank && <span className="rounded-full bg-[#c9a227] px-4 py-2 text-[#0f2b46]">{rep.academicRank}</span>}
              {rep.degreeTitle && <span className="rounded-full bg-white/12 px-4 py-2">{rep.degreeTitle}</span>}
            </div>
            <p className="mt-6 max-w-3xl text-base font-bold leading-9 text-white/80">{rep.shortBio || rep.professionalBio}</p>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-4 py-10 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <article className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-6 shadow-xl shadow-slate-200/70">
            <h2 className="text-2xl font-black">السيرة الذاتية المهنية</h2>
            <p className="mt-4 whitespace-pre-line text-sm font-bold leading-8 text-slate-650">{rep.professionalBio || rep.shortBio || 'لم تعتمد الإدارة سيرة تفصيلية بعد.'}</p>
          </article>
          <article className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-6 shadow-xl shadow-slate-200/70">
            <h2 className="text-2xl font-black">الأعمال والإنجازات</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl bg-slate-50 p-4"><h3 className="font-black text-[#bf1646]">أعماله</h3><p className="mt-2 whitespace-pre-line text-sm font-bold leading-7 text-slate-600">{rep.worksSummary || 'تُضاف الأعمال من لوحة الإدارة.'}</p></div>
              <div className="rounded-2xl bg-slate-50 p-4"><h3 className="font-black text-[#bf1646]">الإنجازات</h3><p className="mt-2 whitespace-pre-line text-sm font-bold leading-7 text-slate-600">{rep.achievements || 'تُضاف الإنجازات من لوحة الإدارة.'}</p></div>
            </div>
          </article>
          <article className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-6 shadow-xl shadow-slate-200/70">
            <h2 className="text-2xl font-black">ملفات وروابط الأعمال</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {(rep.files || []).length ? rep.files!.map((file) => (
                <a key={file.id} href={file.externalUrl || file.fileUrl || '#'} target="_blank" rel="noopener noreferrer" className="rounded-2xl border border-[#0f2b46]/10 bg-slate-50 p-4 transition hover:border-[#c9a227] hover:bg-amber-50">
                  <p className="text-xs font-black text-[#c9a227]">{file.kind}</p>
                  <h3 className="mt-1 font-black">{file.title}</h3>
                  {file.description && <p className="mt-2 text-xs font-bold leading-6 text-slate-500">{file.description}</p>}
                </a>
              )) : <p className="text-sm font-bold text-slate-500">لا توجد ملفات عامة مرتبطة بهذا الممثل بعد.</p>}
            </div>
          </article>
        </div>

        <aside className="space-y-6">
          <div className="rounded-[2rem] border border-[#c9a227]/25 bg-white p-6 shadow-xl shadow-slate-200/70">
            <h2 className="text-xl font-black">نطاق التمثيل</h2>
            <dl className="mt-4 space-y-3 text-sm font-bold text-slate-600">
              <div><dt className="text-xs text-slate-400">المنطقة</dt><dd>{rep.region}</dd></div>
              <div><dt className="text-xs text-slate-400">الدولة/الدول</dt><dd>{rep.country}</dd></div>
              {rep.territory && <div><dt className="text-xs text-slate-400">النطاق الجغرافي</dt><dd>{rep.territory}</dd></div>}
              {rep.specialization && <div><dt className="text-xs text-slate-400">مجال التمثيل</dt><dd>{rep.specialization}</dd></div>}
            </dl>
          </div>
          <div className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-6 shadow-xl shadow-slate-200/70">
            <h2 className="text-xl font-black">التواصل الرسمي</h2>
            <div className="mt-4 space-y-2 text-sm font-bold text-slate-600">
              {rep.phone && <p dir="ltr" className="text-right">{rep.phone}</p>}
              {rep.email && <p dir="ltr" className="text-right">{rep.email}</p>}
              {rep.whatsapp && <p dir="ltr" className="text-right">WhatsApp: {rep.whatsapp}</p>}
              {rep.website && <a href={rep.website} target="_blank" rel="noopener noreferrer" className="block text-[#bf1646]">الموقع / رابط الأعمال</a>}
            </div>
            {rep.publicContactNote && <p className="mt-4 rounded-2xl bg-[#0f2b46]/5 p-3 text-xs font-bold leading-6 text-slate-500">{rep.publicContactNote}</p>}
          </div>
          <div className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-6 text-center shadow-xl shadow-slate-200/70">
            <h2 className="text-xl font-black">التحقق من الكرنيه</h2>
            {qr ? <img src={qr} alt="QR" className="mx-auto mt-4 h-40 w-40 rounded-2xl border border-slate-100 bg-white p-2" /> : <p className="mt-4 text-xs font-bold text-slate-500">سيظهر QR بعد اعتماد الممثل من الإدارة.</p>}
            {rep.qrToken && (
              <div className="mt-4 flex flex-col gap-2">
                <Link href={`/representatives/verify/${rep.qrToken}`} className="inline-block rounded-full bg-[#0f2b46] px-5 py-3 text-xs font-black text-white">فتح صفحة التحقق</Link>
                <a href={`/representatives/qr/${rep.qrToken}`} target="_blank" rel="noopener noreferrer" className="inline-block rounded-full border border-[#0f2b46]/15 bg-white px-5 py-3 text-xs font-black text-[#0f2b46]">فتح QR كصورة قابلة للمسح</a>
              </div>
            )}
          </div>
          <Link href="/representatives" className="block rounded-full border border-[#0f2b46]/15 bg-white px-5 py-3 text-center text-sm font-black text-[#0f2b46]">العودة إلى جميع الممثلين</Link>
        </aside>
      </section>
    </main>
  )
}
