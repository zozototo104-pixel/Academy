'use client'

import { useEffect, useState } from 'react'
import { api, useAppStore } from '@/lib/store'
import { buildAcademicProgramProfile } from '@/lib/program-tracks'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { CertificateDialog, CertificateData } from '@/components/aact/CertificateDialog'
import { DefenseRoom } from '@/components/aact/DefenseRoom'
import { AcademyLogo } from '@/components/aact/Shell'
import {
  Banknote, Loader2, ReceiptText, Wallet, CheckCircle2, Clock3, Landmark,
  FileText, Hourglass, CalendarClock, Award, Gavel, Users2, Info, CreditCard, Printer,
  GraduationCap, ScrollText, Trophy, BookOpen, ClipboardCheck,
} from 'lucide-react'

// ============ تبويب الدفعات والفواتير ============

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
}

const PURPOSE_LABEL: Record<string, string> = {
  APPLICATION_FEE: 'رسوم تقديم وحجز مقعد',
  TUITION: 'الرسوم الدراسية الكاملة',
  ACCREDITATION_APP: 'رسوم تقديم اعتماد',
  ACCREDITATION_FEE: 'رسوم تقديم اعتماد (100$)',
  ACCREDITATION: 'رسوم اعتماد',
  OTHER: 'رسوم أخرى',
}

const METHOD_LABEL: Record<string, string> = {
  PAYMOB: 'Paymob (فوري/بطاقة)',
  FAWRY: 'فوري',
  STRIPE: 'Stripe (بطاقة دولية)',
  PAYPAL: 'PayPal',
  BANK_TRANSFER: 'تحويل بنكي',
}

export function PaymentsTab() {
  const { toast } = useToast()
  const [payments, setPayments] = useState<Payment[]>([])
  const [loading, setLoading] = useState(true)
  const [payTarget, setPayTarget] = useState<Payment | null>(null)
  const [method, setMethod] = useState('PAYMOB')
  const [paying, setPaying] = useState(false)
  const [receipt, setReceipt] = useState<{ payment: Payment } | null>(null)
  const [payMode, setPayMode] = useState<'SANDBOX' | 'LIVE'>('SANDBOX')

  const load = () => {
    api<{ payments: Payment[] }>('/api/payments')
      .then((d) => setPayments(d.payments))
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    load()
    // جلب وضع الدفع الحالي (SANDBOX/LIVE) لتوجيه الطالب للبوابة المناسبة
    api<{ mode: 'SANDBOX' | 'LIVE' }>('/api/payments/config')
      .then((d) => setPayMode(d.mode || 'SANDBOX'))
      .catch(() => {})
    // العودة من بوابة الدفع الحقيقية (Stripe/PayPal): تحقق خادمي من المزود ثم اعتماد — لا ثقة بالمتصفح
    const q = new URLSearchParams(window.location.search)
    const paid = q.get('paid')
    if (paid) {
      api<{ ok: boolean; status: string; receiptNo?: string; note?: string }>(
        `/api/payments/verify-session?invoiceNo=${encodeURIComponent(paid)}`
      )
        .then((d) => {
          if (d.status === 'PAID') {
            toast({ title: 'تم تأكيد الدفع', description: `سُددت الفاتورة ${paid} بنجاح — الإيصال ${d.receiptNo || ''} متاح الآن` })
          } else if (d.note === 'NO_PROVIDER_SESSION') {
            toast({ title: 'الفاتورة بانتظار السداد', description: 'أكمل السداد من زر «ادفع الآن» أو أبلغ الإدارة بالتحويل' })
          } else {
            toast({ title: 'لم يُؤكد المزود السداد بعد', description: d.note || 'إن أكملت الدفع فسيُعتمد تلقائياً خلال دقائق' })
          }
          load()
        })
        .catch(() => {})
      window.history.replaceState({}, '', '/?view=dashboard')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pay = async () => {
    if (!payTarget) return
    setPaying(true)
    try {
      // 1) إنشاء جلسة دفع لدى المزود — يُعيد رابط دفع حقيقي عند تهيئة المفاتيح (وضع LIVE)
      const co = await api<{ mode: 'SANDBOX' | 'LIVE'; redirectUrl: string | null; provider: string }>('/api/payments/checkout', {
        method: 'POST',
        body: JSON.stringify({ invoiceNo: payTarget.invoiceNo, method }),
      }).catch(() => null)
      if (co?.redirectUrl) {
        // دفع حقيقي: تحويل الطالب لصفحة الدفع الرسمية لدى Stripe/PayPal
        window.location.href = co.redirectUrl
        return
      }
      // 2) SANDBOX أو طرق المراجعة اليدوية: تأكيد آمن داخل المنصة مع إيصال فوري
      const d = await api<{ payment: Payment; receiptNo: string }>('/api/payments', {
        method: 'POST',
        body: JSON.stringify({ invoiceNo: payTarget.invoiceNo, method }),
      })
      setPayTarget(null)
      setReceipt({ payment: { ...payTarget, status: 'PAID', receiptNo: d.receiptNo, method, paidAt: new Date().toISOString() } })
      load()
    } catch (e: any) {
      toast({ title: 'خطأ في الدفع', description: e.message, variant: 'destructive' })
    } finally {
      setPaying(false)
    }
  }

  if (loading) {
    return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
  }

  const totalDue = payments.filter((p) => p.status === 'UNPAID').reduce((s, p) => s + p.amount, 0)

  return (
    <div className="space-y-4">
      {/* ملخص */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card className="border-[#0f2b46]/10">
          <CardContent className="flex items-center gap-3 p-4">
            <span className="rounded-xl bg-amber-100 p-2.5 text-amber-600"><Clock3 className="h-5 w-5" /></span>
            <div>
              <p className="text-lg font-black text-[#0f2b46]">{totalDue}$</p>
              <p className="text-[10px] font-bold text-slate-500">مستحق السداد</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#0f2b46]/10">
          <CardContent className="flex items-center gap-3 p-4">
            <span className="rounded-xl bg-emerald-100 p-2.5 text-emerald-600"><Wallet className="h-5 w-5" /></span>
            <div>
              <p className="text-lg font-black text-[#0f2b46]">{payments.filter((p) => p.status === 'PAID').reduce((s, p) => s + p.amount, 0)}$</p>
              <p className="text-[10px] font-bold text-slate-500">إجمالي المسدد</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#0f2b46]/10">
          <CardContent className="flex items-center gap-3 p-4">
            <span className="rounded-xl bg-[#f7edd0] p-2.5 text-[#a8841a]"><ReceiptText className="h-5 w-5" /></span>
            <div>
              <p className="text-lg font-black text-[#0f2b46]">{payments.length}</p>
              <p className="text-[10px] font-bold text-slate-500">عدد الفواتير</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {payments.length === 0 ? (
        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-10 text-center text-sm text-slate-400">
            لا توجد فواتير بعد — تُصدر فاتورة رسوم التقديم (30$) وفاتورة الرسوم الدراسية بعد اعتماد طلب الالتحاق من الإدارة
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {payments.map((p) => (
            <Card key={p.id} className={`border ${p.status === 'PAID' ? 'border-emerald-100 bg-emerald-50/30' : 'border-amber-200 bg-amber-50/30'}`}>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-md bg-[#0f2b46] px-2 py-0.5 font-mono text-[10px] font-bold text-[#e0b83a]" dir="ltr">{p.invoiceNo}</span>
                    <h4 className="text-sm font-black text-[#0f2b46]">{p.description}</h4>
                    {p.status === 'PAID' ? (
                      <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><CheckCircle2 className="ml-1 h-3 w-3" /> مسددة</Badge>
                    ) : (
                      <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100"><Clock3 className="ml-1 h-3 w-3" /> بانتظار السداد</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {PURPOSE_LABEL[p.purpose] || p.purpose}
                    {p.reference ? ` — طلب ${p.reference}` : ''}
                    {p.method ? ` — عبر ${METHOD_LABEL[p.method] || p.method}` : ''}
                    {p.receiptNo ? ` — إيصال ${p.receiptNo}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-lg font-black text-[#0f2b46]">{p.amount}$</span>
                  {p.status === 'UNPAID' && (
                    <Button size="sm" onClick={() => setPayTarget(p)} className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                      <CreditCard className="ml-1 h-3.5 w-3.5" /> ادفع الآن
                    </Button>
                  )}
                  {p.status === 'PAID' && (
                    <Button size="sm" variant="outline" onClick={() => setReceipt({ payment: p })} className="border-emerald-200 font-bold text-emerald-700">
                      <ReceiptText className="ml-1 h-3.5 w-3.5" /> الإيصال
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* نافذة الدفع — بوابات متعددة */}
      <Dialog open={!!payTarget} onOpenChange={(v) => !v && setPayTarget(null)}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between gap-2 font-black text-[#0f2b46]">
              <span className="flex items-center gap-2">
                <Banknote className="h-5 w-5 text-[#c9a227]" /> إتمام الدفع الإلكتروني
              </span>
              <Badge className={payMode === 'LIVE' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
                {payMode === 'LIVE' ? 'دفع حقيقي عبر البوابة' : 'وضع تجريبي آمن'}
              </Badge>
            </DialogTitle>
            <DialogDescription>
              {payTarget?.description} — المبلغ <strong className="text-[#a8841a]">{payTarget?.amount}$</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>اختر بوابة الدفع</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PAYMOB">Paymob — بطاقة / محافظ مصر</SelectItem>
                  <SelectItem value="FAWRY">فوري Fawry — مراكز الدفع</SelectItem>
                  <SelectItem value="STRIPE">Stripe — بطاقة دولية</SelectItem>
                  <SelectItem value="PAYPAL">PayPal — للوكلاء والمتدربين خارج مصر</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-500">
              <Info className="mb-1 h-3.5 w-3.5 text-[#c9a227]" />
              {payMode === 'LIVE'
                ? 'الوضع الحقيقي مفعّل: اختيار Stripe أو PayPal يحوّلك لصفحة الدفع الرسمية ويُعتمد السداد تلقائياً بعد إتمامه. طرق فوري/التحويل البنكي تُراجع من الإدارة.'
                : 'وضع المحاكاة الآمنة: يُصدر إيصالاً فورياً ويربطه بحالة طلبك تلقائياً. عند إدخال الإدارة مفاتيح Stripe/PayPal من تبويب «البريد والدفع» يتحول الدفع تلقائياً للبوابات الرسمية.'}
            </div>
            <Button onClick={pay} disabled={paying} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
              {paying ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Landmark className="ml-2 h-4 w-4" />}
              ادفع {payTarget?.amount}$ الآن
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* نافذة الإيصال */}
      <Dialog open={!!receipt} onOpenChange={(v) => !v && setReceipt(null)}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
              <ReceiptText className="h-5 w-5 text-emerald-600" /> إيصال دفع إلكتروني
            </DialogTitle>
          </DialogHeader>
          {receipt && (
            <div id="aact-receipt" className="space-y-3 rounded-xl border border-emerald-100 bg-emerald-50/40 p-4 text-sm">
              <div className="flex items-center justify-between border-b border-emerald-100 pb-2">
                <span className="font-bold text-slate-500">رقم الإيصال</span>
                <span className="font-mono font-black text-[#0f2b46]" dir="ltr">{receipt.payment.receiptNo}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-500">الفاتورة</span>
                <span className="font-mono text-[#0f2b46]" dir="ltr">{receipt.payment.invoiceNo}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-500">الوصف</span>
                <span className="font-bold text-[#0f2b46]">{receipt.payment.description}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-500">المبلغ</span>
                <span className="text-lg font-black text-emerald-700">{receipt.payment.amount}$</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-500">طريقة الدفع</span>
                <span className="font-bold text-[#0f2b46]">{METHOD_LABEL[receipt.payment.method || ''] || receipt.payment.method}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-500">التاريخ</span>
                <span className="font-bold text-[#0f2b46]">
                  {new Date(receipt.payment.paidAt || Date.now()).toLocaleDateString('ar-EG')}
                </span>
              </div>
              <Button onClick={() => window.print()} variant="outline" className="w-full border-emerald-200 font-bold text-emerald-700">
                <Printer className="ml-1.5 h-4 w-4" /> طباعة الإيصال
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ============ تبويب بحث التخرج ============

/** العد التنازلي الحي لموعد المناقشة — يتحول لـ«القاعة مفتوحة الآن» قبل الموعد بـ15 دقيقة */
function DefenseCountdown({ defenseDate }: { defenseDate: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20000)
    return () => clearInterval(t)
  }, [])
  const target = new Date(defenseDate).getTime()
  const diff = target - now
  if (diff <= -24 * 3600_000) return null // انقضى الموعد منذ أكثر من يوم
  if (diff <= 15 * 60_000) {
    return (
      <p className="mt-2.5 flex w-fit animate-pulse items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-[11px] font-black text-white">
        <Clock3 className="h-3.5 w-3.5" /> القاعة مفتوحة الآن — يمكنك الانضمام للمناقشة فوراً
      </p>
    )
  }
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const mins = Math.floor((diff % 3600000) / 60000)
  return (
    <p className="mt-2.5 flex w-fit items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[11px] font-black text-[#0f2b46]">
      <Hourglass className="h-3.5 w-3.5 text-[#a8841a]" />
      تنطلق مناقشتك خلال:
      <span className="text-[#a8841a]">
        {days > 0 ? `${days} يوم و` : ''}{hours} ساعة و{mins} دقيقة
      </span>
    </p>
  )
}

interface ThesisReviewNoteItem {
  id: string
  stage: string
  action: string
  note: string
  authorName?: string | null
  createdAt: string
}

interface ThesisData {
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
  resultScore?: number | null
  passed?: boolean | null
}

interface AdmissionData {
  id: string
  reference: string
  program: string
  status: string
  approvedAt?: string | null
  thesisDeadline?: string | null
  supervisorName?: string | null
}

interface ThesisTopicItem {
  id: string
  title: string
  description?: string | null
  objectives?: string | null
  methodology?: string | null
  keywords?: string | null
  source?: string | null
}

interface ThesisTopicRequestItem {
  id: string
  topicId?: string | null
  proposedTitle: string
  rationale?: string | null
  status: string
  adminNote?: string | null
  createdAt: string
  topic?: { title: string } | null
}

interface ThesisPlanData {
  id: string
  title: string
  overview: string
  objectives: string[]
  sections: { title?: string; summary?: string; outcomes?: string[]; sourceTitles?: string[] }[]
  activities: string[]
  discussionQuestions: string[]
  updatedAt: string
}

export function ThesisTab() {
  const { toast } = useToast()
  const { navigate } = useAppStore()
  const [loading, setLoading] = useState(true)
  const [thesis, setThesis] = useState<ThesisData | null>(null)
  const [admission, setAdmission] = useState<AdmissionData | null>(null)
  const [thesisPlan, setThesisPlan] = useState<ThesisPlanData | null>(null)
  const [examsGate, setExamsGate] = useState<{ required: number; passed: number; complete: boolean; hasAnyExam: boolean; missing: { kind: string; title: string }[] } | null>(null)
  const [form, setForm] = useState({ title: '', abstract: '', fileNote: '' })
  const [thesisStage, setThesisStage] = useState<'PLAN' | 'FINAL'>('PLAN')
  const [saving, setSaving] = useState(false)
  const [topicProgramId, setTopicProgramId] = useState('')
  const [topics, setTopics] = useState<ThesisTopicItem[]>([])
  const [topicRequests, setTopicRequests] = useState<ThesisTopicRequestItem[]>([])
  const [selectedTopicId, setSelectedTopicId] = useState('')
  const [customTopicTitle, setCustomTopicTitle] = useState('')
  const [topicRationale, setTopicRationale] = useState('')
  const [topicLoading, setTopicLoading] = useState(false)
  const [topicSaving, setTopicSaving] = useState(false)

  const loadTopics = (programId?: string) => {
    const id = programId || topicProgramId
    setTopicLoading(true)
    api<{ programId: string; topics: ThesisTopicItem[]; requests: ThesisTopicRequestItem[] }>(id ? `/api/thesis/topics?programId=${encodeURIComponent(id)}` : '/api/thesis/topics')
      .then((d) => {
        setTopicProgramId(d.programId || id)
        setTopics(d.topics || [])
        setTopicRequests(d.requests || [])
      })
      .catch(() => {})
      .finally(() => setTopicLoading(false))
  }

  const load = () => {
    api<{ thesis: ThesisData | null; admission: AdmissionData | null; thesisPlan?: ThesisPlanData | null; examsGate?: any }>('/api/thesis')
      .then((d) => {
        setThesis(d.thesis)
        setAdmission(d.admission)
        setThesisPlan(d.thesisPlan || null)
        setExamsGate(d.examsGate || null)
        if (d.thesis) {
          setForm({ title: d.thesis.title, abstract: d.thesis.abstract, fileNote: '' })
          setThesisStage(['PLAN_APPROVED', 'FINAL_NEEDS_REVISION'].includes(d.thesis.status) ? 'FINAL' : 'PLAN')
        } else {
          setThesisStage('PLAN')
        }
        if (d.admission?.id) loadTopics()
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  // إعادة تحميل بيانات البحث بعد انتهاء جلسة المناقشة
  const refreshThesis = () => {
    api<{ thesis: ThesisData | null; admission: AdmissionData | null }>('/api/thesis')
      .then((d) => setThesis(d.thesis))
      .catch(() => {})
  }

  const submitTopicRequest = async () => {
    if (!topicProgramId) return toast({ title: 'اختر البرنامج', description: 'لم يتم العثور على برنامج مرتبط بحسابك بعد', variant: 'destructive' })
    if (!selectedTopicId && !customTopicTitle.trim()) return toast({ title: 'عنوان البحث مطلوب', description: 'اختر عنوانًا من القائمة أو اقترح عنوانًا جديدًا', variant: 'destructive' })
    setTopicSaving(true)
    try {
      await api('/api/thesis/topics', {
        method: 'POST',
        body: JSON.stringify({
          programId: topicProgramId,
          topicId: selectedTopicId || null,
          proposedTitle: customTopicTitle,
          rationale: topicRationale,
        }),
      })
      toast({ title: 'تم إرسال العنوان', description: 'سيظهر للإدارة/المشرف لاعتماده قبل بدء البحث' })
      setSelectedTopicId('')
      setCustomTopicTitle('')
      setTopicRationale('')
      loadTopics(topicProgramId)
    } catch (e: any) {
      toast({ title: 'تعذر إرسال العنوان', description: e.message, variant: 'destructive' })
    } finally {
      setTopicSaving(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await api('/api/thesis', { method: 'POST', body: JSON.stringify({ ...form, stage: thesisStage }) })
      toast({ title: 'تم التسليم', description: thesisStage === 'PLAN' ? 'وصلت خطة البحث — سيتم مراجعتها واعتمادها قبل البحث النهائي' : 'وصل البحث النهائي — سيتم جدولة المناقشة وإبلاغك' })
      load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
  }

  // العدّاد الزمني: 3-6 أشهر من تاريخ القبول
  const deadline = admission?.thesisDeadline ? new Date(admission.thesisDeadline) : null
  const now = new Date()
  const daysLeft = deadline ? Math.ceil((deadline.getTime() - now.getTime()) / 86400000) : null
  const totalDays = admission?.approvedAt && deadline
    ? Math.ceil((deadline.getTime() - new Date(admission.approvedAt).getTime()) / 86400000)
    : null
  const elapsed = totalDays && daysLeft !== null ? totalDays - daysLeft : null
  const overdue = daysLeft !== null && daysLeft < 0

  const committee: string[] = (() => {
    try { return JSON.parse(thesis?.committee || '[]') } catch { return [] }
  })()

  const THESIS_STATUS: Record<string, { label: string; cls: string }> = {
    PLAN_SUBMITTED: { label: 'خطة البحث قيد المراجعة', cls: 'bg-amber-100 text-amber-700' },
    PLAN_NEEDS_REVISION: { label: 'خطة البحث تحتاج تعديلًا', cls: 'bg-red-100 text-red-600' },
    PLAN_APPROVED: { label: 'خطة البحث معتمدة', cls: 'bg-emerald-100 text-emerald-700' },
    FINAL_NEEDS_REVISION: { label: 'البحث النهائي يحتاج تعديلًا', cls: 'bg-red-100 text-red-600' },
    SUBMITTED: { label: 'البحث النهائي قيد المراجعة', cls: 'bg-amber-100 text-amber-700' },
    SCHEDULED: { label: 'مجدول للمناقشة', cls: 'bg-blue-100 text-blue-700' },
    RESULT_APPROVED: { label: 'تم اعتماد النتيجة', cls: 'bg-emerald-100 text-emerald-700' },
    NEEDS_REVISION: { label: 'يحتاج تعديلات', cls: 'bg-red-100 text-red-600' },
  }

  const thesisStatusMeta: { label: string; cls: string } | undefined = thesis ? THESIS_STATUS[thesis.status] : undefined
  const approvedTopic = topicRequests.some((r) => r.status === 'APPROVED')
  const topicPending = topicRequests.some((r) => r.status === 'PENDING' || r.status === 'NEEDS_REVISION')
  const thesisStatus = thesis?.status || ''
  const thesisSteps = [
    { key: 'topic', title: 'اختيار العنوان', done: approvedTopic, active: !approvedTopic, note: approvedTopic ? 'عنوان البحث معتمد' : topicPending ? 'العنوان قيد المراجعة/التعديل' : 'اختر عنوانًا أو اقترح عنوانًا' },
    { key: 'plan', title: 'تسليم الخطة', done: ['PLAN_SUBMITTED', 'PLAN_APPROVED', 'FINAL_NEEDS_REVISION', 'SUBMITTED', 'SCHEDULED', 'RESULT_APPROVED'].includes(thesisStatus), active: approvedTopic && (!thesis || ['PLAN_NEEDS_REVISION', 'NEEDS_REVISION'].includes(thesisStatus)), note: thesisStatus === 'PLAN_SUBMITTED' ? 'الخطة قيد المراجعة' : ['PLAN_NEEDS_REVISION', 'NEEDS_REVISION'].includes(thesisStatus) ? 'تحتاج تعديلًا' : 'سلم خطة البحث أولًا' },
    { key: 'plan-approved', title: 'اعتماد الخطة', done: ['PLAN_APPROVED', 'FINAL_NEEDS_REVISION', 'SUBMITTED', 'SCHEDULED', 'RESULT_APPROVED'].includes(thesisStatus), active: thesisStatus === 'PLAN_SUBMITTED', note: thesisStatus === 'PLAN_APPROVED' ? 'الخطة معتمدة' : 'بانتظار قرار الإدارة/المشرف' },
    { key: 'final', title: 'البحث النهائي', done: ['SUBMITTED', 'SCHEDULED', 'RESULT_APPROVED'].includes(thesisStatus), active: ['PLAN_APPROVED', 'FINAL_NEEDS_REVISION'].includes(thesisStatus), note: thesisStatus === 'FINAL_NEEDS_REVISION' ? 'يحتاج تعديلًا' : thesisStatus === 'SUBMITTED' ? 'قيد المراجعة النهائية' : 'يفتح بعد اعتماد الخطة' },
    { key: 'defense', title: 'المناقشة', done: ['SCHEDULED', 'RESULT_APPROVED'].includes(thesisStatus), active: thesisStatus === 'SUBMITTED', note: thesisStatus === 'SCHEDULED' ? 'تم تحديد موعد المناقشة' : 'تُجدول بعد مراجعة البحث النهائي' },
    { key: 'result', title: 'النتيجة', done: thesisStatus === 'RESULT_APPROVED', active: thesisStatus === 'SCHEDULED', note: thesisStatus === 'RESULT_APPROVED' ? 'تم اعتماد النتيجة' : 'تظهر بعد المناقشة' },
  ]
  const thesisRequiredAction = !approvedTopic
    ? { title: 'اختر أو اقترح عنوان بحث', body: topicPending ? 'عنوانك قيد المراجعة أو يحتاج تعديلًا. تابع حالة الطلب أدناه.' : 'ابدأ باختيار عنوان معتمد أو اقترح عنوانًا مناسبًا لتخصصك.' }
    : !thesis
      ? { title: 'سلّم خطة البحث', body: 'بعد اعتماد العنوان، الخطوة التالية هي تسليم خطة البحث للمراجعة.' }
      : thesisStatus === 'PLAN_NEEDS_REVISION' || thesisStatus === 'NEEDS_REVISION'
        ? { title: 'عدّل خطة البحث', body: thesis.reviewNote || 'راجع ملاحظات الإدارة/المشرف ثم أعد تسليم الخطة.' }
        : thesisStatus === 'PLAN_SUBMITTED'
          ? { title: 'انتظر اعتماد الخطة', body: 'الخطة وصلت للإدارة/المشرف وهي قيد المراجعة.' }
          : thesisStatus === 'PLAN_APPROVED'
            ? { title: 'سلّم البحث النهائي', body: 'تم اعتماد الخطة. ابدأ بتسليم البحث النهائي وفق الخطة المنشورة.' }
            : thesisStatus === 'FINAL_NEEDS_REVISION'
              ? { title: 'عدّل البحث النهائي', body: thesis.reviewNote || 'راجع الملاحظة وأعد تسليم البحث النهائي قبل المناقشة.' }
              : thesisStatus === 'SUBMITTED'
                ? { title: 'انتظر جدولة المناقشة', body: 'البحث النهائي قيد المراجعة، وستظهر لك المناقشة عند جدولتها.' }
                : thesisStatus === 'SCHEDULED'
                  ? { title: 'استعد للمناقشة', body: thesis.defenseDate ? `موعد المناقشة: ${new Date(thesis.defenseDate).toLocaleString('ar-EG')}` : 'المناقشة مجدولة. راجع تعليمات اللجنة.' }
                  : { title: 'نتيجتك معتمدة', body: 'تابع الشهادة والسجل الأكاديمي بعد اعتماد النتيجة.' }

  return (
    <div className="space-y-4">
      {/* العدّاد والمهلة */}
      <Card className={`border ${overdue ? 'border-red-200 bg-red-50/40' : 'border-[#c9a227]/40 bg-[#f7edd0]/40'}`}>
        <CardContent className="p-5">
          <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
            <Hourglass className="h-5 w-5 text-[#a8841a]" /> مهلة بحث التخرج (3-6 أشهر من القبول)
          </h3>
          {admission?.approvedAt ? (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs font-bold text-slate-600">
                <span>تاريخ القبول: {new Date(admission.approvedAt).toLocaleDateString('ar-EG')}</span>
                <span>•</span>
                <span>الموعد النهائي: {deadline?.toLocaleDateString('ar-EG')}</span>
              </div>
              {daysLeft !== null && (
                <>
                  <div className="mt-2">
                    <Progress value={Math.max(0, Math.min(100, ((elapsed || 0) / totalDays!) * 100))} className="h-2.5 bg-white" />
                  </div>
                  <p className={`mt-2 text-sm font-black ${overdue ? 'text-red-600' : daysLeft < 30 ? 'text-amber-600' : 'text-emerald-700'}`}>
                    {overdue
                      ? `تنبيه: تجاوزت المهلة بـ ${Math.abs(daysLeft)} يوماً — أسرع بالتسليم ومراجعة مشرفك!`
                      : `متبقٍ ${daysLeft} يوماً على الموعد النهائي`}
                  </p>
                </>
              )}
            </>
          ) : (
            <p className="mt-2 text-xs font-bold text-slate-500">
              يبدأ العدّاد تلقائياً من تاريخ اعتماد طلب التحاق — {admission ? `طلبك (${admission.reference}) لم يُعتمد بعد` : 'لا يوجد طلب التحاق مرتبط بحسابك بعد'}
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="border-[#c9a227]/40 bg-[#fffaf0]">
        <CardContent className="p-5">
          <p className="text-[11px] font-black text-[#a8841a]">الإجراء المطلوب الآن</p>
          <h3 className="mt-1 text-lg font-black text-[#0f2b46]">{thesisRequiredAction.title}</h3>
          <p className="mt-1 text-xs font-bold leading-7 text-slate-600">{thesisRequiredAction.body}</p>
        </CardContent>
      </Card>

      {/* المشرف */}
      {admission?.supervisorName && (
        <div className="flex items-center gap-3 rounded-2xl border border-[#0f2b46]/10 bg-white p-4">
          <span className="rounded-xl bg-[#0f2b46] p-2.5 text-[#e0b83a]"><Users2 className="h-5 w-5" /></span>
          <div className="flex-1">
            <p className="text-sm font-black text-[#0f2b46]">مشرفك الأكاديمي: {admission.supervisorName}</p>
            <p className="text-[11px] text-slate-500">راجعه في خطة البحث — ولأي استفسار فوري استخدم المشرف الذكي 24/7</p>
          </div>
        </div>
      )}

      <Card className="border-[#c9a227]/30 bg-[#fffaf0]">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                <CheckCircle2 className="h-5 w-5 text-[#a8841a]" /> رحلة بحث التخرج
              </h3>
              <p className="mt-1 text-xs font-bold leading-6 text-slate-600">تابع مكانك الحالي من اختيار العنوان حتى اعتماد النتيجة.</p>
            </div>
            {thesis ? <Badge className={thesisStatusMeta?.cls}>{thesisStatusMeta?.label || thesis.status}</Badge> : <Badge className="bg-slate-100 text-slate-600 hover:bg-slate-100">لم يبدأ</Badge>}
          </div>
          <div className="mt-4 grid gap-2 md:grid-cols-3 lg:grid-cols-6">
            {thesisSteps.map((step, index) => (
              <div key={step.key} className={`rounded-2xl border p-3 ${step.done ? 'border-emerald-200 bg-emerald-50' : step.active ? 'border-[#c9a227] bg-white' : 'border-slate-100 bg-white/70'}`}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-black ${step.done ? 'bg-emerald-600 text-white' : step.active ? 'bg-[#c9a227] text-white' : 'bg-slate-100 text-slate-400'}`}>{step.done ? '✓' : index + 1}</span>
                  <span className={`text-[10px] font-black ${step.done ? 'text-emerald-700' : step.active ? 'text-[#a8841a]' : 'text-slate-400'}`}>{step.done ? 'مكتملة' : step.active ? 'الحالية' : 'لاحقًا'}</span>
                </div>
                <p className="text-xs font-black text-[#0f2b46]">{step.title}</p>
                <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">{step.note}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* خطة بحث التخرج المنشورة من الإدارة */}
      <Card className="border-[#0f2b46]/10 bg-white">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                <BookOpen className="h-5 w-5 text-[#a8841a]" /> خطة بحث التخرج المطلوبة
              </h3>
              <p className="mt-1 text-xs font-bold leading-6 text-slate-600">
                هذه الخطة توضح ما يجب أن يلتزم به الطالب قبل تسليم البحث النهائي. يتم نشرها من الإدارة ضمن دليل الفصل الثالث/المشروع.
              </p>
            </div>
            {thesisPlan ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">منشورة</Badge> : <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">بانتظار الإدارة</Badge>}
          </div>
          {thesisPlan ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-2xl bg-[#fffaf0] p-4">
                <h4 className="text-sm font-black text-[#0f2b46]">{thesisPlan.title}</h4>
                <p className="mt-2 text-xs font-bold leading-7 text-slate-600">{thesisPlan.overview}</p>
              </div>
              {thesisPlan.objectives?.length ? (
                <div className="rounded-2xl bg-slate-50 p-4">
                  <p className="mb-2 text-xs font-black text-[#0f2b46]">أهداف خطة البحث</p>
                  <ul className="space-y-1 text-xs font-bold leading-6 text-slate-600">
                    {thesisPlan.objectives.slice(0, 6).map((item, i) => <li key={i}>• {item}</li>)}
                  </ul>
                </div>
              ) : null}
              {thesisPlan.sections?.length ? (
                <div className="grid gap-2 md:grid-cols-2">
                  {thesisPlan.sections.slice(0, 6).map((section, i) => (
                    <div key={i} className="rounded-2xl border border-slate-100 bg-white p-3">
                      <p className="text-xs font-black text-[#0f2b46]">{section.title || `مرحلة ${i + 1}`}</p>
                      {section.summary ? <p className="mt-1 text-[11px] font-bold leading-6 text-slate-500">{section.summary}</p> : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {thesisPlan.activities?.length ? (
                <div className="rounded-2xl bg-[#f7edd0]/50 p-4">
                  <p className="mb-2 text-xs font-black text-[#0f2b46]">المطلوب العملي من الطالب</p>
                  <ul className="space-y-1 text-xs font-bold leading-6 text-slate-600">
                    {thesisPlan.activities.slice(0, 5).map((item, i) => <li key={i}>• {item}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-4 rounded-2xl bg-amber-50 p-4 text-xs font-bold leading-6 text-amber-700">
              لم تُنشر خطة بحث تخرج لهذا البرنامج بعد. ستظهر هنا تلقائيًا عندما تنشر الإدارة دليل الفصل الثالث/المشروع.
            </div>
          )}
        </CardContent>
      </Card>

      {/* اختيار واعتماد عنوان بحث التخرج */}
      <Card className="border-[#c9a227]/30 bg-[#fffaf0]">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                <ScrollText className="h-5 w-5 text-[#a8841a]" /> اختيار عنوان بحث التخرج
              </h3>
              <p className="mt-1 text-xs font-bold leading-6 text-slate-600">
                اختر عنوانًا معتمدًا من الإدارة أو اقترح عنوانًا خاصًا بك. لا يبدأ مسار البحث رسميًا إلا بعد اعتماد العنوان.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => loadTopics()} disabled={topicLoading} className="bg-white font-black">
              {topicLoading ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : null}
              تحديث العناوين
            </Button>
          </div>

          {topicRequests.length > 0 && (
            <div className="mt-3 space-y-2">
              {topicRequests.slice(0, 3).map((r) => (
                <div key={r.id} className="rounded-xl border border-white bg-white/80 p-3 text-xs font-bold leading-6 text-slate-600">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-black text-[#0f2b46]">{r.proposedTitle}</span>
                    <Badge className={r.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-700' : r.status === 'REJECTED' ? 'bg-red-100 text-red-600' : r.status === 'NEEDS_REVISION' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}>
                      {r.status === 'APPROVED' ? 'معتمد' : r.status === 'REJECTED' ? 'مرفوض' : r.status === 'NEEDS_REVISION' ? 'يحتاج تعديل' : 'بانتظار الاعتماد'}
                    </Badge>
                  </div>
                  {r.adminNote ? <p className="mt-1 text-[11px] text-slate-500">ملاحظة الإدارة: {r.adminNote}</p> : null}
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl bg-white p-3">
              <Label className="text-xs font-black text-[#0f2b46]">اختر من العناوين المعتمدة</Label>
              <Select value={selectedTopicId} onValueChange={(v) => { setSelectedTopicId(v); setCustomTopicTitle('') }}>
                <SelectTrigger className="mt-2"><SelectValue placeholder={topicLoading ? 'جاري التحميل...' : 'اختر عنوانًا'} /></SelectTrigger>
                <SelectContent>
                  {topics.length ? topics.map((t) => <SelectItem key={t.id} value={t.id}>{t.title}</SelectItem>) : <SelectItem value="none" disabled>لا توجد عناوين معتمدة بعد</SelectItem>}
                </SelectContent>
              </Select>
              {selectedTopicId && topics.find((t) => t.id === selectedTopicId)?.description ? (
                <p className="mt-2 text-[11px] font-bold leading-5 text-slate-500">{topics.find((t) => t.id === selectedTopicId)?.description}</p>
              ) : null}
            </div>
            <div className="rounded-2xl bg-white p-3">
              <Label className="text-xs font-black text-[#0f2b46]">أو اقترح عنوانًا خاصًا بك</Label>
              <Input className="mt-2" value={customTopicTitle} onChange={(e) => { setCustomTopicTitle(e.target.value); setSelectedTopicId('') }} placeholder="اكتب عنوان بحثك المقترح" />
            </div>
          </div>
          <div className="mt-3 rounded-2xl bg-white p-3">
            <Label className="text-xs font-black text-[#0f2b46]">سبب اختيار العنوان / فكرة البحث</Label>
            <Textarea className="mt-2 min-h-20" value={topicRationale} onChange={(e) => setTopicRationale(e.target.value)} placeholder="اكتب لماذا اخترت هذا العنوان وما المشكلة البحثية التي تريد دراستها..." />
          </div>
          <Button onClick={submitTopicRequest} disabled={topicSaving || (!selectedTopicId && !customTopicTitle.trim())} className="mt-3 w-full bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
            {topicSaving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <ScrollText className="ml-2 h-4 w-4" />}
            إرسال العنوان للمراجعة
          </Button>
        </CardContent>
      </Card>

      {/* حالة البحث الحالي */}
      {thesis && (
        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                <FileText className="h-5 w-5 text-[#c9a227]" /> بحثك: {thesis.title}
              </h3>
              <Badge className={THESIS_STATUS[thesis.status]?.cls || 'bg-slate-100 text-slate-600'}>
                {THESIS_STATUS[thesis.status]?.label || thesis.status}
              </Badge>
            </div>
            <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-slate-500">{thesis.abstract}</p>
            {thesis.reviewNote ? (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs font-bold leading-7 text-amber-800">
                <p className="font-black">ملاحظات الإدارة/المشرف</p>
                <p className="mt-1 whitespace-pre-line">{thesis.reviewNote}</p>
              </div>
            ) : null}
            {thesis.reviewNotes?.length ? (
              <div className="mt-3 rounded-xl border border-slate-100 bg-white p-4">
                <p className="text-xs font-black text-[#0f2b46]">سجل ملاحظات البحث</p>
                <div className="mt-2 space-y-2">
                  {thesis.reviewNotes.slice(0, 5).map((note) => (
                    <div key={note.id} className="rounded-lg bg-slate-50 p-3 text-[11px] font-bold leading-6 text-slate-600">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-black text-[#0f2b46]">{note.stage === 'PLAN' ? 'خطة البحث' : note.stage === 'FINAL' ? 'البحث النهائي' : note.stage === 'RESULT' ? 'النتيجة' : 'ملاحظة عامة'}</span>
                        <span className="text-slate-400">{new Date(note.createdAt).toLocaleDateString('ar-EG')}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-line">{note.note}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {thesis.status === 'SCHEDULED' && thesis.defenseDate && (
              <>
                <div className="mt-3 rounded-xl border border-blue-100 bg-blue-50/60 p-4 text-xs font-bold text-blue-700">
                  <p className="flex items-center gap-1.5">
                    <CalendarClock className="h-4 w-4" /> موعد المناقشة: {new Date(thesis.defenseDate).toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                  </p>
                  {committee.length > 0 && (
                    <p className="mt-1.5 flex items-center gap-1.5">
                      <Gavel className="h-4 w-4" /> لجنة المناقشة: {committee.join('، ')}
                      {thesis.agentMember ? ` + عضو الوكيل الدولي (${thesis.agentMember})` : ''}
                    </p>
                  )}
                  <DefenseCountdown defenseDate={thesis.defenseDate} />
                </div>
                {/* قاعة المناقشة عبر الفيديو كونفرنس مع خبير الذكاء الاصطناعي */}
                <div className="mt-3">
                  <DefenseRoom thesis={thesis} onFinished={refreshThesis} />
                </div>
              </>
            )}
            {thesis.status === 'RESULT_APPROVED' && (
              <div className={`mt-3 rounded-xl p-4 text-xs font-bold ${thesis.passed ? 'border border-emerald-200 bg-emerald-50/60 text-emerald-700' : 'border border-red-200 bg-red-50/60 text-red-600'}`}>
                {thesis.passed
                  ? `مبروك! اجتزت المناقشة بدرجة ${thesis.resultScore} — بعد سداد الرسوم الدراسية الكاملة تُصدر شهادتك خلال 30 يوماً كحد أقصى وفق اللوائح.`
                  : `نتيجتك ${thesis.resultScore} — لم تُعتمد. راجع مشرفك لتعديلات البحث ثم أعد التقديم.`}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* نموذج التسليم — مع بوابة الامتحانات: لا بحث قبل إتمام جميع الامتحانات (مسار المنصة الرسمي) */}
      {(!thesis || ['PLAN_APPROVED', 'PLAN_NEEDS_REVISION', 'FINAL_NEEDS_REVISION', 'NEEDS_REVISION'].includes(thesis.status)) && (
        !admission || !['SUPERVISOR_ASSIGNED', 'THESIS', 'SCHEDULED', 'RESULT_APPROVED'].includes(admission.status) ? (
          <Card className="border-slate-200 bg-slate-50/60">
            <CardContent className="p-5 text-center">
              <h3 className="text-sm font-black text-[#0f2b46]">تسليم البحث يُفتح بعد التسجيل النهائي</h3>
              <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-slate-600">
                يجب أولاً: سداد رسوم التقديم ← موافقة الإدارة ← سداد الرسوم الدراسية كاملة (التسجيل النهائي) — عندها تُفتح لك صفحة تسليم البحث ومناقشته عبر غرفة الفيديو كونفرنس.
              </p>
              <Button onClick={() => navigate('dashboard')} className="mt-4 bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
                متابعة مسار تسجيلي
              </Button>
            </CardContent>
          </Card>
        ) : examsGate?.hasAnyExam && !examsGate.complete ? (
          <Card className="border-amber-200 bg-amber-50/50">
            <CardContent className="p-5 text-center">
              <div className="mx-auto mb-3 w-fit rounded-2xl bg-amber-100 p-3">
                <GraduationCap className="h-7 w-7 text-amber-600" />
              </div>
              <h3 className="text-sm font-black text-[#0f2b46]">أنهِ امتحاناتك أولاً — ثم تُفتح لك صفحة البحث</h3>
              <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-slate-600">
                وفق مسار الأكاديمية الرسمي: بعد اجتياز جميع الامتحانات ({examsGate.passed}/{examsGate.required} منجز) تنتقل لمرحلة تسليم بحث التخرج الذي يُناقَش لاحقاً عبر غرفة الفيديو كونفرنس أمام اللجنة ومع الخبير الذكي.
              </p>
              {examsGate.missing.length > 0 && (
                <div className="mx-auto mt-3 max-w-md rounded-xl bg-white p-3 text-right">
                  <p className="text-[11px] font-black text-amber-700">الامتحانات المتبقية عليك:</p>
                  <ul className="mt-1.5 space-y-1">
                    {examsGate.missing.slice(0, 6).map((m, i) => (
                      <li key={i} className="text-[11px] font-bold text-slate-600">• {m.title} {m.kind === 'SEMESTER' ? '(امتحان فصل)' : ''}</li>
                    ))}
                  </ul>
                </div>
              )}
              <Button onClick={() => navigate('dashboard')} className="mt-4 bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
                <GraduationCap className="ml-2 h-4 w-4" /> الذهاب لبوابة الامتحانات
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-[#0f2b46]/15">
            <CardContent className="p-5">
              <h3 className="mb-1 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                <FileText className="h-5 w-5 text-[#c9a227]" /> {!thesis ? 'تسليم خطة بحث التخرج' : ['PLAN_APPROVED', 'FINAL_NEEDS_REVISION'].includes(thesis.status) ? 'تسليم البحث النهائي' : 'تعديل وإعادة تسليم الخطة'}
              </h3>
              <p className="mb-4 text-xs text-slate-500">
                {!thesis || ['PLAN_NEEDS_REVISION', 'NEEDS_REVISION'].includes(thesis.status)
                  ? 'ابدأ بتسليم خطة البحث: العنوان، المشكلة البحثية، المنهجية المتوقعة، والمراجع/الملف إن وجد. بعد اعتماد الخطة ستُفتح مرحلة البحث النهائي.'
                  : 'قدّم البحث النهائي بعد اعتماد الخطة — ستتم جدولة المناقشة أمام لجنة متخصصة بعد المراجعة.'}
              </p>
              <form onSubmit={submit} className="space-y-3">
                <input type="hidden" value={thesisStage} readOnly />
                <div className="rounded-xl bg-[#fffaf0] p-3 text-[11px] font-bold leading-6 text-[#5c4d1a]">
                  المرحلة الحالية: {!thesis || ['PLAN_NEEDS_REVISION', 'NEEDS_REVISION'].includes(thesis.status) ? 'خطة البحث' : 'البحث النهائي'}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="t-title">عنوان البحث *</Label>
                  <Input id="t-title" required value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="مثال: دور التحول الرقمي في تحسين أداء المؤسسات التدريبية" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="t-abs">ملخص البحث * (50 حرفاً على الأقل)</Label>
                  <Textarea id="t-abs" required className="min-h-28" value={form.abstract}
                    onChange={(e) => setForm({ ...form, abstract: e.target.value })}
                    placeholder="ملخص يوضح مشكلة البحث، المنهجية، أهم النتائج والتوصيات..." />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="t-file">رابط/وصف ملف البحث الكامل (اختياري)</Label>
                  <Input id="t-file" value={form.fileNote}
                    onChange={(e) => setForm({ ...form, fileNote: e.target.value })}
                    placeholder="رابط Drive/Dropbox أو وصف الملف المرفوع" />
                </div>
                <Button type="submit" disabled={saving} className="w-full bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
                  {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <FileText className="ml-2 h-4 w-4" />}
                  {thesis ? 'إعادة التسليم' : 'تسليم البحث للمراجعة'}
                </Button>
              </form>
            </CardContent>
          </Card>
        )
      )}
    </div>
  )
}

// ============ تبويب شهاداتي ============

export function CertificatesTab() {
  const [certs, setCerts] = useState<CertificateData[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<CertificateData | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    api<{ certificates: CertificateData[] }>('/api/certificates')
      .then((d) => setCerts(d.certificates))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
  }

  const TYPE_LABEL: Record<string, string> = {
    PROGRAM_COMPLETION: 'إتمام برنامج تدريبي',
    ACCREDITATION: 'اعتماد دولي',
    AGENCY: 'وكالة دولية',
  }

  return (
    <div className="space-y-4">
      {certs.length === 0 ? (
        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-10 text-center text-sm text-slate-400">
            لا توجد شهادات بعد — أكمل متطلبات برنامجك أو انتظر إصدار شهادة الاعتماد، وستظهر هنا تلقائياً مع إمكانية الطباعة والتحقق
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {certs.map((c) => (
            <Card key={c.serial} className="border-[#c9a227]/40 bg-gradient-to-bl from-[#f7edd0]/70 to-white">
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <span className="rounded-xl bg-[#0f2b46] p-2.5 text-[#e0b83a]"><Award className="h-5 w-5" /></span>
                  <Badge variant="outline" className="border-[#c9a227]/50 text-[10px] font-bold text-[#a8841a]">
                    {TYPE_LABEL[c.type] || c.type}
                  </Badge>
                </div>
                <h4 className="mt-3 text-sm font-black text-[#0f2b46]">{c.program}</h4>
                <p className="mt-1 text-[11px] font-bold text-slate-500">صادرة باسم: {c.holderName}</p>
                <p className="mt-0.5 font-mono text-[10px] text-slate-400" dir="ltr">{c.serial}</p>
                <Button
                  size="sm"
                  onClick={() => { setSelected(c); setOpen(true) }}
                  className="mt-3 w-full bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]"
                >
                  <Award className="ml-1.5 h-4 w-4" /> عرض وطباعة الشهادة
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
      <CertificateDialog certificate={selected} open={open} onClose={() => setOpen(false)} />
    </div>
  )
}

// ============ تبويب السجل الأكاديمي الرسمي (Transcript) ============

interface TranscriptRow {
  kind: 'UNIT' | 'SEMESTER' | 'ASSIGNMENT'
  title: string
  part: string
  passScore: number
  bestScore: number | null
  passed: boolean
  date: string | null
}

interface TranscriptProgram {
  enrollmentId: string
  programId: string
  title: string
  titleEn?: string | null
  description?: string | null
  category?: string | null
  hours?: number | null
  unitsCount?: number | null
  units?: { order?: number; title?: string }[]
  books?: { title?: string; titleEn?: string | null; semester?: number | null }[]
  assignments?: { title?: string; semester?: number | null; points?: number | null; status?: string | null }[]
  exams?: { title?: string; semester?: number | null; status?: string | null; questionCount?: number | null }[]
  academicProfile?: any
  status: string
  finalScore?: number | null
  certificateNo?: string | null
  enrolledAt: string
  completedUnits: number
  rows: TranscriptRow[]
}

interface TranscriptData {
  student: {
    name: string
    email: string
    country?: string | null
    reference?: string | null
    supervisor?: string | null
    admissionStatus?: string | null
    joinedAt: string
  }
  programs: TranscriptProgram[]
  summary: { programsCount: number; totalExams: number; passedExams: number; averageScore: number | null }
  generatedAt: string
}

export function TranscriptTab() {
  const [data, setData] = useState<TranscriptData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<TranscriptData>('/api/transcript')
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
  }
  if (!data) {
    return (
      <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm text-slate-400">تعذر تحميل السجل — حاول مجدداً</CardContent></Card>
    )
  }

  const ADM: Record<string, string> = {
    AWAITING_FEE: 'بانتظار رسوم التقديم', UNDER_REVIEW: 'قيد الدراسة', AWAITING_TUITION: 'مقبول — بانتظار الرسوم',
    THESIS: 'مسجل نهائي', SUPERVISOR_ASSIGNED: 'مشرف معين', SCHEDULED: 'مجدول للمناقشة',
    RESULT_APPROVED: 'اجتاز المناقشة', CERTIFIED: 'خريج معتمد',
  }

  return (
    <div className="space-y-4">
      {/* شريط علوي: طباعة السجل */}
      <div className="aact-no-print flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#0f2b46]/15 bg-[#0f2b46] p-4 text-white">
        <div className="flex items-center gap-2.5">
          <ScrollText className="h-5 w-5 text-[#e0b83a]" />
          <div>
            <p className="text-sm font-black">سجلي الأكاديمي الرسمي</p>
            <p className="text-[11px] text-white/70">كشف درجاتك في جميع اختبارات برامجك — قابل للطباعة كمستند رسمي</p>
          </div>
        </div>
        <Button onClick={() => window.print()} className="aact-no-print bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
          <Printer className="ml-1.5 h-4 w-4" /> طباعة السجل
        </Button>
      </div>

      {/* الوثيقة الرسمية */}
      <div id="aact-transcript" className="space-y-5 rounded-2xl border-2 border-[#c9a227]/40 bg-white p-5 sm:p-7">
        {/* ترويسة الأكاديمية */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b-2 border-[#c9a227]/50 pb-4">
          <div className="flex items-center gap-3">
            <AcademyLogo size={56} />
            <div>
              <p className="text-sm font-black text-[#0f2b46]">الأكاديمية الأمريكية للاستشارات والتدريب</p>
              <p className="text-[10px] font-bold text-[#a8841a]">American Academy for Consulting and Training — EST. 2016</p>
              <p className="mt-0.5 text-[10px] font-bold text-slate-500">كشف درجات أكاديمي رسمي — Academic Transcript</p>
            </div>
          </div>
          <div className="text-left text-[10px] font-bold text-slate-500">
            <p>تاريخ الإصدار: {new Date(data.generatedAt).toLocaleDateString('ar-EG')}</p>
            {data.student.reference && <p dir="ltr">Ref: {data.student.reference}</p>}
          </div>
        </div>

        {/* بيانات الطالب */}
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-[#f7edd0]/40 p-4 text-xs sm:grid-cols-3">
          {[
            { l: 'اسم الطالب', v: data.student.name },
            { l: 'البريد الإلكتروني', v: data.student.email, ltr: true },
            { l: 'الدولة', v: data.student.country || '—' },
            { l: 'المشرف الأكاديمي', v: data.student.supervisor || 'لم يُعين بعد' },
            { l: 'حالة الطلب', v: ADM[data.student.admissionStatus || ''] || data.student.admissionStatus || '—' },
            { l: 'تاريخ الالتحاق', v: new Date(data.student.joinedAt).toLocaleDateString('ar-EG') },
          ].map((f) => (
            <div key={f.l}>
              <p className="text-[10px] font-bold text-slate-500">{f.l}</p>
              <p className="mt-0.5 font-black text-[#0f2b46]" dir={f.ltr ? 'ltr' : undefined} style={f.ltr ? { textAlign: 'right' } : undefined}>{f.v}</p>
            </div>
          ))}
        </div>

        {/* ملخص الأداء */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { icon: BookOpen, l: 'البرامج', v: String(data.summary.programsCount), c: 'bg-[#0f2b46] text-[#e0b83a]' },
            { icon: ClipboardCheck, l: 'تقييمات مجتازة', v: `${data.summary.passedExams}/${data.summary.totalExams}`, c: 'bg-emerald-600 text-white' },
            { icon: Award, l: 'متوسط الدرجات', v: data.summary.averageScore != null ? `${data.summary.averageScore}%` : '—', c: 'bg-[#c9a227] text-[#0f2b46]' },
            { icon: Trophy, l: 'شهادات صادرة', v: String(data.programs.filter((p) => p.certificateNo).length), c: 'bg-[#b22234] text-white' },
          ].map((k) => (
            <div key={k.l} className="rounded-xl border border-slate-100 p-3 text-center">
              <span className={`mx-auto mb-1.5 flex h-8 w-8 items-center justify-center rounded-lg ${k.c}`}><k.icon className="h-4 w-4" /></span>
              <p className="text-lg font-black text-[#0f2b46]">{k.v}</p>
              <p className="text-[10px] font-bold text-slate-500">{k.l}</p>
            </div>
          ))}
        </div>

        {/* كشوف الدرجات لكل برنامج */}
        {data.programs.length === 0 ? (
          <div className="rounded-xl bg-slate-50 p-8 text-center text-sm text-slate-500">لم تسجل في أي برنامج بعد — سجل في برنامجك الأول ليبني سجلك الأكاديمي تلقائياً</div>
        ) : (
          data.programs.map((p) => {
            const academic = buildAcademicProgramProfile({
              titleAr: p.title,
              titleEn: p.titleEn,
              description: p.description,
              category: p.category,
              hours: p.hours,
              unitsCount: p.unitsCount,
              units: p.units,
              books: p.books,
              assignments: p.assignments,
              exams: p.exams,
              academicProfile: p.academicProfile,
            })
            return (
            <div key={p.enrollmentId} className="overflow-hidden rounded-xl border border-[#0f2b46]/15">
              <div className="flex flex-wrap items-center justify-between gap-2 bg-[#0f2b46] px-4 py-2.5 text-white">
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 text-[#e0b83a]" />
                  <p className="text-xs font-black">{p.title}</p>
                  {p.hours ? <span className="text-[10px] text-white/60">({p.hours} ساعة تدريبية)</span> : null}
                </div>
                <div className="flex items-center gap-1.5">
                  {p.certificateNo && <Badge className="bg-emerald-500/20 text-[9px] font-black text-emerald-300 hover:bg-emerald-500/20">شهادة صادرة</Badge>}
                  <Badge className="bg-white/10 text-[9px] font-bold text-white/80 hover:bg-white/10">
                    {p.status === 'COMPLETED' ? 'مكتمل' : 'قيد الدراسة'}
                  </Badge>
                </div>
              </div>
              <div className="grid gap-2 border-b border-[#c9a227]/20 bg-[#fffaf0] p-3 text-[10px] font-bold leading-5 text-slate-600 sm:grid-cols-3">
                <div>
                  <p className="font-black text-[#0f2b46]">المسمى الأكاديمي</p>
                  <p>{academic.academicTitle}</p>
                </div>
                <div>
                  <p className="font-black text-[#0f2b46]">خطة البرنامج</p>
                  <p>{academic.durationLabel} · {academic.creditHoursLabel}</p>
                </div>
                <div>
                  <p className="font-black text-[#0f2b46]">مخرجات مختصرة</p>
                  <p>{academic.learningOutcomes.slice(0, 2).join(' ')}</p>
                </div>
              </div>
              {(academic.termPlans?.length || 0) > 0 && (
                <div className="grid gap-2 border-b border-[#0f2b46]/10 bg-white p-3 text-[10px] font-bold leading-5 text-slate-600 sm:grid-cols-3">
                  {academic.termPlans.slice(0, 3).map((term) => (
                    <div key={term.id} className="rounded-xl bg-[#f8fafc] p-2 ring-1 ring-slate-100">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <p className="font-black text-[#0f2b46]">{term.title}</p>
                        <span className="rounded-full bg-[#f7edd0] px-2 py-0.5 font-black text-[#a8841a]">{term.weight}%</span>
                      </div>
                      <p>كتب: {term.requiredBooks.length ? term.requiredBooks.slice(0, 2).map((b) => b.title).join('، ') : 'تحددها الإدارة'}</p>
                      <p>تقييم: {term.finalEvaluation}</p>
                    </div>
                  ))}
                </div>
              )}
              <table className="w-full text-right text-[11px]">
                <thead>
                  <tr className="border-b border-[#c9a227]/30 bg-[#f7edd0]/50 text-[10px] font-black text-[#5c4d1a]">
                    <th className="px-3 py-2">التقييم/الواجب</th>
                    <th className="px-3 py-2">القسم</th>
                    <th className="px-3 py-2">الدرجة</th>
                    <th className="px-3 py-2">حد النجاح</th>
                    <th className="px-3 py-2">النتيجة</th>
                    <th className="hidden px-3 py-2 sm:table-cell">التاريخ</th>
                  </tr>
                </thead>
                <tbody>
                  {p.rows.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-400">لا اختبارات مسجلة لهذا البرنامج بعد</td></tr>
                  ) : (
                    p.rows.map((r, i) => (
                      <tr key={i} className="border-b border-slate-50 font-bold text-slate-700 odd:bg-white even:bg-slate-50/40">
                        <td className="max-w-52 truncate px-3 py-2 text-[#0f2b46]">{r.title}</td>
                        <td className="px-3 py-2 text-[10px] text-slate-500">{r.part}</td>
                        <td className="px-3 py-2 font-black">{r.bestScore != null ? `${Math.round(r.bestScore)}%` : '—'}</td>
                        <td className="px-3 py-2 text-slate-500">{r.passScore}%</td>
                        <td className="px-3 py-2">
                          {r.bestScore == null ? (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-black text-slate-500">لم يؤدَّ</span>
                          ) : r.passed ? (
                            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[9px] font-black text-emerald-700">ناجح ✓</span>
                          ) : (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-black text-amber-700">إعادة</span>
                          )}
                        </td>
                        <td className="hidden px-3 py-2 text-[10px] text-slate-400 sm:table-cell">{r.date ? new Date(r.date).toLocaleDateString('ar-EG') : '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            )
          })
        )}

        {/* تذييل الوثيقة */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-[9px] font-bold text-slate-400">
          <p>هذه الوثيقة مولدة إلكترونياً من منصة الأكاديمية ويمكن التحقق من شهاداتها عبر صفحة «التحقق من الشهادات»</p>
          <p>بناء القيادات، صقل المهارات — Building Leaders, Refining Skills</p>
        </div>
      </div>
    </div>
  )
}
