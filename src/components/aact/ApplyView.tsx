'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, useAppStore } from '@/lib/store'
import { ADMISSION_GUIDE, ADMISSION_FEES, ACADEMY_INFO } from '@/lib/academyData'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  BadgeCheck,
  Banknote,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  FileText,
  FileWarning,
  GraduationCap,
  IdCard,
  Info,
  Landmark,
  Loader2,
  MapPin,
  Paperclip,
  Search,
  Send,
  Sparkles,
  Trash2,
  UploadCloud,
} from 'lucide-react'

interface ProgramLite {
  id: string
  slug?: string
  titleAr: string
  titleEn?: string | null
  category: string
  categoryLabel?: string
  specialty?: string
  price?: number | null
  admissionRules?: {
    minEducation?: string
    minAge?: number
    minYearsExperience?: number
    customRules?: string
    displayNote?: string
  } | null
}

interface TrackedInvoice {
  invoiceNo: string
  purpose: string
  amount: number
  status: string
  description: string
  currency?: string
}

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

const EDU_MIN_AR: Record<string, string> = {
  HIGH_SCHOOL: 'الثانوية العامة',
  BACHELOR: 'البكالوريوس',
  MASTER: 'الماجستير',
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

const ALLOWED_FILE_MIME = [
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/plain', 'text/csv', 'application/csv',
]
const ALLOWED_FILE_RE = /\.(jpe?g|png|webp|heic|heif|pdf|docx|xlsx|xls|txt|csv)$/i

export function ApplyView() {
  const { toast } = useToast()
  const { user, applyProgramTitle, navigate } = useAppStore()
  const [programs, setPrograms] = useState<ProgramLite[]>([])
  const [selectedCategory, setSelectedCategory] = useState('')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState<{ reference: string; invoice: { invoiceNo: string; amount: number; description: string } | null } | null>(null)
  const [payOpen, setPayOpen] = useState(false)
  const [payMethod, setPayMethod] = useState('PAYMOB')
  const [paying, setPaying] = useState(false)
  const [paidRef, setPaidRef] = useState<string | null>(null)

  const [trackRef, setTrackRef] = useState('')
  const [tracking, setTracking] = useState(false)
  const [tracked, setTracked] = useState<any | null>(null)
  const [trackError, setTrackError] = useState('')
  const [trackPayTarget, setTrackPayTarget] = useState<TrackedInvoice | null>(null)
  const [trackPaying, setTrackPaying] = useState(false)
  const [myAdmissionLoading, setMyAdmissionLoading] = useState(false)
  const [myAdmission, setMyAdmission] = useState<any | null>(null)

  const [form, setForm] = useState({
    fullName: '',
    email: '',
    phone: '',
    country: '',
    nationalId: '',
    birthDate: '',
    address: '',
    education: 'BACHELOR',
    program: '',
    notes: '',
  })
  const [acknowledged, setAcknowledged] = useState(false)
  const [files, setFiles] = useState<Record<string, File>>({})
  const [missingDocs, setMissingDocs] = useState<string[]>([])
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})

  const allDocsUploaded = REQUIRED_DOCS.every((d) => files[d.type])

  useEffect(() => {
    api<{ programs: ProgramLite[] }>('/api/programs')
      .then((d) => setPrograms(d.programs || []))
      .catch(() => toast({ title: 'خطأ', description: 'تعذر تحميل البرامج', variant: 'destructive' }))
  }, [toast])

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

  useEffect(() => {
    if (!form.program || selectedCategory) return
    const p = programs.find((x) => x.titleAr === form.program)
    if (p) setSelectedCategory(p.category)
  }, [programs, form.program, selectedCategory])

  useEffect(() => {
    if (!user || user.role !== 'STUDENT') {
      setMyAdmission(null)
      setMyAdmissionLoading(false)
      return
    }
    let alive = true
    setMyAdmissionLoading(true)
    api<{ application: any | null; applications?: any[] }>('/api/admissions?mine=1')
      .then((d) => {
        if (!alive) return
        const app = d.application || null
        setMyAdmission(app)
        if (app?.reference) setTrackRef((v) => v || app.reference)
      })
      .catch(() => {
        if (alive) setMyAdmission(null)
      })
      .finally(() => {
        if (alive) setMyAdmissionLoading(false)
      })
    return () => { alive = false }
  }, [user?.id, user?.role])

  const availableCategories = useMemo(() => {
    const set = new Set(programs.map((p) => p.category).filter(Boolean))
    return PROGRAM_CATEGORY_ORDER.filter((c) => set.has(c)).concat([...set].filter((c) => !PROGRAM_CATEGORY_ORDER.includes(c)))
  }, [programs])

  const filteredPrograms = useMemo(
    () => (selectedCategory ? programs.filter((p) => p.category === selectedCategory) : []),
    [programs, selectedCategory]
  )

  const selectedProgram = useMemo(
    () => programs.find((p) => p.titleAr === form.program) || null,
    [programs, form.program]
  )
  const selectedProgramId = selectedProgram?.id || ''
  const selectedRules = selectedProgram?.admissionRules || null
  const canSubmitStudentApplication = !user || user.role === 'STUDENT'

  const pickFile = (type: string, f: File | null) => {
    setMissingDocs([])
    if (!f) {
      setFiles((prev) => {
        const next = { ...prev }
        delete next[type]
        return next
      })
      return
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      toast({ title: 'الملف كبير جداً', description: `الحد الأقصى ${MAX_FILE_MB} ميجابايت للملف الواحد`, variant: 'destructive' })
      return
    }
    if (f.type && !ALLOWED_FILE_MIME.includes(f.type) && !ALLOWED_FILE_RE.test(f.name)) {
      toast({ title: 'صيغة غير مدعومة', description: 'المسموح: صور / PDF / Word / Excel / TXT / CSV', variant: 'destructive' })
      return
    }
    setFiles((prev) => ({ ...prev, [type]: f }))
  }

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!canSubmitStudentApplication) {
      toast({ title: 'حساب إداري غير مخصص للدراسة', description: 'استخدم حساب طالب منفصل لتقديم طلب الالتحاق والدفع، ويمكن للإدارة متابعة الطالب من صفحة معاينة طالب.', variant: 'destructive' })
      return
    }
    if (!selectedCategory) {
      toast({ title: 'تنبيه', description: 'يرجى اختيار نوع البرنامج أولاً: ماجستير / دكتوراه / دبلوم', variant: 'destructive' })
      return
    }
    if (!form.program || !selectedProgramId) {
      toast({ title: 'تنبيه', description: 'يرجى اختيار التخصص أو البرنامج المرغوب', variant: 'destructive' })
      return
    }
    if (!form.nationalId.trim()) {
      toast({ title: 'تنبيه', description: 'يرجى إدخال رقم الهوية الشخصية أو جواز السفر', variant: 'destructive' })
      return
    }
    const missing = REQUIRED_DOCS.filter((d) => !files[d.type])
    if (missing.length > 0) {
      setMissingDocs(missing.map((m) => m.label))
      toast({ title: 'المستندات غير مكتملة', description: `يرجى رفع: ${missing.map((m) => m.label).join('، ')}`, variant: 'destructive' })
      return
    }
    if (!acknowledged) {
      toast({ title: 'الإقرار مطلوب', description: 'يجب الموافقة على إقرار الطالب قبل تقديم الطلب', variant: 'destructive' })
      return
    }

    setLoading(true)
    try {
      const fd = new FormData()
      Object.entries(form).forEach(([key, value]) => {
        if (value) fd.append(key, value)
      })
      fd.set('program', form.program)
      fd.append('programId', selectedProgramId)
      fd.append('acknowledged', 'true')
      for (const d of REQUIRED_DOCS) {
        const f = files[d.type]
        if (f) fd.append(`doc_${d.type}`, f)
      }
      const d = await api<{ reference: string; message: string; invoice: any }>('/api/admissions', { method: 'POST', body: fd })
      setDone({ reference: d.reference, invoice: d.invoice || null })
      toast({ title: 'تم استلام الطلب', description: 'سدد رسوم التقديم ليُحوَّل ملفك للإدارة للدراسة' })
    } catch (err: any) {
      if (err?.data?.missing?.length) setMissingDocs(err.data.missing)
      toast({ title: 'تعذر تقديم الطلب', description: err.message || 'حدث خطأ غير متوقع', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const payInvoice = async (invoiceNo: string, after?: () => Promise<void> | void) => {
    const checkout = await api<{ redirectUrl: string | null }>('/api/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({ invoiceNo, method: payMethod }),
    }).catch(() => null)
    if (checkout?.redirectUrl) {
      window.location.href = checkout.redirectUrl
      return
    }
    await api('/api/payments', {
      method: 'POST',
      body: JSON.stringify({ invoiceNo, method: payMethod }),
    })
    await after?.()
  }

  const payApplicationFee = async () => {
    if (!done?.invoice) return
    setPaying(true)
    try {
      await payInvoice(done.invoice.invoiceNo, () => {
        setPayOpen(false)
        setPaidRef(done.reference)
      })
      toast({ title: 'تم سداد رسوم التقديم بنجاح', description: 'أُحوِّل ملفك للإدارة للدراسة' })
    } catch (e: any) {
      toast({ title: 'خطأ في الدفع', description: e.message || 'تعذر إتمام الدفع', variant: 'destructive' })
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
      setTrackError(e.message || 'لم يتم العثور على الطلب')
    } finally {
      setTracking(false)
    }
  }

  const payTracked = async () => {
    if (!trackPayTarget || !tracked) return
    setTrackPaying(true)
    try {
      await payInvoice(trackPayTarget.invoiceNo, async () => {
        const d = await api<{ application: any }>(`/api/admissions?ref=${encodeURIComponent(tracked.reference)}`)
        setTracked(d.application)
        setMyAdmission((current: any) => current?.reference === d.application?.reference ? d.application : current)
        setTrackPayTarget(null)
      })
      toast({ title: 'تم الدفع بنجاح', description: 'تم تحديث حالة الطلب' })
    } catch (e: any) {
      toast({ title: 'خطأ في الدفع', description: e.message || 'تعذر إتمام الدفع', variant: 'destructive' })
    } finally {
      setTrackPaying(false)
    }
  }

  return (
    <div className="aact-fade-in mx-auto max-w-6xl px-4 py-10">
      <div className="mb-8 text-center">
        <Badge className="mb-3 border-[#c9a227]/50 bg-[#c9a227]/10 text-[#a8841a] hover:bg-[#c9a227]/10">
          <ClipboardList className="ml-1 h-3.5 w-3.5" /> دليل إجراءات وشروط الالتحاق
        </Badge>
        <h1 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">الالتحاق ببرامج الأكاديمية الأمريكية للاستشارات والتدريب</h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
          اختر الدرجة أولاً، ثم اختر التخصص. الماجستير والدكتوراه تُدار كتخصصات مستقلة، والكتب والاختبارات تُبنى على التخصص المختار تحديداً.
        </p>
      </div>

      <Tabs defaultValue="apply" dir="rtl" className="w-full">
        <TabsList className="mx-auto grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="apply" className="text-xs font-bold sm:text-sm">طلب الالتحاق</TabsTrigger>
          <TabsTrigger value="track" className="text-xs font-bold sm:text-sm">تتبع طلبك</TabsTrigger>
        </TabsList>

        <TabsContent value="apply">
          {done ? (
            <Card className="mx-auto mt-6 max-w-2xl border-emerald-200 bg-emerald-50/50">
              <CardContent className="p-8 text-center">
                {paidRef ? <CheckCircle2 className="mx-auto mb-4 h-14 w-14 text-emerald-600" /> : <Banknote className="mx-auto mb-4 h-14 w-14 text-amber-500" />}
                <h2 className="text-xl font-black text-[#0f2b46]">تم استلام طلب الالتحاق</h2>
                <div className="mx-auto mt-4 w-fit rounded-xl border border-emerald-200 bg-white px-6 py-4">
                  <div className="text-xs font-bold text-slate-500">كود تتبع حالة طلبك</div>
                  <div className="mt-1 font-mono text-2xl font-black tracking-wider text-[#0f2b46]" dir="ltr">{done.reference}</div>
                </div>
                {!paidRef && done.invoice && (
                  <>
                    <p className="mx-auto mt-4 max-w-md text-xs font-bold leading-relaxed text-amber-700">
                      تبقى سداد رسوم التقديم وحجز المقعد ({done.invoice.amount}$ غير مستردة) حتى يُحوَّل الملف للإدارة.
                    </p>
                    <Button onClick={() => setPayOpen(true)} className="mt-4 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                      <CreditCard className="ml-2 h-4 w-4" /> ادفع رسوم التقديم الآن
                    </Button>
                  </>
                )}
                {paidRef && <p className="mt-4 text-sm font-bold text-emerald-700">تم الدفع بنجاح — ملفك الآن قيد دراسة الإدارة.</p>}
              </CardContent>
            </Card>
          ) : (
            <Card className="mx-auto mt-6 max-w-3xl border-[#0f2b46]/15 shadow-xl">
              <CardContent className="p-6 sm:p-8">
                <h2 className="mb-1 text-lg font-black text-[#0f2b46]">نموذج طلب القبول الإلكتروني</h2>
                <p className="mb-6 text-xs text-slate-500">أكمل البيانات التالية بدقة لدراسة ملفك والالتحاق بالبرنامج.</p>

                {!canSubmitStudentApplication && (
                  <div className="mb-5 rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-bold leading-6 text-red-700">
                    <FileWarning className="ml-1 inline h-4 w-4" />
                    أنت داخل بحساب إدارة/مشرف. لا يتم تقديم طلبات الطلاب أو الدفع من حساب الإدارة حتى لا تختلط صلاحيات الإدارة بالسجل الأكاديمي. سجّل خروجك ثم أنشئ/ادخل بحساب طالب منفصل، وبعدها يمكن للإدارة متابعة الطالب من صفحة معاينة طالب.
                  </div>
                )}

                <form onSubmit={submit} className="space-y-5">
                  <section className="rounded-xl border border-[#c9a227]/40 bg-white">
                    <div className="border-b border-[#c9a227]/30 bg-[#f7edd0]/50 px-4 py-2.5">
                      <h3 className="text-sm font-black text-[#0f2b46]">1. البيانات الشخصية والبرنامج</h3>
                    </div>
                    <div className="space-y-4 p-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="ad-name">الاسم الكامل *</Label>
                          <Input id="ad-name" required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="الاسم الثلاثي كما في الوثائق" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ad-nid" className="flex items-center gap-1"><IdCard className="h-3.5 w-3.5 text-[#a8841a]" /> رقم الهوية / جواز السفر *</Label>
                          <Input id="ad-nid" required dir="ltr" className="text-left" value={form.nationalId} onChange={(e) => setForm({ ...form, nationalId: e.target.value })} />
                        </div>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-3">
                        <div className="space-y-2">
                          <Label htmlFor="ad-country">الدولة *</Label>
                          <Input id="ad-country" required value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="مثال: فلسطين" />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ad-birth" className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5 text-[#a8841a]" /> تاريخ الميلاد</Label>
                          <Input id="ad-birth" type="date" dir="ltr" className="text-left" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ad-address" className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5 text-[#a8841a]" /> العنوان</Label>
                          <Input id="ad-address" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
                        </div>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor="ad-email">البريد الإلكتروني *</Label>
                          <Input id="ad-email" type="email" required dir="ltr" className="text-left" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ad-phone">الهاتف / واتساب *</Label>
                          <Input id="ad-phone" required dir="ltr" className="text-left" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                        </div>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-3">
                        <div className="space-y-2">
                          <Label>المؤهل العلمي *</Label>
                          <Select value={form.education} onValueChange={(v) => setForm({ ...form, education: v })}>
                            <SelectTrigger><SelectValue placeholder="اختر المؤهل" /></SelectTrigger>
                            <SelectContent>
                              {Object.entries(EDUCATION_LABEL).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>نوع البرنامج / الدرجة *</Label>
                          <Select
                            value={selectedCategory}
                            onValueChange={(v) => {
                              setSelectedCategory(v)
                              setForm((f) => ({ ...f, program: '' }))
                            }}
                          >
                            <SelectTrigger><SelectValue placeholder="اختر ماجستير/دكتوراه/دبلوم" /></SelectTrigger>
                            <SelectContent>
                              {availableCategories.map((c) => <SelectItem key={c} value={c}>{PROGRAM_CATEGORY_LABEL[c] || c}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>{selectedCategory === 'MASTERS' || selectedCategory === 'DOCTORATE' ? 'التخصص المطلوب *' : 'البرنامج / الدبلوم *'}</Label>
                          <Select value={form.program} onValueChange={(v) => setForm({ ...form, program: v })} disabled={!selectedCategory}>
                            <SelectTrigger><SelectValue placeholder={selectedCategory ? 'اختر التخصص' : 'اختر نوع البرنامج أولاً'} /></SelectTrigger>
                            <SelectContent className="max-h-72">
                              {filteredPrograms.map((p) => (
                                <SelectItem key={p.id} value={p.titleAr}>
                                  {(p.category === 'MASTERS' || p.category === 'DOCTORATE') ? (p.specialty || p.titleAr) : p.titleAr} {p.price != null ? `— ${p.price}$` : ''}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      {selectedProgram && (selectedProgram.category === 'MASTERS' || selectedProgram.category === 'DOCTORATE') && (
                        <div className="rounded-xl border border-[#c9a227]/30 bg-[#f7edd0]/40 p-3 text-xs font-bold leading-relaxed text-[#0f2b46]">
                          اخترت: {PROGRAM_CATEGORY_LABEL[selectedProgram.category] || selectedProgram.category} — التخصص: {selectedProgram.specialty || selectedProgram.titleAr}. الكتب والاختبارات والمشرف الذكي ستُبنى على هذا التخصص تحديداً.
                        </div>
                      )}
                    </div>
                  </section>

                  {selectedRules && (selectedRules.displayNote || selectedRules.customRules || selectedRules.minEducation || selectedRules.minAge || selectedRules.minYearsExperience) && (
                    <section className="rounded-xl border border-[#c9a227]/50 bg-[#f7edd0]/60 p-4">
                      <p className="mb-2 flex items-center gap-1.5 text-xs font-black text-[#a8841a]"><Sparkles className="h-4 w-4" /> شروط خاصة بالبرنامج المختار</p>
                      <ul className="space-y-1 text-[11px] leading-relaxed text-[#0f2b46]">
                        {selectedRules.minEducation && <li>الحد الأدنى للمؤهل: {EDU_MIN_AR[selectedRules.minEducation] || selectedRules.minEducation}</li>}
                        {selectedRules.minAge && <li>الحد الأدنى للعمر: {selectedRules.minAge} سنة</li>}
                        {selectedRules.minYearsExperience && <li>حد أدنى للخبرة العملية: {selectedRules.minYearsExperience} سنوات</li>}
                        {selectedRules.customRules && <li className="whitespace-pre-line">{selectedRules.customRules}</li>}
                        {selectedRules.displayNote && <li>{selectedRules.displayNote}</li>}
                      </ul>
                    </section>
                  )}

                  <section className="rounded-xl border border-[#c9a227]/40 bg-white">
                    <div className="flex items-center justify-between gap-2 border-b border-[#c9a227]/30 bg-[#f7edd0]/50 px-4 py-2.5">
                      <h3 className="text-sm font-black text-[#0f2b46]">2. إرفاق الوثائق الرسمية المطلوبة</h3>
                      <Badge className={allDocsUploaded ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>
                        {REQUIRED_DOCS.filter((d) => files[d.type]).length} / {REQUIRED_DOCS.length}
                      </Badge>
                    </div>
                    <div className="p-4">
                      <p className="mb-3 text-[11px] text-slate-500">الصيغ المسموحة: صور / PDF / Word DOCX / Excel / TXT / CSV — الحد الأقصى {MAX_FILE_MB} ميجابايت للملف.</p>
                      <div className="grid gap-2.5 sm:grid-cols-2">
                        {REQUIRED_DOCS.map((d) => {
                          const f = files[d.type]
                          return (
                            <div key={d.type} className={`rounded-xl border p-3 ${f ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 bg-white'}`}>
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-black leading-relaxed text-[#0f2b46]">{d.label}</p>
                                  {f ? (
                                    <p className="mt-1 flex items-center gap-1 text-[11px] font-bold text-emerald-700"><Paperclip className="h-3 w-3" /> {f.name} ({fmtSize(f.size)})</p>
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
                                  <Button type="button" size="sm" variant={f ? 'outline' : 'default'} onClick={() => fileInputs.current[d.type]?.click()} className={f ? 'border-emerald-300 text-emerald-700' : 'bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#12365c]'}>
                                    <UploadCloud className="ml-1 h-3.5 w-3.5" /> {f ? 'تغيير' : 'رفع'}
                                  </Button>
                                  {f && (
                                    <Button type="button" size="sm" variant="ghost" onClick={() => pickFile(d.type, null)} className="h-7 text-red-500 hover:text-red-600">
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
                          <FileWarning className="ml-1 inline h-4 w-4" /> المستندات الناقصة: {missingDocs.join('، ')}
                        </div>
                      )}
                    </div>
                  </section>

                  <div className="space-y-2">
                    <Label htmlFor="ad-notes">ملاحظات إضافية</Label>
                    <Textarea id="ad-notes" className="min-h-20" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="خبرات، تخصص دقيق، طريقة التواصل المفضلة..." />
                  </div>

                  <section className="rounded-xl border-2 border-[#c9a227]/60 bg-[#f7edd0]/60 p-4">
                    <p className="text-xs leading-relaxed text-[#5c4d1a]">
                      أقر بأن البيانات والوثائق المقدمة صحيحة، وأوافق على شروط الأكاديمية وسداد رسوم التقديم وحجز المقعد ({ADMISSION_FEES.applicationFee}$ غير مستردة)، ثم سداد الرسوم الدراسية بعد القبول.
                    </p>
                    <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-xl bg-white p-3">
                      <Checkbox checked={acknowledged} onCheckedChange={(v) => setAcknowledged(v === true)} className="mt-0.5" />
                      <span className="text-xs font-black leading-relaxed text-[#0f2b46]">أوافق على الإقرار أعلاه</span>
                    </label>
                  </section>

                  <Button type="submit" disabled={loading || !canSubmitStudentApplication} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a] disabled:opacity-60">
                    {loading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4 rotate-180" />}
                    {canSubmitStudentApplication ? 'تقديم طلب الالتحاق وإصدار فاتورة رسوم التقديم' : 'يتطلب حساب طالب منفصل للتقديم'}
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="track">
          <Card className="mx-auto mt-6 max-w-2xl border-[#0f2b46]/15 shadow-xl">
            <CardContent className="p-6 sm:p-8">
              <h2 className="mb-1 flex items-center gap-2 text-lg font-black text-[#0f2b46]"><Search className="h-5 w-5 text-[#c9a227]" /> تتبع حالة طلب الالتحاق</h2>
              <p className="mb-6 text-xs text-slate-500">أدخل كود التتبع الذي استلمته عند تقديم الطلب.</p>
              <form onSubmit={track} className="flex flex-col gap-3 sm:flex-row">
                <Input dir="ltr" className="flex-1 text-left font-mono" placeholder="AACT-2026-XXXX" value={trackRef} onChange={(e) => setTrackRef(e.target.value)} required />
                <Button type="submit" disabled={tracking} className="bg-[#0f2b46] font-bold text-[#f5f0e1] hover:bg-[#12365c]">
                  {tracking ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Search className="ml-1 h-4 w-4" />} بحث
                </Button>
              </form>

              {trackError && <div className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-600">{trackError}</div>}

              {tracked && (
                <div className="mt-6 space-y-4">
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
                    {tracked.supervisorName && <p className="mt-2 text-xs font-bold text-purple-600">المشرف الأكاديمي: {tracked.supervisorName}</p>}
                  </div>

                  {tracked.payments?.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-sm font-black text-[#0f2b46]">فواتير الطلب</h3>
                      {tracked.payments.map((inv: TrackedInvoice) => (
                        <div key={inv.invoiceNo} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5 ${inv.status === 'PAID' ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
                          <div className="min-w-0">
                            <div className="rounded-md bg-[#0f2b46] px-2 py-0.5 font-mono text-[10px] font-bold text-[#e0b83a]" dir="ltr">{inv.invoiceNo}</div>
                            <p className="mt-1 text-xs font-black text-[#0f2b46]">{inv.description}</p>
                            <p className="mt-1 text-[11px] font-bold text-slate-500">{inv.status === 'PAID' ? 'مسددة ✓' : 'بانتظار السداد'}</p>
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
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]"><Landmark className="h-5 w-5 text-[#c9a227]" /> سداد رسوم التقديم</DialogTitle>
            <DialogDescription>{done?.invoice?.description} — المبلغ <strong className="text-[#a8841a]">{done?.invoice?.amount}$</strong></DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>اختر بوابة الدفع</Label>
              <Select value={payMethod} onValueChange={setPayMethod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PAYMOB">Paymob — بطاقة / محافظ مصر</SelectItem>
                  <SelectItem value="FAWRY">فوري Fawry — مراكز الدفع</SelectItem>
                  <SelectItem value="STRIPE">Stripe — بطاقة دولية</SelectItem>
                  <SelectItem value="PAYPAL">PayPal — خارج مصر</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={payApplicationFee} disabled={paying} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
              {paying ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CreditCard className="ml-2 h-4 w-4" />} ادفع الآن
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!trackPayTarget} onOpenChange={(v) => !v && setTrackPayTarget(null)}>
        <DialogContent className="max-w-md" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]"><Landmark className="h-5 w-5 text-[#c9a227]" /> إتمام الدفع الإلكتروني</DialogTitle>
            <DialogDescription>{trackPayTarget?.description} — المبلغ <strong className="text-[#a8841a]">{trackPayTarget?.amount}$</strong></DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>اختر بوابة الدفع</Label>
              <Select value={payMethod} onValueChange={setPayMethod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="PAYMOB">Paymob — بطاقة / محافظ مصر</SelectItem>
                  <SelectItem value="FAWRY">فوري Fawry — مراكز الدفع</SelectItem>
                  <SelectItem value="STRIPE">Stripe — بطاقة دولية</SelectItem>
                  <SelectItem value="PAYPAL">PayPal — خارج مصر</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={payTracked} disabled={trackPaying} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
              {trackPaying ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CreditCard className="ml-2 h-4 w-4" />} ادفع الآن
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="mx-auto mt-8 max-w-3xl rounded-xl border border-[#0f2b46]/10 bg-white p-4 text-xs leading-relaxed text-slate-500">
        <Info className="ml-1 inline h-4 w-4 text-[#c9a227]" />
        للاستفسار: {ACADEMY_INFO.email} — واتساب: {ACADEMY_INFO.whatsapp}. الوثائق المطلوبة وفق الدليل: {ADMISSION_GUIDE.documents.slice(0, 4).join('، ')}.
      </div>
    </div>
  )
}
