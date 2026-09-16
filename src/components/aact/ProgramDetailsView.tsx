'use client'

import { useEffect, useState } from 'react'
import { useAppStore, api } from '@/lib/store'
import { buildAcademicProgramProfile } from '@/lib/program-tracks'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  GraduationCap, Award, Briefcase, ShieldCheck, Building2, BookOpen,
  Clock3, BadgeCheck, CheckCircle2, ClipboardList, ChevronLeft, ArrowRight,
  Users2, FileText, Loader2, Layers, BookMarked, FileCheck2, Landmark,
  PackageCheck, MessagesSquare, Presentation, Headphones, Megaphone, Calendar,
  HardHat, HeartPulse, Calculator, Monitor, Compass, Library, Newspaper, Plane,
  ShoppingCart, Gauge, Sparkles, TrendingUp, Network, School, Clipboard, Languages, Globe,
} from 'lucide-react'

interface Program {
  id: string
  slug: string
  titleAr: string
  titleEn?: string
  description: string
  category: string
  hours?: number | null
  price?: number | null
  icon: string
  features: string[]
  unitsCount: number
  units?: { id?: string; order?: number; title?: string }[]
  books?: { id?: string; title?: string; titleEn?: string | null; semester?: number | null; source?: string | null }[]
  assignments?: { id?: string; title?: string; semester?: number | null; points?: number | null; status?: string | null }[]
  studyGuides?: { id?: string; title?: string; semester?: number | null; overview?: string | null }[]
  exams?: { id?: string; title?: string; semester?: number | null; status?: string | null; questionCount?: number | null }[]
  academicProfile?: any
  enrolled: boolean
}

const ICONS: Record<string, any> = {
  briefcase: Briefcase,
  award: Award,
  'book-open': BookOpen,
  'shield-check': ShieldCheck,
  'building-2': Building2,
  'graduation-cap': GraduationCap,
  'file-check-2': FileCheck2,
  'package-check': PackageCheck,
  'messages-square': MessagesSquare,
  presentation: Presentation,
  headphones: Headphones,
  megaphone: Megaphone,
  calendar: Calendar,
  'hard-hat': HardHat,
  'heart-pulse': HeartPulse,
  calculator: Calculator,
  monitor: Monitor,
  compass: Compass,
  library: Library,
  newspaper: Newspaper,
  plane: Plane,
  'shopping-cart': ShoppingCart,
  gauge: Gauge,
  sparkles: Sparkles,
  'badge-check': BadgeCheck,
  'trending-up': TrendingUp,
  network: Network,
  school: School,
  clipboard: Clipboard,
  languages: Languages,
  globe: Globe,
}

const CATEGORY_LABEL: Record<string, string> = {
  DIPLOMA: 'دبلوم مهني',
  DOCTORATE: 'دكتوراه مهنية',
  MASTERS: 'ماجستير مهني',
  ACCREDITATION: 'اعتماد دولي',
  INTL_CERT: 'شهادة دولية',
  SERVICE: 'خدمة مهنية',
}

const PROGRAMS_CACHE_KEY = 'aact_programs_summary_v3'

function readCachedPrograms(): Program[] {
  if (typeof window === 'undefined') return []
  try {
    const cached = JSON.parse(localStorage.getItem(PROGRAMS_CACHE_KEY) || '[]')
    return Array.isArray(cached) ? cached : []
  } catch {
    return []
  }
}

function cachePrograms(list: Program[]) {
  if (typeof window === 'undefined' || !Array.isArray(list) || list.length === 0) return
  try {
    localStorage.setItem(PROGRAMS_CACHE_KEY, JSON.stringify(list.slice(0, 160)))
    localStorage.setItem('aact_program_count', String(list.length))
  } catch {}
}

function semesterLabel(value?: number | null) {
  return value === 2 ? 'الفصل الثاني' : value === 3 ? 'بحث/مشروع' : 'الفصل الأول'
}

function moneyLabel(value?: number | null, isService = false) {
  if (value != null) return String(value) + ' دولار'
  return isService ? 'حسب الخدمة' : 'حسب البرنامج'
}

function EmptyBox({ text }: { text: string }) {
  return <div className="rounded-2xl border border-slate-100 bg-slate-50 p-6 text-center text-xs font-bold leading-6 text-slate-500">{text}</div>
}

function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#0f2b46]/10 bg-[#faf6ea] p-4">
      <Icon className="mb-2 h-5 w-5 text-[#a8841a]" />
      <p className="text-xs font-bold text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-black text-[#0f2b46]">{value}</p>
    </div>
  )
}

export function ProgramDetailsView() {
  const { programDetailsId, user, navigate, openApply, openProgram } = useAppStore()
  const [programs, setPrograms] = useState<Program[]>([])
  const [loading, setLoading] = useState(true)
  const { toast } = useToast()

  useEffect(() => {
    api<{ programs: Program[] }>('/api/programs')
      .then((d) => setPrograms(d.programs || []))
      .catch(() => toast({ title: 'خطأ', description: 'تعذر تحميل تفاصيل البرنامج أو الخدمة', variant: 'destructive' }))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!programDetailsId && !loading) navigate('programs')
  }, [programDetailsId, loading, navigate])

  const program = programs.find((p) => p.id === programDetailsId || p.slug === programDetailsId)
  const isService = program?.category === 'SERVICE'
  const Icon = program ? (ICONS[program.icon] || GraduationCap) : GraduationCap
  const academicProfile = program && !isService ? buildAcademicProgramProfile(program) : null

  const startAdmission = () => {
    if (!program) return
    if (program.enrolled && !isService) {
      openProgram(program.id)
      return
    }
    if (!user) {
      toast({
        title: 'تنبيه',
        description: isService ? 'سجّل دخولك أو أنشئ حساباً ثم قدّم طلب الخدمة' : 'سجّل دخولك أو أنشئ حساباً ثم قدّم طلب الالتحاق',
      })
      navigate('auth')
      return
    }
    openApply(program.titleAr)
  }

  if (loading) {
    return (
      <div className="mx-auto flex min-h-[50vh] max-w-5xl items-center justify-center px-4 py-12">
        <Loader2 className="h-9 w-9 animate-spin text-[#c9a227]" />
      </div>
    )
  }

  if (!program) {
    return (
      <div className="aact-fade-in mx-auto max-w-3xl px-4 py-12 text-center">
        <Card className="border-[#0f2b46]/10 bg-white">
          <CardContent className="p-8">
            <FileText className="mx-auto mb-3 h-12 w-12 text-slate-300" />
            <h1 className="text-xl font-black text-[#0f2b46]">لم يتم العثور على العنصر المحدد</h1>
            <p className="mt-2 text-sm text-slate-500">قد يكون البرنامج أو الخدمة حُذف أو تغيّر معرّفه. ارجع إلى القائمة واختره من جديد.</p>
            <Button onClick={() => navigate('programs')} className="mt-5 bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#183c5f]">
              العودة إلى الخدمات والبرامج
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const categoryLabel = CATEGORY_LABEL[program.category] || 'برنامج تدريبي'
  const requestSteps = isService
    ? ['إنشاء حساب أو تسجيل الدخول', 'تعبئة طلب الخدمة وتحديد الاحتياج', 'إرفاق الوثائق أو الملفات المطلوبة', 'مراجعة الإدارة وتحديد الإجراء المناسب', 'إشعار المتقدم بالرسوم أو الموعد أو النتيجة']
    : ['إنشاء حساب أو تسجيل الدخول', 'تعبئة طلب الالتحاق ورفع الوثائق', 'سداد رسوم التقديم وحجز المقعد', 'مراجعة الإدارة واعتماد الطلب', 'بدء الدراسة بعد القبول وسداد الرسوم']

  return (
    <div className="aact-fade-in mx-auto max-w-6xl px-4 py-10">
      <button
        onClick={() => navigate('programs')}
        className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#0f2b46]/15 bg-white px-4 py-2 text-xs font-black text-[#0f2b46] hover:bg-[#0f2b46]/5"
      >
        <ArrowRight className="h-4 w-4" />
        العودة إلى كل الخدمات والبرامج
      </button>

      <Card className="overflow-hidden border-[#c9a227]/40 bg-white shadow-sm">
        <div className="border-b-4 border-[#c9a227] bg-[#0f2b46] p-6 text-[#f5f0e1] sm:p-8">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-4">
              <div className="rounded-2xl bg-[#f5f0e1] p-4 text-[#0f2b46] shadow">
                <Icon className="h-8 w-8" />
              </div>
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge className="bg-[#c9a227] text-[#0f2b46] hover:bg-[#c9a227]">
                    {categoryLabel}
                  </Badge>
                  {program.enrolled && !isService && (
                    <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                      <CheckCircle2 className="ml-1 h-3 w-3" /> مسجل
                    </Badge>
                  )}
                </div>
                <h1 className="text-2xl font-black leading-snug sm:text-3xl">{program.titleAr}</h1>
                {program.titleEn && <p className="mt-2 text-sm font-bold text-[#e0b83a]">{program.titleEn}</p>}
              </div>
            </div>
            <Button onClick={startAdmission} className="shrink-0 bg-[#c9a227] font-black text-[#0f2b46] hover:bg-[#e0b83a]">
              {program.enrolled && !isService ? 'ادرس البرنامج' : isService ? 'اطلب الخدمة الآن' : 'قدّم طلب الالتحاق'}
              <ChevronLeft className="mr-1 h-4 w-4" />
            </Button>
          </div>
        </div>

        <CardContent className="p-6 sm:p-8">
          <div className="grid gap-4 md:grid-cols-3">
            <StatCard icon={Clock3} label={isService ? 'مدة الخدمة' : 'الساعات التدريبية'} value={program.hours ? String(program.hours) + ' ساعة' : isService ? 'حسب طبيعة الطلب' : 'حسب مسار البرنامج'} />
            <StatCard icon={BadgeCheck} label="الرسوم" value={moneyLabel(program.price, isService)} />
            <StatCard icon={Users2} label={isService ? 'المتابعة' : 'المحتوى'} value={program.unitsCount > 0 ? String(program.unitsCount) + ' وحدات' : isService ? 'طلب خدمة ومتابعة' : 'اعتماد مباشر'} />
          </div>

          <Tabs defaultValue="overview" dir="rtl" className="mt-6 space-y-5">
            <div className="sticky top-2 z-20 rounded-2xl border border-[#0f2b46]/10 bg-white/95 p-2 shadow-sm backdrop-blur">
              <TabsList className="flex h-auto w-full flex-wrap gap-1 bg-transparent p-0">
                <TabsTrigger value="overview" className="text-[10px] font-black sm:text-xs"><ClipboardList className="ml-1 h-3.5 w-3.5" /> {isService ? 'نبذة الخدمة' : 'نبذة البرنامج'}</TabsTrigger>
                {!isService && <TabsTrigger value="academic" className="text-[10px] font-black sm:text-xs"><Landmark className="ml-1 h-3.5 w-3.5" /> النظام الأكاديمي</TabsTrigger>}
                {!isService && <TabsTrigger value="content" className="text-[10px] font-black sm:text-xs"><BookMarked className="ml-1 h-3.5 w-3.5" /> المحتوى والكتب</TabsTrigger>}
                <TabsTrigger value="admission" className="text-[10px] font-black sm:text-xs"><ShieldCheck className="ml-1 h-3.5 w-3.5" /> {isService ? 'طلب الخدمة' : 'الالتحاق والرسوم'}</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="overview" className="mt-0 space-y-5">
              {academicProfile && (
                <section className="rounded-3xl border-2 border-[#c9a227]/45 bg-[#fffaf0] p-5 shadow-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs font-black text-[#a8841a]">الملف الأكاديمي الرسمي للبرنامج</p>
                      <h2 className="mt-1 text-xl font-black leading-snug text-[#0f2b46]">{academicProfile.academicTitle}</h2>
                      <p className="mt-2 text-sm font-bold leading-7 text-slate-600">{academicProfile.levelDescription}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-center text-[11px] font-black text-[#0f2b46] sm:min-w-[250px]">
                      <div className="rounded-2xl bg-white p-3 ring-1 ring-[#c9a227]/25">
                        <p className="text-slate-500">الدرجة</p>
                        <p className="mt-1 text-[#a8841a]">{academicProfile.degreeLabel}</p>
                      </div>
                      <div className="rounded-2xl bg-white p-3 ring-1 ring-[#c9a227]/25">
                        <p className="text-slate-500">التخصص</p>
                        <p className="mt-1 text-[#a8841a]">{academicProfile.specialization}</p>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
                <section className="rounded-2xl border border-[#0f2b46]/10 bg-white p-5">
                  <h2 className="mb-3 flex items-center gap-2 text-lg font-black text-[#0f2b46]">
                    <ClipboardList className="h-5 w-5 text-[#a8841a]" /> {isService ? 'تفاصيل الخدمة' : 'تفاصيل البرنامج'}
                  </h2>
                  <p className="text-sm leading-8 text-slate-600">{program.description}</p>
                </section>

                <section className="rounded-2xl border border-[#0f2b46]/10 bg-[#faf6ea] p-5">
                  <h2 className="mb-3 flex items-center gap-2 text-lg font-black text-[#0f2b46]">
                    <CheckCircle2 className="h-5 w-5 text-emerald-600" /> {isService ? 'مكونات وفوائد الخدمة' : 'لماذا هذا البرنامج؟'}
                  </h2>
                  {(program.features || []).length ? (
                    <div className="space-y-2">
                      {program.features.slice(0, 8).map((feature, i) => (
                        <p key={String(i)} className="flex gap-2 text-xs font-bold leading-6 text-slate-600">
                          <CheckCircle2 className="mt-1 h-3.5 w-3.5 shrink-0 text-emerald-600" /> {feature}
                        </p>
                      ))}
                    </div>
                  ) : <p className="text-xs font-bold leading-6 text-slate-600">{isService ? 'خدمة مهنية قابلة للمتابعة من داخل المنصة.' : 'برنامج مهني مصمم وفق خطة أكاديمية ومخرجات تعلم قابلة للقياس.'}</p>}
                </section>
              </div>
            </TabsContent>

            {!isService && academicProfile && (
              <TabsContent value="academic" className="mt-0 space-y-5">
                <section className="rounded-3xl border border-[#0f2b46]/10 bg-gradient-to-br from-white to-[#fffaf0] p-5 sm:p-6">
                  <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-xs font-black text-[#a8841a]">الملف الأكاديمي الرسمي</p>
                      <h2 className="mt-1 text-xl font-black leading-snug text-[#0f2b46]">{academicProfile.academicTitle}</h2>
                      <p className="mt-2 text-sm leading-7 text-slate-600">{academicProfile.levelDescription}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-center text-xs font-black text-[#0f2b46] sm:min-w-[260px]">
                      <div className="rounded-2xl border border-[#c9a227]/35 bg-white p-3">
                        <span className="block text-slate-500">المدة/المسار</span>
                        <span className="mt-1 block text-[#a8841a]">{academicProfile.durationLabel}</span>
                      </div>
                      <div className="rounded-2xl border border-[#c9a227]/35 bg-white p-3">
                        <span className="block text-slate-500">الساعات</span>
                        <span className="mt-1 block text-[#a8841a]">{academicProfile.creditHoursLabel}</span>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="rounded-2xl border border-[#0f2b46]/10 bg-white p-4">
                      <h3 className="mb-3 flex items-center gap-2 font-black text-[#0f2b46]"><GraduationCap className="h-5 w-5 text-[#a8841a]" /> مخرجات التعلم</h3>
                      <ul className="space-y-2 text-sm leading-7 text-slate-600">
                        {academicProfile.learningOutcomes.map((item: string, i: number) => (
                          <li key={String(i)} className="flex gap-2"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-emerald-600" /><span>{item}</span></li>
                        ))}
                      </ul>
                    </div>

                    <div className="rounded-2xl border border-[#0f2b46]/10 bg-white p-4">
                      <h3 className="mb-3 flex items-center gap-2 font-black text-[#0f2b46]"><Briefcase className="h-5 w-5 text-[#a8841a]" /> المهارات المهنية المكتسبة</h3>
                      <div className="flex flex-wrap gap-2">
                        {academicProfile.skills.map((skill: string, i: number) => (
                          <span key={String(i)} className="rounded-full bg-[#faf6ea] px-3 py-1.5 text-xs font-black text-[#0f2b46] ring-1 ring-[#c9a227]/25">{skill}</span>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl border border-[#0f2b46]/10 bg-white p-4">
                    <h3 className="mb-3 flex items-center gap-2 font-black text-[#0f2b46]"><BookOpen className="h-5 w-5 text-[#a8841a]" /> الخطة الدراسية المعتمدة</h3>
                    <div className="grid gap-3 md:grid-cols-3">
                      {academicProfile.studyPlan.map((stage: any, i: number) => (
                        <div key={stage.title || String(i)} className="rounded-2xl bg-[#f8fafc] p-4 ring-1 ring-slate-100">
                          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#0f2b46] text-xs font-black text-[#e0b83a]">{i + 1}</span>
                          <h4 className="mt-3 font-black text-[#0f2b46]">{stage.title}</h4>
                          <p className="mt-2 text-xs leading-6 text-slate-600">{stage.description}</p>
                          <p className="mt-2 rounded-xl bg-white p-2 text-xs font-bold leading-6 text-[#a8841a]">المخرج: {stage.deliverable}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {(academicProfile.finalEvaluationFormula?.length || 0) > 0 && (
                    <div className="mt-4 rounded-2xl border border-[#0f2b46]/10 bg-white p-4">
                      <h3 className="mb-3 font-black text-[#0f2b46]">توزيع الدرجة النهائية</h3>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                        {academicProfile.finalEvaluationFormula.map((item: any, i: number) => (
                          <div key={item.label || String(i)} className="rounded-xl bg-[#f8fafc] p-3 ring-1 ring-slate-100">
                            <div className="mb-1 flex items-center justify-between gap-2">
                              <p className="text-xs font-black text-[#0f2b46]">{item.label}</p>
                              <span className="rounded-full bg-[#c9a227] px-2 py-0.5 text-[10px] font-black text-[#0f2b46]">{item.weight}%</span>
                            </div>
                            <p className="text-[11px] font-bold leading-5 text-slate-600">{item.description}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </section>
              </TabsContent>
            )}

            {!isService && (
              <TabsContent value="content" className="mt-0 space-y-5">
                <section className="rounded-3xl border border-[#0f2b46]/10 bg-white p-5 shadow-sm">
                  <h2 className="mb-3 flex items-center gap-2 text-lg font-black text-[#0f2b46]"><BookOpen className="h-5 w-5 text-[#a8841a]" /> أدلة الدراسة المتاحة</h2>
                  {(program.studyGuides?.length || 0) > 0 ? (
                    <div className="grid gap-3 md:grid-cols-3">
                      {program.studyGuides!.map((guide, i) => (
                        <div key={guide.id || String(i)} className="rounded-2xl bg-[#f8fafc] p-4 ring-1 ring-slate-100">
                          <Badge className="mb-2 bg-[#f7edd0] text-[10px] font-black text-[#0f2b46] hover:bg-[#f7edd0]">{semesterLabel(guide.semester)}</Badge>
                          <h3 className="text-sm font-black leading-6 text-[#0f2b46]">{guide.title}</h3>
                          {guide.overview && <p className="mt-1 line-clamp-4 text-xs font-bold leading-6 text-slate-600">{guide.overview}</p>}
                        </div>
                      ))}
                    </div>
                  ) : <EmptyBox text="لا توجد أدلة دراسة منشورة بعد. تظهر كاملة في بوابة الطالب بعد التسجيل." />}
                </section>

                <div className="grid gap-5 lg:grid-cols-2">
                  <section className="rounded-3xl border border-[#0f2b46]/10 bg-white p-5 shadow-sm">
                    <h2 className="mb-3 flex items-center gap-2 text-lg font-black text-[#0f2b46]"><BookMarked className="h-5 w-5 text-[#a8841a]" /> الكتب المقررة</h2>
                    {(program.books?.length || 0) > 0 ? (
                      <div className="space-y-2">
                        {program.books!.map((book, i) => (
                          <div key={book.id || book.title || String(i)} className="rounded-2xl bg-slate-50 p-3 text-xs font-bold leading-6 text-slate-600">
                            <p className="font-black text-[#0f2b46]">{book.title}</p>
                            {book.titleEn && <p className="text-[#a8841a]">{book.titleEn}</p>}
                            <p className="text-slate-400">{semesterLabel(book.semester)} {book.source ? '— ' + book.source : ''}</p>
                          </div>
                        ))}
                      </div>
                    ) : <EmptyBox text="تضيف الإدارة الكتب المقررة وملفاتها قبل بدء الدراسة أو أثناء بناء المنهج." />}
                  </section>

                  <section className="rounded-3xl border border-[#0f2b46]/10 bg-white p-5 shadow-sm">
                    <h2 className="mb-3 flex items-center gap-2 text-lg font-black text-[#0f2b46]"><Layers className="h-5 w-5 text-[#a8841a]" /> الوحدات والمحاور</h2>
                    {(program.units?.length || 0) > 0 ? (
                      <div className="space-y-2">
                        {program.units!.map((unit, i) => (
                          <div key={unit.id || unit.title || String(i)} className="flex items-center gap-3 rounded-2xl bg-slate-50 p-3 text-xs font-bold text-slate-600">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#0f2b46] font-black text-[#e0b83a]">{unit.order || i + 1}</span>
                            <p className="font-black text-[#0f2b46]">{unit.title}</p>
                          </div>
                        ))}
                      </div>
                    ) : <EmptyBox text="لا توجد وحدات منشورة حالياً لهذا البرنامج." />}
                  </section>
                </div>

                <div className="grid gap-5 lg:grid-cols-2">
                  <section className="rounded-3xl border border-[#0f2b46]/10 bg-white p-5 shadow-sm">
                    <h2 className="mb-3 flex items-center gap-2 text-lg font-black text-[#0f2b46]"><FileCheck2 className="h-5 w-5 text-[#a8841a]" /> الواجبات والتكليفات</h2>
                    {(program.assignments?.length || 0) > 0 ? (
                      <div className="space-y-2">
                        {program.assignments!.map((a, i) => (
                          <div key={a.id || a.title || String(i)} className="rounded-2xl bg-[#fffaf0] p-3 text-xs font-bold leading-6 text-slate-600">
                            <p className="font-black text-[#0f2b46]">{a.title}</p>
                            <p>{semesterLabel(a.semester)} — {a.points || 0} نقطة — {a.status === 'PUBLISHED' ? 'منشور' : 'قيد الإعداد'}</p>
                          </div>
                        ))}
                      </div>
                    ) : <EmptyBox text="لا توجد واجبات منشورة حالياً." />}
                  </section>

                  <section className="rounded-3xl border border-[#0f2b46]/10 bg-white p-5 shadow-sm">
                    <h2 className="mb-3 flex items-center gap-2 text-lg font-black text-[#0f2b46]"><ClipboardList className="h-5 w-5 text-[#a8841a]" /> الامتحانات</h2>
                    {(program.exams?.length || 0) > 0 ? (
                      <div className="space-y-2">
                        {program.exams!.map((exam, i) => (
                          <div key={exam.id || exam.title || String(i)} className="rounded-2xl bg-[#0f2b46] p-3 text-xs font-bold leading-6 text-[#f5f0e1]">
                            <p className="font-black text-[#e0b83a]">{exam.title}</p>
                            <p>{semesterLabel(exam.semester)} — {exam.questionCount || 0} سؤال — {exam.status === 'PUBLISHED' ? 'منشور' : 'قيد المراجعة'}</p>
                          </div>
                        ))}
                      </div>
                    ) : <EmptyBox text="لا توجد امتحانات منشورة حالياً لهذا البرنامج." />}
                  </section>
                </div>
              </TabsContent>
            )}

            <TabsContent value="admission" className="mt-0 space-y-5">
              <section className="rounded-3xl border border-[#0f2b46]/10 bg-[#faf6ea] p-5">
                <h2 className="mb-3 flex items-center gap-2 text-lg font-black text-[#0f2b46]"><ShieldCheck className="h-5 w-5 text-[#a8841a]" /> {isService ? 'مسار طلب الخدمة' : 'مسار الالتحاق'}</h2>
                <ol className="grid gap-3 text-xs font-bold leading-relaxed text-slate-600 md:grid-cols-5">
                  {requestSteps.map((step, i) => (
                    <li key={step} className="rounded-2xl bg-white p-3 ring-1 ring-[#c9a227]/20">
                      <span className="mb-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-[#0f2b46] text-xs font-black text-[#e0b83a]">{i + 1}</span>
                      <p>{step}</p>
                    </li>
                  ))}
                </ol>
              </section>

              <section className="rounded-3xl border border-[#c9a227]/35 bg-white p-5">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="rounded-2xl bg-[#fffaf0] p-4">
                    <p className="text-xs font-bold text-slate-500">النوع</p>
                    <p className="mt-1 font-black text-[#0f2b46]">{categoryLabel}</p>
                  </div>
                  <div className="rounded-2xl bg-[#fffaf0] p-4">
                    <p className="text-xs font-bold text-slate-500">الرسوم</p>
                    <p className="mt-1 font-black text-[#0f2b46]">{moneyLabel(program.price, isService)}</p>
                  </div>
                  <div className="rounded-2xl bg-[#fffaf0] p-4">
                    <p className="text-xs font-bold text-slate-500">الحالة</p>
                    <p className="mt-1 font-black text-[#0f2b46]">{program.enrolled && !isService ? 'أنت مسجل في البرنامج' : isService ? 'متاح لطلب الخدمة' : 'متاح لتقديم طلب التحاق'}</p>
                  </div>
                </div>
                <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                  <Button onClick={startAdmission} className="flex-1 bg-[#c9a227] py-6 text-base font-black text-[#0f2b46] hover:bg-[#e0b83a]">
                    {program.enrolled && !isService ? 'الدخول إلى البرنامج' : isService ? 'طلب هذه الخدمة' : 'قدّم طلب الالتحاق بهذا البرنامج'}
                    <ChevronLeft className="mr-1 h-5 w-5" />
                  </Button>
                  <Button variant="outline" onClick={() => navigate('programs')} className="flex-1 border-[#0f2b46]/20 py-6 text-base font-black text-[#0f2b46] hover:bg-[#0f2b46]/5">
                    استعراض الخدمات والبرامج
                  </Button>
                </div>
              </section>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
