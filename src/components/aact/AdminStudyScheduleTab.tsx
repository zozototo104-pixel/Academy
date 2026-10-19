'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/store'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Loader2, Sparkles, Upload, Download, Plus, Save, Trash2, ArrowUp, ArrowDown, CheckCircle2 } from 'lucide-react'

type ProgramOption = { id: string; titleAr?: string; title?: string; titleEn?: string }
type StudyScheduleItem = {
  id: string
  programId: string
  semester: number
  week: number
  dayOffset?: number | null
  title: string
  description?: string | null
  type: 'READING' | 'UNIT' | 'STUDY_GUIDE' | 'ASSIGNMENT' | 'EXAM' | 'REVIEW'
  unitId?: string | null
  studyGuideId?: string | null
  assignmentId?: string | null
  examId?: string | null
  durationMin?: number | null
  order: number
  status: 'DRAFT' | 'PUBLISHED'
  source: 'AI' | 'MANUAL' | 'IMPORT'
}

type FormState = {
  id?: string
  week: string
  dayOffset: string
  title: string
  description: string
  type: StudyScheduleItem['type']
  durationMin: string
  order: string
}

const typeLabels: Record<StudyScheduleItem['type'], string> = {
  READING: 'قراءة',
  UNIT: 'وحدة',
  STUDY_GUIDE: 'دليل دراسة',
  ASSIGNMENT: 'واجب',
  EXAM: 'امتحان',
  REVIEW: 'مراجعة',
}

const emptyForm: FormState = {
  week: '1',
  dayOffset: '',
  title: '',
  description: '',
  type: 'READING',
  durationMin: '',
  order: '0',
}

function programLabel(program: ProgramOption) {
  return program.titleAr || program.title || program.titleEn || program.id
}

function asText(value: unknown) {
  return String(value ?? '').trim()
}

function groupByWeek(items: StudyScheduleItem[]) {
  return items.reduce<Record<number, StudyScheduleItem[]>>((acc, item) => {
    acc[item.week] = acc[item.week] || []
    acc[item.week].push(item)
    return acc
  }, {})
}

export default function AdminStudyScheduleTab() {
  const [programs, setPrograms] = useState<ProgramOption[]>([])
  const [programId, setProgramId] = useState('')
  const [semester, setSemester] = useState('1')
  const [items, setItems] = useState<StudyScheduleItem[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [csvText, setCsvText] = useState('')
  const [form, setForm] = useState<FormState>(emptyForm)

  const sortedItems = useMemo(() => [...items].sort((a, b) => a.semester - b.semester || a.week - b.week || (a.dayOffset || 0) - (b.dayOffset || 0) || a.order - b.order), [items])
  const weeks = useMemo(() => Object.entries(groupByWeek(sortedItems)).map(([week, weekItems]) => ({ week: Number(week), items: weekItems })).sort((a, b) => a.week - b.week), [sortedItems])

  const loadItems = useCallback(async () => {
    if (!programId) return
    setLoading(true)
    try {
      const data = await api<{ items: StudyScheduleItem[] }>(`/api/admin/study-schedule?programId=${encodeURIComponent(programId)}&semester=${encodeURIComponent(semester)}`)
      setItems(data.items || [])
    } catch (error: any) {
      toast({ title: 'تعذر تحميل جدول الدراسة', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [programId, semester, toast])

  useEffect(() => {
    let alive = true
    api<{ programs: ProgramOption[] }>('/api/programs?summary=1')
      .then((data) => {
        if (!alive) return
        const list = data.programs || []
        setPrograms(list)
        if (list[0]) setProgramId((current) => current || list[0].id)
      })
      .catch((error) => toast({ title: 'تعذر تحميل البرامج', description: String(error?.message || error), variant: 'destructive' }))
    return () => { alive = false }
  }, [toast])

  useEffect(() => {
    if (!programId) return
    const timer = window.setTimeout(() => { void loadItems() }, 0)
    return () => window.clearTimeout(timer)
  }, [programId, loadItems])

  function editItem(item: StudyScheduleItem) {
    setForm({
      id: item.id,
      week: String(item.week),
      dayOffset: item.dayOffset == null ? '' : String(item.dayOffset),
      title: item.title,
      description: item.description || '',
      type: item.type,
      durationMin: item.durationMin == null ? '' : String(item.durationMin),
      order: String(item.order || 0),
    })
  }

  async function saveItem() {
    if (!programId || !asText(form.title)) return
    setSaving(true)
    try {
      const payload = {
        ...(form.id ? { id: form.id } : { programId }),
        semester: Number(semester),
        week: Number(form.week || 1),
        dayOffset: form.dayOffset ? Number(form.dayOffset) : null,
        title: form.title,
        description: form.description || null,
        type: form.type,
        durationMin: form.durationMin ? Number(form.durationMin) : null,
        order: Number(form.order || 0),
        status: 'DRAFT',
        source: 'MANUAL',
      }
      await api('/api/admin/study-schedule', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(payload) })
      setForm(emptyForm)
      await loadItems()
      toast({ title: form.id ? 'تم تحديث عنصر الجدول' : 'تمت إضافة عنصر جديد' })
    } catch (error: any) {
      toast({ title: 'تعذر حفظ العنصر', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  async function deleteItem(id: string) {
    if (!confirm('حذف عنصر جدول الدراسة؟')) return
    try {
      await api(`/api/admin/study-schedule?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      await loadItems()
      toast({ title: 'تم حذف العنصر' })
    } catch (error: any) {
      toast({ title: 'تعذر حذف العنصر', description: String(error?.message || error), variant: 'destructive' })
    }
  }

  async function moveItem(item: StudyScheduleItem, delta: number) {
    try {
      await api('/api/admin/study-schedule', { method: 'PATCH', body: JSON.stringify({ id: item.id, order: Math.max(0, item.order + delta) }) })
      await loadItems()
    } catch (error: any) {
      toast({ title: 'تعذر تغيير الترتيب', description: String(error?.message || error), variant: 'destructive' })
    }
  }

  async function generateSchedule() {
    if (!programId) return
    setGenerating(true)
    try {
      const data = await api<{ generated: number; items: StudyScheduleItem[] }>('/api/admin/study-schedule/generate', { method: 'POST', body: JSON.stringify({ programId, semester: Number(semester) }) })
      setItems(data.items || [])
      toast({ title: 'تم توليد مسودة جدول الدراسة', description: `عدد العناصر الجديدة: ${data.generated || 0}` })
    } catch (error: any) {
      toast({ title: 'تعذر توليد جدول الدراسة', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setGenerating(false)
    }
  }

  async function publishSchedule() {
    if (!programId) return
    setPublishing(true)
    try {
      const data = await api<{ published: number }>('/api/admin/study-schedule/publish', { method: 'POST', body: JSON.stringify({ programId, semester: Number(semester) }) })
      await loadItems()
      toast({ title: 'تم نشر جدول الدراسة', description: `عدد العناصر المنشورة: ${data.published || 0}` })
    } catch (error: any) {
      toast({ title: 'تعذر نشر الجدول', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setPublishing(false)
    }
  }

  async function importCsv() {
    if (!programId || !csvText.trim()) return
    setImporting(true)
    try {
      const data = await api<{ imported: number }>(`/api/admin/study-schedule/import?programId=${encodeURIComponent(programId)}`, { method: 'POST', headers: { 'Content-Type': 'text/csv; charset=utf-8' }, body: csvText })
      setCsvText('')
      await loadItems()
      toast({ title: 'تم الاستيراد', description: `عدد العناصر: ${data.imported || 0}` })
    } catch (error: any) {
      toast({ title: 'تعذر الاستيراد', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setImporting(false)
    }
  }

  function openExport(action: 'template' | 'export') {
    const params = action === 'template'
      ? 'action=template'
      : `action=export&programId=${encodeURIComponent(programId)}&semester=${encodeURIComponent(semester)}`
    window.open(`/api/admin/study-schedule/import?${params}`, '_blank')
  }

  return (
    <div className="mt-4 space-y-4" dir="rtl">
      <Card className="border-[#0f2b46]/10">
        <CardContent className="space-y-4 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
            <div className="space-y-2">
              <Label className="text-xs font-black text-[#0f2b46]">البرنامج</Label>
              <Select value={programId} onValueChange={setProgramId}>
                <SelectTrigger className="h-11 rounded-2xl border-[#c9a227]/30 bg-white font-bold"><SelectValue placeholder="اختر البرنامج" /></SelectTrigger>
                <SelectContent>
                  {programs.map((program) => <SelectItem key={program.id} value={program.id}>{programLabel(program)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs font-black text-[#0f2b46]">الفصل</Label>
              <Select value={semester} onValueChange={setSemester}>
                <SelectTrigger className="h-11 rounded-2xl border-[#c9a227]/30 bg-white font-bold"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4].map((value) => <SelectItem key={value} value={String(value)}>الفصل {value}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-4">
            <Button onClick={generateSchedule} disabled={!programId || generating} className="rounded-2xl bg-[#0f2b46] font-black text-white hover:bg-[#183c5f]">
              {generating ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Sparkles className="ml-2 h-4 w-4" />}
              توليد بالذكاء
            </Button>
            <Button onClick={publishSchedule} disabled={!programId || publishing || items.length === 0} className="rounded-2xl bg-emerald-600 font-black text-white hover:bg-emerald-700">
              {publishing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}
              نشر
            </Button>
            <Button variant="outline" onClick={() => openExport('template')} className="rounded-2xl font-black"><Download className="ml-2 h-4 w-4" /> قالب CSV</Button>
            <Button variant="outline" onClick={() => openExport('export')} disabled={!programId} className="rounded-2xl font-black"><Download className="ml-2 h-4 w-4" /> تصدير</Button>
          </div>
        </CardContent>
      </Card>

      <Card className="border-[#0f2b46]/10">
        <CardContent className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_320px] sm:p-5">
          <div className="space-y-3">
            <h3 className="text-sm font-black text-[#0f2b46]">العناصر حسب الأسابيع</h3>
            {loading ? (
              <div className="flex h-36 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" /></div>
            ) : weeks.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 p-8 text-center text-sm font-bold text-slate-400">لا توجد عناصر لهذا الفصل بعد.</div>
            ) : (
              <div className="space-y-3">
                {weeks.map((week) => (
                  <div key={week.week} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                    <p className="mb-2 text-xs font-black text-[#0f2b46]">الأسبوع {week.week}</p>
                    <div className="space-y-2">
                      {week.items.map((item) => (
                        <div key={item.id} className="rounded-2xl border border-white bg-white p-3 shadow-sm">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge className="bg-[#0f2b46] text-white">{typeLabels[item.type]}</Badge>
                                <Badge variant="outline">{item.status === 'PUBLISHED' ? 'منشور' : 'مسودة'}</Badge>
                                <Badge variant="outline">{item.source}</Badge>
                              </div>
                              <p className="mt-2 font-black text-[#0f2b46]">{item.title}</p>
                              {item.description && <p className="mt-1 text-xs font-bold leading-6 text-slate-500">{item.description}</p>}
                              <p className="mt-1 text-[10px] font-bold text-slate-400">المدة: {item.durationMin || '—'} دقيقة · الترتيب: {item.order}</p>
                            </div>
                            <div className="grid grid-cols-4 gap-1 sm:w-40">
                              <Button size="icon" variant="outline" onClick={() => moveItem(item, -1)} className="h-9 w-9 rounded-xl"><ArrowUp className="h-4 w-4" /></Button>
                              <Button size="icon" variant="outline" onClick={() => moveItem(item, 1)} className="h-9 w-9 rounded-xl"><ArrowDown className="h-4 w-4" /></Button>
                              <Button size="icon" variant="outline" onClick={() => editItem(item)} className="h-9 w-9 rounded-xl"><Save className="h-4 w-4" /></Button>
                              <Button size="icon" variant="outline" onClick={() => deleteItem(item.id)} className="h-9 w-9 rounded-xl border-red-200 text-red-600"><Trash2 className="h-4 w-4" /></Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <div className="rounded-2xl border border-[#c9a227]/20 bg-[#fffaf0] p-4">
              <h3 className="mb-3 text-sm font-black text-[#0f2b46]">{form.id ? 'تعديل عنصر' : 'إضافة عنصر يدوي'}</h3>
              <div className="grid gap-3">
                <div className="grid grid-cols-2 gap-2">
                  <div><Label className="text-xs font-bold">الأسبوع</Label><Input value={form.week} onChange={(e) => setForm((f) => ({ ...f, week: e.target.value }))} className="rounded-2xl" /></div>
                  <div><Label className="text-xs font-bold">اليوم</Label><Input value={form.dayOffset} onChange={(e) => setForm((f) => ({ ...f, dayOffset: e.target.value }))} className="rounded-2xl" /></div>
                </div>
                <div><Label className="text-xs font-bold">العنوان</Label><Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} className="rounded-2xl" /></div>
                <div><Label className="text-xs font-bold">النوع</Label><Select value={form.type} onValueChange={(value) => setForm((f) => ({ ...f, type: value as StudyScheduleItem['type'] }))}><SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(typeLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
                <div><Label className="text-xs font-bold">الوصف</Label><Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} className="min-h-20 rounded-2xl" /></div>
                <div className="grid grid-cols-2 gap-2">
                  <div><Label className="text-xs font-bold">المدة</Label><Input value={form.durationMin} onChange={(e) => setForm((f) => ({ ...f, durationMin: e.target.value }))} className="rounded-2xl" /></div>
                  <div><Label className="text-xs font-bold">الترتيب</Label><Input value={form.order} onChange={(e) => setForm((f) => ({ ...f, order: e.target.value }))} className="rounded-2xl" /></div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Button onClick={saveItem} disabled={saving || !asText(form.title)} className="rounded-2xl bg-[#0f2b46] font-black text-white hover:bg-[#183c5f]">{saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Plus className="ml-2 h-4 w-4" />} حفظ</Button>
                  <Button variant="outline" onClick={() => setForm(emptyForm)} className="rounded-2xl font-black">إلغاء</Button>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-100 bg-white p-4">
              <h3 className="mb-3 text-sm font-black text-[#0f2b46]">استيراد CSV</h3>
              <Textarea value={csvText} onChange={(e) => setCsvText(e.target.value)} placeholder="semester,week,title,type,description,durationMin" className="min-h-28 rounded-2xl text-xs" />
              <Button onClick={importCsv} disabled={importing || !csvText.trim()} variant="outline" className="mt-3 w-full rounded-2xl font-black">
                {importing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Upload className="ml-2 h-4 w-4" />}
                استيراد
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
