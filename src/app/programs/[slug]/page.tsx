import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { db } from '@/lib/db'
import { isGenericAllSpecializationsProgram } from '@/lib/program-tracks'
import { getServiceFlow } from '@/lib/service-flows'

export const revalidate = 300

const CATEGORY_LABEL: Record<string, string> = {
  DIPLOMA: 'دبلوم مهني',
  DOCTORATE: 'دكتوراه مهنية',
  MASTERS: 'ماجستير مهني',
  ACCREDITATION: 'اعتماد دولي',
  INTL_CERT: 'شهادة دولية',
  SERVICE: 'خدمة مهنية',
}

type ProgramDetail = NonNullable<Awaited<ReturnType<typeof getProgramBySlug>>>

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
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

function featureList(value?: string | null): string[] {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, 8).map(String) : []
  } catch {
    return []
  }
}

function shortDescription(value: string, max = 155) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

async function getProgramBySlug(slugParam: string) {
  const slug = safeDecode(slugParam).trim()
  if (!slug) return null

  const program = await db.program.findFirst({
    where: {
      active: true,
      OR: [{ slug }, { id: slug }],
    },
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
      semestersCount: true,
      academicReadinessStatus: true,
      registrationStatus: true,
      academicApproved: true,
      units: {
        orderBy: [{ semester: 'asc' }, { order: 'asc' }],
        select: { id: true, order: true, semester: true, title: true, summary: true, status: true },
      },
      books: {
        orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, title: true, titleEn: true, author: true, year: true, semester: true, description: true },
      },
      assignments: {
        where: { status: 'PUBLISHED' },
        orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, title: true, description: true, semester: true, type: true, points: true },
      },
      programExams: {
        orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }],
        select: { id: true, title: true, semester: true, status: true, durationMin: true, passScore: true, totalPoints: true, _count: { select: { questions: true } } },
      },
      microCredentials: {
        where: { active: true },
        take: 8,
        select: { id: true, titleAr: true, titleEn: true, skillArea: true, description: true },
      },
      _count: { select: { units: true, books: true, assignments: true, programExams: true } },
    },
  })

  if (!program || isGenericAllSpecializationsProgram(program) || isInternalQaProgram(program)) return null
  return program
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const program = await getProgramBySlug(slug)
  if (!program) {
    return { title: 'البرنامج غير موجود | AACT' }
  }
  return {
    title: `${program.titleAr} | AACT`,
    description: shortDescription(program.description),
    alternates: { canonical: `/programs/${program.slug}` },
    openGraph: {
      title: program.titleAr,
      description: shortDescription(program.description),
      type: 'article',
      url: `/programs/${program.slug}`,
    },
  }
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-[#0f2b46]/10 bg-white p-4 shadow-sm">
      <p className="text-[11px] font-black text-slate-500">{label}</p>
      <p className="mt-2 text-xl font-black text-[#0f2b46]">{value}</p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[#0f2b46]/10 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-black text-[#0f2b46]">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function applyHref(program: ProgramDetail) {
  return `/apply?program=${encodeURIComponent(program.titleAr)}`
}

export default async function ProgramDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const program = await getProgramBySlug(slug)
  if (!program) notFound()

  const flow = getServiceFlow(program.slug)
  const serviceLike = flow ? !flow.isStudyProgram : program.category === 'SERVICE'
  const features = flow?.highlights?.length ? flow.highlights : featureList(program.features)
  const description = flow?.summary || program.description
  const categoryLabel = flow?.kicker || CATEGORY_LABEL[program.category] || program.category
  const groupedUnits = program.units.reduce<Record<string, typeof program.units>>((acc, unit) => {
    const key = `الفصل ${unit.semester || 1}`
    acc[key] = acc[key] || []
    acc[key].push(unit)
    return acc
  }, {})

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: program.titleAr,
    description: shortDescription(description, 500),
    provider: {
      '@type': 'Organization',
      name: 'الأكاديمية الأمريكية للاستشارات والتدريب',
      sameAs: 'https://aactacademy.com',
    },
    offers: program.price != null ? {
      '@type': 'Offer',
      price: program.price,
      priceCurrency: 'USD',
      availability: program.registrationStatus === 'OPEN' ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
    } : undefined,
  }

  return (
    <main className="min-h-screen bg-[#f7f4ed] text-[#0f2b46]">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <header className="border-b border-[#0f2b46]/10 bg-white/90">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4">
          <Link href="/programs" className="text-sm font-black text-[#0f2b46]">كل البرامج والخدمات</Link>
          <nav className="flex flex-wrap gap-3 text-xs font-bold text-slate-600">
            <Link href="/" className="hover:text-[#c9a227]">الرئيسية</Link>
            <Link href="/programs" className="hover:text-[#c9a227]">البرامج</Link>
            <Link href="/apply" className="hover:text-[#c9a227]">طلب الالتحاق</Link>
            <Link href="/verify" className="hover:text-[#c9a227]">التحقق من الشهادات</Link>
          </nav>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-4 py-10">
        <div className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-6 shadow-sm sm:p-8">
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full bg-[#0f2b46] px-3 py-1.5 text-xs font-black text-[#e0b83a]">{categoryLabel}</span>
            {program.price != null && <span className="rounded-full bg-[#c9a227]/15 px-3 py-1.5 text-xs font-black text-[#8a6d12]">{program.price}$</span>}
            {program.hours != null && <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600">{program.hours} ساعة</span>}
            <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600">
              {program.registrationStatus === 'OPEN' ? 'التسجيل مفتوح' : 'التسجيل مغلق'}
            </span>
          </div>
          <h1 className="mt-5 text-3xl font-black leading-tight sm:text-4xl">{program.titleAr}</h1>
          {program.titleEn && <p className="mt-2 text-sm font-bold text-[#a8841a]" dir="ltr">{program.titleEn}</p>}
          <p className="mt-5 max-w-5xl text-sm leading-8 text-slate-600">{description}</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Link href={applyHref(program)} className="inline-flex items-center justify-center rounded-xl bg-[#c9a227] px-6 py-3 text-sm font-black text-[#0f2b46] hover:bg-[#e0b83a]">
              {serviceLike ? 'اطلب الخدمة الآن' : 'قدّم طلب الالتحاق'}
            </Link>
            <Link href="/programs" className="inline-flex items-center justify-center rounded-xl border border-[#0f2b46]/15 px-6 py-3 text-sm font-black text-[#0f2b46] hover:bg-[#0f2b46]/5">
              العودة إلى البرامج
            </Link>
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="التصنيف" value={categoryLabel} />
          <StatCard label="عدد الوحدات" value={program._count.units || 'حسب الخطة'} />
          <StatCard label="الكتب والمراجع" value={program._count.books || 'تحدد لاحقاً'} />
          <StatCard label="الاختبارات" value={program._count.programExams || 'حسب البرنامج'} />
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <div className="space-y-6">
            {features.length > 0 && (
              <Section title="ماذا يميز هذا المسار؟">
                <ul className="grid gap-3 sm:grid-cols-2">
                  {features.map((feature, index) => (
                    <li key={index} className="rounded-xl bg-[#f7f4ed] p-4 text-sm font-bold leading-7 text-slate-700">
                      {feature}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {Object.keys(groupedUnits).length > 0 && (
              <Section title="الخطة الدراسية والوحدات">
                <div className="space-y-5">
                  {Object.entries(groupedUnits).map(([semester, units]) => (
                    <div key={semester}>
                      <h3 className="mb-3 text-sm font-black text-[#a8841a]">{semester}</h3>
                      <div className="space-y-3">
                        {units.map((unit) => (
                          <div key={unit.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                            <p className="text-sm font-black text-[#0f2b46]">{unit.order}. {unit.title}</p>
                            {unit.summary && <p className="mt-2 text-xs leading-6 text-slate-600">{unit.summary}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {program.books.length > 0 && (
              <Section title="الكتب والمراجع المعتمدة">
                <div className="space-y-3">
                  {program.books.slice(0, 8).map((book) => (
                    <div key={book.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm font-black text-[#0f2b46]">{book.title}</p>
                      {book.titleEn && <p className="mt-1 text-xs font-bold text-slate-500" dir="ltr">{book.titleEn}</p>}
                      <p className="mt-2 text-xs font-bold text-slate-500">
                        {[book.author, book.year, book.semester ? `الفصل ${book.semester}` : null].filter(Boolean).join(' · ')}
                      </p>
                      {book.description && <p className="mt-2 text-xs leading-6 text-slate-600">{book.description}</p>}
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>

          <aside className="space-y-6">
            <Section title="التقييم والاختبارات">
              {program.programExams.length > 0 ? (
                <div className="space-y-3">
                  {program.programExams.slice(0, 6).map((exam) => (
                    <div key={exam.id} className="rounded-xl bg-[#f7f4ed] p-4 text-xs font-bold leading-6 text-slate-700">
                      <p className="text-sm font-black text-[#0f2b46]">{exam.title}</p>
                      <p className="mt-1">الفصل {exam.semester} · {exam._count.questions} سؤال · درجة النجاح {exam.passScore}%</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm leading-7 text-slate-600">تُعلن الاختبارات حسب جاهزية الخطة الأكاديمية واعتماد الإدارة.</p>
              )}
            </Section>

            <Section title="الواجبات والتكليفات">
              {program.assignments.length > 0 ? (
                <div className="space-y-3">
                  {program.assignments.slice(0, 6).map((assignment) => (
                    <div key={assignment.id} className="rounded-xl bg-[#f7f4ed] p-4 text-xs font-bold leading-6 text-slate-700">
                      <p className="text-sm font-black text-[#0f2b46]">{assignment.title}</p>
                      <p className="mt-1">الفصل {assignment.semester} · {assignment.points} نقاط · {assignment.type}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm leading-7 text-slate-600">تظهر التكليفات للطالب داخل بوابته عند تفعيل البرنامج.</p>
              )}
            </Section>

            {program.microCredentials.length > 0 && (
              <Section title="مهارات مصغّرة مرتبطة">
                <div className="space-y-3">
                  {program.microCredentials.map((item) => (
                    <div key={item.id} className="rounded-xl bg-[#f7f4ed] p-4 text-xs font-bold leading-6 text-slate-700">
                      <p className="text-sm font-black text-[#0f2b46]">{item.titleAr}</p>
                      {item.titleEn && <p className="mt-1 text-slate-500" dir="ltr">{item.titleEn}</p>}
                      <p className="mt-2">{item.description}</p>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <div className="rounded-2xl border border-[#c9a227]/30 bg-[#fffaf0] p-6 shadow-sm">
              <h2 className="text-lg font-black text-[#0f2b46]">جاهز للبدء؟</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                قدّم طلبك الآن، وسيتم إصدار فاتورة رسوم التقديم أو الخدمة حسب نوع المسار، ثم تتابع حالتك من بوابة الطالب.
              </p>
              <Link href={applyHref(program)} className="mt-5 inline-flex w-full items-center justify-center rounded-xl bg-[#0f2b46] px-5 py-3 text-sm font-black text-[#f5f0e1] hover:bg-[#12365c]">
                {serviceLike ? 'طلب الخدمة' : 'طلب الالتحاق'}
              </Link>
            </div>
          </aside>
        </div>
      </section>
    </main>
  )
}
