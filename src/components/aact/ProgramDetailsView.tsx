'use client'

import { useEffect, useState } from 'react'
import { useAppStore, api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  GraduationCap, Award, Briefcase, ShieldCheck, Building2, BookOpen,
  Clock3, BadgeCheck, CheckCircle2, ClipboardList, ChevronLeft, ArrowRight,
  Users2, FileText, Loader2,
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
  enrolled: boolean
}

const ICONS: Record<string, any> = {
  briefcase: Briefcase,
  award: Award,
  'book-open': BookOpen,
  'shield-check': ShieldCheck,
  'building-2': Building2,
  'graduation-cap': GraduationCap,
}

const CATEGORY_LABEL: Record<string, string> = {
  DIPLOMA: 'دبلوم مهني',
  DOCTORATE: 'دكتوراه مهنية',
  MASTERS: 'ماجستير مهني',
  ACCREDITATION: 'اعتماد دولي',
  INTL_CERT: 'شهادة دولية',
}

export function ProgramDetailsView() {
  const { programDetailsId, user, navigate, openApply, openProgram } = useAppStore()
  const [programs, setPrograms] = useState<Program[]>([])
  const [loading, setLoading] = useState(true)
  const { toast } = useToast()

  useEffect(() => {
    api<{ programs: Program[] }>('/api/programs')
      .then((d) => setPrograms(d.programs || []))
      .catch(() => toast({ title: 'خطأ', description: 'تعذر تحميل تفاصيل البرنامج', variant: 'destructive' }))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!programDetailsId && !loading) navigate('programs')
  }, [programDetailsId, loading, navigate])

  const program = programs.find((p) => p.id === programDetailsId || p.slug === programDetailsId)
  const Icon = program ? (ICONS[program.icon] || GraduationCap) : GraduationCap

  const startAdmission = () => {
    if (!program) return
    if (program.enrolled) {
      openProgram(program.id)
      return
    }
    if (!user) {
      toast({ title: 'تنبيه', description: 'سجّل دخولك أو أنشئ حساباً ثم قدّم طلب الالتحاق' })
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
            <h1 className="text-xl font-black text-[#0f2b46]">لم يتم العثور على البرنامج المحدد</h1>
            <p className="mt-2 text-sm text-slate-500">قد يكون البرنامج حُذف أو تغيّر معرّفه. ارجع إلى قائمة البرامج واختر البرنامج من جديد.</p>
            <Button onClick={() => navigate('programs')} className="mt-5 bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#183c5f]">
              العودة إلى البرامج
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="aact-fade-in mx-auto max-w-6xl px-4 py-10">
      <button
        onClick={() => navigate('programs')}
        className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#0f2b46]/15 bg-white px-4 py-2 text-xs font-black text-[#0f2b46] hover:bg-[#0f2b46]/5"
      >
        <ArrowRight className="h-4 w-4" />
        العودة إلى كل البرامج
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
                    {CATEGORY_LABEL[program.category] || 'برنامج تدريبي'}
                  </Badge>
                  {program.enrolled && (
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
              {program.enrolled ? 'ادرس البرنامج' : 'قدّم طلب الالتحاق'}
              <ChevronLeft className="mr-1 h-4 w-4" />
            </Button>
          </div>
        </div>

        <CardContent className="p-6 sm:p-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-[#0f2b46]/10 bg-[#faf6ea] p-4">
              <Clock3 className="mb-2 h-5 w-5 text-[#a8841a]" />
              <p className="text-xs font-bold text-slate-500">الساعات التدريبية</p>
              <p className="mt-1 text-lg font-black text-[#0f2b46]">{program.hours ? `${program.hours} ساعة` : 'حسب مسار البرنامج'}</p>
            </div>
            <div className="rounded-2xl border border-[#0f2b46]/10 bg-[#faf6ea] p-4">
              <BadgeCheck className="mb-2 h-5 w-5 text-[#a8841a]" />
              <p className="text-xs font-bold text-slate-500">الرسوم</p>
              <p className="mt-1 text-lg font-black text-[#0f2b46]">{program.price != null ? `${program.price}$` : 'حسب البرنامج'}</p>
            </div>
            <div className="rounded-2xl border border-[#0f2b46]/10 bg-[#faf6ea] p-4">
              <Users2 className="mb-2 h-5 w-5 text-[#a8841a]" />
              <p className="text-xs font-bold text-slate-500">المحتوى</p>
              <p className="mt-1 text-lg font-black text-[#0f2b46]">{program.unitsCount > 0 ? `${program.unitsCount} وحدات` : 'اعتماد مباشر'}</p>
            </div>
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
            <section className="rounded-2xl border border-[#0f2b46]/10 bg-white p-5">
              <h2 className="mb-3 flex items-center gap-2 text-lg font-black text-[#0f2b46]">
                <ClipboardList className="h-5 w-5 text-[#a8841a]" />
                تفاصيل البرنامج
              </h2>
              <p className="text-sm leading-8 text-slate-600">{program.description}</p>
            </section>

            <section className="rounded-2xl border border-[#0f2b46]/10 bg-[#faf6ea] p-5">
              <h2 className="mb-3 flex items-center gap-2 text-lg font-black text-[#0f2b46]">
                <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                مسار الالتحاق
              </h2>
              <ol className="space-y-2 text-xs font-bold leading-relaxed text-slate-600">
                <li>١. إنشاء حساب أو تسجيل الدخول.</li>
                <li>٢. تعبئة طلب الالتحاق ورفع الوثائق.</li>
                <li>٣. سداد رسوم التقديم وحجز المقعد.</li>
                <li>٤. مراجعة الإدارة واعتماد الطلب.</li>
                <li>٥. بدء الدراسة بعد القبول وسداد الرسوم.</li>
              </ol>
            </section>
          </div>

          {program.features.length > 0 && (
            <section className="mt-6 rounded-2xl border border-[#c9a227]/35 bg-[#fffaf0] p-5">
              <h2 className="mb-4 text-lg font-black text-[#0f2b46]">مميزات ومخرجات البرنامج</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {program.features.map((feature, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-xl bg-white p-3 text-sm leading-relaxed text-slate-600 shadow-sm">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    <span>{feature}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button onClick={startAdmission} className="flex-1 bg-[#c9a227] py-6 text-base font-black text-[#0f2b46] hover:bg-[#e0b83a]">
              {program.enrolled ? 'الدخول إلى البرنامج' : 'قدّم طلب الالتحاق بهذا البرنامج'}
              <ChevronLeft className="mr-1 h-5 w-5" />
            </Button>
            <Button variant="outline" onClick={() => navigate('programs')} className="flex-1 border-[#0f2b46]/20 py-6 text-base font-black text-[#0f2b46] hover:bg-[#0f2b46]/5">
              استعراض جميع البرامج
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
