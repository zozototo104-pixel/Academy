'use client'

import { useState } from 'react'

type ExpandedRepresentative = {
  phone?: string | null
  email?: string | null
  whatsapp?: string | null
  website?: string | null
  shortBio?: string | null
  professionalBio?: string | null
  worksSummary?: string | null
  achievements?: string | null
  publicContactNote?: string | null
  files?: Array<{ id: string; kind: string; title: string; description?: string | null; externalUrl?: string | null; fileUrl?: string | null }>
}

function Detail({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-4">
      <p className="text-[11px] font-black text-slate-500">{label}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm font-bold leading-7 text-[#0f2b46]">{value}</p>
    </div>
  )
}

export default function ExpandedRepresentativeVerifier({ token }: { token: string }) {
  const [last4, setLast4] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<ExpandedRepresentative | null>(null)

  async function verify() {
    setError('')
    setLoading(true)
    try {
      const res = await fetch(`/api/representatives/verify/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ last4 }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'البيانات غير صحيحة')
      setExpanded(data.representative || null)
    } catch (error: any) {
      setExpanded(null)
      setError(String(error?.message || error || 'البيانات غير صحيحة'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="mt-8 rounded-[2rem] border border-[#0f2b46]/10 bg-slate-50 p-5">
      <h2 className="text-lg font-black text-[#0f2b46]">عرض بيانات إضافية</h2>
      <p className="mt-2 text-sm font-bold leading-7 text-slate-600">
        البيانات الموسّعة لا تظهر إلا بعد التحقق من آخر 4 أرقام من جوال الممثل المسجل لدى الأكاديمية.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <input
          value={last4}
          onChange={(event) => setLast4(event.target.value.replace(/\D+/g, '').slice(0, 4))}
          inputMode="numeric"
          maxLength={4}
          placeholder="آخر 4 أرقام"
          className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-center text-xl font-black tracking-[.35em] outline-none focus:border-[#c9a227]"
        />
        <button
          onClick={verify}
          disabled={loading || last4.length !== 4}
          className="rounded-2xl bg-[#0f2b46] px-6 py-3 text-sm font-black text-white disabled:opacity-50"
        >
          {loading ? 'جاري التحقق...' : 'تحقق'}
        </button>
      </div>
      {error && <div className="mt-3 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

      {expanded && (
        <div className="mt-5 space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Detail label="الجوال" value={expanded.phone} />
            <Detail label="واتساب" value={expanded.whatsapp} />
            <Detail label="البريد الإلكتروني" value={expanded.email} />
            <Detail label="الموقع" value={expanded.website} />
          </div>
          <Detail label="النبذة المختصرة" value={expanded.shortBio} />
          <Detail label="النبذة المهنية الكاملة" value={expanded.professionalBio} />
          <Detail label="الأعمال" value={expanded.worksSummary} />
          <Detail label="الإنجازات" value={expanded.achievements} />
          <Detail label="ملاحظة التواصل" value={expanded.publicContactNote} />

          <div className="rounded-2xl border border-slate-100 bg-white p-4">
            <p className="text-[11px] font-black text-slate-500">الملفات المعتمدة</p>
            {expanded.files?.length ? (
              <div className="mt-3 grid gap-3">
                {expanded.files.map((file) => (
                  <div key={file.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3">
                    <p className="text-sm font-black text-[#0f2b46]">{file.title}</p>
                    {file.description && <p className="mt-1 text-xs font-bold leading-6 text-slate-600">{file.description}</p>}
                    {(file.externalUrl || file.fileUrl) && (
                      <a href={file.externalUrl || file.fileUrl || '#'} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs font-black text-[#bf1646]">
                        فتح الملف المعتمد
                      </a>
                    )}
                  </div>
                ))}
              </div>
            ) : <p className="mt-2 text-sm font-bold text-slate-500">لا توجد ملفات معتمدة منشورة حالياً.</p>}
          </div>
        </div>
      )}
    </section>
  )
}
