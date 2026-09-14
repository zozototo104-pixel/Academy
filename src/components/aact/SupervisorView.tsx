'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Loader2, Users2, GraduationCap, FileText, Video, RefreshCcw } from 'lucide-react'

interface SupervisedAdmission {
  reference: string
  fullName: string
  email?: string
  phone?: string
  program: string
  status: string
  statusLabel?: string
  thesisDeadline?: string | null
  createdAt?: string
  documents?: { id: string; docType: string; fileName: string; size: number }[]
  theses?: { id: string; title: string; status: string; createdAt: string; updatedAt: string }[]
}

export function SupervisorView() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [students, setStudents] = useState<SupervisedAdmission[]>([])

  const load = async () => {
    setLoading(true)
    try {
      const d = await api<{ applications: SupervisedAdmission[] }>('/api/admissions?mine=1')
      setStudents(d.applications || [])
    } catch (e: any) {
      toast({ title: 'تعذر تحميل طلابك', description: e.message || 'حاول مرة أخرى', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="aact-fade-in mx-auto max-w-6xl px-4 py-10">
      <div className="mb-6 rounded-3xl border border-[#c9a227]/40 bg-[#0f2b46] p-6 text-[#f5f0e1] shadow">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Badge className="mb-2 bg-[#c9a227] text-[#0f2b46] hover:bg-[#c9a227]">بوابة المشرف البشري</Badge>
            <h1 className="text-2xl font-black">متابعة الطلاب المعيّنين لك</h1>
            <p className="mt-2 text-sm font-bold leading-7 text-[#d7e0ea]">تظهر هنا فقط طلبات وطلاب البحث الذين قامت الإدارة بتعيينك مشرفاً عليهم.</p>
          </div>
          <Button onClick={load} variant="outline" className="border-[#e0b83a] bg-transparent font-black text-[#e0b83a] hover:bg-white/10">
            {loading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCcw className="ml-2 h-4 w-4" />} تحديث
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardContent className="p-4 text-center"><Users2 className="mx-auto mb-2 h-6 w-6 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{students.length}</p><p className="text-xs font-bold text-slate-500">طلاب تحت الإشراف</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><FileText className="mx-auto mb-2 h-6 w-6 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{students.reduce((s, x) => s + (x.theses?.length || 0), 0)}</p><p className="text-xs font-bold text-slate-500">أبحاث تخرج</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><GraduationCap className="mx-auto mb-2 h-6 w-6 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{students.filter((s) => ['THESIS', 'SCHEDULED', 'RESULT_APPROVED', 'CERTIFIED'].includes(s.status)).length}</p><p className="text-xs font-bold text-slate-500">قيد الدراسة/البحث</p></CardContent></Card>
      </div>

      {loading ? (
        <div className="flex h-52 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
      ) : students.length === 0 ? (
        <Card className="mt-6 border-dashed"><CardContent className="p-8 text-center text-sm font-bold leading-7 text-slate-500">لا يوجد طلاب معيّنون لك حالياً. التعيين يتم من لوحة الإدارة عند اعتماد الطالب أو من ملف الطلب.</CardContent></Card>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          {students.map((s) => (
            <Card key={s.reference} className="border-[#0f2b46]/10 shadow-sm">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-lg font-black text-[#0f2b46]">{s.fullName}</CardTitle>
                    <p className="mt-1 text-xs font-bold text-slate-500">{s.program}</p>
                  </div>
                  <Badge className="bg-[#f7edd0] text-[#0f2b46] hover:bg-[#f7edd0]">{s.statusLabel || s.status}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 p-5 pt-2">
                <div className="rounded-2xl bg-slate-50 p-3 text-xs font-bold leading-6 text-slate-600">
                  <p><b className="text-[#0f2b46]">كود الطالب:</b> <span dir="ltr">{s.reference}</span></p>
                  {s.email && <p><b className="text-[#0f2b46]">البريد:</b> {s.email}</p>}
                  {s.phone && <p><b className="text-[#0f2b46]">الهاتف:</b> {s.phone}</p>}
                  <p><b className="text-[#0f2b46]">مهلة البحث:</b> {s.thesisDeadline ? new Date(s.thesisDeadline).toLocaleDateString('ar-EG') : 'غير محددة'}</p>
                </div>

                <div className="rounded-2xl border border-[#c9a227]/25 bg-[#fffaf0] p-3">
                  <h3 className="mb-2 text-sm font-black text-[#0f2b46]">أبحاث الطالب</h3>
                  {s.theses?.length ? s.theses.map((t) => (
                    <div key={t.id} className="rounded-xl bg-white p-3 text-xs font-bold leading-6 text-slate-600 ring-1 ring-[#c9a227]/15">
                      <p className="font-black text-[#0f2b46]">{t.title}</p>
                      <p>الحالة: {t.status} — آخر تحديث: {new Date(t.updatedAt).toLocaleDateString('ar-EG')}</p>
                    </div>
                  )) : <p className="text-xs font-bold text-slate-500">لم يرفع الطالب بحث تخرج بعد.</p>}
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button disabled variant="outline" className="font-bold"><FileText className="ml-2 h-4 w-4" /> مراجعة الملف قريباً</Button>
                  <Button disabled variant="outline" className="font-bold"><Video className="ml-2 h-4 w-4" /> المناقشة عند الجدولة</Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
