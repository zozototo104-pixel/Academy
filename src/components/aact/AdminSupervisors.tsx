'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Loader2, UserCheck, KeyRound, UserPlus, ShieldCheck, RefreshCcw } from 'lucide-react'
import { useAdminActionDialog } from './AdminActionDialog'

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
  const { confirmAction, dialog: actionDialog } = useAdminActionDialog()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [supervisors, setSupervisors] = useState<SupervisorRow[]>([])
  const [proposals, setProposals] = useState<any[]>([])
  const [proposalNotes, setProposalNotes] = useState<Record<string, string>>({})
  const [form, setForm] = useState({ name: '', email: '', password: '', phone: '', country: '' })
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const d = await api<{ supervisors: SupervisorRow[] }>('/api/admin/supervisors')
      setSupervisors(d.supervisors || [])
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message || 'تعذر تحميل المشرفين', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
    try {
      const p = await api<{ proposals: any[] }>('/api/admin/supervisor-proposals')
      setProposals(p.proposals || [])
    } catch { /* الاقتراحات ثانوية هنا */ }
  }

  const resolveProposal = async (id: string, status: 'APPROVED' | 'REJECTED') => {
    setSaving(true)
    try {
      await api('/api/admin/supervisor-proposals', { method: 'PATCH', body: JSON.stringify({ id, status, adminNote: proposalNotes[id] || '' }) })
      toast({ title: status === 'APPROVED' ? 'قُبل الاقتراح وأُشعر المشرف' : 'رُفض الاقتراح وأُشعر المشرف' })
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر البت في الاقتراح', description: e.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => { load() }, [])

  const createSupervisor = async () => {
    setSaving(true)
    try {
      await api('/api/admin/supervisors', { method: 'POST', body: JSON.stringify(form) })
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
      await api('/api/admin/supervisors', { method: 'PATCH', body: JSON.stringify({ action: 'reset-supervisor-password', id, password: newPassword }) })
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
    const supervisor = supervisors.find((item) => item.id === id)
    if (!(await confirmAction({ title: 'إلغاء صلاحية مشرف', description: `تأكيد إلغاء صلاحية المشرف ${supervisor?.name || ''}؟ لن يُسمح بذلك إذا كان لديه طلاب مرتبطون.`, confirmLabel: 'إلغاء الصلاحية', tone: 'danger' }))) return
    setSaving(true)
    try {
      await api('/api/admin/supervisors', { method: 'PATCH', body: JSON.stringify({ action: 'revoke-supervisor', id }) })
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
      <Card className="border-[#0f2b46]/10">
        <CardContent className="p-5">
          <h3 className="mb-1 text-lg font-black text-[#0f2b46]">اقتراحات المشرفين على الوحدات ({proposals.filter((p) => p.status === 'PENDING').length} بانتظار البت)</h3>
          <p className="mb-4 text-xs font-bold leading-6 text-slate-500">المشرف يقترح فقط — القبول لا ينفّذ التغيير تلقائيًا؛ نفّذ التعديل بنفسك في الكتب والوحدات إن قبلته. تعديلات المشرفين على الأسئلة نفسها مباشرة وتصلك إشعارات بها (سجل التدقيق).</p>
          {proposals.length === 0 ? (
            <div className="rounded-2xl bg-slate-50 p-6 text-center text-sm font-bold text-slate-500">لا اقتراحات بعد.</div>
          ) : (
            <div className="space-y-3">
              {proposals.map((p) => (
                <div key={p.id} className="space-y-2 rounded-2xl border border-slate-100 bg-white p-4 text-xs font-bold leading-6 text-slate-600 shadow-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-black text-[#0f2b46]">{p.title}</span>
                    <Badge variant="outline" className="text-[10px]">{p.kind === 'ADD' ? 'إضافة وحدة' : p.kind === 'EDIT' ? 'تعديل وحدة' : p.kind === 'REMOVE' ? 'حذف وحدة' : 'ملاحظة'}</Badge>
                    {p.status === 'PENDING' ? <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">بانتظار البت</Badge> : p.status === 'APPROVED' ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">مقبول</Badge> : <Badge className="bg-red-100 text-red-700 hover:bg-red-100">مرفوض</Badge>}
                  </div>
                  <p>{p.details}</p>
                  <p className="text-slate-400">من {p.supervisorName} — {p.programTitle}{p.unitTitle ? ` — الوحدة: ${p.unitTitle}` : ''}</p>
                  {p.status === 'PENDING' ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Input placeholder="ملاحظة للمشرف (اختياري)" value={proposalNotes[p.id] || ''} onChange={(e) => setProposalNotes((s) => ({ ...s, [p.id]: e.target.value }))} className="max-w-sm" />
                      <Button size="sm" disabled={saving} className="bg-emerald-600 font-bold hover:bg-emerald-700" onClick={() => void resolveProposal(p.id, 'APPROVED')}>قبول</Button>
                      <Button size="sm" disabled={saving} variant="outline" className="font-bold text-red-600" onClick={() => void resolveProposal(p.id, 'REJECTED')}>رفض</Button>
                    </div>
                  ) : p.adminNote ? (
                    <p className="text-slate-400">ملاحظة الإدارة: {p.adminNote}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      {actionDialog}
    </div>
  )
}
