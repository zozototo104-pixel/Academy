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
  Building2,
  CheckCircle2,
  ClipboardList,
  FileText,
  Globe2,
  Handshake,
  IdCard,
  Loader2,
  Percent,
  ReceiptText,
  ShieldCheck,
  UserRound,
} from 'lucide-react'

interface PreviewData {
  previewMode: string
  note: string
  application: {
    id: string
    kind: string
    accreditationType?: string | null
    accreditationLabel: string
    orgName: string
    repName: string
    email: string
    phone?: string | null
    country: string
    territory?: string | null
    experience?: string | null
    status: string
    contractNo?: string | null
    commissionRate?: number | null
    committeeFee?: number | null
    exclusive?: boolean | null
    startDate?: string | null
    endDate?: string | null
    revokedAt?: string | null
    revokedReason?: string | null
    createdAt: string
    submittedByStaff?: boolean
    user?: { id: string; name: string; email: string; role: string; country?: string | null; phone?: string | null; createdAt: string } | null
    documents: { id: string; docType: string; fileName: string; mimeType: string; size: number; createdAt: string }[]
    payments: { id: string; invoiceNo: string; purpose: string; description: string; amount: number; currency: string; method?: string | null; status: string; receiptNo?: string | null; paidAt?: string | null; createdAt: string }[]
    certificates: { id: string; serial: string; type: string; holderName: string; program: string; grade?: string | null; valid: boolean; issuedAt: string }[]
    revenueShares: { id: string; type: string; description: string; amount: number; currency: string; status: string; dueDate?: string | null; paidAt?: string | null; programCountry?: string | null; createdAt: string }[]
  }
  overview: {
    documents: number
    certificates: number
    validCertificates: number
    payments: number
    paidTotal: number
    unpaidTotal: number
    revenueRows: number
    dueRevenue: number
    paidRevenue: number
    submittedByStaff: boolean
  }
}

const STATUS_AR: Record<string, string> = {
  PENDING: 'قيد المراجعة',
  APPROVED: 'معتمد',
  REJECTED: 'مرفوض',
  REVOKED: 'ملغى/مسحوب',
  PAID: 'مدفوع',
  UNPAID: 'غير مدفوع',
  DUE: 'مستحق',
}

const DOC_AR: Record<string, string> = {
  LICENSE: 'الترخيص/مزاولة المهنة',
  ID: 'الهوية/الجواز',
  PHOTO: 'الصورة الشخصية',
  CV: 'السيرة الذاتية',
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

function money(value: number, currency = 'USD') {
  return `${Math.round(Number(value || 0) * 100) / 100} ${currency}`
}

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: ReactNode }) {
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

export function AdminAgentPreview() {
  const { agentPreviewId, navigate } = useAppStore()
  const [data, setData] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const id = useMemo(() => {
    if (agentPreviewId) return agentPreviewId
    if (typeof window === 'undefined') return ''
    return new URLSearchParams(window.location.search).get('agentId') || ''
  }, [agentPreviewId])

  const load = () => {
    if (!id) {
      setLoading(false)
      setError('لم يتم تحديد طلب الوكالة/الاعتماد')
      return
    }
    setLoading(true)
    setError(null)
    api<PreviewData>(`/api/admin/agents/preview?agentId=${encodeURIComponent(id)}`)
      .then(setData)
      .catch((e: any) => setError(e?.message || 'تعذر تحميل معاينة الوكالة/الاعتماد'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [id])

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <Card className="border-[#0f2b46]/10">
          <CardContent className="flex h-56 flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="h-9 w-9 animate-spin text-[#c9a227]" />
            <p className="text-sm font-black text-[#0f2b46]">جاري تحميل معاينة الوكالة/الاعتماد...</p>
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
            <h1 className="text-lg font-black text-red-700">تعذر فتح معاينة الوكالة/الاعتماد</h1>
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

  const app = data.application
  const statusClass = app.status === 'APPROVED'
    ? 'bg-emerald-100 text-emerald-700'
    : app.status === 'PENDING'
      ? 'bg-amber-100 text-amber-700'
      : 'bg-red-100 text-red-700'

  const metrics = [
    { label: 'نوع الملف', value: app.accreditationLabel, icon: app.kind === 'AGENCY' ? Handshake : ShieldCheck },
    { label: 'حالة الطلب', value: arStatus(app.status), icon: ClipboardList },
    { label: 'الوثائق', value: `${data.overview.documents}/4`, icon: FileText },
    { label: 'الشهادات الصالحة', value: data.overview.validCertificates, icon: Award },
    { label: 'مدفوعات مسددة', value: money(data.overview.paidTotal), icon: Banknote },
    { label: 'مستحقات الوكيل', value: money(data.overview.dueRevenue), icon: Percent },
  ]

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:py-8">
      <div className="flex flex-col gap-3 rounded-3xl bg-[#0f2b46] p-5 text-[#f5f0e1] shadow-lg sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Badge className="mb-3 bg-[#c9a227] text-[#0f2b46] hover:bg-[#c9a227]">معاينة إدارية — قراءة فقط</Badge>
          <h1 className="flex items-center gap-2 text-2xl font-black sm:text-3xl">
            <Building2 className="h-6 w-6 text-[#c9a227]" /> {app.orgName}
          </h1>
          <p className="mt-2 text-sm font-bold text-[#f5f0e1]/75">الممثل: {app.repName} — {app.country}{app.territory ? ` — ${app.territory}` : ''}</p>
          <p className="mt-1 text-xs font-bold text-[#f5f0e1]/60" dir="ltr">{app.email}{app.phone ? ` · ${app.phone}` : ''}</p>
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

      {data.overview.submittedByStaff && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex flex-col gap-2 p-4 text-xs font-bold leading-6 text-red-700 sm:flex-row sm:items-center">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            هذا الطلب مرتبط بحساب إدارة/مشرف، لذلك يُعامل كطلب تجريبي/إداري ولا يُعتمد كوكالة أو اعتماد رسمي. أنشئ طلباً جديداً من حساب جهة/وكيل منفصل أو كزائر، ثم أغلق هذا الطلب من لوحة الإدارة.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {metrics.map((m) => (
          <Card key={m.label} className="border-[#0f2b46]/10">
            <CardContent className="p-4 text-center">
              <m.icon className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" />
              <div className="text-lg font-black text-[#0f2b46]">{m.value}</div>
              <div className="mt-1 text-[10px] font-bold text-slate-500">{m.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="بيانات الطلب والجهة" icon={Globe2}>
          <div className="grid gap-3 text-xs font-bold text-slate-600 sm:grid-cols-2">
            <p className="rounded-xl bg-slate-50 p-3"><b className="text-[#0f2b46]">الحالة:</b> <span className={`rounded-full px-2 py-0.5 ${statusClass}`}>{arStatus(app.status)}</span></p>
            <p className="rounded-xl bg-slate-50 p-3"><b className="text-[#0f2b46]">تاريخ التقديم:</b> {dateAr(app.createdAt)}</p>
            <p className="rounded-xl bg-slate-50 p-3"><b className="text-[#0f2b46]">نوع الطلب:</b> {app.accreditationLabel}</p>
            <p className="rounded-xl bg-slate-50 p-3"><b className="text-[#0f2b46]">النطاق:</b> {app.territory || app.country}</p>
          </div>
          {app.experience && <p className="mt-3 rounded-xl bg-slate-50 p-3 text-xs font-bold leading-6 text-slate-600">{app.experience}</p>}
          {app.user && (
            <div className="mt-3 rounded-xl border border-[#0f2b46]/10 bg-white p-3 text-xs leading-6 text-slate-600">
              <p className="font-black text-[#0f2b46]"><UserRound className="ml-1 inline h-4 w-4 text-[#a8841a]" />الحساب المرتبط</p>
              <p>{app.user.name} — {app.user.role}</p>
              <p dir="ltr" className="text-right">{app.user.email}{app.user.phone ? ` · ${app.user.phone}` : ''}</p>
            </div>
          )}
        </Section>

        <Section title="العقد/الإلغاء" icon={Handshake}>
          {app.contractNo ? (
            <div className="space-y-2 text-xs font-bold text-slate-600">
              <p className="rounded-xl bg-[#fff8e6] p-3"><b className="text-[#0f2b46]">رقم العقد:</b> <span dir="ltr">{app.contractNo}</span></p>
              <p className="rounded-xl bg-slate-50 p-3"><b className="text-[#0f2b46]">العمولة:</b> {app.commissionRate || 0}% — مكافأة اللجنة: {app.committeeFee || 0}$</p>
              <p className="rounded-xl bg-slate-50 p-3"><b className="text-[#0f2b46]">المدة:</b> {dateAr(app.startDate)} — {dateAr(app.endDate)} — {app.exclusive ? 'حصري' : 'غير حصري'}</p>
            </div>
          ) : (
            <p className="text-sm text-slate-400">لم يصدر عقد بعد.</p>
          )}
          {app.status === 'REVOKED' && (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold leading-6 text-red-700">
              <p className="font-black">تم إلغاء/سحب الاعتماد</p>
              <p>تاريخ السحب: {dateAr(app.revokedAt)}</p>
              <p>السبب: {app.revokedReason || 'غير مسجل'}</p>
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="الوثائق الرسمية" icon={IdCard}>
          {app.documents.length === 0 ? <p className="text-sm text-slate-400">لا توجد وثائق مرفوعة.</p> : (
            <div className="grid gap-2 sm:grid-cols-2">
              {app.documents.map((doc) => (
                <a key={doc.id} href={`/api/agent-docs/${doc.id}`} target="_blank" rel="noreferrer" className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs font-bold text-[#0f2b46] hover:bg-[#fff8e6]">
                  <FileText className="mb-2 h-4 w-4 text-[#a8841a]" />
                  {DOC_AR[doc.docType] || doc.docType}
                  <p className="mt-1 truncate text-[10px] text-slate-500">{doc.fileName}</p>
                  <p className="text-[10px] text-slate-400">{Math.round(doc.size / 1024)} KB — {dateAr(doc.createdAt)}</p>
                </a>
              ))}
            </div>
          )}
        </Section>

        <Section title="الشهادات الصادرة" icon={Award}>
          {app.certificates.length === 0 ? <p className="text-sm text-slate-400">لا توجد شهادات اعتماد صادرة.</p> : (
            <div className="space-y-2">
              {app.certificates.map((c) => (
                <div key={c.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-black text-[#0f2b46]" dir="ltr">{c.serial}</p>
                    <Badge className={c.valid ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-red-100 text-red-700 hover:bg-red-100'}>{c.valid ? 'صالحة' : 'غير صالحة'}</Badge>
                  </div>
                  <p className="mt-1 font-bold text-slate-600">{c.program}</p>
                  <p className="mt-1 text-slate-400">إصدار: {dateAr(c.issuedAt)}</p>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="الفواتير والمدفوعات" icon={ReceiptText}>
          {app.payments.length === 0 ? <p className="text-sm text-slate-400">لا توجد فواتير مرتبطة.</p> : (
            <div className="space-y-2">
              {app.payments.map((p) => (
                <div key={p.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-black text-[#0f2b46]" dir="ltr">{p.invoiceNo}</p>
                    <Badge className={p.status === 'PAID' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>{arStatus(p.status)}</Badge>
                  </div>
                  <p className="mt-1 text-slate-600">{p.description}</p>
                  <p className="mt-1 text-slate-400">{money(p.amount, p.currency)} — {p.method || 'وسيلة غير محددة'} — {dateAr(p.paidAt || p.createdAt)}</p>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title="مستحقات الوكيل واللجان" icon={Percent}>
          {app.revenueShares.length === 0 ? <p className="text-sm text-slate-400">لا توجد مستحقات أو عمولات مسجلة.</p> : (
            <div className="space-y-2">
              {app.revenueShares.map((r) => (
                <div key={r.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-black text-[#0f2b46]">{r.type === 'COMMITTEE_FEE' ? 'مكافأة لجنة' : 'عمولة إيراد'}</p>
                    <Badge className={r.status === 'PAID' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>{arStatus(r.status)}</Badge>
                  </div>
                  <p className="mt-1 text-slate-600">{r.description}</p>
                  <p className="mt-1 text-slate-400">{money(r.amount, r.currency)} — {r.programCountry || 'عام'} — {dateAr(r.paidAt || r.dueDate || r.createdAt)}</p>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}
