'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { api, getToken } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { CertificateDialog, CertificateData } from '@/components/aact/CertificateDialog'
import { AdminAITab } from '@/components/aact/AdminAITab'
import { AdminListToolbar, AdminPager, matchesAdminSearch, pageItems, safePage } from '@/components/aact/AdminListTools'
import { RefreshPaymentAmountButton } from '@/components/aact/RefreshPaymentAmountButton'
import { useAdminActionDialog } from '@/components/aact/AdminActionDialog'
import {
  Loader2, Gavel, CalendarClock, CheckCircle2, XCircle, Banknote, TrendingUp, Globe2,
  Award, Settings2, ScrollText, Mail, FileDown, Plus, Users2, ReceiptText, Bot,
  FileSignature, Video, RefreshCw, ShieldCheck, Trash2, KeyRound, Upload, Eye, ExternalLink, FileText,
} from 'lucide-react'

const DefenseRoom = dynamic(
  () => import('@/components/aact/DefenseRoom').then((mod) => mod.DefenseRoom),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-2xl bg-slate-50 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
        <p className="text-sm font-black text-[#0f2b46]">جاري تجهيز قاعة المناقشة...</p>
      </div>
    ),
  }
)

// ============ جدولة المناقشات واللجان ============

interface ThesisReviewNoteItem {
  id: string
  stage: string
  action: string
  note: string
  authorName?: string | null
  visibleToStudent?: boolean
  createdAt: string
}

interface Thesis {
  id: string
  title: string
  abstract: string
  reviewNote?: string | null
  reviewNotes?: ThesisReviewNoteItem[]
  status: string
  defenseDate?: string | null
  committee?: string | null
  agentMember?: string | null
  defenseStatus?: string | null
  aiScore?: number | null
  aiRecommendation?: string | null
  defenseMinutes?: string | null
  recordingSize?: number | null
  recordingDurationSec?: number | null
  hasRecording?: boolean | null
  resultScore?: number | null
  passed?: boolean | null
  createdAt: string
  user?: { id: string; name: string; email: string; country?: string | null } | null
  admission?: { id: string; reference: string; program: string; status: string } | null
}

function safeText(value: unknown, fallback = ''): string {
  const text = String(value ?? '').trim()
  return text || fallback
}

function parseCommitteeNames(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map((x) => safeText(x)).filter(Boolean).slice(0, 8)
    if (typeof parsed === 'string') return parsed.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 8)
    if (parsed && typeof parsed === 'object') return Object.values(parsed).map((x) => safeText(x)).filter(Boolean).slice(0, 8)
  } catch {}
  return raw.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 8)
}

function formatArabicDate(value?: string | null): string {
  if (!value) return 'موعد غير محدد'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'موعد غير صالح يحتاج إعادة جدولة'
  return date.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' })
}

export function AdminThesisTab() {
  const { toast } = useToast()
  const { promptAction, dialog: actionDialog } = useAdminActionDialog()
  const [theses, setTheses] = useState<Thesis[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sched, setSched] = useState<Thesis | null>(null)
  const [date, setDate] = useState('')
  const [members, setMembers] = useState('')
  const [agentMember, setAgentMember] = useState('')
  const [busy, setBusy] = useState(false)
  const [resulting, setResulting] = useState<Thesis | null>(null)
  const [score, setScore] = useState('85')
  const [passed, setPassed] = useState('true')
  // 12.3: دخول الإدارة للقاعة كعضو لجنة + محضر الجلسة + التسجيل المؤرشف
  const [roomThesis, setRoomThesis] = useState<Thesis | null>(null)
  const [minutesThesis, setMinutesThesis] = useState<Thesis | null>(null)
  const [showRecording, setShowRecording] = useState<Thesis | null>(null)
  const [thesisSearch, setThesisSearch] = useState('')
  const [thesisStatusFilter, setThesisStatusFilter] = useState('ACTIVE')
  const [thesisPage, setThesisPage] = useState(1)
  const [thesisPageSize, setThesisPageSize] = useState(10)

  const load = () => {
    setLoading(true)
    setLoadError(null)
    api<{ theses: Thesis[] }>('/api/admin/thesis')
      .then((d) => {
        setTheses(Array.isArray(d.theses) ? d.theses : [])
        setLoadError(null)
      })
      .catch((e) => {
        setTheses([])
        const msg = e?.message || 'حدث خطأ أثناء تحميل بيانات المناقشات'
        setLoadError(msg)
        toast({ title: 'تعذر تحميل أبحاث التخرج', description: msg, variant: 'destructive' })
      })
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const schedule = async () => {
    if (!sched) return
    setBusy(true)
    try {
      await api('/api/admin/thesis', {
        method: 'PATCH',
        body: JSON.stringify({
          id: sched.id,
          action: 'SCHEDULE',
          defenseDate: date,
          committee: JSON.stringify(members.split(/[,،\n]/).map((s) => s.trim()).filter(Boolean)),
          agentMember,
        }),
      })
      toast({ title: 'تمت الجدولة', description: 'حُدد موعد المناقشة وأُبلغ الطالب — وإن أُضيف عضو وكيل سُجل مستحقه 100$ تلقائياً' })
      setSched(null)
      load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const thesisAction = async (thesis: Thesis, action: 'APPROVE_PLAN' | 'REQUEST_PLAN_REVISION' | 'REQUEST_FINAL_REVISION') => {
    const reviewNote = await promptAction({
      title: action === 'APPROVE_PLAN' ? 'اعتماد خطة البحث' : action === 'REQUEST_FINAL_REVISION' ? 'طلب تعديل البحث النهائي' : 'طلب تعديل خطة البحث',
      description: action === 'APPROVE_PLAN'
        ? 'اكتب ملاحظة اختيارية تظهر للطالب مع اعتماد الخطة.'
        : action === 'REQUEST_FINAL_REVISION'
          ? 'اكتب ملاحظة تعديل البحث النهائي التي ستظهر للطالب.'
          : 'اكتب ملاحظة التعديل التي ستظهر للطالب.',
      fieldLabel: 'ملاحظة للطالب',
      defaultValue: thesis.reviewNote || '',
      multiline: true,
      confirmLabel: 'متابعة',
      tone: action === 'APPROVE_PLAN' ? 'success' : 'warning',
    })
    if (reviewNote === null) return
    setBusy(true)
    try {
      await api('/api/admin/thesis', {
        method: 'PATCH',
        body: JSON.stringify({ id: thesis.id, action, reviewNote }),
      })
      toast({
        title: action === 'APPROVE_PLAN' ? 'تم اعتماد الخطة' : action === 'REQUEST_FINAL_REVISION' ? 'تم طلب تعديل البحث النهائي' : 'تم طلب تعديل الخطة',
        description: action === 'APPROVE_PLAN'
          ? 'أُبلغ الطالب ويمكنه الآن تسليم البحث النهائي'
          : action === 'REQUEST_FINAL_REVISION'
            ? 'أُبلغ الطالب أن البحث النهائي يحتاج تعديلاً قبل المناقشة'
            : 'أُبلغ الطالب أن خطة البحث تحتاج تعديلاً',
      })
      load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const recordResult = async () => {
    if (!resulting) return
    const reviewNote = await promptAction({
      title: 'اعتماد نتيجة المناقشة',
      description: 'اكتب ملاحظة اختيارية على نتيجة المناقشة تظهر في سجل الطالب.',
      fieldLabel: 'ملاحظة النتيجة',
      defaultValue: resulting.reviewNote || '',
      multiline: true,
      confirmLabel: 'اعتماد النتيجة',
      tone: 'success',
    })
    if (reviewNote === null) return
    setBusy(true)
    try {
      await api('/api/admin/thesis', {
        method: 'PATCH',
        body: JSON.stringify({ id: resulting.id, action: 'RESULT', resultScore: parseFloat(score), passed: passed === 'true', reviewNote }),
      })
      toast({ title: 'تم اعتماد النتيجة', description: 'أُبلغ الطالب بالنتيجة وتحديث حالة طلبه' })
      setResulting(null)
      load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const filteredTheses = useMemo(() => theses.filter((t) => {
    const active = !['RESULT_APPROVED'].includes(t.status)
    const statusOk = thesisStatusFilter === 'ALL' || (thesisStatusFilter === 'ACTIVE' && active) || t.status === thesisStatusFilter
    return statusOk && matchesAdminSearch(thesisSearch, [t.title, t.abstract, t.status, t.user?.name, t.user?.email, t.admission?.program, t.admission?.reference])
  }), [theses, thesisSearch, thesisStatusFilter])
  const pagedTheses = pageItems(filteredTheses, thesisPage, thesisPageSize)
  const currentThesisPage = safePage(filteredTheses.length, thesisPageSize, thesisPage)

  if (loading) return (
    <Card className="mt-4 border-[#0f2b46]/10">
      <CardContent className="flex h-48 flex-col items-center justify-center gap-3 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
        <p className="text-sm font-black text-[#0f2b46]">جاري تحميل أبحاث التخرج والمناقشات...</p>
        <p className="text-xs font-bold text-slate-400">يتم الآن جلب الملخصات فقط بدون تحميل تسجيلات الفيديو الثقيلة.</p>
      </CardContent>
    </Card>
  )

  const ST: Record<string, { label: string; cls: string }> = {
    PLAN_SUBMITTED: { label: 'خطة البحث قيد المراجعة', cls: 'bg-amber-100 text-amber-700' },
    PLAN_NEEDS_REVISION: { label: 'خطة البحث تحتاج تعديلًا', cls: 'bg-red-100 text-red-600' },
    PLAN_APPROVED: { label: 'خطة البحث معتمدة', cls: 'bg-emerald-100 text-emerald-700' },
    FINAL_NEEDS_REVISION: { label: 'البحث النهائي يحتاج تعديلًا', cls: 'bg-red-100 text-red-600' },
    SUBMITTED: { label: 'البحث النهائي — بانتظار الجدولة', cls: 'bg-amber-100 text-amber-700' },
    SCHEDULED: { label: 'مجدول للمناقشة', cls: 'bg-blue-100 text-blue-700' },
    RESULT_APPROVED: { label: 'تم اعتماد النتيجة', cls: 'bg-emerald-100 text-emerald-700' },
    NEEDS_REVISION: { label: 'يحتاج تعديلات', cls: 'bg-red-100 text-red-600' },
  }

  return (
    <div className="mt-4 space-y-4">
      {actionDialog}
      <div className="flex flex-col gap-3 rounded-2xl border border-[#0f2b46]/10 bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-black text-[#0f2b46]">أبحاث التخرج والمناقشات</h2>
          <p className="mt-1 text-xs font-bold leading-5 text-slate-500">
            تعرض هذه القائمة ملخصات الأبحاث فقط لتفتح بسرعة، أما تسجيل الفيديو فيُحمّل عند الضغط على تشغيل التسجيل.
          </p>
        </div>
        <Button onClick={load} variant="outline" className="w-full border-[#c9a227]/50 text-xs font-black text-[#a8841a] hover:bg-[#fff7df] sm:w-auto">
          <RefreshCw className="ml-1.5 h-4 w-4" /> تحديث القائمة
        </Button>
      </div>

      <AdminListToolbar
        search={thesisSearch}
        onSearchChange={(v) => { setThesisSearch(v); setThesisPage(1) }}
        searchPlaceholder="ابحث باسم الباحث أو عنوان البحث أو البرنامج أو كود الطلب..."
        status={thesisStatusFilter}
        onStatusChange={(v) => { setThesisStatusFilter(v); setThesisPage(1) }}
        statusOptions={[
          { value: 'ACTIVE', label: 'النشطة فقط' },
          { value: 'PLAN_SUBMITTED', label: 'خطة قيد المراجعة' },
          { value: 'PLAN_NEEDS_REVISION', label: 'خطة تحتاج تعديل' },
          { value: 'PLAN_APPROVED', label: 'خطة معتمدة' },
          { value: 'SUBMITTED', label: 'بحث نهائي مسلم' },
          { value: 'SCHEDULED', label: 'مجدول' },
          { value: 'RESULT_APPROVED', label: 'نتيجة معتمدة' },
          { value: 'ALL', label: 'كل الأبحاث' },
        ]}
        pageSize={thesisPageSize}
        onPageSizeChange={(v) => { setThesisPageSize(v); setThesisPage(1) }}
        total={theses.length}
        filtered={filteredTheses.length}
        label="بحث"
      />

      {loadError ? (
        <Card className="border-red-100 bg-red-50">
          <CardContent className="p-6 text-center">
            <XCircle className="mx-auto mb-2 h-8 w-8 text-red-500" />
            <p className="text-sm font-black text-red-700">تعذر تحميل أبحاث التخرج</p>
            <p className="mt-1 text-xs font-bold text-red-600">{loadError}</p>
            <Button onClick={load} className="mt-4 bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#12365c]">
              إعادة المحاولة
            </Button>
          </CardContent>
        </Card>
      ) : theses.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد أبحاث تخرج مسلَّمة بعد</CardContent></Card>
      ) : filteredTheses.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد أبحاث مطابقة للبحث أو الفلتر الحالي.</CardContent></Card>
      ) : (
        <>
        {pagedTheses.map((t) => {
          const committee = parseCommitteeNames(t.committee)
          const studentName = safeText(t.user?.name, 'طالب غير محدد')
          const programName = safeText(t.admission?.program, 'برنامج غير محدد')
          const abstractText = safeText(t.abstract, 'لا يوجد ملخص محفوظ لهذا البحث')
          const journey = [
            { title: 'الخطة', done: ['PLAN_SUBMITTED', 'PLAN_APPROVED', 'FINAL_NEEDS_REVISION', 'SUBMITTED', 'SCHEDULED', 'RESULT_APPROVED'].includes(t.status), active: t.status === 'PLAN_SUBMITTED' || ['PLAN_NEEDS_REVISION', 'NEEDS_REVISION'].includes(t.status) },
            { title: 'اعتماد الخطة', done: ['PLAN_APPROVED', 'FINAL_NEEDS_REVISION', 'SUBMITTED', 'SCHEDULED', 'RESULT_APPROVED'].includes(t.status), active: t.status === 'PLAN_SUBMITTED' },
            { title: 'البحث النهائي', done: ['SUBMITTED', 'SCHEDULED', 'RESULT_APPROVED'].includes(t.status), active: ['PLAN_APPROVED', 'FINAL_NEEDS_REVISION'].includes(t.status) },
            { title: 'المناقشة', done: ['SCHEDULED', 'RESULT_APPROVED'].includes(t.status), active: t.status === 'SUBMITTED' },
            { title: 'النتيجة', done: t.status === 'RESULT_APPROVED', active: t.status === 'SCHEDULED' },
          ]
          return (
            <Card key={t.id} className="overflow-hidden border-[#0f2b46]/10">
              <CardContent className="p-4 sm:p-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start gap-2">
                      <h4 className="w-full text-sm font-black leading-6 text-[#0f2b46] sm:w-auto sm:text-base">{t.title}</h4>
                      <Badge className={ST[t.status]?.cls || 'bg-slate-100 text-slate-600'}>{ST[t.status]?.label || t.status}</Badge>
                      {t.admission && (
                        <span className="rounded-md bg-[#0f2b46] px-2 py-0.5 font-mono text-[10px] font-bold text-[#e0b83a]" dir="ltr">{t.admission.reference}</span>
                      )}
                    </div>
                    <p className="mt-1 text-xs font-bold text-slate-600">
                      الباحث: {studentName} — {programName}
                    </p>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{abstractText}</p>
                    {t.reviewNote ? (
                      <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] font-bold leading-6 text-amber-800">
                        <span className="font-black">ملاحظة الإدارة/المشرف:</span> {t.reviewNote}
                      </div>
                    ) : null}
                    {t.reviewNotes?.length ? (
                      <div className="mt-2 rounded-xl border border-slate-100 bg-white p-3">
                        <p className="mb-2 text-[11px] font-black text-[#0f2b46]">سجل الملاحظات</p>
                        <div className="max-h-32 space-y-1.5 overflow-y-auto">
                          {t.reviewNotes.slice(0, 4).map((note) => (
                            <div key={note.id} className="rounded-lg bg-slate-50 p-2 text-[10px] font-bold leading-5 text-slate-600">
                              <div className="flex flex-wrap items-center justify-between gap-1">
                                <span className="font-black text-[#0f2b46]">{note.stage === 'PLAN' ? 'خطة البحث' : note.stage === 'FINAL' ? 'البحث النهائي' : note.stage === 'RESULT' ? 'النتيجة' : 'عام'}</span>
                                <span className="text-slate-400">{new Date(note.createdAt).toLocaleDateString('ar-EG')}</span>
                              </div>
                              <p className="mt-0.5 whitespace-pre-line">{note.note}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    <div className="mt-3 grid gap-1.5 sm:grid-cols-5">
                      {journey.map((step, index) => (
                        <div key={step.title} className={`rounded-xl border px-2 py-2 ${step.done ? 'border-emerald-200 bg-emerald-50' : step.active ? 'border-[#c9a227] bg-[#fffaf0]' : 'border-slate-100 bg-slate-50'}`}>
                          <div className="flex items-center justify-between gap-1">
                            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-black ${step.done ? 'bg-emerald-600 text-white' : step.active ? 'bg-[#c9a227] text-white' : 'bg-white text-slate-400'}`}>{step.done ? '✓' : index + 1}</span>
                            <span className={`text-[9px] font-black ${step.done ? 'text-emerald-700' : step.active ? 'text-[#a8841a]' : 'text-slate-400'}`}>{step.done ? 'مكتملة' : step.active ? 'الحالية' : 'لاحقًا'}</span>
                          </div>
                          <p className="mt-1 text-[10px] font-black text-[#0f2b46]">{step.title}</p>
                        </div>
                      ))}
                    </div>
                    {t.status === 'SCHEDULED' && t.defenseDate && (
                      <p className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-bold text-blue-700">
                        <CalendarClock className="h-3.5 w-3.5" />
                        {formatArabicDate(t.defenseDate)}
                        — اللجنة: {committee.length ? committee.join('، ') : 'لم تُحفظ أسماء اللجنة'}
                        {t.agentMember ? ` + عضو الوكيل (${t.agentMember})` : ''}
                      </p>
                    )}
                    {/* نتيجة جلسة المناقشة المرئية وخبير الذكاء الاصطناعي */}
                    {t.aiScore != null && (
                      <div className="mt-2 rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/60 p-3">
                        <p className="flex flex-wrap items-center gap-2 text-xs font-black text-[#0f2b46]">
                          <Bot className="h-4 w-4 text-[#a8841a]" />
                          تقييم خبير الذكاء الاصطناعي: {t.aiScore}/100
                          <Badge className={t.aiScore >= 60 ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>
                            {t.aiScore >= 80 ? 'توصية بالقبول' : t.aiScore >= 60 ? 'قبول مع ملاحظات' : 'يحتاج مراجعة'}
                          </Badge>
                          {t.defenseStatus === 'COMPLETED' && <span className="text-[10px] font-bold text-slate-500">انتهت الجلسة</span>}
                        </p>
                        {t.aiRecommendation && (
                          <p className="mt-1.5 whitespace-pre-line text-[11px] font-semibold leading-relaxed text-[#5c4d1a]">{t.aiRecommendation}</p>
                        )}
                        {/* 12.3: محضر الجلسة والتسجيل المؤرشف */}
                        <div className="mt-2 flex flex-wrap gap-2">
                          {t.defenseMinutes && (
                            <Button size="sm" variant="outline" onClick={() => setMinutesThesis(t)} className="h-7 border-[#a8841a]/40 bg-white/60 text-[10px] font-black text-[#a8841a]">
                              <FileSignature className="ml-1 h-3 w-3" /> محضر الجلسة التلقائي
                            </Button>
                          )}
                          {t.recordingSize && (
                            <Button size="sm" variant="outline" onClick={() => setShowRecording(t)} className="h-7 border-[#0f2b46]/30 bg-white/60 text-[10px] font-black text-[#0f2b46]">
                              <Video className="ml-1 h-3 w-3" /> تشغيل تسجيل الجلسة ({Math.round((t.recordingSize || 0) / 1024)} ك.ب)
                            </Button>
                          )}
                        </div>
                      </div>
                    )}
                    {t.status === 'RESULT_APPROVED' && (
                      <p className={`mt-2 text-xs font-black ${t.passed ? 'text-emerald-600' : 'text-red-500'}`}>
                        النتيجة: {t.resultScore} — {t.passed ? 'مجتاز' : 'غير مجتاز'}
                      </p>
                    )}
                  </div>
                  <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 xl:w-56 xl:grid-cols-1">
                    {t.status === 'PLAN_SUBMITTED' && (
                      <>
                        <Button size="sm" onClick={() => thesisAction(t, 'APPROVE_PLAN')}
                          className="w-full justify-center bg-emerald-600 font-bold text-white hover:bg-emerald-700">
                          <CheckCircle2 className="ml-1 h-3.5 w-3.5" /> اعتماد خطة البحث
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => thesisAction(t, 'REQUEST_PLAN_REVISION')}
                          className="w-full justify-center border-amber-200 font-bold text-amber-700 hover:bg-amber-50">
                          طلب تعديل الخطة
                        </Button>
                      </>
                    )}
                    {t.status === 'SUBMITTED' && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => thesisAction(t, 'REQUEST_FINAL_REVISION')}
                          className="w-full justify-center border-amber-200 font-bold text-amber-700 hover:bg-amber-50">
                          طلب تعديل البحث النهائي
                        </Button>
                        <Button size="sm" onClick={() => { setSched(t); setDate(''); setMembers(''); setAgentMember('') }}
                          className="w-full justify-center bg-[#0f2b46] font-bold text-[#f5f0e1] hover:bg-[#12365c]">
                          <Gavel className="ml-1 h-3.5 w-3.5" /> جدولة المناقشة
                        </Button>
                      </>
                    )}
                    {['PLAN_NEEDS_REVISION', 'NEEDS_REVISION'].includes(t.status) && (
                      <Button size="sm" variant="outline" onClick={() => thesisAction(t, 'REQUEST_PLAN_REVISION')}
                        className="w-full justify-center border-amber-200 font-bold text-amber-700 hover:bg-amber-50">
                        تحديث ملاحظة تعديل الخطة
                      </Button>
                    )}
                    {t.status === 'FINAL_NEEDS_REVISION' && (
                      <Button size="sm" variant="outline" onClick={() => thesisAction(t, 'REQUEST_FINAL_REVISION')}
                        className="w-full justify-center border-amber-200 font-bold text-amber-700 hover:bg-amber-50">
                        تحديث ملاحظة تعديل البحث النهائي
                      </Button>
                    )}
                    {t.status === 'SCHEDULED' && (
                      <>
                        <Button size="sm" onClick={() => setRoomThesis(t)}
                          className="w-full justify-center bg-[#c9a227] font-bold text-[#0f2b46] hover:bg-[#e0b83a]">
                          <Video className="ml-1 h-3.5 w-3.5" /> دخول قاعة المناقشة
                        </Button>
                        <Button size="sm" onClick={() => setResulting(t)}
                          className="w-full justify-center bg-emerald-600 font-bold text-white hover:bg-emerald-700">
                          <CheckCircle2 className="ml-1 h-3.5 w-3.5" /> تسجيل النتيجة
                        </Button>
                      </>
                    )}
                    {t.status === 'RESULT_APPROVED' && (t.defenseMinutes || t.recordingSize) && (
                      <Button size="sm" variant="outline" onClick={() => setMinutesThesis(t)} className="w-full justify-center border-[#c9a227]/40 text-[10px] font-bold text-[#a8841a]">
                        <FileSignature className="ml-1 h-3 w-3" /> محضر الجلسة
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )
        })}
        <AdminPager page={currentThesisPage} pageSize={thesisPageSize} total={filteredTheses.length} onPageChange={setThesisPage} label="بحث" />
        </>
      )}

      {/* نافذة الجدولة */}
      <Dialog open={!!sched} onOpenChange={(v) => !v && setSched(null)}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
              <Gavel className="h-5 w-5 text-[#c9a227]" /> جدولة مناقشة بحث التخرج
            </DialogTitle>
            <DialogDescription>{sched?.title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label>تاريخ المناقشة *</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>أعضاء اللجنة المتخصصة * (افصل بفاصلة)</Label>
              <Input value={members} onChange={(e) => setMembers(e.target.value)}
                placeholder="د. أحمد سمير، د. منى عبد الله، أ. خالد يوسف" />
            </div>
            <div className="space-y-1.5">
              <Label>عضو من الوكيل الدولي (اختياري — يسجل 100$ مستحقات تلقائياً)</Label>
              <Input value={agentMember} onChange={(e) => setAgentMember(e.target.value)} placeholder="اسم العضو من جهة الوكيل" />
            </div>
            <Button onClick={schedule} disabled={busy} className="w-full bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
              {busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Gavel className="ml-2 h-4 w-4" />}
              تأكيد الجدولة وإشعار الطالب
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* نافذة النتيجة */}
      <Dialog open={!!resulting} onOpenChange={(v) => !v && setResulting(null)}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">تسجيل نتيجة المناقشة</DialogTitle>
            <DialogDescription>{resulting?.title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5">
            <div className="space-y-1.5">
              <Label>الدرجة (من 100)</Label>
              <Input type="number" min="0" max="100" value={score} onChange={(e) => setScore(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>القرار</Label>
              <Select value={passed} onValueChange={setPassed}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">اجتاز المناقشة</SelectItem>
                  <SelectItem value="false">لم يجتز — يحتاج تعديلات</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={recordResult} disabled={busy} className="w-full bg-emerald-600 font-extrabold text-white hover:bg-emerald-700">
              {busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}
              اعتماد النتيجة وإشعار الطالب
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {/* 12.3: نافذة قاعة المناقشة — دخول الإدارة كعضو لجنة */}
      <Dialog open={!!roomThesis} onOpenChange={(v) => !v && setRoomThesis(null)}>
        <DialogContent className="max-h-[95vh] max-w-4xl overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
              <Video className="h-5 w-5 text-[#a8841a]" /> قاعة المناقشة — اتصال الإدارة كعضو لجنة
            </DialogTitle>
            <DialogDescription>
              {roomThesis?.title} — أنت متصل بفيديو وصوت مباشر مع الطالب وبقية أعضاء اللجنة من مواقعهم المختلفة
            </DialogDescription>
          </DialogHeader>
          {roomThesis && (
            <DefenseRoom
              thesis={{
                id: roomThesis.id,
                title: roomThesis.title,
                abstract: roomThesis.abstract,
                defenseDate: roomThesis.defenseDate,
                committee: roomThesis.committee,
                agentMember: roomThesis.agentMember,
                defenseStatus: roomThesis.defenseStatus,
                aiScore: roomThesis.aiScore,
                aiRecommendation: roomThesis.aiRecommendation,
                defenseMinutes: roomThesis.defenseMinutes,
              }}
              mode="committee"
              onFinished={load}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* 12.3: نافذة محضر الجلسة */}
      <Dialog open={!!minutesThesis} onOpenChange={(v) => !v && setMinutesThesis(null)}>
        <DialogContent className="max-w-xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
              <FileSignature className="h-5 w-5 text-[#a8841a]" /> محضر جلسة المناقشة (توليد تلقائي)
            </DialogTitle>
            <DialogDescription>{minutesThesis?.title}</DialogDescription>
          </DialogHeader>
          {minutesThesis?.defenseMinutes && (
            <div className="max-h-[50vh] overflow-y-auto rounded-xl bg-slate-50 p-4 text-xs leading-loose text-slate-700">
              <p className="whitespace-pre-line">{minutesThesis.defenseMinutes}</p>
            </div>
          )}
          {minutesThesis?.recordingSize && (
            <video
              src={`/api/admin/defense-recording?thesisId=${minutesThesis.id}`}
              controls
              className="w-full rounded-xl border"
            />
          )}
        </DialogContent>
      </Dialog>

      {/* 12.3: مشغل تسجيل الجلسة */}
      <Dialog open={!!showRecording} onOpenChange={(v) => !v && setShowRecording(null)}>
        <DialogContent className="max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
              <Video className="h-5 w-5 text-[#a8841a]" /> تسجيل جلسة المناقشة (فيديو + صوت — مؤرشف في ملف الطالب)
            </DialogTitle>
            <DialogDescription>{showRecording?.title}</DialogDescription>
          </DialogHeader>
          {showRecording && (
            <video
              src={`/api/admin/defense-recording?thesisId=${showRecording.id}`}
              controls
              className="w-full rounded-xl border bg-black"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ============ المالية: المدفوعات + التقارير ============

interface PaymentProofRow {
  id: string
  proofType: string
  status: string
  note?: string | null
  adminNote?: string | null
  fileName: string
  mimeType: string
  fileSize: number
  createdAt: string
  reviewedAt?: string | null
  uploadedBy?: { id: string; name: string; email: string } | null
  reviewedBy?: { id: string; name: string; email: string } | null
}

interface PaymentRow {
  id: string
  invoiceNo: string
  purpose: string
  description: string
  amount: number
  status: string
  method?: string | null
  provider?: string | null
  cryptoNetwork?: string | null
  cryptoTxHash?: string | null
  cryptoWalletAddress?: string | null
  cryptoVerificationStatus?: string | null
  cryptoVerificationNote?: string | null
  manualApprovalReference?: string | null
  manualApprovalNote?: string | null
  receiptNo?: string | null
  payerName?: string | null
  payerCountry?: string | null
  createdAt: string
  proofs?: PaymentProofRow[]
  admission?: { reference: string; fullName: string; country?: string; program: string } | null
}

interface Report {
  totalRevenue: number
  byPurpose: Record<string, number>
  byCountry: Record<string, number>
  admissionStats: { total: number; approved: number; rejected: number; pending: number; certified: number }
  agentPerformance: { orgName: string; territory: string; due: number; paid: number; entries: number }[]
}

export function AdminFinanceTab() {
  const { toast } = useToast()
  const { promptAction, dialog: actionDialog } = useAdminActionDialog()
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [totals, setTotals] = useState({ collected: 0, pending: 0, count: 0, paidCount: 0, manualPendingCount: 0, manualPendingAmount: 0, manualAiLiveCreditCount: 0, manualAiLiveCreditAmount: 0 })
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [paymentSearch, setPaymentSearch] = useState('')
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('ALL')
  const [paymentPage, setPaymentPage] = useState(1)
  const [paymentPageSize, setPaymentPageSize] = useState(25)
  const [paymentTotal, setPaymentTotal] = useState(0)
  const [paymentRefresh, setPaymentRefresh] = useState(0)
  const [pdfBusy, setPdfBusy] = useState<string | null>(null)

  const load = () => setPaymentRefresh((v) => v + 1)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(paymentPage), pageSize: String(paymentPageSize), status: paymentStatusFilter })
      if (paymentSearch.trim()) params.set('search', paymentSearch.trim())
      api<{ payments: PaymentRow[]; totals: any; total: number }>(`/api/admin/payments?${params.toString()}`)
        .then((p) => {
          if (cancelled) return
          setPayments(Array.isArray(p.payments) ? p.payments : [])
          setTotals(p.totals || { collected: 0, pending: 0, count: 0, paidCount: 0, manualPendingCount: 0, manualPendingAmount: 0, manualAiLiveCreditCount: 0, manualAiLiveCreditAmount: 0 })
          setPaymentTotal(Number(p.total || p.totals?.count || 0))
        })
        .catch(() => { if (!cancelled) setPayments([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [paymentSearch, paymentStatusFilter, paymentPage, paymentPageSize, paymentRefresh])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      api<Report>('/api/admin/reports')
        .then((r) => {
          if (!cancelled) setReport(r)
        })
        .catch(() => {
          if (!cancelled) setReport(null)
        })
    }, 700)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [paymentRefresh])

  const confirm = async (payment: PaymentRow) => {
    const method = String(payment.method || payment.provider || '').toUpperCase()
    const hasProof = !!payment.proofs?.length
    let approvalReference = ''
    let approvalNote = ''
    if (!hasProof && method !== 'USDT') {
      const value = await promptAction({
        title: 'تأكيد سداد بدون إثبات مرفوع',
        description: 'اكتب رقم الحوالة أو ملاحظة الاعتماد قبل تأكيد السداد حتى يظهر السبب في السجل.',
        fieldLabel: 'رقم الحوالة أو ملاحظة الاعتماد',
        defaultValue: payment.manualApprovalReference || payment.manualApprovalNote || '',
        placeholder: 'مثال: حوالة ويسترن رقم 123 أو اعتماد إداري موثق',
        required: true,
        minLength: 3,
        multiline: true,
        confirmLabel: 'تأكيد السداد',
        tone: 'warning',
      })
      if (value === null) return
      const trimmed = value.trim()
      if (trimmed.length < 3) {
        toast({ title: 'مطلوب دليل اعتماد', description: 'اكتب رقم حوالة أو ملاحظة واضحة، أو اطلب من الطالب رفع إثبات الدفع أولاً.', variant: 'destructive' })
        return
      }
      approvalNote = trimmed
    }
    try {
      await api('/api/admin/payments', { method: 'PATCH', body: JSON.stringify({ id: payment.id, approvalReference, approvalNote }) })
      toast({ title: 'تم التأكيد', description: 'أُصدر إيصال الدفع وأُبلغ الطالب' })
      load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  const openInvoicePdf = async (id: string) => {
    const popup = window.open('', '_blank')
    if (popup) {
      popup.document.write('<p style="font-family:Arial;padding:24px;text-align:center">Preparing invoice PDF...</p>')
      try { popup.opener = null } catch {}
    }
    setPdfBusy(id)
    try {
      const token = getToken()
      const res = await fetch(`/api/pdf/invoices/${encodeURIComponent(id)}`, {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      if (popup) {
        popup.location.href = url
      } else {
        const a = document.createElement('a')
        a.href = url
        a.download = 'aact-invoice.pdf'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e: any) {
      try { popup?.close() } catch {}
      toast({ title: 'تعذر فتح PDF الفاتورة', description: e.message, variant: 'destructive' })
    } finally {
      setPdfBusy(null)
    }
  }

  const filteredPayments = payments
  const pagedPayments = payments
  const currentPaymentPage = paymentPage
  const manualPendingCount = Number(totals.manualPendingCount || 0)
  const manualPendingAmount = Number(totals.manualPendingAmount || 0)
  const manualAiLiveCreditCount = Number(totals.manualAiLiveCreditCount || 0)
  const manualAiLiveCreditAmount = Number(totals.manualAiLiveCreditAmount || 0)

  const PURPOSE_L: Record<string, string> = {
    APPLICATION_FEE: 'رسوم تقديم',
    TUITION: 'رسوم دراسية',
    TUITION_INSTALLMENT: 'دفعة رسوم دراسية',
    ACCREDITATION_APP: 'تقديم اعتماد',
    ACCREDITATION_FEE: 'رسوم تقديم اعتماد',
    ACCREDITATION: 'اعتماد',
    SERVICE_FEE: 'رسوم خدمة',
    AI_LIVE_CREDIT: 'باقة دقائق صوت للمشرف الذكي',
    OTHER: 'أخرى',
  }

  return (
    <div className="mt-4 space-y-5">
      {actionDialog}
      {/* KPIs المالية */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="border-[#0f2b46]/10"><CardContent className="p-4 text-center">
          <p className="text-xl font-black text-emerald-700">{totals.collected}$</p>
          <p className="text-[10px] font-bold text-slate-500">إجمالي المحصّل</p>
        </CardContent></Card>
        <Card className="border-[#0f2b46]/10"><CardContent className="p-4 text-center">
          <p className="text-xl font-black text-amber-600">{totals.pending}$</p>
          <p className="text-[10px] font-bold text-slate-500">مستحق غير مسدد</p>
        </CardContent></Card>
        <Card className="border-[#0f2b46]/10"><CardContent className="p-4 text-center">
          <p className="text-xl font-black text-[#0f2b46]">{totals.paidCount}/{totals.count}</p>
          <p className="text-[10px] font-bold text-slate-500">فواتير مسددة</p>
        </CardContent></Card>
        <Card className="border-[#0f2b46]/10"><CardContent className="p-4 text-center">
          <p className="text-xl font-black text-[#0f2b46]">{report?.admissionStats.certified || 0}</p>
          <p className="text-[10px] font-bold text-slate-500">شهادات صادرة (طلبات)</p>
        </CardContent></Card>
      </div>

      {(manualPendingCount > 0 || manualAiLiveCreditCount > 0) && (
        <Card className="border-amber-200 bg-amber-50/70">
          <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-sm font-black text-[#0f2b46]">طلبات دفع مباشر بانتظار تأكيد وصول المبلغ</h3>
              <p className="mt-1 text-xs font-bold leading-6 text-slate-600">
                يوجد {manualPendingCount} طلب دفع مباشر/USDT بمبلغ {manualPendingAmount}$، منها {manualAiLiveCreditCount} طلب لباقات دقائق صوت بمبلغ {manualAiLiveCreditAmount}$. مبالغ باقات الصوت خدمة إضافية ولا تُخصم من متبقي الرسوم الدراسية.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => { setPaymentStatusFilter('MANUAL_PENDING'); setPaymentPage(1) }}
              className="bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]"
            >
              عرض طلبات الدفع المباشر
            </Button>
          </CardContent>
        </Card>
      )}

      {/* معدلات القبول */}
      {report && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]"><TrendingUp className="h-4.5 w-4.5 text-[#c9a227]" /> معدلات القبول</h3>
              <div className="space-y-2 text-xs font-bold text-slate-600">
                <div className="flex justify-between"><span>إجمالي الطلبات</span><span className="text-[#0f2b46]">{report.admissionStats.total}</span></div>
                <div className="flex justify-between"><span>معتمدة (قيد الدراسة والسداد والمناقشة)</span><span className="text-emerald-600">{report.admissionStats.approved}</span></div>
                <div className="flex justify-between"><span>بانتظار المراجعة</span><span className="text-amber-600">{report.admissionStats.pending}</span></div>
                <div className="flex justify-between"><span>مرفوضة</span><span className="text-red-500">{report.admissionStats.rejected}</span></div>
                <div className="flex justify-between"><span>شهادات صادرة</span><span className="text-[#a8841a]">{report.admissionStats.certified}</span></div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5">
              <h3 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]"><Globe2 className="h-4.5 w-4.5 text-[#c9a227]" /> الإيرادات حسب الدولة</h3>
              {Object.keys(report.byCountry).length === 0 ? (
                <p className="text-xs text-slate-400">لا إيرادات بعد</p>
              ) : (
                <div className="space-y-2 text-xs font-bold text-slate-600">
                  {Object.entries(report.byCountry).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, v]) => (
                    <div key={c} className="flex justify-between"><span>{c}</span><span className="text-[#0f2b46]">{v}$</span></div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* أداء الوكلاء */}
      {report && report.agentPerformance.length > 0 && (
        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]"><Users2 className="h-4.5 w-4.5 text-[#c9a227]" /> أداء الوكلاء (عمولات 25% + لجان 100$)</h3>
            <div className="space-y-2.5 text-xs font-bold">
              {report.agentPerformance.map((a) => (
                <div key={a.orgName} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 p-3">
                  <div>
                    <span className="text-[#0f2b46]">{a.orgName}</span>
                    <span className="mr-2 text-[10px] text-slate-400">نطاق: {a.territory} ({a.entries} سجلات)</span>
                  </div>
                  <div className="flex gap-3">
                    <span className="text-amber-600">معلق: {a.due}$</span>
                    <span className="text-emerald-600">محوّل: {a.paid}$</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* جدول الفواتير */}
      <div className="space-y-3">
        <AdminListToolbar
          search={paymentSearch}
          onSearchChange={(v) => { setPaymentSearch(v); setPaymentPage(1) }}
          searchPlaceholder="ابحث برقم الفاتورة أو الاسم أو الوصف أو البرنامج..."
          status={paymentStatusFilter}
          onStatusChange={(v) => { setPaymentStatusFilter(v); setPaymentPage(1) }}
          statusOptions={[
            { value: 'ALL', label: 'كل الفواتير' },
            { value: 'UNPAID', label: 'غير مسددة' },
            { value: 'PAID', label: 'مسددة' },
            { value: 'MANUAL_PENDING', label: 'دفع مباشر بانتظار التأكيد' },
            { value: 'APPLICATION_FEE', label: 'رسوم تقديم' },
            { value: 'TUITION', label: 'رسوم دراسية' },
            { value: 'TUITION_INSTALLMENT', label: 'دفعات تقسيط' },
            { value: 'SERVICE_FEE', label: 'رسوم خدمات' },
            { value: 'AI_LIVE_CREDIT', label: 'باقات دقائق صوت' },
          ]}
          pageSize={paymentPageSize}
          onPageSizeChange={(v) => { setPaymentPageSize(v); setPaymentPage(1) }}
          total={paymentTotal}
          filtered={paymentTotal}
          label="فاتورة"
        />
      <Card className="border-[#0f2b46]/10">
        <CardContent className="p-0">
          <h3 className="border-b border-slate-100 p-4 text-sm font-black text-[#0f2b46]">كل الفواتير والإيصالات</h3>
          <div className="aact-scroll max-h-96 overflow-y-auto">
            {paymentTotal === 0 && !paymentSearch && paymentStatusFilter === 'ALL' ? (
              <p className="p-8 text-center text-xs text-slate-400">لا توجد فواتير بعد</p>
            ) : payments.length === 0 ? (
              <p className="p-8 text-center text-xs text-slate-400">لا توجد فواتير مطابقة للبحث أو الفلتر الحالي.</p>
            ) : (
              <table className="w-full text-right text-xs">
                <thead className="sticky top-0 bg-[#f7edd0] text-[#0f2b46]">
                  <tr>
                    <th className="p-3 font-black">الفاتورة</th>
                    <th className="p-3 font-black">الوصف</th>
                    <th className="p-3 font-black">المبلغ</th>
                    <th className="p-3 font-black">الحالة</th>
                    <th className="p-3 font-black">PDF</th>
                    <th className="p-3 font-black">تحديث المبلغ</th>
                    <th className="p-3 font-black">تأكيد يدوي</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedPayments.map((p) => (
                    <tr key={p.id} className={`border-t border-slate-100 ${p.status === 'UNPAID' && ['DIRECT_PAYMENT', 'USDT'].includes(String(p.method || p.provider || '')) ? 'bg-amber-50/60' : ''}`}>
                      <td className="p-3">
                        <div className="font-mono text-[10px] font-bold text-[#0f2b46]" dir="ltr">{p.invoiceNo}</div>
                        <div className="text-[10px] text-slate-400">{p.payerName || p.admission?.fullName || '—'}</div>
                      </td>
                      <td className="max-w-48 p-3">
                        <div className="truncate font-bold text-slate-600">{p.description}</div>
                        <div className="text-[10px] text-slate-400">{PURPOSE_L[p.purpose] || p.purpose}{p.admission ? ` — ${p.admission.reference}` : ''}</div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {p.status === 'UNPAID' && ['DIRECT_PAYMENT', 'USDT'].includes(String(p.method || p.provider || '')) && (
                            <Badge className="bg-amber-100 text-[9px] font-black text-amber-700 hover:bg-amber-100">بانتظار تأكيد وصول المبلغ</Badge>
                          )}
                          {p.purpose === 'AI_LIVE_CREDIT' && (
                            <Badge className="bg-indigo-100 text-[9px] font-black text-indigo-700 hover:bg-indigo-100">خدمة إضافية — لا تخصم من الرسوم الدراسية</Badge>
                          )}
                        </div>
                        {(p.method === 'USDT' || p.provider === 'USDT') && (
                          <div className="mt-1 space-y-0.5 rounded-lg bg-slate-50 p-2 text-[10px] font-bold text-slate-500">
                            <div>USDT: {p.cryptoNetwork || '—'} · {p.cryptoVerificationStatus || 'WAITING_TX'}</div>
                            {p.cryptoTxHash && <div className="font-mono" dir="ltr">Tx: {p.cryptoTxHash.slice(0, 12)}…{p.cryptoTxHash.slice(-8)}</div>}
                            {p.cryptoVerificationNote && <div className="line-clamp-2 text-slate-400">{p.cryptoVerificationNote}</div>}
                          </div>
                        )}
                        {p.proofs?.length ? (
                          <div className="mt-1 space-y-1 rounded-lg border border-emerald-100 bg-emerald-50 p-2 text-[10px] font-bold text-emerald-800">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span>إثباتات الدفع: {p.proofs.length}</span>
                              <Badge className="bg-white text-emerald-700 hover:bg-white">{p.proofs[0].status === 'PENDING' ? 'قيد المراجعة' : p.proofs[0].status}</Badge>
                            </div>
                            <a href={`/api/admin/payments/proofs/${encodeURIComponent(p.proofs[0].id)}/download`} target="_blank" rel="noreferrer" className="inline-flex font-black text-emerald-700 underline">
                              فتح آخر إثبات: {p.proofs[0].fileName}
                            </a>
                            {p.proofs[0].uploadedBy?.name ? <div className="text-emerald-700">رفعه: {p.proofs[0].uploadedBy.name}</div> : null}
                          </div>
                        ) : null}
                      </td>
                      <td className="p-3 font-black text-[#0f2b46]">{p.amount}$</td>
                      <td className="p-3">
                        {p.status === 'PAID' ? (
                          <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">مسددة {p.receiptNo ? `(${p.receiptNo})` : ''}</Badge>
                        ) : ['DIRECT_PAYMENT', 'USDT'].includes(String(p.method || p.provider || '')) ? (
                          <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">دفع مباشر بانتظار التأكيد</Badge>
                        ) : (
                          <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">معلقة</Badge>
                        )}
                      </td>
                      <td className="p-3">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pdfBusy === p.id}
                          onClick={() => openInvoicePdf(p.id)}
                          className="border-[#c9a227]/40 font-bold text-[#a8841a]"
                        >
                          {pdfBusy === p.id ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : <FileDown className="ml-1 h-3 w-3" />}
                          PDF
                        </Button>
                      </td>
                      <td className="p-3">
                        <RefreshPaymentAmountButton payment={p} onDone={load} />
                      </td>
                      <td className="p-3">
                        {p.status === 'UNPAID' ? (
                          <Button size="sm" variant="outline" onClick={() => confirm(p)}
                            className="border-emerald-200 font-bold text-emerald-600">
                            <Banknote className="ml-1 h-3 w-3" /> {p.purpose === 'AI_LIVE_CREDIT' ? 'تأكيد وصول مبلغ باقة الصوت' : 'تأكيد وصول المبلغ'}
                          </Button>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>
      <AdminPager page={currentPaymentPage} pageSize={paymentPageSize} total={paymentTotal} onPageChange={setPaymentPage} label="فاتورة" />
      </div>
    </div>
  )
}

// ============ إدارة الشهادات ============

interface CertificateCandidate {
  id: string
  reference: string
  fullName: string
  email: string
  country: string
  program: string
  status: string
  ready: boolean
  missing: string[]
  eligibility: { ok: boolean; score: number | null; gradeLabel: string | null; error: string; components?: any[] }
  payments: { tuitionTotal: number; tuitionPaid: number; tuitionOk: boolean; nonTuitionUnpaid: number; missing: string[] }
}

interface CertificateTemplateItem {
  id: string
  name: string
  certificateType: string
  active: boolean
  fileName: string
  mimeType: string
  fileSize: number
  layoutJson?: any
  imageUrl: string
  createdAt: string
}

const TEMPLATE_FIELD_LABELS: Record<string, string> = {
  holderName: 'اسم الطالب',
  program: 'اسم البرنامج',
  grade: 'التقدير',
  serial: 'الرقم التسلسلي',
  issuedAt: 'تاريخ الإصدار',
  qr: 'رمز QR',
}

const TEMPLATE_DEFAULT_LAYOUT: any = {
  orientation: 'landscape',
  holderName: { x: 50, y: 38, width: 72, fontSize: 4.8, align: 'center', color: '#0f2b46', visible: true },
  program: { x: 50, y: 52, width: 76, fontSize: 2.6, align: 'center', color: '#a8841a', visible: true },
  grade: { x: 50, y: 64, width: 44, fontSize: 1.7, align: 'center', color: '#0f2b46', visible: true },
  serial: { x: 84, y: 90, width: 22, fontSize: 1.2, align: 'right', color: '#0f2b46', visible: true },
  issuedAt: { x: 16, y: 90, width: 24, fontSize: 1.2, align: 'left', color: '#0f2b46', visible: true },
  qr: { x: 50, y: 86, size: 12, visible: true },
}

function templateLayout(raw: any) {
  return { ...TEMPLATE_DEFAULT_LAYOUT, ...(raw && typeof raw === 'object' ? raw : {}) }
}

export function AdminCertificatesTab() {
  const { toast } = useToast()
  const [certs, setCerts] = useState<CertificateData[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<CertificateData | null>(null)
  const [open, setOpen] = useState(false)
  const [issueOpen, setIssueOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [section, setSection] = useState<'READY' | 'BLOCKED' | 'ISSUED'>('READY')
  const [readyCandidates, setReadyCandidates] = useState<CertificateCandidate[]>([])
  const [blockedCandidates, setBlockedCandidates] = useState<CertificateCandidate[]>([])
  const [candidatesLoading, setCandidatesLoading] = useState(true)
  const [candidateRefresh, setCandidateRefresh] = useState(0)
  const [financialOverrideReasons, setFinancialOverrideReasons] = useState<Record<string, string>>({})
  const [templates, setTemplates] = useState<CertificateTemplateItem[]>([])
  const [templateBusy, setTemplateBusy] = useState(false)
  const [templateFile, setTemplateFile] = useState<File | null>(null)
  const [templateForm, setTemplateForm] = useState({ name: '', certificateType: 'PROGRAM_COMPLETION' })
  const [templatePendingDelete, setTemplatePendingDelete] = useState<CertificateTemplateItem | null>(null)
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [selectedTemplateField, setSelectedTemplateField] = useState('holderName')
  const templateCanvasRef = useRef<HTMLDivElement | null>(null)
  const [form, setForm] = useState({ holderName: '', program: '', grade: '', country: '' })
  const [certSearch, setCertSearch] = useState('')
  const [certPage, setCertPage] = useState(1)
  const [certPageSize, setCertPageSize] = useState(25)
  const [certTotal, setCertTotal] = useState(0)
  const [certRefresh, setCertRefresh] = useState(0)

  const load = () => setCertRefresh((v) => v + 1)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ page: String(certPage), pageSize: String(certPageSize) })
      if (certSearch.trim()) params.set('search', certSearch.trim())
      api<{ certificates: CertificateData[]; total: number }>(`/api/admin/certificates?${params.toString()}`)
        .then((d) => {
          if (cancelled) return
          setCerts(Array.isArray(d.certificates) ? d.certificates : [])
          setCertTotal(Number(d.total || 0))
        })
        .catch(() => { if (!cancelled) setCerts([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [certSearch, certPage, certPageSize, certRefresh])

  useEffect(() => {
    let cancelled = false
    setCandidatesLoading(true)
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ limit: '120' })
      if (certSearch.trim()) params.set('search', certSearch.trim())
      api<{ ready: CertificateCandidate[]; blocked: CertificateCandidate[] }>(`/api/admin/certificates/candidates?${params.toString()}`)
        .then((d) => {
          if (cancelled) return
          setReadyCandidates(Array.isArray(d.ready) ? d.ready : [])
          setBlockedCandidates(Array.isArray(d.blocked) ? d.blocked : [])
        })
        .catch(() => {
          if (cancelled) return
          setReadyCandidates([])
          setBlockedCandidates([])
        })
        .finally(() => { if (!cancelled) setCandidatesLoading(false) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [certSearch, candidateRefresh, certRefresh])

  const loadTemplates = () => {
    api<{ templates: CertificateTemplateItem[] }>('/api/admin/certificates/templates')
      .then((d) => setTemplates(Array.isArray(d.templates) ? d.templates : []))
      .catch(() => setTemplates([]))
  }

  useEffect(() => {
    loadTemplates()
  }, [])

  const issue = async () => {
    setBusy(true)
    try {
      await api('/api/admin/certificates', { method: 'POST', body: JSON.stringify(form) })
      toast({ title: 'تم الإصدار', description: `أُصدرت الشهادة برقم متسلسل وQR — ظاهرة الآن في صفحة التحقق` })
      setIssueOpen(false)
      setForm({ holderName: '', program: '', grade: '', country: '' })
      load()
      setCandidateRefresh((v) => v + 1)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const issueCandidate = async (candidate: CertificateCandidate) => {
    if (!candidate.ready) return
    setBusy(true)
    try {
      await api('/api/admin/certificates', { method: 'POST', body: JSON.stringify({ admissionId: candidate.id }) })
      toast({ title: 'تم إصدار الشهادة', description: `أُصدرت شهادة ${candidate.fullName} وربطت بطلبه وبرنامجه.` })
      load()
      setCandidateRefresh((v) => v + 1)
      setSection('ISSUED')
    } catch (e: any) {
      toast({ title: 'تعذر إصدار الشهادة', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const issueWithFinancialOverride = async (candidate: CertificateCandidate) => {
    const reason = String(financialOverrideReasons[candidate.id] || '').trim()
    if (!candidate.eligibility?.ok) {
      toast({ title: 'لا يمكن التجاوز', description: 'التجاوز مسموح مالياً فقط، ولا يسمح بتجاوز شروط النجاح الأكاديمي.', variant: 'destructive' })
      return
    }
    if (reason.length < 6) {
      toast({ title: 'سبب التجاوز مطلوب', description: 'اكتب سبباً واضحاً لا يقل عن 6 أحرف قبل الإصدار.', variant: 'destructive' })
      return
    }
    setBusy(true)
    try {
      await api('/api/admin/certificates', { method: 'POST', body: JSON.stringify({ admissionId: candidate.id, financialOverrideReason: reason }) })
      toast({ title: 'تم إصدار الشهادة بتجاوز مالي', description: `أُصدرت شهادة ${candidate.fullName} مع تسجيل سبب التجاوز في سجل التدقيق.` })
      setFinancialOverrideReasons((prev) => ({ ...prev, [candidate.id]: '' }))
      load()
      setCandidateRefresh((v) => v + 1)
      setSection('ISSUED')
    } catch (e: any) {
      toast({ title: 'تعذر إصدار الشهادة', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const uploadCertificateTemplate = async () => {
    if (!templateFile) {
      toast({ title: 'اختر صورة القالب أولاً', variant: 'destructive' })
      return
    }
    if (!templateForm.name.trim()) {
      toast({ title: 'اسم القالب مطلوب', variant: 'destructive' })
      return
    }
    setTemplateBusy(true)
    try {
      const formData = new FormData()
      formData.append('file', templateFile)
      formData.append('name', templateForm.name)
      formData.append('certificateType', templateForm.certificateType)
      await api('/api/admin/certificates/templates', { method: 'POST', body: formData })
      toast({ title: 'تم رفع قالب الشهادة', description: 'سيظهر القالب في نافذة الشهادة ويضع النظام البيانات فوقه تلقائياً.' })
      setTemplateFile(null)
      setTemplateForm({ name: '', certificateType: 'PROGRAM_COMPLETION' })
      loadTemplates()
    } catch (e: any) {
      toast({ title: 'تعذر رفع القالب', description: e.message, variant: 'destructive' })
    } finally {
      setTemplateBusy(false)
    }
  }

  const updateCertificateTemplate = async (template: CertificateTemplateItem, patch: Partial<CertificateTemplateItem>) => {
    setTemplateBusy(true)
    try {
      await api(`/api/admin/certificates/templates/${encodeURIComponent(template.id)}`, { method: 'PATCH', body: JSON.stringify(patch) })
      loadTemplates()
    } catch (e: any) {
      toast({ title: 'تعذر تحديث القالب', description: e.message, variant: 'destructive' })
    } finally {
      setTemplateBusy(false)
    }
  }

  const deleteCertificateTemplate = async (template: CertificateTemplateItem) => {
    setTemplateBusy(true)
    try {
      await api(`/api/admin/certificates/templates/${encodeURIComponent(template.id)}`, { method: 'DELETE' })
      setTemplatePendingDelete(null)
      if (selectedTemplateId === template.id) setSelectedTemplateId(null)
      loadTemplates()
      toast({ title: 'حُذف قالب الشهادة', description: `تم حذف قالب «${template.name}» من لوحة القوالب.` })
    } catch (e: any) {
      toast({ title: 'تعذر حذف القالب', description: e.message, variant: 'destructive' })
    } finally {
      setTemplateBusy(false)
    }
  }

  const patchTemplateLayout = (template: CertificateTemplateItem, field: string, patch: Record<string, any>) => {
    const nextLayout = templateLayout(template.layoutJson)
    const current = nextLayout[field] || {}
    const updated = { ...current, ...patch }
    setTemplates((prev) => prev.map((t) => t.id === template.id ? { ...t, layoutJson: { ...nextLayout, [field]: updated } } : t))
  }

  const setTemplateOrientation = (template: CertificateTemplateItem, orientation: 'landscape' | 'portrait') => {
    const nextLayout = templateLayout(template.layoutJson)
    setTemplates((prev) => prev.map((t) => t.id === template.id ? { ...t, layoutJson: { ...nextLayout, orientation } } : t))
  }

  const moveTemplateField = (template: CertificateTemplateItem, field: string, clientX: number, clientY: number) => {
    const rect = templateCanvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = Math.max(2, Math.min(98, ((clientX - rect.left) / rect.width) * 100))
    const y = Math.max(2, Math.min(98, ((clientY - rect.top) / rect.height) * 100))
    patchTemplateLayout(template, field, { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) })
  }

  const saveTemplateLayout = async (template: CertificateTemplateItem) => {
    setTemplateBusy(true)
    try {
      await api(`/api/admin/certificates/templates/${encodeURIComponent(template.id)}`, { method: 'PATCH', body: JSON.stringify({ layoutJson: templateLayout(template.layoutJson) }) })
      toast({ title: 'تم حفظ أماكن حقول القالب', description: 'ستستخدم الشهادات هذا التخطيط في المعاينة والطباعة.' })
      loadTemplates()
    } catch (e: any) {
      toast({ title: 'تعذر حفظ التخطيط', description: e.message, variant: 'destructive' })
    } finally {
      setTemplateBusy(false)
    }
  }

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  const filteredCerts = certs
  const pagedCerts = certs
  const currentCertPage = certPage
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) || templates[0] || null
  const selectedLayout = selectedTemplate ? templateLayout(selectedTemplate.layoutJson) : TEMPLATE_DEFAULT_LAYOUT
  const isPortraitTemplate = selectedLayout.orientation === 'portrait'
  const templateAspectClass = isPortraitTemplate ? 'aspect-[1/1.414]' : 'aspect-[1.414/1]'
  const sampleValues: Record<string, string> = {
    holderName: 'محمد أحمد',
    program: 'الماجستير المهني في إدارة الأعمال',
    grade: 'امتياز',
    serial: 'AACT-C-2026-00001',
    issuedAt: '05/10/2026',
    qr: 'QR',
  }
  const designerFieldStyle = (field: string) => {
    const cfg = selectedLayout[field] || {}
    const isQr = field === 'qr'
    return {
      position: 'absolute' as const,
      left: `${Number(cfg.x ?? 50)}%`,
      top: `${Number(cfg.y ?? 50)}%`,
      width: isQr ? `${Number(cfg.size ?? 12)}%` : `${Number(cfg.width ?? 50)}%`,
      minHeight: isQr ? undefined : '22px',
      transform: 'translate(-50%, -50%)',
      textAlign: cfg.align || 'center',
      color: cfg.color || '#0f2b46',
      fontSize: isQr ? undefined : `clamp(10px, ${Number(cfg.fontSize ?? 2)}vw, 42px)`,
      lineHeight: 1.2,
      fontWeight: 900,
      cursor: 'move',
      border: selectedTemplateField === field ? '2px solid #c9a227' : '1px dashed rgba(15,43,70,.35)',
      background: isQr ? 'white' : 'rgba(255,255,255,.72)',
      padding: isQr ? '4px' : '4px 8px',
      borderRadius: '10px',
    }
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-black text-[#0f2b46]">مركز إصدار الشهادات</h3>
          <p className="text-xs font-bold text-slate-500">النظام يحدد الجاهزين والممنوعين آلياً، والإدارة تعتمد الإصدار بضغطة زر.</p>
        </div>
        <Button onClick={() => setIssueOpen(true)} variant="outline" className="border-[#c9a227] font-extrabold text-[#a8841a]">
          <Plus className="ml-1 h-4 w-4" /> إصدار يدوي مقيد
        </Button>
      </div>

      <div className="grid gap-2 rounded-2xl border border-[#0f2b46]/10 bg-white p-2 sm:grid-cols-3">
        {[
          ['READY', 'جاهزة للإصدار', readyCandidates.length, CheckCircle2] as const,
          ['BLOCKED', 'ممنوعة حالياً', blockedCandidates.length, XCircle] as const,
          ['ISSUED', 'سجل الصادرة', certTotal, Award] as const,
        ].map(([key, label, count, Icon]) => (
          <button key={key} type="button" onClick={() => setSection(key)} className={`rounded-xl px-3 py-3 text-right text-xs font-black transition ${section === key ? 'bg-[#0f2b46] text-[#f5f0e1]' : 'bg-slate-50 text-[#0f2b46] hover:bg-slate-100'}`}>
            <span className="flex items-center justify-between gap-2"><span className="inline-flex items-center gap-2"><Icon className="h-4 w-4" />{label}</span><Badge className={section === key ? 'bg-white/15 text-white' : 'bg-[#c9a227]/15 text-[#a8841a]'}>{count}</Badge></span>
          </button>
        ))}
      </div>

      <AdminListToolbar
        search={certSearch}
        onSearchChange={(v) => { setCertSearch(v); setCertPage(1) }}
        searchPlaceholder="ابحث بالاسم أو الرقم التسلسلي أو البرنامج..."
        pageSize={certPageSize}
        onPageSizeChange={(v) => { setCertPageSize(v); setCertPage(1) }}
        total={section === 'ISSUED' ? certTotal : (section === 'READY' ? readyCandidates.length : blockedCandidates.length)}
        filtered={section === 'ISSUED' ? certTotal : (section === 'READY' ? readyCandidates.length : blockedCandidates.length)}
        label={section === 'ISSUED' ? 'شهادة' : 'طلب'}
      />

      {section === 'READY' && (
        candidatesLoading ? <div className="flex h-32 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" /></div> : readyCandidates.length === 0 ? (
          <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد طلبات جاهزة للإصدار حالياً.</CardContent></Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {readyCandidates.map((c) => (
              <Card key={c.id} className="border-emerald-200 bg-white">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3"><div><h4 className="text-sm font-black text-[#0f2b46]">{c.fullName}</h4><p className="text-xs font-bold text-slate-500">{c.program}</p><p className="mt-1 font-mono text-[10px] text-slate-400" dir="ltr">{c.reference}</p></div><Badge className="bg-emerald-100 text-emerald-700">جاهز</Badge></div>
                  <div className="grid gap-2 rounded-xl bg-emerald-50 p-3 text-xs font-bold text-emerald-900 sm:grid-cols-2"><span>النتيجة: {c.eligibility.gradeLabel || 'جاهز أكاديمياً'}</span><span>الرسوم: {c.payments.tuitionPaid}$ / {c.payments.tuitionTotal}$</span></div>
                  <Button disabled={busy} onClick={() => issueCandidate(c)} className="w-full bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]">{busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Award className="ml-2 h-4 w-4" />} إصدار الشهادة</Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      )}

      {section === 'BLOCKED' && (
        candidatesLoading ? <div className="flex h-32 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" /></div> : blockedCandidates.length === 0 ? (
          <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد طلبات ممنوعة حالياً.</CardContent></Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {blockedCandidates.map((c) => (
              <Card key={c.id} className="border-red-100 bg-white">
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3"><div><h4 className="text-sm font-black text-[#0f2b46]">{c.fullName}</h4><p className="text-xs font-bold text-slate-500">{c.program}</p><p className="mt-1 font-mono text-[10px] text-slate-400" dir="ltr">{c.reference}</p></div><Badge className="bg-red-100 text-red-700">ممنوع</Badge></div>
                  <div className="rounded-xl bg-red-50 p-3 text-xs font-bold leading-6 text-red-900"><p className="mb-1 font-black">سبب المنع:</p><ul className="list-inside list-disc space-y-1">{c.missing.slice(0, 6).map((m, i) => <li key={i}>{m}</li>)}</ul></div>
                  {c.eligibility?.ok && (!c.payments.tuitionOk || c.payments.nonTuitionUnpaid > 0) ? (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                      <Label className="text-[11px] font-black text-amber-900">سبب التجاوز المالي *</Label>
                      <Textarea
                        rows={2}
                        value={financialOverrideReasons[c.id] || ''}
                        onChange={(e) => setFinancialOverrideReasons((prev) => ({ ...prev, [c.id]: e.target.value }))}
                        placeholder="مثال: منحة إدارية خاصة أو قرار تأجيل سداد موثق"
                        className="mt-2 bg-white text-xs font-bold leading-6"
                      />
                      <Button disabled={busy} onClick={() => issueWithFinancialOverride(c)} className="mt-2 w-full bg-amber-600 font-black text-white hover:bg-amber-700">
                        {busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Award className="ml-2 h-4 w-4" />} إصدار بتجاوز مالي
                      </Button>
                      <p className="mt-2 text-[10px] font-bold leading-5 text-amber-900">يسمح هذا الزر بتجاوز المنع المالي فقط. لا يسمح بتجاوز الرسوب أو نقص المناقشة أو نقص التقييمات.</p>
                    </div>
                  ) : (
                    <p className="text-[11px] font-bold text-slate-500">لا يمكن الإصدار هنا لأن شروط النجاح الأكاديمي غير مكتملة. التجاوز المالي لا يتجاوز الرسوب أو نقص التقييمات.</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )
      )}

      {section === 'ISSUED' && (
        certTotal === 0 && !certSearch ? (
          <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد شهادات صادرة بعد — تصدرها الإدارة بعد اكتمال النجاح الأكاديمي وسداد الرسوم.</CardContent></Card>
        ) : certs.length === 0 ? (
          <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد شهادات مطابقة للبحث الحالي.</CardContent></Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pagedCerts.map((c) => (
              <Card key={c.serial} className="border-[#c9a227]/30 bg-white">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between"><Award className="h-5 w-5 text-[#a8841a]" /><span className="font-mono text-[10px] text-slate-400" dir="ltr">{c.serial}</span></div>
                  <h4 className="mt-2 text-xs font-black text-[#0f2b46]">{c.holderName}</h4>
                  <p className="mt-0.5 line-clamp-1 text-[11px] font-bold text-slate-500">{c.program}</p>
                  <Button size="sm" variant="outline" className="mt-3 w-full border-[#c9a227] font-bold text-[#a8841a]" onClick={() => { setSelected(c); setOpen(true) }}><FileDown className="ml-1 h-3.5 w-3.5" /> عرض / طباعة</Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      )}
      {section === 'ISSUED' && <AdminPager page={currentCertPage} pageSize={certPageSize} total={certTotal} onPageChange={setCertPage} label="شهادة" />}

      <Card className="border-[#0f2b46]/10 bg-white">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-black text-[#0f2b46]">قوالب الشهادات الرسمية</h4>
              <p className="text-xs font-bold text-slate-500">ارفع صورة قالب شهادة فارغ، والنظام يضع الاسم والبرنامج والرقم وQR فوقها في نافذة الشهادة.</p>
            </div>
            <Badge className="bg-[#c9a227]/15 text-[#a8841a]">{templates.length} قالب</Badge>
          </div>
          <div className="grid gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-3 lg:grid-cols-4">
            <Input value={templateForm.name} placeholder="اسم القالب" onChange={(e) => setTemplateForm((p) => ({ ...p, name: e.target.value }))} className="font-bold" />
            <Select value={templateForm.certificateType} onValueChange={(v) => setTemplateForm((p) => ({ ...p, certificateType: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="PROGRAM_COMPLETION">شهادات البرامج</SelectItem>
                <SelectItem value="ACCREDITATION">شهادات الاعتماد</SelectItem>
                <SelectItem value="AGENCY">شهادات الوكالة</SelectItem>
              </SelectContent>
            </Select>
            <Input type="file" accept="image/png,image/jpeg" onChange={(e) => setTemplateFile(e.target.files?.[0] || null)} className="lg:col-span-1" />
            <Button type="button" onClick={uploadCertificateTemplate} disabled={templateBusy} className="bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]">
              {templateBusy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Upload className="ml-2 h-4 w-4" />} رفع القالب
            </Button>
          </div>
          {templates.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-xs font-bold text-slate-500">لا توجد قوالب مرفوعة بعد. ستبقى نافذة الشهادة تستخدم القالب الافتراضي.</div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {templates.map((t) => (
                <div key={t.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-black text-[#0f2b46]">{t.name}</p>
                      <p className="mt-1 font-mono text-[10px] text-slate-400" dir="ltr">{t.fileName}</p>
                      <Badge className={t.active ? 'mt-2 bg-emerald-100 text-emerald-700' : 'mt-2 bg-slate-200 text-slate-600'}>{t.active ? 'نشط' : 'معطل'}</Badge>
                    </div>
                    <img src={t.imageUrl} alt={t.name} className="h-16 w-24 rounded-lg border border-slate-200 object-cover" />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button asChild type="button" size="sm" variant="outline" className="h-8 text-xs font-bold"><a href={t.imageUrl} target="_blank" rel="noreferrer"><Eye className="ml-1 h-3.5 w-3.5" /> معاينة</a></Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => updateCertificateTemplate(t, { active: !t.active })} disabled={templateBusy} className="h-8 text-xs font-bold">{t.active ? 'تعطيل' : 'تفعيل'}</Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => setTemplatePendingDelete(t)} disabled={templateBusy} className="h-8 text-xs font-bold text-red-600"><Trash2 className="ml-1 h-3.5 w-3.5" /> حذف</Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {selectedTemplate && (
            <div className="rounded-2xl border border-[#0f2b46]/10 bg-[#f8f5ed] p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h5 className="text-sm font-black text-[#0f2b46]">محرر أماكن الحقول على القالب</h5>
                  <p className="text-[11px] font-bold text-slate-500">اختر القالب، ثم اسحب أي حقل فوق الصورة إلى مكانه الصحيح. بعد الضبط اضغط حفظ التخطيط.</p>
                </div>
                <Button type="button" onClick={() => saveTemplateLayout(selectedTemplate)} disabled={templateBusy} className="bg-[#c9a227] font-black text-[#0f2b46] hover:bg-[#e0b83a]">
                  {templateBusy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Settings2 className="ml-2 h-4 w-4" />} حفظ تخطيط القالب
                </Button>
              </div>
              <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-black text-slate-600">القالب الذي يتم ضبطه</Label>
                    <Select value={selectedTemplate.id} onValueChange={(v) => setSelectedTemplateId(v)}>
                      <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-black text-slate-600">اتجاه الشهادة</Label>
                    <div className="grid grid-cols-2 gap-2">
                      <Button type="button" variant={isPortraitTemplate ? 'outline' : 'default'} onClick={() => setTemplateOrientation(selectedTemplate, 'landscape')} className={isPortraitTemplate ? 'bg-white font-black' : 'bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]'}>عرضي</Button>
                      <Button type="button" variant={isPortraitTemplate ? 'default' : 'outline'} onClick={() => setTemplateOrientation(selectedTemplate, 'portrait')} className={isPortraitTemplate ? 'bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]' : 'bg-white font-black'}>طولي</Button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-[11px] font-black text-slate-600">الحقل المحدد</Label>
                    <Select value={selectedTemplateField} onValueChange={setSelectedTemplateField}>
                      <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.keys(TEMPLATE_FIELD_LABELS).map((key) => <SelectItem key={key} value={key}>{TEMPLATE_FIELD_LABELS[key]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {selectedTemplateField !== 'qr' ? (
                    <div className="grid grid-cols-2 gap-2 rounded-xl bg-white p-3">
                      <div className="space-y-1"><Label className="text-[10px] font-bold">حجم الخط</Label><Input type="number" step="0.1" min="0.8" max="8" value={selectedLayout[selectedTemplateField]?.fontSize ?? 2} onChange={(e) => patchTemplateLayout(selectedTemplate, selectedTemplateField, { fontSize: Number(e.target.value || 2) })} /></div>
                      <div className="space-y-1"><Label className="text-[10px] font-bold">العرض %</Label><Input type="number" min="10" max="95" value={selectedLayout[selectedTemplateField]?.width ?? 50} onChange={(e) => patchTemplateLayout(selectedTemplate, selectedTemplateField, { width: Number(e.target.value || 50) })} /></div>
                      <div className="space-y-1"><Label className="text-[10px] font-bold">اللون</Label><Input type="color" value={selectedLayout[selectedTemplateField]?.color || '#0f2b46'} onChange={(e) => patchTemplateLayout(selectedTemplate, selectedTemplateField, { color: e.target.value })} /></div>
                      <div className="space-y-1"><Label className="text-[10px] font-bold">المحاذاة</Label><Select value={selectedLayout[selectedTemplateField]?.align || 'center'} onValueChange={(v) => patchTemplateLayout(selectedTemplate, selectedTemplateField, { align: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="right">يمين</SelectItem><SelectItem value="center">وسط</SelectItem><SelectItem value="left">يسار</SelectItem></SelectContent></Select></div>
                    </div>
                  ) : (
                    <div className="rounded-xl bg-white p-3"><Label className="text-[10px] font-bold">حجم QR %</Label><Input type="number" min="5" max="30" value={selectedLayout.qr?.size ?? 12} onChange={(e) => patchTemplateLayout(selectedTemplate, 'qr', { size: Number(e.target.value || 12) })} /></div>
                  )}
                  <div className="rounded-xl border border-amber-100 bg-amber-50 p-3 text-[11px] font-bold leading-5 text-amber-900">اسحب الحقل من داخل الصورة. القيم تُحفظ كنسب مئوية حتى يبقى التخطيط صحيحاً مهما تغيّر حجم القالب.</div>
                </div>
                <div
                  ref={templateCanvasRef}
                  className={`relative ${templateAspectClass} overflow-hidden rounded-2xl border border-[#0f2b46]/10 bg-white shadow-inner`}
                  onPointerMove={(e) => {
                    if (e.buttons !== 1 || !selectedTemplate) return
                    moveTemplateField(selectedTemplate, selectedTemplateField, e.clientX, e.clientY)
                  }}
                  onPointerDown={(e) => {
                    if (!selectedTemplate) return
                    moveTemplateField(selectedTemplate, selectedTemplateField, e.clientX, e.clientY)
                  }}
                >
                  <img src={selectedTemplate.imageUrl} alt={selectedTemplate.name} className="absolute inset-0 h-full w-full object-cover" />
                  {Object.keys(TEMPLATE_FIELD_LABELS).map((field) => {
                    const cfg = selectedLayout[field]
                    if (cfg?.visible === false) return null
                    return (
                      <button
                        key={field}
                        type="button"
                        onPointerDown={(e) => { e.stopPropagation(); setSelectedTemplateField(field); if (selectedTemplate) moveTemplateField(selectedTemplate, field, e.clientX, e.clientY) }}
                        style={designerFieldStyle(field)}
                        className="select-none"
                      >
                        {field === 'qr' ? 'QR' : sampleValues[field]}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <CertificateDialog certificate={selected} open={open} onClose={() => setOpen(false)} />

      <Dialog open={!!templatePendingDelete} onOpenChange={(v) => !v && setTemplatePendingDelete(null)}>
        <DialogContent className="max-w-md rounded-[2rem] border border-red-100 bg-white p-0" dir="rtl">
          <div className="rounded-t-[2rem] bg-gradient-to-l from-red-700 to-[#0f2b46] px-5 py-5 text-[#f5f0e1]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-lg font-black">
                <Trash2 className="h-5 w-5" /> حذف قالب الشهادة
              </DialogTitle>
              <DialogDescription className="text-xs font-bold leading-6 text-[#f5f0e1]/80">
                سيتم حذف القالب من لوحة القوالب ولن تستخدمه الشهادات الجديدة أو المعاينات القادمة.
              </DialogDescription>
            </DialogHeader>
          </div>
          <div className="space-y-4 p-5">
            <div className="rounded-2xl border border-red-100 bg-red-50 p-4 text-sm font-bold leading-7 text-red-900">
              هل تريد حذف قالب الشهادة
              <span className="mx-1 font-black">«{templatePendingDelete?.name || ''}»</span>
              ؟
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" onClick={() => setTemplatePendingDelete(null)} disabled={templateBusy} className="font-black">إلغاء</Button>
              <Button type="button" onClick={() => templatePendingDelete && deleteCertificateTemplate(templatePendingDelete)} disabled={templateBusy} className="bg-red-700 font-black text-white hover:bg-red-800">
                {templateBusy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Trash2 className="ml-2 h-4 w-4" />} نعم، احذف القالب
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">إصدار شهادة جديدة</DialogTitle>
            <DialogDescription>يولد النظام الرقم التسلسلي ورمز QR تلقائياً</DialogDescription>
          </DialogHeader>
          <div className="space-y-3.5">
            <div className="space-y-1.5"><Label>اسم صاحب الشهادة *</Label>
              <Input value={form.holderName} onChange={(e) => setForm({ ...form, holderName: e.target.value })} /></div>
            <div className="space-y-1.5"><Label>البرنامج / نوع الاعتماد *</Label>
              <Input value={form.program} onChange={(e) => setForm({ ...form, program: e.target.value })}
                placeholder="مثال: الدبلوم المهني في إدارة الموارد البشرية" /></div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5"><Label>الدرجة/التقدير</Label>
                <Input value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} placeholder="مثال: 92% أو امتياز" /></div>
              <div className="space-y-1.5"><Label>الدولة</Label>
                <Input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} /></div>
            </div>
            <Button onClick={issue} disabled={busy || !form.holderName.trim() || !form.program.trim()}
              className="w-full bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
              {busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Award className="ml-2 h-4 w-4" />} إصدار الشهادة
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ============ إدارة الرسوم ومدراء النظام (بدون كود) ============

interface SystemAdminAccount {
  id: string
  name: string
  email: string
  role: string
  status: string
  createdAt: string
  updatedAt: string
}

interface AccreditationAdminDocument {
  id: string
  kind: string
  title: string
  description: string
  verifyUrl: string
  fileName: string
  mimeType: string
  fileSize: number
  active: boolean
  partnershipId?: string | null
  previewUrl: string
  downloadUrl: string
}

interface AccreditationAdminPartnership {
  id?: string
  name: string
  type?: string
  description?: string
  verifyUrl?: string
  active?: boolean
  displayOrder?: number
  documents?: AccreditationAdminDocument[]
}

interface AccreditationAdminProfile {
  id?: string
  licenseNumber: string
  licenseVerifyUrl: string
  licensingAuthority: string
  trustNote: string
  partnerships: AccreditationAdminPartnership[]
  documents: AccreditationAdminDocument[]
}

export function AdminSettingsTab() {
  const { toast } = useToast()
  const { confirmAction, dialog: actionDialog } = useAdminActionDialog()
  const [values, setValues] = useState<Record<string, string>>({})
  const [defs, setDefs] = useState<{ key: string; label: string; group: string; suffix: string; inputType?: 'number' | 'text' | 'textarea' | 'json'; help?: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [admins, setAdmins] = useState<SystemAdminAccount[]>([])
  const [adminsLoading, setAdminsLoading] = useState(true)
  const [adminBusy, setAdminBusy] = useState<string | null>(null)
  const [accreditationProfile, setAccreditationProfile] = useState<AccreditationAdminProfile | null>(null)
  const [accreditationSaving, setAccreditationSaving] = useState(false)
  const [accreditationUploadBusy, setAccreditationUploadBusy] = useState(false)
  const [accreditationUploadFile, setAccreditationUploadFile] = useState<File | null>(null)
  const [accreditationUpload, setAccreditationUpload] = useState({ title: '', kind: 'LICENSE', description: '', verifyUrl: '', partnershipId: '' })
  const [adminForm, setAdminForm] = useState({
    name: 'QA Admin',
    email: 'qa-admin@aactacademy.com',
    password: '',
  })

  const loadSystemAdmins = () => {
    setAdminsLoading(true)
    api<{ admins: SystemAdminAccount[] }>('/api/admin/system-admins')
      .then((d) => setAdmins(Array.isArray(d.admins) ? d.admins : []))
      .catch((e: any) => toast({ title: 'تعذر تحميل مدراء النظام', description: e.message, variant: 'destructive' }))
      .finally(() => setAdminsLoading(false))
  }

  const loadAccreditationProfile = () => {
    api<{ profile: AccreditationAdminProfile }>('/api/admin/accreditation')
      .then((d) => setAccreditationProfile(d.profile))
      .catch((e: any) => toast({ title: 'تعذر تحميل بيانات الاعتماد', description: e.message, variant: 'destructive' }))
  }

  useEffect(() => {
    loadSystemAdmins()
    loadAccreditationProfile()
    api<{ values: any; defs?: any[] }>('/api/settings')
      .then((d) => {
        setValues(d.values)
        setDefs(d.defs || [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const res = await api<{ values?: Record<string, string> }>('/api/settings', { method: 'PUT', body: JSON.stringify({ values }) })
      if (res.values) setValues((prev) => ({ ...prev, ...res.values }))
      toast({ title: 'حُفظت الإعدادات العامة', description: 'تُطبق القيم الجديدة فوراً — سُجل الإجراء في سجل التدقيق' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const createSystemAdmin = async () => {
    const email = adminForm.email.trim().toLowerCase()
    if (!email || !email.includes('@')) {
      toast({ title: 'البريد مطلوب', description: 'أدخل بريد حساب الإدارة الاختباري بشكل صحيح.', variant: 'destructive' })
      return
    }
    if (adminForm.password.length < 12) {
      toast({ title: 'كلمة المرور قصيرة', description: 'استخدم كلمة مرور من 12 حرفاً على الأقل.', variant: 'destructive' })
      return
    }
    setAdminBusy('create')
    try {
      await api('/api/admin/system-admins', {
        method: 'POST',
        body: JSON.stringify({ ...adminForm, email }),
      })
      setAdminForm((prev) => ({ ...prev, password: '' }))
      loadSystemAdmins()
      toast({ title: 'تم تجهيز حساب الإدارة', description: 'يمكن استخدام الحساب الآن لاختبارات لوحة الإدارة ثم تعطيله من نفس القسم.' })
    } catch (e: any) {
      toast({ title: 'تعذر إنشاء حساب الإدارة', description: e.message, variant: 'destructive' })
    } finally {
      setAdminBusy(null)
    }
  }

  const disableSystemAdmin = async (admin: SystemAdminAccount) => {
    const ok = await confirmAction({
      title: 'تعطيل حساب إدارة',
      description: `سيتم تعطيل حساب ${admin.email}، حذف جلساته، ومنعه من تسجيل الدخول مع الحفاظ على سجل التدقيق.`,
      confirmLabel: 'تعطيل الحساب',
      tone: 'danger',
    })
    if (!ok) return
    setAdminBusy(admin.id)
    try {
      await api(`/api/admin/system-admins?id=${encodeURIComponent(admin.id)}`, { method: 'DELETE' })
      loadSystemAdmins()
      toast({ title: 'تم تعطيل حساب الإدارة', description: 'لم يتم حذف السجل التاريخي، وتم إبطال جلسات الحساب.' })
    } catch (e: any) {
      toast({ title: 'تعذر تعطيل الحساب', description: e.message, variant: 'destructive' })
    } finally {
      setAdminBusy(null)
    }
  }

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  const groups: { key: string; label: string; note?: string }[] = [
    { key: 'FEES', label: 'الإعدادات المالية الافتراضية', note: 'سعر كل برنامج يُعدّل من قواعد القبول. هذه القيم تُستخدم فقط عند عدم وجود سعر محدد للبرنامج.' },
    { key: 'AI', label: 'باقات المحادثة الصوتية للمشرف الذكي' },
    { key: 'RULES', label: 'المهل الزمنية والنسب وفق دليل الإجراءات وعقد التمثيل' },
    { key: 'CONTENT', label: 'نصوص عامة تظهر للطلاب والزوار' },
    { key: 'CONTACT', label: 'بيانات التواصل الرسمية' },
  ]

  const readJsonSetting = <T extends Record<string, any>>(key: string, fallback: T): T => {
    try {
      const parsed = JSON.parse(values[key] || '{}')
      return { ...fallback, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
    } catch {
      return fallback
    }
  }

  const patchJsonSetting = (key: string, patch: Record<string, any>, fallback: Record<string, any>) => {
    setValues((prev) => {
      let current = fallback
      try {
        const parsed = JSON.parse(prev[key] || '{}')
        current = { ...fallback, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
      } catch {}
      return { ...prev, [key]: JSON.stringify({ ...current, ...patch }) }
    })
  }

  const renderStructuredJsonSetting = (d: { key: string }) => {
    if (d.key === 'HOME_STATS') {
      const stats = readJsonSetting('HOME_STATS', { graduates: 2000, experts: 120, countries: 18 })
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label className="text-[11px] font-bold text-slate-600">عدد الخريجين والمتدربين</Label>
            <Input dir="ltr" type="number" className="text-left font-black" value={stats.graduates || ''} onChange={(e) => patchJsonSetting('HOME_STATS', { graduates: Number(e.target.value || 0) }, { graduates: 2000, experts: 120, countries: 18 })} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] font-bold text-slate-600">عدد الخبراء والمستشارين</Label>
            <Input dir="ltr" type="number" className="text-left font-black" value={stats.experts || ''} onChange={(e) => patchJsonSetting('HOME_STATS', { experts: Number(e.target.value || 0) }, { graduates: 2000, experts: 120, countries: 18 })} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[11px] font-bold text-slate-600">عدد الدول / الشراكات</Label>
            <Input dir="ltr" type="number" className="text-left font-black" value={stats.countries || ''} onChange={(e) => patchJsonSetting('HOME_STATS', { countries: Number(e.target.value || 0) }, { graduates: 2000, experts: 120, countries: 18 })} />
          </div>
        </div>
      )
    }
    if (d.key === 'ACCREDITATION_PAGE') {
      {
      const emptyProfile: AccreditationAdminProfile = {
        licenseNumber: '',
        licenseVerifyUrl: '',
        licensingAuthority: '',
        trustNote: 'تُعرض هنا فقط بيانات الاعتماد والشراكات التي أدخلتها الإدارة وتملك لها رابط تحقق أو وثيقة منشورة.',
        partnerships: [],
        documents: [],
      }
      const profile = accreditationProfile || emptyProfile
      const partnerships = Array.isArray(profile.partnerships) ? profile.partnerships : []
      const documents = Array.isArray(profile.documents) ? profile.documents : []
      const updateAccreditationProfile = (patch: Partial<AccreditationAdminProfile>) => setAccreditationProfile((prev) => ({ ...(prev || emptyProfile), ...patch }))
      const updateAccreditationPartnership = (index: number, patch: Partial<AccreditationAdminPartnership>) => {
        const next = [...partnerships]
        next[index] = { ...(next[index] || { name: '' }), ...patch }
        updateAccreditationProfile({ partnerships: next })
      }
      const addAccreditationPartnership = () => updateAccreditationProfile({ partnerships: [...partnerships, { name: '', type: '', description: '', verifyUrl: '', active: true, displayOrder: partnerships.length }] })
      const removeAccreditationPartnership = (index: number) => updateAccreditationProfile({ partnerships: partnerships.filter((_, i) => i !== index) })
      const saveAccreditationProfile = async () => {
        if (!profile) return
        setAccreditationSaving(true)
        try {
          const res = await api<{ profile: AccreditationAdminProfile }>('/api/admin/accreditation', { method: 'PUT', body: JSON.stringify({ profile }) })
          setAccreditationProfile(res.profile)
          toast({ title: 'حُفظت صفحة الاعتماد والتحقق', description: 'تظهر البيانات والوثائق على الصفحة العامة بعد الحفظ.' })
        } catch (e: any) {
          toast({ title: 'تعذر حفظ بيانات الاعتماد', description: e.message, variant: 'destructive' })
        } finally {
          setAccreditationSaving(false)
        }
      }
      const uploadAccreditationDocument = async () => {
        if (!accreditationUploadFile) {
          toast({ title: 'اختر ملف الوثيقة أولاً', variant: 'destructive' })
          return
        }
        if (!accreditationUpload.title.trim()) {
          toast({ title: 'عنوان الوثيقة مطلوب', variant: 'destructive' })
          return
        }
        setAccreditationUploadBusy(true)
        try {
          const form = new FormData()
          form.append('file', accreditationUploadFile)
          form.append('title', accreditationUpload.title)
          form.append('kind', accreditationUpload.kind)
          form.append('description', accreditationUpload.description)
          form.append('verifyUrl', accreditationUpload.verifyUrl)
          form.append('partnershipId', accreditationUpload.partnershipId)
          const res = await api<{ profile: AccreditationAdminProfile }>('/api/admin/accreditation/documents', { method: 'POST', body: form })
          setAccreditationProfile(res.profile)
          setAccreditationUploadFile(null)
          setAccreditationUpload({ title: '', kind: 'LICENSE', description: '', verifyUrl: '', partnershipId: '' })
          toast({ title: 'تم رفع الوثيقة', description: 'يمكن معاينتها وتحميلها الآن من صفحة الاعتماد.' })
        } catch (e: any) {
          toast({ title: 'تعذر رفع الوثيقة', description: e.message, variant: 'destructive' })
        } finally {
          setAccreditationUploadBusy(false)
        }
      }
      const deleteAccreditationDocument = async (doc: AccreditationAdminDocument) => {
        if (!confirm(`حذف الوثيقة «${doc.title}» من صفحة الاعتماد؟`)) return
        setAccreditationUploadBusy(true)
        try {
          const res = await api<{ profile: AccreditationAdminProfile }>(`/api/admin/accreditation/documents/${encodeURIComponent(doc.id)}`, { method: 'DELETE' })
          setAccreditationProfile(res.profile)
          toast({ title: 'حُذفت الوثيقة من صفحة الاعتماد' })
        } catch (e: any) {
          toast({ title: 'تعذر حذف الوثيقة', description: e.message, variant: 'destructive' })
        } finally {
          setAccreditationUploadBusy(false)
        }
      }
      return (
        <div className="space-y-4">
          <div className="rounded-2xl border border-amber-100 bg-amber-50 p-3 text-xs font-bold leading-6 text-amber-900">
            الوثائق تُرفع من هنا إلى التخزين الخارجي المضبوط في المشروع. إذا كانت متغيرات Cloudflare/R2 مضبوطة فسيتم الرفع هناك، ثم تظهر روابط معاينة وتحميل في صفحة /accreditation.
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5"><Label className="text-[11px] font-bold text-slate-600">رقم الترخيص / التسجيل</Label><Input value={profile.licenseNumber || ''} onChange={(e) => updateAccreditationProfile({ licenseNumber: e.target.value })} className="font-bold" /></div>
            <div className="space-y-1.5"><Label className="text-[11px] font-bold text-slate-600">جهة الترخيص</Label><Input value={profile.licensingAuthority || ''} onChange={(e) => updateAccreditationProfile({ licensingAuthority: e.target.value })} className="font-bold" /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label className="text-[11px] font-bold text-slate-600">رابط التحقق الرسمي</Label><Input dir="ltr" value={profile.licenseVerifyUrl || ''} placeholder="https://..." onChange={(e) => updateAccreditationProfile({ licenseVerifyUrl: e.target.value })} className="text-left font-mono text-xs" /></div>
            <div className="space-y-1.5 sm:col-span-2"><Label className="text-[11px] font-bold text-slate-600">ملاحظة الثقة</Label><Textarea value={profile.trustNote || ''} rows={3} onChange={(e) => updateAccreditationProfile({ trustNote: e.target.value })} className="font-bold leading-7" /></div>
          </div>
          <div className="flex justify-end"><Button type="button" onClick={saveAccreditationProfile} disabled={accreditationSaving} className="bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]">{accreditationSaving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="ml-2 h-4 w-4" />} حفظ بيانات صفحة الاعتماد</Button></div>

          <div className="rounded-2xl border border-[#0f2b46]/10 bg-white p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><Label className="text-sm font-black text-[#0f2b46]">الشراكات والاعتمادات</Label><p className="mt-1 text-[11px] font-bold text-slate-500">قائمة مرنة؛ أضف أي جهة موثقة، ثم ارفع وثائقها أو ضع رابط تحقق رسمي.</p></div><Button type="button" size="sm" variant="outline" onClick={addAccreditationPartnership} className="font-black">+ إضافة شراكة</Button></div>
            <div className="space-y-3">
              {partnerships.length === 0 && <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-xs font-bold text-slate-500">لا توجد شراكات بعد.</div>}
              {partnerships.map((partner, index) => (
                <div key={partner.id || index} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                  <div className="mb-3 flex items-center justify-between gap-2"><p className="text-xs font-black text-[#0f2b46]">شراكة #{index + 1}</p><Button type="button" size="sm" variant="outline" onClick={() => removeAccreditationPartnership(index)} className="text-[10px] font-black text-red-600">حذف</Button></div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5"><Label className="text-[11px] font-bold text-slate-600">اسم الجهة</Label><Input value={partner.name || ''} onChange={(e) => updateAccreditationPartnership(index, { name: e.target.value })} className="font-bold" /></div>
                    <div className="space-y-1.5"><Label className="text-[11px] font-bold text-slate-600">نوع العلاقة</Label><Input value={partner.type || ''} onChange={(e) => updateAccreditationPartnership(index, { type: e.target.value })} className="font-bold" /></div>
                    <div className="space-y-1.5 sm:col-span-2"><Label className="text-[11px] font-bold text-slate-600">وصف مختصر</Label><Textarea rows={2} value={partner.description || ''} onChange={(e) => updateAccreditationPartnership(index, { description: e.target.value })} className="font-bold leading-7" /></div>
                    <div className="space-y-1.5 sm:col-span-2"><Label className="text-[11px] font-bold text-slate-600">رابط تحقق رسمي للشراكة</Label><Input dir="ltr" value={partner.verifyUrl || ''} onChange={(e) => updateAccreditationPartnership(index, { verifyUrl: e.target.value })} className="text-left font-mono text-xs" /></div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-[#0f2b46]/10 bg-white p-4">
            <Label className="text-sm font-black text-[#0f2b46]">رفع وثيقة اعتماد / شراكة</Label>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Input value={accreditationUpload.title} placeholder="عنوان الوثيقة" onChange={(e) => setAccreditationUpload((p) => ({ ...p, title: e.target.value }))} className="font-bold" />
              <Select value={accreditationUpload.kind} onValueChange={(v) => setAccreditationUpload((p) => ({ ...p, kind: v }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="LICENSE">وثيقة ترخيص</SelectItem><SelectItem value="PARTNERSHIP">وثيقة شراكة</SelectItem><SelectItem value="OTHER">وثيقة أخرى</SelectItem></SelectContent></Select>
              <Select value={accreditationUpload.partnershipId || 'none'} onValueChange={(v) => setAccreditationUpload((p) => ({ ...p, partnershipId: v === 'none' ? '' : v }))}><SelectTrigger><SelectValue placeholder="ربط بشراكة" /></SelectTrigger><SelectContent><SelectItem value="none">وثيقة عامة للترخيص</SelectItem>{partnerships.filter((p) => p.id).map((p) => <SelectItem key={p.id} value={p.id!}>{p.name || 'شراكة بدون اسم'}</SelectItem>)}</SelectContent></Select>
              <Input dir="ltr" value={accreditationUpload.verifyUrl} placeholder="رابط تحقق رسمي اختياري" onChange={(e) => setAccreditationUpload((p) => ({ ...p, verifyUrl: e.target.value }))} className="text-left font-mono text-xs" />
              <Textarea rows={2} value={accreditationUpload.description} placeholder="وصف الوثيقة" onChange={(e) => setAccreditationUpload((p) => ({ ...p, description: e.target.value }))} className="font-bold leading-7 sm:col-span-2" />
              <Input type="file" accept="application/pdf,image/*,.docx,.xlsx,.xls,.txt,.csv" onChange={(e) => setAccreditationUploadFile(e.target.files?.[0] || null)} className="sm:col-span-2" />
            </div>
            <Button type="button" onClick={uploadAccreditationDocument} disabled={accreditationUploadBusy} className="mt-3 bg-[#c9a227] font-black text-[#0f2b46] hover:bg-[#e0b83a]">{accreditationUploadBusy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Upload className="ml-2 h-4 w-4" />} رفع الوثيقة</Button>
            <div className="mt-4 space-y-2">
              {documents.length === 0 && partnerships.every((p) => !p.documents?.length) && <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-xs font-bold text-slate-500">لا توجد وثائق مرفوعة بعد.</div>}
              {[...documents, ...partnerships.flatMap((p) => p.documents || [])].map((doc) => (
                <div key={doc.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs font-bold text-slate-600">
                  <div><p className="font-black text-[#0f2b46]">{doc.title}</p><p dir="ltr" className="text-[10px] text-slate-400">{doc.fileName}</p></div>
                  <div className="flex flex-wrap gap-2"><a href={doc.previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border bg-white px-2 py-1 text-[#0f2b46]"><Eye className="h-3.5 w-3.5" /> معاينة</a><a href={doc.downloadUrl} className="inline-flex items-center gap-1 rounded-lg border bg-white px-2 py-1 text-[#0f2b46]"><FileDown className="h-3.5 w-3.5" /> تحميل</a><Button type="button" size="sm" variant="outline" onClick={() => deleteAccreditationDocument(doc)} className="h-7 text-[10px] font-black text-red-600"><Trash2 className="ml-1 h-3.5 w-3.5" /> حذف</Button></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )
      }
      const accreditationFallback = {
        licenseNumber: '',
        licenseVerifyUrl: '',
        licenseDocumentUrl: '',
        licensingAuthority: '',
        trustNote: 'تُعرض هنا فقط بيانات الاعتماد والشراكات التي أدخلتها الإدارة وتملك لها رابط تحقق أو وثيقة منشورة.',
        partnerships: [] as Array<{ name: string; type?: string; description?: string; verifyUrl?: string; documentUrl?: string }>,
      }
      const accreditation = readJsonSetting('ACCREDITATION_PAGE', accreditationFallback)
      const partnerships = Array.isArray(accreditation.partnerships) ? accreditation.partnerships : []
      const patchPartnerships = (next: typeof partnerships) => patchJsonSetting('ACCREDITATION_PAGE', { partnerships: next }, accreditationFallback)
      const updatePartnership = (index: number, patch: Partial<typeof partnerships[number]>) => {
        const next = partnerships.length ? [...partnerships] : []
        next[index] = { ...(next[index] || { name: '' }), ...patch }
        patchPartnerships(next)
      }
      const addPartnership = () => patchPartnerships([...partnerships, { name: '', type: '', description: '', verifyUrl: '', documentUrl: '' }])
      const removePartnership = (index: number) => patchPartnerships(partnerships.filter((_, i) => i !== index))
      return (
        <div className="space-y-4">
          <div className="rounded-2xl border border-amber-100 bg-amber-50 p-3 text-xs font-bold leading-6 text-amber-900">
            ضع روابط الوثائق المستضافة خارج المنصة فقط، مثل روابط Cloudflare R2 أو Cloudflare Images أو أي رابط تحقق رسمي. لا يتم رفع ملفات الاعتماد داخل المنصة من هذا القسم.
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] font-bold text-slate-600">رقم الترخيص / التسجيل</Label>
              <Input value={accreditation.licenseNumber || ''} onChange={(e) => patchJsonSetting('ACCREDITATION_PAGE', { licenseNumber: e.target.value }, accreditationFallback)} className="font-bold" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] font-bold text-slate-600">جهة الترخيص</Label>
              <Input value={accreditation.licensingAuthority || ''} onChange={(e) => patchJsonSetting('ACCREDITATION_PAGE', { licensingAuthority: e.target.value }, accreditationFallback)} className="font-bold" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] font-bold text-slate-600">رابط التحقق الرسمي</Label>
              <Input dir="ltr" value={accreditation.licenseVerifyUrl || ''} placeholder="https://..." onChange={(e) => patchJsonSetting('ACCREDITATION_PAGE', { licenseVerifyUrl: e.target.value }, accreditationFallback)} className="text-left font-mono text-xs" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px] font-bold text-slate-600">رابط وثيقة الترخيص على Cloudflare</Label>
              <Input dir="ltr" value={accreditation.licenseDocumentUrl || ''} placeholder="https://..." onChange={(e) => patchJsonSetting('ACCREDITATION_PAGE', { licenseDocumentUrl: e.target.value }, accreditationFallback)} className="text-left font-mono text-xs" />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label className="text-[11px] font-bold text-slate-600">ملاحظة الثقة على صفحة الاعتماد</Label>
              <Textarea value={accreditation.trustNote || ''} rows={3} onChange={(e) => patchJsonSetting('ACCREDITATION_PAGE', { trustNote: e.target.value }, accreditationFallback)} className="font-bold leading-7" />
            </div>
          </div>

          <div className="rounded-2xl border border-[#0f2b46]/10 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-black text-[#0f2b46]">الشراكات والاعتمادات المرتبطة</Label>
                <p className="mt-1 text-[11px] font-bold text-slate-500">أضف أي شراكة جديدة باسمها وروابط التحقق أو الوثائق. لا توجد أسماء ثابتة في الكود.</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={addPartnership} className="font-black">+ إضافة شراكة</Button>
            </div>
            <div className="mt-4 space-y-3">
              {partnerships.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50 p-4 text-xs font-bold text-slate-500">
                  لا توجد شراكات مدخلة بعد. أضف شراكة فقط إذا كانت لديك وثيقة أو رابط تحقق رسمي.
                </div>
              )}
              {partnerships.map((partner, index) => (
                <div key={index} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-xs font-black text-[#0f2b46]">شراكة #{index + 1}</p>
                    <Button type="button" size="sm" variant="outline" onClick={() => removePartnership(index)} className="text-[10px] font-black text-red-600">حذف</Button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-bold text-slate-600">اسم الجهة</Label>
                      <Input value={partner.name || ''} placeholder="مثال: جامعة القاهرة" onChange={(e) => updatePartnership(index, { name: e.target.value })} className="font-bold" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-bold text-slate-600">نوع العلاقة</Label>
                      <Input value={partner.type || ''} placeholder="شراكة / اعتماد / تعاون" onChange={(e) => updatePartnership(index, { type: e.target.value })} className="font-bold" />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label className="text-[11px] font-bold text-slate-600">وصف مختصر</Label>
                      <Textarea value={partner.description || ''} rows={2} onChange={(e) => updatePartnership(index, { description: e.target.value })} className="font-bold leading-7" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-bold text-slate-600">رابط تحقق رسمي</Label>
                      <Input dir="ltr" value={partner.verifyUrl || ''} placeholder="https://..." onChange={(e) => updatePartnership(index, { verifyUrl: e.target.value })} className="text-left font-mono text-xs" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-[11px] font-bold text-slate-600">رابط الوثيقة على Cloudflare</Label>
                      <Input dir="ltr" value={partner.documentUrl || ''} placeholder="https://..." onChange={(e) => updatePartnership(index, { documentUrl: e.target.value })} className="text-left font-mono text-xs" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )
    }
    if (d.key === 'OFFICIAL_CONTACT') {
      const contactFallback = { legalEntity: '', registrationNumber: '', address: '', email: '', phone: '', phones: [] as string[], whatsapp: '', whatsapps: [] as string[], responsiblePerson: '' }
      const contact = readJsonSetting('OFFICIAL_CONTACT', contactFallback)
      const contactItems = (primary: string, list: string[]) => {
        const raw = [primary, ...(Array.isArray(list) ? list : [])].map((v) => String(v || '').trim())
        const clean = Array.from(new Set(raw.filter(Boolean)))
        const hasBlankRow = raw.some((v) => !v)
        return clean.length ? (hasBlankRow ? [...clean, ''] : clean) : ['']
      }
      const patchContactItems = (listKey: 'phones' | 'whatsapps', primaryKey: 'phone' | 'whatsapp', items: string[]) => {
        const raw = items.map((v) => String(v || '').trim())
        const clean = Array.from(new Set(raw.filter(Boolean)))
        patchJsonSetting('OFFICIAL_CONTACT', { [primaryKey]: clean[0] || '', [listKey]: raw.length ? raw : [] }, contactFallback)
      }
      const updateContactItem = (listKey: 'phones' | 'whatsapps', primaryKey: 'phone' | 'whatsapp', current: string[], index: number, value: string) => {
        const next = current.length ? [...current] : ['']
        next[index] = value
        patchContactItems(listKey, primaryKey, next)
      }
      const addContactItem = (listKey: 'phones' | 'whatsapps', primaryKey: 'phone' | 'whatsapp', current: string[]) => {
        patchContactItems(listKey, primaryKey, [...current, ''])
      }
      const removeContactItem = (listKey: 'phones' | 'whatsapps', primaryKey: 'phone' | 'whatsapp', current: string[], index: number) => {
        patchContactItems(listKey, primaryKey, current.filter((_, i) => i !== index))
      }
      const phoneItems = contactItems(contact.phone, contact.phones)
      const whatsappItems = contactItems(contact.whatsapp, contact.whatsapps)
      const fields: Array<[string, string, string, 'rtl' | 'ltr']> = [
        ['legalEntity', 'الكيان القانوني', 'الأكاديمية الأمريكية للاستشارات والتدريب', 'rtl'],
        ['registrationNumber', 'رقم التسجيل', '', 'rtl'],
        ['address', 'العنوان الرسمي', '', 'rtl'],
        ['email', 'الإيميل الرسمي', 'info@example.com', 'ltr'],
        ['responsiblePerson', 'الشخص المسؤول', '', 'rtl'],
      ]
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map(([key, label, placeholder, dir]) => (
            <div key={key} className="space-y-1.5">
              <Label className="text-[11px] font-bold text-slate-600">{label}</Label>
              <Input
                dir={dir}
                className={dir === 'ltr' ? 'text-left font-bold' : 'font-bold'}
                value={contact[key] || ''}
                placeholder={placeholder}
                onChange={(e) => patchJsonSetting('OFFICIAL_CONTACT', { [key]: e.target.value }, contactFallback)}
              />
            </div>
          ))}
          <div className="space-y-2 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label className="text-[11px] font-bold text-slate-600">أرقام الهاتف الرسمية</Label>
                <p className="text-[10px] font-bold text-slate-400">كل رقم في خانة مستقلة. أول رقم يُحفظ أيضاً كالهاتف الأساسي للتوافق.</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => addContactItem('phones', 'phone', phoneItems)} className="text-[10px] font-black">
                + إضافة هاتف
              </Button>
            </div>
            {phoneItems.map((phone, index) => (
              <div key={`phone-${index}`} className="flex gap-2">
                <Input
                  dir="ltr"
                  className="text-left font-mono text-xs"
                  value={phone}
                  placeholder={index === 0 ? '+1 ...' : '+970 ...'}
                  onChange={(e) => updateContactItem('phones', 'phone', phoneItems, index, e.target.value)}
                />
                <Button type="button" size="sm" variant="outline" disabled={phoneItems.length === 1 && !phone} onClick={() => removeContactItem('phones', 'phone', phoneItems, index)} className="text-[10px] font-black text-red-600">
                  حذف
                </Button>
              </div>
            ))}
          </div>
          <div className="space-y-2 sm:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <div>
                <Label className="text-[11px] font-bold text-slate-600">أرقام الواتساب الرسمية</Label>
                <p className="text-[10px] font-bold text-slate-400">كل رقم في خانة مستقلة. أول رقم يستخدمه زر الواتساب العائم كرابط مباشر.</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => addContactItem('whatsapps', 'whatsapp', whatsappItems)} className="text-[10px] font-black">
                + إضافة واتساب
              </Button>
            </div>
            {whatsappItems.map((whatsapp, index) => (
              <div key={`whatsapp-${index}`} className="flex gap-2">
                <Input
                  dir="ltr"
                  className="text-left font-mono text-xs"
                  value={whatsapp}
                  placeholder={index === 0 ? '+1 ...' : '+970 ...'}
                  onChange={(e) => updateContactItem('whatsapps', 'whatsapp', whatsappItems, index, e.target.value)}
                />
                <Button type="button" size="sm" variant="outline" disabled={whatsappItems.length === 1 && !whatsapp} onClick={() => removeContactItem('whatsapps', 'whatsapp', whatsappItems, index)} className="text-[10px] font-black text-red-600">
                  حذف
                </Button>
              </div>
            ))}
          </div>
        </div>
      )
    }
    return null
  }

  return (
    <div className="mt-4 space-y-5">
      {actionDialog}
      <Card className="border-[#c9a227]/30 bg-[#fdf8e7]">
        <CardContent className="p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                <ShieldCheck className="h-4.5 w-4.5 text-[#a8841a]" /> مدراء النظام وحساب الاختبار
              </h3>
              <p className="mt-1 max-w-3xl text-xs font-bold leading-6 text-slate-600">
                أنشئ حساب إدارة مؤقت لاختبارات الإطلاق من داخل المنصة. التعطيل هنا يحذف جلسات الحساب ويمنع دخوله مع الحفاظ على سجل التدقيق.
              </p>
            </div>
            <Badge className="w-fit bg-[#0f2b46] text-[#f5f0e1]">محمي بصلاحية ADMIN</Badge>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="admin-name" className="text-[11px] font-bold text-slate-600">الاسم</Label>
              <Input
                id="admin-name"
                value={adminForm.name}
                onChange={(e) => setAdminForm({ ...adminForm, name: e.target.value })}
                placeholder="QA Admin"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-email" className="text-[11px] font-bold text-slate-600">البريد الإلكتروني</Label>
              <Input
                id="admin-email"
                dir="ltr"
                type="email"
                className="text-left"
                value={adminForm.email}
                onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })}
                placeholder="qa-admin@aactacademy.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-password" className="text-[11px] font-bold text-slate-600">كلمة المرور المؤقتة</Label>
              <Input
                id="admin-password"
                dir="ltr"
                type="password"
                className="text-left"
                value={adminForm.password}
                onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })}
                placeholder="12+ characters"
              />
            </div>
            <Button
              onClick={createSystemAdmin}
              disabled={adminBusy === 'create'}
              className="self-end bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]"
            >
              {adminBusy === 'create' ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <KeyRound className="ml-2 h-4 w-4" />}
              إنشاء / تحديث
            </Button>
          </div>

          <div className="mt-5 rounded-2xl border border-[#0f2b46]/10 bg-white p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-xs font-black text-[#0f2b46]">الحسابات الإدارية الحالية</p>
              <Button type="button" variant="ghost" size="sm" onClick={loadSystemAdmins} disabled={adminsLoading} className="h-8 text-xs font-bold">
                {adminsLoading ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="ml-1 h-3.5 w-3.5" />}
                تحديث
              </Button>
            </div>
            {adminsLoading ? (
              <div className="flex h-20 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[#c9a227]" /></div>
            ) : admins.length === 0 ? (
              <div className="rounded-xl bg-slate-50 p-4 text-center text-xs font-bold text-slate-500">لا توجد حسابات إدارة ظاهرة.</div>
            ) : (
              <div className="space-y-2">
                {admins.map((admin) => {
                  const disabled = admin.status === 'DISABLED' || admin.status === 'ARCHIVED'
                  return (
                    <div key={admin.id} className="flex flex-col gap-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-black text-[#0f2b46]">{admin.name}</p>
                          <Badge variant={disabled ? 'outline' : 'default'} className={disabled ? 'border-slate-300 text-slate-500' : 'bg-emerald-600 text-white'}>
                            {disabled ? 'معطّل' : 'نشط'}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate text-xs font-bold text-slate-500" dir="ltr">{admin.email}</p>
                        <p className="mt-1 text-[10px] font-bold text-slate-400">أُنشئ: {new Date(admin.createdAt).toLocaleDateString('ar-EG')}</p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled || adminBusy === admin.id}
                        onClick={() => disableSystemAdmin(admin)}
                        className="border-red-200 font-extrabold text-red-600 hover:bg-red-50"
                      >
                        {adminBusy === admin.id ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="ml-1 h-3.5 w-3.5" />}
                        تعطيل / حذف آمن
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {groups.map((g) => (
        <Card key={g.key} className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
              <Settings2 className="h-4.5 w-4.5 text-[#c9a227]" /> {g.label}
            </h3>
            {g.note && <p className="mb-4 text-xs font-bold leading-6 text-slate-500">{g.note}</p>}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {defs.filter((d) => d.group === g.key).map((d) => {
                const inputType = d.inputType || 'number'
                const wide = inputType === 'textarea' || inputType === 'json'
                const structuredJsonControl = inputType === 'json' ? renderStructuredJsonSetting(d) : null
                return (
                  <div key={d.key} className={`rounded-xl border border-slate-100 bg-slate-50/60 p-3 ${wide ? 'sm:col-span-2 lg:col-span-3' : ''}`}>
                    <Label htmlFor={d.key} className="text-[11px] font-bold leading-snug text-slate-600">{d.label}</Label>
                    {d.help && <p className="mt-1 text-[10px] font-bold leading-5 text-slate-400">{d.help}</p>}
                    <div className="relative mt-2">
                      {structuredJsonControl ? (
                        structuredJsonControl
                      ) : inputType === 'textarea' || inputType === 'json' ? (
                        <Textarea
                          id={d.key}
                          dir={inputType === 'json' ? 'ltr' : 'rtl'}
                          rows={inputType === 'json' ? 7 : 4}
                          className={inputType === 'json' ? 'font-mono text-xs text-left' : 'text-xs font-bold leading-6'}
                          value={values[d.key] || ''}
                          onChange={(e) => setValues({ ...values, [d.key]: e.target.value })}
                        />
                      ) : (
                        <Input
                          id={d.key}
                          dir="ltr"
                          type={inputType === 'number' ? 'number' : 'text'}
                          className="pl-9 text-left font-black"
                          value={values[d.key] || ''}
                          onChange={(e) => setValues({ ...values, [d.key]: e.target.value })}
                        />
                      )}
                      {d.suffix && inputType !== 'textarea' && inputType !== 'json' && (
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-[#a8841a]">{d.suffix}</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      ))}
      <Button onClick={save} disabled={saving} className="w-full max-w-md bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
        {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Settings2 className="ml-2 h-4 w-4" />}
        حفظ التعديلات (بدون كود — فوري)
      </Button>
    </div>
  )
}

export function AdminAdminsTab() {
  const { toast } = useToast()
  const { confirmAction, dialog: actionDialog } = useAdminActionDialog()
  const [admins, setAdmins] = useState<SystemAdminAccount[]>([])
  const [adminsLoading, setAdminsLoading] = useState(true)
  const [adminBusy, setAdminBusy] = useState<string | null>(null)
  const [adminForm, setAdminForm] = useState({
    name: 'QA Admin',
    email: 'qa-admin@aactacademy.com',
    password: '',
  })

  const loadSystemAdmins = () => {
    setAdminsLoading(true)
    api<{ admins: SystemAdminAccount[] }>('/api/admin/system-admins')
      .then((d) => setAdmins(Array.isArray(d.admins) ? d.admins : []))
      .catch((e: any) => toast({ title: 'تعذر تحميل مدراء النظام', description: e.message, variant: 'destructive' }))
      .finally(() => setAdminsLoading(false))
  }

  useEffect(() => {
    loadSystemAdmins()
  }, [])

  const createSystemAdmin = async () => {
    const email = adminForm.email.trim().toLowerCase()
    if (!email || !email.includes('@')) {
      toast({ title: 'البريد مطلوب', description: 'أدخل بريد حساب الإدارة الاختباري بشكل صحيح.', variant: 'destructive' })
      return
    }
    if (adminForm.password.length < 12) {
      toast({ title: 'كلمة المرور قصيرة', description: 'استخدم كلمة مرور من 12 حرفاً على الأقل.', variant: 'destructive' })
      return
    }
    setAdminBusy('create')
    try {
      await api('/api/admin/system-admins', {
        method: 'POST',
        body: JSON.stringify({ ...adminForm, email }),
      })
      setAdminForm((prev) => ({ ...prev, password: '' }))
      loadSystemAdmins()
      toast({ title: 'تم تجهيز حساب الإدارة', description: 'يمكن استخدام الحساب الآن لاختبارات لوحة الإدارة ثم تعطيله من نفس القسم.' })
    } catch (e: any) {
      toast({ title: 'تعذر إنشاء حساب الإدارة', description: e.message, variant: 'destructive' })
    } finally {
      setAdminBusy(null)
    }
  }

  const disableSystemAdmin = async (admin: SystemAdminAccount) => {
    if (!confirm(`تعطيل حساب الإدارة ${admin.email}؟ سيتم حذف جلساته ومنعه من تسجيل الدخول.`)) return
    setAdminBusy(admin.id)
    try {
      await api(`/api/admin/system-admins?id=${encodeURIComponent(admin.id)}`, { method: 'DELETE' })
      loadSystemAdmins()
      toast({ title: 'تم تعطيل حساب الإدارة', description: 'لم يتم حذف السجل التاريخي، وتم إبطال جلسات الحساب.' })
    } catch (e: any) {
      toast({ title: 'تعذر تعطيل الحساب', description: e.message, variant: 'destructive' })
    } finally {
      setAdminBusy(null)
    }
  }

  return (
    <div className="mt-4 space-y-5">
      <Card className="border-[#c9a227]/30 bg-[#fdf8e7]">
        <CardContent className="p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                <ShieldCheck className="h-4.5 w-4.5 text-[#a8841a]" /> مدراء النظام وحساب الاختبار
              </h3>
              <p className="mt-1 max-w-3xl text-xs font-bold leading-6 text-slate-600">
                أنشئ حساب إدارة مؤقت لاختبارات الإطلاق من داخل المنصة. التعطيل هنا يحذف جلسات الحساب ويمنع دخوله مع الحفاظ على سجل التدقيق.
              </p>
            </div>
            <Badge className="w-fit bg-[#0f2b46] text-[#f5f0e1]">محمي بصلاحية ADMIN</Badge>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="admins-tab-admin-name" className="text-[11px] font-bold text-slate-600">الاسم</Label>
              <Input
                id="admins-tab-admin-name"
                value={adminForm.name}
                onChange={(e) => setAdminForm({ ...adminForm, name: e.target.value })}
                placeholder="QA Admin"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admins-tab-admin-email" className="text-[11px] font-bold text-slate-600">البريد الإلكتروني</Label>
              <Input
                id="admins-tab-admin-email"
                dir="ltr"
                type="email"
                className="text-left"
                value={adminForm.email}
                onChange={(e) => setAdminForm({ ...adminForm, email: e.target.value })}
                placeholder="qa-admin@aactacademy.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admins-tab-admin-password" className="text-[11px] font-bold text-slate-600">كلمة المرور المؤقتة</Label>
              <Input
                id="admins-tab-admin-password"
                dir="ltr"
                type="password"
                className="text-left"
                value={adminForm.password}
                onChange={(e) => setAdminForm({ ...adminForm, password: e.target.value })}
                placeholder="12+ characters"
              />
            </div>
            <Button
              onClick={createSystemAdmin}
              disabled={adminBusy === 'create'}
              className="self-end bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]"
            >
              {adminBusy === 'create' ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <KeyRound className="ml-2 h-4 w-4" />}
              إنشاء / تحديث
            </Button>
          </div>

          <div className="mt-5 rounded-2xl border border-[#0f2b46]/10 bg-white p-3">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-xs font-black text-[#0f2b46]">الحسابات الإدارية الحالية</p>
              <Button type="button" variant="ghost" size="sm" onClick={loadSystemAdmins} disabled={adminsLoading} className="h-8 text-xs font-bold">
                {adminsLoading ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="ml-1 h-3.5 w-3.5" />}
                تحديث
              </Button>
            </div>
            {adminsLoading ? (
              <div className="flex h-20 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[#c9a227]" /></div>
            ) : admins.length === 0 ? (
              <div className="rounded-xl bg-slate-50 p-4 text-center text-xs font-bold text-slate-500">لا توجد حسابات إدارة ظاهرة.</div>
            ) : (
              <div className="space-y-2">
                {admins.map((admin) => {
                  const disabled = admin.status === 'DISABLED' || admin.status === 'ARCHIVED'
                  return (
                    <div key={admin.id} className="flex flex-col gap-3 rounded-xl border border-slate-100 bg-slate-50/70 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-black text-[#0f2b46]">{admin.name}</p>
                          <Badge variant={disabled ? 'outline' : 'default'} className={disabled ? 'border-slate-300 text-slate-500' : 'bg-emerald-600 text-white'}>
                            {disabled ? 'معطّل' : 'نشط'}
                          </Badge>
                        </div>
                        <p className="mt-1 truncate text-xs font-bold text-slate-500" dir="ltr">{admin.email}</p>
                        <p className="mt-1 text-[10px] font-bold text-slate-400">أُنشئ: {new Date(admin.createdAt).toLocaleDateString('ar-EG')}</p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={disabled || adminBusy === admin.id}
                        onClick={() => disableSystemAdmin(admin)}
                        className="border-red-200 font-extrabold text-red-600 hover:bg-red-50"
                      >
                        {adminBusy === admin.id ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="ml-1 h-3.5 w-3.5" />}
                        تعطيل / حذف آمن
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ============ سجل التدقيق ============

interface AuditRow {
  id: string
  actorName: string
  action: string
  entity: string
  details?: string | null
  createdAt: string
}

const ACTION_L: Record<string, string> = {
  APPROVE_ADMISSION: 'قبول طلب التحاق', REJECT_ADMISSION: 'رفض طلب التحاق',
  REVIEW_ADMISSION: 'بدء دراسة طلب', UPDATE_ADMISSION_STATUS: 'تحديث حالة طلب',
  ASSIGN_SUPERVISOR: 'تعيين مشرف', APPROVE_AGENT: 'قبول وكالة/اعتماد',
  REJECT_AGENT: 'رفض وكالة/اعتماد', ISSUE_CERTIFICATE: 'إصدار شهادة',
  PAYMENT_RECEIVED: 'استلام دفعة', CONFIRM_PAYMENT: 'تأكيد دفعة يدوياً',
  SCHEDULE_DEFENSE: 'جدولة مناقشة', APPROVE_RESULT: 'اعتماد نتيجة',
  SUBMIT_THESIS: 'تسليم بحث', UPDATE_SETTINGS: 'تحديث الرسوم/الإعدادات',
  CREATE_ADMIN_ACCOUNT: 'إنشاء حساب إدارة', UPDATE_ADMIN_ACCOUNT: 'تحديث حساب إدارة',
  DISABLE_ADMIN_ACCOUNT: 'تعطيل حساب إدارة',
  ADD_REVENUE_SHARE: 'تسجيل مستحق وكيل', MARK_SHARE_PAID: 'تأكيد تحويل مستحقات',
  RESOLVE_MESSAGE: 'معالجة رسالة',
  GENERATE_CURRICULUM_UNITS: 'اقتراح وحدات المنهج من الكتب',
  UPDATE_CURRICULUM_UNIT: 'تعديل وحدة منهج',
  DELETE_CURRICULUM_UNIT: 'حذف وحدة منهج',
  UPDATE_PROGRAM_READINESS: 'تحديث جاهزية/اعتماد منهج برنامج',
  GENERATE_QUESTION_BANK: 'توليد أسئلة لبنك الأسئلة',
  ADD_QUESTION_BANK_ITEM: 'إضافة سؤال يدوي لبنك الأسئلة',
  IMPORT_QUESTION_BANK: 'استيراد أسئلة إلى بنك الأسئلة',
  COPY_EXAM_TO_QUESTION_BANK: 'نسخ أسئلة اختبار إلى بنك الأسئلة',
  REVIEW_QUESTION_BANK_ITEM: 'مراجعة سؤال في بنك الأسئلة',
  GENERATE_PROGRAM_EXAM_FROM_QUESTION_BANK: 'توليد امتحان من بنك الأسئلة',
  IMPORT_PROGRAM_CATALOG: 'استيراد كتالوج البرامج',
  AI_KNOWLEDGE_DIAGNOSTICS: 'تشخيص معرفة الذكاء',
  DB_BACKUP_SUCCESS: 'إنشاء نسخة احتياطية',
  DB_BACKUP_PARTIAL: 'إنشاء نسخة احتياطية مع تنبيهات',
  DB_RESTORE_SUCCESS: 'استيراد نسخة احتياطية',
  DB_RESTORE_PARTIAL: 'استيراد نسخة احتياطية مع أخطاء',
  UPLOAD_BINANCE_PAY_QR: 'رفع صورة QR للدفع عبر Binance Pay',
  LIST_ACADEMY_REPRESENTATIVES: 'استعراض ممثلي الأكاديمية',
  CREATE_ACADEMY_REPRESENTATIVE: 'إضافة ممثل أكاديمية',
  UPDATE_ACADEMY_REPRESENTATIVE: 'تحديث ممثل أكاديمية',
  DELETE_ACADEMY_REPRESENTATIVE: 'حذف ممثل أكاديمية',
  WHATSAPP_WEBHOOK_RECEIVED: 'واتساب — حدث وارد',
  WHATSAPP_IMMEDIATE_GREETING_SENT: 'واتساب — ترحيب فوري',
  WHATSAPP_WEBHOOK_REJECTED: 'واتساب — حدث مرفوض',
  WHATSAPP_WEBHOOK_VERIFIED: 'واتساب — تحقق ناجح',
  WHATSAPP_WEBHOOK_VERIFY_FAILED: 'واتساب — فشل التحقق',
}

function parseAuditDetails(details?: string | null): any | null {
  if (!details) return null
  try {
    return JSON.parse(details)
  } catch {
    return null
  }
}

function humanWhatsAppError(error: string): string {
  const text = String(error || '')
  if (text.includes('#131030')) return 'الرقم كان خارج قائمة الأرقام المسموحة في وضع الاختبار.'
  if (text.includes('#131005')) return 'تم رفض الإرسال من Meta بسبب صلاحيات رمز الوصول أو حساب واتساب.'
  if (text.includes('missing_cloud_api_environment')) return 'إعدادات واتساب في Vercel غير مكتملة.'
  if (text.includes('invalid_signature')) return 'توقيع الطلب غير صالح.'
  if (text.includes('invalid_json')) return 'بيانات الطلب من واتساب غير صالحة.'
  return text.replace(/[{}\[\]"]/g, '').slice(0, 180) || 'حدث خطأ أثناء معالجة واتساب.'
}

function WhatsAppAuditDisplay({ log }: { log: AuditRow }) {
  const details = parseAuditDetails(log.details)
  if (!details || !String(log.action || '').startsWith('WHATSAPP_')) return null

  const received = Number(details.received || 0)
  const sent = Number(details.sent || 0)
  const configured = details.configured !== false
  const messages = Array.isArray(details.messages) ? details.messages : []
  const firstMessage = messages[0] || {}
  const text = String(firstMessage.text || '').trim()
  const from = String(firstMessage.from || '').trim()
  const errors = Array.isArray(details.errors) ? details.errors.filter(Boolean) : []
  const isStatusOnly = log.action === 'WHATSAPP_WEBHOOK_RECEIVED' && received === 0
  const isImmediateGreeting = log.action === 'WHATSAPP_IMMEDIATE_GREETING_SENT'

  if (isImmediateGreeting) {
    return (
      <div className="mt-1 inline-flex max-w-full items-center gap-2 rounded-full border border-emerald-100 bg-emerald-50 px-3 py-1 text-[10px] font-bold text-emerald-700">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        تم إرسال الترحيب الفوري مرة واحدة لهذه المحادثة
      </div>
    )
  }

  if (isStatusOnly) {
    const statusUpdates = Array.isArray(details.statusUpdates) ? details.statusUpdates : []
    const webhookErrors = Array.isArray(details.webhookErrors) ? details.webhookErrors : []
    const firstStatus = statusUpdates[0] || {}
    return (
      <div className="mt-2 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-[11px] font-bold text-slate-500">
        <div className="flex flex-wrap items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
          <span className="text-[#0f2b46]">تحديث حالة من واتساب — لا توجد رسالة جديدة</span>
        </div>
        {statusUpdates.length > 0 && (
          <div className="mt-2 grid gap-1 text-[10px] sm:grid-cols-2">
            <p><span className="text-slate-400">نوع الحالة:</span> {String(firstStatus.status || 'غير محدد')}</p>
            {firstStatus.recipient && <p><span className="text-slate-400">المستلم:</span> {firstStatus.recipient}</p>}
            {firstStatus.phoneNumberId && <p><span className="text-slate-400">رقم واتساب:</span> جاهز</p>}
            {firstStatus.conversationId && <p dir="ltr"><span className="text-slate-400">conversation:</span> {String(firstStatus.conversationId).slice(0, 18)}…</p>}
          </div>
        )}
        {webhookErrors.length > 0 && (
          <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[10px] text-amber-800">
            {String(webhookErrors[0]?.title || webhookErrors[0]?.message || 'يوجد خطأ من Meta في هذا الحدث')}
          </div>
        )}
      </div>
    )
  }

  const title = log.action === 'WHATSAPP_WEBHOOK_REJECTED'
    ? 'تم رفض حدث واتساب'
    : log.action === 'WHATSAPP_WEBHOOK_VERIFY_FAILED'
      ? 'فشل تحقق واتساب'
      : log.action === 'WHATSAPP_WEBHOOK_VERIFIED'
        ? 'تم تحقق واتساب بنجاح'
        : received > 0
          ? 'رسالة واتساب واردة'
          : 'حدث واتساب'

  const status = sent > 0
    ? 'تم رد الوكيل بنجاح'
    : errors.length
      ? 'وصلت الرسالة ولم يتم إرسال الرد'
      : configured
        ? 'تم الاستلام'
        : 'تحتاج إعدادات واتساب'

  return (
    <div className="mt-2 rounded-2xl border border-[#25d366]/15 bg-[#f3fff8] p-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`flex h-9 w-9 items-center justify-center rounded-full text-white ${sent > 0 ? 'bg-[#25d366]' : errors.length ? 'bg-amber-500' : 'bg-[#0f2b46]'}`}>وات</span>
          <div>
            <p className="text-xs font-black text-[#0f2b46]">{title}</p>
            <p className="text-[10px] font-bold text-slate-500">{status}</p>
          </div>
        </div>
        <Badge className={sent > 0 ? 'bg-emerald-600 text-white' : errors.length ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-600'}>
          {sent > 0 ? 'تم الرد' : errors.length ? 'بحاجة متابعة' : 'مستلم'}
        </Badge>
      </div>

      {received > 0 && (
        <div className="mt-3 grid gap-2 text-[11px] font-bold text-slate-600 sm:grid-cols-2">
          {from && <p><span className="text-slate-400">من:</span> {from}</p>}
          <p><span className="text-slate-400">الرسائل:</span> {received}</p>
          <p><span className="text-slate-400">ردود الوكيل:</span> {sent}</p>
          {firstMessage.phoneNumberId && <p><span className="text-slate-400">رقم واتساب:</span> جاهز</p>}
        </div>
      )}

      {text && (
        <div className="mt-3 rounded-xl border border-white bg-white px-3 py-2 text-sm font-black leading-7 text-[#0f2b46]">
          {text}
        </div>
      )}

      {errors.length > 0 && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold leading-6 text-amber-800">
          {humanWhatsAppError(String(errors[0]))}
        </div>
      )}
    </div>
  )
}

function parseAuditJson(details?: string | null): any | null {
  const raw = String(details || '').trim()
  if (!raw || !raw.startsWith('{')) return null
  try { return JSON.parse(raw) } catch { return null }
}

function AiKnowledgeAuditDisplay({ log }: { log: AuditRow }) {
  if (log.action !== 'AI_KNOWLEDGE_DIAGNOSTICS' && log.entity !== 'AIKnowledge') return null
  const data = parseAuditJson(log.details)
  if (!data) return <span className="text-xs font-bold text-slate-600">{log.details || log.entity}</span>
  const selected = Array.isArray(data.selectedPrograms) ? data.selectedPrograms.slice(0, 5) : []
  const scopeLabel = String(data.scope || '')
    .replace('ADMIN_ASSISTANT', 'وكيل الإدارة')
    .replace('HUMAN_SUPERVISOR', 'المشرف البشري')
    .replace('STUDENT_SUPERVISOR', 'المشرف الذكي للطالب')
    .replace('PUBLIC_VISITOR', 'زائر الموقع')
    .replace('WHATSAPP_VISITOR', 'زائر واتساب')
    .replace('DEFENSE_EXAMINER', 'مناقش البحث')
    .replace('EXAM_ASSISTANT', 'وكيل الامتحانات')
  const sourceLabel = String(data.source || '')
    .replace('SCOPED_PROGRAM_CATALOG', 'كتالوج البرامج والكتب')
    .replace('GEMINI_LIVE_SESSION_CONTEXT', 'جلسة صوتية Gemini Live')
  const reasonLabel = String(data.reason || '')
    .replace('selected_programs_ready', 'تم اختيار برامج مطابقة')
    .replace('live_session_context_prepared', 'تم تجهيز سياق جلسة صوتية')
    .replace('no_selected_programs', 'لا توجد برامج مختارة')
    .replace('no_active_programs_loaded', 'لم يتم تحميل برامج نشطة')
    .replace('query_not_program_books', 'ليس سؤال كتب/برامج')
    .replace('scope_cannot_read_program_books', 'النطاق لا يملك صلاحية قراءة كتب البرامج')
  return (
    <div className="w-full rounded-2xl border border-blue-100 bg-blue-50/60 p-3 text-right">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="bg-blue-600 text-white hover:bg-blue-600">تشخيص معرفة الذكاء</Badge>
        {scopeLabel && <Badge variant="outline" className="bg-white text-[10px] font-black text-[#0f2b46]">{scopeLabel}</Badge>}
        {sourceLabel && <Badge variant="outline" className="bg-white text-[10px] font-black text-blue-700">{sourceLabel}</Badge>}
        {reasonLabel && <span className="text-[11px] font-bold text-blue-700">{reasonLabel}</span>}
      </div>
      <div className="mt-3 grid gap-2 text-[11px] font-bold text-slate-700 sm:grid-cols-4">
        {'totalPrograms' in data && <p><span className="text-slate-400">البرامج المحمّلة:</span> {data.totalPrograms}</p>}
        {'matchedPrograms' in data && <p><span className="text-slate-400">المطابقة:</span> {data.matchedPrograms}</p>}
        {'matchedProgramsWithBooks' in data && <p><span className="text-slate-400">مطابقة وفيها كتب:</span> {data.matchedProgramsWithBooks}</p>}
        {'returnedReply' in data && <p><span className="text-slate-400">رد مباشر:</span> {data.returnedReply ? 'نعم' : 'لا'}</p>}
        {'contextLength' in data && <p><span className="text-slate-400">طول السياق:</span> {data.contextLength}</p>}
        {'systemInstructionLength' in data && <p><span className="text-slate-400">تعليمات الصوت:</span> {data.systemInstructionLength}</p>}
        {data.purpose && <p><span className="text-slate-400">نوع الجلسة:</span> {String(data.purpose).replace('SUPERVISOR', 'مشرف صوتي').replace('DISCUSSION', 'مناقشة')}</p>}
        {data.model && <p><span className="text-slate-400">النموذج:</span> {data.model}</p>}
        {data.voice && <p><span className="text-slate-400">الصوت:</span> {data.voice}</p>}
      </div>
      {data.query && (
        <div className="mt-3 rounded-xl bg-white px-3 py-2 text-[11px] font-bold leading-6 text-slate-700">
          <span className="text-slate-400">السؤال:</span> {String(data.query).slice(0, 260)}
        </div>
      )}
      {selected.length > 0 && (
        <div className="mt-3 space-y-2">
          {selected.map((program: any, i: number) => (
            <div key={`${program.titleAr || program.titleEn || i}`} className="rounded-xl bg-white px-3 py-2 text-[11px] font-bold leading-6 text-[#0f2b46]">
              <p>{i + 1}. {program.titleAr || program.titleEn || 'برنامج بلا عنوان'}</p>
              <p className="text-slate-500">التصنيف: {program.category || 'غير محدد'} — درجة المطابقة: {program.score ?? 0} — عدد الكتب: {program.booksCount ?? 0}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const SETTING_KEY_LABELS: Record<string, string> = {
  SMTP_HOST: 'خادم البريد', SMTP_PORT: 'منفذ البريد', SMTP_USER: 'حساب البريد', SMTP_FROM: 'بريد الإرسال', SMTP_NAME: 'اسم المرسل', SMTP_ENABLED: 'تفعيل البريد',
  RESEND_API_KEY: 'مفتاح Resend', RESEND_FROM: 'مرسل Resend', MAIL_FROM: 'بريد الإرسال',
  PAYMENT_MODE: 'وضع الدفع', PAYPAL_CLIENT_ID: 'حساب PayPal', PAYPAL_API_BASE: 'بيئة PayPal',
  USDT_WALLET_ADDRESS: 'محفظة USDT', USDT_BINANCE_PAY_USER_ID: 'حساب Binance Pay', USDT_BINANCE_PAY_QR_IMAGE_URL: 'صورة QR للدفع', USDT_NETWORK: 'شبكة الدفع', USDT_PAYMENT_INSTRUCTIONS: 'تعليمات الدفع',
  TURN_URL: 'خادم TURN', TURN_TCP_URL: 'خادم TURN TCP', TURN_USERNAME: 'مستخدم TURN', TURN_CREDENTIAL: 'كلمة مرور TURN', STUN_URLS: 'خوادم STUN',
  GEMINI_API_KEY: 'مفتاح Gemini', GEMINI_TEXT_MODEL: 'نموذج النص', GEMINI_TTS_MODEL: 'نموذج الصوت', GEMINI_LIVE_MODEL: 'نموذج المحادثة الصوتية', GEMINI_SUPERVISOR_LIVE_MODEL: 'نموذج المشرف الصوتي', GEMINI_DISCUSSION_LIVE_MODEL: 'نموذج المناقشة الصوتية', GEMINI_DISCUSSION_THINKING_LEVEL: 'مستوى تفكير المناقشة', GEMINI_TTS_VOICE: 'صوت Gemini',
  TOPTOOLS_API_KEY: 'مفتاح Top Tools AI', TOPTOOLS_API_KEYS: 'مفاتيح Top Tools AI', TOPTOOLS_TEXT_MODEL: 'نموذج Top Tools AI', TOPTOOLS_BASE_URL: 'رابط Top Tools AI',
  AI_TEXT_PROVIDER: 'مزود النص الذكي', AI_ROUTER_POLICY: 'سياسة توجيه الذكاء',
}

function settingGroupLabel(key: string) {
  if (/^(SMTP_|RESEND_|MAIL_)/.test(key)) return 'إعدادات البريد'
  if (/^(PAYMENT_|PAYPAL_|STRIPE_|USDT_)/.test(key)) return 'إعدادات الدفع'
  if (/^(TURN_|STUN_)/.test(key)) return 'إعدادات الفيديو والمحادثة'
  if (/^(GEMINI_|AI_|OPENAI_|ANTHROPIC_|ZAI_|GROQ_|OPENROUTER_|DEEPINFRA_|TOGETHER_|UNOROUTER_|RELAYROUTER_|TOPTOOLS_)/.test(key)) return 'إعدادات الذكاء الاصطناعي'
  if (/^(AACT_BACKUP_|CRON_)/.test(key)) return 'إعدادات النسخ الاحتياطي'
  return 'إعدادات النظام'
}

function SettingsAuditDisplay({ log }: { log: AuditRow }) {
  if (log.action !== 'UPDATE_SETTINGS') return null
  const raw = String(log.details || '')
  const keys = Array.from(new Set((raw.match(/[A-Z][A-Z0-9_]{2,}/g) || []).filter((key) => key.includes('_'))))
  if (!keys.length) return <span className="text-xs font-bold text-slate-600">تم تحديث إعدادات النظام.</span>
  const groups = Array.from(new Set(keys.map(settingGroupLabel)))
  const labels = keys.map((key) => SETTING_KEY_LABELS[key] || settingGroupLabel(key)).filter(Boolean)
  const visibleLabels = Array.from(new Set(labels)).slice(0, 10)
  const hiddenCount = Math.max(0, labels.length - visibleLabels.length)
  return (
    <div className="w-full rounded-2xl border border-slate-100 bg-slate-50 p-3 text-right">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="bg-[#0f2b46] text-white hover:bg-[#0f2b46]">تحديث إعدادات النظام</Badge>
        {groups.map((group) => (
          <Badge key={group} variant="outline" className="bg-white text-[10px] font-black text-[#0f2b46]">{group}</Badge>
        ))}
      </div>
      <p className="mt-2 text-[11px] font-bold leading-6 text-slate-600">
        تم تحديث {keys.length} بنداً من الإعدادات. تم تحويل أسماء الحقول التقنية إلى وصف إداري وإخفاء التفاصيل الحساسة.
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {visibleLabels.map((label) => (
          <span key={label} className="rounded-full bg-white px-2 py-1 text-[10px] font-bold text-slate-600 shadow-sm">{label}</span>
        ))}
        {hiddenCount > 0 && <span className="rounded-full bg-white px-2 py-1 text-[10px] font-bold text-slate-400 shadow-sm">+{hiddenCount} بند آخر</span>}
      </div>
    </div>
  )
}

function parseAuditPairs(details?: string | null) {
  const raw = String(details || '')
  const pairs: Record<string, string> = {}
  raw.split('|').map((part) => part.trim()).forEach((part) => {
    const index = part.indexOf('=')
    if (index > 0) pairs[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  })
  return pairs
}

function OperationalAuditDisplay({ log }: { log: AuditRow }) {
  const pairs = parseAuditPairs(log.details)
  if (log.action === 'LIST_ACADEMY_REPRESENTATIVES') {
    return <span className="text-xs font-bold text-slate-600">تم فتح قائمة ممثلي الأكاديمية. عدد النتائج: {pairs.count || '0'}.</span>
  }
  if (log.action === 'UPLOAD_BINANCE_PAY_QR') {
    const key = String(log.details || '').replace(/^s3:/, '')
    const fileName = key.split('/').filter(Boolean).pop() || 'صورة QR'
    return (
      <div className="rounded-2xl border border-amber-100 bg-amber-50 p-3 text-xs font-bold leading-6 text-amber-900">
        تم رفع صورة QR للدفع عبر Binance Pay وحفظها في التخزين الآمن.
        <div className="mt-1 break-all rounded-lg bg-white/70 p-2 font-mono text-[10px] text-amber-800" dir="ltr">{fileName}</div>
      </div>
    )
  }
  if (log.action === 'DB_BACKUP_SUCCESS' || log.action === 'DB_BACKUP_PARTIAL') {
    return (
      <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-3 text-xs font-bold leading-6 text-emerald-900">
        تم إنشاء نسخة احتياطية مشفرة لقاعدة البيانات.
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-white px-2 py-1 text-[10px]">المصدر: {pairs.trigger === 'manual-admin' ? 'يدوي من الإدارة' : pairs.trigger === 'cron' ? 'تلقائي مجدول' : pairs.trigger || 'غير محدد'}</span>
          <span className="rounded-full bg-white px-2 py-1 text-[10px]">التخزين: {pairs.provider === 's3' ? 'Cloudflare/R2' : pairs.provider || 'غير محدد'}</span>
          <span className="rounded-full bg-white px-2 py-1 text-[10px]">الجداول: {pairs.tables || '0'}</span>
          <span className="rounded-full bg-white px-2 py-1 text-[10px]">الأخطاء: {pairs.errors || '0'}</span>
          {pairs.bytes && <span className="rounded-full bg-white px-2 py-1 text-[10px]">الحجم: {(Number(pairs.bytes) / 1024).toFixed(1)} KB</span>}
        </div>
      </div>
    )
  }
  if (log.action === 'DB_RESTORE_SUCCESS' || log.action === 'DB_RESTORE_PARTIAL') {
    return (
      <div className="rounded-2xl border border-blue-100 bg-blue-50 p-3 text-xs font-bold leading-6 text-blue-900">
        تم استيراد نسخة احتياطية مشفرة من التخزين الآمن.
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="rounded-full bg-white px-2 py-1 text-[10px]">التخزين: {pairs.provider === 's3' ? 'Cloudflare/R2' : pairs.provider || 'غير محدد'}</span>
          <span className="rounded-full bg-white px-2 py-1 text-[10px]">الجداول: {pairs.tables || '0'}</span>
          <span className="rounded-full bg-white px-2 py-1 text-[10px]">الأخطاء: {pairs.errors || '0'}</span>
        </div>
      </div>
    )
  }
  return null
}

function AuditDetailsDisplay({ log }: { log: AuditRow }) {
  const whatsApp = WhatsAppAuditDisplay({ log })
  if (whatsApp) return whatsApp
  const aiKnowledge = AiKnowledgeAuditDisplay({ log })
  if (aiKnowledge) return aiKnowledge
  const settings = SettingsAuditDisplay({ log })
  if (settings) return settings
  const operational = OperationalAuditDisplay({ log })
  if (operational) return operational
  return <span className="text-xs font-bold text-slate-600">{log.details || log.entity}</span>
}

export function AdminAuditTab() {
  const [logs, setLogs] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ search: '', action: 'ALL', entity: 'ALL' })
  const [auditPage, setAuditPage] = useState(1)
  const [auditPageSize, setAuditPageSize] = useState(50)
  const [auditTotal, setAuditTotal] = useState(0)
  const [actionOptions, setActionOptions] = useState<string[]>([])
  const [entityOptions, setEntityOptions] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!cancelled) setLoading(true)
      const params = new URLSearchParams({ page: String(auditPage), pageSize: String(auditPageSize) })
      if (filters.search.trim()) params.set('search', filters.search.trim())
      if (filters.action !== 'ALL') params.set('action', filters.action)
      if (filters.entity !== 'ALL') params.set('entity', filters.entity)
      api<{ logs: AuditRow[]; total: number; actions: string[]; entities: string[] }>(`/api/admin/audit?${params.toString()}`)
        .then((d) => {
          if (cancelled) return
          setLogs(Array.isArray(d.logs) ? d.logs : [])
          setAuditTotal(Number(d.total || 0))
          setActionOptions(Array.isArray(d.actions) ? d.actions : [])
          setEntityOptions(Array.isArray(d.entities) ? d.entities : [])
        })
        .catch(() => { if (!cancelled) setLogs([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [filters, auditPage, auditPageSize])

  const currentAuditPage = auditPage

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  return (
    <Card className="mt-4 border-[#0f2b46]/10">
      <CardContent className="p-0">
        <div className="border-b border-slate-100 p-4">
          <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
            <ScrollText className="h-4.5 w-4.5 text-[#c9a227]" /> سجل التدقيق الكامل — كل إجراء إداري مسجل بمن قام به ومتى
          </h3>
          <div className="mt-3 grid gap-2 md:grid-cols-4">
            <Input
              value={filters.search}
              onChange={(e) => { setFilters((prev) => ({ ...prev, search: e.target.value })); setAuditPage(1) }}
              placeholder="بحث باسم المنفذ أو تفاصيل العملية"
              className="text-xs font-bold"
            />
            <select
              value={filters.action}
              onChange={(e) => { setFilters((prev) => ({ ...prev, action: e.target.value })); setAuditPage(1) }}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 outline-none focus:border-[#c9a227]"
            >
              <option value="ALL">كل العمليات</option>
              {actionOptions.map((a) => <option key={a} value={a}>{ACTION_L[a] || a}</option>)}
            </select>
            <select
              value={filters.entity}
              onChange={(e) => { setFilters((prev) => ({ ...prev, entity: e.target.value })); setAuditPage(1) }}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 outline-none focus:border-[#c9a227]"
            >
              <option value="ALL">كل الكيانات</option>
              {entityOptions.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
            <select
              value={String(auditPageSize)}
              onChange={(e) => { setAuditPageSize(Number(e.target.value)); setAuditPage(1) }}
              className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold text-slate-600 outline-none focus:border-[#c9a227]"
            >
              <option value="25">عرض 25</option>
              <option value="50">عرض 50</option>
              <option value="100">عرض 100</option>
            </select>
          </div>
          <p className="mt-2 text-[11px] font-bold text-slate-400">المعروض: {logs.length} من {auditTotal} إجراء مطابق</p>
        </div>
        <div className="aact-scroll w-full max-h-[560px] overflow-y-auto">
          {auditTotal === 0 && !filters.search && filters.action === 'ALL' && filters.entity === 'ALL' ? (
            <p className="p-10 text-center text-xs text-slate-400">لا إجراءات مسجلة بعد</p>
          ) : logs.length === 0 ? (
            <p className="p-10 text-center text-xs text-slate-400">لا توجد إجراءات مطابقة للبحث أو الفلاتر الحالية</p>
          ) : (
            <div className="w-full divide-y divide-slate-50">
              {logs.map((l) => (
                <div key={l.id} className="w-full p-3.5">
                  <div className="flex w-full flex-col gap-2 rounded-2xl bg-white px-3 py-2 text-right sm:px-4">
                    <div className="flex w-full flex-wrap items-center justify-between gap-2">
                      <Badge variant="outline" className="text-[10px] font-bold text-[#0f2b46]">{ACTION_L[l.action] || l.action}</Badge>
                      <span className="text-[10px] font-bold text-slate-400">
                        بواسطة: {l.actorName} — {new Date(l.createdAt).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <div className="w-full min-w-0">
                      <AuditDetailsDisplay log={l} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="p-3">
          <AdminPager page={currentAuditPage} pageSize={auditPageSize} total={auditTotal} onPageChange={setAuditPage} label="إجراء" />
        </div>
      </CardContent>
    </Card>
  )
}

// ============ رسائل التواصل ============

interface Msg {
  id: string
  name: string
  email: string
  phone?: string | null
  subject: string
  message: string
  handled: boolean
  createdAt: string
}

export function AdminMessagesTab() {
  const { toast } = useToast()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [loading, setLoading] = useState(true)
  const [msgSearch, setMsgSearch] = useState('')
  const [msgStatusFilter, setMsgStatusFilter] = useState('OPEN')
  const [msgPage, setMsgPage] = useState(1)
  const [msgPageSize, setMsgPageSize] = useState(25)
  const [msgTotal, setMsgTotal] = useState(0)

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      if (!cancelled) setLoading(true)
      const params = new URLSearchParams({ page: String(msgPage), pageSize: String(msgPageSize), status: msgStatusFilter })
      if (msgSearch.trim()) params.set('search', msgSearch.trim())
      api<{ messages: Msg[]; total: number }>(`/api/admin/contact?${params.toString()}`)
        .then((d) => {
          if (cancelled) return
          setMsgs(Array.isArray(d.messages) ? d.messages : [])
          setMsgTotal(Number(d.total || 0))
        })
        .catch(() => { if (!cancelled) setMsgs([]) })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [msgSearch, msgStatusFilter, msgPage, msgPageSize])

  const mark = async (id: string, handled: boolean) => {
    await api('/api/admin/contact', { method: 'PATCH', body: JSON.stringify({ id, handled }) }).catch(() => {})
    setMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, handled } : m)).filter((m) => {
      if (msgStatusFilter === 'OPEN') return !m.handled
      if (msgStatusFilter === 'HANDLED') return m.handled
      return true
    }))
    if ((msgStatusFilter === 'OPEN' && handled) || (msgStatusFilter === 'HANDLED' && !handled)) {
      setMsgTotal((prev) => Math.max(0, prev - 1))
    }
    toast({ title: handled ? 'أُعلّمت كمعالجة' : 'أُعيد فتحها' })
  }

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  const currentMsgPage = msgPage

  return (
    <div className="mt-4 space-y-3">
      <AdminListToolbar
        search={msgSearch}
        onSearchChange={(v) => { setMsgSearch(v); setMsgPage(1) }}
        searchPlaceholder="ابحث باسم المرسل أو البريد أو الموضوع أو نص الرسالة..."
        status={msgStatusFilter}
        onStatusChange={(v) => { setMsgStatusFilter(v); setMsgPage(1) }}
        statusOptions={[
          { value: 'OPEN', label: 'الجديدة/المفتوحة' },
          { value: 'HANDLED', label: 'المعالجة' },
          { value: 'ALL', label: 'كل الرسائل' },
        ]}
        pageSize={msgPageSize}
        onPageSizeChange={(v) => { setMsgPageSize(v); setMsgPage(1) }}
        total={msgTotal}
        filtered={msgTotal}
        label="رسالة"
      />
      {msgTotal === 0 && !msgSearch && msgStatusFilter === 'ALL' ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا رسائل تواصل بعد</CardContent></Card>
      ) : msgs.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد رسائل مطابقة للبحث أو الفلتر الحالي.</CardContent></Card>
      ) : (
        msgs.map((m) => (
          <Card key={m.id} className={`border ${m.handled ? 'border-slate-100 opacity-60' : 'border-[#c9a227]/40 bg-[#f7edd0]/30'}`}>
            <CardContent className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Mail className="h-4 w-4 text-[#c9a227]" />
                    <h4 className="text-sm font-black text-[#0f2b46]">{m.subject}</h4>
                    {m.handled ? (
                      <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><CheckCircle2 className="ml-1 h-3 w-3" /> معالجة</Badge>
                    ) : (
                      <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">جديدة</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] font-bold text-slate-500" dir="ltr">{m.name} · {m.email} {m.phone ? `· ${m.phone}` : ''}</p>
                  <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{m.message}</p>
                  <p className="mt-1.5 text-[10px] text-slate-300">{new Date(m.createdAt).toLocaleString('ar-EG')}</p>
                </div>
                <Button size="sm" variant="outline"
                  onClick={() => mark(m.id, !m.handled)}
                  className={m.handled ? 'border-slate-200 font-bold text-slate-500' : 'border-emerald-200 font-bold text-emerald-600'}>
                  {m.handled ? <><XCircle className="ml-1 h-3.5 w-3.5" /> إعادة فتح</> : <><CheckCircle2 className="ml-1 h-3.5 w-3.5" /> تمت المعالجة</>}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}
      <AdminPager page={currentMsgPage} pageSize={msgPageSize} total={msgTotal} onPageChange={setMsgPage} label="رسالة" />
      {/* REAL_ADMIN_EXTRAS_END */}
    </div>
  )
}
