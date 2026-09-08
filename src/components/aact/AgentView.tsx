'use client'

import { useState } from 'react'
import { api, useAppStore } from '@/lib/store'
import { ACCREDITATION_GUIDE, ADMISSION_FEES } from '@/lib/academyData'
import { toast, useToast } from '@/hooks/use-toast'
import { AgentPortalTab } from '@/components/aact/AgentPortalTab'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Globe2, Loader2, Send, CheckCircle2, Handshake, Percent, FileText, ListChecks,
  ShieldCheck, Building2, Award, BadgeCheck, Banknote, UploadCloud, FileWarning, Trash2,
  Landmark, CreditCard, ScrollText, IdCard, Camera,
} from 'lucide-react'

// الوثائق الرسمية الإلزامية لطلبات الاعتماد — خطوة «إرفاق الوثائق الرسمية» من دليل الإجراءات حرفياً
const AGENT_DOCS = [
  { type: 'LICENSE', label: 'شهادة الترخيص أو مزاولة المهنة', hint: 'صورة عن السجل التجاري أو الترخيص أو إثبات مزاولة المهنة', icon: ScrollText },
  { type: 'ID', label: 'الهوية الشخصية أو جواز السفر', hint: 'صورة واضحة من الجهتين', icon: IdCard },
  { type: 'PHOTO', label: 'صور شخصية حديثة', hint: 'للمدربين / المستشارين (خلفية بيضاء يفضل)', icon: Camera },
  { type: 'CV', label: 'السيرة الذاتية C.V', hint: 'PDF أو صورة واضحة', icon: FileText },
] as const
const MAX_FILE_MB = 4

const PAY_METHODS = [
  { value: 'PAYMOB', label: 'Paymob — بطاقة / محفظة مصرية' },
  { value: 'FAWRY', label: 'فوري — كود دفع مصر' },
  { value: 'STRIPE', label: 'Stripe — بطاقة دولية' },
  { value: 'PAYPAL', label: 'PayPal — حساب دولي' },
  { value: 'BANK_TRANSFER', label: 'تحويل بنكي — مراجعة الإدارة' },
]

const BENEFITS = [
  {
    icon: Percent,
    title: 'عمولة 25%',
    desc: 'من إيرادات جميع البرامج التدريبية في منطقة تمثيلك الجغرافي الحصرية',
  },
  {
    icon: FileText,
    title: '100$ عن كل بحث',
    desc: 'مكافأة عن كل بحث تخرج تشارك أنت ضمن لجنة المناقشة الخاصة به',
  },
  {
    icon: ListChecks,
    title: 'إدراج رسمي',
    desc: 'اسمك ضمن قائمة الوكلاء والممثلين المعتمدين عبر الموقع الرسمي للأكاديمية',
  },
  {
    icon: Handshake,
    title: 'دعم كامل',
    desc: 'تزويدك بالحقائب التدريبية والمناهج والمعايير الأكاديمية المعتمدة لكل برنامج',
  },
]

const ACC_ICONS: Record<string, any> = {
  COMPANY: Building2, CONSULTANT: ShieldCheck, TRAINER: Award, QUALITY: BadgeCheck,
}

export function AgentView() {
  const { toast } = useToast()
  const { user } = useAppStore()
  const [loading, setLoading] = useState(false)
  // نتيجة التقديم: فاتورة رسوم التقديم لطلبات الاعتماد (سداد فوري)
  const [done, setDone] = useState<{ kind: 'agency' | 'accreditation'; invoice?: { invoiceNo: string; amount: number } | null } | null>(null)
  // الوثائق الرسمية المرفوعة (إلزامية لطلبات الاعتماد)
  const [files, setFiles] = useState<Record<string, File | null>>({})
  const [missingDocs, setMissingDocs] = useState<string[]>([])
  // سداد رسوم التقديم
  const [payMethod, setPayMethod] = useState('PAYMOB')
  const [paying, setPaying] = useState(false)

  const [kind, setKind] = useState<'AGENCY' | 'ACCREDITATION'>('AGENCY')
  const [accreditationType, setAccreditationType] = useState('COMPANY')
  const [form, setForm] = useState({
    orgName: '', repName: '', email: '', phone: '', country: '', territory: '', experience: '',
  })

  const setFile = (type: string, f: File | null) => {
    if (f && f.size > MAX_FILE_MB * 1024 * 1024) {
      toast({ title: 'الملف كبير', description: `الحد الأقصى ${MAX_FILE_MB} ميجابايت — يرجى ضغط الملف`, variant: 'destructive' })
      return
    }
    if (f && !['image/jpeg', 'image/png', 'application/pdf'].includes(f.type)) {
      toast({ title: 'صيغة غير مدعومة', description: 'المسموح: JPG / PNG / PDF', variant: 'destructive' })
      return
    }
    setFiles((prev) => ({ ...prev, [type]: f }))
  }

  const allDocsUploaded = AGENT_DOCS.every((d) => files[d.type])

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    // قاعدة الدليل الرسمي: طلبات الاعتماد لا تُقبل بدون الوثائق الأربع
    if (kind === 'ACCREDITATION') {
      const missing = AGENT_DOCS.filter((d) => !files[d.type])
      if (missing.length > 0) {
        setMissingDocs(missing.map((m) => m.label))
        toast({ title: 'الوثائق الرسمية غير مكتملة', description: `يرجى رفع: ${missing.map((m) => m.label).join('، ')}`, variant: 'destructive' })
        return
      }
    }
    setMissingDocs([])
    setLoading(true)
    try {
      let d: { message: string; invoice?: { invoiceNo: string; amount: number } | null }
      if (kind === 'ACCREDITATION') {
        const fd = new FormData()
        fd.append('kind', kind)
        fd.append('accreditationType', accreditationType)
        Object.entries(form).forEach(([k, v]) => fd.append(k, v))
        for (const doc of AGENT_DOCS) {
          const f = files[doc.type]
          if (f) fd.append(`doc_${doc.type}`, f)
        }
        const res = await fetch('/api/agent-apply', {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('aact_token') || ''}` },
          body: fd,
        })
        d = await res.json()
        if (!res.ok) throw new Error(d.message || 'تعذر إرسال الطلب')
      } else {
        d = await api<{ message: string }>('/api/agent-apply', {
          method: 'POST',
          body: JSON.stringify({ ...form, kind }),
        })
      }
      setDone({ kind: kind === 'AGENCY' ? 'agency' : 'accreditation', invoice: d.invoice || null })
      toast({ title: 'تم الإرسال', description: d.message })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  // سداد رسوم تقديم طلب الاعتماد (المسار الحقيقي Stripe/PayPal عند تهيئة المفاتيح)
  const payAccreditationFee = async () => {
    if (!done?.invoice) return
    setPaying(true)
    try {
      const co = await api<{ redirectUrl: string | null }>('/api/payments/checkout', {
        method: 'POST',
        body: JSON.stringify({ invoiceNo: done.invoice.invoiceNo, method: payMethod }),
      }).catch(() => null)
      if (co?.redirectUrl) {
        window.location.href = co.redirectUrl
        return
      }
      await api('/api/payments', {
        method: 'POST',
        body: JSON.stringify({ invoiceNo: done.invoice.invoiceNo, method: payMethod }),
      })
      setDone({ ...done, invoice: null })
      toast({ title: 'تم سداد رسوم التقديم بنجاح', description: 'أُحوِّل ملف اعتمادكم لدراسة الإدارة' })
    } catch (e: any) {
      toast({ title: 'خطأ في الدفع', description: e.message, variant: 'destructive' })
    } finally {
      setPaying(false)
    }
  }

  // بطاقات رفع الوثائق الرسمية — تظهر في نموذج الاعتماد فقط
  const docUploadSection = kind === 'ACCREDITATION' && (
    <div className="rounded-xl border border-[#c9a227]/40 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#c9a227]/30 bg-[#f7edd0]/50 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-black text-[#0f2b46]">إرفاق الوثائق الرسمية المطلوبة (إلزامي — لا يُقبل الطلب بدونها)</span>
        </div>
        <Badge className={allDocsUploaded ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>
          {AGENT_DOCS.filter((d) => files[d.type]).length} / {AGENT_DOCS.length} مكتملة
        </Badge>
      </div>
      <div className="p-4">
        <p className="mb-3 text-[11px] text-slate-500">الصيغ المسموحة: JPG / PNG / PDF — الحد الأقصى {MAX_FILE_MB} ميجابايت للملف</p>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {AGENT_DOCS.map((doc) => {
            const f = files[doc.type]
            return (
              <div key={doc.type} className={`rounded-xl border p-3 transition-colors ${f ? 'border-emerald-300 bg-emerald-50/40' : 'border-slate-200 bg-slate-50/60'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <doc.icon className="h-4 w-4 text-[#a8841a]" />
                    <div>
                      <p className="text-xs font-black text-[#0f2b46]">{doc.label} *</p>
                      <p className="text-[10px] text-slate-400">{doc.hint}</p>
                    </div>
                  </div>
                  {f && (
                    <button type="button" onClick={() => setFile(doc.type, null)} className="text-red-400 hover:text-red-600" aria-label="إزالة">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                <label className="mt-2 flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed border-[#c9a227]/50 bg-white px-3 py-2 text-[11px] font-bold text-[#a8841a] hover:bg-[#f7edd0]/40">
                  <UploadCloud className="h-3.5 w-3.5" />
                  {f ? f.name.slice(0, 28) : 'اختيار ملف'}
                  <input type="file" accept=".jpg,.jpeg,.png,.pdf" className="hidden" onChange={(e) => setFile(doc.type, e.target.files?.[0] || null)} />
                </label>
              </div>
            )
          })}
        </div>
        {missingDocs.length > 0 && (
          <p className="mt-3 flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-[11px] font-bold text-red-600">
            <FileWarning className="h-3.5 w-3.5" /> ملفكم ناقص: {missingDocs.join('، ')}
          </p>
        )}
      </div>
    </div>
  )

  const formFields = (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="agent-org">
            {kind === 'ACCREDITATION' && accreditationType !== 'COMPANY' && accreditationType !== 'QUALITY' ? 'الاسم / اسم المكتب *' : 'اسم المؤسسة / المركز *'}
          </Label>
          <Input id="agent-org" required placeholder={kind === 'AGENCY' ? 'مثال: مؤسسة يد بيد للتدريب' : 'اسم الجهة أو الفرد'}
            value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-rep">الاسم الكامل لمقدم الطلب *</Label>
          <Input id="agent-rep" required placeholder="الاسم الثلاثي"
            value={form.repName} onChange={(e) => setForm({ ...form, repName: e.target.value })} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="agent-email">البريد الإلكتروني *</Label>
          <Input id="agent-email" type="email" required dir="ltr" className="text-left" placeholder="you@example.com"
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="agent-phone">الهاتف / واتساب *</Label>
          <Input id="agent-phone" required dir="ltr" className="text-left" placeholder="+201xxxxxxxxx"
            value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="agent-country">دولة الإقامة *</Label>
          <Input id="agent-country" required placeholder="مثال: مصر"
            value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
        </div>
        {kind === 'AGENCY' ? (
          <div className="space-y-2">
            <Label htmlFor="agent-territory">نطاق التمثيل المطلوب *</Label>
            <Input id="agent-territory" required placeholder="مثال: جمهورية مصر العربية"
              value={form.territory} onChange={(e) => setForm({ ...form, territory: e.target.value })} />
          </div>
        ) : (
          <div className="space-y-2">
            <Label>نوع الاعتماد المطلوب *</Label>
            <Select value={accreditationType} onValueChange={setAccreditationType}>
              <SelectTrigger className="w-full"><SelectValue placeholder="اختر نوع الاعتماد" /></SelectTrigger>
              <SelectContent>
                {ACCREDITATION_GUIDE.items.map((it) => (
                  <SelectItem key={it.key} value={it.key}>
                    {it.label} {it.fee ? `— ${it.fee}$` : '— حسب الطلب'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
      <div className="space-y-2">
        <Label htmlFor="agent-exp">
          {kind === 'AGENCY' ? 'الخبرة في مجال التدريب والاستشارات' : 'الخبرة والمنجزات المهنية (شهادات، دورات، مؤهلات)'}
        </Label>
        <Textarea id="agent-exp" placeholder={kind === 'AGENCY'
          ? 'أخبرنا عن خبرتك: عدد سنوات العمل، البرامج المنفذة، الشهادات، المؤسسات التي تعاملت معها...'
          : 'اذكر خبراتك المهنية: المؤهل، سنوات الخبرة، الشهادات، الدورات المنفذة...'}
          className="min-h-28"
          value={form.experience} onChange={(e) => setForm({ ...form, experience: e.target.value })} />
      </div>
      {docUploadSection}
      {kind === 'ACCREDITATION' && (
        <p className="rounded-lg bg-[#f7edd0]/70 px-3 py-2 text-[11px] font-bold leading-relaxed text-[#a8841a]">
          رسوم تقديم طلب الاعتماد: {ACCREDITATION_GUIDE.applicationFee}$ (غير مستردة) — تُصدر فاتورة فور التقديم وتُسدد من نفس الصفحة، ثم تُدرس الإدارة الملف ويصدر الاعتماد وفق الدليل.
        </p>
      )}
      <Button type="submit" disabled={loading} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
        {loading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4 rotate-180" />}
        {kind === 'AGENCY' ? 'إرسال طلب الوكالة الدولية' : 'إرسال طلب الاعتماد'}
      </Button>
    </form>
  )

  return (
    <div className="aact-fade-in mx-auto max-w-6xl px-4 py-10">
      <div className="mb-8 text-center">
        <Badge className="mb-3 border-[#c9a227]/50 bg-[#c9a227]/10 text-[#a8841a] hover:bg-[#c9a227]/10">
          <Globe2 className="ml-1 h-3.5 w-3.5" /> تمثيل دولي واعتماد رسمي
        </Badge>
        <h1 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">
          وكالة الأكاديمية واعتمادات الجهات والأفراد
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
          نظام الاعتماد الدولي والعضوية الأمريكية: اعتماد شركات ومؤسسات ومراكز التدريب، اعتماد
          المدربين والمستشارين، واعتماد الجودة وفق أفضل المنظومات الدولية — أو احصل على حق
          التمثيل الحصري لتقديم البرامج في نطاقك الجغرافي.
        </p>
      </div>

      <Tabs defaultValue="agency" dir="rtl" className="w-full">
        <TabsList className="mx-auto grid w-full max-w-lg grid-cols-3">
          <TabsTrigger value="agency" onClick={() => setKind('AGENCY')} className="text-xs font-bold sm:text-sm">
            الوكالة الدولية
          </TabsTrigger>
          <TabsTrigger value="accreditation" onClick={() => setKind('ACCREDITATION')} className="text-xs font-bold sm:text-sm">
            طلبات الاعتماد
          </TabsTrigger>
          <TabsTrigger value="portal" className="text-xs font-bold text-[#a8841a] sm:text-sm">
            بوابتي {user ? '' : '(دخول)'}
          </TabsTrigger>
        </TabsList>

        {/* ===== تبويب بوابة الوكيل ===== */}
        <TabsContent value="portal">
          <AgentPortalTab />
        </TabsContent>

        {/* ===== تبويب الوكالة ===== */}
        <TabsContent value="agency">
          <div className="mb-8 mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {BENEFITS.map((b) => (
              <Card key={b.title} className="aact-card border-[#0f2b46]/10 bg-white">
                <CardContent className="p-5 text-center">
                  <div className="mx-auto mb-3 w-fit rounded-xl bg-[#0f2b46] p-3 text-[#e0b83a]">
                    <b.icon className="h-6 w-6" />
                  </div>
                  <h3 className="text-sm font-black text-[#0f2b46]">{b.title}</h3>
                  <p className="mt-2 text-xs leading-relaxed text-slate-500">{b.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="mb-8 border-[#c9a227]/40 bg-[#f7edd0]/40">
            <CardContent className="p-5 sm:p-6">
              <h2 className="mb-3 text-base font-black text-[#0f2b46]">البرامج المشمولة بالوكالة</h2>
              <div className="flex flex-wrap gap-2">
                {['الدكتوراة المهنية', 'الماجستير المهني', 'الدبلومات المهنية', 'اعتماد المستشارين والمدربين', 'اعتماد شركات ومؤسسات ومراكز التدريب'].map((p) => (
                  <span key={p} className="rounded-full border border-[#a8841a]/30 bg-white px-3.5 py-1.5 text-xs font-bold text-[#0f2b46]">
                    {p}
                  </span>
                ))}
              </div>
              <p className="mt-3 text-xs leading-relaxed text-slate-500">
                ملاحظة: الشهادات في مجال التدريب المهني فقط وليست لها علاقة بالمتطلبات الأكاديمية الحكومية.
              </p>
            </CardContent>
          </Card>

          {done?.kind === 'agency' ? (
            <Card className="mx-auto max-w-2xl border-emerald-200 bg-emerald-50/50">
              <CardContent className="p-8 text-center">
                <CheckCircle2 className="mx-auto mb-4 h-14 w-14 text-emerald-600" />
                <h2 className="text-xl font-black text-emerald-700">تم استلام طلب الوكالة!</h2>
                <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-emerald-800">
                  ستتم مراجعة طلبكم من إدارة الأكاديمية، وسيتواصل فريق الاعتمادات معكم عبر البريد
                  الإلكتروني خلال أيام العمل لاستكمال إجراءات توقيع اتفاقية التمثيل والتفويض الدولي.
                </p>
                <p className="mt-4 text-xs font-bold text-emerald-600">
                  للاستفسار: aact.academy2@gmail.com — واتساب: +14748677271
                </p>
                <Button className="mt-6 bg-[#0f2b46] font-bold text-[#f5f0e1] hover:bg-[#12365c]" onClick={() => setDone(null)}>
                  إرسال طلب آخر
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="mx-auto max-w-2xl border-[#0f2b46]/15 shadow-xl">
              <CardHeader>
                <CardTitle className="text-lg font-black text-[#0f2b46]">نموذج طلب الوكالة الدولية</CardTitle>
                <CardDescription>أكمل البيانات التالية وستتواصل معك إدارة الأكاديمية رسمياً</CardDescription>
              </CardHeader>
              <CardContent>{formFields}</CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ===== تبويب الاعتمادات ===== */}
        <TabsContent value="accreditation">
          {/* أنواع الاعتماد ورسومها */}
          <div className="mb-6 mt-6 grid gap-4 sm:grid-cols-2">
            {ACCREDITATION_GUIDE.items.map((it) => {
              const Icon = ACC_ICONS[it.key] || ShieldCheck
              return (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => setAccreditationType(it.key)}
                  className={`rounded-2xl border p-5 text-right transition-all ${
                    accreditationType === it.key
                      ? 'border-[#c9a227] bg-[#f7edd0]/60 shadow-md'
                      : 'border-[#0f2b46]/10 bg-white hover:border-[#c9a227]/50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="rounded-xl bg-[#0f2b46] p-2.5 text-[#e0b83a]">
                      <Icon className="h-5 w-5" />
                    </div>
                    {it.fee ? (
                      <span className="rounded-full bg-[#c9a227]/15 px-3 py-1 text-sm font-black text-[#a8841a]">{it.fee}$</span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-black text-slate-500">حسب الطلب</span>
                    )}
                  </div>
                  <h3 className="mt-3 text-sm font-black leading-relaxed text-[#0f2b46]">{it.label}</h3>
                </button>
              )
            })}
          </div>

          {/* الرسوم والمميزات */}
          <div className="mb-8 grid gap-4 lg:grid-cols-2">
            <Card className="border-[#c9a227]/40 bg-[#f7edd0]/40">
              <CardContent className="p-5">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                  <Banknote className="h-4.5 w-4.5 text-[#a8841a]" /> الرسوم المالية
                </h3>
                <ul className="space-y-2 text-xs leading-relaxed text-slate-700">
                  <li>• رسوم تقديم طلب الاعتماد: <strong>{ACCREDITATION_GUIDE.applicationFee}$ غير مستردة</strong></li>
                  <li>• الهيئات التدريبية (شركات/مؤسسات/مراكز): <strong>1000$</strong></li>
                  <li>• المستشارون (إداري ومالي، تربوي، قانوني، نفسي، هندسي، ذكاء اصطناعي): <strong>350$</strong></li>
                  <li>• المدرب الدولي المعتمد: <strong>200$</strong></li>
                  <li>• اعتماد الجودة: <strong>حسب طبيعة الاعتماد</strong></li>
                </ul>
              </CardContent>
            </Card>
            <Card className="border-[#0f2b46]/10 bg-white">
              <CardContent className="p-5">
                <h3 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                  <BadgeCheck className="h-4.5 w-4.5 text-emerald-600" /> مميزات الاعتماد
                </h3>
                <ul className="space-y-2">
                  {ACCREDITATION_GUIDE.benefits.map((b, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-slate-600">
                      <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      {b}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>

          {done?.kind === 'accreditation' ? (
            <Card className="mx-auto max-w-2xl border-emerald-200 bg-emerald-50/50">
              <CardContent className="p-8 text-center">
                <CheckCircle2 className="mx-auto mb-4 h-14 w-14 text-emerald-600" />
                <h2 className="text-xl font-black text-emerald-700">تم استلام طلب الاعتماد مع الوثائق كاملة!</h2>
                <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-emerald-800">
                  وُصلتنا الوثائق الرسمية الأربع (4/4). بعد دراسة ملف الطلب وسداد رسوم التقديم
                  ({ACCREDITATION_GUIDE.applicationFee}$) سيتم إصدار شهادة الاعتماد والتمثيل ونشرها على الموقع الرسمي للأكاديمية.
                </p>
                {done.invoice ? (
                  <div className="mx-auto mt-5 max-w-md rounded-xl border border-[#c9a227]/40 bg-white p-4 text-right">
                    <p className="text-xs font-black text-[#0f2b46]">فاتورة رسوم التقديم — {done.invoice.invoiceNo}</p>
                    <p className="mt-1 text-2xl font-black text-[#a8841a]">{done.invoice.amount}$</p>
                    <Select value={payMethod} onValueChange={setPayMethod}>
                      <SelectTrigger className="mt-3 w-full text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PAY_METHODS.map((m) => (
                          <SelectItem key={m.value} value={m.value} className="text-xs">{m.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button onClick={payAccreditationFee} disabled={paying} className="mt-3 w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                      {paying ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CreditCard className="ml-2 h-4 w-4" />}
                      سداد رسوم التقديم الآن
                    </Button>
                    <p className="mt-2 flex items-center justify-center gap-1 text-[10px] text-slate-400">
                      <Landmark className="h-3 w-3" /> سداد آمن — إيصال فوري داخل المنصة، أو تحويل لصفحة المزود عند تفعيل الدفع الدولي
                    </p>
                  </div>
                ) : (
                  <p className="mt-4 text-xs font-black text-emerald-700">سُددت رسوم التقديم — ملفكم قيد دراسة الإدارة</p>
                )}
                <Button variant="outline" className="mt-5" onClick={() => { setDone(null); setFiles({}) }}>
                  إرسال طلب آخر
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="mx-auto max-w-2xl border-[#0f2b46]/15 shadow-xl">
              <CardHeader>
                <CardTitle className="text-lg font-black text-[#0f2b46]">نموذج طلب الاعتماد</CardTitle>
                <CardDescription>
                  اختر نوع الاعتماد من البطاقات أعلاه ثم أكمل بياناتك — الوثائق المطلوبة: شهادة الترخيص أو مزاولة المهنة، الهوية أو جواز السفر، صور شخصية، سيرة ذاتية
                </CardDescription>
              </CardHeader>
              <CardContent>{formFields}</CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      <p className="mt-6 text-center text-[11px] text-slate-400">
        رسوم التقديم غير مستردة في جميع الحالات وفق الدليل الرسمي — رسوم الدراسة للدبلومات من {ADMISSION_FEES.diplomasRange}$ حسب البرنامج.
      </p>
    </div>
  )
}
