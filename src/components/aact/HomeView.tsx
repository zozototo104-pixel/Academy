'use client'

import { useAppStore, api } from '@/lib/store'
import { ADMISSION_FEES } from '@/lib/academyData'
import { AcademyLogo } from '@/components/aact/Shell'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  GraduationCap, Award, Briefcase, ShieldCheck, Building2, BookOpen,
  Bot, Mic, MicOff, FileCheck2, Globe2, Clock3, BadgeCheck, ChevronLeft, Sparkles,
  Banknote, ClipboardList, Users, Star, Quote, HelpCircle,
} from 'lucide-react'

interface ProgramLite {
  id: string
  slug: string
  titleAr: string
  titleEn?: string
  description: string
  category: string
  hours?: number | null
  price?: number | null
  icon: string
  unitsCount: number
  enrolled: boolean
}

const ICONS: Record<string, any> = {
  briefcase: Briefcase, award: Award, 'book-open': BookOpen,
  'shield-check': ShieldCheck, 'building-2': Building2, 'graduation-cap': GraduationCap,
}

const CATEGORY_LABEL: Record<string, string> = {
  DIPLOMA: 'دبلوم مهني',
  DOCTORATE: 'دكتوراه مهنية',
  MASTERS: 'ماجستير مهني',
  ACCREDITATION: 'اعتماد دولي',
  INTL_CERT: 'شهادة دولية',
}

// أبرز البرامج المميزة — الشريط المتحرك (الدكتوراة، الماجستير، الدبلومات، شهادات الاستشاريين)
const FEATURED_TICKER: { icon: any; t: string; hint: string; slug?: string }[] = [
  { icon: GraduationCap, t: 'الدكتوراه المهنية', hint: 'كافة التخصصات (باستثناء الطب)', slug: 'professional-doctorate' },
  { icon: GraduationCap, t: 'الماجستير المهني', hint: 'كافة التخصصات (باستثناء الطب)', slug: 'professional-masters' },
  { icon: BookOpen, t: 'الدبلومات المهنية', hint: '32 دبلوماً دولياً' },
  { icon: BadgeCheck, t: 'اعتماد المستشارين والمدربين', hint: 'اعتماد دولي', slug: 'accredit-consultants-trainers' },
  { icon: Briefcase, t: 'دبلوم مهارات الاستشاري المحترف', hint: 'الأكثر طلباً', slug: 'professional-consulting-skills' },
  { icon: Award, t: 'شهادة مدرب دولي معتمد (CIT)', hint: '', slug: 'cert-cit' },
  { icon: Bot, t: 'الشهادة الاحترافية في الذكاء الاصطناعي', hint: 'CPd-AI', slug: 'cert-cpd-ai' },
  { icon: Users, t: 'دبلوم إعداد مدربين (TOT)', hint: '', slug: 'dip-tot' },
]

/** عداد رقمي متحرك — يبدأ العد عند ظهوره في الشاشة (IntersectionObserver) */
function CountUp({ to, suffix = '', duration = 1400 }: { to: number; suffix?: string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [val, setVal] = useState(0)
  const started = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !started.current) {
          started.current = true
          const t0 = performance.now()
          const tick = (t: number) => {
            const p = Math.min(1, (t - t0) / duration)
            // easeOutCubic — بداية سريعة ثم تباطؤ ناعم
            setVal(Math.round(to * (1 - Math.pow(1 - p, 3))))
            if (p < 1) requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
          io.disconnect()
        }
      },
      { threshold: 0.4 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [to, duration])

  return <span ref={ref}>{val.toLocaleString('ar-EG')}{suffix}</span>
}

export function HomeView() {
  const { navigate, user, openProgramDetails } = useAppStore()
  const [programs, setPrograms] = useState<ProgramLite[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api<{ programs: ProgramLite[] }>('/api/programs')
      .then((d) => setPrograms(d.programs))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // حارس حركة الشريط المتحرك — يعالج تجمّده على بعض الأجهزة (آيفون/أندرويد):
  // بعض المتصفحات توقف حركات CSS مع إعداد «تقليل الحركة» أو اللمس العالق :hover.
  // إذا لم يتحرك المسار لمسافتين متتاليتين، نشغّل محركاً يدوياً بـ requestAnimationFrame
  // بنفس رياضيات الحركة الأصلية (36 ثانية لكل دورة، إزاحة حتى 50%) — نفس الشكل تماماً.
  const trackRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = trackRef.current
    if (!el) return
    let lastX = el.getBoundingClientRect().x
    let fails = 0
    let raf = 0
    let started = false
    const iv = setInterval(() => {
      if (started || document.visibilityState !== 'visible') return
      const x = el.getBoundingClientRect().x
      if (Math.abs(x - lastX) < 1) {
        if (++fails >= 2) {
          started = true
          clearInterval(iv)
          const DURATION = 36000
          let t0: number | null = null
          const step = (ts: number) => {
            if (t0 === null) t0 = ts
            const p = ((ts - t0) % DURATION) / DURATION
            el.style.transform = `translateX(${(p * 50).toFixed(4)}%)`
            raf = requestAnimationFrame(step)
          }
          raf = requestAnimationFrame(step)
        }
      } else {
        fails = 0
      }
      lastX = x
    }, 1500)
    return () => {
      clearInterval(iv)
      cancelAnimationFrame(raf)
    }
  }, [])

  const featured = programs.find((p) => p.slug === 'professional-consulting-skills')

  return (
    <div className="aact-fade-in">
      {/* بانر لوحة الإدارة — ظاهر ومباشر لمسؤولي الأكاديمية */}
      {user?.role === 'ADMIN' && (
        <div className="border-b-4 border-[#c9a227] bg-[#0f2b46]">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="rounded-xl bg-[#c9a227] p-2">
                <ShieldCheck className="h-5 w-5 text-[#0f2b46]" />
              </span>
              <div>
                <p className="text-sm font-black text-[#e0b83a]">أنت مسجّل بحساب إدارة الأكاديمية</p>
                <p className="text-[11px] text-[#f5f0e1]/70">اعتماد طلبات الالتحاق بتقييم خبير الذكاء الاصطناعي · الكتب والاختبارات · المالية والشهادات · قواعد القبول</p>
              </div>
            </div>
            <button
              onClick={() => navigate('admin')}
              className="rounded-lg bg-[#c9a227] px-5 py-2.5 text-sm font-black text-[#0f2b46] shadow hover:bg-[#e0b83a]"
            >
              فتح لوحة الإدارة ←
            </button>
          </div>
        </div>
      )}
      {/* شريط متحرك بأبرز البرامج المميزة — في أعلى الصفحة ليكون ظاهراً فوراً على كل الأجهزة */}
      <div className="aact-ticker relative z-20 border-y-2 border-[#c9a227]/60 bg-[#0f2b46]">
        <div className="mx-auto flex max-w-7xl items-stretch">
          <div className="z-10 flex shrink-0 items-center gap-1.5 border-l-2 border-[#0a1f36] bg-[#c9a227] px-3 py-2 text-[10px] font-black text-[#0f2b46] sm:px-4 sm:text-[11px]">
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span>أبرز البرامج المميزة</span>
          </div>
          <div className="relative flex-1 overflow-hidden">
            <div ref={trackRef} className="aact-marquee-track py-2">
              {[0, 1].map((copy) => (
                <div key={copy} className="flex shrink-0 items-center" aria-hidden={copy === 1}>
                  {FEATURED_TICKER.map((f, i) => (
                    <button
                      key={`${copy}-${i}`}
                      onClick={() => {
                        if (!user) return navigate('auth')
                        if (!f.slug) return navigate('programs')
                        const p = programs.find((x) => x.slug === f.slug)
                        p ? openProgram(p.id) : navigate('programs')
                      }}
                      className="group mx-1 flex shrink-0 items-center gap-1.5 rounded-full border border-[#c9a227]/25 bg-white/5 px-3.5 py-1.5 text-[10px] font-bold whitespace-nowrap text-[#f5f0e1] transition hover:border-[#c9a227] hover:bg-[#c9a227]/15 sm:text-[11px]"
                    >
                      <f.icon className="h-3.5 w-3.5 shrink-0 text-[#e0b83a] transition group-hover:scale-110" />
                      <span>{f.t}</span>
                      {f.hint && <span className="hidden text-[9px] font-black text-[#c9a227] sm:inline">· {f.hint}</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-[#0f2b46] to-transparent" />
            <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[#0f2b46] to-transparent" />
          </div>
        </div>
      </div>

      {/* Hero */}
      <section className="aact-hero text-[#f5f0e1]">
        <div className="relative mx-auto max-w-7xl px-4 py-14 sm:py-20">
          {/* الشعار الرسمي — بحلقة ذهبية على يسار العنوان (شاشات كبيرة) */}
          <div className="absolute left-4 top-1/2 hidden -translate-y-1/2 lg:block" aria-hidden="true">
            <div className="rounded-full bg-[#f5f0e1]/5 p-3 ring-1 ring-[#c9a227]/40">
              <AcademyLogo size={170} light />
            </div>
          </div>
          <div className="max-w-3xl">
            <Badge className="mb-4 border-[#c9a227]/50 bg-[#c9a227]/15 text-[#e0b83a] hover:bg-[#c9a227]/15">
              <Sparkles className="ml-1 h-3.5 w-3.5" />
              أكاديمية معتمدة دولياً منذ 2016
            </Badge>
            <h1 className="text-3xl font-black leading-[1.35] sm:text-4xl lg:text-5xl lg:leading-[1.3]">
              الأكاديمية الأمريكية
              <span className="aact-gold-text"> للاستشارات والتدريب</span>
            </h1>
            <p className="mt-3 text-base font-bold text-[#c9a227] sm:text-lg">
              بناء القيادات، صقل المهارات — Building Leaders, Refining Skills
            </p>
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[#f5f0e1]/85 sm:text-base">
              منصة تعليمية متكاملة تقدم الدبلومات المهنية والدكتوراه والماجستير المهني واعتماد
              المستشارين والمدربين ومراكز التدريب — ومع مشرف ذكاء اصطناعي يرافقك في رحلتك، يجيب على
              استفساراتك <strong className="text-[#e0b83a]">صوتاً وكتابة</strong>، ويصحح امتحاناتك
              مع تغذية راجعة تفصيلية.
            </p>
            <div className="mt-7 flex flex-wrap gap-3">
              <Button
                size="lg"
                onClick={() => navigate('apply')}
                className="bg-[#c9a227] text-[#0f2b46] shadow-lg hover:bg-[#e0b83a]"
              >
                قدّم طلب الالتحاق
                <ChevronLeft className="mr-1 h-4 w-4" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => navigate('programs')}
                className="border-[#f5f0e1]/40 bg-transparent text-[#f5f0e1] hover:bg-white/10 hover:text-[#f5f0e1]"
              >
                استكشف البرامج ({programs.length})
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => navigate(user ? 'chat' : 'auth')}
                className="border-[#f5f0e1]/40 bg-transparent text-[#f5f0e1] hover:bg-white/10 hover:text-[#f5f0e1]"
              >
                <Bot className="ml-2 h-5 w-5" />
                المشرف الذكي
              </Button>
            </div>
          </div>

          {/* Stats — عدادات متحركة تبدأ عند الظهور */}
          <div className="mt-12 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {[
              { v: 2016, s: '', l: 'تأسست' },
              { v: 60, s: '+', l: 'ساعة تدريبية بالدبلوم' },
              { v: 24, s: '/7', l: 'مشرف ذكي متاح دائماً' },
              { v: 30, s: '', l: 'يوماً لإصدار الشهادة' },
            ].map((s) => (
              <div
                key={s.l}
                className="rounded-xl border border-[#c9a227]/25 bg-white/5 px-4 py-4 text-center backdrop-blur"
              >
                <div className="text-2xl font-black text-[#e0b83a] sm:text-3xl">
                  <CountUp to={s.v} suffix={s.s} />
                </div>
                <div className="mt-1 text-[11px] font-bold text-[#f5f0e1]/75 sm:text-xs">{s.l}</div>
              </div>
            ))}
          </div>
        </div>
      </section>


      {/* AI Supervisor feature */}
      <section className="mx-auto max-w-7xl px-4 py-14">
        <div className="grid items-center gap-8 lg:grid-cols-2">
          <div>
            <Badge className="mb-3 bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">
              <Sparkles className="ml-1 h-3.5 w-3.5" /> تقنية ذكاء اصطناعي حصرية
            </Badge>
            <h2 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">
              مشرف شخصي ذكي لكل طالب
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-600 sm:text-base">
              لأول مرة: مشرف أكاديمي بالذكاء الاصطناعي يرافق كل طالب على حدة على مدار الساعة.
              اسأله بصوتك أو اكتب سؤالك، وسيرد عليك فوراً بصوت واضح وكتابة، يشرح المفاهيم
              بأمثلة عملية، يرشدك في رحلتك التدريبية، ويصحح امتحاناتك المقالية بتقييم منصف
              وتغذية راجعة بنّاءة.
            </p>
            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              {[
                { icon: Mic, t: 'أسأل بصوتك', d: 'تقنية التعرف على الكلام العربي' },
                { icon: Bot, t: 'يرد صوتاً وكتابة', d: 'ردود فورية مدعومة بمحتوى دوراتك' },
                { icon: FileCheck2, t: 'يصحح امتحاناتك', d: 'تصحيح آلي للمقاليات بتغذية راجعة' },
                { icon: Clock3, t: 'متاح 24/7', d: 'في أي وقت ومن أي جهاز' },
              ].map((f) => (
                <div key={f.t} className="flex items-start gap-3 rounded-xl border border-[#0f2b46]/10 bg-white p-3.5 shadow-sm">
                  <div className="rounded-lg bg-[#0f2b46] p-2 text-[#e0b83a]">
                    <f.icon className="h-5 w-5" />
                  </div>
                  <div>
                    <div className="text-sm font-extrabold text-[#0f2b46]">{f.t}</div>
                    <div className="text-xs text-slate-500">{f.d}</div>
                  </div>
                </div>
              ))}
            </div>
            <Button
              className="mt-6 bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#12365c]"
              onClick={() => navigate(user ? 'chat' : 'auth')}
            >
              جرّب المشرف الذكي الآن
            </Button>
          </div>

          {/* Chat preview mockup */}
          <div className="relative mx-auto w-full max-w-md">
            <div className="absolute -inset-3 rounded-3xl bg-gradient-to-br from-[#c9a227]/20 to-[#0f2b46]/10 blur-xl" />
            <div className="relative rounded-2xl border border-[#0f2b46]/10 bg-white p-4 shadow-2xl">
              <div className="mb-3 flex items-center gap-2 border-b border-slate-100 pb-3">
                <div className="rounded-full bg-[#0f2b46] p-2 text-[#e0b83a]"><Bot className="h-4 w-4" /></div>
                <div>
                  <div className="text-sm font-extrabold text-[#0f2b46]">المشرف الذكي</div>
                  <div className="flex items-center gap-1 text-[10px] font-bold text-emerald-600">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> متصل الآن
                  </div>
                </div>
              </div>
              <div className="space-y-2.5">
                <div className="mr-auto max-w-[85%] rounded-2xl rounded-tr-sm bg-[#0f2b46] px-3.5 py-2.5 text-xs leading-relaxed text-white sm:text-sm">
                  ما الفرق بين تحليل SWOT وتحليل PESTEL؟
                </div>
                <div className="ml-auto max-w-[90%] rounded-2xl rounded-tl-sm bg-[#f7edd0] px-3.5 py-2.5 text-xs leading-relaxed text-[#0f2b46] sm:text-sm">
                  سؤال ممتاز! SWOT يحلل عوامل داخلية (قوة/ضعف) وخارجية مباشرة (فرص/تهديدات) حول
                  المؤسسة نفسها، أما PESTEL فيمسح البيئة الكلية الخارجية: سياسي، اقتصادي، اجتماعي،
                  تكنولوجي، بيئي، قانوني. استخدم SWOT لفهم موقعك، وPESTEL لقراءة السوق. هل تريد
                  مثالاً تطبيقياً؟
                  <div className="mt-2 flex items-center gap-2 border-t border-[#c9a227]/30 pt-2 text-[10px] font-bold text-[#a8841a]">
                    <span className="aact-speak-wave text-[#c9a227]">
                      <span /><span /><span /><span />
                    </span>
                    يشغّل الرد صوتياً...
                  </div>
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 rounded-full border border-slate-200 px-4 py-2.5 text-xs text-slate-400">
                <MicOff className="h-4 w-4" />
                اكتب سؤالك أو اضغط على المايكروفون لالتحدث...
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Featured program */}
      {featured && (
        <section className="bg-[#f7edd0]/40 py-14">
          <div className="mx-auto max-w-7xl px-4">
            <h2 className="mb-6 text-center text-2xl font-black text-[#0f2b46] sm:text-3xl">
              البرنامج الأبرز هذا الموسم
            </h2>
            <Card className="aact-card mx-auto max-w-4xl overflow-hidden border-[#c9a227]/40 bg-white">
              <CardContent className="p-0">
                <div className="grid md:grid-cols-[1fr_auto]">
                  <div className="p-6 sm:p-8">
                    <Badge className="mb-3 bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">
                      {CATEGORY_LABEL[featured.category]}
                    </Badge>
                    <h3 className="text-xl font-black text-[#0f2b46] sm:text-2xl">{featured.titleAr}</h3>
                    <p className="mt-1 text-xs font-bold text-[#a8841a]">{featured.titleEn}</p>
                    <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-slate-600">
                      {featured.description}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2 text-xs font-bold">
                      {featured.hours && (
                        <span className="flex items-center gap-1 rounded-full bg-[#0f2b46]/5 px-3 py-1.5 text-[#0f2b46]">
                          <Clock3 className="h-3.5 w-3.5" /> {featured.hours} ساعة تدريبية
                        </span>
                      )}
                      <span className="flex items-center gap-1 rounded-full bg-[#0f2b46]/5 px-3 py-1.5 text-[#0f2b46]">
                        <BookOpen className="h-3.5 w-3.5" /> 5 وحدات متخصصة
                      </span>
                      {featured.price != null && (
                        <span className="flex items-center gap-1 rounded-full bg-[#c9a227]/15 px-3 py-1.5 text-[#a8841a]">
                          <BadgeCheck className="h-3.5 w-3.5" /> فقط {featured.price}$
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-center bg-[#0f2b46] p-8 md:w-56">
                    <Button
                      onClick={() => (user ? openProgram(featured.id) : navigate('auth'))}
                      className="bg-[#c9a227] font-black text-[#0f2b46] hover:bg-[#e0b83a]"
                    >
                      {featured.enrolled ? 'ادرس الآن' : 'سجل في البرنامج'}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
      )}

      {/* Programs grid */}
      <section className="mx-auto max-w-7xl px-4 py-14">
        <h2 className="mb-2 text-center text-2xl font-black text-[#0f2b46] sm:text-3xl">
          برامجنا التدريبية والاعتمادات
        </h2>
        <p className="mb-8 text-center text-sm text-slate-500">
          {programs.length} برامج معتمدة للعام 2026-2027 — من الدبلومات المهنية إلى الدكتوراه واعتماد المؤسسات
        </p>
        {loading ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-52 animate-pulse rounded-2xl bg-slate-100" />
            ))}
          </div>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {programs.slice(0, 6).map((p) => {
              const Icon = ICONS[p.icon] || GraduationCap
              return (
                <Card
                  key={p.id}
                  className="aact-card cursor-pointer border-[#0f2b46]/10 bg-white"
                  onClick={() => navigate('programs')}
                >
                  <CardContent className="flex h-full flex-col p-6">
                    <div className="mb-4 flex items-start justify-between">
                      <div className="rounded-xl bg-[#0f2b46] p-3 text-[#e0b83a]">
                        <Icon className="h-6 w-6" />
                      </div>
                      <Badge variant="outline" className="border-[#c9a227]/50 text-[11px] text-[#a8841a]">
                        {CATEGORY_LABEL[p.category]}
                      </Badge>
                    </div>
                    <h3 className="text-base font-black leading-snug text-[#0f2b46]">{p.titleAr}</h3>
                    <p className="mt-2 line-clamp-2 flex-1 text-xs leading-relaxed text-slate-500">
                      {p.description}
                    </p>
                    <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                      <span className="text-[11px] font-bold text-slate-400">
                        {p.unitsCount > 0 ? `${p.unitsCount} وحدات تدريبية` : 'اعتماد مباشر'}
                      </span>
                      <span className="flex items-center gap-1 text-xs font-extrabold text-[#a8841a]">
                        التفاصيل <ChevronLeft className="h-3.5 w-3.5" />
                      </span>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        )}
        <div className="mt-8 text-center">
          <Button
            size="lg"
            variant="outline"
            onClick={() => navigate('programs')}
            className="border-[#0f2b46]/25 font-extrabold text-[#0f2b46] hover:bg-[#0f2b46] hover:text-[#f5f0e1]"
          >
            عرض جميع البرامج ({programs.length})
            <ChevronLeft className="mr-1 h-4 w-4" />
          </Button>
        </div>
      </section>

      {/* Admission guide + fees */}
      <section className="bg-[#f7edd0]/40 py-14">
        <div className="mx-auto max-w-7xl px-4">
          <h2 className="mb-2 text-center text-2xl font-black text-[#0f2b46] sm:text-3xl">
            دليل الالتحاق والرسوم
          </h2>
          <p className="mb-8 text-center text-sm text-slate-500">
            وفق دليل إجراءات وشروط الالتحاق الرسمي للعام 2026-2027
          </p>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="border-[#c9a227]/40 bg-white">
              <CardContent className="p-6">
                <h3 className="mb-4 flex items-center gap-2 text-base font-black text-[#0f2b46]">
                  <Banknote className="h-5 w-5 text-[#a8841a]" /> التكلفة المالية للبرامج
                </h3>
                <div className="space-y-3">
                  {[
                    { p: 'الدكتوراه المهنية (معادلة خبرات)', f: `${ADMISSION_FEES.doctorate}$` },
                    { p: 'الماجستير المهني (معادلة خبرات)', f: `${ADMISSION_FEES.masters}$` },
                    { p: 'الدبلومات والبرامج الدولية (حسب البرنامج)', f: `${ADMISSION_FEES.diplomasRange}$` },
                    { p: 'رسوم تقديم الطلب وحجز المقعد (غير مستردة)', f: `${ADMISSION_FEES.applicationFee}$` },
                  ].map((r) => (
                    <div key={r.p} className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 bg-slate-50/60 px-4 py-2.5">
                      <span className="text-xs font-bold text-slate-700 sm:text-sm">{r.p}</span>
                      <span className="shrink-0 text-sm font-black text-[#a8841a]">{r.f}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
                  التكاليف مقابل الدراسة وشهادة معتمدة من الأكاديمية — والشهادات في مجال التدريب المهني فقط.
                </p>
              </CardContent>
            </Card>
            <Card className="border-[#c9a227]/40 bg-white">
              <CardContent className="p-6">
                <h3 className="mb-4 flex items-center gap-2 text-base font-black text-[#0f2b46]">
                  <ClipboardList className="h-5 w-5 text-[#a8841a]" /> خطوات الالتحاق باختصار
                </h3>
                <ol className="space-y-2.5">
                  {[
                    'قدّم طلب الالتحاق الإلكتروني وأرفق وثائقك (الشهادة، الهوية، صور شخصية، C.V)',
                    'سدد رسوم التقديم وحجز المقعد (30$ غير مستردة)',
                    'يتم دراسة ملفك وتعيين مشرف لك بعد القبول',
                    'سدد رسوم الدراسة وابدأ رحلتك التدريبية',
                    'قدّم بحث التخرج وناقشه خلال 3-6 شهور كحد أقصى',
                  ].map((s, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-xs leading-relaxed text-slate-700 sm:text-sm">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#0f2b46] text-[11px] font-black text-[#e0b83a]">{i + 1}</span>
                      {s}
                    </li>
                  ))}
                </ol>
                <Button
                  className="mt-5 w-full bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]"
                  onClick={() => navigate('apply')}
                >
                  <ClipboardList className="ml-2 h-4 w-4" />
                  ابدأ إجراءات الالتحاق الآن
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* آراء طلابنا — دليل اجتماعي */}
      <section className="bg-[#f7edd0]/40 py-14">
        <div className="mx-auto max-w-7xl px-4">
          <div className="mx-auto mb-8 max-w-2xl text-center">
            <Badge className="mb-3 bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">
              <Star className="ml-1 h-3.5 w-3.5" /> آراء طلابنا
            </Badge>
            <h2 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">قصص نجاح من مختلف الدول</h2>
            <p className="mt-2 text-sm text-slate-600">خريجون واعتماد منهم قدموا لهم برامج الأكاديمية نقلة مهنية حقيقية</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { n: 'د. محمد العتيبي', r: 'مستشار إداري معتمد', c: 'السعودية', q: 'الدكتوراه المهنية كانت نقلة حقيقية في مسيرتي — المناقشة عبر الفيديو كونفرنس وفّرت عليّ السفر، والمشرف الذكي كان متاحاً في أي وقت.' },
              { n: 'م. سارة الحمادي', r: 'مديرة موارد بشرية', c: 'الإمارات', q: 'دبلوم الموارد البشرية عمّق خبرتي العملية، والامتحانات المقالية مع التغذية الراجعة الفورية جعلت كل وحدة درساً حقيقياً لا حفظاً.' },
              { n: 'أ. خالد منصور', r: 'مدرب دولي معتمد CIT', c: 'مصر', q: 'شهادة المدرب الدولي فتحت لي أبواب التعاون مع مراكز تدريب كبرى — والإجراءات كانت واضحة من أول يوم حتى وصول الشهادة.' },
              { n: 'د. ليلى بن صالح', r: 'مؤسِّسة مركز تدريب', c: 'الأردن', q: 'اعتماد المركز من الأكاديمية رفع ثقة المتدربين بنا فوراً — والواجهة الإلكترونية والتحقق من الشهادات أضافا مصداقية حقيقية.' },
            ].map((t) => (
              <Card key={t.n} className="aact-card border-[#0f2b46]/10 bg-white">
                <CardContent className="flex h-full flex-col p-5">
                  <Quote className="h-6 w-6 text-[#c9a227]/60" />
                  <div className="mt-2 flex gap-0.5">
                    {[...Array(5)].map((_, i) => (
                      <Star key={i} className="h-3.5 w-3.5 fill-[#c9a227] text-[#c9a227]" />
                    ))}
                  </div>
                  <p className="mt-3 flex-1 text-xs leading-relaxed text-slate-600">{t.q}</p>
                  <div className="mt-4 border-t border-slate-100 pt-3">
                    <p className="text-xs font-black text-[#0f2b46]">{t.n}</p>
                    <p className="mt-0.5 text-[10px] font-bold text-slate-500">{t.r} — {t.c}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* الأسئلة الشائعة — إجابات مباشرة عن أكثر ما يسأل عنه المتقدمون */}
      <section className="mx-auto max-w-4xl px-4 py-14">
        <div className="mb-8 text-center">
          <Badge className="mb-3 border-[#c9a227]/50 bg-[#c9a227]/15 text-[#a8841a] hover:bg-[#c9a227]/15">
            <HelpCircle className="ml-1 h-3.5 w-3.5" /> الأسئلة الشائعة
          </Badge>
          <h2 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">كل ما تريد معرفته قبل الالتحاق</h2>
        </div>
        <Accordion type="single" collapsible className="space-y-3">
          {[
            { q: 'هل شهادات الأكاديمية معتمدة وقابلة للتحقق؟', a: 'نعم — الأكاديمية الأمريكية للاستشارات والتدريب تعمل منذ 2016، وكل شهادة تصدر برقم تسلسلي فريد يمكن التحقق من صحته إلكترونياً خلال ثوانٍ عبر صفحة «التحقق من الشهادات» في المنصة، ما يجعلها موثقة أمام أصحاب العمل والجهات الرسمية.' },
            { q: 'ما هي رسوم البرامج وكيف تدفع؟', a: 'رسوم التقديم 30$ وتُسدد إلكترونياً عند التقديم، الماجستير المهني 700$، الدكتوراه المهنية 1300$، الدبلومات المهنية بين 100–350$ حسب البرنامج، والشهادات الدولية من 250$. الدفع يتم عبر البوابات الإلكترونية داخل المنصة (Stripe/PayPal/Paymob) مع إيصال رسمي لكل عملية.' },
            { q: 'كم تستغرق مدة الدراسة؟', a: 'الدبلومات تشمل أكثر من 60 ساعة تدريبية تدرس بوتيرتك الخاصة، أما الماجستير والدكتوراه المهنية فمسار مرن: تدرس وتجتاز الامتحانات ثم تسلم بحث التخرج خلال مهلة تصل إلى 6 أشهر من القبول، ويمكن تمديدها بطلب من الإدارة.' },
            { q: 'كيف تتم مناقشة بحث التخرج؟', a: 'عبر قاعة فيديو كونفرنس متكاملة داخل المنصة: تناقش بحثك أمام لجنة متخصصة متصلة من دول مختلفة، ويشارك خبير ذكاء اصطناعي بالأسئلة والتحليل الحي. تُفتح القاعة قبل موعدك بـ15 دقيقة، وتولّد الجلسة محضراً رسمياً وتسجيلاً مؤرشفاً في ملفك.' },
            { q: 'متى تصدر الشهادة بعد التخرج؟', a: 'وفق اللوائح الرسمية تصدر شهادتك خلال 30 يوماً كحد أقصى من اجتياز المناقشة وسداد الرسوم الدراسية كاملة، وتظهر تلقائياً في تبويب «شهاداتي» في بوابتك مع إمكانية الطباعة والتحقق العام.' },
            { q: 'من يساعدني أثناء الدراسة؟', a: 'لك مشرف أكاديمي بشري يعينه عليك الإدارة، إضافة إلى مشرف ذكاء اصطناعي متاح 24/7 يجيب أسئلتك صوتاً وكتابة، يشرح مفاهيم دوراتك، يصحح امتحاناتك المقالية بتغذية راجعة تفصيلية، ويرافقك خطوة بخطوة حتى التخرج.' },
          ].map((f) => (
            <AccordionItem key={f.q} value={f.q} className="rounded-2xl border border-[#0f2b46]/10 bg-white px-5">
              <AccordionTrigger className="py-4 text-right text-sm font-black text-[#0f2b46] hover:no-underline">
                {f.q}
              </AccordionTrigger>
              <AccordionContent className="pb-4 text-xs leading-relaxed text-slate-600">
                {f.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>

      {/* International agents CTA */}
      <section className="bg-[#0f2b46] py-14 text-[#f5f0e1]">
        <div className="mx-auto max-w-7xl px-4">
          <div className="mx-auto max-w-3xl text-center">
            <Globe2 className="mx-auto mb-4 h-10 w-10 text-[#c9a227]" />
            <h2 className="text-2xl font-black sm:text-3xl">
              كن الممثل المعتمد للأكاديمية في بلدك
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-[#f5f0e1]/80 sm:text-base">
              تمنح الأكاديمية حق التمثيل الحصري لتسويق وتقديم برامجها التدريبية المعتمدة، مع
              نظام عمولات مغرٍ: <strong className="text-[#e0b83a]">25%</strong> من إيرادات منطقة
              التمثيل، و<strong className="text-[#e0b83a]">100$</strong> عن كل بحث تخرج تشارك
              في لجنة مناقشته، وإدراج اسمك في قائمة الوكلاء المعتمدين بالموقع الرسمي.
            </p>
            <Button
              size="lg"
              className="mt-6 bg-[#c9a227] font-black text-[#0f2b46] hover:bg-[#e0b83a]"
              onClick={() => navigate('agent')}
            >
              قدّم طلب الوكالة الدولية
            </Button>
          </div>
        </div>
      </section>

      {/* الثقة: الدليل العام + التحقق من الشهادات */}
      <section className="py-14">
        <div className="mx-auto grid max-w-7xl gap-5 px-4 md:grid-cols-2">
          <Card className="aact-card border-[#0f2b46]/10 bg-white">
            <CardContent className="flex flex-col items-start gap-3 p-6 sm:flex-row">
              <span className="rounded-2xl bg-[#0f2b46] p-3 text-[#e0b83a]">
                <Users className="h-6 w-6" />
              </span>
              <div className="flex-1">
                <h3 className="text-base font-black text-[#0f2b46]">دليل المعتمدين والوكلاء</h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  استعرض المستشارين والمدربين والهيئات التدريبية المعتمدين، والوكلاء الدوليين
                  المعتمدين رسمياً — مع تحقق فوري من شهاداتهم.
                </p>
                <Button size="sm" variant="outline" className="mt-3 border-[#0f2b46]/20 font-bold text-[#0f2b46]"
                  onClick={() => navigate('directory')}>
                  تصفح الدليل
                </Button>
              </div>
            </CardContent>
          </Card>
          <Card className="aact-card border-[#c9a227]/40 bg-[#f7edd0]/50">
            <CardContent className="flex flex-col items-start gap-3 p-6 sm:flex-row">
              <span className="rounded-2xl bg-[#c9a227] p-3 text-[#0f2b46]">
                <ShieldCheck className="h-6 w-6" />
              </span>
              <div className="flex-1">
                <h3 className="text-base font-black text-[#0f2b46]">التحقق من صحة الشهادة</h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-600">
                  كل شهادة صادرة من الأكاديمية تحمل رقماً تسلسلياً فريداً ورمز QR — تحقق من صحة
                  أي شهادة فوراً عبر صفحة التحقق الرسمية.
                </p>
                <Button size="sm" className="mt-3 bg-[#0f2b46] font-bold text-[#f5f0e1] hover:bg-[#12365c]"
                  onClick={() => navigate('verify')}>
                  تحقق الآن
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  )
}
