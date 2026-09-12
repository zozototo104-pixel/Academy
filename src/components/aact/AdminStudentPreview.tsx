'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, useAppStore } from '@/lib/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  AlertTriangle,
  ArrowRight,
  Award,
  Banknote,
  BookOpen,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  FileSignature,
  GraduationCap,
  Loader2,
  MessageSquareText,
  ShieldCheck,
  UserRound,
} from 'lucide-react'

interface PreviewData {
  previewMode: string
  note: string
  student: {
    id: string
    name: string
    email: string
    phone?: string | null
    country?: string | null
    role: string
    createdAt: string
    academicMemory?: {
      profileDigest?: string | null
      strengths: string[]
      weaknesses: string[]
      conceptsToReview: string[]
      recommendedNextActions: string[]
      lastConversationSummary?: string | null
      lastFileAnalysis?: string | null
      lastInteractionAt?: string | null
      lastExamAt?: string | null
      lastDefenseAt?: string | null
      interactionsCount: number
    } | null
  }
  overview: {
    admissions: number
    enrollments: number
    activeEnrollments: number
    completedEnrollments: number
    programExamAttempts: number
    unitExamAttempts: number
    assignments: number
    theses: number
    certificates: number
    microCredentials: number
    averageScore: number | null
    paidTotal: number
    unpaidTotal: number
    aiInteractions: number
    atRiskSignals: string[]
  }
  admissions: any[]
  enrollments: any[]
  programAttempts: any[]
  unitAttempts: any[]
  assignments: any[]
  theses: any[]
  payments: any[]
  certificates: any[]
  microCredentials: any[]
  recentChats: any[]
}

const STATUS_AR: Record<string, string> = {
  AWAITING_FEE: 'بانتظار رسوم التقديم',
  UNDER_REVIEW: 'قيد الدراسة',
  AWAITING_TUITION: 'مقبول — بانتظار الرسوم',
  SUPERVISOR_ASSIGNED: 'تم تعيين مشرف',
  THESIS: 'قيد بحث التخرج',
  SCHEDULED: 'مجدول للمناقشة',
  RESULT_APPROVED: 'تم اعتماد النتيجة',
  CERTIFIED: 'تم إصدار الشهادة',
  REJECTED: 'مرفوض',
  ACTIVE: 'نشط',
  COMPLETED: 'مكتمل',
  PAID: 'مدفوع',
  UNPAID: 'غير مدفوع',
  SUBMITTED: 'مسلّم',
  GRADED: 'مصَحّح',
  NEEDS_REVISION: 'يحتاج مراجعة',
}

function arStatus(value?: string | null) {
  return STATUS_AR[value || ''] || value || '—'
}

function dateAr(value?: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('ar-EG')
}

function score(value: unknown) {
  return typeof value === 'number' ? `${Math.round(value)}%` : '—'
}

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: React.ReactNode }) {
  return (
    <Card className="border-[#0f2b46]/10">
      <CardContent className="p-4 sm:p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
          <Icon className="h-4 w-4 text-[#a8841a]" /> {title}
        </h3>
        {children}
      </CardContent>
    </Card>
  )
}

export function AdminStudentPreview() {
  const { studentPreviewId, navigate } = useAppStore()
  const [data, setData] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const id = useMemo(() => {
    if (studentPreviewId) return studentPreviewId
    if (typeof window === 'undefined') return ''
    return new URLSearchParams(window.location.search).get('studentId') || ''
  }, [studentPreviewId])

  const load = () => {
    if (!id) {
      setLoading(false)
      setError('لم يتم تحديد الطالب')
      return
    }
    setLoading(true)
    setError(null)
    api<PreviewData>(`/api/admin/students/preview?studentId=${encodeURIComponent(id)}`)
      .then(setData)
      .catch((e: any) => setError(e?.message || 'تعذر تحميل معاينة الطالب'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [id])

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <Card className="border-[#0f2b46]/10">
          <CardContent className="flex h-56 flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="h-9 w-9 animate-spin text-[#c9a227]" />
            <p className="text-sm font-black text-[#0f2b46]">جاري تحميل معاينة الطالب...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Card className="border-red-100 bg-red-50">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="mx-auto mb-3 h-9 w-9 text-red-500" />
            <h1 className="text-lg font-black text-red-700">تعذر فتح معاينة الطالب</h1>
            <p className="mt-2 text-sm font-bold text-red-600">{error || 'بيانات غير متاحة'}</p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button onClick={load} className="bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#12365c]">إعادة المحاولة</Button>
              <Button variant="outline" onClick={() => navigate('admin')}>العودة للوحة الإدارة</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const s = data.student
  const memory = s.academicMemory
  const metrics = [
    { label: 'طلبات الالتحاق', value: data.overview.admissions, icon: ClipboardCheck },
    { label: 'برامج نشطة', value: data.overview.activeEnrollments, icon: GraduationCap },
    { label: 'متوسط الدرجات', value: data.overview.averageScore == null ? '—' : `${data.overview.averageScore}%`, icon: CheckCircle2 },
    { label: 'أبحاث التخرج', value: data.overview.theses, icon: FileSignature },
    { label: 'شهادات', value: data.overview.certificates, icon: Award },
    { label: 'تفاعلات المشرف', value: data.overview.aiInteractions, icon: Bot },
  ]

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:py-8">
      <div className="flex flex-col gap-3 rounded-3xl bg-[#0f2b46] p-5 text-[#f5f0e1] shadow-lg sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Badge className="mb-3 bg-[#c9a227] text-[#0f2b46] hover:bg-[#c9a227]">معاينة إدارية — قراءة فقط</Badge>
          <h1 className="flex items-center gap-2 text-2xl font-black sm:text-3xl">
            <UserRound className="h-6 w-6 text-[#c9a227]" /> {s.name}
          </h1>
          <p className="mt-2 text-sm font-bold text-[#f5f0e1]/75" dir="ltr">{s.email}</p>
          <p className="mt-1 text-xs font-bold text-[#f5f0e1]/60">{s.country || 'الدولة غير محددة'} — حسابه منذ {dateAr(s.createdAt)}</p>
        </div>
        <div className="grid gap-2 sm:w-52">
          <Button onClick={() => navigate('admin')} variant="outline" className="border-[#c9a227]/50 bg-white/5 text-[#f5f0e1] hover:bg-white/10">
            <ArrowRight className="ml-1 h-4 w-4" /> العودة للإدارة
          </Button>
          <Button onClick={load} className="bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]">تحديث المعاينة</Button>
        </div>
      </div>

      <Card className="border-[#c9a227]/30 bg-[#fff8e6]">
        <CardContent className="flex flex-col gap-2 p-4 text-xs font-bold leading-6 text-[#5c4d1a] sm:flex-row sm:items-center">
          <ShieldCheck className="h-5 w-5 shrink-0 text-[#a8841a]" />
          {data.note}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {metrics.map((m) => (
          <Card key={m.label} className="border-[#0f2b46]/10">
            <CardContent className="p-4 text-center">
              <m.icon className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" />
              <div className="text-xl font-black text-[#0f2b46]">{m.value}</div>
              <div className="mt-1 text-[10px] font-bold text-slate-500">{m.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {data.overview.atRiskSignals.length > 0 && (
        <Section title="إشارات متابعة عاجلة" icon={AlertTriangle}>
          <div className="grid gap-2 md:grid-cols-2">
            {data.overview.atRiskSignals.map((x, i) => (
              <p key={i} className="rounded-xl bg-red-50 p-3 text-xs font-bold leading-6 text-red-700">• {x}</p>
            ))}
          </div>
        </Section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="طلبات الالتحاق" icon={ClipboardCheck}>
          {data.admissions.length === 0 ? <p className="text-sm text-slate-400">لا توجد طلبات التحاق مرتبطة.</p> : (
            <div className="space-y-2">
              {data.admissions.map((a) => (
                <div key={a.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-black text-[#0f2b46]">{a.reference}</p>
                    <Badge variant="outline">{arStatus(a.status)}</Badge>
                  </div>
                  <p className="mt-1 font-bold text-slate-600">{a.program}</p>
                  <p className="mt-1 text-slate-500">المشرف: {a.supervisor?.name || 'لم يعين بعد'} — الملفات: {a.files?.length || 0}</p>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="البرامج والتسجيلات" icon={BookOpen}>
          {data.enrollments.length === 0 ? <p className="text-sm text-slate-400">لا توجد تسجيلات مفعّلة.</p> : (
            <div className="space-y-2">
              {data.enrollments.map((e) => (
                <div key={e.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-black text-[#0f2b46]">{e.program.titleAr}</p>
                    <Badge className={e.status === 'COMPLETED' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-blue-100 text-blue-700 hover:bg-blue-100'}>{arStatus(e.status)}</Badge>
                  </div>
                  <p className="mt-1 text-slate-500">وحدات مكتملة: {e.completedUnitsCount}/{e.program._count.units} — كتب {e.program._count.books} — امتحانات {e.program._count.programExams}</p>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="الامتحانات" icon={CheckCircle2}>
          {[...data.programAttempts, ...data.unitAttempts].length === 0 ? <p className="text-sm text-slate-400">لا توجد محاولات امتحان بعد.</p> : (
            <div className="space-y-2">
              {data.programAttempts.slice(0, 8).map((a) => (
                <div key={a.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                  <p className="font-black text-[#0f2b46]">{a.exam.title}</p>
                  <p className="mt-1 text-slate-500">{a.exam.program.titleAr} — النتيجة {score(a.finalScore ?? a.score)} — {a.passed === true ? 'ناجح' : a.passed === false ? 'راسب' : arStatus(a.status)}</p>
                </div>
              ))}
              {data.unitAttempts.slice(0, 5).map((a) => (
                <div key={a.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                  <p className="font-black text-[#0f2b46]">{a.exam.title}</p>
                  <p className="mt-1 text-slate-500">{a.exam.unit.program.titleAr} — النتيجة {score(a.score)}</p>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="الدفعات والفواتير" icon={Banknote}>
          <div className="mb-3 grid gap-2 sm:grid-cols-2">
            <p className="rounded-xl bg-emerald-50 p-3 text-xs font-black text-emerald-700">مدفوع: ${data.overview.paidTotal}</p>
            <p className="rounded-xl bg-amber-50 p-3 text-xs font-black text-amber-700">غير مدفوع: ${data.overview.unpaidTotal}</p>
          </div>
          {data.payments.length === 0 ? <p className="text-sm text-slate-400">لا توجد فواتير.</p> : (
            <div className="space-y-2">
              {data.payments.slice(0, 8).map((p) => (
                <div key={p.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-black text-[#0f2b46]" dir="ltr">{p.invoiceNo}</p>
                    <Badge className={p.status === 'PAID' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>{arStatus(p.status)}</Badge>
                  </div>
                  <p className="mt-1 text-slate-500">{p.description} — ${p.amount}</p>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="بحث التخرج والمناقشة" icon={FileSignature}>
          {data.theses.length === 0 ? <p className="text-sm text-slate-400">لا يوجد بحث تخرج مسلّم.</p> : (
            <div className="space-y-2">
              {data.theses.map((t) => (
                <div key={t.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-black text-[#0f2b46]">{t.title}</p>
                    <Badge variant="outline">{arStatus(t.status)}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-slate-500">{t.abstract}</p>
                  <p className="mt-1 text-slate-500">تقييم AI: {score(t.aiScore)} — نتيجة اللجنة: {score(t.resultScore)} — رسائل المناقشة: {t._count?.defenseMessages || 0}</p>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="ذاكرة المشرف الذكي" icon={Bot}>
          {!memory ? <p className="text-sm text-slate-400">لا توجد ذاكرة أكاديمية محفوظة بعد.</p> : (
            <div className="space-y-3 text-xs leading-6 text-slate-600">
              {memory.profileDigest && <p className="rounded-xl bg-slate-50 p-3 font-bold">{memory.profileDigest}</p>}
              {memory.weaknesses.length > 0 && <p><b className="text-[#0f2b46]">نقاط ضعف:</b> {memory.weaknesses.join('، ')}</p>}
              {memory.conceptsToReview.length > 0 && <p><b className="text-[#0f2b46]">مفاهيم للمراجعة:</b> {memory.conceptsToReview.join('، ')}</p>}
              {memory.recommendedNextActions.length > 0 && <p><b className="text-[#0f2b46]">إجراءات مقترحة:</b> {memory.recommendedNextActions.join('، ')}</p>}
              {memory.lastConversationSummary && <p><b className="text-[#0f2b46]">آخر محادثة:</b> {memory.lastConversationSummary}</p>}
              {memory.lastFileAnalysis && <p><b className="text-[#0f2b46]">آخر تحليل ملف:</b> {memory.lastFileAnalysis}</p>}
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="الشهادات والمهارات الصغيرة" icon={Award}>
          <div className="space-y-2">
            {data.certificates.map((c) => (
              <div key={c.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                <p className="font-black text-[#0f2b46]">{c.program}</p>
                <p className="mt-1 text-slate-500">{c.serial} — {c.valid ? 'صالحة' : 'غير صالحة'} — {dateAr(c.issuedAt)}</p>
              </div>
            ))}
            {data.microCredentials.map((m) => (
              <div key={m.id} className="rounded-xl bg-[#fff8e6] p-3 text-xs">
                <p className="font-black text-[#0f2b46]">{m.microCredential.titleAr}</p>
                <p className="mt-1 text-slate-500">{m.microCredential.badgeCode} — {m.microCredential.program.titleAr}</p>
              </div>
            ))}
            {data.certificates.length === 0 && data.microCredentials.length === 0 && <p className="text-sm text-slate-400">لا توجد شهادات أو مهارات صغيرة.</p>}
          </div>
        </Section>

        <Section title="آخر محادثات المشرف الذكي" icon={MessageSquareText}>
          {data.recentChats.length === 0 ? <p className="text-sm text-slate-400">لا توجد محادثات محفوظة.</p> : (
            <div className="space-y-2">
              {data.recentChats.slice(0, 8).map((c) => (
                <div key={c.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <Badge variant="outline">{c.role === 'assistant' ? 'المشرف' : 'الطالب'} — {c.mode}</Badge>
                    <span className="text-[10px] text-slate-400">{dateAr(c.createdAt)}</span>
                  </div>
                  <p className="line-clamp-3 leading-5 text-slate-600">{c.content}</p>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}
