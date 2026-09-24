'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, useAppStore } from '@/lib/store'
import { ADMISSION_GUIDE, ADMISSION_FEES, ACADEMY_INFO } from '@/lib/academyData'
import { getServiceDocumentOptions, getServiceFlow } from '@/lib/service-flows'
import { SUPPORTED_COUNTRIES, normalizePhone, validateApplicantFullName, validateBirthDateForMinAge, validateNationalIdOrPassport, validatePhone } from '@/lib/admission-validation'
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
    requiredDocuments?: string[]
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
  createdAt?: string
  paidAt?: string | null
}

interface TrackedTuitionPlan {
  totalTuition: number
  paidTuition: number
  remainingTuition: number
  halfRequired?: number
  finalRequired?: number
}

const REQUIRED_DOCS = [
  { type: 'DEGREE', label: 'الشهادة الجامعية وكشف العلامات (أو الثانوية للدبلومات)' },
  { type: 'ID', label: 'الهوية الشخصية أو جواز السفر' },
  { type: 'PHOTO', label: 'صورة شخصية حديثة' },
  { type: 'CV', label: 'السيرة الذاتية (C.V)' },
]

const SERVICE_REQUEST_DOCS = [
  { type: 'ID', label: 'الهوية الشخصية أو جواز السفر عند الحاجة' },
  { type: 'CV', label: 'السيرة الذاتية أو نبذة عن الخبرة' },
  { type: 'SERVICE_FILE', label: 'ملف يوضح الاحتياج أو الوثائق الداعمة للخدمة' },
]

const EXTRA_DOCS = [
  { type: 'EXPERIENCE', label: 'إثبات خبرات عملية' },
  { type: 'TRANSCRIPT', label: 'كشف درجات منفصل' },
]

const MAX_FILE_MB = 4
const fmtSize = (b: number) => (b > 1024 * 1024 ? `${(b / 1048576).toFixed(1)} م.ب` : `${Math.ceil(b / 1024)} ك.ب`)
const invoiceTime = (p: TrackedInvoice) => new Date(p.paidAt || p.createdAt || 0).getTime() || 0
const sortInvoicesNewest = (items: TrackedInvoice[]) => [...items].sort((a, b) => invoiceTime(b) - invoiceTime(a))

const EDUCATION_LABEL: Record<string, string> = {
  HIGH_SCHOOL: 'ثانوية عامة أو ما يعادلها',
  BACHELOR: 'بكالوريوس (مهني أو أكاديمي)',
  MASTER: 'ماجستير',
  OTHER: 'أخرى',
}

const EDU_MIN_AR: Record<string, string> = {
  NONE: 'بلا شرط مؤهل للخدمة',
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
  SERVICE: 'الخدمات المهنية',
}
const PROGRAM_CATEGORY_ORDER = ['MASTERS', 'DOCTORATE', 'DIPLOMA', 'INTL_CERT', 'ACCREDITATION', 'SERVICE']
const PROGRAMS_CACHE_KEY = 'aact_programs_summary_v4'

function readCachedPrograms(): ProgramLite[] {
  if (typeof window === 'undefined') return []
  try {
    const cached = JSON.parse(localStorage.getItem(PROGRAMS_CACHE_KEY) || '[]')
    return Array.isArray(cached) ? cached : []
  } catch {
    return []
  }
}

function cachePrograms(list: ProgramLite[]) {
  if (typeof window === 'undefined' || !Array.isArray(list) || list.length === 0) return
  try {
    localStorage.setItem(PROGRAMS_CACHE_KEY, JSON.stringify(list.slice(0, 160)))
    localStorage.setItem('aact_program_count', String(list.length))
  } catch {}
}

const TERMINAL_APPLICATION_STATUSES = ['CERTIFIED', 'REJECTED', 'WITHDRAWN', 'CANCELLED']

function blocksNewApplication(app: any) {
  if (!app) return false
  if (TERMINAL_APPLICATION_STATUSES.includes(app.status)) return false
  // الخدمات العابرة لا تمنع تقديم خدمة/برنامج جديد؛ تظهر فقط في قائمة الطلبات السابقة والحالية.
  return app.isStudyProgram === true
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  UPLOADING_DOCUMENTS: { text: 'جاري رفع المستندات', cls: 'bg-blue-100 text-blue-700' },
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
  const [activeTab, setActiveTab] = useState('apply')
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState<{ reference: string; invoice: { invoiceNo: string; amount: number; description: string } | null } | null>(null)

  const [trackRef, setTrackRef] = useState('')
  const [tracking, setTracking] = useState(false)
  const [tracked, setTracked] = useState<any | null>(null)
  const [trackError, setTrackError] = useState('')
  const [myAdmissionLoading, setMyAdmissionLoading] = useState(false)
  const [myAdmission, setMyAdmission] = useState<any | null>(null)
  const [myApplications, setMyApplications] = useState<any[]>([])

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

  useEffect(() => {
    let alive = true
    let hadCache = false

    const cached = readCachedPrograms()
    if (cached.length) {
      hadCache = true
      setPrograms(cached)
    }

    fetch('/api/programs?summary=1&public=1', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ programs: ProgramLite[] }>
      })
      .then((d) => {
        if (!alive) return
        const list = Array.isArray(d.programs) ? d.programs : []
        setPrograms(list)
        cachePrograms(list)
      })
      .catch(() => {
        if (!alive || hadCache) return
        toast({ title: 'خطأ', description: 'تعذر تحميل البرامج', variant: 'destructive' })
      })

    return () => { alive = false }
  }, [toast])

  useEffect(() => {
    if (user) {
      setForm((f) => ({
        ...f,
        fullName: f.fullName || user.name,
        email: f.email || user.email,
        country: f.country || (user.country && SUPPORTED_COUNTRIES.includes(user.country) ? user.country : ''),
      }))
    }
    if (applyProgramTitle) {
      setForm((f) => ({ ...f, program: applyProgramTitle }))
      setActiveTab('apply')
    }
  }, [user, applyProgramTitle])

  useEffect(() => {
    if (!form.program || selectedCategory) return
    const p = programs.find((x) => x.titleAr === form.program)
    if (p) setSelectedCategory(p.category)
  }, [programs, form.program, selectedCategory])

  useEffect(() => {
    if (!user || user.role !== 'STUDENT') {
      setMyAdmission(null)
      setMyApplications([])
      setMyAdmissionLoading(false)
      return
    }
    let alive = true
    setMyAdmissionLoading(true)
    api<{ application: any | null; applications?: any[] }>('/api/admissions?mine=1')
      .then((d) => {
        if (!alive) return
        const apps = Array.isArray(d.applications) ? d.applications : (d.application ? [d.application] : [])
        const blockingApp = apps.find((app: any) => blocksNewApplication(app)) || null
        setMyApplications(apps)
        setMyAdmission(blockingApp)
        const preferredTrackApp = blockingApp || apps[0] || null
        if (preferredTrackApp?.reference) setTrackRef((v) => v || preferredTrackApp.reference)
      })
      .catch(() => {
        if (alive) {
          setMyAdmission(null)
          setMyApplications([])
        }
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
  const selectedFlow = getServiceFlow(selectedProgram?.slug)
  const isServiceRequest = selectedFlow ? !selectedFlow.isStudyProgram : selectedCategory === 'SERVICE'
  const selectedProgramId = selectedProgram?.id || ''
  const selectedRules = selectedProgram?.admissionRules || null
  const flowDocs = selectedFlow ? getServiceDocumentOptions(selectedFlow).map((d) => ({ type: d.type, label: d.label })) : []
  const docLabelMap = new Map([...REQUIRED_DOCS, ...SERVICE_REQUEST_DOCS, ...EXTRA_DOCS, ...flowDocs].map((d) => [d.type, d]))
  const ruleDocCodes = selectedRules?.requiredDocuments || []
  const activeDocs = ruleDocCodes.length
    ? ruleDocCodes.map((code) => docLabelMap.get(code) || { type: code, label: code })
    : selectedFlow ? (flowDocs.length ? flowDocs : SERVICE_REQUEST_DOCS) : isServiceRequest ? SERVICE_REQUEST_DOCS : REQUIRED_DOCS
  const requiredDocs = ruleDocCodes.length ? activeDocs : isServiceRequest ? [] : REQUIRED_DOCS
  const allDocsUploaded = requiredDocs.length === 0 || requiredDocs.every((d) => files[d.type])
  const canSubmitStudentApplication = !user || user.role === 'STUDENT'
  const recentApplications = myApplications.slice(0, 5)
  const openStudentPayments = (invoiceNo?: string | null) => {
    navigate('dashboard', { tab: 'payments', invoice: invoiceNo || undefined })
  }

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
      toast({ title: 'تنبيه', description: 'يرجى اختيار نوع الطلب أولاً: برنامج دراسي أو خدمة مهنية', variant: 'destructive' })
      return
    }
    if (!form.program || !selectedProgramId) {
      toast({ title: 'تنبيه', description: isServiceRequest ? 'يرجى اختيار الخدمة المطلوبة' : 'يرجى اختيار التخصص أو البرنامج المرغوب', variant: 'destructive' })
      return
    }
    const validationError = validateApplicantFullName(form.fullName, 3)
      || validatePhone(form.phone)
      || (!SUPPORTED_COUNTRIES.includes(form.country) ? 'يرجى اختيار الدولة من القائمة المعتمدة بدلاً من كتابتها يدوياً.' : null)
      || (!isServiceRequest ? validateNationalIdOrPassport(form.nationalId, form.country) : null)
      || (!isServiceRequest && selectedRules?.minAge ? validateBirthDateForMinAge(form.birthDate, Number(selectedRules.minAge)) : null)
    if (validationError) {
      toast({ title: 'راجع البيانات الشخصية', description: validationError, variant: 'destructive' })
      return
    }
    const missing = requiredDocs.filter((d) => !files[d.type])
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
      fd.set('fullName', form.fullName.trim().replace(/\s+/g, ' '))
      fd.set('phone', normalizePhone(form.phone))
      fd.append('programId', selectedProgramId)
      fd.append('acknowledged', 'true')
      fd.append('stagedUpload', 'true')

      // لا نرسل كل المرفقات دفعة واحدة حتى لا يصطدم الطلب بحد Vercel ويرجع HTTP 413.
      // ننشئ الطلب أولاً، ثم نرفع كل ملف في طلب مستقل، ثم نكمل التقديم ونصدر الفاتورة.
      const staged = await api<{ reference: string; applicationId: string; uploadToken: string; staged: boolean }>('/api/admissions', { method: 'POST', body: fd })
      const docsToUpload = activeDocs.filter((d) => files[d.type])
      for (let i = 0; i < docsToUpload.length; i++) {
        const d = docsToUpload[i]
        const uploadFd = new FormData()
        uploadFd.append('applicationId', staged.applicationId)
        uploadFd.append('reference', staged.reference)
        uploadFd.append('uploadToken', staged.uploadToken)
        uploadFd.append('docType', d.type)
        uploadFd.append('file', files[d.type])
        toast({ title: 'جاري رفع المستندات', description: `رفع ${i + 1} من ${docsToUpload.length}: ${d.label}` })
        await api('/api/admissions/files', { method: 'POST', body: uploadFd })
      }
      const d = await api<{ reference: string; message: string; invoice: any }>('/api/admissions/finalize', {
        method: 'POST',
        body: JSON.stringify({ applicationId: staged.applicationId, reference: staged.reference, uploadToken: staged.uploadToken }),
      })
      setDone({ reference: d.reference, invoice: d.invoice || null })
      try {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
        document.documentElement.scrollTop = 0
        document.body.scrollTop = 0
        requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }))
      } catch {}
      toast({ title: 'تم استلام الطلب', description: isServiceRequest ? 'تم تحويل طلب الخدمة للإدارة لتحديد المتطلبات والمتابعة' : 'سدد رسوم التقديم ليُحوَّل ملفك للإدارة للدراسة' })
    } catch (err: any) {
      if (err?.data?.missing?.length) setMissingDocs(err.data.missing)
      toast({ title: 'تعذر تقديم الطلب', description: err.message || 'حدث خطأ غير متوقع', variant: 'destructive' })
    } finally {
      setLoading(false)
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
      const result = await payInvoice(trackPayTarget.invoiceNo, async () => {
        const d = await api<{ application: any }>(`/api/admissions?ref=${encodeURIComponent(tracked.reference)}`)
        setTracked(d.application)
        setMyAdmission((current: any) => current?.reference === d.application?.reference ? d.application : current)
        setTrackPayTarget(null)
      })
      if (result.status === 'redirect') return
      if (result.status === 'manual') {
        toast({ title: 'تم تسجيل طريقة الدفع', description: result.message || 'تم إبلاغ الإدارة، وستبقى الفاتورة بانتظار تأكيد السداد.' })
        return
      }
      toast({ title: 'تم الدفع بنجاح', description: 'تم تحديث حالة الطلب' })
    } catch (e: any) {
      toast({ title: 'خطأ في الدفع', description: e.message || 'تعذر إتمام الدفع', variant: 'destructive' })
    } finally {
      setTrackPaying(false)
    }
  }

  const createAndPayRemainingTuition = async (app: any) => {
    const plan: TrackedTuitionPlan | null = app?.tuitionPlan || null
    if (!app?.id || !app?.reference || !plan?.remainingTuition) return
    setTrackPaying(true)
    try {
      const created = await api<{ payment: TrackedInvoice }>('/api/payments/installment', {
        method: 'POST',
        body: JSON.stringify({ admissionId: app.id, amount: plan.remainingTuition }),
      })
      const result = await payInvoice(created.payment.invoiceNo, async () => {
        const d = await api<{ application: any }>(`/api/admissions?ref=${encodeURIComponent(app.reference)}`)
        setTracked(d.application)
        setMyAdmission((current: any) => current?.reference === d.application?.reference ? d.application : current)
        setTrackPayTarget(null)
      })
      if (result.status === 'redirect') return
      if (result.status === 'manual') {
        toast({ title: 'تم إنشاء فاتورة المتبقي وتسجيل طريقة الدفع', description: result.message || 'ستؤكد الإدارة السداد بعد استلام المبلغ.' })
        return
      }
      toast({ title: 'تم إنشاء وسداد فاتورة المتبقي', description: 'تم تحديث خطة الرسوم في الطلب.' })
    } catch (e: any) {
      toast({ title: 'تعذر دفع المتبقي', description: e.message || 'سجّل الدخول أو راجع الإدارة لإنشاء فاتورة المتبقي.', variant: 'destructive' })
    } finally {
      setTrackPaying(false)
    }
  }

  const renderAdmissionStatusCard = (app: any) => {
    const isStudyApp = app.isStudyProgram !== false
    const baseStatus = STATUS_LABEL[app.status] || { text: app.statusLabel || app.status, cls: 'bg-slate-100 text-slate-600' }
    const status = !isStudyApp && app.status === 'RESULT_APPROVED'
      ? { text: 'تم اعتماد الخدمة', cls: 'bg-emerald-100 text-emerald-700' }
      : !isStudyApp && app.status === 'CERTIFIED'
        ? { text: 'تم تسليم الخدمة', cls: 'bg-emerald-100 text-emerald-700' }
        : baseStatus
    const rawInvoices: TrackedInvoice[] = sortInvoicesNewest(Array.isArray(app.payments) ? app.payments : [])
    const tuitionPlan: TrackedTuitionPlan | null = app.tuitionPlan || null
    const hasInstallmentInvoices = rawInvoices.some((p) => p.purpose === 'TUITION_INSTALLMENT')
    const hasTuitionProgress = isStudyApp && !!tuitionPlan && tuitionPlan.totalTuition > 0 && (tuitionPlan.paidTuition > 0 || hasInstallmentInvoices)
    const invoices = rawInvoices.filter((p) => !(hasTuitionProgress && p.purpose === 'TUITION' && p.status !== 'PAID'))
    const unpaid = invoices.filter((p) => p.status !== 'PAID')
    const applicationFee = unpaid.find((p) => p.purpose === 'APPLICATION_FEE') || null
    const installmentPayable = unpaid.find((p) => p.purpose === 'TUITION_INSTALLMENT') || null
    const fullTuitionPayable = hasTuitionProgress ? null : (unpaid.find((p) => p.purpose === 'TUITION') || null)
    const tuition = installmentPayable || fullTuitionPayable || unpaid.find((p) => p.purpose !== 'APPLICATION_FEE') || null
    const payable = app.status === 'AWAITING_TUITION' ? tuition : app.status === 'AWAITING_FEE' ? applicationFee : (tuition || applicationFee)
    const isStudyFinalActive = isStudyApp && ['SUPERVISOR_ASSIGNED', 'THESIS', 'SCHEDULED', 'RESULT_APPROVED', 'CERTIFIED'].includes(app.status)
    const isServiceApproved = !isStudyApp && ['RESULT_APPROVED', 'CERTIFIED'].includes(app.status)
    const tuitionSummaryActive = hasTuitionProgress && !!tuitionPlan && tuitionPlan.totalTuition > 0
    const tuitionTotal = Number(tuitionPlan?.totalTuition || 0)
    const tuitionPaid = Number(tuitionPlan?.paidTuition || 0)
    const tuitionRemaining = Number(tuitionPlan?.remainingTuition || 0)
    const canCreateRemainingInvoice = tuitionSummaryActive && !installmentPayable && tuitionRemaining > 0 && app.id
    const headline = app.status === 'AWAITING_TUITION'
      ? 'تمت الموافقة المبدئية على طلبك'
      : app.status === 'UNDER_REVIEW'
        ? (isStudyApp ? 'طلبك قيد دراسة الإدارة' : 'طلب الخدمة قيد مراجعة الإدارة')
        : app.status === 'AWAITING_FEE'
          ? 'تم استلام طلبك — بانتظار رسوم التقديم'
          : isStudyFinalActive && isStudyApp
            ? 'تم تفعيل قيدك الدراسي'
            : isServiceApproved
              ? 'تم اعتماد طلب الخدمة'
              : app.status === 'REJECTED'
                ? 'تمت مراجعة طلبك'
                : (isStudyApp ? 'حالة طلب الالتحاق' : 'حالة طلب الخدمة')

    return (
      <Card className="mx-auto mt-6 max-w-3xl border-[#c9a227]/40 bg-white shadow-xl">
        <CardContent className="p-6 sm:p-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <Badge className={`${status.cls} hover:opacity-100`}>{status.text}</Badge>
              <h2 className="mt-3 text-xl font-black text-[#0f2b46]">{headline}</h2>
              <p className="mt-2 text-sm font-bold leading-7 text-slate-600">{app.nextAction || 'تابع تعليمات الإدارة لإكمال ملفك.'}</p>
            </div>
            <div className="rounded-xl bg-[#0f2b46] px-4 py-3 text-center text-[#f5f0e1]">
              <p className="text-[10px] font-bold opacity-70">كود الطلب</p>
              <p className="font-mono text-lg font-black text-[#e0b83a]" dir="ltr">{app.reference}</p>
            </div>
          </div>

          <div className="mt-5 rounded-2xl border border-[#c9a227]/20 bg-[#f7edd0]/40 p-4">
            <div className="grid gap-3 text-xs font-bold text-slate-600 sm:grid-cols-2">
              <p><b className="text-[#0f2b46]">{isStudyApp ? 'الطالب' : 'العميل'}:</b> {app.fullName}</p>
              <p><b className="text-[#0f2b46]">{isStudyApp ? 'البرنامج' : 'الخدمة'}:</b> {app.program}</p>
              <p><b className="text-[#0f2b46]">تاريخ الطلب:</b> {app.createdAt ? new Date(app.createdAt).toLocaleDateString('ar-EG') : '—'}</p>
              {isStudyApp ? <p><b className="text-[#0f2b46]">المشرف:</b> {app.supervisorName || 'لم يعين بعد'}</p> : <p><b className="text-[#0f2b46]">نوع الطلب:</b> خدمة عابرة</p>}
            </div>
          </div>

          {!isStudyApp && app.serviceWorkflow && (
            <div className="mt-5 rounded-2xl border border-purple-100 bg-purple-50/70 p-4">
              <div className="mb-3">
                <h3 className="text-sm font-black text-[#0f2b46]">{app.serviceWorkflow.workflow?.title || 'مسار تنفيذ الخدمة'}</h3>
                <p className="mt-1 text-xs font-bold leading-6 text-slate-600">{app.serviceWorkflow.workflow?.summary || 'تتابع الإدارة طلب الخدمة حتى الدفع والتسليم.'}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {app.serviceWorkflow.stages?.map((stage: any, idx: number) => (
                  <div key={`${app.reference}-${stage.id}`} className={`rounded-xl border p-3 text-xs ${stage.state === 'done' ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : stage.state === 'active' ? 'border-purple-200 bg-white text-purple-800' : 'border-slate-100 bg-slate-50 text-slate-500'}`}>
                    <p className="font-black">{stage.state === 'done' ? <CheckCircle2 className="ml-1 inline h-4 w-4" /> : <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-slate-200 text-[9px]">{idx + 1}</span>}{stage.label}</p>
                    <p className="mt-1 leading-5 opacity-80">{stage.description}</p>
                  </div>
                ))}
              </div>
              <p className="mt-3 rounded-xl bg-white px-3 py-2 text-xs font-bold leading-6 text-purple-800">المرحلة الحالية: {app.serviceWorkflow.activeStage?.label} — {app.serviceWorkflow.clientNextAction || app.nextAction}</p>
            </div>
          )}

          {app.status === 'AWAITING_TUITION' && (
            <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-bold leading-7 text-emerald-800">
              <CheckCircle2 className="ml-1 inline h-5 w-5" />
              مبروك، تمت الموافقة على طلبك بعد دراسة الملف. الخطوة التالية هي سداد الرسوم الدراسية لاستكمال التسجيل النهائي وفتح البرنامج والكتب والاختبارات.
            </div>
          )}

          {tuitionSummaryActive && (
            <div className="mt-5 rounded-2xl border border-[#c9a227]/30 bg-[#fffaf0] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-black text-[#0f2b46]">خطة الرسوم الدراسية للبرنامج</p>
                  <p className="mt-1 text-xs font-bold leading-6 text-amber-700">
                    سعر البرنامج: {tuitionTotal}$ — المسدد: {tuitionPaid}$ — المتبقي: {tuitionRemaining}$
                  </p>
                  <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">
                    لا يُحسب المتبقي من الفاتورة الأصلية إذا تم السداد على دفعات؛ يتم احتسابه من إجمالي الرسوم ناقص الدفعات المسددة.
                  </p>
                </div>
                {installmentPayable ? (
                  <Button
                    onClick={() => openStudentPayments(installmentPayable.invoiceNo)}
                    className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]"
                  >
                    <CreditCard className="ml-2 h-4 w-4" /> ادفع الدفعة المستحقة من بوابة الطالب
                  </Button>
                ) : canCreateRemainingInvoice ? (
                  <Button
                    onClick={() => openStudentPayments()}
                    className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]"
                  >
                    <CreditCard className="ml-2 h-4 w-4" /> إدارة التقسيط والدفعات من بوابة الطالب
                  </Button>
                ) : null}
              </div>
            </div>
          )}

          {payable && !(tuitionSummaryActive && ['TUITION', 'TUITION_INSTALLMENT'].includes(payable.purpose)) && (
            <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-black text-[#0f2b46]">{payable.description}</p>
                <p className="mt-1 text-xs font-bold text-amber-700">المبلغ المطلوب: {payable.amount}$ — الفاتورة <span dir="ltr">{payable.invoiceNo}</span></p>
              </div>
              <Button
                onClick={() => openStudentPayments(payable.invoiceNo)}
                className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]"
              >
                <CreditCard className="ml-2 h-4 w-4" /> {payable.purpose === 'SERVICE_FEE' ? 'ادفع رسوم الخدمة من بوابة الطالب' : 'ادفع رسوم التقديم من بوابة الطالب'}
              </Button>
            </div>
          )}

          {isStudyFinalActive && (
            <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm font-bold leading-7 text-emerald-800">تم استكمال التسجيل. يمكنك متابعة الدراسة والكتب والاختبارات من بوابة الطالب.</p>
              <Button onClick={() => navigate('dashboard')} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
                <GraduationCap className="ml-2 h-4 w-4" /> دخول بوابة الطالب
              </Button>
            </div>
          )}

          {isServiceApproved && (
            <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm font-bold leading-7 text-emerald-800">تم اعتماد طلب الخدمة. تابع الدفعات والمخرجات التي تنشرها الإدارة من بوابة العميل.</p>
              <Button onClick={() => navigate('dashboard')} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
                <ClipboardList className="ml-2 h-4 w-4" /> دخول بوابة العميل
              </Button>
            </div>
          )}

          {invoices.length > 0 && (
            <div className="mt-5 space-y-2">
              <h3 className="text-sm font-black text-[#0f2b46]">فواتير الطلب</h3>
              {invoices.map((inv) => (
                <div key={inv.invoiceNo} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 ${inv.status === 'PAID' ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
                  <div>
                    <p className="text-xs font-black text-[#0f2b46]">{inv.description}</p>
                    <p className="mt-1 font-mono text-[10px] font-bold text-slate-500" dir="ltr">{inv.invoiceNo}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-black text-[#0f2b46]">{inv.amount}$</span>
                    <Badge className={inv.status === 'PAID' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>{inv.status === 'PAID' ? 'مسددة' : 'بانتظار السداد'}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}

          {app.status === 'REJECTED' && (
            <div className="mt-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-xs font-bold leading-6 text-red-700">
              يمكنك التواصل مع الإدارة لمعرفة سبب القرار أو تقديم طلب جديد عند السماح بذلك.
            </div>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="aact-fade-in mx-auto max-w-6xl px-4 py-10">
      <div className="mb-8 text-center">
        <Badge className="mb-3 border-[#c9a227]/50 bg-[#c9a227]/10 text-[#a8841a] hover:bg-[#c9a227]/10">
          <ClipboardList className="ml-1 h-3.5 w-3.5" /> طلبات الأكاديمية وخدماتها
        </Badge>
        <h1 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">تقديم طلب برنامج دراسي أو خدمة مهنية</h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
          اختر المسار المناسب: البرامج الدراسية تفتح بوابة الطالب بعد القبول والسداد، أما الخدمات العابرة فتُدار كطلب خدمة وتظهر مخرجاتها في بوابة العميل.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} dir="rtl" className="w-full">
        <TabsList className="mx-auto grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="apply" className="text-xs font-bold sm:text-sm">طلب خدمة/التحاق</TabsTrigger>
          <TabsTrigger value="track" className="text-xs font-bold sm:text-sm">تتبع طلبك</TabsTrigger>
        </TabsList>

        <TabsContent value="apply">
          {done ? (
            <Card className="mx-auto mt-6 max-w-2xl border-emerald-200 bg-emerald-50/50">
              <CardContent className="p-8 text-center">
                <Banknote className="mx-auto mb-4 h-14 w-14 text-amber-500" />
                <h2 className="text-xl font-black text-[#0f2b46]">{isServiceRequest ? 'تم استلام طلب الخدمة' : 'تم استلام طلب الالتحاق'}</h2>
                <div className="mx-auto mt-4 w-fit rounded-xl border border-emerald-200 bg-white px-6 py-4">
                  <div className="text-xs font-bold text-slate-500">كود تتبع حالة طلبك</div>
                  <div className="mt-1 font-mono text-2xl font-black tracking-wider text-[#0f2b46]" dir="ltr">{done.reference}</div>
                </div>
                {done.invoice && (
                  <>
                    <p className="mx-auto mt-4 max-w-md text-xs font-bold leading-relaxed text-amber-700">
                      تم إنشاء فاتورة رسوم التقديم وحجز المقعد ({done.invoice.amount}$ غير مستردة). سيتم الدفع من مركز الدفعات نفسه داخل بوابة الطالب.
                    </p>
                    <Button onClick={() => openStudentPayments(done.invoice?.invoiceNo)} className="mt-4 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                      <CreditCard className="ml-2 h-4 w-4" /> الانتقال إلى بوابة الطالب لإتمام الدفع
                    </Button>
                  </>
                )}
                {done.invoice === null && (
                  <p className="mx-auto mt-4 max-w-md text-sm font-bold leading-relaxed text-emerald-700">
                    طلبك الآن قيد دراسة الإدارة. ستصلك تعليمات المتابعة أو التسعير أو موعد الاستشارة حسب طبيعة الخدمة.
                  </p>
                )}
                <Button type="button" variant="outline" onClick={() => { setDone(null); setActiveTab('apply') }} className="mt-5 border-[#c9a227]/50 font-black text-[#a8841a]">
                  تقديم طلب آخر
                </Button>
              </CardContent>
            </Card>
          ) : myAdmissionLoading ? (
            <Card className="mx-auto mt-6 max-w-2xl border-[#0f2b46]/10">
              <CardContent className="flex h-44 flex-col items-center justify-center gap-3 text-center">
                <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
                <p className="text-sm font-black text-[#0f2b46]">جاري فحص طلبك الحالي...</p>
                <p className="text-xs font-bold text-slate-400">إذا كان لديك طلب دراسي نشط ستظهر حالته، أما الخدمات السابقة فلا تمنع تقديم طلب جديد.</p>
              </CardContent>
            </Card>
          ) : myAdmission && myAdmission.status !== 'REJECTED' ? (
            renderAdmissionStatusCard(myAdmission)
          ) : (
            <Card className="mx-auto mt-6 max-w-3xl border-[#0f2b46]/15 shadow-xl">
              <CardContent className="p-6 sm:p-8">
                {recentApplications.length > 0 && (
                  <div className="mb-5 rounded-2xl border border-[#c9a227]/30 bg-[#f7edd0]/40 p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-black text-[#0f2b46]">طلباتك السابقة والحالية</p>
                        <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">يمكنك تقديم طلب جديد الآن، مع الاحتفاظ بسجل الخدمات أو البرامج السابقة في التتبع وبوابة العميل/الطالب.</p>
                      </div>
                      <Badge className="bg-white text-[#a8841a] hover:bg-white">{recentApplications.length} طلب</Badge>
                    </div>
                    <div className="grid gap-2">
                      {recentApplications.map((app: any) => {
                        const status = STATUS_LABEL[app.status] || { text: app.statusLabel || app.status, cls: 'bg-slate-100 text-slate-600' }
                        return (
                          <div key={app.reference} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 text-xs">
                            <div className="min-w-0">
                              <p className="truncate font-black text-[#0f2b46]">{app.program}</p>
                              <p className="mt-0.5 font-bold text-slate-500"><span dir="ltr">{app.reference}</span> — {app.isStudyProgram ? 'برنامج دراسي' : 'خدمة عابرة'}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge className={status.cls}>{status.text}</Badge>
                              <Button type="button" size="sm" variant="outline" onClick={() => { setTracked(app); setTrackRef(app.reference); setTrackError(''); setActiveTab('track') }} className="h-8 border-[#c9a227]/50 text-[11px] font-black text-[#a8841a]">عرض</Button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
                <h2 className="mb-1 text-lg font-black text-[#0f2b46]">{isServiceRequest ? 'نموذج طلب الخدمة الإلكتروني' : 'نموذج طلب القبول الإلكتروني'}</h2>
                <p className="mb-6 text-xs text-slate-500">{isServiceRequest ? 'أكمل بياناتك واشرح احتياجك لتتمكن الإدارة من دراسة الطلب والمتابعة.' : 'أكمل البيانات التالية بدقة لدراسة ملفك والالتحاق بالبرنامج.'}</p>

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
                          <Input id="ad-name" required value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="الاسم الثلاثي على الأقل كما في الوثائق" />
                          <p className="text-[10px] font-bold text-slate-400">يجب أن يحتوي الاسم على 3 مقاطع على الأقل دون اختصارات.</p>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ad-nid" className="flex items-center gap-1"><IdCard className="h-3.5 w-3.5 text-[#a8841a]" /> رقم الهوية / جواز السفر {isServiceRequest ? '(اختياري)' : '*'}</Label>
                          <Input id="ad-nid" required={!isServiceRequest} dir="ltr" className="text-left" value={form.nationalId} onChange={(e) => setForm({ ...form, nationalId: e.target.value })} placeholder="رقم الهوية أو الرقم الوطني أو جواز السفر" />
                          {!isServiceRequest && <p className="text-[10px] font-bold text-slate-400">يقبل النظام أرقام الهويات الدولية وجوازات السفر من 5 إلى 25 خانة.</p>}
                        </div>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-3">
                        <div className="space-y-2">
                          <Label htmlFor="ad-country">الدولة *</Label>
                          <Select value={form.country} onValueChange={(v) => setForm({ ...form, country: v })}>
                            <SelectTrigger id="ad-country"><SelectValue placeholder="اختر الدولة من القائمة" /></SelectTrigger>
                            <SelectContent className="max-h-72">
                              {SUPPORTED_COUNTRIES.map((country) => <SelectItem key={country} value={country}>{country}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="ad-birth" className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5 text-[#a8841a]" /> تاريخ الميلاد {selectedRules?.minAge ? '*' : ''}</Label>
                          <Input id="ad-birth" type="date" required={!isServiceRequest && !!selectedRules?.minAge} dir="ltr" className="text-left" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} />
                          {selectedRules?.minAge && <p className="text-[10px] font-bold text-slate-400">سيتم التحقق من شرط العمر الأدنى: {selectedRules.minAge} سنة.</p>}
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
                          <Input id="ad-phone" required dir="ltr" className="text-left" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} onBlur={() => setForm((f) => ({ ...f, phone: normalizePhone(f.phone) }))} placeholder="+970598400510" />
                          <p className="text-[10px] font-bold text-slate-400">استخدم صيغة دولية عند الإمكان، من 8 إلى 15 رقماً.</p>
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
                          <Label>نوع الطلب *</Label>
                          <Select
                            value={selectedCategory}
                            onValueChange={(v) => {
                              setSelectedCategory(v)
                              setForm((f) => ({ ...f, program: '' }))
                            }}
                          >
                            <SelectTrigger><SelectValue placeholder="اختر برنامجاً دراسياً أو خدمة مهنية" /></SelectTrigger>
                            <SelectContent>
                              {availableCategories.map((c) => <SelectItem key={c} value={c}>{PROGRAM_CATEGORY_LABEL[c] || c}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          <Label>{selectedCategory === 'SERVICE' ? 'الخدمة المطلوبة *' : selectedCategory === 'MASTERS' || selectedCategory === 'DOCTORATE' ? 'التخصص المطلوب *' : 'البرنامج / الدبلوم *'}</Label>
                          <Select value={form.program} onValueChange={(v) => setForm({ ...form, program: v })} disabled={!selectedCategory}>
                            <SelectTrigger><SelectValue placeholder={selectedCategory === 'SERVICE' ? 'اختر الخدمة المطلوبة' : selectedCategory ? 'اختر التخصص أو البرنامج' : 'اختر نوع الطلب أولاً'} /></SelectTrigger>
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

                      {selectedFlow ? (
                        <div className="rounded-xl border border-[#c9a227]/30 bg-[#f7edd0]/40 p-3 text-xs font-bold leading-relaxed text-[#0f2b46]">
                          <p className="font-black text-[#a8841a]">المسار الرسمي: {selectedFlow.kicker}</p>
                          <p className="mt-1">{selectedFlow.summary}</p>
                          <p className="mt-1 text-[11px] text-slate-500">الخطوات: {selectedFlow.steps.slice(0, 4).join(' ← ')}</p>
                        </div>
                      ) : selectedProgram && (selectedProgram.category === 'MASTERS' || selectedProgram.category === 'DOCTORATE') && (
                        <div className="rounded-xl border border-[#c9a227]/30 bg-[#f7edd0]/40 p-3 text-xs font-bold leading-relaxed text-[#0f2b46]">
                          اخترت: {PROGRAM_CATEGORY_LABEL[selectedProgram.category] || selectedProgram.category} — التخصص: {selectedProgram.specialty || selectedProgram.titleAr}. الكتب والاختبارات والمشرف الذكي ستُبنى على هذا التخصص تحديداً.
                        </div>
                      )}
                    </div>
                  </section>

                  {selectedRules && (selectedRules.displayNote || selectedRules.customRules || selectedRules.minEducation || selectedRules.minAge || selectedRules.minYearsExperience) && (
                    <section className="rounded-xl border border-[#c9a227]/50 bg-[#f7edd0]/60 p-4">
                      <p className="mb-2 flex items-center gap-1.5 text-xs font-black text-[#a8841a]"><Sparkles className="h-4 w-4" /> {isServiceRequest ? 'متطلبات خاصة بالخدمة المختارة' : 'شروط خاصة بالبرنامج المختار'}</p>
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
                      <h3 className="text-sm font-black text-[#0f2b46]">2. {isServiceRequest ? (requiredDocs.length ? 'إرفاق مرفقات الخدمة المطلوبة' : 'إرفاق ملفات داعمة للخدمة عند الحاجة') : 'إرفاق الوثائق الرسمية المطلوبة'}</h3>
                      <Badge className={allDocsUploaded ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>
                        {activeDocs.filter((d) => files[d.type]).length} / {activeDocs.length} {isServiceRequest ? (requiredDocs.length ? 'مطلوب' : 'اختياري') : ''}
                      </Badge>
                    </div>
                    <div className="p-4">
                      <p className="mb-3 text-[11px] text-slate-500">الصيغ المسموحة: صور / PDF / Word DOCX / Excel / TXT / CSV — الحد الأقصى {MAX_FILE_MB} ميجابايت للملف.</p>
                      <div className="grid gap-2.5 sm:grid-cols-2">
                        {activeDocs.map((d) => {
                          const f = files[d.type]
                          return (
                            <div key={d.type} className={`rounded-xl border p-3 ${f ? 'border-emerald-300 bg-emerald-50/60' : 'border-slate-200 bg-white'}`}>
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <p className="text-xs font-black leading-relaxed text-[#0f2b46]">{d.label}</p>
                                  {f ? (
                                    <p className="mt-1 flex items-center gap-1 text-[11px] font-bold text-emerald-700"><Paperclip className="h-3 w-3" /> {f.name} ({fmtSize(f.size)})</p>
                                  ) : (
                                    <p className={`mt-1 text-[11px] font-bold ${requiredDocs.some((x) => x.type === d.type) ? 'text-red-500' : 'text-slate-400'}`}>{requiredDocs.some((x) => x.type === d.type) ? 'لم يُرفع بعد — مطلوب' : 'لم يُرفع بعد — اختياري'}</p>
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
                    <Textarea id="ad-notes" className="min-h-20" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder={isServiceRequest ? 'اشرح الخدمة المطلوبة، الهدف، الملفات المتوفرة، وطريقة التواصل المفضلة...' : 'خبرات، تخصص دقيق، طريقة التواصل المفضلة...'} />
                  </div>

                  <section className="rounded-xl border-2 border-[#c9a227]/60 bg-[#f7edd0]/60 p-4">
                    <p className="text-xs leading-relaxed text-[#5c4d1a]">
                      {isServiceRequest
                        ? 'أقر بأن بيانات طلب الخدمة صحيحة، وأوافق على أن تقوم الإدارة بدراسة الاحتياج وتحديد المتطلبات أو الرسوم أو موعد الاستشارة قبل اعتماد الطلب النهائي.'
                        : `أقر بأن البيانات والوثائق المقدمة صحيحة، وأوافق على شروط الأكاديمية وسداد رسوم التقديم وحجز المقعد (${ADMISSION_FEES.applicationFee}$ غير مستردة)، ثم سداد الرسوم الدراسية بعد القبول.`}
                    </p>
                    <label className="mt-3 flex cursor-pointer items-start gap-2.5 rounded-xl bg-white p-3">
                      <Checkbox checked={acknowledged} onCheckedChange={(v) => setAcknowledged(v === true)} className="mt-0.5" />
                      <span className="text-xs font-black leading-relaxed text-[#0f2b46]">أوافق على الإقرار أعلاه</span>
                    </label>
                  </section>

                  <Button type="submit" disabled={loading || !canSubmitStudentApplication} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a] disabled:opacity-60">
                    {loading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4 rotate-180" />}
                    {canSubmitStudentApplication ? (isServiceRequest ? 'تقديم طلب الخدمة للإدارة' : 'تقديم طلب الالتحاق وإصدار فاتورة رسوم التقديم') : 'يتطلب حساب طالب منفصل للتقديم'}
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="track">
          <Card className="mx-auto mt-6 max-w-2xl border-[#0f2b46]/15 shadow-xl">
            <CardContent className="p-6 sm:p-8">
              <h2 className="mb-1 flex items-center gap-2 text-lg font-black text-[#0f2b46]"><Search className="h-5 w-5 text-[#c9a227]" /> تتبع حالة طلب الالتحاق أو الخدمة</h2>
              <p className="mb-6 text-xs text-slate-500">أدخل كود التتبع الذي استلمته عند تقديم طلب برنامج دراسي أو خدمة عابرة.</p>
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
                    {tracked.nextAction && <p className="mt-3 rounded-xl bg-white/70 p-3 text-xs font-bold leading-6 text-[#5c4d1a]">الخطوة التالية: {tracked.nextAction}</p>}
                  </div>

                  {tracked.payments?.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-sm font-black text-[#0f2b46]">فواتير الطلب</h3>
                      {sortInvoicesNewest(tracked.payments).map((inv: TrackedInvoice) => (
                        <div key={inv.invoiceNo} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5 ${inv.status === 'PAID' ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/50'}`}>
                          <div className="min-w-0">
                            <div className="rounded-md bg-[#0f2b46] px-2 py-0.5 font-mono text-[10px] font-bold text-[#e0b83a]" dir="ltr">{inv.invoiceNo}</div>
                            <p className="mt-1 text-xs font-black text-[#0f2b46]">{inv.description}</p>
                            <p className="mt-1 text-[11px] font-bold text-slate-500">{inv.status === 'PAID' ? 'مسددة ✓' : 'بانتظار السداد'}</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-base font-black text-[#0f2b46]">{inv.amount}$</span>
                            {inv.status === 'UNPAID' && (
                              <Button size="sm" onClick={() => openStudentPayments(inv.invoiceNo)} className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                                <CreditCard className="ml-1 h-3.5 w-3.5" /> ادفع من بوابة الطالب
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

      <div className="mx-auto mt-8 max-w-3xl rounded-xl border border-[#0f2b46]/10 bg-white p-4 text-xs leading-relaxed text-slate-500">
        <Info className="ml-1 inline h-4 w-4 text-[#c9a227]" />
        للاستفسار: {ACADEMY_INFO.email} — واتساب: {ACADEMY_INFO.whatsapp}. الوثائق المطلوبة وفق الدليل: {ADMISSION_GUIDE.documents.slice(0, 4).join('، ')}.
      </div>
    </div>
  )
}
