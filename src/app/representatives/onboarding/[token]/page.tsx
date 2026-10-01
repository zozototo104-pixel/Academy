'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Loader2, Upload, Sparkles, ExternalLink } from 'lucide-react'

export default function RepresentativeOnboardingPage() {
  const params = useParams<{ token: string }>()
  const token = params?.token || ''
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [rep, setRep] = useState<any>(null)
  const [form, setForm] = useState<any>({ degreeTitle: '', academicRank: '', city: '', specialization: '', rawBio: '', worksSummary: '', achievements: '', website: '', publicContactNote: '' })
  const [linkTitle, setLinkTitle] = useState('رابط أعمال')
  const [linkUrl, setLinkUrl] = useState('')

  async function load() {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/representatives/onboarding/${encodeURIComponent(token)}`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error('رابط الاستكمال غير صالح أو انتهى.')
      setRep(data.representative)
      setForm({
        degreeTitle: data.representative.degreeTitle || '',
        academicRank: data.representative.academicRank || '',
        city: data.representative.city || '',
        specialization: data.representative.specialization || '',
        rawBio: data.representative.rawBio || data.representative.professionalBio || '',
        worksSummary: data.representative.worksSummary || '',
        achievements: data.representative.achievements || '',
        website: data.representative.website || '',
        publicContactNote: data.representative.publicContactNote || '',
      })
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { if (token) load() }, [token])

  async function save(submit = false) {
    setSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/representatives/onboarding/${encodeURIComponent(token)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, submit }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'تعذر حفظ البيانات.')
      setRep(data.representative)
      if (submit) alert('تم إرسال ملفك للمراجعة. ستقوم الإدارة بمراجعته قبل ظهوره للعامة.')
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  async function upload(assetType: string, file?: File | null, extras?: Record<string, string>) {
    setUploading(true)
    setError('')
    try {
      const body = new FormData()
      body.set('assetType', assetType)
      for (const [k, v] of Object.entries(extras || {})) body.set(k, v)
      if (file) body.set('file', file)
      const res = await fetch(`/api/representatives/onboarding/${encodeURIComponent(token)}`, { method: 'POST', body })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'تعذر رفع الملف.')
      await load()
    } catch (e: any) {
      setError(String(e?.message || e))
    } finally {
      setUploading(false)
    }
  }

  if (loading) return <main dir="rtl" className="flex min-h-screen items-center justify-center bg-slate-50 text-[#0f2b46]"><Loader2 className="ml-3 h-7 w-7 animate-spin text-[#c9a227]" /> جاري فتح ملف الممثل...</main>
  if (error && !rep) return <main dir="rtl" className="min-h-screen bg-slate-50 p-8 text-center text-red-700"><h1 className="text-2xl font-black">{error}</h1></main>

  return (
    <main dir="rtl" className="min-h-screen bg-[#f4f7fb] px-4 py-8 text-[#0f2b46]">
      <section className="mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-white shadow-2xl shadow-slate-200/70">
        <div className="bg-[#0a1f36] p-7 text-white">
          <p className="text-xs font-black text-[#d2ad5a]">استكمال ملف ممثل الأكاديمية</p>
          <h1 className="mt-2 text-3xl font-black">{rep?.fullName}</h1>
          <p className="mt-2 text-sm font-bold text-white/75">{rep?.displayTitle} — {rep?.country}</p>
        </div>

        <div className="grid gap-6 p-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-5">
            {error && <div className="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm font-bold text-red-700">{error}</div>}
            <div className="grid gap-4 md:grid-cols-2">
              {[
                ['degreeTitle', 'الدرجة العلمية'],
                ['academicRank', 'الرتبة العلمية'],
                ['city', 'المدينة'],
                ['specialization', 'التخصص/مجال التمثيل'],
                ['website', 'الموقع أو رابط الأعمال'],
              ].map(([key, label]) => (
                <label key={key} className="block text-sm font-black">
                  {label}
                  <input value={form[key] || ''} onChange={(e) => setForm((p: any) => ({ ...p, [key]: e.target.value }))} className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 outline-none focus:border-[#c9a227]" />
                </label>
              ))}
            </div>
            <TextBlock label="السيرة الذاتية الخام" value={form.rawBio} onChange={(v) => setForm((p: any) => ({ ...p, rawBio: v }))} />
            <TextBlock label="ملخص الأعمال والخبرات" value={form.worksSummary} onChange={(v) => setForm((p: any) => ({ ...p, worksSummary: v }))} />
            <TextBlock label="الإنجازات" value={form.achievements} onChange={(v) => setForm((p: any) => ({ ...p, achievements: v }))} />
            <TextBlock label="ملاحظة التواصل العامة" value={form.publicContactNote} onChange={(v) => setForm((p: any) => ({ ...p, publicContactNote: v }))} />
            <div className="flex flex-wrap gap-3">
              <button onClick={() => save(false)} disabled={saving} className="rounded-2xl bg-[#0f2b46] px-6 py-3 text-sm font-black text-white disabled:opacity-60">{saving ? 'جاري الحفظ...' : 'حفظ مؤقت'}</button>
              <button onClick={() => save(true)} disabled={saving} className="rounded-2xl bg-[#bf1646] px-6 py-3 text-sm font-black text-white disabled:opacity-60"><Sparkles className="ml-2 inline h-4 w-4" /> إرسال للمراجعة وتشغيل الصياغة</button>
            </div>
          </div>

          <aside className="space-y-4">
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <h2 className="font-black">رفع المرفقات</h2>
              <UploadBox label="الصورة الشخصية" accept="image/*" onFile={(file) => upload('profilePhoto', file)} uploading={uploading} />
              <UploadBox label="الكرنيه الرسمي إن وجد" accept="image/*,.pdf" onFile={(file) => upload('officialCard', file)} uploading={uploading} />
              <UploadBox label="CV / كتب / أعمال" accept=".pdf,.doc,.docx,.txt,.jpg,.jpeg,.png" onFile={(file) => upload('file', file, { kind: 'CV', title: file.name })} uploading={uploading} />
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
              <h2 className="font-black">إضافة رابط أعمال</h2>
              <input value={linkTitle} onChange={(e) => setLinkTitle(e.target.value)} className="mt-3 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" placeholder="عنوان الرابط" />
              <input value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" placeholder="https://..." />
              <button disabled={!linkUrl.trim() || uploading} onClick={() => { upload('file', null, { kind: 'LINK', title: linkTitle, externalUrl: linkUrl }); setLinkUrl('') }} className="mt-3 w-full rounded-xl border border-[#0f2b46]/15 px-3 py-2 text-xs font-black"><ExternalLink className="ml-1 inline h-3 w-3" /> إضافة الرابط</button>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-white p-4">
              <h2 className="font-black">الملفات الحالية</h2>
              <div className="mt-3 space-y-2">
                {(rep?.files || []).map((file: any) => <p key={file.id} className="rounded-xl bg-slate-50 px-3 py-2 text-xs font-bold">{file.title}</p>)}
                {!rep?.files?.length && <p className="text-xs font-bold text-slate-400">لا توجد ملفات بعد.</p>}
              </div>
            </div>
            {rep?.onboardingStatus && <div className="rounded-2xl bg-amber-50 p-4 text-xs font-bold text-amber-800">حالة الملف: {rep.onboardingStatus}</div>}
          </aside>
        </div>
      </section>
    </main>
  )
}

function TextBlock({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label className="block text-sm font-black">{label}<textarea value={value || ''} onChange={(e) => onChange(e.target.value)} className="mt-2 min-h-32 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold leading-7 outline-none focus:border-[#c9a227]" /></label>
}

function UploadBox({ label, accept, onFile, uploading }: { label: string; accept: string; onFile: (file: File) => void; uploading: boolean }) {
  return <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white px-3 py-3 text-xs font-black hover:border-[#c9a227]"><input type="file" accept={accept} disabled={uploading} className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) onFile(file); e.currentTarget.value = '' }} /><Upload className="h-4 w-4" /> {label}</label>
}
