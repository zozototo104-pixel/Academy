'use client'

import { useState } from 'react'
import { Loader2, MailCheck, UserPlus } from 'lucide-react'

// إنشاء حساب زائر لمدعوّي الاجتماعات: حساب بلا أي حقوق أكاديمية،
// يُستخدم لاستلام دعوة الاجتماع والدخول. التحقق بالبريد إلزامي.
export default function VisitorRegisterPage() {
  const [form, setForm] = useState({ name: '', email: '', phone: '', password: '', website: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/auth/register-visitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-aact-register-form': 'web' },
        body: JSON.stringify(form),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || 'تعذر إنشاء الحساب')
      setDone(data?.message || 'تم إنشاء الحساب. أكّد بريدك من الرابط المرسل إليك.')
    } catch (err: any) {
      setError(err?.message || 'حدث خطأ')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#eef0f5] px-4 py-10" dir="rtl">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl">
        <div className="text-center">
          <div className="text-xl font-black text-[#0f2b46]">أكاديمية AACT</div>
          <h1 className="mt-3 flex items-center justify-center gap-2 text-lg font-black text-[#0f2b46]">
            <UserPlus className="h-5 w-5 text-[#c9a227]" />
            إنشاء حساب زائر
          </h1>
          <p className="mt-2 text-sm font-bold leading-7 text-slate-600">
            حساب الزائر مخصص لضيوف الاجتماعات فقط — لا يمنح أي حق أكاديمي ولا يحوّلك إلى طالب.
          </p>
        </div>

        {done ? (
          <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center">
            <MailCheck className="mx-auto mb-2 h-8 w-8 text-emerald-600" />
            <p className="text-sm font-bold leading-7 text-emerald-800">{done}</p>
            <a href="/" className="mt-4 inline-block rounded-xl bg-[#0f2b46] px-5 py-2.5 text-sm font-black text-[#f5f0e1]">
              الذهاب لتسجيل الدخول
            </a>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-3">
            <input
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="الاسم الكامل"
              className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-bold outline-none focus:border-[#c9a227]"
            />
            <input
              required
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="البريد الإلكتروني"
              className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-bold outline-none focus:border-[#c9a227]"
            />
            <input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="رقم الهاتف (اختياري)"
              className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-bold outline-none focus:border-[#c9a227]"
            />
            <input
              required
              type="password"
              minLength={6}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="كلمة المرور (6 أحرف على الأقل)"
              className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-bold outline-none focus:border-[#c9a227]"
            />
            <input
              tabIndex={-1}
              autoComplete="off"
              value={form.website}
              onChange={(e) => setForm({ ...form, website: e.target.value })}
              className="hidden"
              aria-hidden="true"
            />
            {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}
            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0f2b46] px-5 py-3 text-sm font-black text-[#f5f0e1] shadow hover:bg-[#12365c] disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              إنشاء الحساب
            </button>
            <p className="text-center text-xs font-bold leading-6 text-slate-500">
              لديك حساب أصلًا؟ سجّل الدخول من الصفحة الرئيسية ثم افتح رابط الدعوة.
            </p>
          </form>
        )}
      </div>
    </main>
  )
}
