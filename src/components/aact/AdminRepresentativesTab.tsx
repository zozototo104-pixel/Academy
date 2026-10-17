'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, Loader2, Plus, Save, Trash2, Upload, Sparkles, QrCode, ExternalLink, Image as ImageIcon, FileText, XCircle } from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAdminActionDialog } from './AdminActionDialog'

const REPRESENTATIVE_COUNTRIES = [
  'فلسطين', 'الأردن', 'مصر', 'السعودية', 'الإمارات', 'قطر', 'الكويت', 'البحرين', 'عُمان', 'العراق', 'سوريا', 'لبنان', 'اليمن',
  'تركيا', 'المغرب', 'الجزائر', 'تونس', 'ليبيا', 'السودان', 'موريتانيا', 'الصومال', 'جيبوتي', 'جزر القمر',
  'الولايات المتحدة', 'كندا', 'المملكة المتحدة', 'ألمانيا', 'فرنسا', 'إيطاليا', 'إسبانيا', 'هولندا', 'بلجيكا', 'السويد', 'النرويج', 'الدنمارك',
  'أستراليا', 'ماليزيا', 'إندونيسيا', 'الهند', 'باكستان', 'جنوب أفريقيا', 'نيجيريا', 'كينيا', 'غانا',
]

const REPRESENTATIVE_FILE_PRESETS = [
  { kind: 'CV', title: 'السيرة الذاتية', label: 'رفع السيرة الذاتية', hint: 'CV أو ملف تعريفي بأي صيغة' },
  { kind: 'BOOK', title: 'كتاب من تأليف الممثل', label: 'رفع كتاب من تأليفه', hint: 'PDF أو Word أو أي صيغة كتاب/مخطوط' },
  { kind: 'WORK', title: 'الأعمال والمشاريع', label: 'رفع الأعمال والمشاريع', hint: 'ملفات أعمال أو نماذج مشاريع' },
  { kind: 'ACHIEVEMENT', title: 'الإنجازات', label: 'رفع الإنجازات', hint: 'ملفات إنجازات أو مشاركات أو توثيق' },
  { kind: 'CERTIFICATE', title: 'شهادة أو اعتماد', label: 'رفع شهادة/اعتماد', hint: 'شهادات، اعتمادات، خطابات رسمية' },
  { kind: 'OTHER', title: 'ملف إضافي', label: 'رفع ملف آخر', hint: 'أي ملف داعم آخر' },
]

const EMPTY_FORM = {
  id: '',
  slug: '',
  status: 'ACTIVE',
  cardNumber: '',
  validFrom: '',
  validUntil: '',
  fullName: '',
  displayTitle: '',
  degreeTitle: '',
  academicRank: '',
  country: '',
  region: '',
  territory: '',
  city: '',
  specialization: '',
  representativeRole: 'COUNTRY_REPRESENTATIVE',
  shortBio: '',
  rawBio: '',
  professionalBio: '',
  worksSummary: '',
  achievements: '',
  publicContactNote: '',
  phone: '',
  email: '',
  whatsapp: '',
  website: '',
  featured: false,
  sortOrder: 0,
}

type FormState = typeof EMPTY_FORM

type Representative = FormState & {
  profilePhotoUrl?: string | null
  officialCardUrl?: string | null
  qrToken?: string | null
  verifyUrl?: string | null
  qrDataUrl?: string | null
  aiRewriteStatus?: string | null
  aiRewriteNote?: string | null
  onboardingStatus?: string | null
  onboardingSubmittedAt?: string | null
  sourceAgentApplicationId?: string | null
  files?: Array<{ id: string; kind: string; title: string; description?: string | null; externalUrl?: string | null; fileUrl?: string | null; reviewStatus?: string | null; reviewNote?: string | null }>
}

function toDateInput(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}

function formFromRepresentative(rep: Representative): FormState {
  return { ...EMPTY_FORM, ...rep, validFrom: toDateInput(rep.validFrom as any), validUntil: toDateInput(rep.validUntil as any), featured: !!rep.featured, sortOrder: Number(rep.sortOrder || 0) }
}

function shouldAutoRewriteAfterUpload(assetType: string, extras?: Record<string, string>) {
  if (assetType !== 'file') return false
  return ['CV', 'WORK', 'ACHIEVEMENT', 'BOOK'].includes(String(extras?.kind || '').toUpperCase())
}

function representativeAssetPreviewUrl(rep: Representative | null | undefined, asset: 'profilePhoto' | 'officialCard') {
  if (!rep?.id) return ''
  if (asset === 'profilePhoto' && !rep.profilePhotoUrl) return ''
  if (asset === 'officialCard' && !rep.officialCardUrl) return ''
  return `/api/admin/representatives/${encodeURIComponent(rep.id)}/asset-preview/${asset}`
}

export default function AdminRepresentativesTab() {
  const { confirmAction, promptAction, dialog: actionDialog } = useAdminActionDialog()
  const [rows, setRows] = useState<Representative[]>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [rewriting, setRewriting] = useState(false)
  const [onboardingBusy, setOnboardingBusy] = useState(false)
  const [onboardingLink, setOnboardingLink] = useState('')
  const [onboardingResult, setOnboardingResult] = useState<{ emailStatus?: string; expiresAt?: string | null }>({})
  const [query, setQuery] = useState('')
  const selected = useMemo(() => rows.find((row) => row.id === selectedId) || null, [rows, selectedId])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) => [row.fullName, row.country, row.region, row.specialization, row.displayTitle].join(' ').toLowerCase().includes(q))
  }, [rows, query])

  async function load(focusId = selectedId) {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/representatives', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'تعذر تحميل ممثلي الأكاديمية')
      const nextRows: Representative[] = data.representatives || []
      setRows(nextRows)
      const active = nextRows.find((row) => row.id === focusId) || (!focusId ? nextRows[0] : null)
      if (active) {
        setSelectedId(active.id)
        if (active.id !== focusId) setOnboardingLink('')
        setForm(formFromRepresentative(active))
      } else if (!nextRows.length) {
        setSelectedId('')
        setOnboardingLink('')
        setForm(EMPTY_FORM)
      }
      return nextRows
    } catch (e: any) {
      toast({ title: 'تعذر التحميل', description: String(e?.message || e), variant: 'destructive' })
      return []
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function newRepresentative() {
    setSelectedId('')
    setOnboardingLink('')
    setOnboardingResult({})
    setForm(EMPTY_FORM)
  }

  function choose(rep: Representative) {
    setSelectedId(rep.id)
    setOnboardingLink('')
    setOnboardingResult({})
    setForm(formFromRepresentative(rep))
  }

  async function save() {
    setSaving(true)
    try {
      const method = form.id ? 'PATCH' : 'POST'
      const url = form.id ? `/api/admin/representatives/${form.id}` : '/api/admin/representatives'
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'تعذر حفظ الممثل')
      const rep = data.representative
      setRows((prev) => form.id ? prev.map((row) => row.id === rep.id ? rep : row) : [rep, ...prev])
      setSelectedId(rep.id)
      setForm(formFromRepresentative(rep))
      toast({ title: 'تم الحفظ', description: 'تم حفظ بيانات ممثل الأكاديمية.' })
    } catch (e: any) {
      toast({ title: 'فشل الحفظ', description: String(e?.message || e), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!form.id) return
    if (!(await confirmAction({ title: 'حذف ممثل الأكاديمية', description: 'هل تريد حذف هذا الممثل من العرض العام؟', confirmLabel: 'حذف الممثل', tone: 'danger' }))) return
    setSaving(true)
    try {
      const res = await fetch(`/api/admin/representatives/${form.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'تعذر حذف الممثل')
      setRows((prev) => prev.filter((row) => row.id !== form.id))
      newRepresentative()
      toast({ title: 'تم الحذف', description: 'تم حذف/أرشفة الممثل من العرض العام.' })
    } catch (e: any) {
      toast({ title: 'فشل الحذف', description: String(e?.message || e), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  async function upload(assetType: 'profilePhoto' | 'officialCard' | 'file', file?: File | null, extras?: Record<string, string>) {
    if (!form.id) return toast({ title: 'احفظ الممثل أولاً', description: 'بعد الحفظ يمكنك رفع الملفات والصور.' })
    if (!file && !extras?.externalUrl) return toast({ title: 'لا يوجد ملف', description: 'اختر ملفاً أو ضع رابطاً خارجياً.' })
    const body = new FormData()
    body.set('assetType', assetType)
    for (const [key, value] of Object.entries(extras || {})) body.set(key, value)
    if (file) body.set('file', file)
    setUploading(true)
    try {
      const res = await fetch(`/api/admin/representatives/${form.id}/assets`, { method: 'POST', body })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'تعذر رفع الملف')
      let nextRepresentative = data.representative as Representative | undefined
      let rewriteApplied = false
      if (nextRepresentative) {
        setRows((prev) => prev.map((row) => row.id === nextRepresentative!.id ? nextRepresentative! : row))
        setSelectedId(nextRepresentative.id)
        setForm(formFromRepresentative(nextRepresentative))
      }
      if (shouldAutoRewriteAfterUpload(assetType, extras)) {
        const rewriteRes = await fetch(`/api/admin/representatives/${form.id}/rewrite`, { method: 'POST' })
        const rewriteData = await rewriteRes.json().catch(() => ({}))
        if (rewriteRes.ok && rewriteData.representative) {
          const rewritten = rewriteData.representative as Representative
          nextRepresentative = rewritten
          setRows((prev) => prev.map((row) => row.id === rewritten.id ? rewritten : row))
          setSelectedId(rewritten.id)
          setForm(formFromRepresentative(rewritten))
          rewriteApplied = true
        } else {
          toast({ title: 'تم الرفع ولم تكتمل الصياغة', description: rewriteData.message || 'حُفظ الملف، لكن لم يستطع الذكاء تفريغ محتواه الآن. يمكنك الضغط على إعادة صياغة بالذكاء لاحقاً.', variant: 'destructive' })
        }
      }
      await load(nextRepresentative?.id || form.id)
      toast({ title: 'تم الرفع', description: assetType === 'profilePhoto' ? 'تم تحديث صورة الممثل.' : assetType === 'officialCard' ? 'تم تحديث الكرنيه الرسمي.' : rewriteApplied ? 'تم إضافة الملف وتفريغ تحليله في خانات السيرة.' : 'تم إضافة الملف/الرابط.' })
    } catch (e: any) {
      toast({ title: 'فشل الرفع', description: String(e?.message || e), variant: 'destructive' })
    } finally {
      setUploading(false)
    }
  }

  async function deleteFile(fileId: string) {
    if (!form.id) return
    if (!(await confirmAction({ title: 'حذف ملف الممثل', description: 'سيتم حذف السجل من لوحة المراجعة ولا يظهر للممثل أو للعامة.', confirmLabel: 'حذف الملف', tone: 'danger' }))) return
    setUploading(true)
    try {
      const res = await fetch(`/api/admin/representatives/${form.id}/files/${fileId}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'تعذر حذف الملف')
      await load()
      toast({ title: 'تم حذف الملف' })
    } catch (e: any) {
      toast({ title: 'فشل حذف الملف', description: String(e?.message || e), variant: 'destructive' })
    } finally {
      setUploading(false)
    }
  }

  async function createOnboardingLink() {
    if (!form.id) return
    setOnboardingBusy(true)
    try {
      const res = await fetch(`/api/admin/representatives/${form.id}/onboarding`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || data.error || 'تعذر إنشاء رابط الاستكمال')
      setOnboardingLink(data.url || '')
      setOnboardingResult({ emailStatus: data.emailStatus, expiresAt: data.expiresAt })
      await load(form.id)
      const mailNote = data.emailStatus === 'SENT'
        ? 'تم إرسال الرابط على بريد الممثل ✅'
        : data.emailStatus === 'FAILED'
          ? 'فشل إرسال البريد، انسخ الرابط وأرسله يدوياً'
          : 'لا يوجد بريد صالح، انسخ الرابط وأرسله يدوياً'
      toast({ title: 'تم تجهيز رابط الاستكمال', description: mailNote })
    } catch (e: any) {
      toast({ title: 'تعذر إنشاء رابط الاستكمال', description: String(e?.message || e), variant: 'destructive' })
    } finally {
      setOnboardingBusy(false)
    }
  }

  async function revokeOnboardingLink() {
    if (!form.id) return
    if (!confirm('هل تريد إلغاء رابط الاستكمال الحالي؟')) return
    setOnboardingBusy(true)
    try {
      const res = await fetch(`/api/admin/representatives/${form.id}/onboarding`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'تعذر إلغاء رابط الاستكمال')
      setOnboardingLink('')
      setOnboardingResult({})
      await load(form.id)
      toast({ title: 'تم إلغاء رابط الاستكمال' })
    } catch (e: any) {
      toast({ title: 'تعذر إلغاء الرابط', description: String(e?.message || e), variant: 'destructive' })
    } finally {
      setOnboardingBusy(false)
    }
  }

  async function copyOnboardingLink() {
    if (!onboardingLink) return
    await navigator.clipboard?.writeText(onboardingLink).catch(() => {})
    toast({ title: 'تم نسخ رابط الاستكمال' })
  }

  async function reviewFile(fileId: string, action: 'APPROVE' | 'REJECT') {
    if (!form.id) return
    let note = ''
    if (action === 'REJECT') {
      if (!(await confirmAction({ title: 'رفض ملف الممثل', description: 'سيبقى الملف محفوظاً في السجل لكنه لن يعتمد للعرض العام.', confirmLabel: 'متابعة الرفض', tone: 'warning' }))) return
      note = (await promptAction({ title: 'سبب رفض ملف الممثل', description: 'اكتب سبب رفض هذا التعديل/الملف ليظهر في سجل المراجعة.', fieldLabel: 'سبب الرفض', defaultValue: '', multiline: true, confirmLabel: 'اعتماد السبب', tone: 'info' })) || ''
      if (!note.trim() && !(await confirmAction({ title: 'رفض بدون سبب', description: 'لم تكتب سبباً للرفض. هل تريد الرفض بدون سبب؟', confirmLabel: 'رفض بدون سبب', tone: 'warning' }))) return
    }
    setUploading(true)
    try {
      const res = await fetch(`/api/admin/representatives/${form.id}/files/${fileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'تعذر تحديث مراجعة الملف')
      await load(form.id)
      toast({ title: action === 'APPROVE' ? 'تم اعتماد الملف' : 'تم رفض الملف' })
    } catch (e: any) {
      toast({ title: 'فشل مراجعة الملف', description: String(e?.message || e), variant: 'destructive' })
    } finally {
      setUploading(false)
    }
  }

  async function rewrite() {
    if (!form.id) return toast({ title: 'احفظ الممثل أولاً' })
    setRewriting(true)
    try {
      const res = await fetch(`/api/admin/representatives/${form.id}/rewrite`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || 'تعذر إعادة الصياغة')
      if (data.representative) {
        const rep = data.representative as Representative
        setRows((prev) => prev.map((row) => row.id === rep.id ? rep : row))
        setSelectedId(rep.id)
        setForm(formFromRepresentative(rep))
      }
      await load(data.representative?.id || form.id)
      toast({ title: 'تمت إعادة الصياغة', description: 'تم تفريغ التحليل في خانات السيرة والأعمال والإنجازات. راجع النص قبل اعتماد العرض النهائي.' })
    } catch (e: any) {
      toast({ title: 'فشل الذكاء', description: String(e?.message || e), variant: 'destructive' })
    } finally {
      setRewriting(false)
    }
  }

  if (loading) {
    return <Card className="mt-4"><CardContent className="flex h-52 items-center justify-center gap-3"><Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" /><span className="text-sm font-black">جاري تحميل ممثلي الأكاديمية...</span></CardContent></Card>
  }

  return (
    <div className="mt-4 grid min-w-0 gap-5 overflow-hidden lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]" dir="rtl">
      <Card className="min-w-0 overflow-hidden border-[#0f2b46]/10">
        <CardHeader className="space-y-3">
          <CardTitle className="flex items-center justify-between text-lg font-black text-[#0f2b46]">
            ممثلو الأكاديمية
            <Button size="sm" onClick={newRepresentative} className="gap-1 bg-[#0f2b46] text-white"><Plus className="h-4 w-4" /> جديد</Button>
          </CardTitle>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ابحث بالاسم أو الدولة أو التخصص..." className="rounded-2xl" />
        </CardHeader>
        <CardContent className="max-h-[720px] space-y-3 overflow-y-auto">
          {filtered.map((rep) => (
            <button key={rep.id} onClick={() => choose(rep)} className={`w-full rounded-2xl border p-3 text-right transition ${selectedId === rep.id ? 'border-[#c9a227] bg-amber-50' : 'border-slate-100 bg-white hover:bg-slate-50'}`}>
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 overflow-hidden rounded-2xl bg-[#0f2b46] text-center text-sm font-black leading-[3rem] text-white">
                  {rep.profilePhotoUrl ? <img src={representativeAssetPreviewUrl(rep, 'profilePhoto')} alt="" className="h-full w-full object-cover" /> : rep.fullName.slice(0, 2)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-black text-[#0f2b46]">{rep.fullName}</p>
                  <p className="truncate text-xs font-bold text-slate-500">{rep.country} — {rep.region}</p>
                  <div className="mt-1 flex flex-wrap gap-1"><Badge variant="outline" className="text-[10px]">{rep.status}</Badge>{rep.onboardingStatus && <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-800">{rep.onboardingStatus}</Badge>}{rep.featured && <Badge className="bg-[#c9a227] text-[#0f2b46] hover:bg-[#c9a227]">مميز</Badge>}</div>
                </div>
              </div>
            </button>
          ))}
          {!filtered.length && <p className="rounded-2xl bg-slate-50 p-4 text-center text-xs font-bold text-slate-500">لا توجد نتائج مطابقة.</p>}
        </CardContent>
      </Card>

      <div className="min-w-0 space-y-5 overflow-hidden">
        <Card className="min-w-0 overflow-hidden border-[#0f2b46]/10">
          <CardHeader>
            <CardTitle className="text-xl font-black text-[#0f2b46]">{form.id ? 'تعديل ممثل الأكاديمية' : 'إضافة ممثل جديد'}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {selected?.onboardingStatus && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold leading-6 text-amber-900">
                حالة استكمال ملف الممثل: <span className="font-black">{selected.onboardingStatus}</span>
                {selected.onboardingSubmittedAt ? ` — أُرسل للمراجعة: ${new Date(selected.onboardingSubmittedAt).toLocaleString('ar')}` : ''}
                {selected.sourceAgentApplicationId ? ' — مرتبط بطلب وكالة/اعتماد.' : ''}
              </div>
            )}
            <div className="grid gap-4 md:grid-cols-3">
              <div><Label>الاسم الكامل</Label><Input value={form.fullName} onChange={(e) => update('fullName', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <CountryCombobox value={form.country} onChange={(value) => update('country', value)} />
              <div><Label>المنطقة الجغرافية</Label><Input value={form.region} onChange={(e) => update('region', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <div><Label>الصفة المعروضة</Label><Input value={form.displayTitle} onChange={(e) => update('displayTitle', e.target.value)} placeholder="ممثل الأكاديمية في..." className="mt-2 rounded-2xl" /></div>
              <div><Label>رقم البطاقة</Label><Input value={form.cardNumber} onChange={(e) => update('cardNumber', e.target.value)} placeholder="REP-2026-0001" className="mt-2 rounded-2xl" /></div>
              <div><Label>بداية الصلاحية</Label><Input type="date" value={form.validFrom} onChange={(e) => update('validFrom', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <div><Label>نهاية الصلاحية</Label><Input type="date" value={form.validUntil} onChange={(e) => update('validUntil', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <div><Label>الدرجة العلمية</Label><Input value={form.degreeTitle} onChange={(e) => update('degreeTitle', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <div><Label>الرتبة العلمية</Label><Input value={form.academicRank} onChange={(e) => update('academicRank', e.target.value)} placeholder="بروفيسور / دكتور..." className="mt-2 rounded-2xl" /></div>
              <div><Label>المدينة</Label><Input value={form.city} onChange={(e) => update('city', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <div><Label>نطاق التمثيل</Label><Input value={form.territory} onChange={(e) => update('territory', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <div><Label>التخصص</Label><Input value={form.specialization} onChange={(e) => update('specialization', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <div><Label>الجوال</Label><Input value={form.phone} onChange={(e) => update('phone', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <div><Label>الإيميل</Label><Input value={form.email} onChange={(e) => update('email', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <div><Label>واتساب</Label><Input value={form.whatsapp} onChange={(e) => update('whatsapp', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <div><Label>الموقع / رابط خارجي</Label><Input value={form.website} onChange={(e) => update('website', e.target.value)} className="mt-2 rounded-2xl" /></div>
              <div><Label>الحالة</Label><Select value={form.status} onValueChange={(v) => update('status', v)}><SelectTrigger className="mt-2 rounded-2xl"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ACTIVE">نشط</SelectItem><SelectItem value="DRAFT">مسودة</SelectItem><SelectItem value="HIDDEN">مخفي</SelectItem><SelectItem value="ARCHIVED">مؤرشف</SelectItem></SelectContent></Select></div>
              <div><Label>الترتيب</Label><Input type="number" value={form.sortOrder} onChange={(e) => update('sortOrder', Number(e.target.value) as any)} className="mt-2 rounded-2xl" /></div>
            </div>
            <label className="flex items-center gap-2 rounded-2xl bg-slate-50 p-3 text-sm font-bold"><input type="checkbox" checked={form.featured} onChange={(e) => update('featured', e.target.checked as any)} /> إظهار كممثل مميز</label>
            <div className="grid gap-4 md:grid-cols-2">
              <div><Label>ملخص قصير</Label><Textarea value={form.shortBio} onChange={(e) => update('shortBio', e.target.value)} className="mt-2 min-h-28 rounded-2xl" /></div>
              <div><Label>ملاحظة تواصل عامة</Label><Textarea value={form.publicContactNote} onChange={(e) => update('publicContactNote', e.target.value)} className="mt-2 min-h-28 rounded-2xl" /></div>
              <div><Label>السيرة الخام</Label><Textarea value={form.rawBio} onChange={(e) => update('rawBio', e.target.value)} className="mt-2 min-h-36 rounded-2xl" /></div>
              <div><Label>السيرة الاحترافية المعروضة</Label><Textarea value={form.professionalBio} onChange={(e) => update('professionalBio', e.target.value)} className="mt-2 min-h-36 rounded-2xl" /></div>
              <div><Label>الأعمال</Label><Textarea value={form.worksSummary} onChange={(e) => update('worksSummary', e.target.value)} className="mt-2 min-h-32 rounded-2xl" /></div>
              <div><Label>الإنجازات</Label><Textarea value={form.achievements} onChange={(e) => update('achievements', e.target.value)} className="mt-2 min-h-32 rounded-2xl" /></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={save} disabled={saving} className="gap-2 bg-[#0f2b46] text-white"><Save className="h-4 w-4" /> {saving ? 'جاري الحفظ...' : 'حفظ'}</Button>
              <Button onClick={rewrite} disabled={!form.id || rewriting} variant="outline" className="gap-2 border-[#c9a227] text-[#8b6b12]"><Sparkles className="h-4 w-4" /> {rewriting ? 'يصيغ...' : 'إعادة صياغة بالذكاء'}</Button>
              {form.id && <Button onClick={remove} disabled={saving} variant="outline" className="gap-2 border-red-200 text-red-700"><Trash2 className="h-4 w-4" /> حذف</Button>}
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden border-[#0f2b46]/10">
            <CardHeader><CardTitle className="text-xl font-black text-[#0f2b46]">الصور والكرنيه والملفات</CardTitle></CardHeader>
            <CardContent className="space-y-5">
              {!form.id && (
                <div className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs font-bold leading-6 text-amber-900 sm:flex-row sm:items-center sm:justify-between">
                  <span>احفظ بيانات الممثل أولاً ليتم إنشاء ملفه، ثم ستتفعّل أزرار رفع الصورة والكُرنيه والسيرة والكتب والأعمال والملفات.</span>
                  <Button type="button" onClick={save} disabled={saving || !form.fullName.trim()} size="sm" className="shrink-0 bg-[#0f2b46] text-white hover:bg-[#12365c]">
                    <Save className="ml-1 h-4 w-4" /> {saving ? 'جاري الحفظ...' : 'حفظ الممثل وتفعيل الرفع'}
                  </Button>
                </div>
              )}
              <div className="min-w-0 break-words rounded-2xl border border-blue-100 bg-blue-50/70 p-4 text-xs font-bold leading-6 text-[#0f2b46]">
                يمكنك رفع ملفات الممثل بكل الصيغ الشائعة: PDF، Word، Excel، PowerPoint، صور، نصوص، ملفات مضغوطة، أو أي ملف داعم. المنصة ستحاول استخراج النص تلقائياً من الصيغ المقروءة ليستفيد منها الذكاء في صياغة السيرة.
              </div>
              <div className="rounded-2xl border border-indigo-100 bg-indigo-50/70 p-4 text-xs font-bold leading-6 text-indigo-950">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-sm font-black">رابط استكمال ملف الممثل</p>
                    <p className="mt-1 text-indigo-800">أرسل هذا الرابط للممثل ليكمل بياناته ويرفع ملفاته بنفسه. الملفات المرفوعة عبر الرابط تبقى بانتظار مراجعتك قبل الظهور للعامة.</p>
                    {selected?.onboardingStatus && <p className="mt-1 text-[11px] text-indigo-700">الحالة الحالية: {['SUBMITTED', 'SUBMITTED_REVIEW'].includes(selected.onboardingStatus) ? 'أرسل الملف للمراجعة' : selected.onboardingStatus === 'INVITED' ? 'تم إنشاء الرابط' : selected.onboardingStatus === 'WAITING_PROFILE' ? 'بدأ استكمال الملف' : selected.onboardingStatus === 'NOT_SENT' ? 'لم يُنشأ رابط' : selected.onboardingStatus}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" disabled={!form.id || onboardingBusy} onClick={createOnboardingLink} className="bg-indigo-700 text-white hover:bg-indigo-800">{onboardingBusy ? 'جاري التجهيز...' : onboardingLink ? 'إعادة عرض الرابط' : 'إنشاء رابط الاستكمال'}</Button>
                    {onboardingLink && <Button type="button" variant="outline" onClick={copyOnboardingLink} className="border-indigo-200 bg-white text-indigo-700">نسخ الرابط</Button>}
                    {onboardingLink && <a href={onboardingLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-xl border border-indigo-200 bg-white px-3 py-2 text-xs font-black text-indigo-700">فتح الرابط</a>}
                    {form.id && <Button type="button" variant="outline" disabled={onboardingBusy} onClick={revokeOnboardingLink} className="border-red-200 bg-white text-red-700">إلغاء الرابط</Button>}
                  </div>
                </div>
                {onboardingLink && <div className="mt-3 space-y-2 rounded-xl bg-white p-3 text-[11px] font-bold text-indigo-800">
                  <p className="break-all">{onboardingLink}</p>
                  <p>{onboardingResult.emailStatus === 'SENT' ? 'تم إرسال الرابط على بريد الممثل ✅' : onboardingResult.emailStatus === 'FAILED' ? 'فشل إرسال البريد، انسخ الرابط وأرسله يدوياً' : 'لم يتم إرسال بريد؛ انسخ الرابط وأرسله يدوياً'}</p>
                  {onboardingResult.expiresAt && <p>ينتهي الرابط في: {new Date(onboardingResult.expiresAt).toLocaleString('ar')}</p>}
                </div>}
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <AssetUploader label="الصورة الشخصية" hint="صورة واضحة للممثل" icon={<ImageIcon className="h-4 w-4" />} accept="image/*" onUpload={(file) => upload('profilePhoto', file)} uploading={uploading || !form.id} />
                <AssetUploader label="الكرنيه الرسمي" hint="صورة أو PDF للكرنيه" icon={<QrCode className="h-4 w-4" />} accept="image/*,.pdf" onUpload={(file) => upload('officialCard', file)} uploading={uploading || !form.id} />
                {REPRESENTATIVE_FILE_PRESETS.map((preset) => (
                  <PresetFileUploader key={preset.kind} preset={preset} onUpload={(file, extras) => upload('file', file, extras)} uploading={uploading || !form.id} />
                ))}
              </div>
              <GeneralFileUploader onUpload={(file, extras) => upload('file', file, extras)} uploading={uploading || !form.id} />
              <ExternalLinkUploader onUpload={(extras) => upload('file', null, extras)} uploading={uploading || !form.id} />
              <div className="grid gap-4 md:grid-cols-2">
                <PreviewBox title="الصورة الحالية" url={representativeAssetPreviewUrl(selected, 'profilePhoto')} originalUrl={selected?.profilePhotoUrl} />
                <PreviewBox title="الكرنيه الحالي" url={representativeAssetPreviewUrl(selected, 'officialCard')} originalUrl={selected?.officialCardUrl} />
              </div>
              <div className="rounded-2xl border border-[#c9a227]/20 bg-amber-50 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  {selected?.qrDataUrl && <img src={selected.qrDataUrl} alt="QR" className="h-64 w-64 min-h-[256px] min-w-[256px] rounded-xl bg-white p-4 [image-rendering:pixelated]" />}
                  <div>
                    <p className="text-sm font-black text-[#0f2b46]">رابط التحقق الآمن</p>
                    {selected?.verifyUrl ? <a href={selected.verifyUrl} target="_blank" rel="noopener noreferrer" className="mt-1 block break-all text-xs font-bold text-[#bf1646]">{selected.verifyUrl}</a> : <p className="text-xs font-bold text-slate-500">يظهر بعد الحفظ.</p>}
                    {selected?.qrToken && <a href={`/representatives/qr/${selected.qrToken}?download=1`} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block rounded-full border border-[#0f2b46]/15 bg-white px-3 py-1 text-[11px] font-black text-[#0f2b46]">فتح QR كصورة PNG كبيرة للمسح والطباعة</a>}
                    <p className="mt-2 text-xs font-bold leading-6 text-slate-500">التحقق الموسّع يحتاج آخر 4 أرقام من الجوال المسجل فقط.</p>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-black text-[#0f2b46]">الملفات والروابط</p>
                {(selected?.files || []).map((file) => {
                  const reviewStatus = file.reviewStatus || 'APPROVED'
                  return (
                    <div key={file.id} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-slate-100 bg-white p-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-black text-[#0f2b46]">{file.title}</p><span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${reviewStatus === 'APPROVED' ? 'bg-emerald-50 text-emerald-700' : reviewStatus === 'REJECTED' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>{reviewStatus === 'APPROVED' ? 'معتمد' : reviewStatus === 'REJECTED' ? 'مرفوض' : 'بانتظار المراجعة'}</span></div>
                        <p className="break-all text-xs font-bold text-slate-500">{file.kind} — {file.externalUrl || file.fileUrl || 'ملف محفوظ'}</p>
                        {file.reviewNote && <p className="text-xs font-bold text-slate-500">ملاحظة المراجعة: {file.reviewNote}</p>}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">{(file.externalUrl || file.fileUrl) && <a href={file.externalUrl || `/api/admin/representatives/${encodeURIComponent(form.id)}/files/${encodeURIComponent(file.id)}`} target="_blank" rel="noopener noreferrer" className="rounded-xl border border-slate-200 p-2 text-[#0f2b46]" title="عرض الملف للإدارة"><ExternalLink className="h-4 w-4" /></a>}{reviewStatus !== 'APPROVED' && <Button size="sm" variant="outline" onClick={() => reviewFile(file.id, 'APPROVE')} className="gap-1 border-emerald-200 text-emerald-700" title="اعتماد الملف"><CheckCircle2 className="h-4 w-4" /> اعتماد</Button>}{reviewStatus !== 'REJECTED' && <Button size="sm" variant="outline" onClick={() => reviewFile(file.id, 'REJECT')} className="gap-1 border-amber-200 text-amber-700" title="رفض الملف"><XCircle className="h-4 w-4" /> رفض</Button>}<Button size="icon" variant="outline" onClick={() => deleteFile(file.id)} className="border-red-200 text-red-700"><Trash2 className="h-4 w-4" /></Button></div>
                    </div>
                  )
                })}
                {!selected?.files?.length && <p className="rounded-2xl bg-slate-50 p-4 text-xs font-bold text-slate-500">لم تُضف ملفات بعد.</p>}
              </div>
            </CardContent>
          </Card>
      </div>
      {actionDialog}
    </div>
  )
}

function CountryCombobox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const search = value || ''
  const trimmed = search.trim()
  const matches = REPRESENTATIVE_COUNTRIES.filter((country) => country.includes(trimmed) || trimmed.includes(country)).slice(0, 8)
  return (
    <div className="relative">
      <Label>الدولة</Label>
      <Input value={search} onChange={(e) => onChange(e.target.value)} placeholder="اختر أو اكتب الدولة" className="mt-2 rounded-2xl" />
      {trimmed && matches.length > 0 && !matches.includes(search) && (
        <div className="absolute z-20 mt-1 max-h-52 w-full overflow-y-auto rounded-2xl border border-slate-100 bg-white p-1 shadow-xl">
          {matches.map((country) => (
            <button key={country} type="button" onClick={() => onChange(country)} className="block w-full rounded-xl px-3 py-2 text-right text-xs font-bold text-[#0f2b46] hover:bg-amber-50">
              {country}
            </button>
          ))}
        </div>
      )}
      <p className="mt-1 text-[10px] font-bold text-slate-400">يمكن الاختيار من القائمة أو كتابة دولة جديدة.</p>
    </div>
  )
}

function AssetUploader({ label, hint, icon, accept, onUpload, uploading }: { label: string; hint?: string; icon: ReactNode; accept?: string; onUpload: (file: File) => void; uploading: boolean }) {
  return (
    <label className="flex min-w-0 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-4 text-center text-sm font-black text-[#0f2b46] hover:border-[#c9a227]">
      <input type="file" accept={accept} className="hidden" disabled={uploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) onUpload(file); e.currentTarget.value = '' }} />
      {icon}
      <span>{label}</span>
      {hint && <span className="text-[10px] font-bold leading-5 text-slate-400">{hint}</span>}
      <span className="text-[10px] font-bold text-slate-400"><Upload className="inline h-3 w-3" /> رفع ملف</span>
    </label>
  )
}

function PresetFileUploader({ preset, onUpload, uploading }: { preset: { kind: string; title: string; label: string; hint: string }; onUpload: (file: File, extras: Record<string, string>) => void; uploading: boolean }) {
  return (
    <label className="flex min-w-0 cursor-pointer flex-col justify-between gap-3 rounded-2xl border border-dashed border-slate-200 bg-white p-4 text-right hover:border-[#c9a227] hover:bg-amber-50/40">
      <input type="file" className="hidden" disabled={uploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) onUpload(file, { kind: preset.kind, title: preset.title, description: preset.hint }); e.currentTarget.value = '' }} />
      <div>
        <div className="flex items-center gap-2 text-sm font-black text-[#0f2b46]"><FileText className="h-4 w-4 text-[#c9a227]" /> {preset.label}</div>
        <p className="mt-2 text-[11px] font-bold leading-5 text-slate-500">{preset.hint}</p>
      </div>
      <span className="inline-flex w-fit rounded-full bg-[#0f2b46] px-3 py-1 text-[10px] font-black text-white">رفع بكل الصيغ</span>
    </label>
  )
}

function GeneralFileUploader({ onUpload, uploading }: { onUpload: (file: File, extras: Record<string, string>) => void; uploading: boolean }) {
  const [kind, setKind] = useState('CV')
  const [title, setTitle] = useState('السيرة الذاتية')
  return <div className="min-w-0 rounded-2xl border border-slate-100 bg-slate-50 p-3"><div className="mb-2 text-xs font-black text-[#0f2b46]">رفع ملف مخصص</div><div className="grid min-w-0 gap-2"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="عنوان الملف" className="rounded-xl" /><Select value={kind} onValueChange={setKind}><SelectTrigger className="rounded-xl"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="CV">سيرة ذاتية</SelectItem><SelectItem value="BOOK">كتاب من تأليفه</SelectItem><SelectItem value="WORK">عمل/مشروع</SelectItem><SelectItem value="ACHIEVEMENT">إنجاز</SelectItem><SelectItem value="CERTIFICATE">شهادة</SelectItem><SelectItem value="OTHER">أخرى</SelectItem></SelectContent></Select><label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl bg-[#0f2b46] px-3 py-2 text-xs font-black text-white"><input type="file" className="hidden" disabled={uploading} onChange={(e) => { const file = e.target.files?.[0]; if (file) onUpload(file, { kind, title }); e.currentTarget.value = '' }} /><FileText className="h-4 w-4" /> رفع أي صيغة</label></div></div>
}

function ExternalLinkUploader({ onUpload, uploading }: { onUpload: (extras: Record<string, string>) => void; uploading: boolean }) {
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('رابط أعمال')
  return <div className="grid min-w-0 gap-2 rounded-2xl border border-slate-100 bg-slate-50 p-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]"><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="عنوان الرابط" className="rounded-xl" /><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://..." className="rounded-xl" /><Button disabled={uploading || !url.trim()} onClick={() => { onUpload({ kind: 'LINK', title, externalUrl: url }); setUrl('') }} variant="outline" className="gap-2"><ExternalLink className="h-4 w-4" /> إضافة رابط</Button></div>
}

function PreviewBox({ title, url, originalUrl }: { title: string; url?: string | null; originalUrl?: string | null }) {
  const [failed, setFailed] = useState(false)
  const safeUrl = String(url || '').trim()
  const linkUrl = String(originalUrl || url || '').trim()
  return (
    <div className="min-w-0 rounded-2xl border border-slate-100 bg-slate-50 p-4">
      <p className="mb-3 text-sm font-black text-[#0f2b46]">{title}</p>
      {safeUrl ? (
        <div className="space-y-2">
          {!failed && <a href={safeUrl} target="_blank" rel="noopener noreferrer"><img src={safeUrl} alt={title} onError={() => setFailed(true)} className="max-h-48 w-full rounded-xl bg-white object-contain" /></a>}
          {failed && linkUrl && <a href={linkUrl} target="_blank" rel="noopener noreferrer" className="block break-all rounded-xl border border-blue-100 bg-white p-3 text-xs font-black text-blue-700">فتح الملف المرفوع</a>}
        </div>
      ) : <p className="text-xs font-bold text-slate-400">لا يوجد ملف مرفوع.</p>}
    </div>
  )
}
