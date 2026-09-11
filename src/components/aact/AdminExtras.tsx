'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { api } from '@/lib/store'
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
import {
  Loader2, Gavel, CalendarClock, CheckCircle2, XCircle, Banknote, TrendingUp, Globe2,
  Award, Settings2, ScrollText, Mail, FileDown, Plus, Users2, ReceiptText, Bot,
  FileSignature, Video, RefreshCw,
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

interface Thesis {
  id: string
  title: string
  abstract: string
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

  const recordResult = async () => {
    if (!resulting) return
    setBusy(true)
    try {
      await api('/api/admin/thesis', {
        method: 'PATCH',
        body: JSON.stringify({ id: resulting.id, action: 'RESULT', resultScore: parseFloat(score), passed: passed === 'true' }),
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
    SUBMITTED: { label: 'مسلَّم — بانتظار الجدولة', cls: 'bg-amber-100 text-amber-700' },
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
      ) : (
        theses.map((t) => {
          const committee = parseCommitteeNames(t.committee)
          const studentName = safeText(t.user?.name, 'طالب غير محدد')
          const programName = safeText(t.admission?.program, 'برنامج غير محدد')
          const abstractText = safeText(t.abstract, 'لا يوجد ملخص محفوظ لهذا البحث')
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
                    {['SUBMITTED', 'NEEDS_REVISION'].includes(t.status) && (
                      <Button size="sm" onClick={() => { setSched(t); setDate(''); setMembers(''); setAgentMember('') }}
                        className="w-full justify-center bg-[#0f2b46] font-bold text-[#f5f0e1] hover:bg-[#12365c]">
                        <Gavel className="ml-1 h-3.5 w-3.5" /> جدولة المناقشة
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
        })
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

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  const PURPOSE_L: Record<string, string> = {
    APPLICATION_FEE: 'رسوم تقديم', TUITION: 'رسوم دراسية', ACCREDITATION_APP: 'تقديم اعتماد', ACCREDITATION_FEE: 'رسوم تقديم اعتماد', ACCREDITATION: 'اعتماد', OTHER: 'أخرى',
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
      <Card className="border-[#0f2b46]/10">
        <CardContent className="p-0">
          <h3 className="border-b border-slate-100 p-4 text-sm font-black text-[#0f2b46]">كل الفواتير والإيصالات</h3>
          <div className="aact-scroll max-h-96 overflow-y-auto">
            {payments.length === 0 ? (
              <p className="p-8 text-center text-xs text-slate-400">لا توجد فواتير بعد</p>
            ) : (
              <table className="w-full text-right text-xs">
                <thead className="sticky top-0 bg-[#f7edd0] text-[#0f2b46]">
                  <tr>
                    <th className="p-3 font-black">الفاتورة</th>
                    <th className="p-3 font-black">الوصف</th>
                    <th className="p-3 font-black">المبلغ</th>
                    <th className="p-3 font-black">الحالة</th>
                    <th className="p-3 font-black">تأكيد يدوي</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id} className="border-t border-slate-100">
                      <td className="p-3">
                        <div className="font-mono text-[10px] font-bold text-[#0f2b46]" dir="ltr">{p.invoiceNo}</div>
                        <div className="text-[10px] text-slate-400">{p.payerName || p.admission?.fullName || '—'}</div>
                      </td>
                      <td className="max-w-48 p-3">
                        <div className="truncate font-bold text-slate-600">{p.description}</div>
                        <div className="text-[10px] text-slate-400">{PURPOSE_L[p.purpose] || p.purpose}{p.admission ? ` — ${p.admission.reference}` : ''}</div>
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

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold text-slate-500">كل الشهادات الصادرة — كل شهادة برقم تسلسلي فريد وQR للتحقق العام</p>
        <Button onClick={() => setIssueOpen(true)} className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
          <Plus className="ml-1 h-4 w-4" /> إصدار شهادة يدوياً
        </Button>
      </div>
      {certs.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد شهادات بعد — تُصدر تلقائياً عند إكمال برنامج أو اعتماد طلب اعتماد</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {certs.map((c) => (
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

// ============ إدارة الرسوم (بدون كود) ============

export function AdminSettingsTab() {
  const { toast } = useToast()
  const [values, setValues] = useState<Record<string, string>>({})
  const [defs, setDefs] = useState<{ key: string; label: string; group: string; suffix: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
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

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  const groups: { key: string; label: string }[] = [
    { key: 'FEES', label: 'جدول الرسوم (دولار أمريكي)' },
    { key: 'RULES', label: 'المهل الزمنية والنسب وفق دليل الإجراءات وعقد التمثيل' },
  ]

  return (
    <div className="mt-4 space-y-5">
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
  ADD_REVENUE_SHARE: 'تسجيل مستحق وكيل', MARK_SHARE_PAID: 'تأكيد تحويل مستحقات',
  RESOLVE_MESSAGE: 'معالجة رسالة',
}

export function AdminAuditTab() {
  const [logs, setLogs] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<{ logs: AuditRow[] }>('/api/admin/audit')
      .then((d) => setLogs(d.logs))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  return (
    <Card className="mt-4 border-[#0f2b46]/10">
      <CardContent className="p-0">
        <h3 className="flex items-center gap-2 border-b border-slate-100 p-4 text-sm font-black text-[#0f2b46]">
          <ScrollText className="h-4.5 w-4.5 text-[#c9a227]" /> سجل التدقيق الكامل — كل إجراء إداري مسجل بمن قام به ومتى
        </h3>
        <div className="aact-scroll max-h-[560px] overflow-y-auto">
          {logs.length === 0 ? (
            <p className="p-10 text-center text-xs text-slate-400">لا إجراءات مسجلة بعد</p>
          ) : (
            logs.map((l) => (
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

  return (
    <div className="mt-4 space-y-3">
      {msgs.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا رسائل تواصل بعد</CardContent></Card>
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
    </div>
  )
}
