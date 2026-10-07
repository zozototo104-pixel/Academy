import type { Metadata } from 'next'
import Link from 'next/link'
import { ACADEMY_INFO } from '@/lib/academyData'

export const metadata: Metadata = {
  title: 'تواصل معنا | الأكاديمية الأمريكية للاستشارات والتدريب',
  description: 'بيانات التواصل الرسمية للأكاديمية الأمريكية للاستشارات والتدريب AACT.',
  alternates: { canonical: '/contact' },
  robots: { index: true, follow: true },
}

export default function ContactPage() {
  return (
    <main className="min-h-screen bg-[#0f1c35] text-white" dir="rtl">
      <div className="mx-auto max-w-4xl px-5 py-12 sm:px-8">
        <Link href="/" className="inline-flex rounded-full border border-[#c9a227]/40 px-4 py-2 text-sm font-black text-[#d8b45c] hover:bg-[#c9a227]/10">
          العودة إلى الرئيسية
        </Link>
        <section className="mt-8 rounded-[2rem] border border-[#c9a227]/25 bg-[#172743] p-7 shadow-2xl shadow-black/20">
          <p className="text-sm font-bold text-[#d8b45c]">{ACADEMY_INFO.nameAr}</p>
          <h1 className="mt-3 text-3xl font-black sm:text-5xl">تواصل معنا</h1>
          <p className="mt-4 max-w-3xl text-sm font-semibold leading-8 text-white/68">
            هذه هي بيانات التواصل الرسمية المعتمدة للأكاديمية الأمريكية للاستشارات والتدريب.
          </p>
        </section>
        <section className="mt-6 grid gap-4 rounded-[1.75rem] border border-white/10 bg-white/[0.055] p-6 shadow-2xl shadow-black/10 backdrop-blur">
          <div>
            <div className="text-xs font-black uppercase tracking-[0.2em] text-[#d8b45c]">Email</div>
            <a dir="ltr" className="mt-2 inline-block text-xl font-black text-white underline decoration-[#c9a227]/60" href={`mailto:${ACADEMY_INFO.email}`}>
              {ACADEMY_INFO.email}
            </a>
          </div>
          <div>
            <div className="text-xs font-black uppercase tracking-[0.2em] text-[#d8b45c]">WhatsApp</div>
            <a dir="ltr" className="mt-2 inline-block text-xl font-black text-white underline decoration-[#c9a227]/60" href={ACADEMY_INFO.whatsappUrl}>
              {ACADEMY_INFO.whatsappDisplay}
            </a>
          </div>
          <div>
            <div className="text-xs font-black uppercase tracking-[0.2em] text-[#d8b45c]">Address</div>
            <p className="mt-2 text-sm font-bold leading-8 text-white/70">{ACADEMY_INFO.address}</p>
          </div>
          <div className="pt-3">
            <Link href="/?view=contact" className="inline-flex rounded-full bg-[#c9a227] px-5 py-3 text-sm font-black text-[#0f1c35] hover:bg-[#d8b45c]">
              فتح صفحة التواصل التفاعلية
            </Link>
          </div>
        </section>
      </div>
    </main>
  )
}
