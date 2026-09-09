'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, useAppStore } from '@/lib/store'
import { ADMISSION_GUIDE, ADMISSION_FEES, ACADEMY_INFO } from '@/lib/academyData'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  ClipboardList, FileText, DollarSign, ListOrdered, GraduationCap, Loader2, Send,
  CheckCircle2, Search, Clock3, BadgeCheck, ShieldAlert, UserCheck, Banknote,
  UploadCloud, FileWarning, Trash2, Paperclip, Landmark, CreditCard, Info,
  Milestone, CalendarDays, MapPin, IdCard, Sparkles,
} from 'lucide-react'

interface ProgramLite {
  id: string
  titleAr: string
  titleEn?: string | null
  category: string
  categoryLabel?: string
  specialty?: string
  price?: number | null
  // قواعد قبول مخصصة يضبطها مدير البرنامج (تعرض للمتقدم عند اختيار البرنامج)
  admissionRules?: {
    minEducation?: string
    minAge?: number
    minYearsExperience?: number
    customRules?: string
    displayNote?: string
  } | null
}

// المستندات الإلزامية وفق دليل الإجراءات — لا يُقبل الطلب بدونها
const REQUIRED_DOCS = [
  { type: 'DEGREE', label: 'الشهادة الجامعية وكشف العلامات (أو الثانوية للدبلومات)' },
  { type: 'ID', label: 'الهوية الشخصية أو جواز السفر' },
  { type: 'PHOTO', label: 'صورة شخصية حديثة' },
  { type: 'CV', label: 'السيرة الذاتية (C.V)' },
]
const MAX_FILE_MB = 4
const fmtSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1048576).toFixed(1)} م.ب` : `${Math.ceil(b / 1024)} ك.ب`)

const EDUCATION_LABEL: Record<string, string> = {
  HIGH_SCHOOL: 'ثانوية عامة أو ما يعادلها',
  BACHELOR: 'بكالوريوس (مهني أو أكاديمي)',
  MASTER: 'ماجستير',
  OTHER: 'أخرى',
}

const PROGRAM_CATEGORY_LABEL: Record<string, string> = {
  MASTERS: 'الماجستير المهني',
  DOCTORATE: 'الدكتوراه المهنية',
  DIPLOMA: 'الدبلومات المهنية',
  INTL_CERT: 'الشهادات الدولية',
  ACCREDITATION: 'الاعتمادات المهنية',
}
const PROGRAM_CATEGORY_ORDER = ['MASTERS', 'DOCTORATE', 'DIPLOMA', 'INTL_CERT', 'ACCREDITATION']

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  AWAITING_FEE: { text: 'بانتظار سداد رسوم التقديم (30$)', cls: 'bg-amber-100 text-amber-700' },
  UNDER_REVIEW: { text: 'قيد دراسة الإدارة', cls: 'bg-blue-100 text-blue-700' },
  AWAITING_TUITION: { text: 'مقبول — بانتظار سداد الرسوم الدراسية', cls: 'bg-[#c9a227]/20 text-[#a8841a]' },
  SUPERVISOR_ASSIGNED: { text: 'تم تعيين مشرف', cls: 'bg-purple-100 text-purple-700' },
  THESIS: { text: 'التسجيل النهائي — قيد إعداد بحث التخرج', cls: 'bg-emerald-100 text-emerald-700' },
  SCHEDULED: { text: 'مجدول للمناقشة', cls: 'bg-blue-100 text-blue-700' },
  RESULT_APPROVED: { text: 'تم اعتماد النتيجة', cls: 'bg-emerald-100 text-emerald-700' },
  CERTIFIED: { text: 'تم إصدار الشهادة', cls: 'bg-emerald-100 text-emerald-700' },
  REJECTED: { text: 'غير مقبول', cls: 'bg-red-100 text-red-600' },
  PENDING: { text: 'تم التقديم', cls: 'bg-slate-100 text-slate-600' },
}

// الخط الزمني لمراحل الطلب وفق دليل الإجراءات الرسمي
const TIMELINE: { key: string; label: string }[] = [
  { key: 'AWAITING_FEE', label: 'تقديم الطلب وسداد رسوم التقديم (30$)' },
  { key: 'UNDER_REVIEW', label: 'دراسة الملف من قبل الإدارة وتعيين المشرف' },
  { key: 'AWAITING_TUITION', label: 'الإقرار بالقبول — سداد الرسوم الدراسية كاملة' },
  { key: 'THESIS', label: 'التسجيل النهائي والبدء بالدراسة وبحث التخرج' },
  { key: 'SCHEDULED', label: 'مناقشة البحث أمام اللجنة' },
  { key: 'CERTIFIED', label: 'اعتماد النتيجة وإصدار الشهادة' },
]

interface TrackedInvoice {
  invoiceNo: string
  purpose: string
  amount: number
  status: string
  description: string
}

const FEES_ROWS = [
  { program: 'الدكتوراه المهنية (معادلة خبرات)', fee: `${ADMISSION_FEES.doctorate}$`, icon: GraduationCap },
  { program: 'الماجستير المهني (معادلة خبرات)', fee: `${ADMISSION_FEES.masters}$`, icon: GraduationCap },
  { program: 'الدبلومات والبرامج الدولية (حسب البرنامج)', fee: `${ADMISSION_FEES.diplomasRange}$`, icon: FileText },
  { program: 'رسوم تقديم الطلب وحجز المقعد (غير مستردة — تُسدد عند التقديم)', fee: `${ADMISSION_FEES.applicationFee}$`, icon: DollarSign },
]

// الخطوة الحالية ضمن الخط الزمني
function statusIndex(status: string): number {
  if (status === 'REJECTED') return -1
  const i = TIMELINE.findIndex((t) => t.key === status)
  if (i >= 0) return i
  if (status === 'RESULT_APPROVED') return TIMELINE.length - 2
  if (status === 'SUPERVISOR_ASSIGNED') return 2
  return 0
}

export function ApplyView() {
  const { toast } = useToast()
  const { user, applyProgramTitle } = useAppStore()
  const [programs, setPrograms] = useState<ProgramLite[]>([])
  const [selectedCategory, setSelectedCategory] = useState('')
  const [loading, setLoading] = useState(false)
  // نتيجة التقديم: كود التتبع + فاتورة رسوم التقديم للسداد الفوري
  const [done, setDone] = useState<{ reference: string; invoice: { invoiceNo: string; amount: number; description: string } | null } | null>(null)

  // نافذة سداد رسوم التقديم
  const [payOpen, setPayOpen] = useState(false)
  const [payMethod, setPayMethod] = useState('PAYMOB')
  const [paying, setPaying] = useState(false)
  const [paidRef, setPaidRef] = useState<string | null>(null) // كود الطلب بعد سداد الرسوم

  // تتبع الطلب
  const [trackRef, setTrackRef] = useState('')
  const [tracking, setTracking] = useState(false)
  const [tracked, setTracked] = useState<any | null>(null)
  const [trackError, setTrackError] = useState('')
  const [trackPayTarget, setTrackPayTarget] = useState<TrackedInvoice | null>(null)
  const [trackPaying, setTrackPaying] = useState(false)

  const [form, setForm] = useState({
    fullName: '', email: '', phone: '', country: '', nationalId: '',
    birthDate: '', address: '', education: 'BACHELOR', program: '', notes: '',
  })
  const [acknowledged, setAcknowledged] = useState(false)
  // ملفات المستندات المرفوعة (مفتاحها نوع الوثيقة)
  const [files, setFiles] = useState<Record<string, File>>({})
  const [missingDocs, setMissingDocs] = useState<string[]>([])
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})

  const allDocsUploaded = REQUIRED_DOCS.every((d) => files[d.type])

  useEffect(() => {
    api<{ programs: ProgramLite[] }>('/api/programs')
      .then((d) => setPrograms(d.programs))
      .catch(() => {})
  }, [])

  // تعبئة مسبقة من حساب المستخدم والبرنامج المختار من صفحة البرامج
  useEffect(() => {
    if (user) {
      setForm((f) => ({
        ...f,
        fullName: f.fullName || user.name,
        email: f.email || user.email,
        country: f.country || user.country || '',
      }))
    }
    if (applyProgramTitle) setForm((f) => ({ ...f, program: applyProgramTitle }))
  }, [user, applyProgramTitle])

  // عند الدخول من بطاقة برنامج، نحدد تلقائياً درجة البرنامج ثم التخصص
  useEffect(() => {
    if (!form.program || selectedCategory) return
    const p = programs.find((x) => x.titleAr === form.program)
    if (p) setSelectedCategory(p.category)
  }, [programs, form.program, selectedCategory])

  const DOCS = ADMISSION_GUIDE.documents

  const pickFile = (type: string, f: File | null) => {
    setMissingDocs([])
    if (!f) {
      setFiles((prev) => {
        const nxt = { ...prev }
        delete nxt[type]
        return nxt
      })
      return
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      toast({ title: 'الملف كبير جداً', description: `الحد الأقصى ${MAX_FILE_MB} ميجابايت للملف الواحد — يرجى ضغطه أو تصغيره`, variant: 'destructive' })
      return
    }
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/plain', 'text/csv', 'application/csv',
    ]
    const nameOk = /\.(jpe?g|png|webp|heic|heif|pdf|docx|xlsx|xls|txt|csv)$/i.test(f.name)
    if (f.type && !allowed.includes(f.type) && !nameOk) {
      toast({ title: 'صيغة غير مدعومة', description: 'المسموح: صور JPG/PNG/WebP/HEIC أو PDF أو Word أو Excel أو TXT/CSV', variant: 'destructive' })
      return
    }
    setFiles((prev) => ({ ...prev, [type]: f }))
  }

  const selectedProgramId = useMemo(
    () => programs.find((p) => p.titleAr === form.program)?.id || '',
    [programs, form.program]
  )

  // متطلبات القبول المخصصة للبرنامج المختار (تعرض للمتقدم قبل التقديم)
  const selectedRules = useMemo(
    () => programs.find((p) => p.titleAr === form.program)?.admissionRules || null,
    [programs, form.program]
  )
  const EDU_MIN_AR: Record<string, string> = { HIGH_SCHOOL: 'الثانوية العامة', BACHELOR: 'البكالوريوس', MASTER: 'الماجستير' }

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!form.program) {
      toast({ title: 'تنبيه', description: 'يرجى اختيار البرنامج المرغوب', variant: 'destructive' })
      return
    }
    if (!form.nationalId.trim()) {
      toast({ title: 'تنبيه', description: 'يرجى إدخال رقم الهوية الشخصية أو جواز السفر', variant: 'destructive' })
      return
    }
    // قاعدة إلزامية: رفع جميع المستندات قبل التقديم
    const missing = REQUIRED_DOCS.filter((d) => !files[d.type])
    if (missing.length > 0) {
      setMissingDocs(missing.map((m) => m.label))
      toast({
        title: 'المستندات غير مكتملة',
        description: `يرجى رفع: ${missing.map((m) => m.label).join('، ')}`,
        variant: 'destructive',
      })
      return
    }
    // قاعدة إلزامية: الإقرار قبل التقديم
    if (!acknowledged) {
      toast({ title: 'الإقرار مطلوب', description: 'يجب الموافقة على إقرار الطالب قبل تقديم الطلب', variant: 'destructive' })
      return
    }
    setLoading(true)
    try {
      const fd = new FormData()
      fd.append('fullName', form.fullName)
      fd.append('email', form.email)
      fd.append('phone', form.phone)
      fd.append('country', form.country)
      fd.append('nationalId', form.nationalId)
      if (form.birthDate) fd.append('birthDate', form.birthDate)
      if (form.address) fd.append('address', form.address)
      fd.append('education', form.education)
      fd.append('program', form.program)
      if (selectedProgramId) fd.append('programId', selectedProgramId)
      if (form.notes) fd.append('notes', form.notes)
      fd.append('acknowledged', 'true')
      for (const d of REQUIRED_DOCS) {
        fd.append(`doc_${d.type}`, files[d.type])
      }
      const d = await api<{ reference: string; message: string; invoice: any }>('/api/admissions', {
        method: 'POST',
        body: fd,
      })
      setDone({ reference: d.reference, invoice: d.invoice || null })
      toast({ title: 'تم استلام الطلب', description: 'سدد رسوم التقديم (30$) ليُحوَّل ملفك للإدارة للدراسة' })
    } catch (err: any) {
      if (err?.data?.missing?.length) setMissingDocs(err.data.missing)
      toast({ title: 'تعذر تقديم الطلب', description: err.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  // سداد رسوم التقديم فور التقديم (الخطوة 4 من دليل الإجراءات)
  const payApplicationFee = async () => {
    if (!done?.invoice) return
    setPaying(true)
    try {
      // محاولة الدفع الحقيقي عبر المزود (Stripe/PayPal) — يُعاد رابط عند وضع LIVE
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
      setPayOpen(false)
      setPaidRef(done.reference)
      toast({ title: 'تم سداد رسوم التقديم بنجاح', description: 'أُحوِّل ملفك للإدارة للدراسة — تابع حالة طلبك بكود التتبع' })
    } catch (e: any) {
      toast({ title: 'خطأ في الدفع', description: e.message, variant: 'destructive' })
    } finally {
      setPaying(false)
    }
  }

  const track = async (e?: React.FormEvent) => {
    e?.preventDefault()
    setTracking(true)
    setTrackError('')
    setTracked(null)
    try {
      const d = await api<{ application: any }>(`/api/admissions?ref=${encodeURIComponent(trackRef.trim())}`)
      setTracked(d.application)
    } catch (e: any) {
      setTrackError(e.message)
    } finally {
      setTracking(false)
    }
  }

  // سداد أي فاتورة (رسوم تقديم / رسوم دراسية) من شاشة التتبع بالكود المرجعي
  const payTracked = async () => {
    if (!trackPayTarget || !tracked) return
    setTrackPaying(true)
    try {
      // دفع حقيقي عبر المزود إن كانت المفاتيح مهيأة — وإلا تأكيد آمن داخل المنصة
      const co = await api<{ redirectUrl: string | null }>('/api/payments/checkout', {
        method: 'POST',
        body: JSON.stringify({ invoiceNo: trackPayTarget.invoiceNo, method: payMethod }),
      }).catch(() => null)
      if (co?.redirectUrl) {
        window.location.href = co.redirectUrl
        return
      }
      await api('/api/payments', {
        method: 'POST',
        body: JSON.stringify({ invoiceNo: trackPayTarget.invoiceNo, method: payMethod }),
      })
      const d = await api<{ application: any }>(`/api/admissions?ref=${encodeURIComponent(tracked.reference)}`)
      setTracked(d.application)
      setTrackPayTarget(null)
      toast({
        title: 'تم الدفع بنجاح',
        description: trackPayTarget.purpose === 'APPLICATION_FEE'
          ? 'سُددت رسوم التقديم — أُحوِّل ملفك للإدارة للدراسة'
          : 'سُددت الرسوم الدراسية — تم تفعيل تسجيلك النهائي في البرنامج',
      })
    } catch (e: any) {
      toast({ title: 'خطأ في الدفع', description: e.message, variant: 'destructive' })
    } finally {
      setTrackPaying(false)
    }
  }

  const trackedIdx = tracked ? statusIndex(tracked.status) : -1

  return (
    <div className="aact-fade-in mx-auto max-w-6xl px-4 py-10">
      {/* Header */}
      <div className="mb-8 text-center">
        <Badge className="mb-3 border-[#c9a227]/50 bg-[#c9a227]/10 text-[#a8841a] hover:bg-[#c9a227]/10">
          <ClipboardList className="ml-1 h-3.5 w-3.5" /> دليل إجراءات وشروط الالتحاق
        </Badge>
        <h1 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">
          الالتحاق ببرامج الأكاديمية الأمريكية للاستشارات والتدريب
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
          درجة / الدبلومات والبرامج الدولية / الماجستير / الدكتوراه المهنية — درجة علمية معادلة
          خبرات تدريبية في مجال التدريب المهني (ليست مرتبطة بالنظام الأكاديمي الحكومي).
        </p>
      </div>

      <Tabs defaultValue="apply" dir="rtl" className="w-full">
        <TabsList className="mx-auto grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="apply" className="text-xs font-bold sm:text-sm">طلب الالتحاق</TabsTrigger>
          <TabsTrigger value="track" className="text-xs font-bold sm:text-sm">تتبع طلبك</TabsTrigger>
        </TabsList>

        {/* ===== تبويب طلب الالتحاق ===== */}
        <TabsContent value="apply">
          {/* خطوات التسجيل الرسمية (وفق الدليل) */}
          <Card className="mt-6 border-[#0f2b46]/10 bg-white">
            <CardContent className="p-5">
              <h2 className="mb-4 flex items-center gap-2 text-base font-black text-[#0f2b46]">
                <ListOrdered className="h-5 w-5 text-[#c9a227]" /> إجراءات وخطوات التسجيل
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {ADMISSION_GUIDE.steps.map((s, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-slate-50/60 p-3.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#0f2b46] text-xs font-black text-[#e0b83a]">
                      {i + 1}
                    </span>
                    <span className="text-xs font-semibold leading-relaxed text-slate-700">{s}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* شروط القبول والوثائق */}
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="border-[#0f2b46]/10 bg-white">
              <CardContent className="p-5">
                <h2 className="mb-3 flex items-center gap-2 text-base font-black text-[#0f2b46]">
                  <ShieldAlert className="h-5 w-5 text-[#c9a227]" /> شروط القبول الأساسية
                </h2>
                <ul className="space-y-2.5">
                  {ADMISSION_GUIDE.conditions.map((c, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-slate-600 sm:text-sm">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      {c}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <Card className="border-[#0f2b46]/10 bg-white">
              <CardContent className="p-5">
                <h2 className="mb-3 flex items-center gap-2 text-base font-black text-[#0f2b46]">
                  <FileText className="h-5 w-5 text-[#c9a227]" /> الوثائق الرسمية المطلوبة
                </h2>
                <ul className="space-y-2.5">
                  {DOCS.map((d, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-slate-600 sm:text-sm">
                      <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#c9a227]" />
                      {d}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>

          {/* الرسوم المالية */}
          <Card className="mt-4 border-[#c9a227]/40 bg-[#f7edd0]/40">
            <CardContent className="p-5">
              <h2 className="mb-4 flex items-center gap-2 text-base font-black text-[#0f2b46]">
                <Banknote className="h-5 w-5 text-[#a8841a]" /> التكلفة المالية للبرامج
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {FEES_ROWS.map((r) => (
                  <div key={r.program} className="flex items-center justify-between gap-3 rounded-xl border border-[#c9a227]/30 bg-white px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="rounded-lg bg-[#0f2b46] p-1.5 text-[#e0b83a]">
                        <r.icon className="h-4 w-4" />
                      </div>
                      <span className="text-xs font-bold text-slate-700 sm:text-sm">{r.program}</span>
                    </div>
                    <span className="shrink-0 text-sm font-black text-[#a8841a]">{r.fee}</span>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-slate-500">{ADMISSION_GUIDE.note}</p>
            </CardContent>
          </Card>

          {/* شريط خطوات النموذج: 1 بيانات كاملة ← 2 وثائق ← 3 إقرار ← 4 دفع 30$ */}
          {!done && (
            <div className="mx-auto mt-6 grid max-w-3xl grid-cols-4 gap-2">
              {[
                { n: 1, t: 'بيانات كاملة' },
                { n: 2, t: 'رفع الوثائق' },
                { n: 3, t: 'الإقرار' },
                { n: 4, t: 'دفع 30$ والتقديم' },
              ].map((s) => (
                <div key={s.n} className="flex flex-col items-center gap-1.5 rounded-xl border border-[#c9a227]/30 bg-white p-3 text-center">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0f2b46] text-[10px] font-black text-[#e0b83a]">{s.n}</span>
                  <span className="text-[10px] font-black leading-tight text-[#0f2b46]">{s.t}</span>
                </div>
              ))}
            </div>
          )}

          {/* النتيجة بعد التقديم: كود التتبع + سداد رسوم التقديم فوراً */}
          {done ? (
            <Card className="mx-auto mt-6 max-w-2xl border-emerald-200 bg-emerald-50/50">
              <CardContent className="p-8 text-center">
                {paidRef ? (
                  <CheckCircle2 className="mx-auto mb-4 h-14 w-14 text-emerald-600" />
                ) : (
                  <Clock3 className="mx-auto mb-4 h-14 w-14 text-amber-500" />
                )}
                {paidRef ? (
                  <h2 className="text-xl font-black text-emerald-700">تم سداد رسوم التقديم — ملفك الآن قيد دراسة الإدارة!</h2>
                ) : (
                  <h2 className="text-xl font-black text-[#0f2b46]">تم استلام طلب الالتحاق! تبقى خطوة واحدة</h2>
                )}
                <div className="mx-auto mt-4 w-fit rounded-xl border border-emerald-200 bg-white px-6 py-4">
                  <div className="text-xs font-bold text-slate-500">كود تتبع حالة طلبك</div>
                  <div className="mt-1 font-mono text-2xl font-black tracking-wider text-[#0f2b46]" dir="ltr">
                    {done.reference}
                  </div>
                  <p className="mt-2 text-[10px] font-bold text-slate-400">احفظ هذا الكود — به تتابع مراحل طلبك في تبويب «تتبع طلبك»</p>
                </div>
                {!paidRef && done.invoice && (
                  <>
                    <div className="mx-auto mt-4 max-w-md rounded-xl border border-amber-200 bg-amber-50 p-4">
                      <p className="text-xs font-bold leading-relaxed text-amber-700">
                        <Banknote className="ml-1 inline h-4 w-4" />
                        الخطوة الأخيرة: سدد رسوم التقديم وحجز المقعد ({done.invoice.amount}$ غير مستردة) ليُحوَّل ملفك للإدارة
                        للدراسة وتعيين المشرف — وبعد الإقرار بقبولك تسدد الرسوم الدراسية كاملة للدخول للبرنامج.
                      </p>
                    </div>
                    <Button onClick={() => setPayOpen(true)} className="mt-4 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                      <CreditCard className="ml-2 h-4 w-4" /> ادفع رسوم التقديم {done.invoice.amount}$ الآن
                    </Button>
                  </>
                )}
                {paidRef && (
                  <p className="mx-auto mt-4 max-w-md text-sm leading-relaxed text-emerald-800">
                    وصل طلبك للإدارة لدراسة الملف وتعيين مشرفك. عند الإقرار بقبولك ستصلك إشعار لسداد الرسوم
                    الدراسية كاملة — وسيُفعَّل تسجيلك النهائي في البرنامج تلقائياً فور السداد.
                  </p>
                )}
                <p className="mt-3 text-xs font-bold text-emerald-600">
                  للاستفسار: {ACADEMY_INFO.email} — واتساب: {ACADEMY_INFO.whatsapp}
                </p>
                <Button variant="outline" className="mt-6 border-[#0f2b46]/20 font-bold text-[#0f2b46]" onClick={() => { setDone(null); setPaidRef(null) }}>
                  تقديم طلب آخر
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card className="mx-auto mt-6 max-w-3xl border-[#0f2b46]/15 shadow-xl">
              <CardContent className="p-6 sm:p-8">
                <h2 className="mb-1 text-lg font-black text-[#0f2b46]">نموذج طلب القبول الإلكتروني</h2>
                <p className="mb-6 text-xs text-slate-500">أكمل البيانات التالية بدقة لدراسة ملفك والالتحاق بالبرنامج</p>
                <form onSubmit={submit} className="space-y-5">
                  {/* ===== الخطوة 1: بيانات كاملة ===== */}
                  <div className="rounded-xl border border-[#c9a227]/40 bg-white">
                    <div className="flex items-center gap-2 border-b border-[#c9a227]/30 bg-[#f7edd0]/50 px-4 py-2.5">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0f2b46] text-[11px] font-black text-[#e0b83a]">1</span>
                      <h3 className="text-sm font-black text-[#0f2b46]">البيانات الشخصية الكاملة (كما في الوثائق الرسمية)</h3>
                    </div>
                    <div className="space-y-4 p-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="ad-name">الاسم الكامل (كما في الشهادة) *</Label>
                          <Input id="ad-name" required placeholder="الاسم الثلاثي"
                            value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ad-nid" className="flex items-center gap-1"><IdCard className="h-3.5 w-3.5 text-[#a8841a]" /> رقم الهوية / جواز السفر *</Label>
                          <Input id="ad-nid" required dir="ltr" className="text-left" placeholder="مثال: 402XXXXXX"
                            value={form.nationalId} onChange={(e) => setForm({ ...form, nationalId: e.target.value })} />
                        </div>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-3">
                        <div className="space-y-2">
                          <Label htmlFor="ad-country">الدولة *</Label>
                          <Input id="ad-country" required placeholder="مثال: فلسطين"
                            value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ad-birth" className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5 text-[#a8841a]" /> تاريخ الميلاد</Label>
                          <Input id="ad-birth" type="date" dir="ltr" className="text-left"
                            value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ad-address" className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5 text-[#a8841a]" /> العنوان</Label>
                          <Input id="ad-address" placeholder="المدينة — العنوان"
                            value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                        </div>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="ad-email">البريد الإلكتروني *</Label>
                          <Input id="ad-email" type="email" required dir="ltr" className="text-left" placeholder="you@example.com"
                            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ad-phone">الهاتف / واتساب *</Label>
                          <Input id="ad-phone" required dir="ltr" className="text-left" placeholder="+9705xxxxxxxx"
                            value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                        </div>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label>المؤهل العلمي *</Label>
                          <Select value={form.education} onValueChange={(v) => setForm({ ...form, education: v })}>
                            <SelectTrigger className="w-full"><SelectValue placeholder="اختر المؤهل" /></SelectTrigger>
                            <SelectContent>
                              {Object.entries(EDUCATION_LABEL).map(([k, v]) => (
                                <SelectItem key={k} value={k}>{v}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>البرنامج المرغوب *</Label>
                          <Select value={form.program} onValueChange={(v) => setForm({ ...form, program: v })}>
                            <SelectTrigger className="w-full"><SelectValue placeholder="اختر البرنامج" /></SelectTrigger>
                            <SelectContent className="max-h-72">
                              {programs.map((p) => (
                                <SelectItem key={p.id} value={p.titleAr}>
                                  {p.titleAr} {p.price != null ? `— ${p.price}$` : ''}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* متطلبات قبول مخصصة لهذا البرنامج (يضبطها مدير البرنامج — يطبقها خبير القبول الذكي) */}
                  {selectedRules && (selectedRules.displayNote || selectedRules.customRules || selectedRules.minEducation || selectedRules.minAge || selectedRules.minYearsExperience) && (
                    <div className="rounded-xl border border-[#c9a227]/50 bg-[#f7edd0]/60 p-4">
                      <p className="mb-2 flex items-center gap-1.5 text-xs font-black text-[#a8841a]">
                        <Sparkles className="h-4 w-4" />
                        شروط خاصة ببرنامج «{form.program}» — يتحقق منها خبير القبول الذكي آلياً
                      </p>
                      <ul className="space-y-1 text-[11px] leading-relaxed text-[#0f2b46]">
                        {selectedRules.minEducation && (
                          <li className="flex items-start gap-1.5">
                            <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#a8841a]" />
                            الحد الأدنى للمؤهل: {EDU_MIN_AR[selectedRules.minEducation] || selectedRules.minEducation}
                          </li>
                        )}
                        {selectedRules.minAge && (
                          <li className="flex items-start gap-1.5">
                            <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#a8841a]" />
                            الحد الأدنى للعمر: {selectedRules.minAge} سنة
                          </li>
                        )}
                        {selectedRules.minYearsExperience && (
                          <li className="flex items-start gap-1.5">
                            <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#a8841a]" />
                            حد أدنى للخبرة العملية: {selectedRules.minYearsExperience} سنوات (يُطلب إثباتها)
                          </li>
                        )}
                        {selectedRules.customRules && (
                          <li className="flex items-start gap-1.5 whitespace-pre-line">
                            <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#a8841a]" />
                            {selectedRules.customRules}
                          </li>
                        )}
                        {selectedRules.displayNote && (
                          <li className="flex items-start gap-1.5">
                            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#0f2b46]" />
                            {selectedRules.displayNote}
                          </li>
                        )}
                      </ul>
                    </div>
                  )}

                  {/* ===== الخطوة 2: رفع المستندات الإلزامية ===== */}
                  <div className="rounded-xl border border-[#c9a227]/40 bg-white">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#c9a227]/30 bg-[#f7edd0]/50 px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0f2b46] text-[11px] font-black text-[#e0b83a]">2</span>
                        <h3 className="text-sm font-black text-[#0f2b46]">إرفاق الوثائق الرسمية المطلوبة (إلزامي — لا يُقبل الطلب بدونها)</h3>
                      </div>
                      <Badge className={allDocsUploaded ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>
                        {REQUIRED_DOCS.filter((d) => files[d.type]).length} / {REQUIRED_DOCS.length} مكتملة
                      </Badge>
                    </div>
                    <div className="p-4">
                      <p className="mb-3 text-[11px] text-slate-500">الصيغ المسموحة: صور / PDF / Word DOCX / Excel / TXT / CSV — الحد الأقصى {MAX_FILE_MB} ميجابايت للملف</p>
                      <div className="grid gap-2.5 sm:grid-cols-2">
                        {REQUIRED_DOCS.map((d) => {
                          const f = files[d.type]
                          return (
                            <div
                              key={d.type}
                              className={`rounded-xl border p-3 transition-colors ${f ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 bg-white hover:border-[#c9a227]'}`}
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-black leading-relaxed text-[#0f2b46]">{d.label}</p>
                                  {f ? (
                                    <p className="mt-1 flex items-center gap-1 text-[11px] font-bold text-emerald-700">
                                      <Paperclip className="h-3 w-3" /> {f.name} ({fmtSize(f.size)})
                                    </p>
                                  ) : (
                                    <p className="mt-1 text-[11px] font-bold text-red-500">لم يُرفع بعد — مطلوب</p>
                                  )}
                                </div>
                                <div className="flex shrink-0 flex-col gap-1.5">
                                  <input
                                    ref={(el) => { fileInputs.current[d.type] = el }}
                                    type="file"
                                    accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv,.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,.docx,.xlsx,.xls,.txt,.csv"
                                    className="hidden"
                                    onChange={(e) => pickFile(d.type, e.target.files?.[0] || null)}
                                  />
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant={f ? 'outline' : 'default'}
                                    onClick={() => fileInputs.current[d.type]?.click()}
                                    className={f ? 'border-emerald-300 text-emerald-700' : 'bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#12365c]'}
                                  >
                                    <UploadCloud className="ml-1 h-3.5 w-3.5" /> {f ? 'تغيير' : 'رفع'}
                                  </Button>
                                  {f && (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => pickFile(d.type, null)}
                                      className="h-7 text-red-500 hover:text-red-600"
                                    >
                                      <Trash2 className="ml-1 h-3 w-3" /> إزالة
                                    </Button>
                                  )}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                      {missingDocs.length > 0 && (
                        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold leading-relaxed text-red-600">
                          <FileWarning className="ml-1 inline h-4 w-4" />
                          لا يمكن تقديم الطلب — المستندات الناقصة:
                          <ul className="mt-1 list-inside list-disc">
                            {missingDocs.map((m) => <li key={m}>{m}</li>)}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ملاحظات إضافية */}
                  <div className="space-y-2">
                    <Label htmlFor="ad-notes">ملاحظات إضافية (اختياري)</Label>
                    <Textarea id="ad-notes" className="min-h-20" placeholder="أي معلومات تود إضافتها لملفك: خبرات، تخصص دقيق، طريقة التواصل المفضلة..."
                      value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                  </div>

                  {/* ===== الخطوة 3: الإقرار ===== */}
                  <div className="rounded-xl border-2 border-[#c9a227]/60 bg-[#f7edd0]/60">
                    <div className="flex items-center gap-2 border-b border-[#c9a227]/40 px-4 py-2.5">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0f2b46] text-[11px] font-black text-[#e0b83a]">3</span>
                      <h3 className="text-sm font-black text-[#0f2b46]">إقرار الطالب (إلزامي)</h3>
                    </div>
                    <div className="p-4">
                      <p className="text-xs leading-relaxed text-[#5c4d1a]">
                        أقر أنا الطالب بأن جميع البيانات والوثائق المقدمة صحيحة وغير منسوخة أو مزورة، وأتعهد بتقديم بحث
                        التخرج ومناقشته في مدة من (3-6) شهور كحد أقصى، وأقر بالاطلاع على دليل الإجراءات والموافقة على
                        سداد رسوم التقديم وحجز المقعد ({ADMISSION_FEES.applicationFee}$ غير مستردة) عند التقديم، ثم سداد
                        الرسوم الدراسية كاملة بعد الإقرار بقبولي للدخول للبرنامج.
                      </p>
                      <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-xl bg-white p-3">
                        <Checkbox checked={acknowledged} onCheckedChange={(v) => setAcknowledged(v === true)} className="mt-0.5" />
                        <span className="text-xs font-black leading-relaxed text-[#0f2b46]">
                          أوافق على الإقرار أعلاه بشروط الأكاديمية وأتحقق بمسؤوليتها القانونية
                        </span>
                      </label>
                    </div>
                  </div>

                  {/* ===== الخطوة 4: التقديم وسداد رسوم التقديم ===== */}
                  <div className="rounded-xl border border-[#0f2b46]/15 bg-slate-50/70 p-4">
                    <div className="flex items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#0f2b46] text-[11px] font-black text-[#e0b83a]">4</span>
                      <p className="text-xs font-bold leading-relaxed text-slate-600">
                        عند التقديم سيُصدر كود تتبع لطلبك وفاتورة رسوم التقديم وحجز المقعد ({ADMISSION_FEES.applicationFee}$
                        غير مستردة) — بعد سدادها يُحوَّل ملفك تلقائياً للإدارة للدراسة وتعيين المشرف، وبعد الإقرار بقبولك
                        تسدد الرسوم الدراسية كاملة لتفعيل التسجيل النهائي.
                      </p>
                    </div>
                  </div>

                  <Button type="submit" disabled={loading} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                    {loading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4 rotate-180" />}
                    {allDocsUploaded && acknowledged ? 'تقديم طلب الالتحاق وإصدار فاتورة رسوم التقديم' : 'أكمل البيانات والوثائق والإقرار أولاً'}
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ===== تبويب التتبع ===== */}
        <TabsContent value="track">
          <Card className="mx-auto mt-6 max-w-2xl border-[#0f2b46]/15 shadow-xl">
            <CardContent className="p-6 sm:p-8">
              <h2 className="mb-1 flex items-center gap-2 text-lg font-black text-[#0f2b46]">
                <Milestone className="h-5 w-5 text-[#c9a227]" /> تتبع حالة طلب الالتحاق
              </h2>
              <p className="mb-6 text-xs text-slate-500">أدخل كود التتبع الذي استلمته عند تقديم الطلب (مثال: AACT-2026-1234)</p>
              <form onSubmit={track} className="flex flex-col gap-3 sm:flex-row">
                <Input dir="ltr" className="flex-1 text-left font-mono" placeholder="AACT-2026-XXXX"
                  value={trackRef} onChange={(e) => setTrackRef(e.target.value)} required />
                <Button type="submit" disabled={tracking} className="bg-[#0f2b46] font-bold text-[#f5f0e1] hover:bg-[#12365c]">
                  {tracking ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Search className="ml-1 h-4 w-4" />}
                  بحث
                </Button>
              </form>

              {trackError && (
                <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-600">
                  {trackError}
                </div>
              )}

              {tracked && (
                <div className="mt-6 space-y-4">
                  {/* بطاقة الطلب */}
                  <div className="rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/40 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <div className="font-mono text-xs font-bold text-slate-500" dir="ltr">{tracked.reference}</div>
                        <div className="mt-1 text-base font-black text-[#0f2b46]">{tracked.fullName}</div>
                        <div className="text-xs font-semibold text-slate-600">{tracked.program}</div>
                      </div>
                      <span className={`rounded-full px-4 py-1.5 text-xs font-black ${STATUS_LABEL[tracked.status]?.cls || 'bg-slate-100 text-slate-600'}`}>
                        {STATUS_LABEL[tracked.status]?.text || tracked.statusLabel || tracked.status}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500">
                      <Clock3 className="h-3.5 w-3.5" />
                      تاريخ التقديم: {new Date(tracked.createdAt).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' })}
                    </div>
                    {tracked.documents?.length > 0 && (
                      <p className="mt-1.5 flex items-center gap-1 text-[11px] font-bold text-emerald-700">
                        <Paperclip className="h-3.5 w-3.5" /> المستندات المرفوعة: {tracked.documents.length}/4
                      </p>
                    )}
                    {tracked.supervisorName && (
                      <p className="mt-1.5 flex items-center gap-1 text-[11px] font-bold text-purple-600">
                        <UserCheck className="h-3.5 w-3.5" /> المشرف الأكاديمي: {tracked.supervisorName}
                      </p>
                    )}
                    {tracked.status === 'REJECTED' && (
                      <div className="mt-4 rounded-lg bg-red-50 p-3 text-xs font-bold text-red-600">
                        نأسف — لم يُقبَل طلبك بعد دراسته. يمكنك التواصل مع الإدارة لمعرفة التفاصيل.
                      </div>
                    )}
                  </div>

                  {/* الخط الزمني للمراحل */}
                  {tracked.status !== 'REJECTED' && (
                    <div className="rounded-xl border border-slate-200 bg-white p-5">
                      <h3 className="mb-4 text-sm font-black text-[#0f2b46]">مراحل طلبك وفق دليل الإجراءات</h3>
                      <ol className="space-y-0">
                        {TIMELINE.map((t, i) => {
                          const doneStep = i < trackedIdx
                          const current = i === trackedIdx
                          return (
                            <li key={t.key} className="flex gap-3">
                              <div className="flex flex-col items-center">
                                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${
                                  doneStep ? 'bg-emerald-500 text-white' : current ? 'bg-[#c9a227] text-[#0f2b46]' : 'bg-slate-200 text-slate-400'
                                }`}>
                                  {doneStep ? '✓' : i + 1}
                                </span>
                                {i < TIMELINE.length - 1 && <span className={`h-8 w-0.5 ${doneStep ? 'bg-emerald-400' : 'bg-slate-200'}`} />}
                              </div>
                              <div className="pb-1">
                                <p className={`text-xs font-black leading-relaxed ${current ? 'text-[#a8841a]' : doneStep ? 'text-emerald-700' : 'text-slate-400'}`}>
                                  {t.label} {current && '— المرحلة الحالية'}
                                </p>
                              </div>
                            </li>
                          )
                        })}
                      </ol>
                    </div>
                  )}

                  {/* الفواتير مع أزرار السداد (بالمرجع حتى بدون تسجيل دخول) */}
                  {tracked.payments?.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-sm font-black text-[#0f2b46]">فواتير الطلب</h3>
                      {tracked.payments.map((inv: TrackedInvoice) => (
                        <div key={inv.invoiceNo} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5 ${
                          inv.status === 'PAID' ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/50'
                        }`}>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-md bg-[#0f2b46] px-2 py-0.5 font-mono text-[10px] font-bold text-[#e0b83a]" dir="ltr">{inv.invoiceNo}</span>
                              <span className="text-xs font-black text-[#0f2b46]">{inv.description}</span>
                            </div>
                            <p className="mt-1 text-[11px] font-bold text-slate-500">
                              {inv.status === 'PAID' ? 'مسددة ✓' : 'بانتظار السداد'}
                              {inv.purpose === 'APPLICATION_FEE' ? ' — رسوم التقديم وحجز المقعد (غير مستردة)' : ' — الرسوم الدراسية الكاملة للدخول للبرنامج'}
                            </p>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-base font-black text-[#0f2b46]">{inv.amount}$</span>
                            {inv.status === 'UNPAID' && (
                              <Button size="sm" onClick={() => { setPayMethod('PAYMOB'); setTrackPayTarget(inv) }} className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                                <CreditCard className="ml-1 h-3.5 w-3.5" /> ادفع الآن
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {tracked.status === 'AWAITING_FEE' && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs font-bold leading-relaxed text-amber-700">
                      <Info className="ml-1 inline h-4 w-4" />
                      طلبك مسجل لكن لم تُسدد رسوم التقديم (30$) بعد — سددها من الفواتير أعلاه ليُحوَّل ملفك للإدارة للدراسة.
                    </div>
                  )}
                  {tracked.status === 'AWAITING_TUITION' && (
                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-xs font-bold leading-relaxed text-emerald-700">
                      <UserCheck className="ml-1 inline h-4 w-4" />
                      مبروك! تم الإقرار بقبولك — سدد الرسوم الدراسية كاملة من الفواتير أعلاه لتفعيل تسجيلك النهائي والدخول للبرنامج.
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* نافذة سداد فاتورة من شاشة التتبع */}
          <Dialog open={!!trackPayTarget} onOpenChange={(v) => !v && setTrackPayTarget(null)}>
            <DialogContent className="max-w-md" dir="rtl">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
                  <Landmark className="h-5 w-5 text-[#c9a227]" /> إتمام الدفع الإلكتروني
                </DialogTitle>
                <DialogDescription>
                  {trackPayTarget?.description} — المبلغ <strong className="text-[#a8841a]">{trackPayTarget?.amount}$</strong>
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>اختر بوابة الدفع</Label>
                  <Select value={payMethod} onValueChange={setPayMethod}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PAYMOB">Paymob — بطاقة / محافظ مصر</SelectItem>
                      <SelectItem value="FAWRY">فوري Fawry — مراكز الدفع</SelectItem>
                      <SelectItem value="STRIPE">Stripe — بطاقة دولية</SelectItem>
                      <SelectItem value="PAYPAL">PayPal — خارج مصر</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-500">
                  <Info className="mb-1 h-3.5 w-3.5 text-[#c9a227]" />
                  بيئة تجريبية: يُصدر إيصال فوري ويرتبط الدفع تلقائياً بحالة طلبك — رسوم التقديم غير مستردة وفق الدليل.
                </div>
                <Button onClick={payTracked} disabled={trackPaying} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                  {trackPaying ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CreditCard className="ml-2 h-4 w-4" />}
                  ادفع {trackPayTarget?.amount}$ الآن
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </TabsContent>
      </Tabs>

      {/* نافذة سداد رسوم التقديم بعد التقديم مباشرة */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
              <Landmark className="h-5 w-5 text-[#c9a227]" /> سداد رسوم التقديم وحجز المقعد
            </DialogTitle>
            <DialogDescription>
              {done?.invoice?.description} — المبلغ <strong className="text-[#a8841a]">{done?.invoice?.amount}$</strong> (غير مستردة)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/50 p-3">
              <p className="text-xs font-bold leading-relaxed text-[#5c4d1a]">
                بعد السداد يُحوَّل ملفك تلقائياً للإدارة للدراسة وتعيين المشرف — وستصلك نتيجة الدراسة بكود التتبع {done?.reference}.
                بعد الإقرار بقبولك تسدد الرسوم الدراسية كاملة لتفعيل التسجيل النهائي في البرنامج.
              </p>
            </div>
            <div className="space-y-2">
              <Label>اختر بوابة الدفع</Label>
              <Select value={payMethod} onValueChange={setPayMethod}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PAYMOB">Paymob — بطاقة / محافظ مصر</SelectItem>
                  <SelectItem value="FAWRY">فوري Fawry — مراكز الدفع</SelectItem>
                  <SelectItem value="STRIPE">Stripe — بطاقة دولية</SelectItem>
                  <SelectItem value="PAYPAL">PayPal — خارج مصر</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={payApplicationFee} disabled={paying} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
              {paying ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CreditCard className="ml-2 h-4 w-4" />}
              ادفع {done?.invoice?.amount}$ وحوِّل ملفك للإدارة
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
