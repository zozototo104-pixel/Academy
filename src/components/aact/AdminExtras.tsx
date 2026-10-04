'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, getToken } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CertificateDialog, CertificateData } from '@/components/aact/CertificateDialog'
import {
  Loader2, Gavel, CheckCircle2, XCircle, Banknote, TrendingUp, Globe2,
  Award, Settings2, ScrollText, Mail, FileDown, Plus, Users2,
  FileSignature, RefreshCw, ShieldCheck, Trash2, KeyRound,
} from 'lucide-react'

type ApiError = { message?: string }

function money(value: unknown) {
  const n = Number(value || 0)
  return `${Number.isFinite(n) ? n.toLocaleString('en-US') : '0'}$`
}

function safeDate(value?: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ar-EG')
}

function apiMessage(e: unknown, fallback = 'تعذر تنفيذ العملية') {
  return (e as ApiError)?.message || fallback
}

// ============ جدولة المناقشات واللجان ============

interface Thesis {
  id: string
  title: string
  abstract?: string | null
  status: string
  defenseDate?: string | null
  committee?: string | null
  resultScore?: number | null
  passed?: boolean | null
  reviewNote?: string | null
  user?: { name?: string | null; email?: string | null } | null
  admission?: { reference?: string | null; program?: string | null } | null
}

export function AdminThesisTab() {
  const { toast } = useToast()
  const [theses, setTheses] = useState<Thesis[]>([])
  const [loading, setLoading] = useState(true)

  const load = () => {
    setLoading(true)
    api<{ theses: Thesis[] }>('/api/admin/thesis')
      .then((d) => setTheses(Array.isArray(d.theses) ? d.theses : []))
      .catch((e) => toast({ title: 'تعذر تحميل أبحاث التخرج', description: apiMessage(e), variant: 'destructive' }))
      .finally(() => setLoading(false))
  }

  useEffect(load, [])

  if (loading) return <LoadingBlock label="جاري تحميل أبحاث التخرج والمناقشات..." />

  return (
    <div className="mt-4 space-y-4">
      <SectionHeader icon={<Gavel className="h-5 w-5 text-[#c9a227]" />} title="أبحاث التخرج والمناقشات" onRefresh={load} />
      {theses.length === 0 ? <EmptyCard text="لا توجد أبحاث تخرج مسلَّمة بعد" /> : theses.map((t) => (
        <Card key={t.id} className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-black text-[#0f2b46]">{t.title}</h4>
                  <Badge variant="outline" className="font-bold">{t.status}</Badge>
                  {t.admission?.reference && <span className="rounded bg-[#0f2b46] px-2 py-0.5 font-mono text-[10px] text-[#e0b83a]" dir="ltr">{t.admission.reference}</span>}
                </div>
                <p className="mt-1 text-xs font-bold text-slate-500">{t.user?.name || 'طالب غير محدد'} — {t.admission?.program || 'برنامج غير محدد'}</p>
                {t.abstract && <p className="mt-2 line-clamp-3 text-xs leading-6 text-slate-600">{t.abstract}</p>}
                {t.reviewNote && <p className="mt-2 rounded-xl bg-amber-50 p-3 text-[11px] font-bold text-amber-800">{t.reviewNote}</p>}
                <p className="mt-2 text-[11px] font-bold text-slate-400">موعد المناقشة: {safeDate(t.defenseDate)}</p>
                {t.resultScore != null && <p className="mt-1 text-xs font-black text-[#0f2b46]">النتيجة: {t.resultScore} — {t.passed ? 'مجتاز' : 'غير مجتاز'}</p>}
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

// ============ المالية: المدفوعات + التقارير ============

interface PaymentProofRow {
  id: string
  status: string
  fileName: string
  uploadedBy?: { name?: string | null } | null
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
  receiptNo?: string | null
  payerName?: string | null
  createdAt: string
  proofs?: PaymentProofRow[]
  admission?: { reference?: string | null; fullName?: string | null; program?: string | null } | null
}

interface Report {
  admissionStats?: { total: number; approved: number; rejected: number; pending: number; certified: number }
  byCountry?: Record<string, number>
  agentPerformance?: { orgName: string; territory: string; due: number; paid: number; entries: number }[]
}

export function AdminFinanceTab() {
  const { toast } = useToast()
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [totals, setTotals] = useState({ collected: 0, pending: 0, count: 0, paidCount: 0, manualPendingCount: 0, manualPendingAmount: 0 })
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('ALL')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pdfBusy, setPdfBusy] = useState<string | null>(null)
  const [amountBusy, setAmountBusy] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  const load = () => setRefresh((v) => v + 1)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const params = new URLSearchParams({ page: String(page), pageSize: '25', status })
    if (search.trim()) params.set('search', search.trim())
    api<{ payments: PaymentRow[]; totals: any }>(`/api/admin/payments?${params.toString()}`)
      .then((d) => {
        if (cancelled) return
        setPayments(Array.isArray(d.payments) ? d.payments : [])
        setTotals(d.totals || { collected: 0, pending: 0, count: 0, paidCount: 0, manualPendingCount: 0, manualPendingAmount: 0 })
      })
      .catch((e) => toast({ title: 'تعذر تحميل المدفوعات', description: apiMessage(e), variant: 'destructive' }))
      .finally(() => { if (!cancelled) setLoading(false) })
    api<Report>('/api/admin/reports').then(setReport).catch(() => setReport(null))
    return () => { cancelled = true }
  }, [page, status, search, refresh, toast])

  const confirmPayment = async (payment: PaymentRow) => {
    const approvalNote = window.prompt('اكتب ملاحظة أو رقم حوالة قبل التأكيد:', payment.invoiceNo)
    if (approvalNote === null) return
    try {
      await api('/api/admin/payments', { method: 'PATCH', body: JSON.stringify({ id: payment.id, approvalNote }) })
      toast({ title: 'تم التأكيد', description: 'أُصدر إيصال الدفع وأُبلغ الطالب' })
      load()
    } catch (e) {
      toast({ title: 'تعذر التأكيد', description: apiMessage(e), variant: 'destructive' })
    }
  }

  const refreshAmount = async (payment: PaymentRow) => {
    setAmountBusy(payment.id)
    try {
      const preview = await api<{ changed: boolean; oldAmount: number; newAmount: number }>('/api/admin/payments', {
        method: 'PATCH',
        body: JSON.stringify({ id: payment.id, action: 'REFRESH_AMOUNT', dryRun: true }),
      })
      if (!preview.changed) {
        toast({ title: 'لا يوجد تغيير', description: 'المبلغ الحالي مطابق للمبلغ المحسوب من الإعدادات الحالية.' })
        return
      }
      if (!window.confirm(`سيتم تحديث مبلغ الفاتورة من ${preview.oldAmount}$ إلى ${preview.newAmount}$. هل تريد المتابعة؟`)) return
      const reason = window.prompt('اكتب سبب تحديث مبلغ الفاتورة:')
      if (reason === null) return
      if (reason.trim().length < 6) {
        toast({ title: 'سبب مطلوب', description: 'اكتب سبباً واضحاً لا يقل عن 6 أحرف.', variant: 'destructive' })
        return
      }
      await api('/api/admin/payments', { method: 'PATCH', body: JSON.stringify({ id: payment.id, action: 'REFRESH_AMOUNT', reason: reason.trim() }) })
      toast({ title: 'تم تحديث المبلغ', description: `${preview.oldAmount}$ ← ${preview.newAmount}$` })
      load()
    } catch (e) {
      toast({ title: 'تعذر تحديث المبلغ', description: apiMessage(e), variant: 'destructive' })
    } finally {
      setAmountBusy(null)
    }
  }

  const openInvoicePdf = async (id: string) => {
    setPdfBusy(id)
    try {
      const token = getToken()
      const res = await fetch(`/api/pdf/invoices/${encodeURIComponent(id)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      toast({ title: 'تعذر فتح PDF الفاتورة', description: apiMessage(e), variant: 'destructive' })
    } finally {
      setPdfBusy(null)
    }
  }

  if (loading) return <LoadingBlock label="جاري تحميل المدفوعات..." />

  return (
    <div className="mt-4 space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="إجمالي المحصّل" value={money(totals.collected)} />
        <StatCard label="مستحق غير مسدد" value={money(totals.pending)} />
        <StatCard label="فواتير مسددة" value={`${totals.paidCount}/${totals.count}`} />
        <StatCard label="شهادات صادرة" value={String(report?.admissionStats?.certified || 0)} />
      </div>

      <Card className="border-[#0f2b46]/10">
        <CardContent className="p-4">
          <div className="mb-4 grid gap-2 md:grid-cols-[1fr_auto_auto]">
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="ابحث برقم الفاتورة أو الاسم أو البرنامج..." />
            <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1) }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">كل الفواتير</SelectItem>
                <SelectItem value="UNPAID">غير مسددة</SelectItem>
                <SelectItem value="PAID">مسددة</SelectItem>
                <SelectItem value="MANUAL_PENDING">دفع مباشر بانتظار التأكيد</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={load}><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
          </div>

          {payments.length === 0 ? <EmptyCard text="لا توجد فواتير مطابقة" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-right text-xs">
                <thead className="bg-[#f7edd0] text-[#0f2b46]">
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
                  {payments.map((p) => (
                    <tr key={p.id} className="border-t border-slate-100 align-top">
                      <td className="p-3">
                        <div className="font-mono text-[10px] font-bold" dir="ltr">{p.invoiceNo}</div>
                        <div className="text-[10px] text-slate-400">{p.payerName || p.admission?.fullName || '—'}</div>
                      </td>
                      <td className="max-w-xs p-3">
                        <div className="font-bold text-slate-700">{p.description}</div>
                        {p.admission?.reference && <div className="text-[10px] text-slate-400">{p.admission.reference}</div>}
                        {p.proofs?.length ? <Badge className="mt-1 bg-emerald-100 text-emerald-700 hover:bg-emerald-100">إثباتات: {p.proofs.length}</Badge> : null}
                      </td>
                      <td className="p-3 font-black text-[#0f2b46]">{money(p.amount)}</td>
                      <td className="p-3">{p.status === 'PAID' ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">مسددة</Badge> : <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">غير مسددة</Badge>}</td>
                      <td className="p-3"><Button size="sm" variant="outline" disabled={pdfBusy === p.id} onClick={() => openInvoicePdf(p.id)}>{pdfBusy === p.id ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : <FileDown className="ml-1 h-3 w-3" />} PDF</Button></td>
                      <td className="p-3">{p.status === 'UNPAID' ? <Button size="sm" variant="outline" disabled={amountBusy === p.id} onClick={() => refreshAmount(p)}>{amountBusy === p.id ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : <RefreshCw className="ml-1 h-3 w-3" />} تحديث المبلغ</Button> : '—'}</td>
                      <td className="p-3">{p.status === 'UNPAID' ? <Button size="sm" variant="outline" onClick={() => confirmPayment(p)}><Banknote className="ml-1 h-3 w-3" /> تأكيد وصول المبلغ</Button> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
            <span>الصفحة {page}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>السابق</Button>
              <Button size="sm" variant="outline" onClick={() => setPage((p) => p + 1)}>التالي</Button>
            </div>
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
  const [form, setForm] = useState({ holderName: '', program: '', grade: '', country: '' })

  const load = () => {
    setLoading(true)
    api<{ certificates: CertificateData[] }>('/api/admin/certificates')
      .then((d) => setCerts(Array.isArray(d.certificates) ? d.certificates : []))
      .catch((e) => toast({ title: 'تعذر تحميل الشهادات', description: apiMessage(e), variant: 'destructive' }))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const issue = async () => {
    try {
      await api('/api/admin/certificates', { method: 'POST', body: JSON.stringify(form) })
      setIssueOpen(false)
      setForm({ holderName: '', program: '', grade: '', country: '' })
      toast({ title: 'تم الإصدار' })
      load()
    } catch (e) {
      toast({ title: 'تعذر الإصدار', description: apiMessage(e), variant: 'destructive' })
    }
  }

  if (loading) return <LoadingBlock label="جاري تحميل الشهادات..." />

  return (
    <div className="mt-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-black text-[#0f2b46]">الشهادات الصادرة</h3>
        <Button onClick={() => setIssueOpen(true)} className="bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]"><Plus className="ml-1 h-4 w-4" /> إصدار شهادة</Button>
      </div>
      {certs.length === 0 ? <EmptyCard text="لا توجد شهادات بعد" /> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {certs.map((c) => (
            <Card key={c.serial} className="border-[#c9a227]/30">
              <CardContent className="p-4">
                <Award className="mb-2 h-5 w-5 text-[#a8841a]" />
                <h4 className="text-sm font-black text-[#0f2b46]">{c.holderName}</h4>
                <p className="mt-1 text-xs text-slate-500">{c.program}</p>
                <p className="mt-1 font-mono text-[10px] text-slate-400" dir="ltr">{c.serial}</p>
                <Button size="sm" variant="outline" className="mt-3 w-full" onClick={() => { setSelected(c); setOpen(true) }}>عرض / طباعة</Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <CertificateDialog certificate={selected} open={open} onClose={() => setOpen(false)} />
      <Dialog open={issueOpen} onOpenChange={setIssueOpen}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>إصدار شهادة جديدة</DialogTitle><DialogDescription>يولد النظام الرقم التسلسلي ورمز QR تلقائياً.</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <Input placeholder="اسم صاحب الشهادة" value={form.holderName} onChange={(e) => setForm({ ...form, holderName: e.target.value })} />
            <Input placeholder="البرنامج" value={form.program} onChange={(e) => setForm({ ...form, program: e.target.value })} />
            <Input placeholder="التقدير" value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} />
            <Input placeholder="الدولة" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
            <Button onClick={issue} className="w-full bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#12365c]">إصدار</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ============ إعدادات عامة ومدراء النظام ============

interface SettingDef { key: string; label: string; group: string; suffix?: string; inputType?: 'number' | 'text' | 'textarea' | 'json'; help?: string }
interface SystemAdminAccount { id: string; name: string; email: string; role?: string; status: string; createdAt: string }

export function AdminSettingsTab() {
  const { toast } = useToast()
  const [values, setValues] = useState<Record<string, string>>({})
  const [defs, setDefs] = useState<SettingDef[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api<{ values: Record<string, string>; defs?: SettingDef[] }>('/api/settings')
      .then((d) => { setValues(d.values || {}); setDefs(d.defs || []) })
      .catch((e) => toast({ title: 'تعذر تحميل الإعدادات', description: apiMessage(e), variant: 'destructive' }))
      .finally(() => setLoading(false))
  }, [toast])

  const save = async () => {
    setSaving(true)
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify({ values }) })
      toast({ title: 'حُفظت الإعدادات العامة' })
    } catch (e) {
      toast({ title: 'تعذر الحفظ', description: apiMessage(e), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const grouped = useMemo(() => defs.reduce<Record<string, SettingDef[]>>((acc, d) => {
    const key = d.group || 'GENERAL'
    acc[key] = acc[key] || []
    acc[key].push(d)
    return acc
  }, {}), [defs])

  if (loading) return <LoadingBlock label="جاري تحميل الإعدادات..." />

  return (
    <div className="mt-4 space-y-4">
      {Object.entries(grouped).map(([group, items]) => (
        <Card key={group} className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <h3 className="mb-4 flex items-center gap-2 text-sm font-black text-[#0f2b46]"><Settings2 className="h-4 w-4 text-[#c9a227]" /> {group}</h3>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {items.map((d) => (
                <div key={d.key} className={(d.inputType === 'textarea' || d.inputType === 'json') ? 'md:col-span-2 lg:col-span-3' : ''}>
                  <Label className="text-xs font-bold text-slate-600">{d.label}</Label>
                  {d.help && <p className="mt-1 text-[10px] text-slate-400">{d.help}</p>}
                  {d.inputType === 'textarea' || d.inputType === 'json' ? (
                    <Textarea rows={d.inputType === 'json' ? 6 : 4} dir={d.inputType === 'json' ? 'ltr' : 'rtl'} value={values[d.key] || ''} onChange={(e) => setValues({ ...values, [d.key]: e.target.value })} />
                  ) : (
                    <Input dir="ltr" type={d.inputType === 'number' ? 'number' : 'text'} value={values[d.key] || ''} onChange={(e) => setValues({ ...values, [d.key]: e.target.value })} />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
      <Button onClick={save} disabled={saving} className="bg-[#c9a227] font-black text-[#0f2b46] hover:bg-[#e0b83a]">{saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Settings2 className="ml-2 h-4 w-4" />} حفظ التعديلات</Button>
    </div>
  )
}

export function AdminAdminsTab() {
  const { toast } = useToast()
  const [admins, setAdmins] = useState<SystemAdminAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: 'QA Admin', email: 'qa-admin@aactacademy.com', password: '' })

  const load = () => {
    setLoading(true)
    api<{ admins: SystemAdminAccount[] }>('/api/admin/system-admins')
      .then((d) => setAdmins(Array.isArray(d.admins) ? d.admins : []))
      .catch((e) => toast({ title: 'تعذر تحميل المدراء', description: apiMessage(e), variant: 'destructive' }))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const createAdmin = async () => {
    setBusy(true)
    try {
      await api('/api/admin/system-admins', { method: 'POST', body: JSON.stringify(form) })
      setForm({ ...form, password: '' })
      toast({ title: 'تم تجهيز حساب الإدارة' })
      load()
    } catch (e) {
      toast({ title: 'تعذر إنشاء الحساب', description: apiMessage(e), variant: 'destructive' })
    } finally { setBusy(false) }
  }

  const disableAdmin = async (admin: SystemAdminAccount) => {
    if (!window.confirm(`تعطيل حساب ${admin.email}؟`)) return
    try {
      await api(`/api/admin/system-admins?id=${encodeURIComponent(admin.id)}`, { method: 'DELETE' })
      toast({ title: 'تم تعطيل الحساب' })
      load()
    } catch (e) {
      toast({ title: 'تعذر التعطيل', description: apiMessage(e), variant: 'destructive' })
    }
  }

  if (loading) return <LoadingBlock label="جاري تحميل مدراء النظام..." />

  return (
    <div className="mt-4 space-y-4">
      <Card className="border-[#0f2b46]/10"><CardContent className="grid gap-3 p-5 md:grid-cols-[1fr_1fr_1fr_auto]">
        <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="الاسم" />
        <Input dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="email@example.com" />
        <Input dir="ltr" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="كلمة المرور" />
        <Button disabled={busy} onClick={createAdmin} className="bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#12365c]"><KeyRound className="ml-1 h-4 w-4" /> إنشاء / تحديث</Button>
      </CardContent></Card>
      {admins.map((a) => (
        <Card key={a.id} className="border-[#0f2b46]/10"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div><p className="font-black text-[#0f2b46]">{a.name}</p><p className="text-xs text-slate-500" dir="ltr">{a.email}</p></div>
          <Badge variant="outline">{a.status}</Badge>
          <Button size="sm" variant="outline" onClick={() => disableAdmin(a)} className="border-red-200 text-red-600"><Trash2 className="ml-1 h-3 w-3" /> تعطيل</Button>
        </CardContent></Card>
      ))}
    </div>
  )
}

// ============ سجل التدقيق ============

interface AuditRow { id: string; actorName: string; action: string; entity: string; details?: string | null; createdAt: string }

export function AdminAuditTab() {
  const [logs, setLogs] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  useEffect(() => {
    const params = new URLSearchParams({ page: '1', pageSize: '100' })
    if (search.trim()) params.set('search', search.trim())
    setLoading(true)
    api<{ logs: AuditRow[] }>(`/api/admin/audit?${params.toString()}`)
      .then((d) => setLogs(Array.isArray(d.logs) ? d.logs : []))
      .catch(() => setLogs([]))
      .finally(() => setLoading(false))
  }, [search])

  if (loading) return <LoadingBlock label="جاري تحميل سجل التدقيق..." />

  return (
    <Card className="mt-4 border-[#0f2b46]/10">
      <CardContent className="p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]"><ScrollText className="h-4 w-4 text-[#c9a227]" /> سجل التدقيق</h3>
        <Input className="mb-3" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="بحث في السجل..." />
        <div className="space-y-2">
          {logs.length === 0 ? <p className="p-6 text-center text-xs text-slate-400">لا توجد إجراءات مطابقة</p> : logs.map((l) => (
            <div key={l.id} className="rounded-xl border border-slate-100 p-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2"><Badge variant="outline">{l.action}</Badge><span className="text-slate-400">{safeDate(l.createdAt)}</span></div>
              <p className="mt-1 font-bold text-[#0f2b46]">{l.actorName} — {l.entity}</p>
              <p className="mt-1 break-words text-slate-600">{l.details || '—'}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

// ============ رسائل التواصل ============

interface Msg { id: string; name: string; email: string; phone?: string | null; subject: string; message: string; handled: boolean; createdAt: string }

export function AdminMessagesTab() {
  const { toast } = useToast()
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('OPEN')

  const load = () => {
    setLoading(true)
    const params = new URLSearchParams({ page: '1', pageSize: '50', status })
    api<{ messages: Msg[] }>(`/api/admin/contact?${params.toString()}`)
      .then((d) => setMsgs(Array.isArray(d.messages) ? d.messages : []))
      .catch((e) => toast({ title: 'تعذر تحميل الرسائل', description: apiMessage(e), variant: 'destructive' }))
      .finally(() => setLoading(false))
  }
  useEffect(load, [status])

  const mark = async (id: string, handled: boolean) => {
    await api('/api/admin/contact', { method: 'PATCH', body: JSON.stringify({ id, handled }) }).catch(() => {})
    load()
  }

  if (loading) return <LoadingBlock label="جاري تحميل رسائل التواصل..." />

  return (
    <div className="mt-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="OPEN">الجديدة</SelectItem><SelectItem value="HANDLED">المعالجة</SelectItem><SelectItem value="ALL">كل الرسائل</SelectItem></SelectContent>
        </Select>
        <Button variant="outline" onClick={load}><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button>
      </div>
      {msgs.length === 0 ? <EmptyCard text="لا توجد رسائل مطابقة" /> : msgs.map((m) => (
        <Card key={m.id} className={`border ${m.handled ? 'border-slate-100 opacity-70' : 'border-[#c9a227]/40 bg-[#f7edd0]/30'}`}>
          <CardContent className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1"><h4 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]"><Mail className="h-4 w-4 text-[#c9a227]" /> {m.subject}</h4><p className="mt-1 text-xs text-slate-500" dir="ltr">{m.name} · {m.email} {m.phone ? `· ${m.phone}` : ''}</p><p className="mt-2 whitespace-pre-wrap text-xs leading-6 text-slate-600">{m.message}</p></div>
              <Button size="sm" variant="outline" onClick={() => mark(m.id, !m.handled)}>{m.handled ? <><XCircle className="ml-1 h-3 w-3" /> إعادة فتح</> : <><CheckCircle2 className="ml-1 h-3 w-3" /> تمت المعالجة</>}</Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function LoadingBlock({ label }: { label: string }) {
  return <div className="mt-4 flex h-40 flex-col items-center justify-center gap-2 rounded-2xl border border-slate-100 bg-white"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /><p className="text-sm font-black text-[#0f2b46]">{label}</p></div>
}

function EmptyCard({ text }: { text: string }) {
  return <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">{text}</CardContent></Card>
}

function SectionHeader({ title, icon, onRefresh }: { title: string; icon: React.ReactNode; onRefresh: () => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#0f2b46]/10 bg-white p-4"><h2 className="flex items-center gap-2 text-base font-black text-[#0f2b46]">{icon}{title}</h2><Button variant="outline" onClick={onRefresh}><RefreshCw className="ml-1 h-4 w-4" /> تحديث</Button></div>
}

function StatCard({ label, value }: { label: string; value: string }) {
  return <Card className="border-[#0f2b46]/10"><CardContent className="p-4 text-center"><p className="text-xl font-black text-[#0f2b46]">{value}</p><p className="text-[10px] font-bold text-slate-500">{label}</p></CardContent></Card>
}
