import Link from 'next/link'
import { db } from '@/lib/db'
import { serializeRepresentative, type RepresentativePublicProfile } from '@/lib/academy-representatives'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadRepresentatives(): Promise<RepresentativePublicProfile[]> {
  try {
    const rows = await db.academyRepresentative.findMany({
      where: { deletedAt: null, status: 'ACTIVE' },
      orderBy: [{ featured: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
    })
    return rows.map((row) => serializeRepresentative(row, null, false))
  } catch {
    return []
  }
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((x) => x[0]).join('') || 'AA'
}

export default async function RepresentativesPage() {
  const rows = await loadRepresentatives()
  const regions = [...new Set(rows.map((r) => r.region).filter(Boolean))]
  return (
    <main dir="rtl" className="min-h-screen overflow-hidden bg-[#f4f7fb] text-[#0f2b46]">
      <section className="relative isolate bg-[#0a1f36] px-4 py-16 text-white sm:py-20">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top_left,rgba(201,162,39,.35),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(191,22,70,.22),transparent_35%)]" />
        <div className="mx-auto max-w-7xl">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <Link href="/" className="inline-flex items-center rounded-full border border-white/20 bg-white/10 px-4 py-2 text-xs font-black text-white shadow-lg shadow-black/10 transition hover:bg-white/18">
              العودة للقائمة الرئيسية
            </Link>
            <Link href="/" className="inline-flex items-center rounded-full border border-[#c9a227]/40 bg-[#c9a227]/15 px-4 py-2 text-xs font-black text-[#f4d77d] transition hover:bg-[#c9a227]/25">
              الصفحة الرئيسية
            </Link>
          </div>
          <div className="max-w-3xl">
            <p className="mb-3 inline-flex rounded-full border border-[#c9a227]/35 bg-white/10 px-4 py-1 text-xs font-black text-[#f4d77d]">شبكة التمثيل الدولي</p>
            <h1 className="text-4xl font-black leading-tight sm:text-6xl">ممثلو الأكاديمية في الدول والمناطق</h1>
            <p className="mt-5 max-w-2xl text-sm font-bold leading-8 text-white/78 sm:text-base">
              نافذة رسمية للتعرّف إلى ممثلي الأكاديمية الأمريكية للاستشارات والتدريب، نطاقاتهم الجغرافية، سيرهم المهنية، وأعمالهم الموثقة.
            </p>
          </div>
          <div className="mt-8 flex flex-wrap gap-2">
            {regions.map((region) => <span key={region} className="rounded-full bg-white/10 px-4 py-2 text-xs font-black text-white/90">{region}</span>)}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12">
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((rep) => (
            <Link key={rep.id} href={`/representatives/${rep.slug}`} className="group overflow-hidden rounded-[2rem] border border-[#0f2b46]/10 bg-white shadow-xl shadow-slate-200/70 transition hover:-translate-y-1 hover:shadow-2xl">
              <div className="relative h-56 bg-gradient-to-br from-[#0f2b46] via-[#173e66] to-[#bf1646]">
                {rep.profilePhotoUrl ? (
                  <img src={rep.profilePhotoUrl} alt={rep.fullName} className="h-full w-full object-cover opacity-90 transition group-hover:scale-105" />
                ) : (
                  <div className="flex h-full items-center justify-center text-6xl font-black text-[#f5f0e1]">{initials(rep.fullName)}</div>
                )}
                <div className="absolute bottom-4 right-4 rounded-2xl bg-white/92 px-4 py-2 text-xs font-black text-[#0f2b46] shadow-lg">
                  {rep.country} — {rep.region}
                </div>
              </div>
              <div className="space-y-4 p-6">
                <div>
                  <h2 className="text-2xl font-black text-[#0f2b46]">{rep.fullName}</h2>
                  <p className="mt-1 text-sm font-extrabold text-[#bf1646]">{rep.displayTitle || 'ممثل الأكاديمية'}</p>
                  <p className="mt-1 text-xs font-bold text-slate-500">{rep.academicRank || rep.degreeTitle || 'ممثل أكاديمي معتمد'}</p>
                </div>
                <p className="min-h-20 text-sm font-bold leading-7 text-slate-600">{rep.shortBio || rep.professionalBio || 'سيرة مهنية ستظهر بعد اعتمادها من الإدارة.'}</p>
                <div className="flex flex-wrap gap-2">
                  {rep.specialization && <span className="rounded-full bg-[#c9a227]/15 px-3 py-1 text-[11px] font-black text-[#8b6b12]">{rep.specialization}</span>}
                  {rep.territory && <span className="rounded-full bg-[#0f2b46]/8 px-3 py-1 text-[11px] font-black text-[#0f2b46]">{rep.territory}</span>}
                </div>
                <div className="flex items-center justify-between border-t border-dashed border-slate-200 pt-4 text-xs font-black text-[#0f2b46]">
                  <span>عرض السيرة والاعتماد</span>
                  <span className="rounded-full bg-[#bf1646] px-3 py-1 text-white">زيارة الملف</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </main>
  )
}
