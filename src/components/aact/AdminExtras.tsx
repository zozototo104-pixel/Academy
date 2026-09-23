'use client'

import { useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { api, getToken } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { CertificateDialog, CertificateData } from '@/components/aact/CertificateDialog'
import { AdminAITab } from '@/components/aact/AdminAITab'
import { AdminListToolbar, AdminPager, matchesAdminSearch, pageItems, safePage } from '@/components/aact/AdminListTools'
import {
  Loader2, Gavel, CalendarClock, CheckCircle2, XCircle, Banknote, TrendingUp, Globe2,
  Award, Settings2, ScrollText, Mail, FileDown, Plus, Users2, ReceiptText, Bot,
  FileSignature, Video, RefreshCw, ShieldCheck, Trash2, KeyRound,
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
    const reviewNote = window.prompt(
      action === 'APPROVE_PLAN'
        ? 'اكتب ملاحظة اختيارية تظهر للطالب مع اعتماد الخطة:'
        : action === 'REQUEST_FINAL_REVISION'
          ? 'اكتب ملاحظة تعديل البحث النهائي التي ستظهر للطالب:'
          : 'اكتب ملاحظة التعديل التي ستظهر للطالب:',
      thesis.reviewNote || ''
    )
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
    const reviewNote = window.prompt('اكتب ملاحظة اختيارية على نتيجة المناقشة تظهر في سجل الطالب:', resulting.reviewNote || '')
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
  receiptNo?: string | null
  payerName?: string | null
  payerCountry?: string | null
  createdAt: string
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
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [totals, setTotals] = useState({ collected: 0, pending: 0, count: 0, paidCount: 0 })
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [paymentSearch, setPaymentSearch] = useState('')
  const [paymentStatusFilter, setPaymentStatusFilter] = useState('ALL')
  const [paymentPage, setPaymentPage] = useState(1)
  const [paymentPageSize, setPaymentPageSize] = useState(25)
  const [pdfBusy, setPdfBusy] = useState<string | null>(null)

  const load = () => {
    Promise.all([
      api<{ payments: PaymentRow[]; totals: any }>('/api/admin/payments'),
      api<Report>('/api/admin/reports'),
    ])
      .then(([p, r]) => {
        setPayments(p.payments)
        setTotals(p.totals)
        setReport(r)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const confirm = async (id: string) => {
    try {
      await api('/api/admin/payments', { method: 'PATCH', body: JSON.stringify({ id }) })
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

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  const filteredPayments = payments.filter((p) => {
    const statusOk = paymentStatusFilter === 'ALL' || p.status === paymentStatusFilter || p.purpose === paymentStatusFilter
    return statusOk && matchesAdminSearch(paymentSearch, [p.invoiceNo, p.description, p.purpose, p.status, p.method, p.receiptNo, p.payerName, p.payerCountry, p.admission?.reference, p.admission?.fullName, p.admission?.program])
  })
  const pagedPayments = pageItems(filteredPayments, paymentPage, paymentPageSize)
  const currentPaymentPage = safePage(filteredPayments.length, paymentPageSize, paymentPage)

  const PURPOSE_L: Record<string, string> = {
    APPLICATION_FEE: 'رسوم تقديم', TUITION: 'رسوم دراسية', ACCREDITATION_APP: 'تقديم اعتماد', ACCREDITATION_FEE: 'رسوم تقديم اعتماد', ACCREDITATION: 'اعتماد', SERVICE_FEE: 'رسوم خدمة', OTHER: 'أخرى',
  }

  return (
    <div className="mt-4 space-y-5">
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
            { value: 'APPLICATION_FEE', label: 'رسوم تقديم' },
            { value: 'TUITION', label: 'رسوم دراسية' },
            { value: 'TUITION_INSTALLMENT', label: 'دفعات تقسيط' },
            { value: 'SERVICE_FEE', label: 'رسوم خدمات' },
          ]}
          pageSize={paymentPageSize}
          onPageSizeChange={(v) => { setPaymentPageSize(v); setPaymentPage(1) }}
          total={payments.length}
          filtered={filteredPayments.length}
          label="فاتورة"
        />
      <Card className="border-[#0f2b46]/10">
        <CardContent className="p-0">
          <h3 className="border-b border-slate-100 p-4 text-sm font-black text-[#0f2b46]">كل الفواتير والإيصالات</h3>
          <div className="aact-scroll max-h-96 overflow-y-auto">
            {payments.length === 0 ? (
              <p className="p-8 text-center text-xs text-slate-400">لا توجد فواتير بعد</p>
            ) : filteredPayments.length === 0 ? (
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
                    <th className="p-3 font-black">تأكيد يدوي</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedPayments.map((p) => (
                    <tr key={p.id} className="border-t border-slate-100">
                      <td className="p-3">
                        <div className="font-mono text-[10px] font-bold text-[#0f2b46]" dir="ltr">{p.invoiceNo}</div>
                        <div className="text-[10px] text-slate-400">{p.payerName || p.admission?.fullName || '—'}</div>
                      </td>
                      <td className="max-w-48 p-3">
                        <div className="truncate font-bold text-slate-600">{p.description}</div>
                        <div className="text-[10px] text-slate-400">{PURPOSE_L[p.purpose] || p.purpose}{p.admission ? ` — ${p.admission.reference}` : ''}</div>
                        {(p.method === 'USDT' || p.provider === 'USDT') && (
                          <div className="mt-1 space-y-0.5 rounded-lg bg-slate-50 p-2 text-[10px] font-bold text-slate-500">
                            <div>USDT: {p.cryptoNetwork || '—'} · {p.cryptoVerificationStatus || 'WAITING_TX'}</div>
                            {p.cryptoTxHash && <div className="font-mono" dir="ltr">Tx: {p.cryptoTxHash.slice(0, 12)}…{p.cryptoTxHash.slice(-8)}</div>}
                            {p.cryptoVerificationNote && <div className="line-clamp-2 text-slate-400">{p.cryptoVerificationNote}</div>}
                          </div>
                        )}
                      </td>
                      <td className="p-3 font-black text-[#0f2b46]">{p.amount}$</td>
                      <td className="p-3">
                        {p.status === 'PAID' ? (
                          <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">مسددة {p.receiptNo ? `(${p.receiptNo})` : ''}</Badge>
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
                        {p.status === 'UNPAID' ? (
                          <Button size="sm" variant="outline" onClick={() => confirm(p.id)}
                            className="border-emerald-200 font-bold text-emerald-600">
                            <Banknote className="ml-1 h-3 w-3" /> تأكيد
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
      <AdminPager page={currentPaymentPage} pageSize={paymentPageSize} total={filteredPayments.length} onPageChange={setPaymentPage} label="فاتورة" />
      </div>
    </div>
  )
}

// ============ إدارة الشهادات ============

export function AdminCertificatesTab() {
  const { toast } = useToast()
  const [certs, setCerts] = useState<CertificateData[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<CertificateData | null>(null)
  const [open, setOpen] = useState(false)
  const [issueOpen, setIssueOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ holderName: '', program: '', grade: '', country: '' })
  const [certSearch, setCertSearch] = useState('')
  const [certPage, setCertPage] = useState(1)
  const [certPageSize, setCertPageSize] = useState(25)

  const load = () => {
    api<{ certificates: CertificateData[] }>('/api/admin/certificates')
      .then((d) => setCerts(d.certificates))
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const issue = async () => {
    setBusy(true)
    try {
      await api('/api/admin/certificates', { method: 'POST', body: JSON.stringify(form) })
      toast({ title: 'تم الإصدار', description: `أُصدرت الشهادة برقم متسلسل وQR — ظاهرة الآن في صفحة التحقق` })
      setIssueOpen(false)
      setForm({ holderName: '', program: '', grade: '', country: '' })
      load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  const filteredCerts = certs.filter((c: any) => matchesAdminSearch(certSearch, [c.serial, c.holderName, c.program, c.grade, c.country, c.certificateId, c.verificationUrl]))
  const pagedCerts = pageItems(filteredCerts, certPage, certPageSize)
  const currentCertPage = safePage(filteredCerts.length, certPageSize, certPage)

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold text-slate-500">كل الشهادات الصادرة — كل شهادة برقم تسلسلي فريد وQR للتحقق العام</p>
        <Button onClick={() => setIssueOpen(true)} className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
          <Plus className="ml-1 h-4 w-4" /> إصدار شهادة يدوياً
        </Button>
      </div>
      <AdminListToolbar
        search={certSearch}
        onSearchChange={(v) => { setCertSearch(v); setCertPage(1) }}
        searchPlaceholder="ابحث بالاسم أو الرقم التسلسلي أو البرنامج..."
        pageSize={certPageSize}
        onPageSizeChange={(v) => { setCertPageSize(v); setCertPage(1) }}
        total={certs.length}
        filtered={filteredCerts.length}
        label="شهادة"
      />
      {certs.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد شهادات بعد — تُصدر تلقائياً عند إكمال برنامج أو اعتماد طلب اعتماد</CardContent></Card>
      ) : filteredCerts.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد شهادات مطابقة للبحث الحالي.</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {pagedCerts.map((c) => (
            <Card key={c.serial} className="border-[#c9a227]/30 bg-white">
              <CardContent className="p-4">
                <div className="flex items-start justify-between">
                  <Award className="h-5 w-5 text-[#a8841a]" />
                  <span className="font-mono text-[10px] text-slate-400" dir="ltr">{c.serial}</span>
                </div>
                <h4 className="mt-2 text-xs font-black text-[#0f2b46]">{c.holderName}</h4>
                <p className="mt-0.5 line-clamp-1 text-[11px] font-bold text-slate-500">{c.program}</p>
                <Button size="sm" variant="outline" className="mt-3 w-full border-[#c9a227] font-bold text-[#a8841a]"
                  onClick={() => { setSelected(c); setOpen(true) }}>
                  <FileDown className="ml-1 h-3.5 w-3.5" /> عرض / طباعة
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <AdminPager page={currentCertPage} pageSize={certPageSize} total={filteredCerts.length} onPageChange={setCertPage} label="شهادة" />

      <CertificateDialog certificate={selected} open={open} onClose={() => setOpen(false)} />

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

export function AdminSettingsTab() {
  const { toast } = useToast()
  const [values, setValues] = useState<Record<string, string>>({})
  const [defs, setDefs] = useState<{ key: string; label: string; group: string; suffix: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
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
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ values }) })
      toast({ title: 'حُفظت الرسوم', description: 'تُطبق القيم الجديدة فوراً على كامل المنصة — سُجل الإجراء في سجل التدقيق' })
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

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  const groups: { key: string; label: string }[] = [
    { key: 'FEES', label: 'جدول الرسوم (دولار أمريكي)' },
    { key: 'RULES', label: 'المهل الزمنية والنسب وفق دليل الإجراءات وعقد التمثيل' },
  ]

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
            <h3 className="mb-4 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
              <Settings2 className="h-4.5 w-4.5 text-[#c9a227]" /> {g.label}
            </h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {defs.filter((d) => d.group === g.key).map((d) => (
                <div key={d.key} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                  <Label htmlFor={d.key} className="text-[11px] font-bold leading-snug text-slate-600">{d.label}</Label>
                  <div className="relative mt-2">
                    <Input
                      id={d.key}
                      dir="ltr"
                      type="number"
                      className="pl-9 text-left font-black"
                      value={values[d.key] || ''}
                      onChange={(e) => setValues({ ...values, [d.key]: e.target.value })}
                    />
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-black text-[#a8841a]">{d.suffix}</span>
                  </div>
                </div>
              ))}
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
}

export function AdminAuditTab() {
  const [logs, setLogs] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [filters, setFilters] = useState({ search: '', action: 'ALL', entity: 'ALL' })
  const [auditPage, setAuditPage] = useState(1)
  const [auditPageSize, setAuditPageSize] = useState(50)

  useEffect(() => {
    api<{ logs: AuditRow[] }>('/api/admin/audit')
      .then((d) => setLogs(d.logs))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const actionOptions = useMemo(() => Array.from(new Set(logs.map((l) => l.action))).sort(), [logs])
  const entityOptions = useMemo(() => Array.from(new Set(logs.map((l) => l.entity))).sort(), [logs])
  const filteredLogs = useMemo(() => {
    const q = filters.search.trim().toLowerCase()
    return logs.filter((l) => {
      const actionOk = filters.action === 'ALL' || l.action === filters.action
      const entityOk = filters.entity === 'ALL' || l.entity === filters.entity
      const searchOk = !q || `${l.actorName} ${l.details || ''} ${l.entity} ${l.action}`.toLowerCase().includes(q)
      return actionOk && entityOk && searchOk
    })
  }, [logs, filters])
  const pagedLogs = pageItems(filteredLogs, auditPage, auditPageSize)
  const currentAuditPage = safePage(filteredLogs.length, auditPageSize, auditPage)

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
          <p className="mt-2 text-[11px] font-bold text-slate-400">المعروض: {filteredLogs.length} من {logs.length} إجراء</p>
        </div>
        <div className="aact-scroll max-h-[560px] overflow-y-auto">
          {logs.length === 0 ? (
            <p className="p-10 text-center text-xs text-slate-400">لا إجراءات مسجلة بعد</p>
          ) : filteredLogs.length === 0 ? (
            <p className="p-10 text-center text-xs text-slate-400">لا توجد إجراءات مطابقة للبحث أو الفلاتر الحالية</p>
          ) : (
            pagedLogs.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-50 p-3.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[10px] font-bold text-[#0f2b46]">{ACTION_L[l.action] || l.action}</Badge>
                    <span className="text-xs font-bold text-slate-600">{l.details || l.entity}</span>
                  </div>
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    بواسطة: {l.actorName} — {new Date(l.createdAt).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
        <div className="p-3">
          <AdminPager page={currentAuditPage} pageSize={auditPageSize} total={filteredLogs.length} onPageChange={setAuditPage} label="إجراء" />
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

  const load = () => {
    api<{ messages: Msg[] }>('/api/admin/contact')
      .then((d) => setMsgs(d.messages))
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const mark = async (id: string, handled: boolean) => {
    await api('/api/admin/contact', { method: 'PATCH', body: JSON.stringify({ id, handled }) }).catch(() => {})
    setMsgs((prev) => prev.map((m) => (m.id === id ? { ...m, handled } : m)))
    toast({ title: handled ? 'أُعلّمت كمعالجة' : 'أُعيد فتحها' })
  }

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  const filteredMsgs = msgs.filter((m) => {
    const statusOk = msgStatusFilter === 'ALL' || (msgStatusFilter === 'OPEN' && !m.handled) || (msgStatusFilter === 'HANDLED' && m.handled)
    return statusOk && matchesAdminSearch(msgSearch, [m.name, m.email, m.phone, m.subject, m.message])
  })
  const pagedMsgs = pageItems(filteredMsgs, msgPage, msgPageSize)
  const currentMsgPage = safePage(filteredMsgs.length, msgPageSize, msgPage)

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
        total={msgs.length}
        filtered={filteredMsgs.length}
        label="رسالة"
      />
      {msgs.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا رسائل تواصل بعد</CardContent></Card>
      ) : filteredMsgs.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد رسائل مطابقة للبحث أو الفلتر الحالي.</CardContent></Card>
      ) : (
        pagedMsgs.map((m) => (
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
      <AdminPager page={currentMsgPage} pageSize={msgPageSize} total={filteredMsgs.length} onPageChange={setMsgPage} label="رسالة" />
    </div>
  )
}
