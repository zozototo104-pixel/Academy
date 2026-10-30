'use client'

import { useCallback, useEffect, useState } from 'react'
import { Mail, X } from 'lucide-react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'

type MeInfo = {
  email: string
  notificationEmail: string | null
  pendingEmail: string | null
  pendingEmailPurpose: string | null
  authProvider: string
}

// Account email settings (owner decision 2026-10-30):
// - Password accounts may swap their LOGIN email (current password +
//   confirmation from the new mailbox; the old email works until then).
// - Google accounts keep their Gmail as the login identity and may set a
//   NOTIFICATION email — platform mail is delivered there instead, which
//   solves the full-mailbox problem without touching sign-in.
export default function AccountEmailDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast()
  const [me, setMe] = useState<MeInfo | null>(null)
  const [loginEmail, setLoginEmail] = useState('')
  const [password, setPassword] = useState('')
  const [notifEmail, setNotifEmail] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api<{ user: MeInfo | null }>('/api/auth/me')
      setMe(d.user)
    } catch {
      setMe(null)
    }
  }, [])

  // The parent mounts this component only while it is open, so a plain
  // mount effect (async fetch, state set from the promise) is enough.
  useEffect(() => {
    let live = true
    api<{ user: MeInfo | null }>('/api/auth/me')
      .then((d) => { if (live) setMe(d.user) })
      .catch(() => { if (live) setMe(null) })
    return () => { live = false }
  }, [])

  if (!open) return null

  const isGoogle = me?.authProvider === 'GOOGLE'

  const submit = async (purpose: 'LOGIN' | 'NOTIFICATION') => {
    const newEmail = (purpose === 'LOGIN' ? loginEmail : notifEmail).trim()
    if (!newEmail) return
    setBusy(purpose)
    try {
      await api('/api/auth/email-change', {
        method: 'POST',
        body: JSON.stringify({ newEmail, purpose, password: purpose === 'LOGIN' ? password : undefined }),
      })
      toast({ title: 'أرسلنا رابط التأكيد', description: `افتح بريد ${newEmail} واضغط رابط التأكيد لإتمام التغيير. لن يتغير أي شيء قبل التأكيد.` })
      setLoginEmail('')
      setPassword('')
      setNotifEmail('')
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر إرسال الطلب', description: e.message || 'حاول لاحقاً', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const cancelPending = async () => {
    setBusy('CANCEL')
    try {
      await api('/api/auth/email-change', { method: 'DELETE' })
      toast({ title: 'تم إلغاء الطلب', description: 'ألغي تغيير البريد المنتظر.' })
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر الإلغاء', description: e.message || 'حاول لاحقاً', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const inputCls = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-bold text-slate-700 outline-none focus:border-[#c9a227]'
  const btnCls = 'rounded-xl bg-[#0f2b46] px-4 py-2 text-xs font-black text-white transition hover:bg-[#12365c] disabled:opacity-50'

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" dir="rtl" role="dialog" aria-modal="true" aria-label="إعدادات البريد الإلكتروني">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-base font-black text-[#0f2b46]"><Mail className="h-5 w-5 text-[#a8841a]" /> إعدادات البريد الإلكتروني</h3>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="إغلاق"><X className="h-5 w-5" /></button>
        </div>

        {!me ? (
          <p className="py-6 text-center text-sm font-bold text-slate-500">جارٍ التحميل…</p>
        ) : (
          <div className="space-y-5 text-right">
            <div className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="text-[11px] font-black text-slate-400">بريد الدخول الحالي</p>
              <p className="truncate text-sm font-black text-[#0f2b46]" dir="ltr">{me.email}</p>
              {isGoogle && <p className="mt-1 text-[11px] font-bold text-slate-500">حساب Google — بريد الدخول يبقى كما هو، ويمكنك اعتماد بريد إشعارات جديد بالأسفل.</p>}
              <p className="mt-1 text-[11px] font-bold text-slate-500">بريد الإشعارات المعتمد: {me.notificationEmail || 'نفس بريد الدخول'}</p>
            </div>

            {me.pendingEmail && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-xs font-black text-amber-800">بانتظار التأكيد: أرسلنا رابطاً إلى {me.pendingEmail} ({me.pendingEmailPurpose === 'LOGIN' ? 'تغيير بريد الدخول' : 'بريد إشعارات'}). لن يسري التغيير قبل ضغط الرابط.</p>
                <button type="button" onClick={cancelPending} disabled={busy !== null} className="mt-2 rounded-lg border border-amber-300 px-3 py-1.5 text-[11px] font-black text-amber-800 hover:bg-amber-100 disabled:opacity-50">إلغاء الطلب</button>
              </div>
            )}

            {!isGoogle && (
              <div className="space-y-2">
                <p className="text-sm font-black text-[#0f2b46]">تغيير بريد الدخول</p>
                <p className="text-[11px] font-bold leading-5 text-slate-500">لأصحاب الحسابات المسجلة ببريد وكلمة مرور. سيصلك رابط تأكيد على البريد الجديد، ويبقى بريدك الحالي شغالاً حتى تأكد التغيير منه.</p>
                <input type="email" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="البريد الجديد" className={inputCls} dir="ltr" />
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="كلمة المرور الحالية" className={inputCls} dir="ltr" />
                <button type="button" onClick={() => submit('LOGIN')} disabled={busy !== null || !loginEmail.trim() || !password} className={btnCls}>{busy === 'LOGIN' ? 'جارٍ الإرسال…' : 'إرسال رابط تأكيد التغيير'}</button>
              </div>
            )}

            <div className="space-y-2 border-t border-slate-100 pt-4">
              <p className="text-sm font-black text-[#0f2b46]">بريد الإشعارات</p>
              <p className="text-[11px] font-bold leading-5 text-slate-500">إذا امتلأ بريد دخولك أو لم تعد تصلك الرسائل، اعتمد بريداً آخر لتصل إليه إشعارات المنصة (نتائج، مواعيد، تنبيهات) بدلاً من بريد الدخول — دون أي تغيير في طريقة دخولك.</p>
              <input type="email" value={notifEmail} onChange={(e) => setNotifEmail(e.target.value)} placeholder="بريد الإشعارات الجديد" className={inputCls} dir="ltr" />
              <button type="button" onClick={() => submit('NOTIFICATION')} disabled={busy !== null || !notifEmail.trim()} className={btnCls}>{busy === 'NOTIFICATION' ? 'جارٍ الإرسال…' : 'إرسال رابط تأكيد الإشعارات'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
