'use client'

import { useEffect } from 'react'

export function PrintControls({ autoPrint = false }: { autoPrint?: boolean }) {
  useEffect(() => {
    if (!autoPrint) return
    const t = window.setTimeout(() => window.print(), 450)
    return () => window.clearTimeout(t)
  }, [autoPrint])

  return (
    <div className="pdf-no-print fixed bottom-4 left-4 z-50 flex flex-wrap items-center gap-2" dir="rtl">
      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-2xl bg-[#0f2b46] px-5 py-3 text-sm font-black text-[#f5f0e1] shadow-lg transition hover:bg-[#17385c]"
      >
        طباعة / حفظ PDF
      </button>
      <button
        type="button"
        onClick={() => window.history.back()}
        className="rounded-2xl border border-[#c9a227] bg-white px-5 py-3 text-sm font-black text-[#a8841a] shadow-sm transition hover:bg-[#fff7dd]"
      >
        رجوع
      </button>
    </div>
  )
}
