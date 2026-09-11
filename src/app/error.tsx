'use client'

import { useEffect } from 'react'

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('AACT client error boundary:', error)
  }, [error])

  return (
    <main dir="rtl" className="min-h-screen bg-[#f5f0e1] px-4 py-10 font-cairo text-[#0f2b46]">
      <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center text-center">
        <div className="rounded-3xl border border-red-100 bg-white p-6 shadow-lg">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-50 text-2xl font-black text-red-600">!</div>
          <h1 className="text-xl font-black">حدث خطأ مؤقت في عرض الصفحة</h1>
          <p className="mt-3 text-sm font-bold leading-7 text-slate-600">
            لم يتم فقدان بياناتك. جرّب إعادة تحميل هذا الجزء، وإذا تكرر الخطأ افتح الصفحة من جديد.
          </p>
          {error?.digest && <p className="mt-3 rounded-xl bg-slate-50 p-2 font-mono text-[11px] text-slate-400" dir="ltr">{error.digest}</p>}
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <button onClick={() => reset()} className="rounded-xl bg-[#0f2b46] px-4 py-3 text-sm font-black text-[#f5f0e1] shadow hover:bg-[#12365c]">إعادة المحاولة</button>
            <button onClick={() => { window.location.href = '/' }} className="rounded-xl border border-[#c9a227]/50 bg-white px-4 py-3 text-sm font-black text-[#a8841a] hover:bg-[#fff7df]">العودة للرئيسية</button>
          </div>
        </div>
      </div>
    </main>
  )
}
