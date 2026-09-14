'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Loader2, UserCheck, KeyRound, UserPlus, ShieldCheck, RefreshCcw } from 'lucide-react'

interface SupervisorRow {
  id: string
  name: string
  email: string
  phone?: string | null
  country?: string | null
  createdAt: string
  supervisedCount: number
}

export function AdminSupervisorsTab() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [supervisors, setSupervisors] = useState<SupervisorRow[]>([])
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '', country: '' })
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const d = await api<{ supervisors: SupervisorRow[] }>('/api/admin/students?role=supervisors')
      setSupervisors(d.supervisors || [])
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message || 'تعذر تحميل المشرفين', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const createSupervisor = async () => {
    setSaving(true)
    try {
      await api('/api/admin/students', { method: 'POST', body: JSON.stringify({ action: 'create-supervisor', ...form }) })
      toast({ title: 'تم إنشاء المشرف', description: 'يمكنه الآن الدخول من صفحة تسجيل الدخول بنفس البريد وكلمة المرور.' })
      setForm({ name: '', email: '', password: '', phone: '', country: '' })
      load()
    } catch (e: any) {
      toast({ title: 'تعذر إنشاء المشرف', description: e.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const resetPassword = async (id: string) => {
    setSaving(true)
    try {
      await api('/api/admin/students', { method: 'PATCH', body: JSON.stringify({ action: 'reset-supervisor-password', id, password: newPassword }) })
      toast({ title: 'تم تحديث كلمة المرور', description: 'أبلغ المشرف بكلمة المرور الجديدة بشكل آمن.' })
      setResetFor(null)
      setNewPassword('')
    } catch (e: any) {
      toast({ title: 'تعذر تحديث كلمة المرور', description: e.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const revoke = async (id: string) => {
    setSaving(true)
    try {
      await api('/api/admin/students', { method: 'PATCH', body: JSON.stringify({ action: 'revoke-supervisor', id }) })
      toast({ title: 'تم إلغاء صلاحية المشرف', description: 'تحول الحساب إلى طالب عادي.' })
      load()
    } catch (e: any) {
      toast({ title: 'تعذر إلغاء الصلاحية', description: e.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-5">
      <Card className="border-[#c9a227]/35 bg-gradient-to-br from-white to-[#fffaf0]">
        <CardContent className="p-5">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <Badge className="mb-2 bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]"><ShieldCheck className="ml-1 h-3.5 w-3.5" /> صلاحيات المشرفين</Badge>
              <h2 className="text-xl font-black text-[#0f2b46]">إنشاء وإدارة حسابات المشرفين البشريين</h2>
              <p className="mt-2 text-sm font-bold leading-7 text-slate-600">المشرف يدخل من نفس صفحة تسجيل الدخول، ويُحوّل تلقائياً إلى بوابة المشرف، ولا يرى إلا الطلاب الذين عينته الإدارة عليهم.</p>
            </div>
            <Button onClick={load} variant="outline" disabled={loading} className="font-bold"><RefreshCcw className="ml-2 h-4 w-4" /> تحديث</Button>
          </div>

          <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-white p-4 md:grid-cols-2 lg:grid-cols-5">
            <Input placeholder="اسم المشرف" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input placeholder="البريد الإلكتروني" type="email" dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Input placeholder="كلمة مرور مؤقتة" type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            <Input placeholder="الجوال" dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Input placeholder="الدولة" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
          </div>
          <Button onClick={createSupervisor} disabled={saving} className="mt-4 bg-[#c9a227] font-black text-[#0f2b46] hover:bg-[#e0b83a]">
            {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <UserPlus className="ml-2 h-4 w-4" />} إنشاء حساب مشرف
          </Button>
        </CardContent>
      </Card>

      <Card className="border-[#0f2b46]/10">
        <CardContent className="p-5">
          <h3 className="mb-4 text-lg font-black text-[#0f2b46]">المشرفون الحاليون ({supervisors.length})</h3>
          {loading ? (
            <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
          ) : supervisors.length === 0 ? (
            <div className="rounded-2xl bg-slate-50 p-6 text-center text-sm font-bold text-slate-500">لا يوجد مشرفون بشريون بعد.</div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {supervisors.map((s) => (
                <div key={s.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h4 className="font-black text-[#0f2b46]"><UserCheck className="ml-1 inline h-4 w-4 text-[#a8841a]" /> {s.name}</h4>
                      <p className="mt-1 text-xs font-bold text-slate-500" dir="ltr">{s.email}</p>
                      <p className="mt-1 text-xs font-bold text-slate-500">{s.country || '—'} {s.phone ? `— ${s.phone}` : ''}</p>
                    </div>
                    <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">{s.supervisedCount} طالب</Badge>
                  </div>

                  {resetFor === s.id ? (
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                      <Input placeholder="كلمة مرور جديدة" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                      <Button onClick={() => resetPassword(s.id)} disabled={saving} className="bg-[#0f2b46] font-bold text-[#f5f0e1]">حفظ</Button>
                      <Button onClick={() => { setResetFor(null); setNewPassword('') }} variant="outline">إلغاء</Button>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => setResetFor(s.id)} className="font-bold"><KeyRound className="ml-1 h-3.5 w-3.5" /> إعادة كلمة المرور</Button>
                      <Button size="sm" variant="outline" onClick={() => revoke(s.id)} disabled={saving || s.supervisedCount > 0} className="font-bold text-red-600">إلغاء الصلاحية</Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
