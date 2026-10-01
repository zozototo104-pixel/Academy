'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'

export default function RepresentativeVerifyPage() {
  const params = useParams<{ token: string }>()
  const token = params?.token || ''
  const [last4, setLast4] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<any>(null)

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
      if (!res.ok) throw new Error(data.message || 'تعذر التحقق من البيانات.')
      setResult(data.representative)
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  const rep = result
  return (
    <main dir="rtl" className="min-h-screen bg-[#f4f7fb] px-4 py-10 text-[#0f2b46]">
      <section className="mx-auto max-w-4xl overflow-hidden rounded-[2rem] border border-[#0f2b46]/10 bg-white shadow-2xl shadow-slate-200/80">
        <div className="bg-[#0a1f36] px-6 py-8 text-white">
          <p className="text-xs font-black text-[#d2ad5a]">AACT Secure Representative ID</p>
          <h1 className="mt-2 text-3xl font-black">التحقق الآمن من كرنيه ممثل الأكاديمية</h1>
          <p className="mt-3 max-w-2xl text-sm font-bold leading-7 text-white/75">
            أدخل آخر 4 أرقام من جوال الممثل أو آخر 4 خانات من البريد الإلكتروني المسجل لدى الإدارة لعرض الكرنيه الرسمي.
          </p>
        </div>

        {!rep ? (
          <div className="space-y-5 p-6">
            <label className="block">
              <span className="text-sm font-black">آخر 4 أرقام / خانات</span>
              <input
                value={last4}
                onChange={(e) => setLast4(e.target.value.slice(0, 12))}
                inputMode="text"
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-center text-2xl font-black tracking-[.4em] outline-none focus:border-[#c9a227]"
                placeholder="••••"
              />
            </label>
            {error && <div className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}
            <button
              onClick={verify}
              disabled={loading || last4.trim().length < 4}
              className="w-full rounded-2xl bg-[#bf1646] px-6 py-4 text-sm font-black text-white shadow-lg shadow-[#bf1646]/20 disabled:opacity-50"
            >
              {loading ? 'جاري التحقق...' : 'تحقق واعرض الكرنيه'}
            </button>
          </div>
        ) : (
          <div className="p-6">
            <div className="mb-5 rounded-2xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm font-black text-emerald-800">
              تم التحقق بنجاح. هذه بطاقة ممثل الأكاديمية المسجلة رسمياً.
            </div>
            {rep.officialCardUrl ? (
              <div className="overflow-hidden rounded-[2rem] border border-[#c9a227]/30 bg-slate-100">
                <img src={rep.officialCardUrl} alt="الكرنيه الرسمي" className="mx-auto max-h-[80vh] w-full object-contain" />
              </div>
            ) : (
              <div className="relative overflow-hidden rounded-[2rem] border border-[#c9a227]/35 bg-gradient-to-br from-[#0a1f36] via-[#12365c] to-[#bf1646] p-8 text-white shadow-2xl">
                <div className="absolute left-6 top-6 rounded-full border border-[#c9a227]/50 px-4 py-1 text-xs font-black text-[#f4d77d]">AACT OFFICIAL REPRESENTATIVE</div>
                <div className="mt-16 grid gap-6 sm:grid-cols-[160px_1fr] sm:items-center">
                  <div className="flex aspect-square items-center justify-center overflow-hidden rounded-[2rem] border-4 border-[#c9a227] bg-white/10">
                    {rep.profilePhotoUrl ? <img src={rep.profilePhotoUrl} alt={rep.fullName} className="h-full w-full object-cover" /> : <span className="text-5xl font-black">AA</span>}
                  </div>
                  <div>
                    <h2 className="text-3xl font-black">{rep.fullName}</h2>
                    <p className="mt-2 text-sm font-black text-[#f4d77d]">{rep.displayTitle || 'ممثل الأكاديمية'}</p>
                    <p className="mt-1 text-sm font-bold text-white/75">{rep.academicRank || rep.degreeTitle}</p>
                    <div className="mt-4 grid gap-2 text-sm font-bold text-white/85">
                      <p>الدولة/النطاق: {rep.country} — {rep.region}</p>
                      {rep.territory && <p>المنطقة الجغرافية: {rep.territory}</p>}
                      {rep.specialization && <p>مجال التمثيل: {rep.specialization}</p>}
                    </div>
                  </div>
                </div>
                <div className="mt-8 rounded-2xl bg-white/10 p-4 text-xs font-bold leading-6 text-white/80">
                  هذه بطاقة تحقق رقمية مؤقتة مبنية من بيانات الممثل لأن الإدارة لم ترفع صورة الكرنيه الرسمي بعد.
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  )
}
