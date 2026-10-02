import type { Metadata } from 'next'
import Link from 'next/link'
import { db } from '@/lib/db'
import { isGenericAllSpecializationsProgram, PROGRAM_CATEGORY_ORDER } from '@/lib/program-tracks'
import { getServiceFlow } from '@/lib/service-flows'

export const metadata: Metadata = {
  title: 'البرامج والخدمات المهنية | AACT',
  description: 'استكشف برامج الأكاديمية الأمريكية للاستشارات والتدريب: الماجستير المهني، الدكتوراه المهنية، الدبلومات، الشهادات الدولية، الاعتمادات والخدمات المهنية.',
}

export const revalidate = 300

const CATEGORY_LABEL: Record<string, string> = {
  DIPLOMA: 'دبلوم مهني',
  DOCTORATE: 'دكتوراه مهنية',
  MASTERS: 'ماجستير مهني',
  ACCREDITATION: 'اعتماد دولي',
  INTL_CERT: 'شهادة دولية',
  SERVICE: 'خدمة مهنية',
}

const FILTERS: { key: string; label: string }[] = [
  { key: 'ALL', label: 'الكل' },
  { key: 'MASTERS', label: 'الماجستير' },
  { key: 'DOCTORATE', label: 'الدكتوراه' },
  { key: 'DEGREES', label: 'ماجستير ودكتوراه' },
  { key: 'INTL_CERT', label: 'الشهادات الدولية' },
  { key: 'DIPLOMA', label: 'الدبلومات التدريبية' },
  { key: 'ACCREDITATION', label: 'الاعتمادات' },
  { key: 'SERVICE', label: 'الخدمات المهنية' },
]

type ProgramRow = {
  id: string
  slug: string
  titleAr: string
  titleEn: string | null
  description: string
  category: string
  hours: number | null
  price: number | null
  features: string | null
  order: number
  _count: { units: number }
}

function isInternalQaProgram(p: { slug?: string | null; titleAr?: string | null; titleEn?: string | null }) {
  const slug = String(p.slug || '')
  const titleAr = String(p.titleAr || '')
  const titleEn = String(p.titleEn || '')
  return slug.startsWith('qa-full-journey-')
    || slug === 'launch-quality-diagnostic-program'
    || titleAr.startsWith('برنامج جودة رحلة كاملة QA')
    || titleEn.startsWith('QA Full Journey Program')
}

function matchFilter(p: ProgramRow, filter: string) {
  if (filter === 'ALL') return true
  if (filter === 'DEGREES') return p.category === 'MASTERS' || p.category === 'DOCTORATE'
  return p.category === filter
}

function featureList(value?: string | null): string[] {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 4).map(String) : []
  } catch {
    return []
  }
}

function normalize(value: string) {
  return value.trim().toLowerCase()
}

function filterHref(filter: string, q: string) {
  const params = new URLSearchParams()
  if (filter !== 'ALL') params.set('filter', filter)
  if (q.trim()) params.set('q', q.trim())
  const suffix = params.toString()
  return suffix ? `/programs?${suffix}` : '/programs'
}

async function getPrograms() {
  const rows = await db.program.findMany({
    where: { active: true },
    orderBy: [{ category: 'asc' }, { order: 'asc' }, { titleAr: 'asc' }],
    select: {
      id: true,
      slug: true,
      titleAr: true,
      titleEn: true,
      description: true,
      category: true,
      hours: true,
      price: true,
      features: true,
      order: true,
      _count: { select: { units: true } },
    },
  })

  return rows
    .filter((p) => !isGenericAllSpecializationsProgram(p) && !isInternalQaProgram(p))
    .sort((a, b) => {
      const ca = PROGRAM_CATEGORY_ORDER.indexOf(a.category)
      const cb = PROGRAM_CATEGORY_ORDER.indexOf(b.category)
      const oa = ca === -1 ? 999 : ca
      const ob = cb === -1 ? 999 : cb
      return oa - ob || a.order - b.order || a.titleAr.localeCompare(b.titleAr, 'ar')
    })
}

export default async function ProgramsPage({
  searchParams,
}: {
  searchParams?: Promise<{ filter?: string; q?: string; search?: string }>
}) {
  const params = (await searchParams) || {}
  const requestedFilter = String(params.filter || 'ALL').toUpperCase()
  const activeFilter = FILTERS.some((f) => f.key === requestedFilter) ? requestedFilter : 'ALL'
  const q = String(params.q || params.search || '').trim()
  const words = normalize(q).split(/\s+/).filter(Boolean)
  const programs = await getPrograms()
  const filtered = programs
    .filter((p) => matchFilter(p, activeFilter))
    .filter((p) => {
      if (!words.length) return true
      const hay = normalize(`${p.titleAr} ${p.titleEn || ''} ${p.description || ''}`)
      return words.every((word) => hay.includes(word))
    })

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: 'برامج وخدمات الأكاديمية الأمريكية للاستشارات والتدريب',
    description: metadata.description,
    numberOfItems: filtered.length,
    itemListElement: filtered.slice(0, 40).map((program, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: program.titleAr,
      url: `/programs/${program.slug || program.id}`,
    })),
  }

  return (
    <main className="min-h-screen bg-[#f7f4ed] text-[#0f2b46]">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <header className="border-b border-[#0f2b46]/10 bg-white/90">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <Link href="/" className="text-sm font-black text-[#0f2b46]">الأكاديمية الأمريكية للاستشارات والتدريب</Link>
          <nav className="flex flex-wrap gap-3 text-xs font-bold text-slate-600">
            <Link href="/" className="hover:text-[#c9a227]">الرئيسية</Link>
            <Link href="/apply" className="hover:text-[#c9a227]">طلب الالتحاق</Link>
            <Link href="/verify" className="hover:text-[#c9a227]">التحقق من الشهادات</Link>
            <Link href="/login" className="hover:text-[#c9a227]">دخول</Link>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-4 py-10">
        <div className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-6 shadow-sm sm:p-8">
          <p className="text-xs font-black uppercase tracking-[0.25em] text-[#c9a227]">AACT Programs</p>
          <h1 className="mt-3 text-3xl font-black leading-tight sm:text-4xl">البرامج والخدمات المهنية</h1>
          <p className="mt-4 max-w-4xl text-sm leading-8 text-slate-600">
            استكشف مسارات الأكاديمية الأمريكية للاستشارات والتدريب: الدرجات المهنية، الدبلومات، الشهادات الدولية، الاعتمادات، الحقائب التدريبية، معادلة الخبرة، والاستشارات المؤسسية.
          </p>
          <div className="mt-5 flex flex-wrap gap-2 text-xs font-extrabold text-slate-600">
            <span className="rounded-full bg-[#0f2b46]/5 px-3 py-1.5">{programs.length} برنامج وخدمة منشورة</span>
            <span className="rounded-full bg-[#c9a227]/15 px-3 py-1.5 text-[#8a6d12]">تحديث مباشر من قاعدة البرامج</span>
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-[#0f2b46]/10 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((filter) => (
              <Link
                key={filter.key}
                href={filterHref(filter.key, q)}
                className={`rounded-full px-4 py-2 text-xs font-extrabold transition-colors ${
                  activeFilter === filter.key
                    ? 'bg-[#0f2b46] text-[#e0b83a]'
                    : 'border border-[#0f2b46]/15 bg-white text-[#0f2b46] hover:bg-[#0f2b46]/5'
                }`}
              >
                {filter.label}
              </Link>
            ))}
          </div>
          <form action="/programs" className="mt-4 flex flex-col gap-2 sm:flex-row">
            {activeFilter !== 'ALL' && <input type="hidden" name="filter" value={activeFilter} />}
            <input
              name="q"
              defaultValue={q}
              placeholder="ابحث عن برنامج... قيادة، موارد بشرية، مشاريع"
              className="min-h-11 flex-1 rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm outline-none focus:border-[#c9a227]"
            />
            <button className="rounded-xl bg-[#0f2b46] px-5 py-3 text-sm font-black text-[#f5f0e1] hover:bg-[#12365c]">
              بحث
            </button>
          </form>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {filtered.map((program) => {
            const flow = getServiceFlow(program.slug)
            const features = flow?.highlights?.length ? flow.highlights.slice(0, 4) : featureList(program.features)
            const description = flow?.summary || program.description
            const serviceLike = flow ? !flow.isStudyProgram : program.category === 'SERVICE'
            return (
              <article key={program.id} className="flex flex-col rounded-2xl border border-[#0f2b46]/10 bg-white p-6 shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-[#0f2b46] px-3 py-1.5 text-xs font-black text-[#e0b83a]">
                    {flow?.kicker || CATEGORY_LABEL[program.category] || program.category}
                  </span>
                  {program.price != null && (
                    <span className="rounded-full bg-[#c9a227]/15 px-3 py-1.5 text-xs font-black text-[#8a6d12]">{program.price}$</span>
                  )}
                  {program.hours != null && (
                    <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600">{program.hours} ساعة</span>
                  )}
                  <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600">
                    {program._count.units > 0 ? `${program._count.units} وحدات` : serviceLike ? 'خدمة مهنية' : 'برنامج اعتماد'}
                  </span>
                </div>
                <h2 className="mt-4 text-xl font-black leading-8 text-[#0f2b46]">{program.titleAr}</h2>
                {program.titleEn && <p className="mt-1 text-xs font-bold text-[#a8841a]" dir="ltr">{program.titleEn}</p>}
                <p className="mt-4 line-clamp-4 text-sm leading-7 text-slate-600">{description}</p>
                {features.length > 0 && (
                  <ul className="mt-4 space-y-2 text-xs font-bold leading-6 text-slate-600">
                    {features.map((feature, index) => (
                      <li key={index} className="flex gap-2">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#c9a227]" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-auto flex flex-col gap-2 pt-5 sm:flex-row">
                  <Link
                    href={`/programs/${encodeURIComponent(program.slug || program.id)}`}
                    className="inline-flex flex-1 items-center justify-center rounded-xl border border-[#0f2b46]/15 px-4 py-3 text-sm font-black text-[#0f2b46] hover:bg-[#0f2b46]/5"
                  >
                    التفاصيل
                  </Link>
                  <Link
                    href={`/apply?program=${encodeURIComponent(program.titleAr)}`}
                    className="inline-flex flex-1 items-center justify-center rounded-xl bg-[#c9a227] px-4 py-3 text-sm font-black text-[#0f2b46] hover:bg-[#e0b83a]"
                  >
                    {serviceLike ? 'اطلب الخدمة الآن' : 'قدّم طلب الالتحاق'}
                  </Link>
                </div>
              </article>
            )
          })}
        </div>

        {filtered.length === 0 && (
          <div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm font-bold text-slate-500">
            لا توجد برامج مطابقة. جرّب كلمة أخرى أو تصنيفاً مختلفاً.
          </div>
        )}
      </section>
    </main>
  )
}
