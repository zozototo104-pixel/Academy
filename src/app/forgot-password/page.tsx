'use client'

import { useState, type FormEvent } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, Mail } from 'lucide-react'

export default function ForgotPasswordPage() {
  const { toast } = useToast()
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) })
      setDone(true)
      toast({ title: 'تحقق من بريدك', description: 'إذا كان البريد مسجلاً، ستصلك رسالة إعادة تعيين كلمة المرور.' })
    } catch (error: any) {
      toast({ title: 'تعذر إرسال الرابط', description: error.message || 'حاول مرة أخرى لاحقاً', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#111b33] px-4 py-16 text-white" dir="rtl">
      <form onSubmit={submit} className="mx-auto max-w-md rounded-[2rem] bg-white p-7 text-[#1d2947] shadow-2xl">
        <h1 className="text-2xl font-black">نسيت كلمة السر؟</h1>
        <p className="mt-3 text-sm font-bold leading-7 text-slate-500">أدخل بريدك الإلكتروني وسنرسل رابطاً صالحاً لمدة ساعة واحدة لإعادة تعيين كلمة المرور.</p>
        <div className="mt-6 space-y-2">
          <Label htmlFor="email" className="font-black"><Mail className="ml-1 inline h-4 w-4 text-[#bf1646]" /> البريد الإلكتروني</Label>
          <Input id="email" type="email" required dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} className="h-12 rounded-2xl border-slate-200 bg-slate-50 text-left font-bold" />
        </div>
        {done ? <p className="mt-4 rounded-2xl bg-emerald-50 p-3 text-sm font-bold text-emerald-700">تحقق من بريدك لإكمال إعادة التعيين.</p> : null}
        <Button disabled={loading} className="mt-6 h-12 w-full rounded-2xl bg-[#bf1646] text-base font-black text-white hover:bg-[#a61139]">
          {loading ? <Loader2 className="ml-2 h-5 w-5 animate-spin" /> : null}
          إرسال رابط إعادة التعيين
        </Button>
      </form>
    </main>
  )
}
