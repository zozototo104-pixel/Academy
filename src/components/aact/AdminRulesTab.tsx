'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { buildOfficialStudyAdmissionDefaults, buildServiceAdmissionDefaults, getServiceDocumentOptions, getServiceFlow } from '@/lib/service-flows'
import { toast } from '@/hooks/use-toast'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Save, RotateCcw, Sparkles, ClipboardCheck, FileText, IdCard, Camera, ScrollText, Users, GraduationCap, BookOpen, Target, ListChecks, Search } from 'lucide-react'

// ===== تبويب قواعد القبول المخصصة لكل برنامج =====
// الإدارة تضبط لكل برنامج: الحد الأدنى للمؤهل، إلزام الماجستير للدكتوراة، معادلة الخبرات،
// الوثائق الإلزامية، الحد الأدنى للعمر، وقواعد نصية حرة — يطبقها خبير القبول الذكي على كل طلب.

interface AcademicPlanStage {
  title: string
  description: string
  deliverable: string
}

interface AcademicEvaluationItemDraft {
  label: string
  weight: number
  description: string
}

interface AcademicTermPlanDraft {
  id?: string
  order?: number
  title: string
  phase?: 'TERM' | 'THESIS' | 'PROJECT' | 'ACCREDITATION'
  weight?: number
  description: string
  learningOutcomes?: string[]
  requiredSkills?: string[]
  assignments?: string[]
  finalEvaluation?: string
  statusHint?: string
}

interface AcademicProfileDraft {
  degreeLabel?: string
  specialization?: string
  academicTitle?: string
  levelDescription?: string
  creditHoursLabel?: string
  durationLabel?: string
  learningOutcomes?: string[]
  skills?: string[]
  studyPlan?: AcademicPlanStage[]
  termPlans?: AcademicTermPlanDraft[]
  finalEvaluationFormula?: AcademicEvaluationItemDraft[]
  graduationRequirements?: string[]
  assessmentComponents?: string[]
  thesisRequirement?: string
  qualityControls?: string[]
  hiddenSections?: string[]
}

interface Rules {
  minEducation?: string
  requireMasterForDoctorate?: boolean
  allowExperienceEquivalency?: boolean
  minYearsExperience?: number
  requiredDocuments?: string[]
  minAge?: number
  customRules?: string
  displayNote?: string
  academicProfile?: AcademicProfileDraft | null
}

interface ProgramDraft {
  titleAr: string
  titleEn?: string | null
  description?: string | null
  category: string
  icon: string
  features: string[]
  active: boolean
  sortOrder: number
  price?: number | null
  hours?: number | null
  credentialType?: string | null
  trademarkNotice?: string | null
  disclosureConsentText?: string | null
}

interface ProgramRules {
  id: string
  slug: string
  titleAr: string
  titleEn?: string | null
  description?: string | null
  category: string
  hours?: number | null
  price?: number | null
  icon?: string | null
  features?: string[]
  active?: boolean
  sortOrder?: number
  credentialType?: string | null
  trademarkNotice?: string | null
  disclosureConsentText?: string | null
  program?: ProgramDraft
  _count?: { units: number }
  rules: Rules
  custom: boolean
}

const EDU_AR: Record<string, string> = {
  NONE: 'بلا شرط مؤهل',
  HIGH_SCHOOL: 'الثانوية العامة',
  BACHELOR: 'البكالوريوس',
  MASTER: 'الماجستير',
}

const DOC_OPTIONS = [
  { value: 'DEGREE', label: 'الشهادة وكشف العلامات', icon: GraduationCap },
  { value: 'ID', label: 'الهوية / الجواز', icon: IdCard },
  { value: 'PHOTO', label: 'الصورة الشخصية', icon: Camera },
  { value: 'CV', label: 'السيرة الذاتية', icon: ScrollText },
  { value: 'EXPERIENCE', label: 'إثبات خبرات عملية', icon: Users },
  { value: 'TRANSCRIPT', label: 'كشف درجات منفصل', icon: FileText },
]

const CAT_AR: Record<string, string> = {
  DOCTORATE: 'دكتوراة',
  MASTERS: 'ماجستير',
  DIPLOMA: 'دبلوم',
  INTL_CERT: 'شهادة دولية',
  ACCREDITATION: 'اعتماد',
  SERVICE: 'خدمة عابرة',
}

const CATEGORY_OPTIONS = Object.entries(CAT_AR).map(([value, label]) => ({ value, label }))
const CREDENTIAL_OPTIONS = [
  { value: 'PROFESSIONAL_MASTER', label: 'ماجستير مهني' },
  { value: 'PROFESSIONAL_DOCTORATE', label: 'دكتوراه مهنية' },
  { value: 'DIPLOMA', label: 'دبلوم مهني' },
  { value: 'PROFESSIONAL_CERTIFICATE', label: 'شهادة مهنية' },
  { value: 'SERVICE', label: 'خدمة مهنية' },
]

const ACADEMIC_SECTION_CONFIG = [
  { key: 'overview', label: 'بيانات الملف الأساسية', fields: ['degreeLabel', 'specialization', 'academicTitle', 'levelDescription'] },
  { key: 'duration', label: 'المدة والساعات', fields: ['durationLabel', 'creditHoursLabel'] },
  { key: 'learningOutcomes', label: 'مخرجات التعلم', fields: ['learningOutcomes'] },
  { key: 'skills', label: 'المهارات المهنية', fields: ['skills'] },
  { key: 'studyPlan', label: 'الخطة الدراسية', fields: ['studyPlan'] },
  { key: 'termPlans', label: 'خطط الفصول', fields: ['termPlans'] },
  { key: 'finalEvaluationFormula', label: 'معادلة التقييم النهائي', fields: ['finalEvaluationFormula'] },
  { key: 'graduationRequirements', label: 'متطلبات التخرج', fields: ['graduationRequirements'] },
  { key: 'assessmentComponents', label: 'مكونات التقييم', fields: ['assessmentComponents'] },
  { key: 'thesisRequirement', label: 'الرسالة أو المشروع النهائي', fields: ['thesisRequirement'] },
  { key: 'qualityControls', label: 'ضوابط الجودة', fields: ['qualityControls'] },
] as const

function programDraftFromProgram(p: ProgramRules): ProgramDraft {
  return {
    titleAr: p.program?.titleAr || p.titleAr || '',
    titleEn: p.program?.titleEn ?? p.titleEn ?? '',
    description: p.program?.description ?? p.description ?? '',
    category: p.program?.category || p.category || 'DIPLOMA',
    icon: p.program?.icon || p.icon || 'graduation-cap',
    features: p.program?.features || p.features || [],
    active: p.program?.active ?? p.active ?? true,
    sortOrder: p.program?.sortOrder ?? p.sortOrder ?? 0,
    price: p.program?.price ?? p.price ?? null,
    hours: p.program?.hours ?? p.hours ?? null,
    credentialType: p.program?.credentialType ?? p.credentialType ?? null,
    trademarkNotice: p.program?.trademarkNotice ?? p.trademarkNotice ?? '',
    disclosureConsentText: p.program?.disclosureConsentText ?? p.disclosureConsentText ?? '',
  }
}

function listToText(list?: string[]) {
  return (list || []).join('\n')
}

function textToList(text: string) {
  // مهم للموبايل: لا ننظف الأسطر أثناء الكتابة حتى لا يقفز مؤشر الكتابة لآخر النص،
  // وحتى يستطيع المستخدم ضغط Enter لإضافة بند جديد فارغ ثم تعبئته.
  return text.replace(/\r/g, '').split('\n')
}

function cleanTextList(list?: string[]) {
  return (list || []).map((x) => String(x || '').trim()).filter(Boolean)
}

function normalizeAcademicProfile(profile?: AcademicProfileDraft | null): AcademicProfileDraft | null | undefined {
  if (!profile) return profile
  return {
    ...profile,
    learningOutcomes: cleanTextList(profile.learningOutcomes),
    skills: cleanTextList(profile.skills),
    graduationRequirements: cleanTextList(profile.graduationRequirements),
    assessmentComponents: cleanTextList(profile.assessmentComponents),
    qualityControls: cleanTextList(profile.qualityControls),
    studyPlan: (profile.studyPlan || [])
      .map((s) => ({ title: String(s.title || '').trim(), description: String(s.description || '').trim(), deliverable: String(s.deliverable || '').trim() }))
      .filter((s) => s.title || s.description || s.deliverable),
    termPlans: (profile.termPlans || [])
      .map((t, index) => ({
        id: String(t.id || `term-${index + 1}`).trim(),
        order: Number(t.order || index + 1),
        title: String(t.title || '').trim(),
        phase: t.phase || 'TERM',
        weight: Number(t.weight || 0),
        description: String(t.description || '').trim(),
        learningOutcomes: cleanTextList(t.learningOutcomes),
        requiredSkills: cleanTextList(t.requiredSkills),
        assignments: cleanTextList(t.assignments),
        finalEvaluation: String(t.finalEvaluation || '').trim(),
        statusHint: String(t.statusHint || '').trim(),
      }))
      .filter((t) => t.title || t.description),
    finalEvaluationFormula: (profile.finalEvaluationFormula || [])
      .map((item) => ({
        label: String(item.label || '').trim(),
        weight: Number(item.weight || 0),
        description: String(item.description || '').trim(),
      }))
      .filter((item) => item.label && item.weight > 0),
    hiddenSections: cleanTextList(profile.hiddenSections),
  }
}

function normalizeRulesForSave(rules: Rules): Rules {
  return {
    ...rules,
    customRules: rules.customRules?.trim() || undefined,
    displayNote: rules.displayNote?.trim() || undefined,
    academicProfile: normalizeAcademicProfile(rules.academicProfile),
  }
}

function stageAt(profile: AcademicProfileDraft | null | undefined, index: number): AcademicPlanStage {
  return profile?.studyPlan?.[index] || { title: '', description: '', deliverable: '' }
}

export function AdminRulesTab() {
  const [programs, setPrograms] = useState<ProgramRules[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [programSearch, setProgramSearch] = useState('')
  const [programCategoryFilter, setProgramCategoryFilter] = useState('ALL')
  const [draft, setDraft] = useState<Rules>({})
  const [programDraft, setProgramDraft] = useState<ProgramDraft | null>(null)
  const [custom, setCustom] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [bulkApplyOpen, setBulkApplyOpen] = useState(false)
  const [bulkApplying, setBulkApplying] = useState(false)

  const selectProgram = useCallback((p: ProgramRules) => {
    setSelectedId(p.id)
    setDraft({ ...p.rules })
    setProgramDraft(programDraftFromProgram(p))
    setCustom(p.custom)
    setBulkApplyOpen(false)
  }, [])

  useEffect(() => {
    api<{ programs: ProgramRules[] }>('/api/admin/program-rules')
      .then((d) => {
        setPrograms(d.programs)
        if (d.programs.length) selectProgram(d.programs[0])
      })
      .catch(() => toast({ title: 'تعذر تحميل البرامج', variant: 'destructive' }))
      .finally(() => setLoading(false))
  }, [selectProgram])

  const selected = programs.find((p) => p.id === selectedId)
  const categoryProgramsForBulkApply = programDraft
    ? programs.filter((p) => p.category === programDraft.category && p.active !== false)
    : []
  const selectedFlow = getServiceFlow(selected?.slug)
  const isStudyProgram = selectedFlow ? selectedFlow.isStudyProgram : selected?.category !== 'SERVICE'
  const serviceDocOptions = selectedFlow ? getServiceDocumentOptions(selectedFlow) : []
  const activeDocOptions = isStudyProgram ? DOC_OPTIONS : (serviceDocOptions.length ? serviceDocOptions.map((d) => ({ value: d.value, label: d.label, icon: FileText })) : DOC_OPTIONS)
  const normalizedProgramSearch = programSearch.trim().toLowerCase()
  const filteredPrograms = programs.filter((p) => {
    const matchesCategory = programCategoryFilter === 'ALL' || p.category === programCategoryFilter
    if (!matchesCategory) return false
    if (!normalizedProgramSearch) return true
    return [p.titleAr, p.titleEn, p.slug, CAT_AR[p.category] || p.category]
      .some((value) => String(value || '').toLowerCase().includes(normalizedProgramSearch))
  })

  const toggleDoc = (doc: string) => {
    const cur = new Set(draft.requiredDocuments || [])
    if (cur.has(doc)) cur.delete(doc)
    else cur.add(doc)
    setDraft({ ...draft, requiredDocuments: Array.from(cur) })
  }

  const patchAcademic = (patch: AcademicProfileDraft) => {
    setDraft({ ...draft, academicProfile: { ...(draft.academicProfile || {}), ...patch } })
  }

  const updateAcademicList = (key: keyof Pick<AcademicProfileDraft, 'learningOutcomes' | 'skills' | 'graduationRequirements' | 'assessmentComponents' | 'qualityControls'>, value: string) => {
    patchAcademic({ [key]: textToList(value) } as AcademicProfileDraft)
  }

  const appendAcademicListItem = (key: keyof Pick<AcademicProfileDraft, 'learningOutcomes' | 'skills' | 'graduationRequirements' | 'assessmentComponents' | 'qualityControls'>) => {
    const current = [...((draft.academicProfile?.[key] as string[] | undefined) || [])]
    if (current.length && current[current.length - 1] === '') current.push('')
    else current.push('')
    patchAcademic({ [key]: current } as AcademicProfileDraft)
  }

  const updateStudyStage = (index: number, patch: Partial<AcademicPlanStage>) => {
    const rows = [...(draft.academicProfile?.studyPlan || [])]
    while (rows.length <= index) rows.push({ title: '', description: '', deliverable: '' })
    rows[index] = { ...rows[index], ...patch }
    patchAcademic({ studyPlan: rows })
  }

  const appendStudyStage = () => {
    const rows = [...(draft.academicProfile?.studyPlan || [])]
    while (rows.length < 3) rows.push({ title: '', description: '', deliverable: '' })
    rows.push({ title: '', description: '', deliverable: '' })
    patchAcademic({ studyPlan: rows })
  }

  const removeStudyStage = (index: number) => {
    const rows = [...(draft.academicProfile?.studyPlan || [])]
    if (rows.length <= 3) return
    rows.splice(index, 1)
    patchAcademic({ studyPlan: rows })
  }

  const updateEvaluationItem = (index: number, patch: Partial<AcademicEvaluationItemDraft>) => {
    const rows = [...(draft.academicProfile?.finalEvaluationFormula || [])]
    while (rows.length <= index) rows.push({ label: '', weight: 0, description: '' })
    rows[index] = { ...rows[index], ...patch }
    patchAcademic({ finalEvaluationFormula: rows })
  }

  const appendEvaluationItem = () => {
    const rows = [...(draft.academicProfile?.finalEvaluationFormula || [])]
    rows.push({ label: '', weight: 0, description: '' })
    patchAcademic({ finalEvaluationFormula: rows })
  }

  const removeEvaluationItem = (index: number) => {
    const rows = [...(draft.academicProfile?.finalEvaluationFormula || [])]
    rows.splice(index, 1)
    patchAcademic({ finalEvaluationFormula: rows })
  }

  const updateTermPlan = (index: number, patch: Partial<AcademicTermPlanDraft>) => {
    const rows = [...(draft.academicProfile?.termPlans || [])]
    while (rows.length <= index) rows.push({ title: '', description: '', phase: 'TERM', weight: 0 })
    rows[index] = { ...rows[index], ...patch }
    patchAcademic({ termPlans: rows })
  }

  const appendTermPlan = () => {
    const rows = [...(draft.academicProfile?.termPlans || [])]
    rows.push({ title: '', description: '', phase: 'TERM', weight: 0 })
    patchAcademic({ termPlans: rows })
  }

  const removeTermPlan = (index: number) => {
    const rows = [...(draft.academicProfile?.termPlans || [])]
    rows.splice(index, 1)
    patchAcademic({ termPlans: rows })
  }

  const patchProgramDraft = (patch: Partial<ProgramDraft>) => {
    setProgramDraft((prev) => prev ? { ...prev, ...patch } : prev)
  }

  const clearAcademicProfile = () => {
    const next = { ...draft }
    delete next.academicProfile
    setDraft(next)
  }

  const fillAcademicFromDefault = () => {
    if (!selected) return
    const flow = getServiceFlow(selected.slug)
    if (flow && !flow.isStudyProgram) {
      const serviceDefaults = buildServiceAdmissionDefaults(flow)
      if (serviceDefaults) {
        setDraft({
          ...draft,
          ...serviceDefaults,
          academicProfile: serviceDefaults.academicProfile,
        })
      }
      return
    }
    const officialDefaults = buildOfficialStudyAdmissionDefaults({
      slug: selected.slug,
      titleAr: selected.titleAr,
      titleEn: selected.titleEn,
      description: selected.description,
      category: selected.category,
      hours: selected.hours,
      _count: selected._count,
    })
    setDraft({
      ...draft,
      ...officialDefaults,
      academicProfile: officialDefaults.academicProfile,
    })
  }

  const save = async (reset = false) => {
    if (!selectedId) return
    setSaving(true)
    try {
      const d = await api<{ rules: Rules; custom: boolean; program?: ProgramDraft }>('/api/admin/program-rules', {
        method: 'PUT',
        body: JSON.stringify({
          programId: selectedId,
          rules: reset ? { reset: true } : normalizeRulesForSave(draft),
          ...(reset ? {} : { programPatch: programDraft }),
        }),
      })
      setDraft({ ...d.rules })
      if (d.program) setProgramDraft(d.program)
      setCustom(d.custom)
      setPrograms((ps) => ps.map((p) => (p.id === selectedId ? {
        ...p,
        ...(d.program || {}),
        program: d.program || p.program,
        titleAr: d.program?.titleAr || p.titleAr,
        titleEn: d.program?.titleEn ?? p.titleEn,
        description: d.program?.description ?? p.description,
        category: d.program?.category || p.category,
        hours: d.program?.hours ?? p.hours,
        price: d.program?.price ?? p.price,
        features: d.program?.features || p.features,
        active: d.program?.active ?? p.active,
        sortOrder: d.program?.sortOrder ?? p.sortOrder,
        credentialType: d.program?.credentialType ?? p.credentialType,
        trademarkNotice: d.program?.trademarkNotice ?? p.trademarkNotice,
        disclosureConsentText: d.program?.disclosureConsentText ?? p.disclosureConsentText,
        rules: d.rules,
        custom: d.custom,
      } : p)))
      toast({ title: reset ? 'أُعيدت القواعد والملف الأكاديمي للافتراضي' : 'حُفظت بيانات البرنامج وقواعد القبول والملف الأكاديمي' })
    } catch {
      toast({ title: 'تعذر الحفظ', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const applyPriceHoursToCategory = async () => {
    if (!programDraft) return
    if (programDraft.price === null || programDraft.price === undefined || !Number.isFinite(Number(programDraft.price))) {
      toast({ title: 'أدخل السعر أولاً قبل التطبيق الجماعي', variant: 'destructive' })
      return
    }
    if (!programDraft.hours || !Number.isFinite(Number(programDraft.hours)) || Number(programDraft.hours) <= 0) {
      toast({ title: 'أدخل عدد ساعات صحيح قبل التطبيق الجماعي', variant: 'destructive' })
      return
    }
    setBulkApplying(true)
    try {
      const d = await api<{ ok: boolean; count: number; price: number; hours: number; programs: Array<{ id: string; titleAr: string; oldPrice?: number | null; oldHours?: number | null }> }>('/api/admin/program-rules', {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'APPLY_CATEGORY_PRICE_HOURS',
          category: programDraft.category,
          price: Number(programDraft.price),
          hours: Number(programDraft.hours),
        }),
      })
      const updatedIds = new Set((d.programs || []).map((p) => p.id))
      setPrograms((ps) => ps.map((p) => updatedIds.has(p.id) ? {
        ...p,
        price: d.price,
        hours: d.hours,
        program: p.program ? { ...p.program, price: d.price, hours: d.hours } : p.program,
      } : p))
      setBulkApplyOpen(false)
      toast({ title: `تم تطبيق السعر والساعات على ${d.count} برنامج/مسار` })
    } catch (e: any) {
      toast({ title: e?.message || 'تعذر تطبيق السعر والساعات على التصنيف', variant: 'destructive' })
    } finally {
      setBulkApplying(false)
    }
  }

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
  }

  return (
    <div className="mt-4 space-y-4 pb-[45vh] md:pb-6">
      <Card className="border-[#0f2b46]/10">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-black text-[#0f2b46]">
                <ClipboardCheck className="h-5 w-5 text-[#a8841a]" />
                قواعد القبول أو متطلبات الخدمة لكل مسار
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                اختر البرنامج أو الخدمة واضبط شروطه: البرامج الدراسية تستخدم مؤهلات ووثائق أكاديمية، أما الخدمات العابرة فتستخدم متطلبات ومرفقات مختلفة حسب نوع الخدمة.
                يقرأ خبير الذكاء الاصطناعي هذه القواعد ويطبقها آلياً قبل زر الاعتماد.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[320px_1fr]">
            {/* قائمة البرامج */}
            <div className="rounded-xl border bg-[#faf6ea]/50 p-2">
              <div className="sticky top-0 z-10 space-y-2 rounded-lg bg-[#faf6ea] p-2 shadow-sm">
                <div className="relative">
                  <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    value={programSearch}
                    onChange={(e) => setProgramSearch(e.target.value)}
                    placeholder="ابحث باسم البرنامج أو slug..."
                    className="h-10 pr-9 text-xs font-bold"
                  />
                </div>
                <Select value={programCategoryFilter} onValueChange={setProgramCategoryFilter}>
                  <SelectTrigger className="h-10 text-xs font-bold"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ALL" className="text-xs">كل التصنيفات</SelectItem>
                    {CATEGORY_OPTIONS.map((c) => <SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-center text-[10px] font-black text-slate-500">
                  ظاهر {filteredPrograms.length} من {programs.length} برنامج/مسار
                </p>
              </div>
              <div className="mt-2 max-h-[460px] space-y-1.5 overflow-y-auto">
                {filteredPrograms.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => selectProgram(p)}
                    className={`block w-full rounded-lg px-3 py-2.5 text-right transition-colors ${
                      p.id === selectedId ? 'bg-[#0f2b46] text-white' : 'hover:bg-[#f7edd0]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs font-black ${p.id === selectedId ? 'text-[#e0b83a]' : 'text-[#0f2b46]'}`}>{p.titleAr}</span>
                      {p.custom && <Badge className="shrink-0 bg-[#c9a227] text-[10px] text-[#0f2b46]">مخصص</Badge>}
                    </div>
                    <span className={`mt-0.5 block text-[10px] ${p.id === selectedId ? 'text-white/70' : 'text-slate-400'}`}>
                      {CAT_AR[p.category] || p.category}
                    </span>
                  </button>
                ))}
                {!filteredPrograms.length && (
                  <div className="rounded-lg border border-dashed bg-white/70 p-4 text-center text-xs font-bold text-slate-500">
                    لا توجد برامج مطابقة للبحث أو التصنيف المحدد.
                  </div>
                )}
              </div>
            </div>

            {/* محرر القواعد */}
            {selected && (
              <div className="space-y-4 rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-black text-[#0f2b46]">{selected.titleAr}</h3>
                    <button
                      type="button"
                      onClick={() => window.open(`/programs/${selected.slug}`, '_blank', 'noopener,noreferrer')}
                      className="mt-1 text-[11px] font-bold text-[#a8841a] underline-offset-4 hover:underline"
                    >
                      معاينة صفحة البرنامج
                    </button>
                  </div>
                  <Badge className={custom ? 'bg-[#c9a227]/20 text-[#a8841a]' : 'bg-slate-100 text-slate-500'}>
                    {custom ? 'قواعد مخصصة مفعلة' : (isStudyProgram ? 'قواعد افتراضية للدرجة' : 'متطلبات خدمة افتراضية')}
                  </Badge>
                </div>

                {programDraft && (
                  <div className="space-y-3">
                    <details open className="rounded-2xl border bg-white p-4">
                      <summary className="cursor-pointer text-sm font-black text-[#0f2b46]">1) البيانات الأساسية</summary>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">اسم البرنامج بالعربية</label>
                          <Input className="text-xs" value={programDraft.titleAr} onChange={(e) => patchProgramDraft({ titleAr: e.target.value })} />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">اسم البرنامج بالإنجليزية</label>
                          <Input className="text-xs" value={programDraft.titleEn || ''} onChange={(e) => patchProgramDraft({ titleEn: e.target.value })} />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">التصنيف</label>
                          <Select value={programDraft.category} onValueChange={(v) => patchProgramDraft({ category: v })}>
                            <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {CATEGORY_OPTIONS.map((c) => <SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">الأيقونة</label>
                          <Input className="text-xs" value={programDraft.icon} onChange={(e) => patchProgramDraft({ icon: e.target.value })} />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">ترتيب العرض</label>
                          <Input type="number" className="text-xs" value={programDraft.sortOrder} onChange={(e) => patchProgramDraft({ sortOrder: Number(e.target.value) })} />
                        </div>
                        <div className="flex items-center justify-between rounded-xl border bg-slate-50 px-3 py-2.5">
                          <div>
                            <p className="text-xs font-black text-[#0f2b46]">البرنامج منشور</p>
                            <p className="text-[10px] text-slate-500">إيقافه يخفيه من الكتالوج العام.</p>
                          </div>
                          <Switch checked={programDraft.active} onCheckedChange={(v) => patchProgramDraft({ active: v })} />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">الوصف</label>
                          <Textarea rows={3} className="text-xs" value={programDraft.description || ''} onChange={(e) => patchProgramDraft({ description: e.target.value })} />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">الميزات — كل سطر ميزة، بحد أقصى 12</label>
                          <Textarea rows={4} className="text-xs" value={listToText(programDraft.features)} onChange={(e) => patchProgramDraft({ features: cleanTextList(textToList(e.target.value)).slice(0, 12) })} />
                        </div>
                      </div>
                    </details>

                    <details className="rounded-2xl border bg-white p-4">
                      <summary className="cursor-pointer text-sm font-black text-[#0f2b46]">2) السعر والمدة</summary>
                      <div className="mt-4 grid gap-3 sm:grid-cols-3">
                        <div>
                          <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">السعر بالدولار</label>
                          <Input type="number" min={0} className="text-xs" value={programDraft.price ?? ''} onChange={(e) => patchProgramDraft({ price: e.target.value === '' ? null : Number(e.target.value) })} />
                        </div>
                        <div>
                          <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">عدد الساعات</label>
                          <Input type="number" min={1} className="text-xs" value={programDraft.hours ?? ''} onChange={(e) => patchProgramDraft({ hours: e.target.value === '' ? null : Number(e.target.value) })} />
                        </div>
                        <div className="rounded-xl border bg-[#faf6ea] p-3 text-xs font-bold leading-6 text-[#0f2b46]">
                          سعر القسط المحسوب سيظهر هنا بعد ربط خطة الأقساط الخاصة بالبرنامج.
                        </div>
                      </div>

                      <div className="mt-4 rounded-2xl border border-[#c9a227]/30 bg-[#fffaf0] p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <p className="text-xs font-black text-[#0f2b46]">تطبيق السعر والساعات على كل برامج هذا التصنيف</p>
                            <p className="mt-1 text-[10px] font-bold leading-5 text-slate-500">
                              سيستخدم السعر والساعات أعلاه ويطبقهما على {categoryProgramsForBulkApply.length} برنامج/مسار ضمن تصنيف «{CAT_AR[programDraft.category] || programDraft.category}».
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="border-[#c9a227]/50 text-[11px] font-black text-[#0f2b46] hover:bg-[#f7edd0]"
                            disabled={saving || bulkApplying || !categoryProgramsForBulkApply.length}
                            onClick={() => setBulkApplyOpen((v) => !v)}
                          >
                            {bulkApplyOpen ? 'إخفاء التأكيد' : 'تطبيق على التصنيف'}
                          </Button>
                        </div>

                        {bulkApplyOpen && (
                          <div className="mt-3 rounded-xl border bg-white p-3">
                            <p className="text-xs font-black text-red-700">تأكيد قبل التنفيذ</p>
                            <p className="mt-1 text-[11px] font-bold leading-6 text-slate-600">
                              سيتم تحديث السعر إلى <span className="font-black text-[#0f2b46]">{programDraft.price ?? 'فارغ'}$</span> وعدد الساعات إلى <span className="font-black text-[#0f2b46]">{programDraft.hours ?? 'فارغ'}</span> للبرامج التالية:
                            </p>
                            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-slate-50 p-2 text-[11px] font-bold leading-6 text-slate-600">
                              {categoryProgramsForBulkApply.map((p) => (
                                <div key={p.id} className="border-b border-slate-100 py-1 last:border-b-0">
                                  {p.titleAr}
                                  <span className="text-slate-400"> — حالياً: {p.price ?? 'بدون سعر'}$ / {p.hours ?? 'بدون ساعات'} ساعة</span>
                                </div>
                              ))}
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                type="button"
                                size="sm"
                                className="bg-red-600 text-xs font-black text-white hover:bg-red-700"
                                disabled={bulkApplying}
                                onClick={applyPriceHoursToCategory}
                              >
                                {bulkApplying ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : null}
                                نعم، طبّق على كل التصنيف
                              </Button>
                              <Button type="button" size="sm" variant="outline" disabled={bulkApplying} onClick={() => setBulkApplyOpen(false)}>
                                إلغاء
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    </details>

                    <details className="rounded-2xl border bg-white p-4">
                      <summary className="cursor-pointer text-sm font-black text-[#0f2b46]">3) بيانات الشهادة</summary>
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        <div>
                          <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">نوع الاعتماد/الشهادة</label>
                          <Select value={programDraft.credentialType || 'PROFESSIONAL_CERTIFICATE'} onValueChange={(v) => patchProgramDraft({ credentialType: v })}>
                            <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {CREDENTIAL_OPTIONS.map((c) => <SelectItem key={c.value} value={c.value} className="text-xs">{c.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="sm:col-span-2">
                          <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">تنبيه العلامة التجارية أو الجهة المالكة</label>
                          <Textarea rows={3} className="text-xs" value={programDraft.trademarkNotice || ''} onChange={(e) => patchProgramDraft({ trademarkNotice: e.target.value })} />
                        </div>
                      </div>
                    </details>
                  </div>
                )}

                <details open className="rounded-2xl border bg-white p-4">
                  <summary className="cursor-pointer text-sm font-black text-[#0f2b46]">4) شروط القبول</summary>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {/* الحد الأدنى للمؤهل */}
                  <div>
                    <label className="mb-1.5 block text-xs font-black text-[#0f2b46]">{isStudyProgram ? 'الحد الأدنى للمؤهل المطلوب' : 'شرط المؤهل للخدمة'}</label>
                    <Select value={draft.minEducation || 'HIGH_SCHOOL'} onValueChange={(v) => setDraft({ ...draft, minEducation: v })}>
                      <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(EDU_AR).map(([v, l]) => (
                          <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* الحد الأدنى للعمر */}
                  {isStudyProgram && (
                    <div>
                      <label className="mb-1.5 block text-xs font-black text-[#0f2b46]">الحد الأدنى للعمر (سنة)</label>
                      <Input
                        type="number" min={12} max={80} className="text-xs"
                        value={draft.minAge ?? 18}
                        onChange={(e) => setDraft({ ...draft, minAge: Number(e.target.value) })}
                      />
                    </div>
                  )}

                  {/* الدكتوراة: إلزام الماجستير */}
                  {selected.category === 'DOCTORATE' && (
                    <>
                      <div className="flex items-center justify-between rounded-lg border bg-slate-50 px-3 py-2.5">
                        <div>
                          <p className="text-xs font-black text-[#0f2b46]">إلزام شهادة ماجستير للقبول بالدكتوراة</p>
                          <p className="text-[10px] text-slate-500">عند الإيقاف يكفي البكالوريوس مع استيفاء شروط أخرى</p>
                        </div>
                        <Switch
                          checked={draft.requireMasterForDoctorate !== false}
                          onCheckedChange={(v) => setDraft({ ...draft, requireMasterForDoctorate: v })}
                        />
                      </div>
                      <div className="flex items-center justify-between rounded-lg border bg-slate-50 px-3 py-2.5">
                        <div>
                          <p className="text-xs font-black text-[#0f2b46]">السماح بمعادلة الخبرات بدل الماجستير</p>
                          <p className="text-[10px] text-slate-500">وفق دليل الإجراءات: بكالوريوس + خبرات عملية</p>
                        </div>
                        <Switch
                          checked={draft.allowExperienceEquivalency !== false}
                          onCheckedChange={(v) => setDraft({ ...draft, allowExperienceEquivalency: v })}
                        />
                      </div>
                    </>
                  )}

                  {/* سنوات الخبرة */}
                  {selected.category === 'DOCTORATE' && draft.allowExperienceEquivalency !== false && (
                    <div>
                      <label className="mb-1.5 block text-xs font-black text-[#0f2b46]">حد أدنى لسنوات الخبرة (لمعادلة الخبرات)</label>
                      <Input
                        type="number" min={0} max={40} className="text-xs"
                        value={draft.minYearsExperience ?? 8}
                        onChange={(e) => setDraft({ ...draft, minYearsExperience: Number(e.target.value) })}
                      />
                    </div>
                  )}
                </div>

                {/* الوثائق الإلزامية */}
                <div>
                  <label className="mb-1.5 block text-xs font-black text-[#0f2b46]">{isStudyProgram ? 'الوثائق الإلزامية عند التقديم' : 'مرفقات الخدمة المطلوبة عند التقديم'}</label>
                  <div className="flex flex-wrap gap-2">
                    {activeDocOptions.map((d) => {
                      const on = (draft.requiredDocuments || []).includes(d.value)
                      return (
                        <button
                          key={d.value}
                          onClick={() => toggleDoc(d.value)}
                          className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-bold transition-colors ${
                            on ? 'border-[#0f2b46] bg-[#0f2b46] text-[#e0b83a]' : 'border-slate-200 bg-white text-slate-500 hover:border-[#c9a227]'
                          }`}
                        >
                          <d.icon className="h-3.5 w-3.5" />
                          {d.label}
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-1 text-[10px] text-slate-400">{isStudyProgram ? 'انقر لإضافة أو إزالة أي وثيقة — يرفض نموذج التقديم الطلب بنقصها، ويحاسب عليها خبير القبول الذكي.' : 'انقر لتحديد المرفقات المطلوبة لهذه الخدمة فقط. الخدمات العابرة لا تستخدم ملفاً أكاديمياً جامعياً إلا إذا أضفته هنا صراحة.'}</p>
                </div>

                {/* قواعد نصية حرة */}
                <div>
                  <label className="mb-1.5 flex items-center gap-1.5 text-xs font-black text-[#0f2b46]">
                    <Sparkles className="h-3.5 w-3.5 text-[#a8841a]" />
                    قواعد إضافية بنص حر — يقرأها الذكاء الاصطناعي ويطبقها حرفياً
                  </label>
                  <Textarea
                    rows={4} className="text-xs"
                    placeholder={isStudyProgram ? 'مثال: يشترط خبرة سنتين في مجال الموارد البشرية. أو: يقبل حملة الدبلوم الصناعي فقط بتخصصات معينة. أو: يجب أن تكون الشهادة مصدقة من وزارة الخارجية.' : 'مثال: لا يلزم ملف أكاديمي. يتم قبول الطلب بعد وضوح بيانات الخدمة والمرفقات المطلوبة حسب نوعها، وقد تطلب الإدارة إثبات دفع أو ملفاً داعماً قبل التسليم.'}
                    value={draft.customRules || ''}
                    onChange={(e) => setDraft({ ...draft, customRules: e.target.value })}
                  />
                </div>

                {/* ملاحظة للمتقدمين */}
                <div>
                  <label className="mb-1.5 block text-xs font-black text-[#0f2b46]">ملاحظة تُعرض للمتقدمين في نموذج {isStudyProgram ? 'طلب الالتحاق' : 'طلب الخدمة'}</label>
                  <Input
                    className="text-xs"
                    placeholder="مثال: يُفضل إرفاق شهادة خبرة لمن يتقدم بمعادلة خبرات"
                    value={draft.displayNote || ''}
                    onChange={(e) => setDraft({ ...draft, displayNote: e.target.value })}
                  />
                </div>

                </details>

                {/* الملف الأكاديمي الرسمي */}
                <details open className="rounded-2xl border-2 border-[#c9a227]/35 bg-[#fffaf0] p-4">
                  <summary className="cursor-pointer text-sm font-black text-[#0f2b46]">5) الملف الأكاديمي</summary>
                  <div className="mt-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="flex items-center gap-1.5 text-sm font-black text-[#0f2b46]">
                        <BookOpen className="h-4 w-4 text-[#a8841a]" />
                        {isStudyProgram ? 'الملف الأكاديمي الرسمي للبرنامج' : 'ملف الخدمة الرسمي ومسار التسليم'}
                      </h4>
                      <p className="mt-1 text-[10px] leading-5 text-slate-500">{isStudyProgram ? 'هذه البيانات تظهر في تفاصيل البرنامج، بوابة الطالب، السجل الأكاديمي، والتحقق من الشهادة. اترك الحقول فارغة ليستخدم النظام الملف التلقائي.' : 'هذه البيانات تظهر كملف خدمة: وصف المسار، المرفقات، خطوات التنفيذ، والمخرجات التي ستُسلم للعميل. زر الملء ينسخ متطلبات الخدمة الرسمية تلقائياً.'}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={fillAcademicFromDefault} className="border-[#c9a227]/40 text-xs font-bold text-[#0f2b46] hover:bg-[#f7edd0]">
                        {isStudyProgram ? 'ملء من بيانات الموقع الرسمي' : 'ملء وفق متطلبات الخدمة الرسمية'}
                      </Button>
                      {draft.academicProfile && (
                        <Button size="sm" variant="outline" onClick={clearAcademicProfile} className="border-red-200 text-xs text-red-600 hover:bg-red-50">
                          مسح التخصيص الأكاديمي
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">{isStudyProgram ? 'المسمى الأكاديمي الظاهر' : 'اسم الخدمة الظاهر'}</label>
                      <Input className="text-xs" placeholder={isStudyProgram ? 'مثال: الماجستير المهني في الأمن السيبراني' : 'مثال: طلب حقيبة تدريبية جاهزة أو معادلة خبرة'} value={draft.academicProfile?.academicTitle || ''} onChange={(e) => patchAcademic({ academicTitle: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">{isStudyProgram ? 'الدرجة' : 'نوع المسار'}</label>
                      <Input className="text-xs" placeholder={isStudyProgram ? 'مثال: ماجستير مهني' : 'مثال: خدمة مهنية عابرة'} value={draft.academicProfile?.degreeLabel || ''} onChange={(e) => patchAcademic({ degreeLabel: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">{isStudyProgram ? 'التخصص' : 'تصنيف الخدمة'}</label>
                      <Input className="text-xs" placeholder={isStudyProgram ? 'مثال: الأمن السيبراني' : 'مثال: معادلة / حقيبة / استشارة'} value={draft.academicProfile?.specialization || ''} onChange={(e) => patchAcademic({ specialization: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">{isStudyProgram ? 'المدة/المسار' : 'مدة/مؤشرات الخدمة'}</label>
                      <Input className="text-xs" placeholder={isStudyProgram ? 'مثال: فصلان دراسيان + بحث تخرج مهني' : 'مثال: 48 ساعة دراسة ملف أو تحميل فوري'} value={draft.academicProfile?.durationLabel || ''} onChange={(e) => patchAcademic({ durationLabel: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">{isStudyProgram ? 'الساعات/الرصيد' : 'طبيعة الرسوم/التسليم'}</label>
                      <Input className="text-xs" placeholder={isStudyProgram ? 'مثال: 700 ساعة تدريبية أو حسب الخطة' : 'مثال: خدمة تنفيذ وتسليم بلا ساعات دراسية'} value={draft.academicProfile?.creditHoursLabel || ''} onChange={(e) => patchAcademic({ creditHoursLabel: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">{isStudyProgram ? 'متطلب البحث/المشروع' : 'شرط التسليم النهائي'}</label>
                      <Input className="text-xs" placeholder={isStudyProgram ? 'مثال: بحث تطبيقي ومناقشة فيديو' : 'مثال: لا يوجد بحث؛ يتم التسليم بعد اعتماد الإدارة'} value={draft.academicProfile?.thesisRequirement || ''} onChange={(e) => patchAcademic({ thesisRequirement: e.target.value })} />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">{isStudyProgram ? 'الوصف الأكاديمي الرسمي' : 'وصف الخدمة الرسمي'}</label>
                      <Textarea rows={2} className="text-xs" placeholder={isStudyProgram ? 'صف البرنامج أكاديمياً بلغة رسمية واضحة' : 'صف الخدمة ومتى تعد مكتملة وماذا يستلم العميل'} value={draft.academicProfile?.levelDescription || ''} onChange={(e) => patchAcademic({ levelDescription: e.target.value })} />
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-black text-[#0f2b46]"><Target className="h-3.5 w-3.5 text-[#a8841a]" /> {isStudyProgram ? 'مخرجات التعلم' : 'ميزات/نطاق الخدمة'} — كل سطر بند</label>
                      <Textarea rows={5} className="scroll-mt-32 text-xs leading-6" value={listToText(draft.academicProfile?.learningOutcomes)} onChange={(e) => updateAcademicList('learningOutcomes', e.target.value)} />
                      <Button type="button" size="sm" variant="outline" onClick={() => appendAcademicListItem('learningOutcomes')} className="mt-2 h-8 border-[#c9a227]/40 text-[11px] font-bold text-[#0f2b46] hover:bg-[#f7edd0]">
                        إضافة بند جديد
                      </Button>
                    </div>
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-black text-[#0f2b46]"><Sparkles className="h-3.5 w-3.5 text-[#a8841a]" /> {isStudyProgram ? 'المهارات المكتسبة' : 'مخرجات التسليم'} — كل سطر بند</label>
                      <Textarea rows={5} className="scroll-mt-32 text-xs leading-6" value={listToText(draft.academicProfile?.skills)} onChange={(e) => updateAcademicList('skills', e.target.value)} />
                      <Button type="button" size="sm" variant="outline" onClick={() => appendAcademicListItem('skills')} className="mt-2 h-8 border-[#c9a227]/40 text-[11px] font-bold text-[#0f2b46] hover:bg-[#f7edd0]">
                        إضافة بند جديد
                      </Button>
                    </div>
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-black text-[#0f2b46]"><ClipboardCheck className="h-3.5 w-3.5 text-[#a8841a]" /> {isStudyProgram ? 'متطلبات التخرج' : 'بيانات/مرفقات الخدمة'} — كل سطر متطلب</label>
                      <Textarea rows={5} className="scroll-mt-32 text-xs leading-6" value={listToText(draft.academicProfile?.graduationRequirements)} onChange={(e) => updateAcademicList('graduationRequirements', e.target.value)} />
                      <Button type="button" size="sm" variant="outline" onClick={() => appendAcademicListItem('graduationRequirements')} className="mt-2 h-8 border-[#c9a227]/40 text-[11px] font-bold text-[#0f2b46] hover:bg-[#f7edd0]">
                        إضافة بند جديد
                      </Button>
                    </div>
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-black text-[#0f2b46]"><ListChecks className="h-3.5 w-3.5 text-[#a8841a]" /> {isStudyProgram ? 'نظام التقييم' : 'الخيارات/الرسوم أو مراحل المراجعة'} — كل سطر بند</label>
                      <Textarea rows={5} className="scroll-mt-32 text-xs leading-6" value={listToText(draft.academicProfile?.assessmentComponents)} onChange={(e) => updateAcademicList('assessmentComponents', e.target.value)} />
                      <Button type="button" size="sm" variant="outline" onClick={() => appendAcademicListItem('assessmentComponents')} className="mt-2 h-8 border-[#c9a227]/40 text-[11px] font-bold text-[#0f2b46] hover:bg-[#f7edd0]">
                        إضافة بند جديد
                      </Button>
                    </div>
                    <div className="lg:col-span-2">
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-black text-[#0f2b46]"><FileText className="h-3.5 w-3.5 text-[#a8841a]" /> {isStudyProgram ? 'ضوابط الجودة الأكاديمية' : 'ضوابط جودة الخدمة والتسليم'} — كل سطر ضابط</label>
                      <Textarea rows={4} className="scroll-mt-32 text-xs leading-6" value={listToText(draft.academicProfile?.qualityControls)} onChange={(e) => updateAcademicList('qualityControls', e.target.value)} />
                      <Button type="button" size="sm" variant="outline" onClick={() => appendAcademicListItem('qualityControls')} className="mt-2 h-8 border-[#c9a227]/40 text-[11px] font-bold text-[#0f2b46] hover:bg-[#f7edd0]">
                        إضافة بند جديد
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 space-y-3 rounded-xl bg-white p-3 ring-1 ring-[#c9a227]/20">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-black text-[#0f2b46]">{isStudyProgram ? 'الخطة الدراسية المعتمدة' : 'مراحل تنفيذ الخدمة المعتمدة'}</p>
                      <Button type="button" size="sm" variant="outline" onClick={appendStudyStage} className="h-8 border-[#c9a227]/40 text-[11px] font-bold text-[#0f2b46] hover:bg-[#f7edd0]">
                        إضافة مرحلة جديدة
                      </Button>
                    </div>
                    {Array.from({ length: Math.max(3, draft.academicProfile?.studyPlan?.length || 0) }).map((_, i) => {
                      const stage = stageAt(draft.academicProfile, i)
                      const canRemove = (draft.academicProfile?.studyPlan?.length || 0) > 3
                      return (
                        <div key={i} className="rounded-lg bg-slate-50 p-2">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <p className="text-[11px] font-black text-[#0f2b46]">مرحلة {i + 1}</p>
                            {canRemove && (
                              <button type="button" onClick={() => removeStudyStage(i)} className="text-[11px] font-bold text-red-600">
                                حذف المرحلة
                              </button>
                            )}
                          </div>
                          <div className="grid gap-2 sm:grid-cols-3">
                            <Input className="text-xs" placeholder={`عنوان المرحلة ${i + 1}`} value={stage.title} onChange={(e) => updateStudyStage(i, { title: e.target.value })} />
                            <Input className="text-xs" placeholder="وصف المرحلة" value={stage.description} onChange={(e) => updateStudyStage(i, { description: e.target.value })} />
                            <Input className="text-xs" placeholder="المخرج المطلوب" value={stage.deliverable} onChange={(e) => updateStudyStage(i, { deliverable: e.target.value })} />
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div className="mt-4 space-y-3 rounded-xl bg-white p-3 ring-1 ring-[#c9a227]/20">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-black text-[#0f2b46]">معادلة التقييم النهائي</p>
                      <Button type="button" size="sm" variant="outline" onClick={appendEvaluationItem} className="h-8 border-[#c9a227]/40 text-[11px] font-bold text-[#0f2b46] hover:bg-[#f7edd0]">
                        إضافة عنصر تقييم
                      </Button>
                    </div>
                    {(draft.academicProfile?.finalEvaluationFormula || []).map((item, i) => (
                      <div key={i} className="rounded-lg bg-slate-50 p-2">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-[11px] font-black text-[#0f2b46]">عنصر تقييم {i + 1}</p>
                          <button type="button" onClick={() => removeEvaluationItem(i)} className="text-[11px] font-bold text-red-600">حذف</button>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-[1fr_110px_1.5fr]">
                          <Input className="text-xs" placeholder="العنصر: بحث، اختبار، مشاركة..." value={item.label} onChange={(e) => updateEvaluationItem(i, { label: e.target.value })} />
                          <Input type="number" min={0} max={100} className="text-xs" placeholder="النسبة %" value={item.weight || ''} onChange={(e) => updateEvaluationItem(i, { weight: Number(e.target.value) })} />
                          <Input className="text-xs" placeholder="وصف مختصر" value={item.description || ''} onChange={(e) => updateEvaluationItem(i, { description: e.target.value })} />
                        </div>
                      </div>
                    ))}
                    {!(draft.academicProfile?.finalEvaluationFormula || []).length && <p className="text-[11px] font-bold text-slate-400">اتركها فارغة ليستخدم النظام معادلة التقييم التلقائية من الدليل.</p>}
                  </div>

                  <div className="mt-4 space-y-3 rounded-xl bg-white p-3 ring-1 ring-[#c9a227]/20">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-black text-[#0f2b46]">خطة الفصول التفصيلية</p>
                      <Button type="button" size="sm" variant="outline" onClick={appendTermPlan} className="h-8 border-[#c9a227]/40 text-[11px] font-bold text-[#0f2b46] hover:bg-[#f7edd0]">
                        إضافة فصل/مرحلة
                      </Button>
                    </div>
                    {(draft.academicProfile?.termPlans || []).map((term, i) => (
                      <div key={i} className="rounded-lg bg-slate-50 p-2">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-[11px] font-black text-[#0f2b46]">فصل/مرحلة {i + 1}</p>
                          <button type="button" onClick={() => removeTermPlan(i)} className="text-[11px] font-bold text-red-600">حذف</button>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-[1fr_150px_100px]">
                          <Input className="text-xs" placeholder="عنوان الفصل أو المرحلة" value={term.title} onChange={(e) => updateTermPlan(i, { title: e.target.value })} />
                          <Select value={term.phase || 'TERM'} onValueChange={(v) => updateTermPlan(i, { phase: v as AcademicTermPlanDraft['phase'] })}>
                            <SelectTrigger className="text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="TERM" className="text-xs">فصل</SelectItem>
                              <SelectItem value="THESIS" className="text-xs">رسالة/بحث</SelectItem>
                              <SelectItem value="PROJECT" className="text-xs">مشروع</SelectItem>
                              <SelectItem value="ACCREDITATION" className="text-xs">اعتماد</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input type="number" min={0} max={100} className="text-xs" placeholder="الوزن %" value={term.weight || ''} onChange={(e) => updateTermPlan(i, { weight: Number(e.target.value) })} />
                        </div>
                        <Textarea rows={2} className="mt-2 text-xs" placeholder="وصف الفصل أو المرحلة" value={term.description || ''} onChange={(e) => updateTermPlan(i, { description: e.target.value })} />
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <Textarea rows={3} className="text-xs" placeholder="مخرجات التعلم — كل سطر بند" value={listToText(term.learningOutcomes)} onChange={(e) => updateTermPlan(i, { learningOutcomes: textToList(e.target.value) })} />
                          <Textarea rows={3} className="text-xs" placeholder="المهارات المطلوبة — كل سطر بند" value={listToText(term.requiredSkills)} onChange={(e) => updateTermPlan(i, { requiredSkills: textToList(e.target.value) })} />
                          <Textarea rows={3} className="text-xs" placeholder="الواجبات/المخرجات — كل سطر بند" value={listToText(term.assignments)} onChange={(e) => updateTermPlan(i, { assignments: textToList(e.target.value) })} />
                          <Textarea rows={3} className="text-xs" placeholder="التقييم النهائي أو ملاحظة الحالة" value={term.finalEvaluation || term.statusHint || ''} onChange={(e) => updateTermPlan(i, { finalEvaluation: e.target.value, statusHint: e.target.value })} />
                        </div>
                      </div>
                    ))}
                    {!(draft.academicProfile?.termPlans || []).length && <p className="text-[11px] font-bold text-slate-400">اتركها فارغة ليستخدم النظام خطط الفصول التلقائية من الدليل.</p>}
                  </div>
                  </div>
                </details>

                {programDraft && (
                  <details className="rounded-2xl border bg-white p-4">
                    <summary className="cursor-pointer text-sm font-black text-[#0f2b46]">6) نص الإقرار قبل الدفع</summary>
                    <div className="mt-4">
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">نص اختياري خاص بهذا البرنامج</label>
                      <Textarea
                        rows={4}
                        className="text-xs"
                        placeholder="اتركه فارغاً ليستخدم النظام نص الإقرار العام من صفحة الرسوم والقواعد"
                        value={programDraft.disclosureConsentText || ''}
                        onChange={(e) => patchProgramDraft({ disclosureConsentText: e.target.value })}
                      />
                    </div>
                  </details>
                )}

                <div className="flex flex-wrap gap-2 border-t pt-3">
                  <Button onClick={() => save(false)} disabled={saving} className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#12365c]">
                    {saving ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Save className="ml-1 h-4 w-4" />}
                    حفظ القواعد والملف الأكاديمي
                  </Button>
                  {custom && (
                    <Button onClick={() => save(true)} disabled={saving} variant="outline" className="border-red-200 text-red-600 hover:bg-red-50">
                      <RotateCcw className="ml-1 h-4 w-4" />
                      العودة للافتراضي
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
