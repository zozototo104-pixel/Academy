'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { toast } from '@/hooks/use-toast'
import CertificateStampEditor, { parseCertificateStampLayout, serializeCertificateStampLayout as serializeStampLayout, type CertificateStampField, type CertificateStampLayout } from '@/components/aact/CertificateStampEditor'
import { useAdminActionDialog } from './AdminActionDialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Check, ChevronDown, ChevronUp, Download, FileSpreadsheet, Loader2, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react'

type ProgramOption = { id: string; titleAr: string; titleEn?: string | null; slug?: string | null; active?: boolean | null; category?: string | null; serviceKind?: string | null }
type InternetExamAxis = { topic: string; origin: 'CURRICULUM' | 'AI_SUGGESTION' }
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

// One-tap collapse for the exam-prep sections, following the AdminExtras
// pattern (a header button with aria-expanded; collapsing only hides the
// body — the section's state lives outside it and is never reset).
function SectionCollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'فتح القسم' : 'طي القسم'}
      onClick={onToggle}
      className="shrink-0 rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600"
    >
      {collapsed ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
    </button>
  )
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

type SavedInternetExamPlan = { axesText: string; selectedTopics: Record<string, boolean>; basis: string; reviewed: true }

function internetExamPlanStorageKey(examId: string) {
  return `aact:comprehensive-exam-internet-plan:v1:${examId}`
}

// Persist only the administrator-approved blueprint in this browser. The
// server remains authoritative for the saved question count and axis caps.
export function parseSavedInternetExamPlan(raw: string | null): SavedInternetExamPlan | null {
  if (!raw || raw.length > 8000) return null
  try {
    const data = JSON.parse(raw)
    if (typeof data?.axesText !== 'string' || data.axesText.length > 4000 || data.reviewed !== true) return null
    const axes = data.axesText.split('\n').map((axis: string) => axis.trim()).filter(Boolean)
    if (!axes.length || axes.length > 20 || axes.some((axis: string) => axis.length < 10 || axis.length > 160)) return null
    if (!data.selectedTopics || typeof data.selectedTopics !== 'object' || Array.isArray(data.selectedTopics)) return null
    const selectedTopics = Object.fromEntries(axes.filter((axis: string) => data.selectedTopics[axis] === true).map((axis: string) => [axis, true]))
    if (!Object.keys(selectedTopics).length || Object.keys(selectedTopics).length > 10) return null
    return { axesText: axes.join('\n'), selectedTopics, basis: String(data.basis || 'MANUAL').slice(0, 30), reviewed: true }
  } catch { return null }
}

type BulkReviewQuestion = { id: string; order: number }

// Reuse the single-question approval endpoint for every item, including all
// academic checks and its individual audit. Never skip a failed question.
export async function approvePendingQuestionsInBatches(
  questions: readonly BulkReviewQuestion[],
  approveOne: (id: string) => Promise<void>,
  onProgress?: (processed: number, total: number) => void,
): Promise<{ approvedIds: string[]; failed: { id: string; order: number; reason: string }[] }> {
  const uniqueQuestions = [...new Map(questions.map((q) => [q.id, q])).values()]
  const approvedIds: string[] = []
  const failed: { id: string; order: number; reason: string }[] = []
  for (let start = 0; start < uniqueQuestions.length; start += 4) {
    const results = await Promise.all(uniqueQuestions.slice(start, start + 4).map(async (question) => {
      try {
        await approveOne(question.id)
        return { question, ok: true as const }
      } catch (error: any) {
        return { question, ok: false as const, reason: String(error?.message || error || 'تعذر الاعتماد') }
      }
    }))
    for (const result of results) {
      if (result.ok) approvedIds.push(result.question.id)
      else failed.push({ id: result.question.id, order: result.question.order, reason: result.reason })
    }
    onProgress?.(Math.min(start + 4, uniqueQuestions.length), uniqueQuestions.length)
  }
  return { approvedIds, failed }
}

export function AdminComprehensiveExamTab() {
  const { confirmAction, dialog: actionDialog } = useAdminActionDialog()
  const [programs, setPrograms] = useState<ProgramOption[]>([])
  const [exams, setExams] = useState<ExamListItem[]>([])
  const [examSearch, setExamSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({})
  const toggleSection = (key: string) => setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }))
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
  const [internetAxesText, setInternetAxesText] = useState('')
  const [internetSelectedTopics, setInternetSelectedTopics] = useState<Record<string, boolean>>({})
  const [internetPlanBasis, setInternetPlanBasis] = useState('')
  const [internetPlanBusy, setInternetPlanBusy] = useState(false)
  const [internetPlanReviewed, setInternetPlanReviewed] = useState(false)
  const [internetPlanStored, setInternetPlanStored] = useState(false)
  const [internetRunBusy, setInternetRunBusy] = useState(false)
  const [internetRunProgress, setInternetRunProgress] = useState<{axis: number; total: number; imported: number; errors: string[]; status: string; retryAt?: string | null; axisProgress?: { topic: string; target: number; saved: number; remaining: number }[]} | null>(null)
  const internetRunLock = useRef(false)
  const activeExamIdRef = useRef<string | null>(null)
  const restoredInternetJobRef = useRef<string | null>(null)
  const [manualType, setManualType] = useState('MCQ')
  const [manualText, setManualText] = useState('')
  const [manualOptions, setManualOptions] = useState(['', '', '', ''])
  const [manualAnswer, setManualAnswer] = useState('0')
  const [manualEvidence, setManualEvidence] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const editTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [editText, setEditText] = useState('')
  const [editOptions, setEditOptions] = useState<string[]>([])
  const [editAnswer, setEditAnswer] = useState('0')
  const [rejectReason, setRejectReason] = useState('')
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<string[]>([])
  const [bulkApproveBusy, setBulkApproveBusy] = useState(false)
  const [bulkApproveProgress, setBulkApproveProgress] = useState<{ processed: number; total: number } | null>(null)
  const bulkApproveLock = useRef(false)

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

  const loadDetail = async (examId: string, showLoading = true) => {
    // Keep the question list mounted for in-place review updates.
    // Hiding a long panel during refresh collapses the page and moves scroll.
    if (selectedId !== examId) {
      // Switching exams restores this exam's last reviewed blueprint. A
      // refresh must not discard the ability to resume a partial run.
      restoredInternetJobRef.current = null
      activeExamIdRef.current = examId
      let saved: SavedInternetExamPlan | null = null
      try { saved = parseSavedInternetExamPlan(localStorage.getItem(internetExamPlanStorageKey(examId))) } catch { /* private browsing may deny storage */ }
      setInternetAxesText(saved?.axesText || '')
      setInternetSelectedTopics(saved?.selectedTopics || {})
      setInternetPlanBasis(saved?.basis || '')
      setInternetPlanReviewed(Boolean(saved?.reviewed))
      setInternetPlanStored(Boolean(saved))
      setInternetRunProgress(null)
    }
    if (showLoading) setDetailLoading(true)
    try {
      const data = await jsonOrThrow(await fetch(`/api/admin/comprehensive-exams/${examId}`, { cache: 'no-store' }), 'تعذر تحميل الامتحان')
      setDetail({ exam: data.exam, counts: data.counts, questions: data.questions })
      const pendingIds = new Set((data.questions as ExamQuestion[]).filter((q) => q.status === 'PENDING_REVIEW').map((q) => q.id))
      setSelectedQuestionIds((ids) => ids.filter((id) => pendingIds.has(id)))
      setSelectedId(examId)
    } catch (e: any) {
      toast({ title: 'تعذر تحميل الامتحان', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      if (showLoading) setDetailLoading(false)
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
  const selectedSpecialtyDraft = useMemo(() => exams.find((exam) => exam.status === 'DRAFT' && exam.specializationProgramId === specializationProgramId), [exams, specializationProgramId])
  const visibleExams = useMemo(() => {
    const query = examSearch.trim().toLocaleLowerCase('ar')
    return query ? exams.filter((exam) => `${exam.title} ${exam.specialtyLabel} ${STATUS_LABEL[exam.status] || exam.status}`.toLocaleLowerCase('ar').includes(query)) : exams
  }, [exams, examSearch])
  const filteredQuestions = useMemo(() => {
    if (!detail) return []
    return statusFilter === 'ALL' ? detail.questions : detail.questions.filter((q) => q.status === statusFilter)
  }, [detail, statusFilter])

  const refreshDetailAndList = async (examId: string) => {
    await Promise.all([loadDetail(examId, false), loadExams()])
  }

  // Progress is authoritative on the server. Closing this tab stops only
  // polling; Vercel's scheduled worker continues the reviewed blueprint.
  useEffect(() => {
    if (!selectedId) return
    const examId = selectedId
    let cancelled = false
    let previousImported: number | null = null
    const poll = async () => {
      try {
        const res = await fetch(`/api/admin/comprehensive-exams/${examId}/questions/from-internet`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'BACKGROUND_STATUS' }), cache: 'no-store',
        })
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        const job = data?.job
        setInternetRunBusy(Boolean(job && ['QUEUED', 'RUNNING'].includes(job.status)))
        setInternetRunProgress(job ? { axis: job.axis, total: job.total, imported: job.imported, errors: job.errors || [], status: job.status, retryAt: job.retryAt, axisProgress: job.axisProgress || [] } : null)
        if (job && restoredInternetJobRef.current !== examId && Array.isArray(job.axes)) {
          restoredInternetJobRef.current = examId
          const topics = job.axes.map((axis: { topic: string }) => axis.topic)
          setInternetAxesText((prev) => prev.trim() ? prev : topics.join('\n'))
          setInternetSelectedTopics((prev) => Object.keys(prev).length ? prev : Object.fromEntries(topics.map((topic: string) => [topic, true])))
          setInternetPlanBasis((prev) => prev || 'SERVER')
          setInternetPlanReviewed(true)
          setInternetPlanStored(true)
        }
        if (job && previousImported !== null && job.imported !== previousImported) {
          const [detailRes, examsRes] = await Promise.all([
            fetch(`/api/admin/comprehensive-exams/${examId}`, { cache: 'no-store' }),
            fetch('/api/admin/comprehensive-exams', { cache: 'no-store' }),
          ])
          if (cancelled) return
          if (detailRes.ok) {
            const fresh = await detailRes.json()
            if (!cancelled) setDetail({ exam: fresh.exam, counts: fresh.counts, questions: fresh.questions })
          }
          if (examsRes.ok) {
            const fresh = await examsRes.json()
            if (!cancelled) setExams(fresh.exams || [])
          }
        }
        previousImported = job ? Number(job.imported || 0) : null
      } catch { /* a temporary network outage must not stop the server job */ }
    }
    void poll()
    const timer = window.setInterval(() => { void poll() }, 10_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [selectedId])

  const discardSavedInternetPlan = (examId: string) => {
    try { localStorage.removeItem(internetExamPlanStorageKey(examId)) } catch { /* no browser storage */ }
    setInternetPlanStored(false)
  }

  const createExam = async (prepareAxes = false) => {
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
      if (prepareAxes) await createInternetPlan(data.examId)
    } catch (e: any) {
      toast({ title: 'تعذر إنشاء الامتحان', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setCreating(false)
    }
  }

  const publishExam = async (action: 'publish' | 'unpublish' | 'archive') => {
    if (!detail) return
    if (action === 'archive') {
      const confirmed = await confirmAction({
        title: 'أرشفة الامتحان',
        description: `هل تريد أرشفة «${detail.exam.title}»؟ تبقى نتائجه وسجلاته محفوظة، ويمكنك إنشاء نسخة جديدة للتخصص.`,
        confirmLabel: 'أرشفة الامتحان', tone: 'warning',
      })
      if (!confirmed) return
    }
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

  const createInternetPlan = async (examIdOverride?: string) => {
    const examId = examIdOverride || detail?.exam.id
    if (!examId) return
    setInternetPlanBusy(true)
    setInternetPlanReviewed(false)
    setInternetAxesText('')
    setInternetSelectedTopics({})
    setInternetPlanBasis('')
    setInternetRunProgress(null)
    try {
      const data = await jsonOrThrow(await fetch(`/api/admin/comprehensive-exams/${examId}/questions/from-internet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'PLAN' }),
      }), 'تعذر تحضير محاور التخصص')
      if (activeExamIdRef.current !== examId) return
      discardSavedInternetPlan(examId)
      setInternetAxesText((data.axes as InternetExamAxis[]).map((axis) => axis.topic).join('\n'))
      setInternetPlanBasis(data.basis)
      toast({ title: `تم تحضير ${data.axes.length} محاور — اختر التي تريدها`, description: data.warning || 'تستطيع تعديل القائمة قبل تحديد المحاور' })
    } catch (e: any) {
      toast({ title: 'تعذر تحضير مخطط الامتحان', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setInternetPlanBusy(false)
    }
  }

  const openManualInternetPlan = () => {
    if (detail) discardSavedInternetPlan(detail.exam.id)
    setInternetAxesText('')
    setInternetSelectedTopics({})
    setInternetPlanBasis('MANUAL')
    setInternetPlanReviewed(false)
    setInternetRunProgress(null)
  }

  const runComprehensiveInternetPlan = async () => {
    if (!detail || internetBusy || internetRunLock.current || !internetPlanReviewed) return
    const examId = detail.exam.id
    const writtenAxes = internetAxesText.split('\n').map((line) => line.trim()).filter(Boolean)
    const chosenAxes = writtenAxes.filter((topic) => internetSelectedTopics[topic])
    if (!chosenAxes.length || chosenAxes.length > 10 || writtenAxes.length > 20 || chosenAxes.some((topic) => topic.length < 10 || topic.length > 160) || new Set(chosenAxes).size !== chosenAxes.length) {
      toast({ title: 'حدد المحاور التي تريد الامتحان فيها، وتأكّد أنها علمية وصالحة وغير مكررة', variant: 'destructive' })
      return
    }
    // The browser persists a copy for editing. The authoritative reviewed
    // plan and its execution lease are stored server-side before any AI call.
    try {
      localStorage.setItem(internetExamPlanStorageKey(examId), JSON.stringify({
        axesText: writtenAxes.join('\n'),
        selectedTopics: Object.fromEntries(chosenAxes.map((topic) => [topic, true])),
        basis: internetPlanBasis, reviewed: true,
      }))
      setInternetPlanStored(true)
    } catch { /* server persistence does not depend on browser storage */ }
    internetRunLock.current = true
    try {
      setInternetKeyMissing(false)
      const res = await fetch(`/api/admin/comprehensive-exams/${examId}/questions/from-internet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'BACKGROUND_START', axes: chosenAxes, reviewed: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (data?.code === 'TAVILY_KEY_MISSING') setInternetKeyMissing(true)
        throw new Error(apiErrorMessage(data, 'تعذر بدء التوليد بالخلفية'))
      }
      setInternetRunBusy(true)
      setInternetRunProgress({ axis: data.job.axis, total: data.job.total, imported: 0, errors: [], status: 'QUEUED' })
      toast({ title: 'بدأ توليد الامتحان في الخلفية', description: 'تستطيع الخروج من الصفحة؛ الخادم سيواصل العمل ويحفظ كل دفعة موثقة.' })
    } catch (e: any) {
      toast({ title: 'تعذر بدء توليد الامتحان', description: e.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      internetRunLock.current = false
    }
  }

  const pauseComprehensiveInternetPlan = async () => {
    if (!detail) return
    try {
      const data = await jsonOrThrow(await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions/from-internet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'BACKGROUND_PAUSE' }),
      }), 'تعذر إيقاف التوليد')
      setInternetRunBusy(false)
      if (data.job) setInternetRunProgress({ axis: data.job.axis, total: data.job.total, imported: data.job.imported, errors: data.job.errors, status: data.job.status })
      toast({ title: 'تم طلب إيقاف التوليد', description: 'الدفعة الجارية تُحفظ أولاً؛ يمكنك الاستكمال لاحقاً.' })
    } catch (e: any) {
      toast({ title: 'تعذر إيقاف التوليد', description: e.message || 'حدث خطأ', variant: 'destructive' })
    }
  }

  const resumeComprehensiveInternetPlan = async () => {
    if (!detail || internetRunLock.current) return
    internetRunLock.current = true
    try {
      const data = await jsonOrThrow(await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions/from-internet`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'BACKGROUND_RESUME' }),
      }), 'تعذر استكمال مهمة التوليد المحفوظة')
      setInternetRunBusy(true)
      setInternetRunProgress({ axis: data.job.axis, total: data.job.total, imported: data.job.imported, errors: [], status: data.job.status })
      toast({ title: 'استُكمل التوليد من المحاور المحفوظة', description: 'سيستكمل الخادم الأسئلة الناقصة دون تغيير حصص المحاور أو إعادة الأسئلة الموجودة.' })
    } catch (error: any) {
      toast({ title: 'تعذر الاستكمال', description: error.message || 'حدث خطأ', variant: 'destructive' })
    } finally { internetRunLock.current = false }
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

  const approveSelectedQuestions = async () => {
    if (!detail || detail.exam.status !== 'DRAFT' || bulkApproveLock.current) return
    const selected = new Set(selectedQuestionIds)
    const questions = filteredQuestions.filter((q) => q.status === 'PENDING_REVIEW' && selected.has(q.id))
    if (!questions.length) return
    bulkApproveLock.current = true
    setBulkApproveBusy(true)
    setBulkApproveProgress({ processed: 0, total: questions.length })
    try {
      const result = await approvePendingQuestionsInBatches(questions, async (questionId) => {
        await jsonOrThrow(
          await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions/${questionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'APPROVED' }),
          }),
          'تعذر اعتماد السؤال',
        )
      }, (processed, total) => setBulkApproveProgress({ processed, total }))
      setSelectedQuestionIds((ids) => ids.filter((id) => !result.approvedIds.includes(id)))
      toast({
        title: `تم اعتماد ${result.approvedIds.length} من ${questions.length} سؤالاً محدداً`,
        description: result.failed.length
          ? `تعذر اعتماد ${result.failed.length}: ${result.failed.slice(0, 3).map((q) => `#${q.order} (${q.reason})`).join('، ')}. صحّحها وراجعها فردياً.`
          : undefined,
        variant: result.failed.length ? 'destructive' : undefined,
      })
      await refreshDetailAndList(detail.exam.id)
    } catch (e: any) {
      toast({ title: 'تعذر تحديث قائمة الأسئلة بعد الاعتماد', description: e.message || 'حدّث القائمة للتأكد من الحالات', variant: 'destructive' })
    } finally {
      bulkApproveLock.current = false
      setBulkApproveBusy(false)
      setBulkApproveProgress(null)
    }
  }

  const saveEdit = async (q: ExamQuestion) => {
    if (!detail || savingEdit) return
    if (q.type === 'MCQ' && !editOptions[Number(editAnswer)]?.trim()) {
      toast({ title: 'اختر إجابة صحيحة لها نص قبل الحفظ', variant: 'destructive' })
      return
    }
    setSavingEdit(true)
    try {
      await jsonOrThrow(
        await fetch(`/api/admin/comprehensive-exams/${detail.exam.id}/questions/${q.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: editText,
            options: q.type === 'TF' ? ['صح', 'خطأ'] : editOptions.filter((o) => o.trim() !== ''),
            correctAnswer: q.type === 'TF' ? editAnswer : String(editOptions.slice(0, Number(editAnswer)).filter((o) => o.trim()).length),
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
    } finally {
      setSavingEdit(false)
    }
  }

  const deleteQuestion = async (q: ExamQuestion) => {
    if (!detail) return
    const confirmed = await confirmAction({
      title: `حذف السؤال رقم ${q.order}؟`,
      description: `سيُحذف السؤال التالي من مسودة الامتحان «${detail.exam.title}».\n${q.text}`,
      confirmLabel: 'حذف السؤال', tone: 'danger',
    })
    if (!confirmed) return
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

  const startEdit = (q: ExamQuestion, trigger: HTMLButtonElement) => {
    editTriggerRef.current = trigger
    setEditingId(q.id)
    setEditText(q.text)
    setEditOptions(q.type === 'TF' ? ['صح', 'خطأ'] : parseOptions(q.options))
    setEditAnswer(q.correctAnswer || '0')
  }

  const editingQuestion = editingId ? detail?.questions.find((q) => q.id === editingId) : null

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
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-black">تجهيز امتحان شامل لاجتياز البرنامج</h3>
            <SectionCollapseButton collapsed={!!collapsedSections.create} onToggle={() => toggleSection('create')} />
          </div>
          {!collapsedSections.create && (
            <>
              <p className="text-xs text-slate-500">
                امتحان من 100 سؤال (صح/خطأ واختيار متعدد فقط — لا مقالي) لخريج درس التخصص في مؤسسة أخرى. يُنشر فقط عند اكتمال 100 سؤال معتمد،
                والنجاح فيه يؤهل صاحبه كخريج في ذلك التخصص. الامتحان يعيش على برنامج خدمة المعادلة فقط — برامج الدراسة العادية لا يظهر عليها الامتحان أبداً.
                مصدر «الذكاء من الإنترنت» يبحث في الويب عبر Tavily (مفتاح مجاني يُحفظ في إعدادات النظام) ويولّد أسئلة بدليل حرفي ورابط مصدر لكل سؤال.
              </p>
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
              <Button onClick={() => createExam(false)} disabled={creating || !programId || !specializationProgramId}>
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} إنشاء المسودة
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => createExam(true)} disabled={creating || !programId || !specializationProgramId}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} إنشاء مسودة وتحضير محاور التخصص
            </Button>
            <span className="text-xs text-slate-600">مسار أسرع: ينشئ المسودة ثم يقترح المحاور؛ أنت تختارها وتوافق عليها قبل البحث وتوليد الأسئلة.</span>
          </div>
          {selectedSpecialtyDraft && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
              <span>لديك مسودة سابقة لهذا التخصص ({selectedSpecialtyDraft.counts.approved} معتمد، {selectedSpecialtyDraft.counts.pending} بانتظار المراجعة).</span>
              <Button variant="outline" size="sm" onClick={() => loadDetail(selectedSpecialtyDraft.id)}>فتح المسودة واستكمالها</Button>
            </div>
          )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-2 pt-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-black">الامتحانات الشاملة ({exams.length})</h4>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => loadAll()}><RefreshCw className="h-3.5 w-3.5" /> تحديث</Button>
              <SectionCollapseButton collapsed={!!collapsedSections.list} onToggle={() => toggleSection('list')} />
            </div>
          </div>
          {!collapsedSections.list && (
            <>
          {exams.length === 0 && <p className="text-xs text-slate-500">لا توجد امتحانات شاملة بعد — أنشئ أول مسودة من الأعلى.</p>}
          {exams.length > 0 && <Input dir="rtl" value={examSearch} onChange={(e: ChangeEvent<HTMLInputElement>) => setExamSearch(e.target.value)} placeholder="ابحث باسم الامتحان أو التخصص أو الحالة…" aria-label="البحث في الامتحانات الشاملة" />}
          {exams.length > 0 && visibleExams.length === 0 && <p className="text-xs text-slate-500">لا توجد امتحانات مطابقة للبحث.</p>}
          <div className="space-y-2">
            {visibleExams.map((exam) => (
              <button
                key={exam.id}
                type="button"
                disabled={bulkApproveBusy}
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
            </>
          )}
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
          internetAxesText={internetAxesText}
          setInternetAxesText={(value: string) => { discardSavedInternetPlan(detail.exam.id); setInternetAxesText(value); setInternetSelectedTopics({}); setInternetPlanReviewed(false) }}
          internetSelectedTopics={internetSelectedTopics}
          onToggleInternetAxis={(topic: string, checked: boolean) => { discardSavedInternetPlan(detail.exam.id); setInternetSelectedTopics((prev) => ({ ...prev, [topic]: checked })); setInternetPlanReviewed(false) }}
          onSelectAllInternetAxes={() => { discardSavedInternetPlan(detail.exam.id); setInternetSelectedTopics(Object.fromEntries(internetAxesText.split('\n').map((topic) => topic.trim()).filter(Boolean).map((topic) => [topic, true]))); setInternetPlanReviewed(false) }}
          onClearInternetAxes={() => { discardSavedInternetPlan(detail.exam.id); setInternetSelectedTopics({}); setInternetPlanReviewed(false) }}
          internetPlanBasis={internetPlanBasis}
          internetPlanBusy={internetPlanBusy}
          internetPlanReviewed={internetPlanReviewed}
          setInternetPlanReviewed={(checked: boolean) => { if (!checked) discardSavedInternetPlan(detail.exam.id); setInternetPlanReviewed(checked) }}
          internetPlanStored={internetPlanStored}
          internetRunBusy={internetRunBusy}
          internetRunProgress={internetRunProgress}
          onCreateInternetPlan={() => createInternetPlan()}
          onOpenManualInternetPlan={openManualInternetPlan}
          onRunComprehensiveInternetPlan={runComprehensiveInternetPlan}
          onStopInternetPlan={pauseComprehensiveInternetPlan}
          onResumeInternetPlan={resumeComprehensiveInternetPlan}
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
          rejectReason={rejectReason}
          setRejectReason={setRejectReason}
          selectedQuestionIds={selectedQuestionIds}
          setSelectedQuestionIds={setSelectedQuestionIds}
          bulkApproveBusy={bulkApproveBusy}
          bulkApproveProgress={bulkApproveProgress}
          onApproveSelected={approveSelectedQuestions}
          onReview={reviewQuestion}
          onDelete={deleteQuestion}
          onStartEdit={startEdit}
        />
      )}

      {actionDialog}
      {editingQuestion && (
        <Dialog open onOpenChange={(open) => { if (!open && !savingEdit) setEditingId(null) }}>
          <DialogContent dir="rtl" showCloseButton={!savingEdit}
            className="max-h-[92dvh] overflow-y-auto rounded-2xl sm:max-w-lg"
            onCloseAutoFocus={(event) => {
              if (editTriggerRef.current?.isConnected) {
                event.preventDefault()
                editTriggerRef.current.focus({ preventScroll: true })
              }
            }}>
            <DialogHeader className="text-right sm:text-right">
              <DialogTitle>تعديل السؤال رقم {editingQuestion.order}</DialogTitle>
              <DialogDescription>عدّل نص السؤال وحدّد الإجابة الصحيحة. حفظ التعديلات يعيد السؤال المعتمد إلى المراجعة.</DialogDescription>
            </DialogHeader>
            <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void saveEdit(editingQuestion) }}>
              <fieldset disabled={savingEdit} className="min-w-0 space-y-3">
                <Label htmlFor="exam-question-text">نص السؤال</Label>
                <Textarea id="exam-question-text" value={editText} onChange={(event) => setEditText(event.target.value)} rows={3} />
                <fieldset className="min-w-0 space-y-2">
                  <legend className="text-sm font-bold">الخيارات والإجابة الصحيحة</legend>
                  {editOptions.map((option, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <input type="radio" id={`exam-edit-answer-${index}`} name="exam-edit-answer"
                        aria-label={`تعيين الخيار ${index + 1} إجابة صحيحة`} checked={editAnswer === String(index)}
                        onChange={() => setEditAnswer(String(index))} />
                      {editingQuestion.type === 'TF'
                        ? <Label htmlFor={`exam-edit-answer-${index}`}>{option}</Label>
                        : <Input aria-label={`نص الخيار ${index + 1}`} value={option} onChange={(event) => {
                            const value = event.target.value
                            setEditOptions((previous) => previous.map((item, i) => i === index ? value : item))
                          }} />}
                    </div>
                  ))}
                </fieldset>
              </fieldset>
              <DialogFooter>
                <Button type="button" variant="outline" disabled={savingEdit} onClick={() => setEditingId(null)}>إلغاء</Button>
                <Button type="submit" disabled={savingEdit}>{savingEdit ? 'جارٍ الحفظ…' : 'حفظ التعديل'}</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
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
  const remainingExamSlots = Math.max(0, 100 - detail.counts.approved - detail.counts.pending)
  const selectable = (filteredQuestions as ExamQuestion[]).filter((q) => q.status === 'PENDING_REVIEW')
  const selectedVisible = selectable.filter((q) => props.selectedQuestionIds.includes(q.id))
  const allVisibleSelected = selectable.length > 0 && selectedVisible.length === selectable.length
  const suggestedAxes = String(props.internetAxesText || '').split('\n').map((axis) => axis.trim()).filter(Boolean)
  const chosenAxesCount = suggestedAxes.filter((axis) => props.internetSelectedTopics?.[axis]).length
  // Sections collapse state — the questions list starts collapsed (it is the
  // 100-row wall); everything else starts open. Collapsing only hides the
  // body: all working state lives in the parent and is never reset.
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({ questions: true })
  const toggleSection = (key: string) => setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }))

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-black">{exam.title}</h4>
            <div className="flex items-center gap-2">
              <Badge variant={exam.status === 'READY' ? 'default' : 'secondary'}>{STATUS_LABEL[exam.status] || exam.status}</Badge>
              <SectionCollapseButton collapsed={!!collapsedSections.settings} onToggle={() => toggleSection('settings')} />
            </div>
          </div>
          {!collapsedSections.settings && (
            <>
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
            </>
          )}
        </CardContent>
      </Card>

      {isDraft && (
        <>
          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-black">إضافة سؤال يدوي (صح/خطأ أو اختيار متعدد — لا مقالي)</h4>
                <SectionCollapseButton collapsed={!!collapsedSections.manual} onToggle={() => toggleSection('manual')} />
              </div>
              {!collapsedSections.manual && (
                <>
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
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-sm font-black">من الكتب المرفوعة — عبر بنك الأسئلة المعتمد</h4>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={props.onLoadBank} disabled={props.bankLoading}>
                    {props.bankLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} تحميل المعتمدة
                  </Button>
                  <SectionCollapseButton collapsed={!!collapsedSections.bank} onToggle={() => toggleSection('bank')} />
                </div>
              </div>
              {!collapsedSections.bank && (
                <>
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
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-black">استيراد ملف أسئلة</h4>
                <SectionCollapseButton collapsed={!!collapsedSections.import} onToggle={() => toggleSection('import')} />
              </div>
              {!collapsedSections.import && (
                <>
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
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-black">رفع كتاب مخصص وتوليد أسئلة منه</h4>
                <SectionCollapseButton collapsed={!!collapsedSections.customBook} onToggle={() => toggleSection('customBook')} />
              </div>
              {!collapsedSections.customBook && (
                <>
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
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-black">بحث الذكاء عبر الإنترنت</h4>
                <SectionCollapseButton collapsed={!!collapsedSections.internet} onToggle={() => toggleSection('internet')} />
              </div>
              {!collapsedSections.internet && (
                <>
              <div className="rounded-lg border border-indigo-200 bg-indigo-50/70 p-3 space-y-2">
                <h5 className="text-sm font-bold text-indigo-900">امتحان شامل موزع على محاور التخصص</h5>
                <p className="text-xs text-indigo-900">
                  يحضّر مخططاً من 5 إلى 10 محاور من وحدات التخصص المعتمدة أو مقترحات الذكاء. راجع المحاور وعدّلها أولاً، ثم يبحث عن مصادر لكل محور
                  ويولّد أسئلة فهم وتطبيق وتحليل. كل دفعة بحد أقصى 10 أسئلة، ويواصل تلقائياً حتى سقف 100 سؤال أو نفاد الأدلة العلمية؛ ويمكن استكمال النقص لاحقاً.
                  أي سؤال يُحفظ بانتظار مراجعتك، ولا يُملأ النقص بأسئلة مخترعة.
                </p>
                <Button variant="outline" disabled={!isDraft || props.internetBusy || props.internetPlanBusy || props.internetRunBusy} onClick={props.onCreateInternetPlan}>
                  {props.internetPlanBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  تحضير محاور التخصص
                </Button>
                <Button variant="outline" disabled={!isDraft || props.internetRunBusy || props.internetPlanBusy} onClick={props.onOpenManualInternetPlan}>كتابة المحاور يدوياً</Button>
                {props.internetPlanBusy && <p className="text-xs text-indigo-700">جارٍ إعداد المحاور — قد تستغرق العملية دقيقة…</p>}
                {!!props.internetPlanBasis && (
                  <div className="space-y-2">
                    <p className="text-xs text-indigo-800">
                      {props.internetPlanBasis === 'CURRICULUM' ? 'المحاور مأخوذة من الوحدات المعتمدة للتخصص.' : props.internetPlanBasis === 'MIXED' ? 'المحاور تجمع وحدات معتمدة ومقترحات ذكاء لإكمال التغطية؛ راجع المقترحات قبل التشغيل.' : props.internetPlanBasis === 'MANUAL' ? 'اكتب المحاور العلمية التي تريد إضافتها، كل محور بسطر، ثم حدد المحاور المطلوب الامتحان فيها.' : 'هذه محاور مقترحة بالذكاء، وليست منهجاً معتمداً. راجع ملاءمتها للتخصص قبل التشغيل.'}
                    </p>
                    <Textarea rows={10} dir="rtl" value={props.internetAxesText} disabled={props.internetRunBusy} onChange={(e: ChangeEvent<HTMLTextAreaElement>) => props.setInternetAxesText(e.target.value)} aria-label="محاور الامتحان الشامل — محور في كل سطر" />
                    <p className="text-[11px] text-slate-600">المحاور المقترحة: {suggestedAxes.length}. حدّد فقط المحاور التي تريدها؛ الاختيار النهائي لك. عند تحرير القائمة ستُلغى التحديدات السابقة.</p>
                    <div className="rounded-md border border-indigo-200 bg-white p-2 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-bold text-indigo-900">المحاور المختارة: {chosenAxesCount} من {suggestedAxes.length}</p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" disabled={props.internetRunBusy || !suggestedAxes.length} onClick={props.onSelectAllInternetAxes}>تحديد جميع المحاور</Button>
                          <Button size="sm" variant="outline" disabled={props.internetRunBusy || !chosenAxesCount} onClick={props.onClearInternetAxes}>إلغاء التحديد</Button>
                        </div>
                      </div>
                      {suggestedAxes.map((axis, index) => (
                        <label key={`${index}-${axis}`} className="flex items-start gap-2 text-xs text-slate-800 cursor-pointer">
                          <input type="checkbox" className="mt-0.5" disabled={props.internetRunBusy} checked={Boolean(props.internetSelectedTopics?.[axis])} onChange={(e: ChangeEvent<HTMLInputElement>) => props.onToggleInternetAxis(axis, e.target.checked)} />
                          <span>{axis}</span>
                        </label>
                      ))}
                    </div>
                    {chosenAxesCount > 0 && chosenAxesCount < 5 && <p className="text-xs text-amber-800">تنبيه: اختيار أقل من خمسة محاور يعني تغطية أضيق للتخصص، لكنه مسموح إذا كان هذا مقصوداً.</p>}
                    <p className="text-[11px] text-indigo-800">لكل محور مختار: ثلاثة أبحاث ويب متقدمة (نظريات، دراسات علمية، وحالات تطبيقية) من مواقع مستقلة. يوزّع النظام العدد المستهدف بالتساوي، ويبلغك بالنقص بدل اختراع الأسئلة. البحث المتقدم يستهلك نقاط Tavily أكثر من البحث العادي.</p>
                    {props.internetPlanStored && (
                      <p className="rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900" role="status">
                        مخطط المحاور محفوظ. عند بدء التوليد يحتفظ الخادم بالمهمة ويواصل إنشاء الأسئلة حتى لو أغلقت الصفحة أو خرجت منها. بعد العودة يظهر التقدم ويمكن استكمال النقص.
                        المتبقي من سعة الامتحان ككل: {remainingExamSlots} من 100 سؤال.
                      </p>
                    )}
                    <label className="flex items-start gap-2 text-xs text-indigo-900">
                      <input type="checkbox" checked={props.internetPlanReviewed} disabled={props.internetRunBusy || !chosenAxesCount} onChange={(e: ChangeEvent<HTMLInputElement>) => props.setInternetPlanReviewed(e.target.checked)} className="mt-1" />
                      راجعت المحاور المختارة وتأكدت أنها تمثل كفاءات التخصص العلمية ولا تتناول شروط القبول أو وصف الدرجة، وأوافق على استهلاك رصيد Tavily للبحث المتقدم (نحو 6 نقاط لكل دفعة من ثلاثة أبحاث).
                    </label>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button disabled={!isDraft || props.internetBusy || !chosenAxesCount || !props.internetPlanReviewed || props.internetRunBusy || props.internetPlanBusy || !remainingExamSlots} onClick={props.onRunComprehensiveInternetPlan}>
                        {props.internetRunBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : props.internetPlanStored ? <RefreshCw className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                        {props.internetPlanStored ? 'استكمال الأسئلة الناقصة' : 'توليد الأسئلة حسب المخطط'}
                      </Button>
                      {props.internetRunBusy && <Button variant="outline" onClick={props.onStopInternetPlan}>إيقاف بعد الدفعة الحالية</Button>}
                    </div>
                    {props.internetRunProgress && (
                      <div className="text-xs text-indigo-900 space-y-1" role="status" aria-live="polite">
                        <p className="font-semibold">{props.internetRunProgress.status === 'QUEUED' ? 'في قائمة الانتظار — سيواصل الخادم التوليد ولو غادرت الصفحة' : props.internetRunProgress.status === 'RUNNING' ? 'جارٍ إنشاء الأسئلة في الخلفية — يمكن مغادرة الصفحة' : props.internetRunProgress.status === 'PAUSED' ? 'متوقف مؤقتاً — راجع التنبيهات ثم استكمل' : props.internetRunProgress.status === 'COMPLETED_WITH_GAPS' ? 'اكتمل العمل مع نقص في بعض المحاور — راجع التفاصيل' : 'اكتمل توليد المحاور'}</p>
                        <p>المحور {props.internetRunProgress.axis} من {props.internetRunProgress.total} — أُضيف {props.internetRunProgress.imported} سؤالاً بانتظار المراجعة</p>
                        {props.internetRunProgress.retryAt && <p className="text-amber-800">سيحاول الخادم مجدداً تلقائياً بعد تعافٍ مؤقت من الخطأ.</p>}
                        {props.internetRunProgress.errors.map((error: string, index: number) => <p key={`${index}-${error}`} className="text-amber-800">{error}</p>)}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                أو ابحث في محور واحد فقط: يبحث الذكاء في الويب (Tavily) عن محور علمي داخل تخصص الامتحان، ثم يولّد أسئلة كفاءة تخصصية بدليل حرفي ورابط مصدر، وكلها بانتظار المراجعة.
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
                <Button disabled={!isDraft || props.internetBusy || props.internetRunBusy || !props.internetTopic?.trim()} onClick={props.onRunInternet}>
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
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-black">أسئلة الامتحان ({detail.questions.length})</h4>
            <div className="flex flex-wrap items-center gap-2">
              {isDraft && selectable.length > 0 && (
                <>
                  <Button size="sm" disabled={props.bulkApproveBusy || selectedVisible.length === 0} onClick={props.onApproveSelected}>
                    {props.bulkApproveBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                    اعتماد المحدد ({selectedVisible.length})
                  </Button>
                  {props.bulkApproveBusy && props.bulkApproveProgress && (
                    <span role="status" className="text-xs text-slate-600">جارٍ معالجة {props.bulkApproveProgress.processed} من {props.bulkApproveProgress.total} سؤالاً…</span>
                  )}
                </>
              )}
              <Select value={statusFilter} onValueChange={setStatusFilter} disabled={props.bulkApproveBusy}>
                <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">كل الحالات</SelectItem>
                  <SelectItem value="PENDING_REVIEW">بانتظار المراجعة</SelectItem>
                  <SelectItem value="APPROVED">معتمدة</SelectItem>
                  <SelectItem value="REJECTED">مرفوضة</SelectItem>
                </SelectContent>
              </Select>
              <SectionCollapseButton collapsed={!!collapsedSections.questions} onToggle={() => toggleSection('questions')} />
            </div>
          </div>
          {!collapsedSections.questions && (
            <>
          {isDraft && selectable.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-2 text-xs">
              <label className="flex cursor-pointer items-center gap-2 font-bold">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  disabled={props.bulkApproveBusy}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const visible = new Set(selectable.map((q) => q.id))
                    props.setSelectedQuestionIds((ids: string[]) => e.target.checked
                      ? [...new Set([...ids, ...visible])]
                      : ids.filter((id) => !visible.has(id)))
                  }}
                />
                تحديد الكل ({selectable.length} بانتظار المراجعة)
              </label>
            </div>
          )}
          <div className="space-y-2">
            {filteredQuestions.map((q: ExamQuestion) => (
              <QuestionRow key={q.id} q={q} isDraft={isDraft} {...props} />
            ))}
            {filteredQuestions.length === 0 && <p className="text-xs text-slate-500">لا توجد أسئلة بهذه الحالة بعد.</p>}
          </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function QuestionRow(props: any) {
  const { q, isDraft } = props
  const options = parseOptions(q.options)
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {isDraft && q.status === 'PENDING_REVIEW' && (
          <label className="flex cursor-pointer items-center gap-1 font-bold">
            <input
              type="checkbox"
              aria-label={`تحديد السؤال ${q.order} للاعتماد`}
              checked={props.selectedQuestionIds.includes(q.id)}
              disabled={props.bulkApproveBusy}
              onChange={(e: ChangeEvent<HTMLInputElement>) => props.setSelectedQuestionIds((ids: string[]) =>
                e.target.checked ? [...new Set([...ids, q.id])] : ids.filter((id) => id !== q.id))}
            />
            تحديد
          </label>
        )}
        <span className="font-black">#{q.order}</span>
        <Badge variant="secondary">{q.type === 'TF' ? 'صح/خطأ' : 'اختيار متعدد'}</Badge>
        <Badge variant={q.status === 'APPROVED' ? 'default' : q.status === 'REJECTED' ? 'destructive' : 'secondary'}>
          {STATUS_LABEL[q.status] || q.status}
        </Badge>
        <span className="text-slate-500">المصدر: {SOURCE_LABEL[q.source] || q.source}</span>
      </div>
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
            <Button size="sm" variant="outline" disabled={props.bulkApproveBusy} onClick={() => props.onReview(q, 'APPROVED')}><Check className="h-3.5 w-3.5" /> اعتماد</Button>
          )}
          {q.status !== 'REJECTED' && (
            <>
              <Input
                value={props.rejectReason}
                placeholder="سبب الرفض (مطلوب للرفض)"
                className="w-48"
                onChange={(e: ChangeEvent<HTMLInputElement>) => props.setRejectReason(e.target.value)}
              />
              <Button size="sm" variant="outline" disabled={props.bulkApproveBusy} onClick={() => props.onReview(q, 'REJECTED')}><X className="h-3.5 w-3.5" /> رفض</Button>
            </>
          )}
          <Button size="sm" variant="outline" onClick={(e) => props.onStartEdit(q, e.currentTarget)}>تعديل</Button>
          <Button size="sm" variant="outline" onClick={() => props.onDelete(q)}><Trash2 className="h-3.5 w-3.5" /> حذف</Button>
        </div>
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
type CandidateAttempt = { id: string; status: string; score: number | null; passed: boolean | null; startedAt: string; submittedAt: string | null; certificateSerial?: string | null; certificateId?: string | null; certificateUploadedFileKey?: string | null; certificateStampedFileKey?: string | null; certificateQrPosition?: string | null; certificateQrSize?: string | null }
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
  const [candidatesCollapsed, setCandidatesCollapsed] = useState(false)
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
  const [certStampLayoutByCandidate, setCertStampLayoutByCandidate] = useState<Record<string, CertificateStampLayout>>({})
  const [certSelectedStampFieldByCandidate, setCertSelectedStampFieldByCandidate] = useState<Record<string, CertificateStampField>>({})
  const [certBackdropUrlByCandidate, setCertBackdropUrlByCandidate] = useState<Record<string, string | null>>({})
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
  const certStampLayout = (c: CandidateItem) => certStampLayoutByCandidate[c.id] || parseCertificateStampLayout(c.attempt?.certificateQrPosition, c.attempt?.certificateQrSize)
  const certStampLayoutJson = (c: CandidateItem) => serializeStampLayout(certStampLayout(c))
  const certSelectedStampField = (c: CandidateItem) => certSelectedStampFieldByCandidate[c.id] || 'qr'

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
        fd.append('stampLayout', certStampLayoutJson(c))
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
          [c.id]: `${certUploadUrl(c)}?layout=${encodeURIComponent(certStampLayoutJson(c))}&t=${Date.now()}`,
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
      fd.append('stampLayout', certStampLayoutJson(c))
      const data = await jsonOrThrow(await fetch(certUploadUrl(c), { method: 'POST', body: fd }), 'تعذر حفظ الشهادة المختومة')
      toast({ title: 'تم حفظ الشهادة المختومة', description: data.stampedFileKey || c.attempt?.certificateSerial || '' })
      setCertFileByCandidate((prev) => ({ ...prev, [c.id]: null }))
      const backdrop = certBackdropUrlByCandidate[c.id]
      if (backdrop) URL.revokeObjectURL(backdrop)
      setCertBackdropUrlByCandidate((prev) => ({ ...prev, [c.id]: null }))
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
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={loadCandidates}><RefreshCw className="h-3.5 w-3.5" /> تحديث</Button>
            <SectionCollapseButton collapsed={candidatesCollapsed} onToggle={() => setCandidatesCollapsed((prev) => !prev)} />
          </div>
        </div>
        {!candidatesCollapsed && (
          <>
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
                    <Input type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      const file = e.target.files?.[0] || null
                      const oldBackdrop = certBackdropUrlByCandidate[c.id]
                      if (oldBackdrop) URL.revokeObjectURL(oldBackdrop)
                      setCertBackdropUrlByCandidate((prev) => ({ ...prev, [c.id]: file && file.type.startsWith('image/') ? URL.createObjectURL(file) : null }))
                      setCertFileByCandidate((prev) => ({ ...prev, [c.id]: file }))
                    }} />
                    {certFileByCandidate[c.id] && <p className="text-[11px] text-slate-500">{certFileByCandidate[c.id]?.name}</p>}
                    <CertificateStampEditor
                      layout={certStampLayout(c)}
                      onLayoutChange={(next) => setCertStampLayoutByCandidate((prev) => ({ ...prev, [c.id]: next }))}
                      fields={['qr', 'serial']}
                      fieldTexts={{ qr: 'QR', serial: c.attempt?.certificateSerial || '' }}
                      backdropUrl={certBackdropUrlByCandidate[c.id] || null}
                      backdropEmptyText={c.attempt?.certificateUploadedFileKey
                        ? 'الملف الأصلي PDF — اضبط المواضع هنا ثم اضغط معاينة لرؤية النتيجة تحت المحرر مباشرة.'
                        : 'ارفع صورة للشهادة لعرضها هنا مباشرة، أو استخدم هذه المساحة لضبط الموضع ثم اضغط معاينة عند رفع PDF.'}
                      selectedField={certSelectedStampField(c)}
                      onSelectedFieldChange={(field) => setCertSelectedStampFieldByCandidate((prev) => ({ ...prev, [c.id]: field }))}
                      hint="اسحب أي عنصر لتحريكه، واسحب المقبض الذهبي الصغير لتكبيره أو تصغيره."
                    />
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
          </>
        )}
      </CardContent>
    </Card>
  )
}
