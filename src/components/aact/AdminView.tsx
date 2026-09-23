'use client'

import { useAppStore, api } from '@/lib/store'
import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  Users2, ClipboardCheck, Bot, Globe2, Loader2, TrendingUp,
  CheckCircle2, XCircle, Clock3, GraduationCap, BarChart3, ClipboardList, Search,
  Gavel, Banknote, Award, Settings2, ScrollText, Mail, UserCheck,
  Paperclip, FileText, BookMarked, AlertTriangle, Sparkles, Eye, PackageCheck,
} from 'lucide-react'

function AdminTabLoader() {
  return (
    <Card className="mt-4 border-[#0f2b46]/10">
      <CardContent className="flex h-48 flex-col items-center justify-center gap-3 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
        <p className="text-sm font-black text-[#0f2b46]">جاري تحميل هذا القسم...</p>
        <p className="text-xs font-bold text-slate-400">تم فصل التبويبات الثقيلة لتفتح لوحة الإدارة بسرعة أكبر.</p>
      </CardContent>
    </Card>
  )
}

const loadAdminExtrasModule = () => import('@/components/aact/AdminExtras')
const loadAdminBooksModule = () => import('@/components/aact/AdminBooks')
const loadAdminAIModule = () => import('@/components/aact/AdminAITab')
const loadAdminSystemModule = () => import('@/components/aact/AdminSystemTab')
const loadAdminRulesModule = () => import('@/components/aact/AdminRulesTab')
const loadAdminQualityModule = () => import('@/components/aact/AdminQualityTab')
const loadAdminSupervisorsModule = () => import('@/components/aact/AdminSupervisors')

const AdminThesisTab = dynamic(() => loadAdminExtrasModule().then((m) => m.AdminThesisTab), { ssr: false, loading: AdminTabLoader })
const AdminFinanceTab = dynamic(() => loadAdminExtrasModule().then((m) => m.AdminFinanceTab), { ssr: false, loading: AdminTabLoader })
const AdminCertificatesTab = dynamic(() => loadAdminExtrasModule().then((m) => m.AdminCertificatesTab), { ssr: false, loading: AdminTabLoader })
const AdminSettingsTab = dynamic(() => loadAdminExtrasModule().then((m) => m.AdminSettingsTab), { ssr: false, loading: AdminTabLoader })
const AdminAuditTab = dynamic(() => loadAdminExtrasModule().then((m) => m.AdminAuditTab), { ssr: false, loading: AdminTabLoader })
const AdminMessagesTab = dynamic(() => loadAdminExtrasModule().then((m) => m.AdminMessagesTab), { ssr: false, loading: AdminTabLoader })
const AdminBooksTab = dynamic(() => loadAdminBooksModule().then((m) => m.AdminBooksTab), { ssr: false, loading: AdminTabLoader })
const AdminAITab = dynamic(() => loadAdminAIModule().then((m) => m.AdminAITab), { ssr: false, loading: AdminTabLoader })
const AdminSystemTab = dynamic(() => loadAdminSystemModule().then((m) => m.AdminSystemTab), { ssr: false, loading: AdminTabLoader })
const AdminRulesTab = dynamic(() => loadAdminRulesModule().then((m) => m.AdminRulesTab), { ssr: false, loading: AdminTabLoader })
const AdminQualityTab = dynamic(() => loadAdminQualityModule().then((m) => m.AdminQualityTab), { ssr: false, loading: AdminTabLoader })
const AdminSupervisorsTab = dynamic(() => loadAdminSupervisorsModule().then((m) => m.AdminSupervisorsTab), { ssr: false, loading: AdminTabLoader })

interface Stats {
  stats: {
    totalStudents: number
    totalEnrollments: number
    totalAttempts: number
    totalChats: number
    pendingAgents: number
    pendingAdmissions: number
    pendingServices?: number
    paidServicesWaitingDelivery?: number
    passRate: number
  }
  recentAttempts: {
    id: string; student: string; email: string; exam: string; program: string
    score: number | null; passed: boolean | null; submittedAt: string
  }[]
  programCounts: { titleAr: string; enrollments: number }[]
}

interface AgentApp {
  id: string; kind: string; accreditationType?: string | null
  orgName: string; repName: string; email: string; phone?: string | null
  country: string; territory?: string | null; experience?: string | null
  status: string; createdAt: string
  user?: { id: string; name: string; email: string; role: string } | null
  submittedByStaff?: boolean
  contractNo?: string | null
  commissionRate?: number | null
  committeeFee?: number | null
  exclusive?: boolean
  startDate?: string | null
  endDate?: string | null
  revokedAt?: string | null
  revokedReason?: string | null
  revokedById?: string | null
  // وثائق الاعتماد الرسمية المرفوعة + فاتورة رسوم التقديم
  documents?: { id: string; docType: string; fileName: string; size: number; mimeType: string }[]
  certificates?: { id: string; serial: string; valid: boolean; issuedAt: string }[]
  applicationFee?: { invoiceNo: string; amount: number; status: string } | null
}

interface ServiceWorkflowStageView {
  id: string
  label: string
  description: string
  deliverableTypes?: string[]
  state: 'done' | 'active' | 'pending'
}

interface ServiceWorkflowView {
  workflow: { kind: string; title: string; summary: string }
  stages: ServiceWorkflowStageView[]
  activeStage: ServiceWorkflowStageView
  nextAction: string
  clientNextAction?: string
  expectedDeliverableTypes: string[]
  paid: boolean
  hasInvoice: boolean
  publishedDeliverables: number
}

interface AdmissionApp {
  id: string; reference: string; fullName: string; email: string; phone: string
  country: string; education: string; program: string; documents: string; notes?: string | null
  files?: { id: string; docType: string; fileName: string; size: number; mimeType: string }[]
  deliverables?: { id: string; type: string; status: string; title: string; description?: string | null; fileName?: string | null; mimeType?: string | null; size?: number | null; externalUrl?: string | null; certificateId?: string | null; verificationUrl?: string | null; meetingAt?: string | null; expiresAt?: string | null; visibleToStudent?: boolean; createdAt: string }[]
  serviceWorkflow?: ServiceWorkflowView | null
  tuitionAppeal?: { id: string; status: string; requestedInitialAmount: number; proposedSchedule?: string | null; reason?: string | null; adminNote?: string | null; approvedInitialAmount?: number | null; firstSemesterRequiredAmount?: number | null; finalRequiredAmount?: number | null; createdAt: string } | null
  tuitionPlan?: { totalTuition: number; paidTuition: number; remainingTuition: number; firstSemesterRequiredAmount: number; finalRequiredAmount: number; firstSemesterAllowed: boolean; secondSemesterAllowed: boolean } | null
  status: string; createdAt: string
  programSlug?: string | null
  requestKind?: string | null
  requestLabel?: string | null
  requestActionLabel?: string | null
  isStudyProgram?: boolean
  user?: { id: string; name: string; email: string; role: string } | null
  supervisor?: { id: string; name: string } | null
  supervisorId?: string | null
  thesisDeadline?: string | null
  payments?: { id: string; invoiceNo?: string; purpose: string; status: string; amount: number; method?: string | null; receiptNo?: string | null; cryptoNetwork?: string | null; cryptoTxHash?: string | null; cryptoVerificationStatus?: string | null; cryptoVerificationNote?: string | null }[]
  theses?: { id: string; status: string; title: string }[]
  // التقييم الذكي المخزّن — يظهر للإدارة قبل زر الاعتماد
  aiVerdict?: string | null
  aiScore?: number | null
  aiReviewedAt?: string | null
}

interface DeliverableFormState {
  type: string
  title: string
  description: string
  externalUrl: string
  certificateId: string
  verificationUrl: string
  visibleToStudent: boolean
}

const emptyDeliverableForm = (): DeliverableFormState => ({
  type: 'PACKAGE_DOWNLOAD',
  title: '',
  description: '',
  externalUrl: '',
  certificateId: '',
  verificationUrl: '',
  visibleToStudent: true,
})

interface ChecklistItem { requirement: string; status: string; detail: string }
interface AIFinding { severity: string; title: string; detail: string }
interface AdmissionDocumentAnalysis {
  fileName: string
  declaredType: string
  declaredLabel: string
  detectedKind: string
  detectedLabel: string
  reader: string
  readable: boolean
  clearEnough: boolean
  belongsToStudent: 'YES' | 'NO' | 'UNVERIFIED'
  relatedToProgram: 'YES' | 'NO' | 'UNVERIFIED'
  coverage: number
  coverageReason: string
  recommendation: string
  reasons: string[]
}
interface AdmissionAIReview {
  verdict: string
  fitScore: number
  summaryForAdmin: string
  checklist: ChecklistItem[]
  documentAnalyses?: AdmissionDocumentAnalysis[]
  findings: AIFinding[]
  strengths: string[]
  recommendedAction: string
  engine: string
  analyzedAt: string
}

const AI_VERDICT_META: Record<string, { label: string; cls: string; border: string }> = {
  RECOMMEND_APPROVE: { label: 'خبير الذكاء الاصطناعي يوصي بالاعتماد', cls: 'bg-emerald-100 text-emerald-700', border: 'border-emerald-300' },
  NEEDS_CLARIFICATION: { label: 'خبير الذكاء الاصطناعي: ملاحظات تحتاج مراجعة قبل الاعتماد', cls: 'bg-amber-100 text-amber-700', border: 'border-amber-300' },
  RECOMMEND_REJECT: { label: 'خبير الذكاء الاصطناعي: نواقص جوهرية — راجع بجدية قبل الاعتماد', cls: 'bg-red-100 text-red-700', border: 'border-red-300' },
  INSUFFICIENT_DATA: { label: 'خبير الذكاء الاصطناعي: بيانات غير كافية للتحليل', cls: 'bg-slate-100 text-slate-600', border: 'border-slate-300' },
}

const DOC_RECOMMENDATION_AR: Record<string, string> = {
  ACCEPT_AS_EVIDENCE: 'يُقبل كدليل',
  REQUEST_CLEARER_COPY: 'اطلب نسخة أوضح',
  REQUEST_REPLACEMENT: 'اطلب استبدال المرفق',
  IGNORE_AS_NON_ADMISSION: 'لا يُحتسب كمرفق قبول',
}

const TRI_STATE_AR: Record<string, string> = { YES: 'نعم', NO: 'لا', UNVERIFIED: 'غير متحقق' }

const CHECK_STATUS_META: Record<string, { icon: typeof CheckCircle2; cls: string }> = {
  FOUND: { icon: CheckCircle2, cls: 'text-emerald-600' },
  MISSING: { icon: XCircle, cls: 'text-red-500' },
  UNVERIFIED: { icon: Search, cls: 'text-amber-500' },
  PROBLEM: { icon: AlertTriangle, cls: 'text-red-500' },
}

const SEVERITY_META: Record<string, { label: string; cls: string }> = {
  HIGH: { label: 'ملاحظة جوهرية', cls: 'bg-red-100 text-red-700' },
  MEDIUM: { label: 'ملاحظة متوسطة', cls: 'bg-amber-100 text-amber-700' },
  LOW: { label: 'ملاحظة بسيطة', cls: 'bg-slate-100 text-slate-600' },
}

interface SupervisorOption { id: string; name: string; role: string }

const STATUS_LABEL: Record<string, string> = {
  AWAITING_FEE: 'بانتظار سداد رسوم التقديم (30$)',
  UNDER_REVIEW: 'قيد دراسة الإدارة',
  AWAITING_TUITION: 'مقبول — بانتظار سداد الرسوم الدراسية',
  SUPERVISOR_ASSIGNED: 'تم تعيين مشرف',
  THESIS: 'التسجيل النهائي — قيد إعداد بحث التخرج',
  SCHEDULED: 'مجدول للمناقشة',
  RESULT_APPROVED: 'تم اعتماد النتيجة',
  CERTIFIED: 'تم إصدار الشهادة',
  REJECTED: 'غير مقبول',
  PENDING: 'تم التقديم',
}

const STATUS_BADGE: Record<string, string> = {
  AWAITING_FEE: 'bg-amber-100 text-amber-700',
  UNDER_REVIEW: 'bg-blue-100 text-blue-700',
  AWAITING_TUITION: 'bg-[#c9a227]/20 text-[#a8841a]',
  SUPERVISOR_ASSIGNED: 'bg-purple-100 text-purple-700',
  THESIS: 'bg-[#f7edd0] text-[#a8841a]',
  SCHEDULED: 'bg-blue-100 text-blue-700',
  RESULT_APPROVED: 'bg-emerald-100 text-emerald-700',
  CERTIFIED: 'bg-emerald-100 text-emerald-700',
  REJECTED: 'bg-red-100 text-red-600',
  PENDING: 'bg-amber-100 text-amber-700',
}

const EDUCATION_LABEL: Record<string, string> = {
  HIGH_SCHOOL: 'ثانوية عامة',
  BACHELOR: 'بكالوريوس',
  MASTER: 'ماجستير',
  OTHER: 'أخرى',
}

const DOC_TYPE_AR: Record<string, string> = {
  DEGREE: 'الشهادة وكشف العلامات',
  ID: 'الهوية / الجواز',
  PHOTO: 'صورة شخصية',
  CV: 'السيرة الذاتية',
  SERVICE_FILE: 'مرفق داعم للخدمة',
  FLOW_DOC_1: 'مستند مسار الخدمة 1',
  FLOW_DOC_2: 'مستند مسار الخدمة 2',
  FLOW_DOC_3: 'مستند مسار الخدمة 3',
  FLOW_DOC_4: 'مستند مسار الخدمة 4',
  FLOW_DOC_5: 'مستند مسار الخدمة 5',
}

const DELIVERABLE_TYPE_AR: Record<string, string> = {
  CERTIFICATE_PDF: 'شهادة PDF',
  EQUIVALENCY_CERTIFICATE: 'شهادة معادلة',
  PACKAGE_DOWNLOAD: 'رابط/ملف تحميل حقيبة',
  CONSULTATION_LINK: 'رابط جلسة استشارية',
  CONSULTATION_REPORT: 'تقرير استشارة',
  MEMBERSHIP_CARD: 'بطاقة عضوية',
  ACCREDITATION_CERTIFICATE: 'شهادة اعتماد',
  CUSTOM_PACKAGE_DRAFT: 'مسودة حقيبة مخصصة',
  CUSTOM_PACKAGE_FINAL: 'التسليم النهائي للحقيبة',
  OTHER: 'مخرج آخر',
}

const DELIVERABLE_TYPE_OPTIONS = Object.entries(DELIVERABLE_TYPE_AR).map(([value, label]) => ({ value, label }))

// وثائق طلبات الاعتماد الرسمية (وفق دليل الإجراءات — خطوة إرفاق الوثائق)
const AGENT_DOC_AR: Record<string, string> = {
  LICENSE: 'شهادة الترخيص/مزاولة المهنة',
  ID: 'الهوية / الجواز',
  PHOTO: 'صورة شخصية',
  CV: 'السيرة الذاتية',
}

const ACC_TYPE_LABEL: Record<string, string> = {
  COMPANY: 'اعتماد هيئة تدريبية',
  CONSULTANT: 'اعتماد مستشار',
  TRAINER: 'اعتماد مدرب دولي',
  QUALITY: 'اعتماد جودة',
}

interface StudentRow {
  id: string; name: string; email: string; country?: string | null; createdAt: string
  enrollments: { program: string; status: string; certificateNo?: string | null; finalScore?: number | null }[]
  attemptsCount: number
  bestScore: number | null
  aiChats: number
  latestAdmission?: { id: string; reference: string; status: string; program: string; createdAt: string } | null
}

export function AdminView() {
  const { user, navigate, openStudentPreview, openAgentPreview } = useAppStore()
  const { toast } = useToast()
  const [data, setData] = useState<Stats | null>(null)
  const [apps, setApps] = useState<AgentApp[]>([])
  const [admissions, setAdmissions] = useState<AdmissionApp[]>([])
  const [supervisors, setSupervisors] = useState<SupervisorOption[]>([])
  const [students, setStudents] = useState<StudentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [admissionsLoading, setAdmissionsLoading] = useState(true)
  const [studentsLoading, setStudentsLoading] = useState(true)
  const [appsLoading, setAppsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('admissions')
  const [highlightAdmissionId, setHighlightAdmissionId] = useState<string | null>(null)
  const [creatingDemoThesis, setCreatingDemoThesis] = useState(false)
  // ===== التقييم الذكي للطلب قبل الاعتماد: خبير AI يحلل المدخلات والمرفقات ويقارنها بالمطلوب =====
  const [aiReviews, setAiReviews] = useState<Record<string, AdmissionAIReview | null>>({})
  const [aiLoading, setAiLoading] = useState<string | null>(null)
  const [aiOpen, setAiOpen] = useState<Record<string, boolean>>({})
  const [deliverableForms, setDeliverableForms] = useState<Record<string, DeliverableFormState>>({})
  const [deliverableFiles, setDeliverableFiles] = useState<Record<string, File | null>>({})
  const [deliverableLoading, setDeliverableLoading] = useState<string | null>(null)
  const [tuitionAppealDialog, setTuitionAppealDialog] = useState<null | {
    appeal: NonNullable<AdmissionApp['tuitionAppeal']>
    plan?: AdmissionApp['tuitionPlan']
    decision: 'APPROVE' | 'REJECT'
    studentName: string
    program: string
  }>(null)
  const [tuitionAppealForm, setTuitionAppealForm] = useState({
    approvedInitialAmount: '',
    firstSemesterRequiredAmount: '',
    finalRequiredAmount: '',
    adminNote: '',
  })
  const [tuitionAppealSubmitting, setTuitionAppealSubmitting] = useState(false)
  const [paymentConfirmDialog, setPaymentConfirmDialog] = useState<null | {
    paymentId: string
    method?: string | null
    amount?: number
    invoiceNo?: string
    status?: string
    cryptoVerificationStatus?: string | null
  }>(null)
  const [paymentConfirmSubmitting, setPaymentConfirmSubmitting] = useState(false)
  const [revokeDialog, setRevokeDialog] = useState<null | { app: AgentApp; reason: string }>(null)
  const [revokeSubmitting, setRevokeSubmitting] = useState(false)

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<any>).detail
      if (!detail) return
      if (typeof detail === 'string') {
        setActiveTab(detail)
        return
      }
      if (detail.tab) setActiveTab(detail.tab)
      if (detail.tab === 'books') {
        ;[80, 300, 700].forEach((delay) => {
          window.setTimeout(() => window.dispatchEvent(new CustomEvent('aact-admin-books-target', { detail })), delay)
        })
      }
    }
    window.addEventListener('aact-admin-tab', handler as EventListener)
    return () => window.removeEventListener('aact-admin-tab', handler as EventListener)
  }, [])

  const updateDeliverableForm = (admissionId: string, patch: Partial<DeliverableFormState>) => {
    setDeliverableForms((prev) => ({
      ...prev,
      [admissionId]: Object.assign(emptyDeliverableForm(), prev[admissionId] || {}, patch),
    }))
  }

  const submitDeliverable = async (admission: AdmissionApp) => {
    const recommendedType = admission.serviceWorkflow?.expectedDeliverableTypes?.[0] || 'PACKAGE_DOWNLOAD'
    const formState = Object.assign(emptyDeliverableForm(), { type: recommendedType }, deliverableForms[admission.id] || {})
    if (!formState.title.trim()) {
      toast({ title: 'العنوان مطلوب', description: 'اكتب عنوان المخرج الذي سيظهر للعميل.', variant: 'destructive' })
      return
    }
    if (!deliverableFiles[admission.id] && !formState.externalUrl.trim() && !formState.certificateId.trim() && !formState.verificationUrl.trim()) {
      toast({ title: 'أضف ملفاً أو رابطاً', description: 'يجب رفع ملف أو إدخال رابط تحميل/اجتماع أو رقم شهادة/تحقق.', variant: 'destructive' })
      return
    }
    setDeliverableLoading(admission.id)
    try {
      const fd = new FormData()
      fd.append('admissionId', admission.id)
      fd.append('type', formState.type)
      fd.append('title', formState.title)
      fd.append('description', formState.description)
      fd.append('externalUrl', formState.externalUrl)
      fd.append('certificateId', formState.certificateId)
      fd.append('verificationUrl', formState.verificationUrl)
      fd.append('visibleToStudent', String(formState.visibleToStudent))
      const file = deliverableFiles[admission.id]
      if (file) fd.append('file', file)
      await api('/api/admin/service-deliverables', { method: 'POST', body: fd })
      toast({ title: 'تم تسليم المخرج', description: 'تم نشر المخرج للعميل وإرسال إشعار عند تفعيل البريد.' })
      setDeliverableForms((prev) => ({ ...prev, [admission.id]: Object.assign(emptyDeliverableForm(), { type: recommendedType }) }))
      setDeliverableFiles((prev) => ({ ...prev, [admission.id]: null }))
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر تسليم المخرج', description: e?.data?.message || e.message, variant: 'destructive' })
    } finally {
      setDeliverableLoading(null)
    }
  }

  const revokeDeliverable = async (id: string) => {
    try {
      await api(`/api/admin/service-deliverables?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      toast({ title: 'تم إلغاء المخرج', description: 'لن يظهر هذا المخرج للعميل.' })
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر إلغاء المخرج', description: e.message, variant: 'destructive' })
    }
  }

  const openPaymentConfirmDialog = (payment: NonNullable<AdmissionApp['payments']>[number]) => {
    setPaymentConfirmDialog({
      paymentId: payment.id,
      method: payment.method,
      amount: payment.amount,
      invoiceNo: payment.invoiceNo,
      status: payment.status,
      cryptoVerificationStatus: payment.cryptoVerificationStatus,
    })
  }

  const confirmAdmissionPayment = async () => {
    if (!paymentConfirmDialog) return
    try {
      setPaymentConfirmSubmitting(true)
      await api('/api/admin/payments', { method: 'PATCH', body: JSON.stringify({ id: paymentConfirmDialog.paymentId }) })
      toast({
        title: paymentConfirmDialog.method === 'USDT' ? 'تم تأكيد دفع USDT' : 'تم تأكيد الدفع المباشر',
        description: 'تم إصدار الإيصال وتحديث الطلب حسب نوع الفاتورة.',
      })
      setPaymentConfirmDialog(null)
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر تأكيد الدفع', description: e.message, variant: 'destructive' })
    } finally {
      setPaymentConfirmSubmitting(false)
    }
  }

  const openTuitionAppealDialog = (
    appeal: NonNullable<AdmissionApp['tuitionAppeal']>,
    decision: 'APPROVE' | 'REJECT',
    plan: AdmissionApp['tuitionPlan'] | undefined,
    app: AdmissionApp
  ) => {
    const total = plan?.totalTuition || appeal.finalRequiredAmount || 0
    const initialDefault = appeal.approvedInitialAmount || appeal.requestedInitialAmount || Math.ceil(total * 0.25)
    setTuitionAppealDialog({ appeal, plan, decision, studentName: app.fullName, program: app.program })
    setTuitionAppealForm({
      approvedInitialAmount: String(initialDefault || ''),
      firstSemesterRequiredAmount: String(appeal.firstSemesterRequiredAmount || plan?.firstSemesterRequiredAmount || Math.ceil(total / 2) || ''),
      finalRequiredAmount: String(appeal.finalRequiredAmount || plan?.finalRequiredAmount || total || ''),
      adminNote: appeal.adminNote || '',
    })
  }

  const submitTuitionAppealDecision = async () => {
    if (!tuitionAppealDialog) return
    const { appeal, decision } = tuitionAppealDialog
    try {
      setTuitionAppealSubmitting(true)
      const body: any = { id: appeal.id, decision, adminNote: tuitionAppealForm.adminNote.trim() || undefined }
      if (decision === 'APPROVE') {
        const approvedInitialAmount = Number(tuitionAppealForm.approvedInitialAmount)
        const firstSemesterRequiredAmount = Number(tuitionAppealForm.firstSemesterRequiredAmount)
        const finalRequiredAmount = Number(tuitionAppealForm.finalRequiredAmount)
        if (![approvedInitialAmount, firstSemesterRequiredAmount, finalRequiredAmount].every((n) => Number.isFinite(n) && n > 0)) {
          toast({ title: 'أدخل مبالغ صحيحة', description: 'الدفعة الأولى وشرط الفصل الأول والمبلغ النهائي يجب أن تكون أرقاماً أكبر من صفر.', variant: 'destructive' })
          return
        }
        if (approvedInitialAmount > firstSemesterRequiredAmount || firstSemesterRequiredAmount > finalRequiredAmount) {
          toast({ title: 'ترتيب مبالغ غير منطقي', description: 'يجب أن تكون الدفعة الأولى ≤ شرط الفصل الأول ≤ إجمالي المطلوب قبل الفصل الثاني.', variant: 'destructive' })
          return
        }
        body.approvedInitialAmount = approvedInitialAmount
        body.firstSemesterRequiredAmount = firstSemesterRequiredAmount
        body.finalRequiredAmount = finalRequiredAmount
      }
      await api('/api/admin/tuition-appeals', { method: 'PATCH', body: JSON.stringify(body) })
      toast({ title: decision === 'APPROVE' ? 'تم قبول التقسيط' : 'تم رفض الالتماس', description: 'تم إشعار الطالب بالقرار.' })
      setTuitionAppealDialog(null)
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر تحديث الالتماس', description: e.message, variant: 'destructive' })
    } finally {
      setTuitionAppealSubmitting(false)
    }
  }

  const load = async () => {
    setLoading(true)
    setAdmissionsLoading(true)
    setStudentsLoading(true)
    setAppsLoading(true)

    const statsPromise = api<Stats>('/api/admin/stats')
      .then((s) => setData(s))
      .catch((e: any) => toast({ title: 'تعذر تحميل مؤشرات الإدارة', description: e.message, variant: 'destructive' }))
      .finally(() => setLoading(false))

    void api<{ applications: AgentApp[] }>('/api/admin/applications')
      .then((a) => setApps(Array.isArray(a.applications) ? a.applications : []))
      .catch(() => setApps([]))
      .finally(() => setAppsLoading(false))

    void api<{ students: StudentRow[] }>('/api/admin/students')
      .then((st) => setStudents(Array.isArray(st.students) ? st.students : []))
      .catch(() => setStudents([]))
      .finally(() => setStudentsLoading(false))

    void api<{ applications: AdmissionApp[]; supervisors: SupervisorOption[] }>('/api/admin/admissions')
      .then((ad) => {
        setAdmissions(Array.isArray(ad.applications) ? ad.applications : [])
        setSupervisors(Array.isArray(ad.supervisors) ? ad.supervisors : [])
      })
      .catch((e: any) => {
        setAdmissions([])
        setSupervisors([])
        toast({ title: 'تعذر تحميل طلبات الالتحاق', description: e.message, variant: 'destructive' })
      })
      .finally(() => setAdmissionsLoading(false))

    await statsPromise
  }

  useEffect(() => {
    if (user && user.role === 'ADMIN') load()
    else if (user) navigate('home')
  }, [user])

  useEffect(() => {
    if (activeTab !== 'admissions' || !highlightAdmissionId) return
    const t = setTimeout(() => {
      const el = document.getElementById(`admission-${highlightAdmissionId}`)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 120)
    return () => clearTimeout(t)
  }, [activeTab, highlightAdmissionId, admissions.length])

  if (!user) {
    navigate('auth')
    return null
  }
  if (user.role !== 'ADMIN') {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 text-center">
        <h1 className="text-xl font-black text-[#0f2b46]">صلاحيات الإدارة مطلوبة</h1>
        <p className="mt-2 text-sm text-slate-500">هذه الصفحة مخصصة لإدارة الأكاديمية فقط.</p>
        <Button className="mt-5 bg-[#0f2b46] text-[#f5f0e1]" onClick={() => navigate('home')}>العودة للرئيسية</Button>
      </div>
    )
  }
  const setAppStatus = async (id: string, status: string, extra?: Record<string, any>) => {
    try {
      const d = await api<{ application?: AgentApp; revokedCertificates?: number }>('/api/admin/applications', {
        method: 'PATCH',
        body: JSON.stringify({ id, status, ...(extra || {}) }),
      })
      setApps((prev) => prev.map((a) => (a.id === id ? { ...a, ...(d.application || {}), status } : a)))
      const label = status === 'APPROVED' ? 'مقبول' : status === 'REJECTED' ? 'مرفوض' : status === 'REVOKED' ? 'ملغى/مسحوب' : 'معلق'
      toast({
        title: 'تم التحديث',
        description: status === 'REVOKED'
          ? `تم سحب الاعتماد وتعطيل ${d.revokedCertificates || 0} شهادة مرتبطة.`
          : `حالة الطلب أصبحت: ${label}`,
      })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  const revokeApp = async (a: AgentApp) => {
    const reason = window.prompt(
      `اكتب سبب إلغاء ${a.kind === 'AGENCY' ? 'الوكالة' : 'الاعتماد'} باسم ${a.orgName}.\n\nيجب أن يكون السبب موثقاً مثل إخلال بالعقد، مخالفة شروط التمثيل، إساءة استخدام الشهادة، أو مخالفة مهنية.`
    )
    if (reason == null) return
    const cleanReason = reason.replace(/\s+/g, ' ').trim()
    if (cleanReason.length < 25) {
      toast({ title: 'سبب غير كافٍ', description: 'اكتب سبباً واضحاً لا يقل عن 25 حرفاً حتى يظهر في سجل التدقيق.', variant: 'destructive' })
      return
    }
    const ok = window.confirm(
      `تأكيد سحب الاعتماد/الوكالة؟\n\nسيتم تغيير الحالة إلى ملغى، وتعطيل أي شهادة اعتماد مرتبطة في صفحة التحقق.\n\nالسبب: ${cleanReason}`
    )
    if (!ok) return
    await setAppStatus(a.id, 'REVOKED', { revokedReason: cleanReason, revocationAcknowledged: true })
  }

  const setAdmissionStatus = async (id: string, status: string) => {
    try {
      await api('/api/admin/admissions', { method: 'PATCH', body: JSON.stringify({ id, status }) })
      setAdmissions((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)))
      toast({ title: 'تم التحديث', description: `حالة الطلب أصبحت: ${STATUS_LABEL[status] || status}` })
      await load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  const assignSupervisor = async (id: string, supervisorId: string) => {
    try {
      const d = await api<{ application: AdmissionApp }>('/api/admin/admissions', {
        method: 'PATCH',
        body: JSON.stringify({ id, supervisorId: supervisorId === 'AI_ONLY' ? null : supervisorId }),
      })
      const chosen = supervisors.find((s) => s.id === supervisorId) || null
      setAdmissions((prev) =>
        prev.map((a) =>
          a.id === id
            ? { ...a, status: d.application.status, supervisor: chosen, supervisorId: chosen?.id || null }
            : a
        )
      )
      toast({
        title: 'تم ضبط الإشراف',
        description: supervisorId === 'AI_ONLY'
          ? 'أصبح الطالب تحت إشراف المشرف الذكي فقط'
          : `عيّن ${chosen?.name} مشرفاً أكاديمياً وأُبلغ الطالب`,
      })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  // تشغيل التحليل الذكي وحفظ النتيجة — يعرض للإدارة قبل زر الاعتماد
  const runAIReview = async (id: string, force = false) => {
    setAiLoading(id)
    try {
      const d = await api<{ review: AdmissionAIReview; cached: boolean }>('/api/admin/admissions/ai-review', {
        method: 'POST',
        body: JSON.stringify({ id, force }),
      })
      setAiReviews((prev) => ({ ...prev, [id]: d.review }))
      setAiOpen((prev) => ({ ...prev, [id]: true }))
      setAdmissions((prev) => prev.map((a) => (a.id === id ? { ...a, aiVerdict: d.review.verdict, aiScore: d.review.fitScore, aiReviewedAt: d.review.analyzedAt } : a)))
      const vm = AI_VERDICT_META[d.review.verdict]
      toast({
        title: d.cached ? 'التقييم الذكي المخزّن' : 'اكتمل التحليل الذكي للطلب',
        description: `${vm?.label || d.review.verdict} — درجة التوافق ${d.review.fitScore}%`,
      })
    } catch (e: any) {
      toast({ title: 'تعذر التحليل', description: e.message, variant: 'destructive' })
    } finally {
      setAiLoading(null)
    }
  }

  const createDemoThesisStudent = async () => {
    setCreatingDemoThesis(true)
    try {
      const d = await api<{
        student: { email: string; password: string; name: string }
        admission: { id: string; reference: string; program: string; status: string }
        thesis: { id: string; title: string; status: string; defenseDate: string }
        note: string
      }>('/api/admin/demo-thesis', { method: 'POST' })
      await load()
      setHighlightAdmissionId(d.admission.id)
      setActiveTab('admissions')
      toast({
        title: 'تم تجهيز طالب بحث تجريبي',
        description: `الدخول: ${d.student.email} / ${d.student.password} — افتح بوابة الطالب ثم بحث التخرج ثم قاعة المناقشة`,
      })
    } catch (e: any) {
      toast({ title: 'تعذر تجهيز الطالب التجريبي', description: e.message, variant: 'destructive' })
    } finally {
      setCreatingDemoThesis(false)
    }
  }

  const openStudentAdmission = (student: StudentRow) => {
    const linked = student.latestAdmission || admissions.find((a) => a.email.toLowerCase() === student.email.toLowerCase()) || null
    if (!linked) {
      toast({
        title: 'لا يوجد طلب التحاق مرتبط',
        description: 'هذا الطالب لديه حساب أو تسجيل، لكن لا توجد له بطاقة طلب التحاق مفصلة حالياً.',
      })
      return
    }
    setHighlightAdmissionId(linked.id)
    setActiveTab('admissions')
  }

  const studyAdmissions = admissions.filter((a) => a.isStudyProgram !== false)
  const serviceRequests = admissions.filter((a) => a.isStudyProgram === false)
  const visibleAdmissionRows = activeTab === 'service-requests' ? serviceRequests : studyAdmissions
  const academicStudents = students.filter((s) => (s.enrollments?.length || 0) > 0)

  const kpis = data
    ? [
        { icon: Users2, label: 'الطلاب المسجلون', value: data.stats.totalStudents, color: 'bg-[#0f2b46] text-[#e0b83a]' },
        { icon: GraduationCap, label: 'التسجيلات في البرامج', value: data.stats.totalEnrollments, color: 'bg-[#c9a227] text-[#0f2b46]' },
        { icon: ClipboardCheck, label: 'امتحانات مصححة AI', value: data.stats.totalAttempts, color: 'bg-emerald-600 text-white' },
        { icon: Bot, label: 'رسائل المشرف الذكي', value: data.stats.totalChats, color: 'bg-[#b22234] text-white' },
        { icon: TrendingUp, label: 'نسبة النجاح', value: `${data.stats.passRate}%`, color: 'bg-[#12365c] text-[#e0b83a]' },
        { icon: ClipboardList, label: 'طلبات التحاق دراسي معلقة', value: data.stats.pendingAdmissions, color: 'bg-amber-500 text-white' },
        { icon: PackageCheck, label: 'خدمات عابرة معلقة', value: data.stats.pendingServices || 0, color: 'bg-purple-600 text-white' },
        { icon: Award, label: 'خدمات مدفوعة تنتظر التسليم', value: data.stats.paidServicesWaitingDelivery || 0, color: 'bg-indigo-600 text-white' },
        { icon: Globe2, label: 'طلبات وكالة/اعتماد معلقة', value: data.stats.pendingAgents, color: 'bg-slate-600 text-white' },
      ]
    : []

  return (
    <div className="aact-fade-in mx-auto max-w-7xl px-4 py-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">لوحة إدارة الأكاديمية</h1>
          <p className="mt-1 text-sm text-slate-500">نظرة شاملة على أداء المنصة — الطلاب، الامتحانات، المشرف الذكي، طلبات الالتحاق والاعتمادات</p>
        </div>
        <Button
          onClick={createDemoThesisStudent}
          disabled={creatingDemoThesis}
          className="bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#183c5f]"
        >
          {creatingDemoThesis ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Gavel className="ml-2 h-4 w-4" />}
          تجهيز طالب بحث تجريبي
        </Button>
      </div>

      <Card className="mt-4 border-[#c9a227]/35 bg-[#fffaf0]">
        <CardContent className="p-4 text-xs font-bold leading-7 text-[#0f2b46] sm:text-sm">
          زر التجهيز ينشئ طالباً تجريبياً مع طلب قبول مدفوع، مشرف أكاديمي، بحث تخرج مجدول الآن، ولجنة تشمل المستشار الذكي لاختبار قاعة الفيديو كونفرنس فوراً.
        </CardContent>
      </Card>

      {/* KPIs */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
        {kpis.map((k) => (
          <Card key={k.label} className="border-[#0f2b46]/10">
            <CardContent className="p-4">
              <div className={`mx-auto mb-2.5 w-fit rounded-xl p-2.5 ${k.color}`}>
                <k.icon className="h-5 w-5" />
              </div>
              <div className="text-center text-xl font-black text-[#0f2b46] sm:text-2xl">{k.value}</div>
              <div className="mt-1 text-center text-[10px] font-bold leading-tight text-slate-500">{k.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        className="mt-8"
        dir="rtl"
      >
        {/* تنظيم علمي: التبويبات مجمعة بأربعة أقسام وظيفية واضحة */}
        <div className="space-y-2.5 rounded-2xl border border-[#0f2b46]/10 bg-white p-3">
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-black text-[#b22234]">
              <UserCheck className="h-3.5 w-3.5" /> القبول والتسجيل
            </p>
            <TabsList className="flex h-auto w-full flex-wrap gap-1 bg-transparent p-0">
              <TabsTrigger value="admissions" className="gap-1 text-[10px] font-bold sm:text-xs">الالتحاق الدراسي ({admissionsLoading ? '…' : studyAdmissions.length})</TabsTrigger>
              <TabsTrigger value="service-requests" className="gap-1 text-[10px] font-bold sm:text-xs">الخدمات العابرة ({admissionsLoading ? '…' : serviceRequests.length})</TabsTrigger>
              <TabsTrigger value="rules" className="gap-1 text-[10px] font-bold sm:text-xs">قواعد القبول</TabsTrigger>
              <TabsTrigger value="students" className="gap-1 text-[10px] font-bold sm:text-xs">الطلاب ({studentsLoading ? '…' : academicStudents.length})</TabsTrigger>
              <TabsTrigger value="supervisors" className="gap-1 text-[10px] font-bold sm:text-xs">إدارة المشرفين</TabsTrigger>
              <TabsTrigger value="agents" className="gap-1 text-[10px] font-bold sm:text-xs">الوكالة والاعتماد ({appsLoading ? '…' : apps.length})</TabsTrigger>
            </TabsList>
          </div>
          <div className="border-t border-dashed border-slate-100 pt-2.5">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-black text-[#a8841a]">
              <BookMarked className="h-3.5 w-3.5" /> العملية الأكاديمية
            </p>
            <TabsList className="flex h-auto w-full flex-wrap gap-1 bg-transparent p-0">
              <TabsTrigger value="books" className="gap-1 text-[10px] font-bold sm:text-xs">الكتب والاختبارات</TabsTrigger>
              <TabsTrigger value="quality" className="gap-1 text-[10px] font-bold sm:text-xs">مركز الجودة</TabsTrigger>
              <TabsTrigger value="attempts" className="gap-1 text-[10px] font-bold sm:text-xs">نتائج الامتحانات</TabsTrigger>
              <TabsTrigger value="thesis" className="gap-1 text-[10px] font-bold sm:text-xs">أبحاث التخرج والمناقشات</TabsTrigger>
              <TabsTrigger value="ai" className="gap-1 text-[10px] font-bold sm:text-xs">سجل المشرف الذكي</TabsTrigger>
            </TabsList>
          </div>
          <div className="border-t border-dashed border-slate-100 pt-2.5">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-black text-emerald-700">
              <Banknote className="h-3.5 w-3.5" /> المالية والشهادات
            </p>
            <TabsList className="flex h-auto w-full flex-wrap gap-1 bg-transparent p-0">
              <TabsTrigger value="finance" className="gap-1 text-[10px] font-bold sm:text-xs">المالية والفواتير</TabsTrigger>
              <TabsTrigger value="certs" className="gap-1 text-[10px] font-bold sm:text-xs">الشهادات</TabsTrigger>
            </TabsList>
          </div>
          <div className="border-t border-dashed border-slate-100 pt-2.5">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-black text-[#12365c]">
              <Settings2 className="h-3.5 w-3.5" /> إعدادات النظام
            </p>
            <TabsList className="flex h-auto w-full flex-wrap gap-1 bg-transparent p-0">
              <TabsTrigger value="system" className="gap-1 text-[10px] font-bold sm:text-xs">البريد والدفع والفيديو</TabsTrigger>
              <TabsTrigger value="settings" className="gap-1 text-[10px] font-bold sm:text-xs">الرسوم والقواعد</TabsTrigger>
              <TabsTrigger value="audit" className="gap-1 text-[10px] font-bold sm:text-xs">سجل التدقيق</TabsTrigger>
              <TabsTrigger value="messages" className="gap-1 text-[10px] font-bold sm:text-xs">رسائل التواصل</TabsTrigger>
            </TabsList>
          </div>
        </div>

        {/* Study admissions + transient service requests. نفس قالب البطاقة، لكن كل مسار في تبويب منفصل. */}
        <TabsContent value={activeTab === 'service-requests' ? 'service-requests' : 'admissions'}>
          <div className="mt-4 space-y-4">
            {admissionsLoading ? (
              <Card className="border-[#0f2b46]/10">
                <CardContent className="flex h-40 flex-col items-center justify-center gap-3 text-center">
                  <Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" />
                  <p className="text-sm font-black text-[#0f2b46]">جاري تحميل {activeTab === 'service-requests' ? 'طلبات الخدمات العابرة' : 'طلبات الالتحاق الدراسي'}...</p>
                  <p className="text-xs font-bold text-slate-400">تفتح لوحة الإدارة الآن بينما تُحمّل التفاصيل في الخلفية.</p>
                </CardContent>
              </Card>
            ) : visibleAdmissionRows.length === 0 ? (
              <Card className="border-[#0f2b46]/10">
                <CardContent className="p-10 text-center text-sm text-slate-400">{activeTab === 'service-requests' ? 'لا توجد طلبات خدمات عابرة حالياً' : 'لا توجد طلبات التحاق دراسي حالياً'}</CardContent>
              </Card>
            ) : (
              visibleAdmissionRows.map((a) => {
                const unpaid = (a.payments || []).filter((p) => p.status === 'UNPAID')
                const ownerIsStaffAccount = !!a.user && a.user.role !== 'STUDENT'
                const isStudyAdmission = a.isStudyProgram !== false
                const serviceHasInvoice = !isStudyAdmission && (a.payments || []).length > 0
                const serviceDeliveryReady = !isStudyAdmission && a.status === 'RESULT_APPROVED' && serviceHasInvoice && unpaid.length === 0
                const supervisorAssigned = a.status === 'SUPERVISOR_ASSIGNED' || a.status === 'THESIS' || a.status === 'SCHEDULED' || a.status === 'AWAITING_TUITION' || a.status === 'RESULT_APPROVED' || a.status === 'CERTIFIED'
                return (
                  <Card
                    key={a.id}
                    id={`admission-${a.id}`}
                    className={`aact-responsive-card aact-readable transition-all ${highlightAdmissionId === a.id ? 'border-[#c9a227] shadow-lg shadow-[#c9a227]/20 ring-2 ring-[#c9a227]/40' : 'border-[#0f2b46]/10'}`}
                  >
                    <CardContent className="p-4 sm:p-5">
                      <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 w-full sm:flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-md bg-[#0f2b46] px-2 py-0.5 font-mono text-[10px] font-bold text-[#e0b83a]" dir="ltr">{a.reference}</span>
                            <h3 className="text-sm font-black text-[#0f2b46]">{a.fullName}</h3>
                            <Badge className={`${STATUS_BADGE[a.status] || 'bg-slate-100 text-slate-600'} hover:bg-inherit`}>
                              <Clock3 className="ml-1 h-3 w-3" /> {!isStudyAdmission && a.status === 'RESULT_APPROVED' ? 'تم اعتماد الخدمة' : STATUS_LABEL[a.status] || a.status}
                            </Badge>
                            <Badge className={isStudyAdmission ? 'bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]' : 'bg-purple-100 text-purple-700 hover:bg-purple-100'}>
                              {a.requestLabel || (isStudyAdmission ? 'طلب التحاق دراسي' : 'طلب خدمة مهنية')}
                            </Badge>
                          </div>
                          <p className="mt-1.5 text-xs font-bold text-slate-600">
                            {isStudyAdmission ? 'البرنامج' : 'الخدمة'}: {a.program} — {isStudyAdmission ? `المؤهل: ${EDUCATION_LABEL[a.education] || a.education}` : `نوع المسار: ${a.requestKind || 'خدمة'}`} — {a.country}
                          </p>
                          <p className="mt-0.5 text-[11px] text-slate-400" dir="ltr">{a.email} · {a.phone}</p>
                          {(a.files?.length || 0) > 0 ? (
                            <div className="mt-2 rounded-xl border border-emerald-100 bg-emerald-50/50 p-2.5">
                              <p className="text-[11px] font-black text-emerald-700">
                                <Paperclip className="ml-0.5 inline h-3.5 w-3.5" /> المستندات المرفوعة ({a.files!.length}{isStudyAdmission ? '/4' : ''}):
                              </p>
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                {a.files!.map((f) => (
                                  <a
                                    key={f.id}
                                    href={`/api/admissions/docs/${f.id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="rounded-lg border border-emerald-200 bg-white px-2.5 py-1 text-[10px] font-bold text-emerald-700 transition-colors hover:bg-emerald-100"
                                  >
                                    <FileText className="ml-1 inline h-3 w-3" />
                                    {DOC_TYPE_AR[f.docType] || f.docType} ({Math.ceil(f.size / 1024)}ك.ب)
                                  </a>
                                ))}
                              </div>
                            </div>
                          ) : (
                            <p className="mt-1 text-[11px] font-bold text-red-500">لا توجد مستندات مرفوعة (الطلبات القديمة قبل تفعيل الرفع الإلزامي)</p>
                          )}

                          {!isStudyAdmission && !(a.payments?.length || 0) && (
                            <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-[10px] font-bold leading-5 text-amber-800">
                              لا توجد فاتورة خدمة لهذا الطلب بعد. اضغط الزر لإصدار فاتورة الخدمة ثم اطلب من العميل اختيار «دفع مباشر» أو أي وسيلة متاحة.
                              <Button size="sm" onClick={() => setAdmissionStatus(a.id, 'RESULT_APPROVED')} className="mt-2 h-7 bg-amber-600 px-2 text-[10px] font-black text-white hover:bg-amber-700">
                                إصدار فاتورة الخدمة
                              </Button>
                            </div>
                          )}

                          {!!a.payments?.length && (
                            <div className="mt-2 rounded-xl border border-amber-100 bg-amber-50/40 p-2.5">
                              <p className="mb-1.5 text-[11px] font-black text-amber-700"><Banknote className="ml-1 inline h-3.5 w-3.5" /> فواتير هذا الطلب</p>
                              <div className="grid gap-1.5">
                                {a.payments.map((p) => (
                                  <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-2 text-[10px]">
                                    <div className="min-w-0">
                                      <span className="font-mono font-black text-[#0f2b46]" dir="ltr">{p.invoiceNo || p.id}</span>
                                      <span className="mr-2 font-bold text-slate-500">{p.purpose} — {p.amount}$</span>
                                      {p.method && <span className="mr-2 text-slate-400">طريقة: {p.method === 'DIRECT_PAYMENT' ? 'دفع مباشر' : p.method === 'USDT' ? 'USDT' : p.method}</span>}
                                      {p.method === 'USDT' && (
                                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                                          <span>الشبكة: {p.cryptoNetwork || 'TRC20'}</span>
                                          {p.cryptoTxHash ? <span dir="ltr">TX: {String(p.cryptoTxHash).slice(0, 10)}…{String(p.cryptoTxHash).slice(-6)}</span> : <span className="text-amber-600">بانتظار TX Hash</span>}
                                          {p.cryptoVerificationStatus && (
                                            <Badge className={p.cryptoVerificationStatus === 'VERIFIED' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : p.cryptoVerificationStatus === 'FAILED' ? 'bg-red-100 text-red-700 hover:bg-red-100' : 'bg-slate-100 text-slate-600 hover:bg-slate-100'}>
                                              {p.cryptoVerificationStatus === 'VERIFIED' ? 'تحقق آلي ناجح' : p.cryptoVerificationStatus === 'FAILED' ? 'فشل التحقق' : p.cryptoVerificationStatus}
                                            </Badge>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-1.5">
                                      {p.status === 'PAID' ? (
                                        <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">مدفوعة {p.receiptNo ? `(${p.receiptNo})` : ''}</Badge>
                                      ) : (
                                        <>
                                          <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">بانتظار الدفع</Badge>
                                          <Button size="sm" variant="outline" onClick={() => openPaymentConfirmDialog(p)} className="h-7 border-emerald-200 px-2 text-[10px] font-black text-emerald-700">
                                            {p.method === 'USDT' ? 'تأكيد USDT بعد التحقق' : 'تأكيد استلام الدفع المباشر'}
                                          </Button>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}

                          {isStudyAdmission && a.tuitionPlan && (
                            <div className="mt-2 rounded-xl border border-blue-100 bg-blue-50/50 p-3">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-[11px] font-black text-blue-800"><Banknote className="ml-1 inline h-3.5 w-3.5" /> خطة الرسوم والتقسيط</p>
                                <Badge className="bg-white text-blue-700 hover:bg-white">مدفوع {a.tuitionPlan.paidTuition}$ / {a.tuitionPlan.totalTuition}$</Badge>
                              </div>
                              <div className="mt-2 grid gap-2 text-[10px] font-bold text-blue-900 sm:grid-cols-3">
                                <div className="rounded-lg bg-white p-2">المتبقي: {a.tuitionPlan.remainingTuition}$</div>
                                <div className="rounded-lg bg-white p-2">شرط الفصل الأول: {a.tuitionPlan.firstSemesterRequiredAmount}$ {a.tuitionPlan.firstSemesterAllowed ? '✓' : '✕'}</div>
                                <div className="rounded-lg bg-white p-2">شرط الفصل الثاني: {a.tuitionPlan.finalRequiredAmount}$ {a.tuitionPlan.secondSemesterAllowed ? '✓' : '✕'}</div>
                              </div>
                              {a.tuitionAppeal && (
                                <div className="mt-2 rounded-lg border border-blue-100 bg-white p-2 text-[10px] font-bold leading-5 text-slate-600">
                                  <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div>
                                      <span className="font-black text-[#0f2b46]">التماس تقسيط: </span>
                                      <Badge className={a.tuitionAppeal.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : a.tuitionAppeal.status === 'PENDING' ? 'bg-amber-100 text-amber-700 hover:bg-amber-100' : 'bg-red-100 text-red-700 hover:bg-red-100'}>{a.tuitionAppeal.status}</Badge>
                                      <span className="mr-2">الدفعة المقترحة: {a.tuitionAppeal.requestedInitialAmount}$</span>
                                    </div>
                                    {a.tuitionAppeal.status === 'PENDING' && (
                                      <div className="flex gap-1">
                                        <Button size="sm" onClick={() => openTuitionAppealDialog(a.tuitionAppeal!, 'APPROVE', a.tuitionPlan, a)} className="h-7 bg-emerald-600 px-2 text-[10px] font-black text-white hover:bg-emerald-700">قبول التقسيط</Button>
                                        <Button size="sm" variant="outline" onClick={() => openTuitionAppealDialog(a.tuitionAppeal!, 'REJECT', a.tuitionPlan, a)} className="h-7 border-red-200 px-2 text-[10px] font-black text-red-700">رفض</Button>
                                      </div>
                                    )}
                                  </div>
                                  {a.tuitionAppeal.reason && <p className="mt-1">سبب الطالب: {a.tuitionAppeal.reason}</p>}
                                  {a.tuitionAppeal.proposedSchedule && <p className="mt-1">جدول مقترح: {a.tuitionAppeal.proposedSchedule}</p>}
                                  {a.tuitionAppeal.adminNote && <p className="mt-1 text-blue-700">ملاحظة الإدارة: {a.tuitionAppeal.adminNote}</p>}
                                </div>
                              )}
                            </div>
                          )}

                          {!isStudyAdmission && (
                            <div className="mt-3 rounded-xl border border-purple-100 bg-purple-50/60 p-3">
                              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                <p className="text-[11px] font-black text-purple-700"><Award className="ml-1 inline h-3.5 w-3.5" /> تنفيذ وتسليم الخدمة للعميل</p>
                                <Badge className="bg-white text-purple-700 hover:bg-white">{a.deliverables?.filter((d) => d.status === 'PUBLISHED' && d.visibleToStudent !== false).length || 0} منشور</Badge>
                              </div>
                              {a.serviceWorkflow && (
                                <div className="mb-3 rounded-xl border border-purple-100 bg-white p-3">
                                  <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                                    <div>
                                      <p className="text-[11px] font-black text-[#0f2b46]">{a.serviceWorkflow.workflow.title}</p>
                                      <p className="mt-1 text-[10px] font-bold leading-5 text-slate-500">{a.serviceWorkflow.workflow.summary}</p>
                                    </div>
                                    <Badge className="bg-purple-100 text-purple-700 hover:bg-purple-100">المرحلة: {a.serviceWorkflow.activeStage.label}</Badge>
                                  </div>
                                  <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                                    {a.serviceWorkflow.stages.map((stage, idx) => (
                                      <div key={`${a.id}-${stage.id}`} className={`rounded-lg border p-2 text-[10px] ${stage.state === 'done' ? 'border-emerald-100 bg-emerald-50 text-emerald-800' : stage.state === 'active' ? 'border-purple-200 bg-purple-50 text-purple-800' : 'border-slate-100 bg-slate-50 text-slate-500'}`}>
                                        <p className="font-black">{stage.state === 'done' ? <CheckCircle2 className="ml-1 inline h-3.5 w-3.5" /> : stage.state === 'active' ? <Clock3 className="ml-1 inline h-3.5 w-3.5" /> : <span className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-slate-200 text-[8px]">{idx + 1}</span>}{stage.label}</p>
                                        <p className="mt-1 leading-5 opacity-80">{stage.description}</p>
                                      </div>
                                    ))}
                                  </div>
                                  <div className="mt-2 rounded-lg bg-purple-50 px-2.5 py-2 text-[10px] font-bold leading-5 text-purple-800">
                                    الإجراء التالي: {a.serviceWorkflow.nextAction}
                                    {a.serviceWorkflow.expectedDeliverableTypes?.length ? <span className="block text-slate-500">المخرج المتوقع: {a.serviceWorkflow.expectedDeliverableTypes.map((t) => DELIVERABLE_TYPE_AR[t] || t).join(' / ')}</span> : null}
                                  </div>
                                </div>
                              )}
                              {!serviceDeliveryReady && (
                                <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[10px] font-bold leading-5 text-amber-800">
                                  لا يمكن نشر أي مخرج للعميل قبل اعتماد طلب الخدمة وسداد فاتورتها. اضغط أولاً «اعتماد طلب الخدمة وتحديد المتابعة»، ثم أكد الدفع من تبويب الدفعات.
                                </div>
                              )}

                              {!!a.deliverables?.length && (
                                <div className="mb-3 grid gap-2">
                                  {a.deliverables.map((d) => (
                                    <div key={d.id} className="rounded-lg border border-purple-100 bg-white p-2 text-[10px]">
                                      <div className="flex flex-wrap items-center justify-between gap-2">
                                        <div className="min-w-0">
                                          <p className="font-black text-[#0f2b46]">{d.title}</p>
                                          <p className="mt-0.5 text-slate-500">{DELIVERABLE_TYPE_AR[d.type] || d.type} — {d.status === 'PUBLISHED' ? 'منشور' : d.status === 'REVOKED' ? 'ملغى' : 'مسودة'} {d.visibleToStudent === false ? '— مخفي عن العميل' : ''}</p>
                                        </div>
                                        <div className="flex flex-wrap gap-1">
                                          {d.status !== 'REVOKED' && (
                                            <Button size="sm" variant="outline" onClick={() => revokeDeliverable(d.id)} className="h-7 text-[10px] font-black text-red-600">إلغاء</Button>
                                          )}
                                        </div>
                                      </div>
                                      {d.externalUrl && <p className="mt-1 truncate text-slate-400" dir="ltr">{d.externalUrl}</p>}
                                      {d.fileName && <p className="mt-1 text-slate-400"><Paperclip className="ml-1 inline h-3 w-3" />{d.fileName}</p>}
                                    </div>
                                  ))}
                                </div>
                              )}

                              <div className="grid gap-2 md:grid-cols-2">
                                <select
                                  value={deliverableForms[a.id]?.type || a.serviceWorkflow?.expectedDeliverableTypes?.[0] || 'PACKAGE_DOWNLOAD'}
                                  onChange={(e) => updateDeliverableForm(a.id, { type: e.currentTarget.value })}
                                  className="h-9 rounded-lg border border-purple-100 bg-white px-2 text-[11px] font-bold text-[#0f2b46]"
                                >
                                  {DELIVERABLE_TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                                </select>
                                <input
                                  value={deliverableForms[a.id]?.title || ''}
                                  onChange={(e) => updateDeliverableForm(a.id, { title: e.currentTarget.value })}
                                  placeholder="عنوان يظهر للعميل: شهادة معادلة / رابط تحميل / تقرير..."
                                  className="h-9 rounded-lg border border-purple-100 bg-white px-2 text-[11px] font-bold text-[#0f2b46]"
                                />
                                <input
                                  value={deliverableForms[a.id]?.externalUrl || ''}
                                  onChange={(e) => updateDeliverableForm(a.id, { externalUrl: e.currentTarget.value })}
                                  placeholder="رابط خارجي اختياري: تحميل، اجتماع، ملف..."
                                  dir="ltr"
                                  className="h-9 rounded-lg border border-purple-100 bg-white px-2 text-[11px] font-bold text-[#0f2b46]"
                                />
                                <input
                                  type="file"
                                  onChange={(e) => setDeliverableFiles((prev) => ({ ...prev, [a.id]: e.currentTarget.files?.[0] || null }))}
                                  className="h-9 rounded-lg border border-purple-100 bg-white px-2 py-1 text-[11px] font-bold text-[#0f2b46]"
                                />
                                <input
                                  value={deliverableForms[a.id]?.certificateId || ''}
                                  onChange={(e) => updateDeliverableForm(a.id, { certificateId: e.currentTarget.value })}
                                  placeholder="رقم شهادة/عضوية اختياري"
                                  className="h-9 rounded-lg border border-purple-100 bg-white px-2 text-[11px] font-bold text-[#0f2b46]"
                                />
                                <input
                                  value={deliverableForms[a.id]?.verificationUrl || ''}
                                  onChange={(e) => updateDeliverableForm(a.id, { verificationUrl: e.currentTarget.value })}
                                  placeholder="رابط تحقق اختياري"
                                  dir="ltr"
                                  className="h-9 rounded-lg border border-purple-100 bg-white px-2 text-[11px] font-bold text-[#0f2b46]"
                                />
                              </div>
                              <textarea
                                value={deliverableForms[a.id]?.description || ''}
                                onChange={(e) => updateDeliverableForm(a.id, { description: e.currentTarget.value })}
                                placeholder="وصف مختصر أو تعليمات للعميل..."
                                className="mt-2 min-h-[58px] w-full rounded-lg border border-purple-100 bg-white px-2 py-2 text-[11px] font-bold text-[#0f2b46]"
                              />
                              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                <label className="flex items-center gap-2 text-[10px] font-bold text-slate-500">
                                  <input type="checkbox" checked={deliverableForms[a.id]?.visibleToStudent !== false} onChange={(e) => updateDeliverableForm(a.id, { visibleToStudent: e.currentTarget.checked })} />
                                  يظهر للعميل فوراً ويرسل إشعاراً بالبريد
                                </label>
                                <Button size="sm" disabled={deliverableLoading === a.id || !serviceDeliveryReady} onClick={() => submitDeliverable(a)} className="bg-purple-700 text-white hover:bg-purple-800 disabled:opacity-50">
                                  {deliverableLoading === a.id ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Award className="ml-1 h-3.5 w-3.5" />}
                                  تسليم المخرج
                                </Button>
                              </div>
                            </div>
                          )}
                          {a.thesisDeadline && (
                            <p className="mt-1 text-[11px] font-bold text-[#a8841a]">
                              مهلة بحث التخرج حتى: {new Date(a.thesisDeadline).toLocaleDateString('ar-EG')} (6 أشهر من القبول)
                            </p>
                          )}
                          {a.supervisor && (
                            <p className="mt-1 text-[11px] font-bold text-purple-600">
                              المشرف الأكاديمي: {a.supervisor.name}
                            </p>
                          )}
                          {unpaid.length > 0 && (
                            <p className="mt-1 text-[11px] font-bold text-amber-600">
                              فواتير غير مسددة: {unpaid.map((p) => `${p.amount}$`).join(' + ')}
                            </p>
                          )}
                          {a.notes && <p className="mt-1.5 max-w-2xl text-[11px] leading-relaxed text-slate-500">ملاحظات: {a.notes}</p>}
                          {ownerIsStaffAccount && (
                            <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] font-bold leading-6 text-red-700">
                              <AlertTriangle className="ml-1 inline h-3.5 w-3.5" />
                              هذا الطلب مرتبط بحساب إداري/غير طالب ({a.user?.role}). لا يُعتمد كقيد دراسة ولا تُصدر له فاتورة دراسية أو شهادة. الإجراء الصحيح: إنشاء حساب طالب منفصل ببريد الطالب الحقيقي ثم إعادة تقديم الطلب، أو رفض هذا الطلب كتجريبي.
                            </div>
                          )}

                          {/* ===== التقييم الذكي للطلب — يعرض قبل زر الاعتماد للمراجعة ===== */}
                          <div className={`mt-3 rounded-xl border p-3 ${(() => {
                            const v = aiReviews[a.id]?.verdict || a.aiVerdict
                            return v && AI_VERDICT_META[v] ? AI_VERDICT_META[v].border : 'border-[#c9a227]/40'
                          })()} bg-[#fdfaf3]`}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2">
                                <Badge className={`${AI_VERDICT_META[aiReviews[a.id]?.verdict || a.aiVerdict || '']?.cls || 'bg-[#c9a227] text-[#0f2b46]'} hover:bg-inherit text-[10px]`}>
                                  <Bot className="ml-1 h-3 w-3" />
                                  {aiReviews[a.id]?.verdict || a.aiVerdict
                                    ? AI_VERDICT_META[aiReviews[a.id]?.verdict || a.aiVerdict!]?.label || 'تقييم ذكي متوفر'
                                    : 'التقييم الذكي للطلب'}
                                </Badge>
                                {(aiReviews[a.id]?.fitScore ?? a.aiScore) != null && (
                                  <span className="rounded-lg bg-[#0f2b46] px-2 py-0.5 text-[10px] font-black text-[#e0b83a]">
                                    درجة توافق الملف: {aiReviews[a.id]?.fitScore ?? a.aiScore}%
                                  </span>
                                )}
                                {a.aiReviewedAt && !aiLoading && (
                                  <span className="text-[10px] font-bold text-slate-400">
                                    آخر تحليل: {new Date(a.aiReviewedAt).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })}
                                  </span>
                                )}
                              </div>
                              <div className="flex gap-1.5">
                                {aiReviews[a.id] && (
                                  <Button size="sm" variant="ghost" onClick={() => setAiOpen((p) => ({ ...p, [a.id]: !p[a.id] }))} className="h-7 text-[10px] font-black text-[#0f2b46]">
                                    {aiOpen[a.id] ? 'إخفاء التفاصيل' : 'عرض التفاصيل'}
                                  </Button>
                                )}
                                <Button size="sm" variant="outline" disabled={aiLoading === a.id} onClick={() => runAIReview(a.id, !!(a.aiVerdict || aiReviews[a.id]))} className="h-7 border-[#c9a227] text-[10px] font-black text-[#a8841a] hover:bg-[#f7edd0]">
                                  {aiLoading === a.id ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : <Sparkles className="ml-1 h-3 w-3" />}
                                  {a.aiVerdict || aiReviews[a.id] ? 'إعادة التحليل' : 'تحليل ذكي للطلب'}
                                </Button>
                              </div>
                            </div>

                            {aiLoading === a.id && !aiReviews[a.id] && (
                              <p className="mt-2 flex items-center gap-2 text-[11px] font-bold text-[#a8841a]">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" /> خبير الذكاء الاصطناعي يقرأ مدخلات الطالب ومرفقاته ويقارنها بمتطلبات البرنامج...
                              </p>
                            )}

                            {aiOpen[a.id] && aiReviews[a.id] && (
                              <div className="mt-3 space-y-3 border-t border-[#c9a227]/20 pt-3">
                                <p className="text-[11px] leading-relaxed font-medium text-[#0f2b46]">{aiReviews[a.id]!.summaryForAdmin}</p>

                                {/* قائمة المتطلبات: مكتمل / ناقص / غير قابل للتحقق / مشكلة */}
                                <div>
                                  <p className="mb-1.5 text-[10px] font-black text-slate-500">مقارنة الملف بمتطلبات البرنامج:</p>
                                  <div className="grid gap-1.5 sm:grid-cols-2">
                                    {aiReviews[a.id]!.checklist.map((c, i) => {
                                      const meta = CHECK_STATUS_META[c.status] || CHECK_STATUS_META.UNVERIFIED
                                      return (
                                        <div key={i} className="flex items-start gap-1.5 rounded-lg bg-white p-2 text-[10px]">
                                          <meta.icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${meta.cls}`} />
                                          <div className="min-w-0">
                                            <p className="font-black text-[#0f2b46]">{c.requirement}</p>
                                            <p className="mt-0.5 leading-relaxed text-slate-500">{c.detail}</p>
                                          </div>
                                        </div>
                                      )
                                    })}
                                  </div>
                                </div>

                                {(aiReviews[a.id]!.documentAnalyses?.length || 0) > 0 && (
                                  <div>
                                    <p className="mb-1.5 text-[10px] font-black text-slate-500">تحليل كل مرفق على حدة:</p>
                                    <div className="grid gap-1.5 lg:grid-cols-2">
                                      {aiReviews[a.id]!.documentAnalyses!.map((d, i) => (
                                        <div key={`${d.fileName}-${i}`} className="rounded-lg border border-slate-100 bg-white p-2 text-[10px]">
                                          <div className="flex flex-wrap items-center gap-1.5">
                                            <Badge className={`${d.recommendation === 'ACCEPT_AS_EVIDENCE' ? 'bg-emerald-100 text-emerald-700' : d.recommendation === 'REQUEST_REPLACEMENT' || d.recommendation === 'IGNORE_AS_NON_ADMISSION' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'} hover:bg-inherit text-[9px]`}>
                                              {DOC_RECOMMENDATION_AR[d.recommendation] || d.recommendation}
                                            </Badge>
                                            <span className="rounded bg-[#0f2b46] px-1.5 py-0.5 font-black text-[#e0b83a]">{d.coverage}%</span>
                                          </div>
                                          <p className="mt-1 font-black text-[#0f2b46]">{d.fileName}</p>
                                          <p className="mt-0.5 text-slate-500">المرفوع كـ {d.declaredLabel} — المكتشف: {d.detectedLabel}</p>
                                          <div className="mt-1 grid grid-cols-3 gap-1 text-[9px] font-bold text-slate-500">
                                            <span className="rounded bg-slate-50 p-1">واضح: {d.clearEnough ? 'نعم' : 'لا'}</span>
                                            <span className="rounded bg-slate-50 p-1">يخص الطالب: {TRI_STATE_AR[d.belongsToStudent] || d.belongsToStudent}</span>
                                            <span className="rounded bg-slate-50 p-1">مرتبط: {TRI_STATE_AR[d.relatedToProgram] || d.relatedToProgram}</span>
                                          </div>
                                          <p className="mt-1 leading-relaxed text-slate-600">{d.coverageReason}</p>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {aiReviews[a.id]!.findings.length > 0 && (
                                  <div>
                                    <p className="mb-1.5 text-[10px] font-black text-slate-500">ملاحظات وتقييم خبير الذكاء الاصطناعي:</p>
                                    <div className="space-y-1.5">
                                      {aiReviews[a.id]!.findings.map((f, i) => {
                                        const sm = SEVERITY_META[f.severity] || SEVERITY_META.MEDIUM
                                        return (
                                          <div key={i} className="rounded-lg border border-slate-100 bg-white p-2 text-[10px]">
                                            <div className="flex flex-wrap items-center gap-1.5">
                                              <Badge className={`${sm.cls} hover:bg-inherit text-[9px]`}>{sm.label}</Badge>
                                              <p className="font-black text-[#0f2b46]">{f.title}</p>
                                            </div>
                                            <p className="mt-1 leading-relaxed text-slate-600">{f.detail}</p>
                                          </div>
                                        )
                                      })}
                                    </div>
                                  </div>
                                )}

                                {aiReviews[a.id]!.strengths.length > 0 && (
                                  <div className="flex flex-wrap gap-1.5">
                                    {aiReviews[a.id]!.strengths.map((s, i) => (
                                      <span key={i} className="rounded-lg bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700">+ {s}</span>
                                    ))}
                                  </div>
                                )}

                                <div className="rounded-lg bg-[#0f2b46] p-2.5 text-[10px] font-bold leading-relaxed text-[#f5f0e1]">
                                  توصية خبير الذكاء الاصطناعي للإدارة: {aiReviews[a.id]!.recommendedAction}
                                  <span className="mt-0.5 block text-[9px] text-[#e0b83a]/70">
                                    ({aiReviews[a.id]!.engine === 'RULES_ONLY' ? 'فحص قواعدي — تعذر تحليل النموذج اللغوي' : 'تحليل ذكاء اصطناعي + قواعد مقارنة'} — القرار النهائي لكم أنتم)
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>

                          {/* تعيين المشرف الأكاديمي يخص مسارات الدراسة فقط، وليس الخدمات العابرة */}
                          {isStudyAdmission && !ownerIsStaffAccount && a.status !== 'REJECTED' && a.status !== 'CERTIFIED' && (
                            <div className="mt-3 flex max-w-md items-center gap-2 rounded-xl bg-[#f7edd0]/50 p-2.5">
                              <UserCheck className="h-4 w-4 shrink-0 text-[#a8841a]" />
                              <Select
                                value={a.supervisor?.id || a.supervisorId || 'AI_ONLY'}
                                onValueChange={(v) => assignSupervisor(a.id, v)}
                              >
                                <SelectTrigger className="h-8 flex-1 text-xs">
                                  <SelectValue placeholder="تعيين مشرف أكاديمي للطالب..." />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="AI_ONLY">المشرف الذكي فقط</SelectItem>
                                  {supervisors.map((s) => (
                                    <SelectItem key={s.id} value={s.id}>{s.name} {s.role === 'ADMIN' ? '(إدارة)' : '(مشرف بشري)'}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                        </div>

                        {/* أزرار آلة الحالات وفق الترتيب الرسمي: سداد 30$ ← دراسة الإدارة والإقرار ← سداد الرسوم الدراسية ← تسجيل نهائي */}
                        {!ownerIsStaffAccount && a.status !== 'REJECTED' && a.status !== 'CERTIFIED' && (
                          <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
                            <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:justify-end">
                              {a.status === 'AWAITING_FEE' && (
                                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold leading-relaxed text-amber-700">
                                  <Banknote className="ml-1 inline h-3.5 w-3.5" />
                                  لم يُحوَّل الملف للإدارة بعد — بانتظار سداد المتقدم رسوم التقديم (30$) من صفحة طلب الالتحاق أو التتبع
                                </div>
                              )}
                              {a.status === 'PENDING' && (
                                <Button size="sm" variant="outline" onClick={() => setAdmissionStatus(a.id, 'UNDER_REVIEW')} className="border-blue-200 font-bold text-blue-600">
                                  <Search className="ml-1 h-3.5 w-3.5" /> {isStudyAdmission ? 'بدء الدراسة' : 'بدء مراجعة الخدمة'}
                                </Button>
                              )}
                              {['UNDER_REVIEW', 'PENDING'].includes(a.status) && (
                                <>
                                  {(() => {
                                    const v = aiReviews[a.id]?.verdict || a.aiVerdict
                                    if (!v || v === 'RECOMMEND_APPROVE') return null
                                    const vm = AI_VERDICT_META[v]
                                    if (!vm) return null
                                    return (
                                      <div className={`rounded-xl border ${vm.border} px-3 py-2 text-[11px] font-bold leading-relaxed ${v === 'RECOMMEND_REJECT' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                                        <AlertTriangle className="ml-1 inline h-3.5 w-3.5" />
                                        {vm.label} — راجع ملاحظات خبير الذكاء الاصطناعي بالأعلى قبل المتابعة
                                      </div>
                                    )
                                  })()}
                                  {isStudyAdmission ? (
                                    <Button size="sm" onClick={() => setAdmissionStatus(a.id, 'AWAITING_TUITION')} className="bg-emerald-600 font-bold text-white hover:bg-emerald-700">
                                      <CheckCircle2 className="ml-1 h-3.5 w-3.5" /> الإقرار بالقبول وإصدار فاتورة الرسوم الدراسية
                                    </Button>
                                  ) : (
                                    <Button size="sm" onClick={() => setAdmissionStatus(a.id, 'RESULT_APPROVED')} className="bg-emerald-600 font-bold text-white hover:bg-emerald-700">
                                      <CheckCircle2 className="ml-1 h-3.5 w-3.5" /> اعتماد طلب الخدمة وتحديد المتابعة
                                    </Button>
                                  )}
                                </>
                              )}
                              {a.status === 'AWAITING_TUITION' && (
                                <div className="rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/60 px-3 py-2 text-[11px] font-bold leading-relaxed text-[#a8841a]">
                                  <Clock3 className="ml-1 inline h-3.5 w-3.5" />
                                  تم الإقرار بالقبول — بانتظار سداد المتقدم الرسوم الدراسية كاملة (يُفعَّل التسجيل النهائي تلقائياً فور السداد)
                                </div>
                              )}
                              {isStudyAdmission && ['SUPERVISOR_ASSIGNED', 'THESIS', 'SCHEDULED', 'RESULT_APPROVED'].includes(a.status) && (
                                <Button size="sm" variant="outline" onClick={() => setAdmissionStatus(a.id, 'CERTIFIED')} className="border-[#c9a227] font-bold text-[#a8841a] hover:bg-[#f7edd0]">
                                  <Award className="ml-1 h-3.5 w-3.5" /> إصدار الشهادة الدراسية
                                </Button>
                              )}
                              <Button size="sm" variant="outline" onClick={() => setAdmissionStatus(a.id, 'REJECTED')} className="border-red-200 font-bold text-red-500">
                                <XCircle className="ml-1 h-3.5 w-3.5" /> رفض
                              </Button>
                            </div>
                          </div>
                        )}
                        {ownerIsStaffAccount && a.status !== 'REJECTED' && (
                          <div className="flex w-full flex-col items-stretch gap-2 sm:w-64">
                            <Button size="sm" variant="outline" onClick={() => setAdmissionStatus(a.id, 'REJECTED')} className="border-red-200 bg-red-50 font-bold text-red-600 hover:bg-red-100">
                              <XCircle className="ml-1 h-3.5 w-3.5" /> إغلاقه كطلب تجريبي/إداري
                            </Button>
                          </div>
                        )}
                        {isStudyAdmission && a.status === 'CERTIFIED' && (
                          <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                            <Award className="ml-1 h-3.5 w-3.5" /> شهادة دراسية صادرة — ظاهرة في تبويب الشهادات
                          </Badge>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )
              })
            )}
          </div>
        </TabsContent>

        {/* قواعد القبول المخصصة لكل برنامج — يطبقها خبير القبول الذكي قبل زر الاعتماد */}
        <TabsContent value="rules">
          <AdminRulesTab />
        </TabsContent>

        {/* Recent attempts */}
        <TabsContent value="attempts">
          <Card className="mt-4 border-[#0f2b46]/10">
            <CardContent className="p-0">
              <div className="aact-scroll max-h-[520px] overflow-y-auto">
                {data?.recentAttempts.length === 0 ? (
                  <div className="p-10 text-center text-sm text-slate-400">لا توجد محاولات امتحانات بعد</div>
                ) : (
                  <table className="w-full text-right text-xs sm:text-sm">
                    <thead className="sticky top-0 bg-[#f7edd0] text-[#0f2b46]">
                      <tr>
                        <th className="p-3 font-black">الطالب</th>
                        <th className="p-3 font-black">الاختبار</th>
                        <th className="p-3 font-black">النتيجة</th>
                        <th className="p-3 font-black">الحالة</th>
                        <th className="hidden p-3 font-black sm:table-cell">التاريخ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data?.recentAttempts.map((a) => (
                        <tr key={a.id} className="border-t border-slate-100">
                          <td className="p-3">
                            <div className="font-extrabold text-[#0f2b46]">{a.student}</div>
                            <div className="text-[10px] text-slate-400" dir="ltr">{a.email}</div>
                          </td>
                          <td className="p-3">
                            <div className="max-w-52 truncate font-bold text-slate-600">{a.exam}</div>
                            <div className="text-[10px] text-slate-400">{a.program}</div>
                          </td>
                          <td className="p-3 font-black text-[#0f2b46]">{a.score ?? '—'}%</td>
                          <td className="p-3">
                            {a.passed === true ? (
                              <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">ناجح</Badge>
                            ) : a.passed === false ? (
                              <Badge className="bg-red-100 text-red-600 hover:bg-red-100">راسب</Badge>
                            ) : (
                              <Badge variant="outline">—</Badge>
                            )}
                          </td>
                          <td className="hidden p-3 text-slate-400 sm:table-cell">
                            {new Date(a.submittedAt).toLocaleDateString('ar')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Students */}
        <TabsContent value="students">
          <Card className="mt-4 border-[#0f2b46]/10">
            <CardContent className="p-0">
              <div className="aact-scroll max-h-[520px] overflow-y-auto">
                {studentsLoading ? (
                  <div className="flex h-40 flex-col items-center justify-center gap-3 p-10 text-center text-sm text-slate-500">
                    <Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" />
                    جاري تحميل الطلاب...
                  </div>
                ) : academicStudents.length === 0 ? (
                  <div className="p-10 text-center text-sm text-slate-400">لا يوجد طلاب ملتحقون ببرامج دراسية بعد</div>
                ) : (
                  <table className="w-full text-right text-xs sm:text-sm">
                    <thead className="sticky top-0 bg-[#f7edd0] text-[#0f2b46]">
                      <tr>
                        <th className="p-3 font-black">الطالب</th>
                        <th className="p-3 font-black">برامجه</th>
                        <th className="p-3 font-black">أفضل نتيجة</th>
                        <th className="p-3 font-black">محادثات AI</th>
                        <th className="hidden p-3 font-black sm:table-cell">التسجيل</th>
                        <th className="p-3 font-black">متابعة</th>
                      </tr>
                    </thead>
                    <tbody>
                      {academicStudents.map((s) => (
                        <tr
                          key={s.id}
                          onClick={() => openStudentAdmission(s)}
                          className="cursor-pointer border-t border-slate-100 transition hover:bg-[#fff8e6]"
                          title="اضغط لفتح بطاقة طلب الالتحاق المرتبطة بهذا الطالب"
                        >
                          <td className="p-3">
                            <div className="font-extrabold text-[#0f2b46]">{s.name}</div>
                            <div className="text-[10px] text-slate-400" dir="ltr">{s.email}</div>
                            {s.latestAdmission ? (
                              <div className="mt-1 text-[10px] font-black text-[#a8841a]">فتح طلب {s.latestAdmission.reference}</div>
                            ) : (
                              <div className="mt-1 text-[10px] font-bold text-slate-400">لا يوجد طلب التحاق مرتبط</div>
                            )}
                          </td>
                          <td className="p-3">
                            {s.enrollments.length === 0 ? (
                              <span className="text-slate-400">—</span>
                            ) : (
                              <div className="space-y-1">
                                {s.enrollments.map((e, i) => (
                                  <div key={i} className="max-w-48 truncate text-[11px] font-bold text-slate-600">
                                    {e.program} {e.status === 'COMPLETED' && '✓'}
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="p-3 font-black text-[#0f2b46]">{s.bestScore != null ? `${s.bestScore}%` : '—'}</td>
                          <td className="p-3 font-bold text-slate-600">{s.aiChats}</td>
                          <td className="hidden p-3 text-slate-400 sm:table-cell">
                            {new Date(s.createdAt).toLocaleDateString('ar')}
                          </td>
                          <td className="p-3">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={(e) => {
                                e.stopPropagation()
                                openStudentPreview(s.id)
                              }}
                              className="border-[#c9a227]/50 text-[10px] font-black text-[#a8841a] hover:bg-[#fff7df]"
                            >
                              <Eye className="ml-1 h-3.5 w-3.5" /> معاينة
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* إدارة حسابات المشرفين البشريين */}
        <TabsContent value="supervisors">
          <AdminSupervisorsTab />
        </TabsContent>

        {/* Agent applications */}
        <TabsContent value="agents">
          <div className="mt-4 space-y-4">
            {appsLoading ? (
              <Card className="border-[#0f2b46]/10">
                <CardContent className="flex h-40 flex-col items-center justify-center gap-3 text-center text-sm text-slate-500">
                  <Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" />
                  جاري تحميل طلبات الوكالة والاعتماد...
                </CardContent>
              </Card>
            ) : apps.length === 0 ? (
              <Card className="border-[#0f2b46]/10">
                <CardContent className="p-10 text-center text-sm text-slate-400">لا توجد طلبات وكالة بعد</CardContent>
              </Card>
            ) : (
              apps.map((a) => {
                const submittedByStaff = !!a.submittedByStaff || (!!a.user && ['ADMIN', 'SUPERVISOR'].includes(a.user.role))
                return (
                <Card key={a.id} className="aact-responsive-card aact-readable border-[#0f2b46]/10">
                  <CardContent className="p-4 sm:p-5">
                    <div className="flex flex-col items-stretch gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 w-full sm:flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-sm font-black text-[#0f2b46]">{a.orgName}</h3>
                          {a.kind === 'ACCREDITATION' ? (
                            <Badge variant="outline" className="border-[#c9a227]/60 text-[10px] text-[#a8841a]">
                              {ACC_TYPE_LABEL[a.accreditationType || ''] || 'اعتماد'}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-[#0f2b46]/40 text-[10px] text-[#0f2b46]">وكالة دولية</Badge>
                          )}
                          {a.status === 'PENDING' && (
                            <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100"><Clock3 className="ml-1 h-3 w-3" /> معلق</Badge>
                          )}
                          {a.status === 'APPROVED' && (
                            <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><CheckCircle2 className="ml-1 h-3 w-3" /> مقبول</Badge>
                          )}
                          {a.status === 'REJECTED' && (
                            <Badge className="bg-red-100 text-red-600 hover:bg-red-100"><XCircle className="ml-1 h-3 w-3" /> مرفوض</Badge>
                          )}
                          {a.status === 'REVOKED' && (
                            <Badge className="bg-red-100 text-red-700 hover:bg-red-100"><AlertTriangle className="ml-1 h-3 w-3" /> اعتماد ملغى</Badge>
                          )}
                        </div>
                        <p className="mt-1 text-xs font-bold text-slate-600">
                          الممثل: {a.repName} — {a.country}{a.territory ? ` — نطاق التمثيل: ${a.territory}` : ''}
                        </p>
                        <p className="mt-0.5 text-[11px] text-slate-400" dir="ltr">{a.email} {a.phone ? `· ${a.phone}` : ''}</p>
                        {submittedByStaff && (
                          <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] font-bold leading-6 text-red-700">
                            <AlertTriangle className="ml-1 inline h-3.5 w-3.5" />
                            هذا الطلب مرتبط بحساب إدارة/مشرف ({a.user?.role || 'مطابق للبريد'}). لا يُعتمد كوكالة/اعتماد رسمي. الإجراء الصحيح: تقديم طلب جديد من حساب جهة/وكيل منفصل أو كزائر، ثم إغلاق هذا الطلب كتجريبي.
                          </div>
                        )}
                        {a.contractNo && (
                          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-[#f7edd0]/50 p-2.5 text-[11px] font-bold text-[#0f2b46]">
                            <span className="font-mono" dir="ltr">{a.contractNo}</span>
                            <span>• عمولة {a.commissionRate}%</span>
                            <span>• {a.exclusive ? 'حصري' : 'غير حصري'}</span>
                            {a.endDate && <span>• ينتهي {new Date(a.endDate).toLocaleDateString('ar-EG')}</span>}
                          </div>
                        )}
                        {a.experience && <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-500">{a.experience}</p>}
                        {a.status === 'REVOKED' && (
                          <div className="mt-3 rounded-xl border border-red-100 bg-red-50 p-3 text-[11px] font-bold leading-6 text-red-700">
                            <p className="font-black">تم سحب الاعتماد/الوكالة وفق قرار إداري موثق.</p>
                            {a.revokedAt && <p>تاريخ السحب: {new Date(a.revokedAt).toLocaleDateString('ar-EG')}</p>}
                            {a.revokedReason && <p>السبب: {a.revokedReason}</p>}
                          </div>
                        )}
                        {/* وثائق الاعتماد الرسمية المرفوعة (وفق دليل الإجراءات) + فاتورة رسوم التقديم */}
                        {a.kind === 'ACCREDITATION' && (
                          <div className="mt-3 rounded-xl border bg-slate-50/70 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <p className="text-[11px] font-black text-[#0f2b46]">
                                الوثائق الرسمية المرفوعة: {a.documents?.length || 0} / 4
                              </p>
                              {a.applicationFee && (
                                <Badge className={a.applicationFee.status === 'PAID' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
                                  رسوم التقديم {a.applicationFee.amount}$ — {a.applicationFee.status === 'PAID' ? 'مسددة' : 'غير مسددة'} ({a.applicationFee.invoiceNo})
                                </Badge>
                              )}
                            </div>
                            {!!a.documents?.length && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {a.documents.map((doc) => (
                                  <a
                                    key={doc.id}
                                    href={`/api/agent-docs/${doc.id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="flex items-center gap-1 rounded-full border border-[#c9a227]/40 bg-white px-2.5 py-1 text-[10px] font-bold text-[#0f2b46] hover:bg-[#f7edd0]/60"
                                  >
                                    <Paperclip className="h-3 w-3 text-[#a8841a]" />
                                    {AGENT_DOC_AR[doc.docType] || doc.docType} — {doc.fileName.slice(0, 20)}
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      {a.status === 'PENDING' && (
                        <div className="grid w-full grid-cols-1 gap-2 sm:w-auto sm:grid-cols-2">
                          {!submittedByStaff && (
                            <Button size="sm" onClick={() => setAppStatus(a.id, 'APPROVED')} className="bg-emerald-600 font-bold text-white hover:bg-emerald-700">
                              <CheckCircle2 className="ml-1 h-3.5 w-3.5" /> قبول
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => setAppStatus(a.id, 'REJECTED')} className="border-red-200 font-bold text-red-500">
                            <XCircle className="ml-1 h-3.5 w-3.5" /> {submittedByStaff ? 'إغلاق تجريبي' : 'رفض'}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => openAgentPreview(a.id)} className="border-[#c9a227]/50 font-bold text-[#a8841a] hover:bg-[#fff7df]">
                            <Eye className="ml-1 h-3.5 w-3.5" /> معاينة
                          </Button>
                        </div>
                      )}
                      {a.status === 'APPROVED' && (
                        <div className="grid w-full grid-cols-1 gap-2 sm:w-56">
                          <Button size="sm" variant="outline" onClick={() => openAgentPreview(a.id)} className="border-[#c9a227]/50 font-bold text-[#a8841a] hover:bg-[#fff7df]">
                            <Eye className="ml-1 h-3.5 w-3.5" /> معاينة
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => revokeApp(a)} className="border-red-200 bg-red-50 font-bold text-red-600 hover:bg-red-100">
                            <AlertTriangle className="ml-1 h-3.5 w-3.5" /> إلغاء الاعتماد
                          </Button>
                          <p className="rounded-lg bg-amber-50 p-2 text-[10px] font-bold leading-5 text-amber-700">
                            يستخدم فقط عند إخلال عقدي/مهني موثق. سيعطل صفحة التحقق لأي شهادة مرتبطة.
                          </p>
                        </div>
                      )}
                      {a.status !== 'PENDING' && a.status !== 'APPROVED' && (
                        <div className="grid w-full grid-cols-1 gap-2 sm:w-40">
                          <Button size="sm" variant="outline" onClick={() => openAgentPreview(a.id)} className="border-[#c9a227]/50 font-bold text-[#a8841a] hover:bg-[#fff7df]">
                            <Eye className="ml-1 h-3.5 w-3.5" /> معاينة
                          </Button>
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )})
            )}
          </div>
        </TabsContent>

        {/* المناقشات واللجان */}
        <TabsContent value="thesis">
          <AdminThesisTab />
        </TabsContent>

        {/* الكتب المقررة والاختبارات الشاملة */}
        <TabsContent value="books">
          <AdminBooksTab />
        </TabsContent>

        {/* مركز الجودة الأكاديمي الداخلي */}
        <TabsContent value="quality">
          <AdminQualityTab />
        </TabsContent>

        {/* 12.1: سجل المشرف الذكي — متاح للمشرف البشري والإدارة */}
        <TabsContent value="ai">
          <AdminAITab />
        </TabsContent>

        {/* المالية والتقارير */}
        <TabsContent value="finance">
          <AdminFinanceTab />
        </TabsContent>

        {/* الشهادات */}
        <TabsContent value="certs">
          <AdminCertificatesTab />
        </TabsContent>

        {/* الرسوم والإعدادات */}
        <TabsContent value="settings">
          <AdminSettingsTab />
        </TabsContent>

        {/* النظام: البريد + بوابات الدفع + TURN */}
        <TabsContent value="system">
          <AdminSystemTab />
        </TabsContent>

        {/* سجل التدقيق */}
        <TabsContent value="audit">
          <AdminAuditTab />
        </TabsContent>

        {/* رسائل التواصل */}
        <TabsContent value="messages">
          <AdminMessagesTab />
        </TabsContent>
      </Tabs>

      <Dialog open={!!paymentConfirmDialog} onOpenChange={(open) => { if (!open) setPaymentConfirmDialog(null) }}>
        <DialogContent dir="rtl" className="max-h-[92vh] overflow-y-auto rounded-3xl border-emerald-200 bg-gradient-to-b from-white to-emerald-50 p-0 sm:max-w-lg">
          {paymentConfirmDialog && (
            <div>
              <DialogHeader className="border-b border-emerald-100 bg-[#0f2b46] px-5 py-5 text-right text-white sm:px-6">
                <DialogTitle className="flex items-center gap-2 text-xl font-black text-white">
                  <Banknote className="h-5 w-5 text-[#f4d36d]" />
                  {paymentConfirmDialog.method === 'USDT' ? 'تأكيد دفع USDT' : 'تأكيد استلام الدفع'}
                </DialogTitle>
                <DialogDescription className="pt-1 text-xs font-bold leading-6 text-blue-100">
                  سيتم إصدار إيصال وتحديث إجراءات الطلب تلقائياً بعد التأكيد.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 p-5 sm:p-6">
                <div className="grid gap-3 rounded-2xl border border-emerald-100 bg-white p-4 text-xs font-bold text-slate-600 shadow-sm sm:grid-cols-2">
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-[10px] text-slate-400">رقم الفاتورة</p>
                    <p className="mt-1 break-all text-sm font-black text-[#0f2b46]">{paymentConfirmDialog.invoiceNo || 'غير محدد'}</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-[10px] text-slate-400">المبلغ</p>
                    <p className="mt-1 text-xl font-black text-emerald-700">{paymentConfirmDialog.amount || 0}$</p>
                  </div>
                </div>

                <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4 text-sm font-bold leading-7 text-amber-900">
                  {paymentConfirmDialog.method === 'USDT'
                    ? paymentConfirmDialog.cryptoVerificationStatus === 'VERIFIED'
                      ? 'تم التحقق آلياً من التحويل. اضغط التأكيد فقط إذا راجعت العملية وتأكدت من مطابقتها للفاتورة.'
                      : 'لا تؤكد دفع USDT قبل ظهور حالة التحقق الآلي الناجح. سيمنع النظام التأكيد إذا لم يتحقق التحويل.'
                    : 'استخدم هذا الزر فقط بعد استلام المبلغ فعلياً عبر الدفع المباشر أو التحويل المتفق عليه.'}
                </div>
              </div>

              <DialogFooter className="border-t border-emerald-100 bg-white px-5 py-4 sm:px-6">
                <Button variant="outline" onClick={() => setPaymentConfirmDialog(null)} disabled={paymentConfirmSubmitting} className="rounded-2xl font-black">
                  إلغاء
                </Button>
                <Button onClick={confirmAdmissionPayment} disabled={paymentConfirmSubmitting} className="rounded-2xl bg-emerald-600 font-black text-white hover:bg-emerald-700">
                  {paymentConfirmSubmitting && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
                  تأكيد وإصدار الإيصال
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!tuitionAppealDialog} onOpenChange={(open) => { if (!open) setTuitionAppealDialog(null) }}>
        <DialogContent dir="rtl" className="max-h-[92vh] overflow-y-auto rounded-3xl border-[#c9a227]/25 bg-gradient-to-b from-white to-[#fffaf0] p-0 sm:max-w-2xl">
          {tuitionAppealDialog && (
            <div>
              <DialogHeader className="border-b border-[#c9a227]/20 bg-[#0f2b46] px-5 py-5 text-right text-white sm:px-6">
                <DialogTitle className="flex items-center gap-2 text-xl font-black text-white">
                  <Banknote className="h-5 w-5 text-[#f4d36d]" />
                  {tuitionAppealDialog.decision === 'APPROVE' ? 'قبول طلب التقسيط' : 'رفض طلب التقسيط'}
                </DialogTitle>
                <DialogDescription className="pt-1 text-xs font-bold leading-6 text-blue-100">
                  {tuitionAppealDialog.studentName} — {tuitionAppealDialog.program}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 p-5 sm:p-6">
                <div className="grid gap-3 rounded-2xl border border-[#c9a227]/20 bg-white p-4 text-xs font-bold text-slate-600 shadow-sm sm:grid-cols-3">
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-[10px] text-slate-400">إجمالي الرسوم</p>
                    <p className="mt-1 text-lg font-black text-[#0f2b46]">{tuitionAppealDialog.plan?.totalTuition || tuitionAppealDialog.appeal.finalRequiredAmount || 0}$</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-[10px] text-slate-400">اقتراح الطالب</p>
                    <p className="mt-1 text-lg font-black text-[#0f2b46]">{tuitionAppealDialog.appeal.requestedInitialAmount}$</p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="text-[10px] text-slate-400">المدفوع حالياً</p>
                    <p className="mt-1 text-lg font-black text-emerald-700">{tuitionAppealDialog.plan?.paidTuition || 0}$</p>
                  </div>
                </div>

                {tuitionAppealDialog.appeal.reason && (
                  <div className="rounded-2xl border border-amber-100 bg-amber-50 p-4 text-xs font-bold leading-6 text-amber-900">
                    <p className="mb-1 font-black text-[#0f2b46]">سبب الطالب</p>
                    {tuitionAppealDialog.appeal.reason}
                  </div>
                )}

                {tuitionAppealDialog.decision === 'APPROVE' ? (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="space-y-2">
                      <Label className="text-xs font-black text-[#0f2b46]">الدفعة الأولى المقبولة</Label>
                      <Input
                        inputMode="decimal"
                        value={tuitionAppealForm.approvedInitialAmount}
                        onChange={(e) => setTuitionAppealForm((f) => ({ ...f, approvedInitialAmount: e.target.value }))}
                        className="h-12 rounded-2xl border-[#c9a227]/30 bg-white text-center text-lg font-black"
                      />
                      <p className="text-[10px] font-bold text-slate-400">تفعيل التسجيل يتم بعد سدادها.</p>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-black text-[#0f2b46]">قبل امتحان الفصل الأول</Label>
                      <Input
                        inputMode="decimal"
                        value={tuitionAppealForm.firstSemesterRequiredAmount}
                        onChange={(e) => setTuitionAppealForm((f) => ({ ...f, firstSemesterRequiredAmount: e.target.value }))}
                        className="h-12 rounded-2xl border-[#c9a227]/30 bg-white text-center text-lg font-black"
                      />
                      <p className="text-[10px] font-bold text-slate-400">غالباً نصف الرسوم.</p>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-xs font-black text-[#0f2b46]">قبل امتحان الفصل الثاني</Label>
                      <Input
                        inputMode="decimal"
                        value={tuitionAppealForm.finalRequiredAmount}
                        onChange={(e) => setTuitionAppealForm((f) => ({ ...f, finalRequiredAmount: e.target.value }))}
                        className="h-12 rounded-2xl border-[#c9a227]/30 bg-white text-center text-lg font-black"
                      />
                      <p className="text-[10px] font-bold text-slate-400">عادة كامل الرسوم.</p>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-red-100 bg-red-50 p-4 text-xs font-bold leading-6 text-red-800">
                    سيتم إشعار الطالب بأن الالتماس مرفوض، ولن يتم إنشاء خطة تقسيط من هذا الطلب.
                  </div>
                )}

                <div className="space-y-2">
                  <Label className="text-xs font-black text-[#0f2b46]">ملاحظة الإدارة للطالب</Label>
                  <Textarea
                    value={tuitionAppealForm.adminNote}
                    onChange={(e) => setTuitionAppealForm((f) => ({ ...f, adminNote: e.target.value }))}
                    placeholder={tuitionAppealDialog.decision === 'APPROVE' ? 'مثال: تمت الموافقة بشرط الالتزام بمواعيد السداد المحددة.' : 'مثال: يرجى التواصل مع الإدارة لتوضيح خطة السداد.'}
                    className="min-h-24 rounded-2xl border-[#c9a227]/30 bg-white text-sm font-bold leading-7"
                  />
                </div>

                <div className="rounded-2xl border border-blue-100 bg-blue-50 p-4 text-xs font-bold leading-6 text-blue-900">
                  عند قبول التقسيط: لا يفتح امتحان الفصل الأول قبل بلوغ مبلغ الفصل الأول، ولا يفتح امتحان الفصل الثاني قبل بلوغ المبلغ النهائي.
                </div>
              </div>

              <DialogFooter className="border-t border-[#c9a227]/20 bg-white px-5 py-4 sm:px-6">
                <Button variant="outline" onClick={() => setTuitionAppealDialog(null)} disabled={tuitionAppealSubmitting} className="rounded-2xl font-black">
                  إلغاء
                </Button>
                <Button
                  onClick={submitTuitionAppealDecision}
                  disabled={tuitionAppealSubmitting}
                  className={tuitionAppealDialog.decision === 'APPROVE' ? 'rounded-2xl bg-emerald-600 font-black text-white hover:bg-emerald-700' : 'rounded-2xl bg-red-600 font-black text-white hover:bg-red-700'}
                >
                  {tuitionAppealSubmitting && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}
                  {tuitionAppealDialog.decision === 'APPROVE' ? 'اعتماد خطة التقسيط' : 'تأكيد رفض الالتماس'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Program enrollment chart-like bars */}
      {data && data.programCounts.length > 0 && (
        <Card className="mt-8 border-[#0f2b46]/10">
          <CardContent className="p-5 sm:p-6">
            <h2 className="mb-4 flex items-center gap-2 text-base font-black text-[#0f2b46]">
              <BarChart3 className="h-5 w-5 text-[#c9a227]" /> التسجيلات حسب البرنامج
            </h2>
            <div className="space-y-3">
              {data.programCounts.map((p) => {
                const max = Math.max(...data.programCounts.map((x) => x.enrollments), 1)
                return (
                  <div key={p.titleAr} className="flex items-center gap-3">
                    <span className="w-40 shrink-0 truncate text-xs font-bold text-slate-600 sm:w-56">{p.titleAr}</span>
                    <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-gradient-to-l from-[#c9a227] to-[#e0b83a] transition-all"
                        style={{ width: `${Math.max(6, (p.enrollments / max) * 100)}%` }}
                      />
                    </div>
                    <span className="w-8 text-left text-xs font-black text-[#0f2b46]">{p.enrollments}</span>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
