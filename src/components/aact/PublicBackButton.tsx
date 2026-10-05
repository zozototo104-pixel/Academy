'use client'

import { ArrowRight } from 'lucide-react'

export function PublicBackButton({ label = 'رجوع للخلف' }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        if (window.history.length > 1) window.history.back()
        else window.location.assign('/')
      }}
      className="inline-flex items-center gap-2 rounded-2xl border border-white/20 bg-white/10 px-4 py-2 text-xs font-black text-[#f5f0e1] transition hover:bg-white/15"
    >
      <ArrowRight className="h-4 w-4" />
      {label}
    </button>
  )
}
