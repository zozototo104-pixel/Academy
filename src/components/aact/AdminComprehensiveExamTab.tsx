'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { toast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Check, Download, FileSpreadsheet, Loader2, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react'

type ProgramOption = { id: string; titleAr: string; titleEn?: string | null; slug?: string | null; active?: boolean | null; category?: string | null; serviceKind?: string | null }
type ExamCounts = { approved: number; pending: number; rejected: number }
type ExamListItem = {
  id: string; programId: string; programTitleAr: string; programCategory: string
  specializationProgramId?: string | null; specializationTitleAr?: string | null; specializationTitleEn?: string | null; specializationCategory?: string | null
  categoryLabel: string; specialtyLabel: string
  level: string; title: string; status: string; passScore: number; durationMin: number; totalPoints: number
  publishedAt?: string | null; counts: ExamCounts
}
type ExamQuestion = {
  id: string; order: number; type: string; text: string; options: string | null; correctAnswer: string | null
  source: string; sourceBookId?: string | null; sourceEvidence?: string | null; sourceUrl?: string | null; bankItemId?: string | null
  status: string; rejectedReason?: string | null
}
type BankItem = { id: string; type: string; text: string; options: string | null; correctAnswer: string | null; sourceBookTitle?: string | null }

const STATUS_LABEL: Record<string, string> = { DRAFT: 'مسودة', READY: 'منشور', ARCHIVED: 'مؤرشف', PENDING_REVIEW: 'بانتظار المراجعة', APPROVED: 'معتمد', REJECTED: 'مرفوض' }
const SOURCE_LABEL: Record<string, string> = { BANK: 'بنك الأسئلة', MANUAL: 'يدوي', EXCEL_IMPORT: 'استيراد Excel', DOC_IMPORT: 'استيراد مستند', AI_INTERNET: 'ذكاء من الإنترنت', CUSTOM_BOOK: 'كتاب مخصص' }

function apiErrorMessage(data: any, fallback: string) {
  return String(data?.error || data?.message || fallback)
}

async function jsonOrThrow(res: Response, fallback: string) {
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(apiErrorMessage(data, fallback))
  return data
}

function parseOptions(raw: string | null): string[] {
  try {
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

export function AdminComprehensiveExamTab() {
  const [programs, setPrograms] = useState<ProgramOption[]>([])
  const [exams, setExams] = useState<ExamListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ exam: ExamListItem; counts: ExamCounts; questions: ExamQuestion[] } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [programId, setProgramId] = useState('')
  const [specializationProgramId, setSpecializationProgramId] = useState('')
  const [passScore, setPassScore] = useState('60')
  const [durationMin, setDurationMin] = useState('120')
  const [creating, setCreating] = useState(false)
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [bankItems, setBankItems] = useState<BankItem[]>([])
  const [bankLoading, setBankLoading] = useState(false)
  const [bankSelected, setBankSelected] = useState<Record<string, boolean>>({})
  const [importFile, setImportFile] = useState<File | null>(null)
  const [importPreview, setImportPreview] = useState<any>(null)
  const [importing, setImporting] = useState(false)
  const [customBookFile, setCustomBookFile] = useState<File | null>(null)
  const [customBookCount, setCustomBookCount] = useState('5')
  const [customBookResult, setCustomBookResult] = useState<any>(null)
  const [customBookBusy, setCustomBookBusy] = useState(false)
  const [internetTopic, setInternetTopic] = useState('')
  const [internetCount, setInternetCount] = useState('5')
  const [internetResult, setInternetResult] = useState<any>(null)
  const [internetBusy, setInternetBusy] = useState(false)
  const [internetKeyMissing, setInternetKeyMissing] = useState(false)
  const [manualType, setManualType] = useState('MCQ')
  const [manualText, setManualText] = useState('')
  const [manualOptions, setManualOptions] = useState(['', '', '', ''])
  const [manualAnswer, setManualAnswer] = useState('0')
  const [manualEvidence, setManualEvidence] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [editOptions, setEditOptions] = useState<string[]>([])
  const [editAnswer, setEditAnswer] = useState('0')
  const [rejectReason, setRejectReason] = useState('')

  const loadExams = async () => {
    const data = await jsonOrThrow(await fetch('/api/admin/comprehensive-exams', { cache: 'no-store' }), 'تعذر تحميل الامتحانات الشاملة')
    setExams(data.exams || [])
  }

  const loadAll = async (withSpinner = true) => {
    if (withSpinner) setLoading(true)
    try {
      const [progData] = await Promise.all([
        jsonOrThrow(await fetch('/api/admin/program-catalog?lite=1', { cache: 'no-store' }), 'تعذر تحميل البرامج'),
        loadExams(),
      ])
      setPrograms((progData.programs || []).filter((p: ProgramOption) => p.active !== false))
      // برنامج المعادلة هو برنامج خدمة المعادلة من بيانات المنصة
      // (نوع مساره CERTIFICATE_EQUIVALENCY) — ثابت لإنشاء الامتحانات.
      const equivalency = (progData.programs || []).find((p: ProgramOption) => p.serviceKind === 'CERTIFICATE_EQUIVALENCY')
      if (equivalency) setProgramId(equivalency.id)
    } catch (e: any) {
      toast({ title: 'تعذر التحميل', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const loadDetail = async (examId: string) => {
    setDetailLoading(true)
    try {
      const data = await jsonOrThrow(await fetch(`/api/admin/comprehensive-exams/${examId}`, { cache: 'no-store' }), 'تعذر تحميل الامتحان')
      setDetail({ exam: data.exam, counts: data.counts, questions: data.questions })
      setSelectedId(examId)
    } catch (e: any) {
      toast({ title: 'تعذر تحميل الامتحان', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setDetailLoading(false)
    }
  }

  useEffect(() => {
    // Initial load: state updates happen only after the awaits below,
    // never synchronously inside the effect body.
    let cancelled = false
    ;(async () => {
      try {
        const progData = await jsonOrThrow(await fetch('/api/admin/program-catalog?lite=1', { cache: 'no-store' }), 'تعذر تحميل البرامج')
        const examsData = await jsonOrThrow(await fetch('/api/admin/comprehensive-exams', { cache: 'no-store' }), 'تعذر تحميل الامتحانات الشاملة')
        if (cancelled) return
        setPrograms((progData.programs || []).filter((p: ProgramOption) => p.active !== false))
        const equivalency = (progData.programs || []).find((p: ProgramOption) => p.serviceKind === 'CERTIFICATE_EQUIVALENCY')
        if (equivalency) setProgramId(equivalency.id)
        setExams(examsData.exams || [])
      } catch (e: any) {
        if (!cancelled) toast({ title: 'تعذر التحميل', description: e.message || 'حدث خطأ', variant: 'destructive' })
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const selectedProgram = useMemo(() => programs.find((p) => p.id === programId), [programs, programId])
  const filteredQuestions = useMemo(() => {
    if (!detail) return []
    return statusFilter === 'ALL' ? detail.questions : detail.questions.filter((q) => q.status === statusFilter)
  }, [detail, statusFilter])

  const refreshDetailAndList = async (examId: string) => {
    await Promise.all([loadDetail(examId), loadExams()])
  }

  const createExam = async () => {
    if (!programId) {
      toast({ title: 'برنامج المعادلة غير موجود — أنشئ برنامج خدمة المعادلة أولاً', variant: 'destructive' })
      return
    }
    if (!specializationProgramId) {
      toast({ title: 'اختر التخصص أولاً', variant: 'destructive' })
      return
    }
    setCreating(true)
    try {
      const data = await jsonOrThrow(
        await fetch('/api/admin/comprehensive-exams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ programId, specializationProgramId, passScore: Number(passScore) || 60, durationMin: Number(durationMin) || 120 }),
        }),
        'تعذر إنشاء الامتحان',
      )
      toast({ title: 'تم إنشاء مسودة الامتحان الشامل', description: 'أضف الأسئلة من المصادر أدناه ثم راجعها قبل النشر' })
      await loadExams()
      await loadDetail(data.examId)
    } catch (e: any) {
      toast({ title: 'تعذر إنشاء الامتحان', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setCreating(false)
    }
  }

  const publishExam = async (action: 'publish' | 'unpublish' | 'archive') => {
    if (!detail) return
    if (action === 'archive' && !window.confirm('أرشفة الامتحان نهائياً؟ تبقى نتائجه وسجلاته، ويمكن بعدها إنشاء نسخة جديدة للتخصص.')) return
    try {
      const data = await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        }),
        'تعذر تنفيذ الإجراء',
      )
      toast({ title: action === 'publish' ? 'تم نشر الامتحان الشامل — 100 سؤال معتمد' : action === 'archive' ? 'تمت أرشفة الامتحان مع الاحتفاظ بنتائجه' : 'تم إلغاء النشر — عاد الامتحان مسودة' })
      await refreshDetailAndList(detail.exam.id)
    } catch (e: any) {
      toast({ title: 'تعذر النشر', description: e.message || 'حدث خطأ', variant: 'destructive' })
    }
  }

  const saveSettings = async () => {
    if (!detail) return
    try {
      await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ passScore: Number(passScore) || detail.exam.passScore, durationMin: Number(durationMin) || detail.exam.durationMin }),
        }),
        'تعذر حفظ الإعدادات',
      )
      toast({ title: 'تم حفظ إعدادات الامتحان' })
      await refreshDetailAndList(detail.exam.id)
    } catch (e: any) {
      toast({ title: 'تعذر حفظ الإعدادات', description: e.message || 'حدث خطأ', variant: 'destructive' })
    }
  }

  const loadBankItems = async () => {
    if (!detail) return
    setBankLoading(true)
    try {
      const data = await jsonOrThrow(
        await fetch(`/api/admin/question-bank?programId=${encodeURIComponent(detail.exam.specializationProgramId || detail.exam.programId)}&status=APPROVED`, { cache: 'no-store' }),
        'تعذر تحميل بنك الأسئلة',
      )
      setBankItems((data.items || []).filter((it: BankItem) => it.type === 'MCQ' || it.type === 'TF'))
    } catch (e: any) {
      toast({ title: 'تعذر تحميل بنك الأسئلة', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setBankLoading(false)
    }
  }

  const importFromBank = async () => {
    if (!detail) return
    const ids = Object.keys(bankSelected).filter((id) => bankSelected[id])
    if (!ids.length) {
      toast({ title: 'اختر سؤالاً واحداً على الأقل من بنك الأسئلة', variant: 'destructive' })
      return
    }
    try {
      const data = await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions/from-bank`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bankItemIds: ids }),
        }),
        'تعذر الاستيراد من بنك الأسئلة',
      )
      toast({ title: `تم استيراد ${data.imported} سؤالاً معتمداً من بنك الأسئلة` })
      setBankSelected({})
      await refreshDetailAndList(detail.exam.id)
    } catch (e: any) {
      toast({ title: 'تعذر الاستيراد من بنك الأسئلة', description: e.message || 'حدث خطأ', variant: 'destructive' })
    }
  }

  const addManualQuestion = async () => {
    if (!detail) return
    try {
      await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: manualType,
            text: manualText,
            options: manualType === 'TF' ? ['صح', 'خطأ'] : manualOptions.filter((o) => o.trim() !== ''),
            correctAnswer: manualAnswer,
            correctAnswerIndexBase: 0,
            sourceEvidence: manualEvidence || undefined,
          }),
        }),
        'تعذر إضافة السؤال',
      )
      toast({ title: 'تمت إضافة السؤال — بانتظار المراجعة' })
      setManualText('')
      setManualOptions(['', '', '', ''])
      setManualAnswer('0')
      setManualEvidence('')
      await refreshDetailAndList(detail.exam.id)
    } catch (e: any) {
      toast({ title: 'تعذر إضافة السؤال', description: e.message || 'حدث خطأ', variant: 'destructive' })
    }
  }

  const runImport = async (dryRun: boolean) => {
    if (!detail || !importFile) return
    setImporting(true)
    try {
      const fd = new FormData()
      fd.append('file', importFile)
      const data = await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions/import?dryRun=${dryRun ? 'true' : 'false'}`, { method: 'POST', body: fd }),
        'تعذر استيراد الملف',
      )
      if (dryRun) {
        setImportPreview(data)
        toast({ title: `المعاينة: ${data.valid} سؤالاً صالحاً، ${data.errors?.length || 0} صفاً مرفوضاً` })
      } else {
        setImportPreview(null)
        setImportFile(null)
        toast({ title: `تم استيراد ${data.imported} سؤالاً — كلها بانتظار المراجعة`, description: data.errors?.length ? `${data.errors.length} صفاً مرفوضاً — راجع التفاصيل` : undefined })
        await refreshDetailAndList(detail.exam.id)
      }
    } catch (e: any) {
      toast({ title: 'تعذر استيراد الملف', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setImporting(false)
    }
  }

  const runCustomBook = async () => {
    if (!detail || !customBookFile) return
    setCustomBookBusy(true)
    try {
      const fd = new FormData()
      fd.append('file', customBookFile)
      fd.append('count', customBookCount)
      const data = await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions/from-custom-book`, { method: 'POST', body: fd }),
        'تعذر توليد الأسئلة من الكتاب',
      )
      setCustomBookResult(data)
      toast({
        title: `تم توليد ${data.imported} سؤالاً من الكتاب — كلها بانتظار المراجعة`,
        description: data.rejectedCount ? `${data.rejectedCount} سؤالاً مرفوضاً بالتحقق بالدليل` : undefined,
      })
      await refreshDetailAndList(detail.exam.id)
    } catch (e: any) {
      toast({ title: 'تعذر توليد الأسئلة من الكتاب', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setCustomBookBusy(false)
    }
  }

  const runInternet = async () => {
    if (!detail || !internetTopic.trim()) return
    setInternetBusy(true)
    setInternetKeyMissing(false)
    try {
      // The response is parsed here (not via jsonOrThrow) so the
      // TAVILY_KEY_MISSING code survives and the tab can show the
      // settings hint instead of a bare error toast.
      const res = await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions/from-internet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: internetTopic.trim(), count: internetCount }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data?.code === 'TAVILY_KEY_MISSING') setInternetKeyMissing(true)
        throw new Error(apiErrorMessage(data, 'تعذر توليد الأسئلة من الإنترنت'))
      }
      setInternetResult(data)
      toast({
        title: `تم توليد ${data.imported} سؤالاً من بحث الإنترنت — كلها بانتظار المراجعة`,
        description: data.rejectedCount ? `${data.rejectedCount} سؤالاً مرفوضاً بالتحقق بالدليل` : undefined,
      })
      await refreshDetailAndList(detail.exam.id)
    } catch (e: any) {
      toast({ title: 'تعذر توليد الأسئلة من الإنترنت', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setInternetBusy(false)
    }
  }

  const reviewQuestion = async (q: ExamQuestion, status: 'APPROVED' | 'REJECTED') => {
    if (!detail) return
    if (status === 'REJECTED' && !rejectReason.trim()) {
      toast({ title: 'رفض السؤال يتطلب سبباً — اكتبه في حقل السبب أولاً', variant: 'destructive' })
      return
    }
    try {
      await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions/${q.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(status === 'REJECTED' ? { status, rejectedReason: rejectReason } : { status }),
        }),
        'تعذر مراجعة السؤال',
      )
      toast({ title: status === 'APPROVED' ? 'تم اعتماد السؤال' : 'تم رفض السؤال' })
      setRejectReason('')
      await refreshDetailAndList(detail.exam.id)
    } catch (e: any) {
      toast({ title: 'تعذر مراجعة السؤال', description: e.message || 'حدث خطأ', variant: 'destructive' })
    }
  }

  const saveEdit = async (q: ExamQuestion) => {
    if (!detail) return
    try {
      await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions/${q.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: editText,
            options: q.type === 'TF' ? ['صح', 'خطأ'] : editOptions.filter((o) => o.trim() !== ''),
            correctAnswer: editAnswer,
            correctAnswerIndexBase: 0,
          }),
        }),
        'تعذر حفظ التعديل',
      )
      toast({ title: 'تم حفظ التعديل — عاد السؤال لانتظار المراجعة إن كان معتمداً' })
      setEditingId(null)
      await refreshDetailAndList(detail.exam.id)
    } catch (e: any) {
      toast({ title: 'تعذر حفظ التعديل', description: e.message || 'حدث خطأ', variant: 'destructive' })
    }
  }

  const deleteQuestion = async (q: ExamQuestion) => {
    if (!detail || !window.confirm('حذف هذا السؤال من المسودة؟')) return
    try {
      await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions/${q.id}`, { method: 'DELETE' }),
        'تعذر حذف السؤال',
      )
      toast({ title: 'تم حذف السؤال' })
      await refreshDetailAndList(detail.exam.id)
    } catch (e: any) {
      toast({ title: 'تعذر حذف السؤال', description: e.message || 'حدث خطأ', variant: 'destructive' })
    }
  }

  const startEdit = (q: ExamQuestion) => {
    setEditingId(q.id)
    setEditText(q.text)
    setEditOptions(q.type === 'TF' ? ['صح', 'خطأ'] : parseOptions(q.options))
    setEditAnswer(q.correctAnswer || '0')
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-10 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> جارٍ تحميل الامتحانات الشاملة…
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div>
            <h3 className="text-base font-black">تجهيز امتحان شامل لاجتياز البرنامج</h3>
            <p className="text-xs text-slate-500">
              امتحان من 100 سؤال (صح/خطأ واختيار متعدد فقط — لا مقالي) لخريج درس التخصص في مؤسسة أخرى. يُنشر فقط عند اكتمال 100 سؤال معتمد،
              والنجاح فيه يؤهل صاحبه كخريج في ذلك التخصص. الامتحان يعيش على برنامج خدمة المعادلة فقط — برامج الدراسة العادية لا يظهر عليها الامتحان أبداً.
              مصدر «الذكاء من الإنترنت» يبحث في الويب عبر Tavily (مفتاح مجاني يُحفظ في إعدادات النظام) ويولّد أسئلة بدليل حرفي ورابط مصدر لكل سؤال.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_120px_140px_auto]">
            <div className="space-y-1">
              <Label>برنامج المعادلة</Label>
              <div className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-bold text-slate-900">
                {selectedProgram ? selectedProgram.titleAr : 'لم يُنشأ برنامج المعادلة بعد — أنشئ برنامج خدمة المعادلة أولاً'}
              </div>
            </div>
            <div className="space-y-1">
              <Label>التخصص</Label>
              <Select value={specializationProgramId} onValueChange={setSpecializationProgramId}>
                <SelectTrigger><SelectValue placeholder="اختر التخصص" /></SelectTrigger>
                <SelectContent>
                  {programs
                    .filter((p) => p.id !== programId && p.category !== 'SERVICE')
                    .map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.titleAr} — {p.category || ''}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>علامة النجاح %</Label>
              <Input type="number" min={1} max={100} value={passScore} onChange={(e: ChangeEvent<HTMLInputElement>) => setPassScore(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>المدة (دقيقة)</Label>
              <Input type="number" min={10} max={480} value={durationMin} onChange={(e: ChangeEvent<HTMLInputElement>) => setDurationMin(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button onClick={createExam} disabled={creating || !programId || !specializationProgramId}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} إنشاء المسودة
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-black">الامتحانات الشاملة ({exams.length})</h4>
            <Button variant="outline" size="sm" onClick={() => loadAll()}><RefreshCw className="h-3.5 w-3.5" /> تحديث</Button>
          </div>
          {exams.length === 0 && <p className="text-xs text-slate-500">لا توجد امتحانات شاملة بعد — أنشئ أول مسودة من الأعلى.</p>}
          <div className="space-y-2">
            {exams.map((exam) => (
              <button
                key={exam.id}
                type="button"
                onClick={() => loadDetail(exam.id)}
                className={`w-full rounded-lg border p-3 text-right ${selectedId === exam.id ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200'}`}
              >
                <span className="flex flex-wrap items-center gap-2 text-sm font-bold">
                  {exam.title}
                  <Badge variant={exam.status === 'READY' ? 'default' : 'secondary'}>{STATUS_LABEL[exam.status] || exam.status}</Badge>
                  <span className="text-xs font-normal text-slate-500">{exam.categoryLabel} — {exam.specialtyLabel}</span>
                </span>
                <span className="mt-1 block text-xs text-slate-500">
                  معتمد {exam.counts.approved} / 100 — بانتظار {exam.counts.pending} — مرفوض {exam.counts.rejected} — نجاح {exam.passScore}% — {exam.durationMin} دقيقة
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {detailLoading && (
        <Card><CardContent className="flex items-center gap-2 py-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> جارٍ تحميل الامتحان…</CardContent></Card>
      )}

      {detail && !detailLoading && (
        <DetailPanel
          detail={detail}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
          filteredQuestions={filteredQuestions}
          passScore={passScore}
          setPassScore={setPassScore}
          durationMin={durationMin}
          setDurationMin={setDurationMin}
          onSaveSettings={saveSettings}
          onPublish={publishExam}
          bankItems={bankItems}
          bankLoading={bankLoading}
          bankSelected={bankSelected}
          setBankSelected={setBankSelected}
          onLoadBank={loadBankItems}
          onImportFromBank={importFromBank}
          importFile={importFile}
          setImportFile={setImportFile}
          importPreview={importPreview}
          importing={importing}
          onRunImport={runImport}
          customBookFile={customBookFile}
          setCustomBookFile={setCustomBookFile}
          customBookCount={customBookCount}
          setCustomBookCount={setCustomBookCount}
          customBookResult={customBookResult}
          customBookBusy={customBookBusy}
          onRunCustomBook={runCustomBook}
          internetTopic={internetTopic}
          setInternetTopic={setInternetTopic}
          internetCount={internetCount}
          setInternetCount={setInternetCount}
          internetResult={internetResult}
          internetBusy={internetBusy}
          internetKeyMissing={internetKeyMissing}
          onRunInternet={runInternet}
          examId={detail.exam.id}
          manualType={manualType}
          setManualType={setManualType}
          manualText={manualText}
          setManualText={setManualText}
          manualOptions={manualOptions}
          setManualOptions={setManualOptions}
          manualAnswer={manualAnswer}
          setManualAnswer={setManualAnswer}
          manualEvidence={manualEvidence}
          setManualEvidence={setManualEvidence}
          onAddManual={addManualQuestion}
          editingId={editingId}
          setEditingId={setEditingId}
          editText={editText}
          setEditText={setEditText}
          editOptions={editOptions}
          setEditOptions={setEditOptions}
          editAnswer={editAnswer}
          setEditAnswer={setEditAnswer}
          rejectReason={rejectReason}
          setRejectReason={setRejectReason}
          onReview={reviewQuestion}
          onSaveEdit={saveEdit}
          onDelete={deleteQuestion}
          onStartEdit={startEdit}
        />
      )}

      {detail && !detailLoading && (
        <CandidatesPanel examId={detail.exam.id} examStatus={detail.exam.status} examTitle={detail.exam.title} />
      )}
    </div>
  )
}

function DetailPanel(props: any) {
  const { detail, statusFilter, setStatusFilter, filteredQuestions } = props
  const exam = detail.exam
  const isDraft = exam.status === 'DRAFT'
  const canPublish = detail.counts.approved === 100

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-black">{exam.title}</h4>
            <Badge variant={exam.status === 'READY' ? 'default' : 'secondary'}>{STATUS_LABEL[exam.status] || exam.status}</Badge>
          </div>
          <p className="text-xs text-slate-600">
            معتمد <b>{detail.counts.approved} / 100</b> — بانتظار المراجعة {detail.counts.pending} — مرفوض {detail.counts.rejected} — المجموع {detail.counts.approved + detail.counts.pending + detail.counts.rejected}
            {detail.counts.approved < 100 && ` — ينقص ${100 - detail.counts.approved} سؤالاً معتمداً للنشر`}
            {detail.counts.approved > 100 && ` — زائد ${detail.counts.approved - 100} سؤالاً معتمداً، ألغِ اعتماد الزائد قبل النشر`}
          </p>
          <div className="grid gap-3 sm:grid-cols-[120px_140px_auto_auto]">
            <div className="space-y-1">
              <Label>علامة النجاح %</Label>
              <Input type="number" min={1} max={100} value={props.passScore} disabled={!isDraft} onChange={(e: ChangeEvent<HTMLInputElement>) => props.setPassScore(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>المدة (دقيقة)</Label>
              <Input type="number" min={10} max={480} value={props.durationMin} disabled={!isDraft} onChange={(e: ChangeEvent<HTMLInputElement>) => props.setDurationMin(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button variant="outline" disabled={!isDraft} onClick={props.onSaveSettings}>حفظ الإعدادات</Button>
            </div>
            <div className="flex items-end gap-2">
              {exam.status === 'DRAFT' && (
                <Button disabled={!canPublish} onClick={() => props.onPublish('publish')}>
                  <Check className="h-4 w-4" /> نشر الامتحان (100 معتمد)
                </Button>
              )}
              {exam.status === 'READY' && (
                <Button variant="outline" onClick={() => props.onPublish('unpublish')}>إلغاء النشر</Button>
              )}
              {(exam.status === 'DRAFT' || exam.status === 'READY') && (
                <Button variant="outline" onClick={() => props.onPublish('archive')}>أرشفة الامتحان</Button>
              )}
            </div>
          </div>
          {!canPublish && exam.status === 'DRAFT' && (
            <p className="text-[11px] text-amber-700">زر النشر يفعَّل فقط عند 100 سؤال معتمد بالضبط — النظام لا يختار أسئلة نيابة عنك.</p>
          )}
        </CardContent>
      </Card>

      {isDraft && (
        <>
          <Card>
            <CardContent className="space-y-3 pt-4">
              <h4 className="text-sm font-black">إضافة سؤال يدوي (صح/خطأ أو اختيار متعدد — لا مقالي)</h4>
              <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                <div className="space-y-1">
                  <Label>النوع</Label>
                  <Select value={props.manualType} onValueChange={(v: string) => { props.setManualType(v); props.setManualAnswer('0') }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="MCQ">اختيار متعدد</SelectItem>
                      <SelectItem value="TF">صح / خطأ</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>نص السؤال</Label>
                  <Textarea value={props.manualText} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => props.setManualText(e.target.value)} rows={2} />
                </div>
              </div>
              {props.manualType === 'MCQ' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {props.manualOptions.map((opt: string, i: number) => (
                    <div key={i} className="flex items-center gap-2">
                      <input type="radio" name="manual-answer" checked={props.manualAnswer === String(i)} onChange={() => props.setManualAnswer(String(i))} aria-label={`الخيار ${i + 1} صحيح`} />
                      <Input value={opt} placeholder={`الخيار ${i + 1}`} onChange={(e: ChangeEvent<HTMLInputElement>) => { const next = [...props.manualOptions]; next[i] = e.target.value; props.setManualOptions(next) }} />
                    </div>
                  ))}
                </div>
              )}
              {props.manualType === 'TF' && (
                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-1"><input type="radio" name="manual-tf" checked={props.manualAnswer === '0'} onChange={() => props.setManualAnswer('0')} /> صح</label>
                  <label className="flex items-center gap-1"><input type="radio" name="manual-tf" checked={props.manualAnswer === '1'} onChange={() => props.setManualAnswer('1')} /> خطأ</label>
                </div>
              )}
              <div className="space-y-1">
                <Label>الدليل من الكتاب (اختياري)</Label>
                <Input value={props.manualEvidence} onChange={(e: ChangeEvent<HTMLInputElement>) => props.setManualEvidence(e.target.value)} />
              </div>
              <Button onClick={props.onAddManual} disabled={!props.manualText.trim()}><Plus className="h-4 w-4" /> إضافة السؤال (بانتظار المراجعة)</Button>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-black">من الكتب المرفوعة — عبر بنك الأسئلة المعتمد</h4>
                <Button variant="outline" size="sm" onClick={props.onLoadBank} disabled={props.bankLoading}>
                  {props.bankLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} تحميل المعتمدة
                </Button>
              </div>
              <p className="text-[11px] text-slate-500">أسئلة بنك الأسئلة المعتمدة لهذا البرنامج (المولَّدة من كتبه). الاستيراد ينسخ لقطة وتبدأ معتمدة لأنها اعتُمدت أصلاً في البنك.</p>
              {props.bankItems.length > 0 && (
                <>
                  <div className="max-h-64 space-y-2 overflow-y-auto">
                    {props.bankItems.map((it: BankItem) => (
                      <label key={it.id} className="flex items-start gap-2 rounded-lg border p-2 text-xs">
                        <input type="checkbox" checked={!!props.bankSelected[it.id]} onChange={(e: ChangeEvent<HTMLInputElement>) => props.setBankSelected({ ...props.bankSelected, [it.id]: e.target.checked })} />
                        <span><b>{it.type === 'TF' ? 'صح/خطأ' : 'اختيار متعدد'}</b> — {it.text}{it.sourceBookTitle ? <span className="text-slate-500"> ({it.sourceBookTitle})</span> : null}</span>
                      </label>
                    ))}
                  </div>
                  <Button onClick={props.onImportFromBank}>استيراد المحدد ({Object.values(props.bankSelected).filter(Boolean).length})</Button>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 pt-4">
              <h4 className="text-sm font-black">استيراد ملف أسئلة</h4>
              <p className="text-[11px] text-slate-500">
                Excel موثوق (قالب جاهز أدناه) — وورد/PDF/نص مسودة للمراجعة فقط، والأسطر غير المحلَّلة تُحصى ولا تُحفظ. كل سؤال مستورد يبدأ بانتظار المراجعة.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <a className="text-xs font-bold text-emerald-700 underline" href={`/api/admin/comprehensive-exams/${props.examId}/template`}>
                  <Download className="inline h-3.5 w-3.5" /> تنزيل قالب Excel
                </a>
                <Input type="file" accept=".xlsx,.xls,.csv,.docx,.pdf,.txt" onChange={(e: ChangeEvent<HTMLInputElement>) => props.setImportFile(e.target.files?.[0] || null)} className="max-w-xs" />
              </div>
              {props.importFile && (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={props.importing} onClick={() => props.onRunImport(true)}>
                    {props.importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSpreadsheet className="h-4 w-4" />} معاينة أولاً
                  </Button>
                  <Button disabled={props.importing || !props.importPreview} onClick={() => props.onRunImport(false)}>
                    <Upload className="h-4 w-4" /> تأكيد الاستيراد
                  </Button>
                </div>
              )}
              {props.importPreview && (
                <p className="text-xs text-slate-600">
                  المعاينة: {props.importPreview.valid} سؤالاً صالحاً، {props.importPreview.errors?.length || 0} صفاً مرفوضاً
                  {props.importPreview.errors?.length ? ` — أول خطأ: سطر ${props.importPreview.errors[0].row}: ${props.importPreview.errors[0].message}` : ''}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 pt-4">
              <h4 className="text-sm font-black">رفع كتاب مخصص وتوليد أسئلة منه</h4>
              <p className="text-[11px] text-slate-500">
                كتاب PDF أو Word (DOCX) من خارج كتب البرنامج — يُقرأ هنا فقط ولا يُسجَّل ككتاب برنامج. الذكاء يولّد أسئلة صح/خطأ واختيار متعدد من نصه، وكل سؤال يحمل
                دليلاً حرفياً من الكتاب ويبدأ بانتظار المراجعة. الحد 10 ميغابايت و300 صفحة (أو 300 مقطعاً نصياً لملف Word — فملف Word بلا صفحات حقيقية)؛ الصفحات بلا نص مقروء (ممسوحة ضوئياً) تُبلَّغ ولا تولَّد منها أسئلة.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input type="file" accept=".pdf,.docx" onChange={(e: ChangeEvent<HTMLInputElement>) => props.setCustomBookFile(e.target.files?.[0] || null)} className="max-w-xs" />
                <div className="flex items-center gap-2">
                  <Label>عدد الأسئلة</Label>
                  <Input
                    type="number" min={1} max={10} value={props.customBookCount}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => props.setCustomBookCount(e.target.value)} className="w-20"
                  />
                </div>
                <Button disabled={props.customBookBusy || !props.customBookFile} onClick={props.onRunCustomBook}>
                  {props.customBookBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} رفع الكتاب وتوليد أسئلة
                </Button>
              </div>
              {props.customBookBusy && <p className="text-xs text-slate-500">جارٍ قراءة الكتاب وتوليد الأسئلة — قد تستغرق العملية دقيقة أو أكثر…</p>}
              {props.customBookResult && (
                <p className="text-xs text-slate-600">
                  الكتاب «{props.customBookResult.extraction?.bookTitle}»: {props.customBookResult.extraction?.totalPages} {props.customBookResult.extraction?.kind === 'DOCX' ? 'مقطعاً نصياً' : 'صفحة'}،
                  {' '}{props.customBookResult.extraction?.readablePages} {props.customBookResult.extraction?.kind === 'DOCX' ? 'مقروءاً' : 'مقروءة'}
                  {props.customBookResult.extraction?.unreadablePages?.length
                    ? `، ${props.customBookResult.extraction.unreadablePages.length} غير مقروءة (${props.customBookResult.extraction.kind === 'DOCX' ? 'مقاطع نصية' : 'صفحات'} ${props.customBookResult.extraction.unreadablePages.slice(0, 5).map((p: any) => p.page).join('، ')}${props.customBookResult.extraction.unreadablePages.length > 5 ? '…' : ''})`
                    : ''}
                  {' '}— وُلّد {props.customBookResult.imported} سؤالاً من {props.customBookResult.requested} مطلوباً
                  {props.customBookResult.rejectedCount ? `، ${props.customBookResult.rejectedCount} مرفوضاً بالتحقق بالدليل` : ''}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 pt-4">
              <h4 className="text-sm font-black">بحث الذكاء عبر الإنترنت</h4>
              <p className="text-[11px] text-slate-500">
                يبحث الذكاء في الويب (Tavily) عن محور علمي داخل تخصص الامتحان، ثم يولّد أسئلة كفاءة تخصصية بدليل حرفي ورابط مصدر، وكلها بانتظار المراجعة.
                اكتب موضوعاً مثل «الإدارة الاستراتيجية وتحليل المنافسة» أو «مناهج البحث التطبيقي»؛ لا تكتب اسم الدرجة (DBA) وحده، أو شروط قبولها، فهذه ليست أسئلة تخصصية.
                يتطلب ذلك مفتاح Tavily محفوظاً في إعدادات النظام.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input value={props.internetTopic} onChange={(e: ChangeEvent<HTMLInputElement>) => props.setInternetTopic(e.target.value)} placeholder="مثال: مبادئ المحاسبة المالية" className="max-w-xs" />
                <div className="flex items-center gap-2">
                  <Label>عدد الأسئلة</Label>
                  <Input
                    type="number" min={1} max={10} value={props.internetCount}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => props.setInternetCount(e.target.value)} className="w-20"
                  />
                </div>
                <Button disabled={props.internetBusy || !props.internetTopic?.trim()} onClick={props.onRunInternet}>
                  {props.internetBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} بحث وتوليد أسئلة
                </Button>
              </div>
              {props.internetBusy && <p className="text-xs text-slate-500">جارٍ البحث في الويب وتوليد الأسئلة — قد تستغرق العملية دقيقة أو أكثر…</p>}
              {props.internetKeyMissing && (
                <p className="text-xs font-bold text-amber-700">
                  لم يُحفظ مفتاح Tavily بعد — احفظ مفتاحاً مجانياً من tavily.com في لوحة الإدارة ← النظام ← مزوّدو النصوص والمفاتيح ← بحث الإنترنت للامتحان الشامل (Tavily)، ثم أعد المحاولة.
                </p>
              )}
              {props.internetResult && (
                <p className="text-xs text-slate-600">
                  البحث عن «{props.internetResult.search?.topic}»: {props.internetResult.search?.resultsFound} نتيجة، {props.internetResult.search?.chunksUsed} مقطعاً مستخدماً
                  {props.internetResult.search?.creditsUsed != null ? `، ${props.internetResult.search.creditsUsed} نقطة بحث مستخدمة` : ''}
                  {' '}— وُلّد {props.internetResult.imported} سؤالاً من {props.internetResult.requested} مطلوباً
                  {props.internetResult.rejectedCount ? `، ${props.internetResult.rejectedCount} مرفوضاً بالتحقق بالدليل` : ''}
                </p>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-black">أسئلة الامتحان ({detail.questions.length})</h4>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">كل الحالات</SelectItem>
                <SelectItem value="PENDING_REVIEW">بانتظار المراجعة</SelectItem>
                <SelectItem value="APPROVED">معتمدة</SelectItem>
                <SelectItem value="REJECTED">مرفوضة</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            {filteredQuestions.map((q: ExamQuestion) => (
              <QuestionRow key={q.id} q={q} isDraft={isDraft} {...props} />
            ))}
            {filteredQuestions.length === 0 && <p className="text-xs text-slate-500">لا توجد أسئلة بهذه الحالة بعد.</p>}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function QuestionRow(props: any) {
  const { q, isDraft } = props
  const options = parseOptions(q.options)
  const editing = props.editingId === q.id
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-black">#{q.order}</span>
        <Badge variant="secondary">{q.type === 'TF' ? 'صح/خطأ' : 'اختيار متعدد'}</Badge>
        <Badge variant={q.status === 'APPROVED' ? 'default' : q.status === 'REJECTED' ? 'destructive' : 'secondary'}>
          {STATUS_LABEL[q.status] || q.status}
        </Badge>
        <span className="text-slate-500">المصدر: {SOURCE_LABEL[q.source] || q.source}</span>
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <Textarea value={props.editText} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => props.setEditText(e.target.value)} rows={2} />
          {q.type === 'MCQ' && (
            <div className="grid gap-2 sm:grid-cols-2">
              {props.editOptions.map((opt: string, i: number) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="radio" name={`edit-answer-${q.id}`} checked={props.editAnswer === String(i)} onChange={() => props.setEditAnswer(String(i))} aria-label={`الخيار ${i + 1} صحيح`} />
                  <Input value={opt} onChange={(e: ChangeEvent<HTMLInputElement>) => { const next = [...props.editOptions]; next[i] = e.target.value; props.setEditOptions(next) }} />
                </div>
              ))}
            </div>
          )}
          {q.type === 'TF' && (
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1"><input type="radio" name={`edit-tf-${q.id}`} checked={props.editAnswer === '0'} onChange={() => props.setEditAnswer('0')} /> صح</label>
              <label className="flex items-center gap-1"><input type="radio" name={`edit-tf-${q.id}`} checked={props.editAnswer === '1'} onChange={() => props.setEditAnswer('1')} /> خطأ</label>
            </div>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => props.onSaveEdit(q)}>حفظ التعديل</Button>
            <Button size="sm" variant="outline" onClick={() => props.setEditingId(null)}>إلغاء</Button>
          </div>
        </div>
      ) : (
        <>
          <p className="mt-2 text-sm font-bold">{q.text}</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {options.map((opt: string, i: number) => (
              <li key={i} className={String(i) === q.correctAnswer ? 'font-bold text-emerald-700' : 'text-slate-600'}>
                {i + 1}. {opt} {String(i) === q.correctAnswer ? '✓ (الصحيحة)' : ''}
              </li>
            ))}
          </ul>
          {q.sourceEvidence && <p className="mt-1 text-[11px] text-slate-500">الدليل: {q.sourceEvidence}</p>}
          {q.sourceUrl && (
            <p className="mt-1 text-[11px] text-slate-500">
              المصدر:{' '}
              <a className="text-emerald-700 underline" href={q.sourceUrl} target="_blank" rel="noreferrer">
                {q.sourceUrl}
              </a>
            </p>
          )}
          {q.status === 'REJECTED' && q.rejectedReason && <p className="mt-1 text-[11px] text-red-600">سبب الرفض: {q.rejectedReason}</p>}
          {isDraft && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {q.status !== 'APPROVED' && (
                <Button size="sm" variant="outline" onClick={() => props.onReview(q, 'APPROVED')}><Check className="h-3.5 w-3.5" /> اعتماد</Button>
              )}
              {q.status !== 'REJECTED' && (
                <>
                  <Input
                    value={props.rejectReason}
                    placeholder="سبب الرفض (مطلوب للرفض)"
                    className="w-48"
                    onChange={(e: ChangeEvent<HTMLInputElement>) => props.setRejectReason(e.target.value)}
                  />
                  <Button size="sm" variant="outline" onClick={() => props.onReview(q, 'REJECTED')}><X className="h-3.5 w-3.5" /> رفض</Button>
                </>
              )}
              <Button size="sm" variant="outline" onClick={() => props.onStartEdit(q)}>تعديل</Button>
              <Button size="sm" variant="outline" onClick={() => props.onDelete(q)}><Trash2 className="h-3.5 w-3.5" /> حذف</Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---- المرحلة الثانية: المرشحون والدعوات والمحاولات ----
type CandidateInvitation = {
  id: string
  status: string
  expiresAt: string
  emailStatus: string | null
  emailError: string | null
  whatsappStatus: string | null
  whatsappError: string | null
  lastSentAt: string | null
  inviteUrl?: string | null
}
type CandidateAttempt = { id: string; status: string; score: number | null; passed: boolean | null; startedAt: string; submittedAt: string | null; certificateSerial?: string | null; certificateId?: string | null; certificateUploadedFileKey?: string | null; certificateStampedFileKey?: string | null }
type CandidateItem = {
  id: string
  fullName: string
  nationalId: string
  email: string
  phone: string | null
  externalCertificateFileName: string | null
  externalCertificateDownloadUrl: string
  idDocumentFileName: string | null
  idDocumentDownloadUrl: string
  status: string
  rejectedReason: string | null
  submittedBy: string
  createdAt: string
  serviceFeePaid?: boolean | null
  manualPayment?: { id: string; status: string; amount: number; invoiceNo: string; receiptNo: string | null } | null
  inviteBlockedReason?: 'EXAM_NOT_READY' | 'PAYMENT_REQUIRED' | null
  specialization?: { id: string; titleAr: string; titleEn?: string | null; category?: string | null } | null
  invitation: CandidateInvitation | null
  attempt: CandidateAttempt | null
}

const CHANNEL_LABEL: Record<string, string> = { SENT: 'وصل', SKIPPED: 'تخطّى', FAILED: 'فشل', NOT_CONFIGURED: 'غير مهيأ' }

function DeliveryLine({ label, status, error }: { label: string; status: string | null; error: string | null }) {
  const shown = status || '—'
  const ok = status === 'SENT'
  const bad = status === 'FAILED'
  return (
    <span className="block text-[11px] leading-5">
      <span className="font-black">{label}: </span>
      <span className={ok ? 'font-black text-emerald-700' : bad ? 'font-black text-red-700' : 'font-bold text-amber-700'}>
        {CHANNEL_LABEL[shown] || shown}
      </span>
      {error && <span className="block text-slate-500">{error}</span>}
    </span>
  )
}

function CandidatesPanel({ examId, examStatus, examTitle }: { examId: string; examStatus: string; examTitle: string }) {
  const [candidates, setCandidates] = useState<CandidateItem[]>([])
  const [specialization, setSpecialization] = useState<{ id: string; titleAr: string; titleEn?: string | null; category?: string | null } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [fullName, setFullName] = useState('')
  const [nationalId, setNationalId] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [certificateFile, setCertificateFile] = useState<File | null>(null)
  const [idFile, setIdFile] = useState<File | null>(null)
  const [creating, setCreating] = useState(false)
  const [paymentCandidateId, setPaymentCandidateId] = useState<string | null>(null)
  const [paidAmount, setPaidAmount] = useState('')
  const [paidNote, setPaidNote] = useState('تم استلام المبلغ لدى الإدارة مباشرة')
  const [rejectReasonById, setRejectReasonById] = useState<Record<string, string>>({})
  const [invitationsByCandidate, setInvitationsByCandidate] = useState<Record<string, CandidateInvitation[]>>({})
  const [showInvitations, setShowInvitations] = useState<Record<string, boolean>>({})
  const [inviteUrlByCandidate, setInviteUrlByCandidate] = useState<Record<string, string>>({})
  const [certFileByCandidate, setCertFileByCandidate] = useState<Record<string, File | null>>({})
  const [certQrSizeByCandidate, setCertQrSizeByCandidate] = useState<Record<string, string>>({})
  const [certQrPositionByCandidate, setCertQrPositionByCandidate] = useState<Record<string, string>>({})
  const [certPreviewUrlByCandidate, setCertPreviewUrlByCandidate] = useState<Record<string, string | null>>({})

  const loadCandidates = async () => {
    setLoading(true)
    try {
      const data = await jsonOrThrow(await fetch(`/api/admin/comprehensive-exams/${examId}/candidates`, { cache: 'no-store' }), 'تعذر تحميل المرشحين')
      setCandidates(data.candidates || [])
      setSpecialization(data.specialization || null)
    } catch (e: any) {
      toast({ title: 'تعذر تحميل المرشحين', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // First load via an async callback (not a sync setState in the effect).
    // loading starts true from useState, so nothing is set here.
    let alive = true
    fetch(`/api/admin/comprehensive-exams/${examId}/candidates`, { cache: 'no-store' })
      .then((r) => jsonOrThrow(r, 'تعذر تحميل المرشحين'))
      .then((data) => {
        if (!alive) return
        setCandidates(data.candidates || [])
        setSpecialization(data.specialization || null)
        setLoading(false)
      })
      .catch((e: any) => {
        if (!alive) return
        setLoading(false)
        toast({ title: 'تعذر تحميل المرشحين', description: e.message || 'حدث خطأ', variant: 'destructive' })
      })
    return () => {
      alive = false
    }
  }, [examId])

  const deliverySummary = (d: any) =>
    `البريد: ${CHANNEL_LABEL[d?.email?.status] || d?.email?.status || '—'} — واتساب: ${CHANNEL_LABEL[d?.whatsapp?.status] || d?.whatsapp?.status || '—'}`

  const createCandidate = async () => {
    if (!certificateFile) return toast({ title: 'ملف الشهادة مطلوب', variant: 'destructive' })
    if (!idFile) return toast({ title: 'ملف الهوية مطلوب', variant: 'destructive' })
    const form = new FormData()
    form.append('fullName', fullName)
    form.append('nationalId', nationalId)
    form.append('email', email)
    form.append('phone', phone)
    form.append('certificateFile', certificateFile)
    form.append('idDocumentFile', idFile)
    setCreating(true)
    try {
      const data = await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${examId}/candidates`, { method: 'POST', body: form }),
        'تعذر إدخال المرشح',
      )
      const accountMessage = data.userCreated
        ? data.emailStatus === 'SENT' ? 'أُنشئ حساب الطالب ووصلت تعليمات الدخول بالبريد.' : 'أُنشئ الحساب، لكن البريد لم يصل؛ استخدم زر إعادة إرسال تعليمات الدخول.'
        : 'المرشح مرتبط بحساب طالب موجود مسبقاً.'
      toast({ title: 'أُدخل المرشح', description: `${accountMessage} راجعه واعتمده قبل توثيق الدفعة والدعوة.` })
      setFullName('')
      setNationalId('')
      setEmail('')
      setPhone('')
      setCertificateFile(null)
      setIdFile(null)
      await loadCandidates()
    } catch (e: any) {
      toast({ title: 'تعذر إدخال المرشح', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setCreating(false)
    }
  }

  const resendAccountSetup = async (c: CandidateItem) => {
    setBusy(`setup-${c.id}`)
    try {
      const data = await jsonOrThrow(await fetch(`/api/admin/comprehensive-exams/${examId}/candidates/${c.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resend_account_setup' }),
      }), 'تعذر إرسال تعليمات الدخول')
      toast({ title: data.emailStatus === 'SENT' ? 'أُرسلت تعليمات الدخول' : 'تعذر التسليم', description: `البريد: ${data.emailStatus}` })
    } catch (e: any) {
      toast({ title: 'تعذر إرسال تعليمات الدخول', description: e.message || 'راجع إعدادات البريد', variant: 'destructive' })
    } finally { setBusy(null) }
  }

  const recordDirectPayment = async (c: CandidateItem) => {
    if (!paidAmount.trim()) return toast({ title: 'أدخل المبلغ الذي استلمته بالدولار', variant: 'destructive' })
    setBusy(`payment-${c.id}`)
    try {
      const data = await jsonOrThrow(await fetch(`/api/admin/comprehensive-exams/${examId}/candidates/${c.id}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'record_paid', amount: paidAmount, note: paidNote }),
      }), 'تعذر تسجيل الدفعة')
      toast({ title: 'تم تسجيل السداد رسمياً', description: `${data.payment.amount}$ — الفاتورة ${data.payment.invoiceNo} — الإيصال ${data.payment.receiptNo}` })
      setPaymentCandidateId(null)
      setPaidAmount('')
      await loadCandidates()
    } catch (e: any) {
      toast({ title: 'تعذر تسجيل الدفعة', description: e.message || 'راجع قسم المالية', variant: 'destructive' })
    } finally { setBusy(null) }
  }

  const reviewCandidate = async (c: CandidateItem, action: 'approve' | 'reject') => {
    const reason = (rejectReasonById[c.id] || '').trim()
    if (action === 'reject' && !reason) return toast({ title: 'رفض المرشح يتطلب سبباً', variant: 'destructive' })
    setBusy(`review-${c.id}`)
    try {
      await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${examId}/candidates/${c.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, rejectedReason: reason }),
        }),
        'تعذر مراجعة المرشح',
      )
      toast({ title: action === 'approve' ? 'اعتُمد المرشح' : 'رُفض المرشح', description: action === 'approve' ? (c.submittedBy === 'ADMIN' ? 'وثّق المبلغ المقبوض أولاً من زر «تم الدفع»، ثم أصدر دعوة الاختبار.' : 'يمكنك الآن إصدار الدعوة بعد تحقق شرط سداد الرسوم.') : '' })
      await loadCandidates()
    } catch (e: any) {
      toast({ title: 'تعذر مراجعة المرشح', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const issueInvitation = async (c: CandidateItem) => {
    setBusy(`issue-${c.id}`)
    try {
      const data = await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${examId}/candidates/${c.id}/invitations`, { method: 'POST' }),
        'تعذر إصدار الدعوة',
      )
      if (data?.invitation?.inviteUrl) setInviteUrlByCandidate((prev) => ({ ...prev, [c.id]: data.invitation.inviteUrl }))
      toast({ title: 'صدرت الدعوة', description: deliverySummary(data?.delivery) })
      await loadCandidates()
    } catch (e: any) {
      toast({ title: 'تعذر إصدار الدعوة', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const invitationAction = async (c: CandidateItem, inv: CandidateInvitation, action: 'renew' | 'revoke') => {
    setBusy(`${action}-${inv.id}`)
    try {
      const data = await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${examId}/candidates/${c.id}/invitations/${inv.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        }),
        action === 'renew' ? 'تعذر تجديد الدعوة' : 'تعذر إلغاء الدعوة',
      )
      if (action === 'renew' && data?.invitation?.inviteUrl) {
        setInviteUrlByCandidate((prev) => ({ ...prev, [c.id]: data.invitation.inviteUrl }))
        toast({ title: 'جُددت الدعوة — الرابط القديم توقف', description: deliverySummary(data?.delivery) })
      } else {
        toast({ title: 'أُلغيت الدعوة' })
      }
      await loadCandidates()
    } catch (e: any) {
      toast({ title: action === 'renew' ? 'تعذر تجديد الدعوة' : 'تعذر إلغاء الدعوة', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const qualifyCandidate = async (c: CandidateItem) => {
    setBusy(`qualify-${c.id}`)
    try {
      const data = await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${examId}/candidates/${c.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'qualify' }),
        }),
        'تعذر التأهيل',
      )
      toast({ title: 'صدرت الشهادة', description: `الرقم التسلسلي: ${data?.certificate?.serial || ''}` })
      await loadCandidates()
    } catch (e: any) {
      toast({ title: 'تعذر التأهيل', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const loadInvitations = async (c: CandidateItem) => {
    setShowInvitations((prev) => ({ ...prev, [c.id]: !prev[c.id] }))
    if (invitationsByCandidate[c.id]) return
    try {
      const data = await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${examId}/candidates/${c.id}/invitations`, { cache: 'no-store' }),
        'تعذر تحميل الدعوات',
      )
      setInvitationsByCandidate((prev) => ({ ...prev, [c.id]: data.invitations || [] }))
    } catch (e: any) {
      toast({ title: 'تعذر تحميل الدعوات', description: e.message || 'حدث خطأ', variant: 'destructive' })
    }
  }

  const copyInviteLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      toast({ title: 'نُسخ رابط الدعوة' })
    } catch {
      toast({ title: 'تعذر النسخ — انسخ الرابط يدوياً', variant: 'destructive' })
    }
  }

  // ---- رفع/ختم ملف شهادة المعادلة (مطابق لشاشة الخريجين السابقين) ----
  // الشهادة الأصلية لا يُعاد رسمها؛ يُضاف QR والرقم التسلسلي فقط فوق
  // الملف كما رُفع، بنفس مسار الختم وحقول التخطيط.
  const certUploadUrl = (c: CandidateItem) => `/api/admin/comprehensive-exams/${examId}/certificates/${c.attempt?.certificateId}/upload`
  const certQrSize = (c: CandidateItem) => certQrSizeByCandidate[c.id] || 'M'
  const certQrPosition = (c: CandidateItem) => certQrPositionByCandidate[c.id] || 'BOTTOM_LEFT'

  const previewCertFile = async (c: CandidateItem) => {
    const certId = c.attempt?.certificateId
    if (!certId) return
    const file = certFileByCandidate[c.id] || null
    setBusy(`cert-preview-${c.id}`)
    try {
      if (file) {
        // ملف جديد لم يُحفظ بعد: المعاينة تمر عبر POST (مثل شاشة
        // الخريجين السابقين) لأن متصفحات الهواتف ترفض عرض blob: PDF
        // داخل الإطارات.
        const fd = new FormData()
        fd.append('file', file)
        fd.append('qrPosition', certQrPosition(c))
        fd.append('qrSize', certQrSize(c))
        const res = await fetch(`${certUploadUrl(c)}?preview=true`, { method: 'POST', body: fd })
        if (!res.ok) throw new Error(apiErrorMessage(await res.json().catch(() => ({})), 'تعذر إنشاء المعاينة'))
        const blob = await res.blob()
        const prev = certPreviewUrlByCandidate[c.id]
        if (prev && prev.startsWith('blob:')) URL.revokeObjectURL(prev)
        setCertPreviewUrlByCandidate((prevState) => ({ ...prevState, [c.id]: URL.createObjectURL(blob) }))
      } else {
        if (!c.attempt?.certificateUploadedFileKey) return toast({ title: 'ارفع ملف الشهادة أولاً', variant: 'destructive' })
        // الملف المخزّن يُعاين برابط GET نظامي حتى يعرضه متصفح التلفون
        // داخل الإطار.
        setCertPreviewUrlByCandidate((prevState) => ({
          ...prevState,
          [c.id]: `${certUploadUrl(c)}?qrSize=${certQrSize(c)}&layout=${encodeURIComponent(certQrPosition(c))}&t=${Date.now()}`,
        }))
      }
    } catch (e: any) {
      toast({ title: 'فشل إنشاء المعاينة', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const uploadCertFile = async (c: CandidateItem) => {
    const certId = c.attempt?.certificateId
    if (!certId) return
    const file = certFileByCandidate[c.id] || null
    if (!file && !c.attempt?.certificateUploadedFileKey) return toast({ title: 'ارفع ملف الشهادة أولاً', variant: 'destructive' })
    setBusy(`cert-upload-${c.id}`)
    try {
      const fd = new FormData()
      if (file) fd.append('file', file)
      fd.append('qrPosition', certQrPosition(c))
      fd.append('qrSize', certQrSize(c))
      const data = await jsonOrThrow(await fetch(certUploadUrl(c), { method: 'POST', body: fd }), 'تعذر حفظ الشهادة المختومة')
      toast({ title: 'تم حفظ الشهادة المختومة', description: data.stampedFileKey || c.attempt?.certificateSerial || '' })
      setCertFileByCandidate((prev) => ({ ...prev, [c.id]: null }))
      await loadCandidates()
    } catch (e: any) {
      toast({ title: 'فشل حفظ الملف المختوم', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-black">المرشحون والدعوات والمحاولات — {examTitle}</h4>
            <p className="mt-0.5 text-[11px] font-bold text-slate-500">التخصص: {specialization?.titleAr || '—'}</p>
          </div>
          <Button variant="outline" size="sm" onClick={loadCandidates}><RefreshCw className="h-3.5 w-3.5" /> تحديث</Button>
        </div>

        {examStatus === 'READY' ? (
          <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-black">إدخال مرشح من الإدارة</p>
            <p className="text-[11px] leading-5 text-slate-500">
              لمن لا يستطيع التقديم بنفسه ويرسل ملفاته للإدارة (مثلاً عبر واتساب). نفس الحقول ونفس فحوصات
              التكرار ونفس مسار الموافقة والدعوة كالتقديم الذاتي.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1"><Label>الاسم الكامل *</Label><Input value={fullName} onChange={(e: ChangeEvent<HTMLInputElement>) => setFullName(e.target.value)} /></div>
              <div className="space-y-1"><Label>رقم الهوية / الرقم الوطني *</Label><Input value={nationalId} onChange={(e: ChangeEvent<HTMLInputElement>) => setNationalId(e.target.value)} dir="ltr" /></div>
              <div className="space-y-1"><Label>البريد الإلكتروني *</Label><Input type="email" value={email} onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} dir="ltr" /></div>
              <div className="space-y-1"><Label>رقم الهاتف (واتساب) *</Label><Input value={phone} onChange={(e: ChangeEvent<HTMLInputElement>) => setPhone(e.target.value)} dir="ltr" /></div>
              <div className="space-y-1">
                <Label>الشهادة الخارجية (صورة أو PDF) *</Label>
                <Input type="file" accept="image/*,.pdf" onChange={(e: ChangeEvent<HTMLInputElement>) => setCertificateFile(e.target.files?.[0] || null)} />
                {certificateFile && <p className="text-[11px] text-slate-500">{certificateFile.name}</p>}
              </div>
              <div className="space-y-1">
                <Label>الهوية (صورة أو PDF) *</Label>
                <Input type="file" accept="image/*,.pdf" onChange={(e: ChangeEvent<HTMLInputElement>) => setIdFile(e.target.files?.[0] || null)} />
                {idFile && <p className="text-[11px] text-slate-500">{idFile.name}</p>}
              </div>
            </div>
            <Button onClick={createCandidate} disabled={creating || !fullName || !nationalId || !email || !phone}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} إدخال المرشح
            </Button>
          </div>
        ) : (
          <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-800">
            إدخال المرشحين والدعوات يتطلب امتحاناً منشوراً — انشر الامتحان أولاً (100 سؤال معتمد).
          </p>
        )}

        {loading && <p className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> جارٍ تحميل المرشحين…</p>}
        {!loading && candidates.length === 0 && <p className="text-xs text-slate-500">لا مرشحين بعد لهذا الامتحان.</p>}

        <div className="space-y-2">
          {candidates.map((c) => {
            const inv = c.invitation
            // الرابط يظهر هنا بعد الإصدار/التجديد مباشرة؛ والروابط القديمة تظهر في قائمة «عرض الدعوات».
            const inviteUrl = inviteUrlByCandidate[c.id]
            const needsQualify = c.attempt?.status === 'GRADED' && c.attempt?.passed && !c.attempt?.certificateSerial
            return (
              <div key={c.id} className="rounded-xl border border-slate-200 p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm font-bold">
                  <span>{c.fullName}</span>
                  <Badge variant={c.status === 'APPROVED' ? 'default' : c.status === 'REJECTED' ? 'destructive' : 'secondary'}>
                    {STATUS_LABEL[c.status] || c.status}
                  </Badge>
                  <Badge variant="outline">{c.submittedBy === 'ADMIN' ? 'أدخلته الإدارة' : 'تقديم ذاتي'}</Badge>
                  <span className="text-xs font-normal text-slate-500" dir="ltr">{c.email}</span>
                  <span className="text-xs font-normal text-slate-500" dir="ltr">{c.phone || ''}</span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">
                  التخصص: {c.specialization?.titleAr || '—'}
                  {' — '}
                  الهوية: <span dir="ltr">{c.nationalId}</span>
                  {' — '}
                  <a className="text-teal-700 underline" href={c.externalCertificateDownloadUrl} target="_blank" rel="noreferrer">الشهادة: {c.externalCertificateFileName || 'ملف'}</a>
                  {' — '}
                  <a className="text-teal-700 underline" href={c.idDocumentDownloadUrl} target="_blank" rel="noreferrer">الهوية: {c.idDocumentFileName || 'ملف'}</a>
                </p>
                {c.status === 'REJECTED' && c.rejectedReason && <p className="mt-1 text-[11px] text-red-600">سبب الرفض: {c.rejectedReason}</p>}
                {c.submittedBy === 'ADMIN' && (
                  <p className={`mt-1 rounded-lg p-2 text-[11px] font-bold ${c.manualPayment?.status === 'PAID' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
                    {c.manualPayment?.status === 'PAID'
                      ? `تم السداد رسمياً: ${Number(c.manualPayment.amount).toFixed(2)}$ — فاتورة ${c.manualPayment.invoiceNo} — إيصال ${c.manualPayment.receiptNo || '—'}`
                      : c.manualPayment ? `فاتورة ${c.manualPayment.invoiceNo} بانتظار استكمال التسوية` : 'لم يُوثق المبلغ المستلم بعد؛ سجله من زر «تم الدفع» قبل إصدار الدعوة.'}
                  </p>
                )}

                {c.attempt && (
                  <p className="mt-1 text-[11px] font-bold text-slate-700">
                    المحاولة: {c.attempt.status === 'GRADED' ? `مصححة — النتيجة ${c.attempt.score ?? '—'}% — ${c.attempt.passed ? 'ناجح' : 'راسب'}` : c.attempt.status === 'STARTED' ? 'بدأت ولم تُسلَّم' : 'منتهية'}
                    {c.attempt.certificateSerial ? ` — الشهادة: ${c.attempt.certificateSerial}` : ''}
                  </p>
                )}

                {c.attempt?.status === 'GRADED' && c.attempt?.passed && c.attempt?.certificateId && (
                  <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <div className="flex flex-wrap items-center gap-2 text-[11px] font-black">
                      <span>رفع شهادة جاهزة وختم QR والرقم</span>
                      <span className="font-bold text-slate-500">الرقم: <span dir="ltr">{c.attempt.certificateSerial}</span></span>
                      {c.attempt.certificateStampedFileKey ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">ملف مختوم</Badge> : <Badge variant="outline">بلا ملف مختوم</Badge>}
                    </div>
                    <p className="rounded-xl border border-emerald-100 bg-emerald-50 p-2 text-[11px] font-bold leading-5 text-emerald-900">
                      الشهادة الأصلية لا يُعاد رسمها. يتم فقط إضافة QR والرقم التسلسلي فوق الملف كما رفعته.
                    </p>
                    <Input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e: ChangeEvent<HTMLInputElement>) => setCertFileByCandidate((prev) => ({ ...prev, [c.id]: e.target.files?.[0] || null }))} />
                    {certFileByCandidate[c.id] && <p className="text-[11px] text-slate-500">{certFileByCandidate[c.id]?.name}</p>}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-[11px] font-black text-slate-600">حجم QR</Label>
                        <Select value={certQrSize(c)} onValueChange={(v) => setCertQrSizeByCandidate((prev) => ({ ...prev, [c.id]: v }))}>
                          <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="S">صغير</SelectItem>
                            <SelectItem value="M">متوسط</SelectItem>
                            <SelectItem value="L">كبير</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px] font-black text-slate-600">موضع QR</Label>
                        <Select value={certQrPosition(c)} onValueChange={(v) => setCertQrPositionByCandidate((prev) => ({ ...prev, [c.id]: v }))}>
                          <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="BOTTOM_LEFT">أسفل اليسار</SelectItem>
                            <SelectItem value="BOTTOM_RIGHT">أسفل اليمين</SelectItem>
                            <SelectItem value="TOP_LEFT">أعلى اليسار</SelectItem>
                            <SelectItem value="TOP_RIGHT">أعلى اليمين</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {certPreviewUrlByCandidate[c.id] && (
                      <div className="space-y-1">
                        <Label className="text-[11px] font-black text-slate-600">معاينة بالمواضع الحالية — لم تُحفظ بعد</Label>
                        <iframe title="معاينة الشهادة المختومة" src={certPreviewUrlByCandidate[c.id] || ''} className="h-96 w-full rounded-xl border border-slate-200 bg-white" />
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => previewCertFile(c)} disabled={busy === `cert-preview-${c.id}`}>
                        {busy === `cert-preview-${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} معاينة
                      </Button>
                      <Button size="sm" onClick={() => uploadCertFile(c)} disabled={busy === `cert-upload-${c.id}`}>
                        {busy === `cert-upload-${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} حفظ المختوم
                      </Button>
                    </div>
                  </div>
                )}

                {inv && (
                  <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
                    <p className="text-[11px] font-black">
                      آخر دعوة: {STATUS_LABEL[inv.status] || inv.status} — تنتهي {new Date(inv.expiresAt).toLocaleDateString('ar-EG')}
                    </p>
                    <DeliveryLine label="البريد" status={inv.emailStatus} error={inv.emailError} />
                    <DeliveryLine label="واتساب" status={inv.whatsappStatus} error={inv.whatsappError} />
                  </div>
                )}

                {inviteUrl && (
                  <div className="mt-2 flex items-center gap-2">
                    <Input value={inviteUrl} readOnly dir="ltr" className="text-[11px]" />
                    <Button size="sm" variant="outline" onClick={() => copyInviteLink(inviteUrl)}>نسخ الرابط</Button>
                  </div>
                )}

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {c.status === 'PENDING_REVIEW' && (
                    <>
                      <Button size="sm" onClick={() => reviewCandidate(c, 'approve')} disabled={busy === `review-${c.id}`}>
                        <Check className="h-3.5 w-3.5" /> اعتماد
                      </Button>
                      <Input
                        value={rejectReasonById[c.id] || ''}
                        placeholder="سبب الرفض (مطلوب للرفض)"
                        className="w-48"
                        onChange={(e: ChangeEvent<HTMLInputElement>) => setRejectReasonById((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      />
                      <Button size="sm" variant="outline" onClick={() => reviewCandidate(c, 'reject')} disabled={busy === `review-${c.id}`}>
                        <X className="h-3.5 w-3.5" /> رفض
                      </Button>
                    </>
                  )}
                  {c.submittedBy === 'ADMIN' && (
                    <Button size="sm" variant="outline" onClick={() => resendAccountSetup(c)} disabled={busy === `setup-${c.id}`}>
                      إعادة إرسال تعليمات الدخول
                    </Button>
                  )}
                  {c.submittedBy === 'ADMIN' && c.status === 'APPROVED' && c.manualPayment?.status !== 'PAID' && (
                    <Button size="sm" variant="outline" onClick={() => {
                      setPaymentCandidateId(paymentCandidateId === c.id ? null : c.id)
                      setPaidAmount(c.manualPayment ? String(c.manualPayment.amount) : '')
                    }} disabled={busy === `payment-${c.id}`}>
                      تم الدفع — تسجيل المبلغ
                    </Button>
                  )}
                  {c.status === 'APPROVED' && (
                    <Button size="sm" onClick={() => issueInvitation(c)} disabled={busy === `issue-${c.id}` || !!c.inviteBlockedReason}>
                      {busy === `issue-${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} إصدار دعوة
                    </Button>
                  )}
                  {inv && (inv.status === 'PENDING' || inv.status === 'EXPIRED') && (
                    <Button size="sm" variant="outline" onClick={() => invitationAction(c, inv, 'renew')} disabled={busy === `renew-${inv.id}` || !!c.inviteBlockedReason}>
                      {busy === `renew-${inv.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} تجديد الدعوة
                    </Button>
                  )}
                  {c.inviteBlockedReason && (
                    <p className="mt-1 w-full text-[11px] font-bold text-amber-700">
                      {c.inviteBlockedReason === 'PAYMENT_REQUIRED'
                        ? c.submittedBy === 'ADMIN' ? 'وثّق المبلغ المستلم أولاً من زر «تم الدفع» حتى يصدر إيصال رسمي' : 'رسوم الخدمة لم تُسدد بعد — لا يُرسَل الرابط قبل السداد'
                        : 'الامتحان غير منشور بعد — جهّزه وانشره أولاً'}
                    </p>
                  )}
                  {inv && inv.status === 'PENDING' && (
                    <Button size="sm" variant="outline" onClick={() => invitationAction(c, inv, 'revoke')} disabled={busy === `revoke-${inv.id}`}>
                      <X className="h-3.5 w-3.5" /> إلغاء الدعوة
                    </Button>
                  )}
                  {needsQualify && (
                    <Button size="sm" onClick={() => qualifyCandidate(c)} disabled={busy === `qualify-${c.id}`}>
                      {busy === `qualify-${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} إعادة التأهيل وإصدار الشهادة
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => loadInvitations(c)}>
                    {showInvitations[c.id] ? 'إخفاء الدعوات' : 'عرض الدعوات'}
                  </Button>
                </div>

                {paymentCandidateId === c.id && c.submittedBy === 'ADMIN' && c.status === 'APPROVED' && c.manualPayment?.status !== 'PAID' && (
                  <div className="mt-2 space-y-2 rounded-xl border border-teal-200 bg-teal-50 p-3">
                    <p className="text-xs font-black text-teal-900">تسجيل سداد استلمته الإدارة فعلياً — سيصدر رقم فاتورة وإيصال رسمي</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <Label>المبلغ المستلم بالدولار ($) *</Label>
                        <Input type="number" min="0.01" max="999999.99" step="0.01" dir="ltr" value={paidAmount} onChange={(e: ChangeEvent<HTMLInputElement>) => setPaidAmount(e.target.value)} placeholder="مثال: 50.00" />
                      </div>
                      <div className="space-y-1">
                        <Label>ملاحظة استلام إدارية *</Label>
                        <Textarea value={paidNote} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setPaidNote(e.target.value)} rows={2} />
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => recordDirectPayment(c)} disabled={busy === `payment-${c.id}` || !paidAmount || paidNote.trim().length < 6}>
                        {busy === `payment-${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} تأكيد المبلغ وتسجيل الإيصال
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setPaymentCandidateId(null)}>إلغاء</Button>
                    </div>
                  </div>
                )}

                {showInvitations[c.id] && (
                  <div className="mt-2 space-y-1 rounded-lg border border-slate-200 p-2">
                    {(invitationsByCandidate[c.id] || []).length === 0 && <p className="text-[11px] text-slate-500">لا دعوات سابقة.</p>}
                    {(invitationsByCandidate[c.id] || []).map((iv) => (
                      <div key={iv.id} className="border-b border-slate-100 pb-1 text-[11px] last:border-0">
                        <span className="font-black">{STATUS_LABEL[iv.status] || iv.status}</span>
                        {' — تنتهي '}
                        {new Date(iv.expiresAt).toLocaleDateString('ar-EG')}
                        <DeliveryLine label="البريد" status={iv.emailStatus} error={iv.emailError} />
                        <DeliveryLine label="واتساب" status={iv.whatsappStatus} error={iv.whatsappError} />
                        {iv.inviteUrl && (
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => copyInviteLink(iv.inviteUrl as string)}>
                            نسخ الرابط
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
