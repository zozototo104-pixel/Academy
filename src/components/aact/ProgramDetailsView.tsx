'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useAppStore, api } from '@/lib/store'
import { buildAcademicProgramProfile } from '@/lib/program-tracks'
import { getServiceFlow } from '@/lib/service-flows'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
  return (
    <div className="rounded-[1.6rem] border border-white/10 bg-white/[0.05] p-6 text-center text-xs font-bold leading-6 text-white/60">
      {text}
    </div>
  )
}

function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="rounded-[1.6rem] border border-white/10 bg-white/[0.06] p-5 shadow-xl shadow-black/10 backdrop-blur">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-[#b08a38]/35 bg-[#b08a38]/10 text-[#d2ad5a]">
        <Icon className="h-6 w-6" />
      </span>
      <p className="text-xs font-black text-white/52">{label}</p>
      <p className="mt-1 text-lg font-black text-white">{value}</p>
    </div>
  )
}

function DetailSection({ title, icon: Icon, children, accent = false }: { title: string; icon: any; children: ReactNode; accent?: boolean }) {
  return (
    <section className={`rounded-[1.8rem] border p-5 shadow-2xl shadow-black/10 backdrop-blur ${accent ? 'border-[#b08a38]/35 bg-[#b08a38]/10' : 'border-white/10 bg-white/[0.055]'}`}>
      <h2 className="mb-4 flex items-center gap-2 text-lg font-black text-white">
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[#b08a38]/35 bg-[#b08a38]/10 text-[#d2ad5a]">
          <Icon className="h-5 w-5" />
        </span>
        {title}
      </h2>
      {children}
    </section>
  )
}

export function ProgramDetailsView() {
  const { programDetailsId, user, navigate, openApply, openProgram } = useAppStore()
  const [programs, setPrograms] = useState<Program[]>(() => readCachedPrograms())
  const [loading, setLoading] = useState(true)
  const { toast } = useToast()

  useEffect(() => {
    let alive = true
    const cached = readCachedPrograms()
    const cachedMatch = cached.some((p) => p.id === programDetailsId || p.slug === programDetailsId)

    if (cached.length) {
      setPrograms(cached)
      if (cachedMatch) setLoading(false)
    }

    if (!programDetailsId) {
      setLoading(false)
      return () => { alive = false }
    }

    const detailUrl = `/api/programs?detail=${encodeURIComponent(programDetailsId)}${user ? '' : '&public=1'}`
    api<{ program?: Program | null; programs?: Program[] }>(detailUrl)
      .then((d) => {
        if (!alive) return
        const detail = d.program || d.programs?.[0]
        if (!detail) return
        setPrograms((prev) => {
          const base = prev.length ? prev : cached
          const exists = base.some((p) => p.id === detail.id || p.slug === detail.slug || p.id === programDetailsId || p.slug === programDetailsId)
          const next = exists
            ? base.map((p) => (p.id === detail.id || p.slug === detail.slug || p.id === programDetailsId || p.slug === programDetailsId ? { ...p, ...detail } : p))
            : [detail, ...base]
          cachePrograms(next)
          return next
        })
      })
      .catch(() => {
        if (!alive || cachedMatch) return
        toast({ title: 'خطأ', description: 'تعذر تحميل تفاصيل البرنامج أو الخدمة', variant: 'destructive' })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })

    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programDetailsId])

  useEffect(() => {
    if (!programDetailsId && !loading) navigate('programs')
  }, [programDetailsId, loading, navigate])

  const program = programs.find((p) => p.id === programDetailsId || p.slug === programDetailsId)
  const flow = getServiceFlow(program?.slug)
  const isService = flow ? !flow.isStudyProgram : program?.category === 'SERVICE'
  const Icon = program ? (ICONS[program.icon] || GraduationCap) : GraduationCap
  const academicProfile = program && !isService ? buildAcademicProgramProfile(program) : null
  const displayTitle = flow?.title || program?.titleAr || ''
  const displayDescription = flow?.summary || program?.description || ''
  const displayFeatures = flow?.highlights?.length ? flow.highlights : (program?.features || [])
  const displayPrimaryAction = flow?.primaryAction || (isService ? 'طلب هذه الخدمة' : 'قدّم طلب الالتحاق بهذا البرنامج')

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
      <div className="min-h-[calc(100vh-5rem)] bg-[#0b1428] px-4 py-16 text-white">
        <div className="mx-auto flex min-h-[52vh] max-w-5xl items-center justify-center rounded-[2rem] border border-white/10 bg-white/[0.04]">
          <div className="text-center">
            <Loader2 className="mx-auto h-10 w-10 animate-spin text-[#d2ad5a]" />
            <p className="mt-4 text-xs font-black tracking-[0.25em] text-white/50">جاري فتح التفاصيل</p>
          </div>
        </div>
      </div>
    )
  }

  if (!program) {
    return (
      <div className="aact-fade-in min-h-[calc(100vh-5rem)] bg-[#0b1428] px-4 py-14 text-center text-white">
        <div className="mx-auto max-w-3xl rounded-[2rem] border border-white/10 bg-white/[0.06] p-8 shadow-2xl shadow-black/20">
          <FileText className="mx-auto mb-3 h-12 w-12 text-[#d2ad5a]" />
          <h1 className="text-xl font-black">لم يتم العثور على العنصر المحدد</h1>
          <p className="mt-2 text-sm leading-7 text-white/60">قد يكون البرنامج أو الخدمة حُذف أو تغيّر معرّفه. ارجع إلى القائمة واختره من جديد.</p>
          <Button onClick={() => navigate('programs')} className="mt-5 rounded-full bg-[#bf1646] px-6 font-black text-white hover:bg-[#a61139]">
            العودة إلى الخدمات والبرامج
          </Button>
        </div>
      </div>
    )
  }

  const categoryLabel = flow?.kicker || CATEGORY_LABEL[program.category] || 'برنامج تدريبي'
  const requestSteps = flow?.steps?.length
    ? flow.steps
    : isService
      ? ['إنشاء حساب أو تسجيل الدخول', 'تعبئة طلب الخدمة وتحديد الاحتياج', 'إرفاق الوثائق أو الملفات المطلوبة', 'مراجعة الإدارة وتحديد الإجراء المناسب', 'إشعار المتقدم بالرسوم أو الموعد أو النتيجة']
      : ['إنشاء حساب أو تسجيل الدخول', 'تعبئة طلب الالتحاق ورفع الوثائق', 'سداد رسوم التقديم وحجز المقعد', 'مراجعة الإدارة واعتماد الطلب', 'بدء الدراسة بعد القبول وسداد الرسوم']

  return (
    <div className="aact-fade-in relative min-h-screen overflow-hidden bg-[#0b1428] text-white">
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_82%_8%,rgba(191,22,70,0.23),transparent_28rem),radial-gradient(circle_at_8%_38%,rgba(176,138,56,0.16),transparent_25rem),linear-gradient(180deg,#111b33_0%,#0b1428_56%,#1d2947_100%)]" />
        <div className="absolute inset-0 opacity-[0.055] [background-image:linear-gradient(to_right,#ffffff_1px,transparent_1px),linear-gradient(to_bottom,#ffffff_1px,transparent_1px)] [background-size:72px_72px]" />
      </div>

      <section className="relative border-b border-white/10 px-4 py-9 sm:py-12">
        <div className="mx-auto max-w-6xl">
          <button
            onClick={() => navigate('programs')}
            className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.06] px-4 py-2 text-xs font-black text-white/78 backdrop-blur transition hover:bg-white/10 hover:text-white"
          >
            <ArrowRight className="h-4 w-4" />
            العودة إلى كل الخدمات والبرامج
          </button>

          <div className="grid items-center gap-8 lg:grid-cols-[1.25fr_0.75fr]">
            <div className="text-center lg:text-right">
              <Badge className="mb-5 rounded-full border border-[#b08a38]/45 bg-[#b08a38]/10 px-5 py-2 text-sm font-black text-[#d2ad5a] hover:bg-[#b08a38]/10">
                <Icon className="ml-2 h-4 w-4" />
                {flow?.kicker || (isService ? categoryLabel : 'التعليم العالي المهني المعتمد')}
              </Badge>
              <h1 className="text-4xl font-black leading-[1.25] text-white sm:text-5xl lg:text-6xl">
                {program.titleAr}
              </h1>
              {program.titleEn && <p className="mt-3 text-sm font-black tracking-[0.18em] text-[#d2ad5a]/85">{program.titleEn}</p>}
              <p className="mx-auto mt-5 max-w-3xl text-base font-bold leading-9 text-white/64 lg:mx-0">
                {program.description}
              </p>
              <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row lg:justify-start">
                <Button onClick={startAdmission} className="rounded-[1.35rem] bg-[#a98a52] px-8 py-6 text-base font-black text-white shadow-xl shadow-black/20 hover:bg-[#b7975d]">
                  {program.enrolled && !isService ? 'الدخول إلى البرنامج' : isService ? 'اطلب الخدمة الآن' : 'قدّم طلب الانضمام الآن'}
                  <ChevronLeft className="mr-2 h-5 w-5" />
                </Button>
                <Button variant="outline" onClick={() => navigate('contact')} className="rounded-[1.35rem] border-white/15 bg-white/[0.03] px-8 py-6 text-base font-black text-white hover:bg-white/10 hover:text-white">
                  <MessagesSquare className="ml-2 h-5 w-5 text-[#d2ad5a]" />
                  استشارة أكاديمية مجانية
                </Button>
              </div>
            </div>

            <div className="mx-auto w-full max-w-sm rounded-[2rem] border border-white/10 bg-white/[0.055] p-6 text-center shadow-2xl shadow-black/20 backdrop-blur lg:ml-0">
              <span className="mx-auto flex h-24 w-24 items-center justify-center rounded-[1.7rem] border border-[#b08a38]/35 bg-[#b08a38]/10 text-[#d2ad5a]">
                <Icon className="h-12 w-12" />
              </span>
              <p className="mt-5 text-sm font-black text-[#d2ad5a]">{categoryLabel}</p>
              <p className="mt-2 text-2xl font-black text-white">{moneyLabel(program.price, isService)}</p>
              <p className="mt-3 text-xs font-bold leading-6 text-white/50">
                {program.enrolled && !isService ? 'أنت مسجل في البرنامج' : isService ? 'الخدمة متاحة للطلب والمتابعة من الإدارة' : 'البرنامج متاح لتقديم طلب التحاق'}
              </p>
            </div>
          </div>

          <div className="mt-8 grid gap-4 md:grid-cols-3">
            <StatCard icon={Clock3} label={isService ? 'مدة الخدمة' : 'الساعات التدريبية'} value={program.hours ? String(program.hours) + ' ساعة' : isService ? 'حسب طبيعة الطلب' : 'حسب مسار البرنامج'} />
            <StatCard icon={BadgeCheck} label="الرسوم" value={moneyLabel(program.price, isService)} />
            <StatCard icon={Users2} label={isService ? 'المتابعة' : 'المحتوى'} value={program.unitsCount > 0 ? String(program.unitsCount) + ' وحدات' : isService ? 'طلب خدمة ومتابعة' : 'اعتماد مباشر'} />
          </div>
        </div>
      </section>

      <main className="relative mx-auto max-w-6xl px-4 py-8">
        <Tabs defaultValue="overview" dir="rtl" className="space-y-6">
          <div className="sticky top-[5.25rem] z-20 rounded-[1.4rem] border border-white/10 bg-[#111b33]/92 p-2 shadow-2xl shadow-black/20 backdrop-blur">
            <TabsList className="flex h-auto w-full flex-wrap gap-2 bg-transparent p-0">
              <TabsTrigger value="overview" className="rounded-full px-4 py-2 text-[11px] font-black text-white/70 data-[state=active]:bg-[#bf1646] data-[state=active]:text-white sm:text-xs"><ClipboardList className="ml-1 h-3.5 w-3.5" /> {isService ? 'نبذة الخدمة' : 'نبذة البرنامج'}</TabsTrigger>
              {!isService && <TabsTrigger value="academic" className="rounded-full px-4 py-2 text-[11px] font-black text-white/70 data-[state=active]:bg-[#bf1646] data-[state=active]:text-white sm:text-xs"><Landmark className="ml-1 h-3.5 w-3.5" /> النظام الأكاديمي</TabsTrigger>}
              {!isService && <TabsTrigger value="content" className="rounded-full px-4 py-2 text-[11px] font-black text-white/70 data-[state=active]:bg-[#bf1646] data-[state=active]:text-white sm:text-xs"><BookMarked className="ml-1 h-3.5 w-3.5" /> المحتوى والكتب</TabsTrigger>}
              <TabsTrigger value="admission" className="rounded-full px-4 py-2 text-[11px] font-black text-white/70 data-[state=active]:bg-[#bf1646] data-[state=active]:text-white sm:text-xs"><ShieldCheck className="ml-1 h-3.5 w-3.5" /> {isService ? 'طلب الخدمة' : 'الالتحاق والرسوم'}</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="mt-0 space-y-5">
            {academicProfile && (
              <DetailSection title="الملف الأكاديمي الرسمي للبرنامج" icon={School} accent>
                <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
                  <div>
                    <h2 className="text-2xl font-black leading-snug text-white">{academicProfile.academicTitle}</h2>
                    <p className="mt-3 text-sm font-bold leading-8 text-white/62">{academicProfile.levelDescription}</p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-center text-xs font-black">
                    <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-4">
                      <p className="text-white/45">الدرجة</p>
                      <p className="mt-1 text-[#d2ad5a]">{academicProfile.degreeLabel}</p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-4">
                      <p className="text-white/45">التخصص</p>
                      <p className="mt-1 text-[#d2ad5a]">{academicProfile.specialization}</p>
                    </div>
                  </div>
                </div>
              </DetailSection>
            )}

            <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
              <DetailSection title={isService ? 'تفاصيل الخدمة' : 'تفاصيل البرنامج'} icon={ClipboardList}>
                <p className="text-sm font-bold leading-9 text-white/64">{program.description}</p>
              </DetailSection>

              <DetailSection title={isService ? 'مكونات وفوائد الخدمة' : 'لماذا هذا البرنامج؟'} icon={CheckCircle2}>
                {(program.features || []).length ? (
                  <div className="space-y-2">
                    {program.features.slice(0, 8).map((feature, i) => (
                      <p key={String(i)} className="flex gap-2 text-xs font-bold leading-7 text-white/62">
                        <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-[#d2ad5a]" /> {feature}
                      </p>
                    ))}
                  </div>
                ) : <p className="text-xs font-bold leading-6 text-white/60">{isService ? 'خدمة مهنية قابلة للمتابعة من داخل المنصة.' : 'برنامج مهني مصمم وفق خطة أكاديمية ومخرجات تعلم قابلة للقياس.'}</p>}
              </DetailSection>
            </div>
          </TabsContent>

          {!isService && academicProfile && (
            <TabsContent value="academic" className="mt-0 space-y-5">
              <DetailSection title="النظام الأكاديمي ومخرجات التعلم" icon={GraduationCap} accent>
                <div className="mb-5 grid gap-3 text-center text-xs font-black sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-4"><span className="block text-white/45">الدرجة</span><span className="mt-1 block text-[#d2ad5a]">{academicProfile.degreeLabel}</span></div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-4"><span className="block text-white/45">التخصص</span><span className="mt-1 block text-[#d2ad5a]">{academicProfile.specialization}</span></div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-4"><span className="block text-white/45">المدة/المسار</span><span className="mt-1 block text-[#d2ad5a]">{academicProfile.durationLabel}</span></div>
                  <div className="rounded-2xl border border-white/10 bg-white/[0.06] p-4"><span className="block text-white/45">الساعات</span><span className="mt-1 block text-[#d2ad5a]">{academicProfile.creditHoursLabel}</span></div>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-[1.5rem] border border-white/10 bg-[#0b1428]/55 p-4">
                    <h3 className="mb-3 flex items-center gap-2 font-black text-white"><GraduationCap className="h-5 w-5 text-[#d2ad5a]" /> مخرجات التعلم</h3>
                    <ul className="space-y-2 text-sm font-bold leading-7 text-white/62">
                      {(academicProfile.learningOutcomes || []).map((item: string, i: number) => (
                        <li key={String(i)} className="flex gap-2"><CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-[#d2ad5a]" /><span>{item}</span></li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-[1.5rem] border border-white/10 bg-[#0b1428]/55 p-4">
                    <h3 className="mb-3 flex items-center gap-2 font-black text-white"><Briefcase className="h-5 w-5 text-[#d2ad5a]" /> المهارات المهنية المكتسبة</h3>
                    <div className="flex flex-wrap gap-2">
                      {(academicProfile.skills || []).map((skill: string, i: number) => (
                        <span key={String(i)} className="rounded-full border border-[#b08a38]/25 bg-[#b08a38]/10 px-3 py-1.5 text-xs font-black text-[#d2ad5a]">{skill}</span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-4 rounded-[1.5rem] border border-white/10 bg-[#0b1428]/55 p-4">
                  <h3 className="mb-3 flex items-center gap-2 font-black text-white"><BookOpen className="h-5 w-5 text-[#d2ad5a]" /> الخطة الدراسية المعتمدة</h3>
                  <div className="grid gap-3 md:grid-cols-3">
                    {(academicProfile.studyPlan || []).map((stage: any, i: number) => (
                      <div key={stage.title || String(i)} className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                        <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#bf1646] text-xs font-black text-white">{i + 1}</span>
                        <h4 className="mt-3 font-black text-white">{stage.title}</h4>
                        <p className="mt-2 text-xs font-bold leading-6 text-white/58">{stage.description}</p>
                        <p className="mt-2 rounded-xl border border-[#b08a38]/20 bg-[#b08a38]/10 p-2 text-xs font-bold leading-6 text-[#d2ad5a]">المخرج: {stage.deliverable}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {(academicProfile.finalEvaluationFormula?.length || 0) > 0 && (
                  <div className="mt-4 rounded-[1.5rem] border border-white/10 bg-[#0b1428]/55 p-4">
                    <h3 className="mb-3 font-black text-white">توزيع الدرجة النهائية</h3>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      {academicProfile.finalEvaluationFormula.map((item: any, i: number) => (
                        <div key={item.label || String(i)} className="rounded-2xl border border-white/10 bg-white/[0.045] p-3">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <p className="text-xs font-black text-white">{item.label}</p>
                            <span className="rounded-full bg-[#b08a38] px-2 py-0.5 text-[10px] font-black text-white">{item.weight}%</span>
                          </div>
                          <p className="text-[11px] font-bold leading-5 text-white/58">{item.description}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </DetailSection>
            </TabsContent>
          )}

          {!isService && (
            <TabsContent value="content" className="mt-0 space-y-5">
              <DetailSection title="أدلة الدراسة المتاحة" icon={BookOpen}>
                {(program.studyGuides?.length || 0) > 0 ? (
                  <div className="grid gap-3 md:grid-cols-3">
                    {program.studyGuides!.map((guide, i) => (
                      <div key={guide.id || String(i)} className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                        <Badge className="mb-2 rounded-full bg-[#b08a38]/20 text-[10px] font-black text-[#d2ad5a] hover:bg-[#b08a38]/20">{semesterLabel(guide.semester)}</Badge>
                        <h3 className="text-sm font-black leading-6 text-white">{guide.title}</h3>
                        {guide.overview && <p className="mt-1 line-clamp-4 text-xs font-bold leading-6 text-white/58">{guide.overview}</p>}
                      </div>
                    ))}
                  </div>
                ) : <EmptyBox text="لا توجد أدلة دراسة منشورة بعد. تظهر كاملة في بوابة الطالب بعد التسجيل." />}
              </DetailSection>

              <div className="grid gap-5 lg:grid-cols-2">
                <DetailSection title="الكتب المقررة" icon={BookMarked}>
                  {(program.books?.length || 0) > 0 ? (
                    <div className="space-y-2">
                      {program.books!.map((book, i) => (
                        <div key={book.id || book.title || String(i)} className="rounded-2xl border border-white/10 bg-white/[0.045] p-3 text-xs font-bold leading-6 text-white/58">
                          <p className="font-black text-white">{book.title}</p>
                          {book.titleEn && <p className="text-[#d2ad5a]">{book.titleEn}</p>}
                          <p className="text-white/38">{semesterLabel(book.semester)} {book.source ? '— ' + book.source : ''}</p>
                        </div>
                      ))}
                    </div>
                  ) : <EmptyBox text="تضيف الإدارة الكتب المقررة وملفاتها قبل بدء الدراسة أو أثناء بناء المنهج." />}
                </DetailSection>

                <DetailSection title="الوحدات والمحاور" icon={Layers}>
                  {(program.units?.length || 0) > 0 ? (
                    <div className="space-y-2">
                      {program.units!.map((unit, i) => (
                        <div key={unit.id || unit.title || String(i)} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.045] p-3 text-xs font-bold text-white/62">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#bf1646] font-black text-white">{unit.order || i + 1}</span>
                          <p className="font-black text-white">{unit.title}</p>
                        </div>
                      ))}
                    </div>
                  ) : <EmptyBox text="لا توجد وحدات منشورة حالياً لهذا البرنامج." />}
                </DetailSection>
              </div>

              <div className="grid gap-5 lg:grid-cols-2">
                <DetailSection title="الواجبات والتكليفات" icon={FileCheck2}>
                  {(program.assignments?.length || 0) > 0 ? (
                    <div className="space-y-2">
                      {program.assignments!.map((a, i) => (
                        <div key={a.id || a.title || String(i)} className="rounded-2xl border border-[#b08a38]/22 bg-[#b08a38]/10 p-3 text-xs font-bold leading-6 text-white/62">
                          <p className="font-black text-white">{a.title}</p>
                          <p>{semesterLabel(a.semester)} — {a.points || 0} نقطة — {a.status === 'PUBLISHED' ? 'منشور' : 'قيد الإعداد'}</p>
                        </div>
                      ))}
                    </div>
                  ) : <EmptyBox text="لا توجد واجبات منشورة حالياً." />}
                </DetailSection>

                <DetailSection title="الامتحانات" icon={ClipboardList}>
                  {(program.exams?.length || 0) > 0 ? (
                    <div className="space-y-2">
                      {program.exams!.map((exam, i) => (
                        <div key={exam.id || exam.title || String(i)} className="rounded-2xl border border-white/10 bg-[#bf1646]/20 p-3 text-xs font-bold leading-6 text-white/70">
                          <p className="font-black text-white">{exam.title}</p>
                          <p>{semesterLabel(exam.semester)} — {exam.questionCount || 0} سؤال — {exam.status === 'PUBLISHED' ? 'منشور' : 'قيد المراجعة'}</p>
                        </div>
                      ))}
                    </div>
                  ) : <EmptyBox text="لا توجد امتحانات منشورة حالياً لهذا البرنامج." />}
                </DetailSection>
              </div>
            </TabsContent>
          )}

          <TabsContent value="admission" className="mt-0 space-y-5">
            <DetailSection title={isService ? 'مسار طلب الخدمة' : 'مسار الالتحاق'} icon={ShieldCheck} accent>
              <ol className="grid gap-3 text-xs font-bold leading-relaxed text-white/62 md:grid-cols-5">
                {requestSteps.map((step, i) => (
                  <li key={step} className="rounded-2xl border border-white/10 bg-[#0b1428]/55 p-3">
                    <span className="mb-2 inline-flex h-8 w-8 items-center justify-center rounded-full bg-[#bf1646] text-xs font-black text-white">{i + 1}</span>
                    <p>{step}</p>
                  </li>
                ))}
              </ol>
            </DetailSection>

            <DetailSection title="معلومات الطلب" icon={ClipboardList}>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                  <p className="text-xs font-bold text-white/45">النوع</p>
                  <p className="mt-1 font-black text-white">{categoryLabel}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                  <p className="text-xs font-bold text-white/45">الرسوم</p>
                  <p className="mt-1 font-black text-white">{moneyLabel(program.price, isService)}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                  <p className="text-xs font-bold text-white/45">الحالة</p>
                  <p className="mt-1 font-black text-white">{program.enrolled && !isService ? 'أنت مسجل في البرنامج' : isService ? 'متاح لطلب الخدمة' : 'متاح لتقديم طلب التحاق'}</p>
                </div>
              </div>
              <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                <Button onClick={startAdmission} className="flex-1 rounded-[1.35rem] bg-[#a98a52] py-6 text-base font-black text-white shadow-xl shadow-black/20 hover:bg-[#b7975d]">
                  {program.enrolled && !isService ? 'الدخول إلى البرنامج' : isService ? 'طلب هذه الخدمة' : 'قدّم طلب الالتحاق بهذا البرنامج'}
                  <ChevronLeft className="mr-1 h-5 w-5" />
                </Button>
                <Button variant="outline" onClick={() => navigate('programs')} className="flex-1 rounded-[1.35rem] border-white/15 bg-white/[0.03] py-6 text-base font-black text-white hover:bg-white/10 hover:text-white">
                  استعراض الخدمات والبرامج
                </Button>
              </div>
            </DetailSection>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
