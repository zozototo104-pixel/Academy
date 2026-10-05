import type { Metadata } from 'next'
import Link from 'next/link'
import { AgentView } from '@/components/aact/AgentView'
import { PublicBackButton } from '@/components/aact/PublicBackButton'

export const metadata: Metadata = {
  title: 'الوكالة والاعتماد | AACT',
  description: 'صفحة الوكالة الدولية واعتماد الجهات والأفراد لدى الأكاديمية الأمريكية للاستشارات والتدريب.',
}

export default function AgentPage() {
  return (
    <main dir="rtl" className="min-h-screen bg-[#f6f0e3] text-[#0f2b46]">
      <header className="sticky top-0 z-40 border-b border-[#e0b83a]/20 bg-[#0f2b46]/95 text-[#f5f0e1] shadow-xl shadow-slate-900/10 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="flex items-center gap-3">
            <img src="/aact-logo.png" alt="شعار الأكاديمية الأمريكية للاستشارات والتدريب" className="h-11 w-11 shrink-0 object-contain" />
            <div>
              <p className="text-sm font-black leading-5">الأكاديمية الأمريكية</p>
              <p className="text-[11px] font-bold text-[#e0b83a]">للاستشارات والتدريب</p>
            </div>
          </Link>
          <nav className="hidden flex-wrap items-center gap-4 text-xs font-black md:flex">
            <Link href="/" className="hover:text-[#e0b83a]">الرئيسية</Link>
            <Link href="/programs" className="hover:text-[#e0b83a]">البرامج والخدمات</Link>
            <Link href="/accreditation" className="hover:text-[#e0b83a]">التراخيص والوثائق الرسمية</Link>
            <Link href="/verify" className="hover:text-[#e0b83a]">الشهادات والتحقق</Link>
            <Link href="/apply" className="hover:text-[#e0b83a]">طلب الالتحاق</Link>
            <Link href="/contact" className="hover:text-[#e0b83a]">تواصل معنا</Link>
          </nav>
          <PublicBackButton />
        </div>
      </header>
      <AgentView />
    </main>
  )
}
