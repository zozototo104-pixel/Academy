import type { Metadata } from 'next'
import Link from 'next/link'
import { Award, Building2, CheckCircle2, ExternalLink, FileCheck2, FileText, Mail, Phone, ShieldCheck } from 'lucide-react'
import { db } from '@/lib/db'
import { getOfficialContact, getSettings } from '@/lib/settings'

export const metadata: Metadata = {
  title: 'الاعتماد والتحقق | AACT',
  description: 'صفحة الاعتماد والتحقق الرسمية للأكاديمية الأمريكية للاستشارات والتدريب، مع روابط التحقق ودليل الجهات والبرامج المنشورة.',
}

type OfficialContact = {
  legalEntity?: string
  registrationNumber?: string
  address?: string
  email?: string
  phone?: string
  phones?: string[]
  whatsapp?: string
  whatsapps?: string[]
  responsiblePerson?: string
}

function contactList(primary?: unknown, list?: unknown): string[] {
  const values = [primary, ...(Array.isArray(list) ? list : [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  return Array.from(new Set(values))
}

function priceLabel(programPrice: number | null, settings: Record<string, string>, slug: string) {
  if (typeof programPrice === 'number' && Number.isFinite(programPrice)) return `${programPrice}$`
  if (slug.includes('center') || slug.includes('company')) return `${Number(settings.FEE_ACC_COMPANY || 0)}$`
  if (slug.includes('trainer')) return `${Number(settings.FEE_ACC_TRAINER || 0)}$`
  if (slug.includes('consult')) return `${Number(settings.FEE_ACC_CONSULTANT || 0)}$`
  return 'حسب نوع الاعتماد بعد المراجعة'
}

export default async function AccreditationPage() {
  const [contact, settings, programs] = await Promise.all([
    getOfficialContact().catch(() => ({} as OfficialContact)),
    getSettings().catch(() => ({} as Record<string, string>)),
    db.program.findMany({
      where: { active: true, category: 'ACCREDITATION' },
      orderBy: [{ order: 'asc' }, { titleAr: 'asc' }],
      select: { id: true, slug: true, titleAr: true, description: true, price: true, icon: true },
    }).catch(() => []),
  ])

  const phones = contactList((contact as OfficialContact).phone, (contact as OfficialContact).phones)
  const whatsapps = contactList((contact as OfficialContact).whatsapp, (contact as OfficialContact).whatsapps)
  const applicationFee = Number(settings.FEE_ACC_APPLICATION || 0)

  return (
    <main dir="rtl" className="min-h-screen bg-[#f6f0e3] text-[#0f2b46]">
      <section className="relative overflow-hidden bg-[#0f2b46] px-4 py-16 text-[#f5f0e1]">
        <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(circle at 20% 20%, #e0b83a 0, transparent 28%), radial-gradient(circle at 80% 0%, #ffffff 0, transparent 22%)' }} />
        <div className="relative mx-auto max-w-6xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#e0b83a]/30 bg-white/10 px-4 py-2 text-xs font-black text-[#e0b83a]">
            <ShieldCheck className="h-4 w-4" />
            صفحة الاعتماد والتحقق الرسمية
          </div>
          <h1 className="mt-5 max-w-3xl text-4xl font-black leading-tight md:text-5xl">
            الاعتماد المهني، التحقق من الشهادات، ودليل الجهات المعتمدة
          </h1>
          <p className="mt-5 max-w-3xl text-sm font-bold leading-8 text-[#f5f0e1]/75 md:text-base">
            هذه الصفحة تجمع روابط التحقق الرسمية وخيارات الاعتماد المنشورة في المنصة. لا تعرض الصفحة أي أرقام تراخيص أو شراكات غير مدخلة في إعدادات الأكاديمية أو بياناتها الرسمية.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/verify" className="rounded-2xl bg-[#e0b83a] px-5 py-3 text-sm font-black text-[#0f2b46] shadow-lg shadow-black/20">
              تحقق من شهادة
            </Link>
            <Link href="/representatives" className="rounded-2xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-black text-white hover:bg-white/15">
              دليل الممثلين والجهات
            </Link>
            <Link href="/programs" className="rounded-2xl border border-white/20 bg-white/10 px-5 py-3 text-sm font-black text-white hover:bg-white/15">
              برامج الاعتماد المنشورة
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-6 px-4 py-10 lg:grid-cols-3">
        <div className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-6 shadow-xl shadow-slate-200/70 lg:col-span-2">
          <div className="flex items-center gap-3">
            <span className="rounded-2xl bg-[#0f2b46] p-3 text-[#e0b83a]"><FileCheck2 className="h-6 w-6" /></span>
            <div>
              <p className="text-xs font-black text-[#c9a227]">ما الذي يمكن التحقق منه؟</p>
              <h2 className="text-2xl font-black text-[#0f2b46]">قنوات التحقق الرسمية</h2>
            </div>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {[
              { title: 'الشهادات', body: 'تحقق من الرقم التسلسلي أو رمز QR للشهادات الصادرة من المنصة.', href: '/verify' },
              { title: 'الدليل العام', body: 'استعرض الجهات أو الممثلين المنشورين رسمياً عند توفرهم.', href: '/representatives' },
              { title: 'البرامج المنشورة', body: 'أي اعتماد أو برنامج يظهر للزوار يجب أن يكون منشوراً من لوحة الإدارة.', href: '/programs' },
            ].map((item) => (
              <Link key={item.href} href={item.href} className="rounded-2xl border border-[#0f2b46]/10 bg-[#f8f5ed] p-4 transition hover:-translate-y-0.5 hover:border-[#c9a227]/40">
                <CheckCircle2 className="h-5 w-5 text-[#c9a227]" />
                <h3 className="mt-3 text-sm font-black text-[#0f2b46]">{item.title}</h3>
                <p className="mt-2 text-xs font-bold leading-6 text-slate-600">{item.body}</p>
              </Link>
            ))}
          </div>
        </div>

        <aside className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-6 shadow-xl shadow-slate-200/70">
          <div className="flex items-center gap-3">
            <span className="rounded-2xl bg-[#e0b83a]/20 p-3 text-[#a8841a]"><Building2 className="h-6 w-6" /></span>
            <h2 className="text-xl font-black text-[#0f2b46]">البيانات الرسمية</h2>
          </div>
          <div className="mt-5 space-y-3 text-xs font-bold leading-6 text-slate-600">
            <p><span className="font-black text-[#0f2b46]">الكيان:</span> {(contact as OfficialContact).legalEntity || 'غير مضبوط في الإعدادات'}</p>
            {(contact as OfficialContact).registrationNumber && <p><span className="font-black text-[#0f2b46]">رقم التسجيل:</span> {(contact as OfficialContact).registrationNumber}</p>}
            {(contact as OfficialContact).address && <p><span className="font-black text-[#0f2b46]">العنوان:</span> {(contact as OfficialContact).address}</p>}
            {(contact as OfficialContact).email && <p className="flex items-center gap-2"><Mail className="h-4 w-4 text-[#c9a227]" /> <span dir="ltr">{(contact as OfficialContact).email}</span></p>}
            {phones.length > 0 && <p className="flex items-center gap-2"><Phone className="h-4 w-4 text-[#c9a227]" /> <span dir="ltr">{phones.join(' / ')}</span></p>}
            {whatsapps.length > 0 && <p><span className="font-black text-[#0f2b46]">واتساب:</span> <span dir="ltr">{whatsapps.join(' / ')}</span></p>}
          </div>
        </aside>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-14">
        <div className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-6 shadow-xl shadow-slate-200/70">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-black text-[#c9a227]">طلبات الاعتماد</p>
              <h2 className="text-2xl font-black text-[#0f2b46]">خيارات الاعتماد المنشورة</h2>
              <p className="mt-2 text-sm font-bold leading-7 text-slate-600">
                رسوم تقديم طلب الاعتماد غير المستردة: <span className="font-black text-[#0f2b46]">{applicationFee}$</span>. السعر النهائي لكل نوع يظهر حسب البرنامج أو إعدادات الرسوم.
              </p>
            </div>
            <Link href="/apply" className="rounded-2xl bg-[#0f2b46] px-5 py-3 text-sm font-black text-[#f5f0e1]">
              تقديم طلب
            </Link>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {programs.length === 0 && (
              <div className="rounded-2xl border border-dashed border-[#0f2b46]/20 bg-[#f8f5ed] p-6 text-sm font-bold leading-7 text-slate-600 md:col-span-2">
                لا توجد برامج اعتماد منشورة حالياً. يمكن للإدارة نشر برامج الاعتماد من محرر قواعد القبول.
              </div>
            )}
            {programs.map((program) => (
              <Link key={program.id} href={`/programs/${program.slug}`} className="rounded-2xl border border-[#0f2b46]/10 bg-[#f8f5ed] p-5 transition hover:-translate-y-0.5 hover:border-[#c9a227]/50">
                <div className="flex items-start gap-3">
                  <span className="rounded-2xl bg-white p-3 text-[#c9a227]"><Award className="h-5 w-5" /></span>
                  <div>
                    <h3 className="text-lg font-black text-[#0f2b46]">{program.titleAr}</h3>
                    <p className="mt-2 line-clamp-3 text-xs font-bold leading-6 text-slate-600">{program.description || 'تفاصيل الاعتماد تضبط من قواعد القبول.'}</p>
                    <p className="mt-3 text-xs font-black text-[#a8841a]">الرسوم: {priceLabel(program.price, settings, program.slug)}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </main>
  )
}
