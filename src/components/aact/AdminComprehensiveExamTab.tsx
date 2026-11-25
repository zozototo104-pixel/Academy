'use client'

import { useEffect, useMemo, useState } from 'react'
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

type ProgramOption = { id: string; titleAr: string; titleEn?: string | null; slug?: string | null; active?: boolean | null; category?: string | null }
type ExamCounts = { approved: number; pending: number; rejected: number }
type ExamListItem = {
  id: string; programId: string; programTitleAr: string; programCategory: string; categoryLabel: string; specialtyLabel: string
  level: string; title: string; status: string; passScore: number; durationMin: number; totalPoints: number
  publishedAt?: string | null; counts: ExamCounts
}
type ExamQuestion = {
  id: string; order: number; type: string; text: string; options: string | null; correctAnswer: string | null
  source: string; sourceBookId?: string | null; sourceEvidence?: string | null; bankItemId?: string | null
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
      toast({ title: 'اختر البرنامج أولاً', variant: 'destructive' })
      return
    }
    setCreating(true)
    try {
      const data = await jsonOrThrow(
        await fetch('/api/admin/comprehensive-exams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ programId, passScore: Number(passScore) || 60, durationMin: Number(durationMin) || 120 }),
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

  const publishExam = async (action: 'publish' | 'unpublish') => {
    if (!detail) return
    try {
      const data = await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/publish`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        }),
        'تعذر تنفيذ الإجراء',
      )
      toast({ title: action === 'publish' ? 'تم نشر الامتحان الشامل — 100 سؤال معتمد' : 'تم إلغاء النشر — عاد الامتحان مسودة' })
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
        await fetch(`/api/admin/question-bank?programId=${encodeURIComponent(detail.exam.programId)}&status=APPROVED`, { cache: 'no-store' }),
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
              امتحان من 100 سؤال (صح/خطأ واختيار متعدد فقط — لا مقالي) لخريج درس البرنامج في مؤسسة أخرى. يُنشر فقط عند اكتمال 100 سؤال معتمد،
              والنجاح فيه يؤهل صاحبه كخريج. مصدر «الذكاء من الإنترنت» غير متاح بعد — لا توجد قدرة بحث ويب في المنصة.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_120px_140px_auto]">
            <div className="space-y-1">
              <Label>البرنامج والتخصص</Label>
              <Select value={programId} onValueChange={setProgramId}>
                <SelectTrigger><SelectValue placeholder="اختر البرنامج" /></SelectTrigger>
                <SelectContent>
                  {programs.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.titleAr} — {p.category || ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedProgram && <p className="text-[11px] text-slate-500">المستوى: {selectedProgram.category || '—'}</p>}
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
              <Button onClick={createExam} disabled={creating || !programId}>
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
                كتاب PDF من خارج كتب البرنامج — يُقرأ هنا فقط ولا يُسجَّل ككتاب برنامج. الذكاء يولّد أسئلة صح/خطأ واختيار متعدد من نصه، وكل سؤال يحمل
                دليلاً حرفياً من الكتاب ويبدأ بانتظار المراجعة. الحد 10 ميغابايت و300 صفحة؛ الصفحات بلا نص مقروء (ممسوحة ضوئياً) تُبلَّغ ولا تولَّد منها أسئلة.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input type="file" accept=".pdf" onChange={(e: ChangeEvent<HTMLInputElement>) => props.setCustomBookFile(e.target.files?.[0] || null)} className="max-w-xs" />
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
                  الكتاب «{props.customBookResult.extraction?.bookTitle}»: {props.customBookResult.extraction?.totalPages} صفحة،
                  {' '}{props.customBookResult.extraction?.readablePages} مقروءة
                  {props.customBookResult.extraction?.unreadablePages?.length
                    ? `، ${props.customBookResult.extraction.unreadablePages.length} غير مقروءة (صفحات ${props.customBookResult.extraction.unreadablePages.slice(0, 5).map((p: any) => p.page).join('، ')}${props.customBookResult.extraction.unreadablePages.length > 5 ? '…' : ''})`
                    : ''}
                  {' '}— وُلّد {props.customBookResult.imported} سؤالاً من {props.customBookResult.requested} مطلوباً
                  {props.customBookResult.rejectedCount ? `، ${props.customBookResult.rejectedCount} مرفوضاً بالتحقق بالدليل` : ''}
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
