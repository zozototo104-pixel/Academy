'use client'

import { useEffect, useState } from 'react'

type ReadyExam = {
  id: string
  programId: string
  programTitle: string
  title: string
  durationMin: number
  passScore: number
}

export default function ComprehensiveExamApplyPage() {
  const [exams, setExams] = useState<ReadyExam[]>([])
  const [loadingExams, setLoadingExams] = useState(true)
  const [programId, setProgramId] = useState('')
  const [fullName, setFullName] = useState('')
  const [nationalId, setNationalId] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [certificateFile, setCertificateFile] = useState<File | null>(null)
  const [idFile, setIdFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  useEffect(() => {
    fetch('/api/comprehensive-exams/ready')
      .then((r) => r.json())
      .then((d) => setExams(Array.isArray(d?.exams) ? d.exams : []))
      .catch(() => setExams([]))
      .finally(() => setLoadingExams(false))
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setDone('')
    if (!programId) return setError('اختر البرنامج أولاً')
    if (!certificateFile) return setError('أرفق ملف الشهادة الخارجية')
    if (!idFile) return setError('أرفق ملف الهوية')
    const form = new FormData()
    form.append('programId', programId)
    form.append('fullName', fullName)
    form.append('nationalId', nationalId)
    form.append('email', email)
    form.append('phone', phone)
    form.append('certificateFile', certificateFile)
    form.append('idDocumentFile', idFile)
    setSubmitting(true)
    try {
      const r = await fetch('/api/comprehensive-exams/apply', { method: 'POST', body: form })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d?.error || 'تعذر إرسال الطلب')
      setDone(d?.message || 'استلمنا طلبك')
    } catch (err: any) {
      setError(err?.message || 'تعذر إرسال الطلب')
    } finally {
      setSubmitting(false)
    }
  }

  const inputCls =
    'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-bold text-slate-900 outline-none focus:border-teal-600'

  return (
    <div dir="rtl" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-black text-slate-900">التقديم للامتحان الشامل لمعادلة مؤهل سابق</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">
        إن كنت تحمل مؤهلاً سابقاً من خارج الأكاديمية وتريد معادلته، قدّم طلبك هنا: نراجع شهادتك وهويتك، وعند
        الموافقة نرسل لك رابط الامتحان الشامل بالبريد وواتساب. الامتحان محاولة واحدة ومدته محددة، ونتيجته
        المعادلة تمنحك شهادة من الأكاديمية عند النجاح.
      </p>

      {done ? (
        <div className="mt-6 rounded-2xl border border-emerald-300 bg-emerald-50 p-5 text-sm font-bold leading-relaxed text-emerald-900">
          {done}
        </div>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-black text-slate-700">البرنامج *</span>
            <select value={programId} onChange={(e) => setProgramId(e.target.value)} className={inputCls} disabled={loadingExams}>
              <option value="">{loadingExams ? 'جاري تحميل البرامج…' : 'اختر البرنامج'}</option>
              {exams.map((ex) => (
                <option key={ex.programId} value={ex.programId}>
                  {ex.programTitle} — الامتحان {ex.durationMin} دقيقة، النجاح {ex.passScore}%
                </option>
              ))}
            </select>
            {!loadingExams && exams.length === 0 && (
              <span className="mt-1 block text-[11px] font-bold text-amber-700">لا يوجد برنامج له امتحان شامل منشور حالياً — تواصل مع الإدارة.</span>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-black text-slate-700">الاسم الكامل *</span>
            <input value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputCls} required minLength={3} />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-black text-slate-700">رقم الهوية / الرقم الوطني *</span>
              <input value={nationalId} onChange={(e) => setNationalId(e.target.value)} className={inputCls} required dir="ltr" />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-black text-slate-700">رقم الهاتف (واتساب) *</span>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} className={inputCls} required dir="ltr" placeholder="05xxxxxxxx" />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-xs font-black text-slate-700">البريد الإلكتروني *</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} required dir="ltr" />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-black text-slate-700">الشهادة الخارجية (صورة أو PDF، حتى 10MB) *</span>
            <input
              type="file"
              accept="image/*,.pdf"
              onChange={(e) => setCertificateFile(e.target.files?.[0] || null)}
              className="w-full text-sm font-bold text-slate-700"
            />
            {certificateFile && <span className="text-[11px] font-bold text-slate-500">{certificateFile.name}</span>}
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-black text-slate-700">الهوية (صورة أو PDF، حتى 10MB) *</span>
            <input
              type="file"
              accept="image/*,.pdf"
              onChange={(e) => setIdFile(e.target.files?.[0] || null)}
              className="w-full text-sm font-bold text-slate-700"
            />
            {idFile && <span className="text-[11px] font-bold text-slate-500">{idFile.name}</span>}
          </label>

          {error && <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-bold text-red-800">{error}</p>}

          <button
            type="submit"
            disabled={submitting || exams.length === 0}
            className="w-full rounded-xl bg-teal-700 px-4 py-3 text-sm font-black text-white disabled:opacity-50"
          >
            {submitting ? 'جاري الإرسال…' : 'إرسال الطلب'}
          </button>
          <p className="text-[11px] leading-relaxed text-slate-500">
            ملفاتك تُحفظ بشكل خاص ولا يطّلع عليها إلا الإدارة. بالتقديم أنت توافق على مراجعة الشهادة والهوية
            لهذا الغرض فقط.
          </p>
        </form>
      )}
    </div>
  )
}
