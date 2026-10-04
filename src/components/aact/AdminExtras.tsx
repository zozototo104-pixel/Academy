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
import { Textarea } from '@/components/ui/textarea'
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
      const value = window.prompt('اكتب رقم الحوالة أو ملاحظة الاعتماد قبل تأكيد السداد:', payment.manualApprovalReference || payment.manualApprovalNote || '')
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

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

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
