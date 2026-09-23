'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
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
import {
  Banknote,
  Loader2,
  ReceiptText,
  Wallet,
  CheckCircle2,
  Clock3,
  Landmark,
  CreditCard,
  Printer,
  Info,
  FileText,
  Award,
  ScrollText,
} from 'lucide-react'

interface PaymentMethodStatus {
  id: string
  label: string
  enabled: boolean
  configured: boolean
  kind: 'gateway' | 'manual' | 'placeholder'
  reason?: string
}

interface PaymentConfig {
  mode: 'SANDBOX' | 'LIVE'
  sandboxAllowed: boolean
  trueGatewayCount: number
  warnings: string[]
  errors: string[]
  methods: PaymentMethodStatus[]
}

interface Payment {
  id: string
  invoiceNo: string
  purpose: string
  description: string
  amount: number
  currency: string
  method?: string | null
  status: string
  receiptNo?: string | null
  paidAt?: string | null
  createdAt: string
  reference?: string | null
  admissionId?: string | null
  provider?: string | null
  cryptoNetwork?: string | null
  cryptoWalletAddress?: string | null
  cryptoTxHash?: string | null
  cryptoVerificationStatus?: string | null
  cryptoVerificationNote?: string | null
}

interface TuitionPlan {
  admissionId: string
  reference: string
  program: string
  totalTuition: number
  paidTuition: number
  remainingTuition: number
  halfRequired: number
  finalRequired: number
  firstSemesterAllowed: boolean
  secondSemesterAllowed: boolean
  appealStatus: string | null
  appealId: string | null
  approvedInitialAmount: number | null
}

const PURPOSE_LABEL: Record<string, string> = {
  APPLICATION_FEE: 'رسوم تقديم وحجز مقعد',
  TUITION: 'الرسوم الدراسية الكاملة',
  TUITION_INSTALLMENT: 'دفعة جزئية من الرسوم الدراسية',
  ACCREDITATION_APP: 'رسوم تقديم اعتماد',
  ACCREDITATION_FEE: 'رسوم تقديم اعتماد',
  ACCREDITATION: 'رسوم اعتماد',
  SERVICE_FEE: 'رسوم تنفيذ خدمة',
  OTHER: 'رسوم أخرى',
}

const METHOD_LABEL: Record<string, string> = {
  PAYMOB: 'Paymob',
  FAWRY: 'فوري',
  STRIPE: 'Stripe',
  PAYPAL: 'PayPal',
  USDT: 'USDT / Tether',
  BANK_TRANSFER: 'تحويل بنكي',
  DIRECT_PAYMENT: 'دفع مباشر',
  SANDBOX: 'محاكاة آمنة',
}

function Money({ value }: { value: number }) {
  return <span dir="ltr">{Math.round((Number(value) || 0) * 100) / 100}$</span>
}

export function PaymentsTab() {
  const { toast } = useToast()
  const [payments, setPayments] = useState<Payment[]>([])
  const [tuitionPlans, setTuitionPlans] = useState<TuitionPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [payTarget, setPayTarget] = useState<Payment | null>(null)
  const [method, setMethod] = useState('DIRECT_PAYMENT')
  const [paying, setPaying] = useState(false)
  const [receipt, setReceipt] = useState<{ payment: Payment } | null>(null)
  const [payConfig, setPayConfig] = useState<PaymentConfig | null>(null)
  const [payMode, setPayMode] = useState<'SANDBOX' | 'LIVE'>('SANDBOX')
  const [appealBusy, setAppealBusy] = useState(false)
  const [appealPlanId, setAppealPlanId] = useState<string | null>(null)
  const [appealAmount, setAppealAmount] = useState('')
  const [appealReason, setAppealReason] = useState('')
  const [appealSchedule, setAppealSchedule] = useState('')
  const [partialAmount, setPartialAmount] = useState<Record<string, string>>({})
  const [usdtHashes, setUsdtHashes] = useState<Record<string, string>>({})
  const [verifyingUsdt, setVerifyingUsdt] = useState<string | null>(null)

  const load = () => {
    api<{ payments: Payment[]; tuitionPlans?: TuitionPlan[] }>('/api/payments')
      .then((d) => {
        setPayments(Array.isArray(d.payments) ? d.payments : [])
        setTuitionPlans(Array.isArray(d.tuitionPlans) ? d.tuitionPlans : [])
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    api<PaymentConfig>('/api/payments/config')
      .then((d) => {
        setPayConfig(d)
        setPayMode(d.mode || 'SANDBOX')
        const firstEnabled = d.methods?.find((m) => m.enabled)?.id
        if (firstEnabled) setMethod(firstEnabled)
      })
      .catch(() => {})

    const q = new URLSearchParams(window.location.search)
    const paid = q.get('paid')
    if (paid) {
      api<{ ok: boolean; status: string; receiptNo?: string; note?: string }>(`/api/payments/verify-session?invoiceNo=${encodeURIComponent(paid)}`)
        .then((d) => {
          if (d.status === 'PAID') toast({ title: 'تم تأكيد الدفع', description: `سُددت الفاتورة ${paid} — الإيصال ${d.receiptNo || ''}` })
          else toast({ title: 'الدفع قيد التحقق', description: d.note || 'سيُعتمد تلقائياً عند تأكيد المزود.' })
          load()
        })
        .catch(() => {})
      window.history.replaceState({}, '', '/?view=dashboard')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openPaymentDialog = (payment: Payment) => {
    const firstEnabled = payConfig?.methods?.find((m) => m.enabled)?.id
    if (firstEnabled) setMethod(firstEnabled)
    setPayTarget(payment)
  }

  const submitInstallmentAppeal = async (plan: TuitionPlan) => {
    const amount = Number(appealAmount || 0)
    if (!amount || amount <= 0) {
      toast({ title: 'أدخل مبلغاً صحيحاً', description: 'حدد الدفعة التي تستطيع دفعها الآن.', variant: 'destructive' })
      return
    }
    setAppealBusy(true)
    try {
      await api('/api/tuition-appeals', {
        method: 'POST',
        body: JSON.stringify({ admissionId: plan.admissionId, requestedInitialAmount: amount, reason: appealReason, proposedSchedule: appealSchedule }),
      })
      toast({ title: 'تم إرسال الالتماس', description: 'سيظهر القرار بعد مراجعة الإدارة.' })
      setAppealPlanId(null)
      setAppealAmount('')
      setAppealReason('')
      setAppealSchedule('')
      load()
    } catch (e: any) {
      toast({ title: 'تعذر إرسال الالتماس', description: e.message, variant: 'destructive' })
    } finally {
      setAppealBusy(false)
    }
  }

  const createInstallmentInvoice = async (plan: TuitionPlan) => {
    const amount = Number(partialAmount[plan.admissionId] || 0)
    if (!amount || amount <= 0) {
      toast({ title: 'أدخل مبلغ الدفعة', description: 'يمكنك دفع أي مبلغ متوفر لديك ضمن المتبقي.', variant: 'destructive' })
      return
    }
    setAppealBusy(true)
    try {
      const r = await api<{ payment: Payment }>('/api/payments/installment', {
        method: 'POST',
        body: JSON.stringify({ admissionId: plan.admissionId, amount }),
      })
      toast({ title: 'تم إنشاء فاتورة دفعة جزئية', description: `يمكنك الآن دفع ${amount}$ من الفواتير.` })
      setPartialAmount((prev) => ({ ...prev, [plan.admissionId]: '' }))
      load()
      if (r.payment) setPayTarget(r.payment)
    } catch (e: any) {
      toast({ title: 'تعذر إنشاء الدفعة', description: e.message, variant: 'destructive' })
    } finally {
      setAppealBusy(false)
    }
  }

  const submitUsdtProof = async (payment: Payment) => {
    const txHash = (usdtHashes[payment.id] || payment.cryptoTxHash || '').trim()
    if (!txHash) {
      toast({ title: 'أدخل TX Hash', description: 'انسخ Hash عملية تحويل USDT من المحفظة وألصقه هنا.', variant: 'destructive' })
      return
    }
    setVerifyingUsdt(payment.id)
    try {
      const res = await api<{ verification: { status: string; note: string }; payment: Payment }>('/api/payments/usdt-proof', {
        method: 'POST',
        body: JSON.stringify({ paymentId: payment.id, invoiceNo: payment.invoiceNo, txHash }),
      })
      toast({
        title: res.verification.status === 'VERIFIED' ? 'تم التحقق آلياً' : 'نتيجة التحقق من USDT',
        description: res.verification.note,
        variant: res.verification.status === 'FAILED' ? 'destructive' : undefined,
      })
      setUsdtHashes((prev) => ({ ...prev, [payment.id]: txHash }))
      load()
    } catch (e: any) {
      toast({ title: 'تعذر التحقق من USDT', description: e.message, variant: 'destructive' })
    } finally {
      setVerifyingUsdt(null)
    }
  }

  const pay = async () => {
    if (!payTarget) return
    const selectedMethod = payConfig?.methods?.find((m) => m.id === method)
    if (selectedMethod && !selectedMethod.enabled) {
      toast({ title: 'طريقة الدفع غير متاحة حالياً', description: selectedMethod.reason || 'اختر وسيلة أخرى أو راجع الإدارة.', variant: 'destructive' })
      return
    }
    const selectedKind = selectedMethod?.kind
    if (payConfig && payConfig.trueGatewayCount === 0 && payMode === 'LIVE' && selectedKind !== 'manual') {
      toast({ title: 'الدفع الإلكتروني غير متاح حالياً', description: 'اختر وسيلة دفع يدوية مثل «دفع مباشر» أو USDT إذا كانت مفعلة.', variant: 'destructive' })
      return
    }
    setPaying(true)
    try {
      const co = await api<{ mode: 'SANDBOX' | 'LIVE' | 'MANUAL'; redirectUrl: string | null; provider: string; message?: string }>('/api/payments/checkout', {
        method: 'POST',
        body: JSON.stringify({ invoiceNo: payTarget.invoiceNo, method }),
      })
      if (co?.provider === 'DIRECT_PAYMENT' || co?.provider === 'USDT') {
        toast({ title: co.provider === 'USDT' ? 'تم اختيار الدفع عبر USDT' : 'تم اختيار الدفع المباشر', description: co.message || 'تواصل مع الإدارة لتأكيد السداد.' })
        setPayTarget(null)
        load()
        return
      }
      if (co?.redirectUrl) {
        window.location.href = co.redirectUrl
        return
      }
      if (co?.provider !== 'SANDBOX') throw new Error('تعذر استلام رابط الدفع من البوابة. حاول لاحقاً أو راجع الإدارة.')
      const d = await api<{ payment: Payment; receiptNo: string }>('/api/payments', {
        method: 'POST',
        body: JSON.stringify({ invoiceNo: payTarget.invoiceNo, method }),
      })
      setReceipt({ payment: { ...payTarget, status: 'PAID', receiptNo: d.receiptNo, method, paidAt: new Date().toISOString() } })
      setPayTarget(null)
      load()
    } catch (e: any) {
      toast({ title: 'خطأ في الدفع', description: e.message, variant: 'destructive' })
    } finally {
      setPaying(false)
    }
  }

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>

  const totalDue = payments.filter((p) => p.status === 'UNPAID').reduce((s, p) => s + p.amount, 0)
  const totalPaid = payments.filter((p) => p.status === 'PAID').reduce((s, p) => s + p.amount, 0)
  const plansWithBalance = tuitionPlans.filter((p) => p.totalTuition > 0 && p.remainingTuition > 0)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card className="border-[#0f2b46]/10"><CardContent className="flex items-center gap-3 p-4"><span className="rounded-xl bg-amber-100 p-2.5 text-amber-600"><Clock3 className="h-5 w-5" /></span><div><p className="text-lg font-black text-[#0f2b46]"><Money value={totalDue} /></p><p className="text-[10px] font-bold text-slate-500">مستحق السداد</p></div></CardContent></Card>
        <Card className="border-[#0f2b46]/10"><CardContent className="flex items-center gap-3 p-4"><span className="rounded-xl bg-emerald-100 p-2.5 text-emerald-600"><Wallet className="h-5 w-5" /></span><div><p className="text-lg font-black text-[#0f2b46]"><Money value={totalPaid} /></p><p className="text-[10px] font-bold text-slate-500">إجمالي المسدد</p></div></CardContent></Card>
        <Card className="border-[#0f2b46]/10"><CardContent className="flex items-center gap-3 p-4"><span className="rounded-xl bg-[#f7edd0] p-2.5 text-[#a8841a]"><ReceiptText className="h-5 w-5" /></span><div><p className="text-lg font-black text-[#0f2b46]">{payments.length}</p><p className="text-[10px] font-bold text-slate-500">عدد الفواتير</p></div></CardContent></Card>
      </div>

      {plansWithBalance.map((plan) => (
        <Card key={plan.admissionId} className="border-blue-100 bg-blue-50/40">
          <CardContent className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-black text-[#0f2b46]">خطة الرسوم الدراسية — {plan.program}</p>
                <p className="mt-1 text-xs font-bold text-slate-600">المسدد <Money value={plan.paidTuition} /> من أصل <Money value={plan.totalTuition} /> — المتبقي <Money value={plan.remainingTuition} /></p>
              </div>
              <Badge className={plan.appealStatus === 'APPROVED' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : plan.appealStatus === 'PENDING' ? 'bg-amber-100 text-amber-700 hover:bg-amber-100' : 'bg-slate-100 text-slate-600 hover:bg-slate-100'}>
                {plan.appealStatus === 'APPROVED' ? 'تقسيط معتمد' : plan.appealStatus === 'PENDING' ? 'التماس قيد الدراسة' : 'بدون تقسيط'}
              </Badge>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl bg-white p-3 text-xs font-bold text-slate-600">فتح امتحان الفصل الأول: يلزم <Money value={plan.halfRequired} /> {plan.firstSemesterAllowed ? <span className="text-emerald-700">— مستوفى</span> : <span className="text-amber-700">— غير مستوفى</span>}</div>
              <div className="rounded-xl bg-white p-3 text-xs font-bold text-slate-600">فتح امتحان الفصل الثاني: يلزم <Money value={plan.finalRequired} /> {plan.secondSemesterAllowed ? <span className="text-emerald-700">— مستوفى</span> : <span className="text-amber-700">— غير مستوفى</span>}</div>
            </div>
            {plan.appealStatus === 'APPROVED' ? (
              <div className="mt-3 rounded-xl border border-emerald-100 bg-white p-3">
                <p className="text-xs font-black text-emerald-800">يمكنك دفع أي مبلغ متوفر لديك حتى اكتمال الرسوم.</p>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <Input value={partialAmount[plan.admissionId] || ''} onChange={(e) => setPartialAmount((prev) => ({ ...prev, [plan.admissionId]: e.target.value }))} inputMode="decimal" placeholder={`مبلغ الدفعة — المتبقي ${plan.remainingTuition}$`} />
                  <Button disabled={appealBusy} onClick={() => createInstallmentInvoice(plan)} className="bg-emerald-700 font-black text-white hover:bg-emerald-800">إنشاء فاتورة دفعة</Button>
                </div>
              </div>
            ) : plan.appealStatus === 'PENDING' ? (
              <div className="mt-3 rounded-xl border border-amber-100 bg-white p-3 text-xs font-bold text-amber-800">التماس التقسيط قيد دراسة الإدارة. ستظهر لك إمكانية الدفع الجزئي بعد القبول.</div>
            ) : (
              <div className="mt-3 rounded-xl border border-blue-100 bg-white p-3">
                {appealPlanId === plan.admissionId ? (
                  <div className="grid gap-2">
                    <Input value={appealAmount} onChange={(e) => setAppealAmount(e.target.value)} inputMode="decimal" placeholder="المبلغ الذي تستطيع دفعه الآن" />
                    <Textarea value={appealReason} onChange={(e) => setAppealReason(e.target.value)} placeholder="سبب الالتماس أو ظرف الدفع" />
                    <Textarea value={appealSchedule} onChange={(e) => setAppealSchedule(e.target.value)} placeholder="اقتراحك لتسديد الباقي خلال الفصل" />
                    <div className="flex gap-2">
                      <Button disabled={appealBusy} onClick={() => submitInstallmentAppeal(plan)} className="bg-blue-700 font-black text-white hover:bg-blue-800">إرسال الالتماس</Button>
                      <Button variant="outline" onClick={() => setAppealPlanId(null)}>إلغاء</Button>
                    </div>
                  </div>
                ) : (
                  <Button onClick={() => { setAppealPlanId(plan.admissionId); setAppealAmount(String(Math.ceil(plan.remainingTuition * 0.25))) }} variant="outline" className="border-blue-200 font-black text-blue-700">طلب تقسيط الرسوم</Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      {payments.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">لا توجد فواتير بعد</CardContent></Card>
      ) : (
        <div className="space-y-3">
          {payments.map((p) => (
            <Card key={p.id} className={`border ${p.status === 'PAID' ? 'border-emerald-100 bg-emerald-50/30' : 'border-amber-200 bg-amber-50/30'}`}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-[#0f2b46] px-2 py-0.5 font-mono text-[10px] font-bold text-[#e0b83a]" dir="ltr">{p.invoiceNo}</span>
                    <h4 className="text-sm font-black text-[#0f2b46]">{p.description}</h4>
                    {p.status === 'PAID' ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><CheckCircle2 className="ml-1 h-3 w-3" /> مسددة</Badge> : <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100"><Clock3 className="ml-1 h-3 w-3" /> بانتظار السداد</Badge>}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">{PURPOSE_LABEL[p.purpose] || p.purpose}{p.reference ? ` — طلب ${p.reference}` : ''}{p.method ? ` — عبر ${METHOD_LABEL[p.method] || p.method}` : ''}{p.receiptNo ? ` — إيصال ${p.receiptNo}` : ''}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-lg font-black text-[#0f2b46]"><Money value={p.amount} /></span>
                  {p.status === 'UNPAID' ? <Button size="sm" onClick={() => openPaymentDialog(p)} className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]"><CreditCard className="ml-1 h-3.5 w-3.5" /> ادفع الآن</Button> : <Button size="sm" variant="outline" onClick={() => setReceipt({ payment: p })} className="border-emerald-200 font-bold text-emerald-700"><ReceiptText className="ml-1 h-3.5 w-3.5" /> الإيصال</Button>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!payTarget} onOpenChange={(v) => !v && setPayTarget(null)}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-2 font-black text-[#0f2b46]"><span className="flex items-center gap-2"><Banknote className="h-5 w-5 text-[#c9a227]" /> إتمام الدفع</span><Badge className={payMode === 'LIVE' ? 'bg-emerald-100 text-emerald-700' : payConfig?.sandboxAllowed ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}>{payMode === 'LIVE' ? 'دفع حقيقي' : payConfig?.sandboxAllowed ? 'تجريبي' : 'غير مفعل'}</Badge></DialogTitle>
            <DialogDescription>{payTarget?.description} — المبلغ <strong className="text-[#a8841a]">{payTarget?.amount}$</strong></DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>اختر بوابة الدفع</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(payConfig?.methods?.length ? payConfig.methods : [{ id: 'DIRECT_PAYMENT', label: 'دفع مباشر — تواصل مع الإدارة', enabled: true, configured: true, kind: 'manual' as const }]).map((m) => <SelectItem key={m.id} value={m.id}>{m.label}{m.enabled ? '' : ' — غير مفعلة'}</SelectItem>)}
                </SelectContent>
              </Select>
              {payConfig?.methods?.find((m) => m.id === method && !m.enabled)?.reason && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[10px] font-bold text-amber-700">{payConfig.methods.find((m) => m.id === method)?.reason}</p>}
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-500"><Info className="mb-1 h-3.5 w-3.5 text-[#c9a227]" /> الدفع المباشر لا يخصم تلقائياً؛ تؤكد الإدارة السداد بعد استلام المبلغ.</div>
            <Button onClick={pay} disabled={paying} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">{paying ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Landmark className="ml-2 h-4 w-4" />}{method === 'DIRECT_PAYMENT' ? 'اختيار الدفع المباشر وإبلاغ الإدارة' : `ادفع ${payTarget?.amount}$ الآن`}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!receipt} onOpenChange={(v) => !v && setReceipt(null)}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader><DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]"><ReceiptText className="h-5 w-5 text-emerald-600" /> إيصال دفع</DialogTitle></DialogHeader>
          {receipt && <div className="space-y-3 rounded-xl border border-emerald-100 bg-emerald-50/40 p-4 text-sm"><div className="flex items-center justify-between"><span className="font-bold text-slate-500">رقم الإيصال</span><span className="font-mono font-black text-[#0f2b46]" dir="ltr">{receipt.payment.receiptNo}</span></div><div className="flex items-center justify-between"><span className="font-bold text-slate-500">الفاتورة</span><span dir="ltr">{receipt.payment.invoiceNo}</span></div><div className="flex items-center justify-between"><span className="font-bold text-slate-500">المبلغ</span><span className="font-black text-emerald-700"><Money value={receipt.payment.amount} /></span></div><Button onClick={() => window.print()} variant="outline" className="w-full border-emerald-200 font-bold text-emerald-700"><Printer className="ml-1.5 h-4 w-4" /> طباعة الإيصال</Button></div>}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function ThesisTab() {
  return (
    <Card className="border-[#0f2b46]/10 bg-white">
      <CardContent className="p-6 text-center">
        <FileText className="mx-auto h-8 w-8 text-[#c9a227]" />
        <h3 className="mt-3 text-lg font-black text-[#0f2b46]">بحث التخرج والمناقشة</h3>
        <p className="mt-2 text-sm font-bold leading-7 text-slate-500">تظهر تفاصيل البحث والمناقشة بعد اعتماد مسارك الأكاديمي من الإدارة واستكمال شروط البرنامج.</p>
      </CardContent>
    </Card>
  )
}

export function CertificatesTab() {
  const [certs, setCerts] = useState<CertificateData[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<CertificateData | null>(null)
  useEffect(() => {
    api<{ certificates: CertificateData[] }>('/api/certificates').then((d) => setCerts(Array.isArray(d.certificates) ? d.certificates : [])).catch(() => setCerts([])).finally(() => setLoading(false))
  }, [])
  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
  return (
    <div className="space-y-3">
      {certs.length === 0 ? <Card className="border-[#0f2b46]/10"><CardContent className="p-8 text-center text-sm text-slate-400">لا توجد شهادات صادرة بعد</CardContent></Card> : certs.map((c: any) => <Card key={c.id || c.serial} className="border-[#0f2b46]/10"><CardContent className="flex flex-wrap items-center justify-between gap-3 p-4"><div><p className="font-black text-[#0f2b46]">{c.title || c.programTitle || 'شهادة'}</p><p className="text-xs text-slate-500" dir="ltr">{c.serial}</p></div><Button size="sm" variant="outline" onClick={() => setSelected(c)} className="font-bold"><Award className="ml-1 h-4 w-4" /> عرض</Button></CardContent></Card>)}
      <CertificateDialog certificate={selected} open={!!selected} onClose={() => setSelected(null)} />
    </div>
  )
}

interface TranscriptGradeComponent {
  key: string
  label: string
  weight: number
  score: number | null
  weighted: number
  ready: boolean
}

interface TranscriptData {
  student?: { name?: string; email?: string; reference?: string | null }
  programs?: Array<any & { gradebook?: { score: number | null; components: TranscriptGradeComponent[]; missing: string[] } | null }>
  summary?: { programsCount?: number; averageScore?: number | null; passedExams?: number; totalExams?: number }
}

export function TranscriptTab() {
  const [data, setData] = useState<TranscriptData | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api<TranscriptData>('/api/transcript').then((d) => setData(d)).catch(() => setData(null)).finally(() => setLoading(false))
  }, [])
  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
  return (
    <Card className="border-[#0f2b46]/10 bg-white">
      <CardContent className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
          <div>
            <h3 className="text-lg font-black text-[#0f2b46]">السجل الأكاديمي</h3>
            <p className="text-xs text-slate-500">{data?.student?.name || 'الطالب'}{data?.student?.reference ? ` — ${data.student.reference}` : ''}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge className="bg-[#f7edd0] text-[#0f2b46] hover:bg-[#f7edd0]">{data?.summary?.programsCount || data?.programs?.length || 0} برنامج</Badge>
            <ScrollText className="h-7 w-7 text-[#c9a227]" />
          </div>
        </div>
        {!data?.programs?.length ? (
          <p className="p-8 text-center text-sm text-slate-400">لا توجد برامج مكتملة في السجل بعد</p>
        ) : (
          <div className="mt-4 grid gap-4">
            {data.programs.map((p, i) => {
              const gradebook = p.gradebook
              return (
                <div key={p.enrollmentId || p.id || i} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-black text-[#0f2b46]">{p.title || p.programTitle || 'برنامج'}</p>
                      <p className="mt-1 text-[11px] font-bold text-slate-500">الحالة: {p.status || '—'}{p.certificateNo ? ` — شهادة ${p.certificateNo}` : ''}</p>
                    </div>
                    <Badge className={gradebook?.score != null ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>
                      الدرجة النهائية: {gradebook?.score != null ? `${gradebook.score}%` : p.finalScore != null ? `${p.finalScore}%` : 'قيد الاكتمال'}
                    </Badge>
                  </div>
                  {gradebook?.components?.length ? (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {gradebook.components.map((c) => (
                        <div key={c.key} className="rounded-xl bg-white p-3 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <p className="font-black text-[#0f2b46]">{c.label}</p>
                            <span className="font-black text-[#a8841a]">{c.weight}%</span>
                          </div>
                          <p className="mt-1 font-bold text-slate-500">الدرجة: {c.score != null ? `${c.score}%` : 'غير مكتملة'} — المحتسب: {c.ready ? `${c.weighted}%` : '—'}</p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {gradebook?.missing?.length ? (
                    <div className="mt-3 rounded-xl border border-amber-100 bg-amber-50 p-3 text-xs font-bold leading-6 text-amber-800">
                      عناصر لم تكتمل بعد: {gradebook.missing.join('، ')}
                    </div>
                  ) : null}
                  {!!p.rows?.length && (
                    <div className="mt-3 rounded-xl bg-white p-3">
                      <p className="mb-2 text-[11px] font-black text-slate-500">تفاصيل التقييمات المسجلة</p>
                      <div className="grid gap-1 text-[11px] font-bold text-slate-500">
                        {p.rows.slice(0, 8).map((r: any, idx: number) => (
                          <div key={`${r.kind}-${idx}`} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1.5">
                            <span>{r.title}</span>
                            <span className={r.passed ? 'text-emerald-700' : 'text-slate-400'}>{r.bestScore != null ? `${r.bestScore}%` : '—'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
