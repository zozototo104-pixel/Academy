import type { Metadata } from 'next'
import Link from 'next/link'
import { ACADEMY_INFO } from '@/lib/academyData'

export const metadata: Metadata = {
  title: 'التحقق من الشهادات | الأكاديمية الأمريكية للاستشارات والتدريب',
  description: 'تحقق من صحة شهادات الأكاديمية الأمريكية للاستشارات والتدريب عبر الرقم التسلسلي أو رمز QR.',
  alternates: { canonical: '/verify' },
  robots: { index: true, follow: true },
}

export default function VerifyPage() {
  return (
    <main className="min-h-screen bg-[#0f1c35] text-white" dir="rtl">
      <div className="mx-auto max-w-4xl px-5 py-12 sm:px-8">
        <Link href="/" className="inline-flex rounded-full border border-[#c9a227]/40 px-4 py-2 text-sm font-black text-[#d8b45c] hover:bg-[#c9a227]/10">
          العودة إلى الرئيسية
        </Link>
        <section className="mt-8 rounded-[2rem] border border-[#c9a227]/25 bg-[#172743] p-7 shadow-2xl shadow-black/20">
          <p className="text-sm font-bold text-[#d8b45c]">{ACADEMY_INFO.nameAr}</p>
          <h1 className="mt-3 text-3xl font-black sm:text-5xl">التحقق من الشهادات</h1>
          <p className="mt-4 max-w-3xl text-sm font-semibold leading-8 text-white/68">
            استخدم صفحة التحقق الرسمية للتأكد من صحة الشهادة عبر الرقم التسلسلي أو رمز QR المنشور على الشهادة.
          </p>
        </section>
        <section className="mt-6 rounded-[1.75rem] border border-white/10 bg-white/[0.055] p-6 shadow-2xl shadow-black/10 backdrop-blur">
          <h2 className="text-xl font-black text-white">صفحة التحقق الرسمية</h2>
          <p className="mt-4 text-sm font-semibold leading-8 text-white/68">
            اضغط الزر التالي لفتح أداة التحقق التفاعلية داخل المنصة. لا تعتمد أي شهادة لا تظهر نتيجتها من الرابط الرسمي للأكاديمية.
          </p>
          <Link href="/?view=verify" className="mt-5 inline-flex rounded-full bg-[#c9a227] px-5 py-3 text-sm font-black text-[#0f1c35] hover:bg-[#d8b45c]">
            فتح أداة التحقق
          </Link>
          <div className="mt-6 rounded-2xl border border-[#c9a227]/20 bg-[#0f1c35]/70 p-4 text-xs font-bold leading-7 text-white/65">
            البريد الرسمي للاستفسار: <span dir="ltr">{ACADEMY_INFO.email}</span>
          </div>
        </section>
      </div>
    </main>
  )
}
