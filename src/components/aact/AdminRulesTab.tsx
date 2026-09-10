'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { buildAcademicProgramProfile } from '@/lib/program-tracks'
import { toast } from '@/hooks/use-toast'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, Save, RotateCcw, Sparkles, ClipboardCheck, FileText, IdCard, Camera, ScrollText, Users, GraduationCap, BookOpen, Target, ListChecks } from 'lucide-react'

// ===== تبويب قواعد القبول المخصصة لكل برنامج =====
// الإدارة تضبط لكل برنامج: الحد الأدنى للمؤهل، إلزام الماجستير للدكتوراة، معادلة الخبرات،
// الوثائق الإلزامية، الحد الأدنى للعمر، وقواعد نصية حرة — يطبقها خبير القبول الذكي على كل طلب.

interface AcademicPlanStage {
  title: string
  description: string
  deliverable: string
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
  graduationRequirements?: string[]
  assessmentComponents?: string[]
  thesisRequirement?: string
  qualityControls?: string[]
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

interface ProgramRules {
  id: string
  slug: string
  titleAr: string
  titleEn?: string | null
  description?: string | null
  category: string
  hours?: number | null
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
  ACCREDITATION: 'اعتماد',
}

function listToText(list?: string[]) {
  return (list || []).join('\n')
}

function textToList(text: string) {
  return text.split('\n').map((x) => x.trim()).filter(Boolean)
}

function stageAt(profile: AcademicProfileDraft | null | undefined, index: number): AcademicPlanStage {
  return profile?.studyPlan?.[index] || { title: '', description: '', deliverable: '' }
}

export function AdminRulesTab() {
  const [programs, setPrograms] = useState<ProgramRules[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [draft, setDraft] = useState<Rules>({})
  const [custom, setCustom] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api<{ programs: ProgramRules[] }>('/api/admin/program-rules')
      .then((d) => {
        setPrograms(d.programs)
        if (d.programs.length) select(d.programs[0])
      })
      .catch(() => toast({ title: 'تعذر تحميل البرامج', variant: 'destructive' }))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const select = (p: ProgramRules) => {
    setSelectedId(p.id)
    setDraft({ ...p.rules })
    setCustom(p.custom)
  }

  const selected = programs.find((p) => p.id === selectedId)

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

  const updateStudyStage = (index: number, patch: Partial<AcademicPlanStage>) => {
    const rows = [...(draft.academicProfile?.studyPlan || [])]
    while (rows.length <= index) rows.push({ title: '', description: '', deliverable: '' })
    rows[index] = { ...rows[index], ...patch }
    patchAcademic({ studyPlan: rows })
  }

  const clearAcademicProfile = () => {
    const next = { ...draft }
    delete next.academicProfile
    setDraft(next)
  }

  const save = async (reset = false) => {
    if (!selectedId) return
    setSaving(true)
    try {
      const d = await api<{ rules: Rules; custom: boolean }>('/api/admin/program-rules', {
        method: 'PUT',
        body: JSON.stringify({ programId: selectedId, rules: reset ? { reset: true } : draft }),
      })
      setDraft({ ...d.rules })
      setCustom(d.custom)
      setPrograms((ps) => ps.map((p) => (p.id === selectedId ? { ...p, rules: d.rules, custom: d.custom } : p)))
      toast({ title: reset ? 'أُعيدت القواعد والملف الأكاديمي للافتراضي' : 'حُفظت قواعد القبول والملف الأكاديمي — سيظهر التحديث في تفاصيل البرنامج والسجل والشهادة' })
    } catch {
      toast({ title: 'تعذر الحفظ', variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
  }

  return (
    <div className="mt-4 space-y-4">
      <Card className="border-[#0f2b46]/10">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-lg font-black text-[#0f2b46]">
                <ClipboardCheck className="h-5 w-5 text-[#a8841a]" />
                قواعد القبول المخصصة لكل برنامج
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-slate-500">
                اختر البرنامج واضبط شروط قبوله — يقرأ خبير الذكاء الاصطناعي هذه القواعد ويطبقها آلياً على كل طلب التحاق
                ويضع ملاحظاته للإدارة قبل زر الاعتماد. البرامج بلا تخصيص تطبق القواعد الافتراضية لدرجتها العلمية.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[320px_1fr]">
            {/* قائمة البرامج */}
            <div className="max-h-[560px] space-y-1.5 overflow-y-auto rounded-xl border bg-[#faf6ea]/50 p-2">
              {programs.map((p) => (
                <button
                  key={p.id}
                  onClick={() => select(p)}
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
            </div>

            {/* محرر القواعد */}
            {selected && (
              <div className="space-y-4 rounded-xl border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-black text-[#0f2b46]">{selected.titleAr}</h3>
                  <Badge className={custom ? 'bg-[#c9a227]/20 text-[#a8841a]' : 'bg-slate-100 text-slate-500'}>
                    {custom ? 'قواعد مخصصة مفعلة' : 'قواعد افتراضية للدرجة'}
                  </Badge>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  {/* الحد الأدنى للمؤهل */}
                  <div>
                    <label className="mb-1.5 block text-xs font-black text-[#0f2b46]">الحد الأدنى للمؤهل المطلوب</label>
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
                  <div>
                    <label className="mb-1.5 block text-xs font-black text-[#0f2b46]">الحد الأدنى للعمر (سنة)</label>
                    <Input
                      type="number" min={12} max={80} className="text-xs"
                      value={draft.minAge ?? 18}
                      onChange={(e) => setDraft({ ...draft, minAge: Number(e.target.value) })}
                    />
                  </div>

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
                  <label className="mb-1.5 block text-xs font-black text-[#0f2b46]">الوثائق الإلزامية عند التقديم</label>
                  <div className="flex flex-wrap gap-2">
                    {DOC_OPTIONS.map((d) => {
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
                  <p className="mt-1 text-[10px] text-slate-400">انقر لإضافة أو إزالة أي وثيقة — يرفض نموذج التقديم الطلب بنقصها، ويحاسب عليها خبير القبول الذكي.</p>
                </div>

                {/* قواعد نصية حرة */}
                <div>
                  <label className="mb-1.5 flex items-center gap-1.5 text-xs font-black text-[#0f2b46]">
                    <Sparkles className="h-3.5 w-3.5 text-[#a8841a]" />
                    قواعد إضافية بنص حر — يقرأها الذكاء الاصطناعي ويطبقها حرفياً
                  </label>
                  <Textarea
                    rows={4} className="text-xs"
                    placeholder="مثال: يشترط خبرة سنتين في مجال الموارد البشرية. أو: يقبل حملة الدبلوم الصناعي فقط بتخصصات معينة. أو: يجب أن تكون الشهادة مصدقة من وزارة الخارجية."
                    value={draft.customRules || ''}
                    onChange={(e) => setDraft({ ...draft, customRules: e.target.value })}
                  />
                </div>

                {/* ملاحظة للمتقدمين */}
                <div>
                  <label className="mb-1.5 block text-xs font-black text-[#0f2b46]">ملاحظة تُعرض للمتقدمين في نموذج طلب الالتحاق</label>
                  <Input
                    className="text-xs"
                    placeholder="مثال: يُفضل إرفاق شهادة خبرة لمن يتقدم بمعادلة خبرات"
                    value={draft.displayNote || ''}
                    onChange={(e) => setDraft({ ...draft, displayNote: e.target.value })}
                  />
                </div>

                {/* الملف الأكاديمي الرسمي */}
                <div className="rounded-2xl border-2 border-[#c9a227]/35 bg-[#fffaf0] p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h4 className="flex items-center gap-1.5 text-sm font-black text-[#0f2b46]">
                        <BookOpen className="h-4 w-4 text-[#a8841a]" />
                        الملف الأكاديمي الرسمي للبرنامج
                      </h4>
                      <p className="mt-1 text-[10px] leading-5 text-slate-500">هذه البيانات تظهر في تفاصيل البرنامج، بوابة الطالب، السجل الأكاديمي، والتحقق من الشهادة. اترك الحقول فارغة ليستخدم النظام الملف التلقائي.</p>
                    </div>
                    {draft.academicProfile && (
                      <Button size="sm" variant="outline" onClick={clearAcademicProfile} className="border-red-200 text-xs text-red-600 hover:bg-red-50">
                        مسح التخصيص الأكاديمي
                      </Button>
                    )}
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">المسمى الأكاديمي الظاهر</label>
                      <Input className="text-xs" placeholder="مثال: الماجستير المهني في الأمن السيبراني" value={draft.academicProfile?.academicTitle || ''} onChange={(e) => patchAcademic({ academicTitle: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">الدرجة</label>
                      <Input className="text-xs" placeholder="مثال: ماجستير مهني" value={draft.academicProfile?.degreeLabel || ''} onChange={(e) => patchAcademic({ degreeLabel: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">التخصص</label>
                      <Input className="text-xs" placeholder="مثال: الأمن السيبراني" value={draft.academicProfile?.specialization || ''} onChange={(e) => patchAcademic({ specialization: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">المدة/المسار</label>
                      <Input className="text-xs" placeholder="مثال: فصلان دراسيان + بحث تخرج مهني" value={draft.academicProfile?.durationLabel || ''} onChange={(e) => patchAcademic({ durationLabel: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">الساعات/الرصيد</label>
                      <Input className="text-xs" placeholder="مثال: 700 ساعة تدريبية أو حسب الخطة" value={draft.academicProfile?.creditHoursLabel || ''} onChange={(e) => patchAcademic({ creditHoursLabel: e.target.value })} />
                    </div>
                    <div>
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">متطلب البحث/المشروع</label>
                      <Input className="text-xs" placeholder="مثال: بحث تطبيقي ومناقشة فيديو" value={draft.academicProfile?.thesisRequirement || ''} onChange={(e) => patchAcademic({ thesisRequirement: e.target.value })} />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="mb-1 block text-[11px] font-black text-[#0f2b46]">الوصف الأكاديمي الرسمي</label>
                      <Textarea rows={2} className="text-xs" placeholder="صف البرنامج أكاديمياً بلغة رسمية واضحة" value={draft.academicProfile?.levelDescription || ''} onChange={(e) => patchAcademic({ levelDescription: e.target.value })} />
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-2">
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-black text-[#0f2b46]"><Target className="h-3.5 w-3.5 text-[#a8841a]" /> مخرجات التعلم — كل سطر مخرج</label>
                      <Textarea rows={5} className="text-xs" value={listToText(draft.academicProfile?.learningOutcomes)} onChange={(e) => updateAcademicList('learningOutcomes', e.target.value)} />
                    </div>
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-black text-[#0f2b46]"><Sparkles className="h-3.5 w-3.5 text-[#a8841a]" /> المهارات المكتسبة — كل سطر مهارة</label>
                      <Textarea rows={5} className="text-xs" value={listToText(draft.academicProfile?.skills)} onChange={(e) => updateAcademicList('skills', e.target.value)} />
                    </div>
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-black text-[#0f2b46]"><ClipboardCheck className="h-3.5 w-3.5 text-[#a8841a]" /> متطلبات التخرج — كل سطر متطلب</label>
                      <Textarea rows={5} className="text-xs" value={listToText(draft.academicProfile?.graduationRequirements)} onChange={(e) => updateAcademicList('graduationRequirements', e.target.value)} />
                    </div>
                    <div>
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-black text-[#0f2b46]"><ListChecks className="h-3.5 w-3.5 text-[#a8841a]" /> نظام التقييم — كل سطر بند</label>
                      <Textarea rows={5} className="text-xs" value={listToText(draft.academicProfile?.assessmentComponents)} onChange={(e) => updateAcademicList('assessmentComponents', e.target.value)} />
                    </div>
                    <div className="lg:col-span-2">
                      <label className="mb-1 flex items-center gap-1 text-[11px] font-black text-[#0f2b46]"><FileText className="h-3.5 w-3.5 text-[#a8841a]" /> ضوابط الجودة الأكاديمية — كل سطر ضابط</label>
                      <Textarea rows={4} className="text-xs" value={listToText(draft.academicProfile?.qualityControls)} onChange={(e) => updateAcademicList('qualityControls', e.target.value)} />
                    </div>
                  </div>

                  <div className="mt-4 space-y-3 rounded-xl bg-white p-3 ring-1 ring-[#c9a227]/20">
                    <p className="text-xs font-black text-[#0f2b46]">الخطة الدراسية المعتمدة</p>
                    {[0, 1, 2].map((i) => {
                      const stage = stageAt(draft.academicProfile, i)
                      return (
                        <div key={i} className="grid gap-2 rounded-lg bg-slate-50 p-2 sm:grid-cols-3">
                          <Input className="text-xs" placeholder={`عنوان المرحلة ${i + 1}`} value={stage.title} onChange={(e) => updateStudyStage(i, { title: e.target.value })} />
                          <Input className="text-xs" placeholder="وصف المرحلة" value={stage.description} onChange={(e) => updateStudyStage(i, { description: e.target.value })} />
                          <Input className="text-xs" placeholder="المخرج المطلوب" value={stage.deliverable} onChange={(e) => updateStudyStage(i, { deliverable: e.target.value })} />
                        </div>
                      )
                    })}
                  </div>
                </div>

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
