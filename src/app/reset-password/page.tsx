'use client'

import { useState, type FormEvent } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, LockKeyhole } from 'lucide-react'

export default function ResetPasswordPage() {
  const { toast } = useToast()
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const token = new URLSearchParams(window.location.search).get('token') || ''
    setLoading(true)
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) })
      setDone(true)
      toast({ title: 'تم تحديث كلمة المرور', description: 'يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.' })
    } catch (error: any) {
      toast({ title: 'تعذر تحديث كلمة المرور', description: error.message || 'الرابط غير صالح أو منتهي', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#111b33] px-4 py-16 text-white" dir="rtl">
      <form onSubmit={submit} className="mx-auto max-w-md rounded-[2rem] bg-white p-7 text-[#1d2947] shadow-2xl">
        <h1 className="text-2xl font-black">إعادة تعيين كلمة المرور</h1>
        <p className="mt-3 text-sm font-bold leading-7 text-slate-500">اختر كلمة مرور جديدة. بعد الحفظ سيتم إبطال الجلسات القديمة ويجب تسجيل الدخول من جديد.</p>
        <div className="mt-6 space-y-2">
          <Label htmlFor="password" className="font-black"><LockKeyhole className="ml-1 inline h-4 w-4 text-[#bf1646]" /> كلمة المرور الجديدة</Label>
          <Input id="password" type="password" required minLength={6} dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} className="h-12 rounded-2xl border-slate-200 bg-slate-50 text-left font-bold" />
        </div>
        {done ? <p className="mt-4 rounded-2xl bg-emerald-50 p-3 text-sm font-bold text-emerald-700">تم تحديث كلمة المرور. يمكنك العودة لتسجيل الدخول.</p> : null}
        <Button disabled={loading || done} className="mt-6 h-12 w-full rounded-2xl bg-[#bf1646] text-base font-black text-white hover:bg-[#a61139]">
          {loading ? <Loader2 className="ml-2 h-5 w-5 animate-spin" /> : null}
          تحديث كلمة المرور
        </Button>
      </form>
    </main>
  )
}
