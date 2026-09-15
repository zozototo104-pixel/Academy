'use client'

import { useAppStore } from '@/lib/store'
import { ACADEMY_INFO, SERVICE_OFFERINGS } from '@/lib/academyData'
import { AcademyLogo } from '@/components/aact/Shell'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Award, BookOpen, Briefcase, CheckCircle2, ChevronLeft, Globe2,
  GraduationCap, Lightbulb, ShieldCheck, Sparkles, Target, Users2,
} from 'lucide-react'

const VALUES = [
  {
    title: 'التميز المهني',
    text: 'تقديم برامج وشهادات مهنية بمعايير واضحة ترتقي بمهارات الدارسين وتدعم مسارهم الوظيفي.',
    icon: Award,
  },
  {
    title: 'الابتكار والتطوير',
    text: 'تحديث وسائل التدريب والتقييم والاعتماد، ودمج التعلم الذاتي والتفاعل الرقمي والمشرف الذكي.',
    icon: Lightbulb,
  },
  {
    title: 'النزاهة والشفافية',
    text: 'إجراءات قبول واعتماد وتحقق رقمية قابلة للمراجعة، مع وضوح في الرسوم والشروط ومخرجات التعلم.',
    icon: ShieldCheck,
  },
  {
    title: 'العالمية والريادة',
    text: 'بناء شبكة مهنية دولية تربط الخريجين والمدربين والمستشارين والمؤسسات بفرص تدريب واعتماد موثوقة.',
    icon: Globe2,
  },
]

const STATS = [
  { value: '+15k', label: 'خريج ومتدرب معتمد' },
  { value: '+25', label: 'برنامج تدريبي ومهني' },
  { value: '+50', label: 'خبير ومستشار دولي' },
  { value: '100%', label: 'تعلم تطبيقي ومهني' },
]

export function AboutView() {
  const { navigate, openPrograms } = useAppStore()
  const featuredServices = SERVICE_OFFERINGS.slice(0, 4)

  return (
    <div className="aact-fade-in">
      <section className="relative overflow-hidden bg-[#0f2b46] text-[#f5f0e1]">
        <div className="absolute inset-0 opacity-20" aria-hidden="true">
          <div className="absolute -left-16 top-10 h-64 w-64 rounded-full bg-[#c9a227] blur-3xl" />
          <div className="absolute -right-20 bottom-0 h-72 w-72 rounded-full bg-white blur-3xl" />
        </div>
        <div className="relative mx-auto grid max-w-7xl items-center gap-8 px-4 py-16 lg:grid-cols-[1.4fr_0.8fr] lg:py-20">
          <div>
            <Badge className="mb-4 border-[#c9a227]/50 bg-[#c9a227]/15 text-[#e0b83a] hover:bg-[#c9a227]/15">
              ريادة تعليمية بمعايير دولية
            </Badge>
            <h1 className="text-3xl font-black leading-[1.35] sm:text-4xl lg:text-5xl">من نحن</h1>
            <p className="mt-4 max-w-3xl text-base font-bold leading-8 text-[#f5f0e1]/85">
              {ACADEMY_INFO.nameAr} صرح مهني يربط التدريب والاستشارات والاعتماد بمنصة رقمية واحدة،
              ويحوّل التعلم من محتوى نظري إلى مسار تطبيقي قابل للقياس والتحقق.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button onClick={() => openPrograms()} className="bg-[#c9a227] font-black text-[#0f2b46] hover:bg-[#e0b83a]">
                استكشف البرامج والخدمات
                <ChevronLeft className="mr-1 h-4 w-4" />
              </Button>
              <Button variant="outline" onClick={() => navigate('contact')} className="border-white/35 bg-transparent font-black text-white hover:bg-white/10 hover:text-white">
                تواصل معنا
              </Button>
            </div>
          </div>
          <div className="mx-auto w-full max-w-sm rounded-[2rem] border border-[#c9a227]/40 bg-white/10 p-6 text-center backdrop-blur">
            <AcademyLogo size={150} light className="mx-auto" />
            <h2 className="mt-5 text-lg font-black text-[#e0b83a]">American Academy</h2>
            <p className="mt-2 text-sm font-bold text-[#f5f0e1]/75">Leadership in Excellence</p>
            <div className="mt-4 rounded-2xl bg-white/10 p-3 text-xs font-bold leading-6 text-[#f5f0e1]/80">
              {ACADEMY_INFO.locationAr}<br />تأسست عام {ACADEMY_INFO.founded}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-14">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {STATS.map((s) => (
            <Card key={s.label} className="border-[#c9a227]/30 bg-white text-center shadow-sm">
              <CardContent className="p-5">
                <p className="text-3xl font-black text-[#a8841a]">{s.value}</p>
                <p className="mt-2 text-xs font-black text-[#0f2b46]">{s.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-6 px-4 pb-14 lg:grid-cols-2">
        <Card className="border-[#0f2b46]/10 bg-white">
          <CardContent className="p-6 sm:p-8">
            <div className="mb-4 flex items-center gap-3">
              <span className="rounded-2xl bg-[#0f2b46] p-3 text-[#e0b83a]"><Target className="h-6 w-6" /></span>
              <h2 className="text-xl font-black text-[#0f2b46]">رسالتنا</h2>
            </div>
            <p className="text-sm font-bold leading-8 text-slate-600">
              تمكين الكفاءات وتزويد الدارسين بالمهارات القيادية والعملية والتدريبية، وسد الفجوة بين المعرفة النظرية وتحديات سوق العمل عبر برامج ودبلومات واعتمادات قابلة للتطبيق والتحقق.
            </p>
            <div className="mt-5 grid gap-2 text-xs font-black text-[#0f2b46] sm:grid-cols-2">
              <p className="rounded-xl bg-[#faf6ea] p-3"><CheckCircle2 className="ml-1 inline h-4 w-4 text-emerald-600" /> تدريب عملي تطبيقي</p>
              <p className="rounded-xl bg-[#faf6ea] p-3"><CheckCircle2 className="ml-1 inline h-4 w-4 text-emerald-600" /> مناهج مهنية محدثة</p>
            </div>
          </CardContent>
        </Card>
        <Card className="border-[#0f2b46]/10 bg-[#fffaf0]">
          <CardContent className="p-6 sm:p-8">
            <div className="mb-4 flex items-center gap-3">
              <span className="rounded-2xl bg-[#c9a227] p-3 text-[#0f2b46]"><Sparkles className="h-6 w-6" /></span>
              <h2 className="text-xl font-black text-[#0f2b46]">رؤيتنا</h2>
            </div>
            <p className="text-sm font-bold leading-8 text-slate-600">
              أن تكون الأكاديمية وجهة موثوقة للأفراد والشركات الباحثين عن التطوير المهني والاعتمادات الدولية، وأن تقدم نموذجاً رقمياً يجمع بين التعليم المرن، التحكيم المهني، والاستشارات المتخصصة.
            </p>
            <div className="mt-5 grid gap-2 text-xs font-black text-[#0f2b46] sm:grid-cols-2">
              <p className="rounded-xl bg-white p-3"><CheckCircle2 className="ml-1 inline h-4 w-4 text-emerald-600" /> شبكة خريجين دولية</p>
              <p className="rounded-xl bg-white p-3"><CheckCircle2 className="ml-1 inline h-4 w-4 text-emerald-600" /> اعتماد وتحقق رقمي</p>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="bg-[#f7edd0]/40 py-14">
        <div className="mx-auto max-w-7xl px-4">
          <div className="mx-auto mb-8 max-w-3xl text-center">
            <Badge className="mb-3 bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">قيمنا الأساسية</Badge>
            <h2 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">المبادئ التي تحكم برامجنا وخدماتنا</h2>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {VALUES.map((v) => {
              const Icon = v.icon
              return (
                <Card key={v.title} className="aact-card border-[#0f2b46]/10 bg-white">
                  <CardContent className="p-5">
                    <span className="mb-4 inline-flex rounded-2xl bg-[#0f2b46] p-3 text-[#e0b83a]"><Icon className="h-6 w-6" /></span>
                    <h3 className="font-black text-[#0f2b46]">{v.title}</h3>
                    <p className="mt-2 text-xs font-bold leading-6 text-slate-600">{v.text}</p>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-14">
        <div className="mb-8 flex flex-col gap-3 text-center sm:text-right lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Badge className="mb-3 border-[#c9a227]/50 bg-[#c9a227]/15 text-[#a8841a] hover:bg-[#c9a227]/15">منظومة الأكاديمية</Badge>
            <h2 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">خدمات وبرامج تحت سقف واحد</h2>
            <p className="mt-2 max-w-3xl text-sm font-bold leading-7 text-slate-600">
              لا تقتصر الأكاديمية على البرامج الدراسية؛ بل تقدم اعتماداً وعضوية ورخص تدريب وحقائب واستشارات ومعادلة خبرات.
            </p>
          </div>
          <Button variant="outline" onClick={() => openPrograms('SERVICE')} className="border-[#0f2b46]/20 font-black text-[#0f2b46] hover:bg-[#0f2b46] hover:text-[#f5f0e1]">
            عرض الخدمات المهنية
          </Button>
        </div>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {featuredServices.map((s) => (
            <Card key={s.slug} className="aact-card border-[#0f2b46]/10 bg-white">
              <CardContent className="p-5">
                <Briefcase className="mb-3 h-6 w-6 text-[#a8841a]" />
                <h3 className="text-sm font-black leading-6 text-[#0f2b46]">{s.titleAr}</h3>
                <p className="mt-2 line-clamp-4 text-xs font-bold leading-6 text-slate-600">{s.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="bg-[#0f2b46] py-14 text-[#f5f0e1]">
        <div className="mx-auto max-w-4xl px-4 text-center">
          <GraduationCap className="mx-auto mb-4 h-10 w-10 text-[#c9a227]" />
          <h2 className="text-2xl font-black sm:text-3xl">ابدأ رحلتك المهنية المتميزة الآن</h2>
          <p className="mx-auto mt-3 max-w-2xl text-sm font-bold leading-8 text-[#f5f0e1]/80">
            اختر البرنامج أو الخدمة المناسبة، وقدّم طلبك من المنصة ليصل إلى الإدارة مع كامل البيانات والمرفقات للمتابعة.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <Button onClick={() => navigate('apply')} className="bg-[#c9a227] font-black text-[#0f2b46] hover:bg-[#e0b83a]">قدّم طلبك الآن</Button>
            <Button variant="outline" onClick={() => navigate('contact')} className="border-white/35 bg-transparent font-black text-white hover:bg-white/10 hover:text-white">تواصل معنا</Button>
          </div>
        </div>
      </section>
    </div>
  )
}
