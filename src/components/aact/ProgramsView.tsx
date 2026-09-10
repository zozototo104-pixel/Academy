'use client'

import { useAppStore, api } from '@/lib/store'
import { useEffect, useState } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Input } from '@/components/ui/input'
import { Search, ChevronLeft, Users2, Loader2 } from 'lucide-react'
import {
  GraduationCap, Award, Briefcase, ShieldCheck, Building2, BookOpen,
  Clock3, BadgeCheck, CheckCircle2, ClipboardList,
} from 'lucide-react'

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

const FILTERS: { key: string; label: string }[] = [
  { key: 'ALL', label: 'الكل' },
  { key: 'DEGREES', label: 'ماجستير ودكتوراة' },
  { key: 'INTL_CERT', label: 'الشهادات الدولية' },
  { key: 'DIPLOMA', label: 'الدبلومات التدريبية' },
  { key: 'ACCREDITATION', label: 'الاعتمادات' },
]

function matchFilter(p: Program, f: string): boolean {
  if (f === 'ALL') return true
  if (f === 'DEGREES') return p.category === 'MASTERS' || p.category === 'DOCTORATE'
  return p.category === f
}

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

interface InvoiceLite {
  invoiceNo: string
  description: string
  amount: number
  currency: string
}

export function ProgramsView() {
  const { user, navigate, openProgram, openProgramDetails, openApply } = useAppStore()
  const [programs, setPrograms] = useState<Program[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('ALL')
  const [search, setSearch] = useState('')
  const { toast } = useToast()

  const load = async () => {
    try {
      const d = await api<{ programs: Program[] }>('/api/programs')
      setPrograms(d.programs)
    } catch {
      toast({ title: 'خطأ', description: 'تعذر تحميل البرامج', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // الالتحاق بالبرنامج يتم عبر إجراءات الالتحاق الرسمية (دليل الإجراءات):
  // بيانات كاملة → رفع الوثائق → الإقرار → سداد رسوم التقديم 30$ → دراسة الإدارة → بعد القبول سداد الرسوم كاملة
  const startAdmission = (p: Program) => {
    if (p.enrolled) {
      openProgram(p.id)
      return
    }
    if (!user) {
      toast({ title: 'تنبيه', description: 'أنشئ حسابك أو سجل دخولك أولاً ثم قدّم طلب الالتحاق' })
      navigate('auth')
      return
    }
    openApply(p.titleAr)
  }

  const searchWords = search.trim().split(/\s+/).filter(Boolean)
  const matchesSearch = (p: Program) => {
    if (!searchWords.length) return true
    const hay = `${p.titleAr} ${p.titleEn || ''}`
    return searchWords.every((w) => hay.includes(w))
  }

  const filtered = programs
    .filter((p) => matchFilter(p, filter))
    .filter(matchesSearch)

  return (
    <div className="aact-fade-in mx-auto max-w-7xl px-4 py-10">
      <h1 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">البرامج التدريبية والاعتمادات</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-600">
        جميع البرامج صادرة ومعتمدة من الأكاديمية الأمريكية للاستشارات والتدريب ضمن برامج العام 2026-2027، وتُصدر شهاداتها
        خلال 30 يوماً من استلام كشوف الدرجات والرسوم المقررة وفق دليل الإجراءات الرسمي.
      </p>

      {/* Filters + search */}
      <div className="mt-6 flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-4 py-2 text-xs font-extrabold transition-colors sm:text-sm ${
                filter === f.key
                  ? 'bg-[#0f2b46] text-[#e0b83a]'
                  : 'border border-[#0f2b46]/15 bg-white text-[#0f2b46] hover:bg-[#0f2b46]/5'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            placeholder="ابحث عن برنامج... (موارد بشرية، مشاريع...)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-white pr-10"
          />
        </div>
      </div>

      {loading ? (
        <div className="mt-8 grid gap-5 lg:grid-cols-2">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-64 animate-pulse rounded-2xl bg-slate-100" />
          ))}
        </div>
      ) : (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {filtered.map((p) => {
            const Icon = ICONS[p.icon] || GraduationCap
            return (
              <Card key={p.id} className="aact-card flex flex-col border-[#0f2b46]/10 bg-white">
                <CardContent className="flex flex-1 flex-col p-6">
                  <div className="mb-4 flex items-start gap-4">
                    <div className="rounded-xl bg-[#0f2b46] p-3 text-[#e0b83a]">
                      <Icon className="h-7 w-7" />
                    </div>
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">
                          {CATEGORY_LABEL[p.category]}
                        </Badge>
                        {p.enrolled && (
                          <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                            <CheckCircle2 className="ml-1 h-3 w-3" /> مسجل
                          </Badge>
                        )}
                      </div>
                      <h2 className="mt-2 text-lg font-black leading-snug text-[#0f2b46]">{p.titleAr}</h2>
                      {p.titleEn && <p className="text-xs font-bold text-[#a8841a]">{p.titleEn}</p>}
                    </div>
                  </div>

                  <p className="text-sm leading-relaxed text-slate-600">{p.description}</p>

                  <div className="mt-4 flex flex-wrap gap-2 text-xs font-bold">
                    {p.hours && (
                      <span className="flex items-center gap-1 rounded-full bg-[#0f2b46]/5 px-3 py-1.5 text-[#0f2b46]">
                        <Clock3 className="h-3.5 w-3.5" /> {p.hours} ساعة
                      </span>
                    )}
                    {p.price != null && (
                      <span className="flex items-center gap-1 rounded-full bg-[#c9a227]/15 px-3 py-1.5 text-[#a8841a]">
                        <BadgeCheck className="h-3.5 w-3.5" /> {p.price}$
                      </span>
                    )}
                    <span className="flex items-center gap-1 rounded-full bg-[#0f2b46]/5 px-3 py-1.5 text-[#0f2b46]">
                      <Users2 className="h-3.5 w-3.5" /> {p.unitsCount > 0 ? `${p.unitsCount} وحدات` : 'برنامج اعتماد'}
                    </span>
                  </div>

                  {p.features.length > 0 && (
                    <Accordion type="single" collapsible className="mt-4">
                      <AccordionItem value="features" className="border-slate-100">
                        <AccordionTrigger className="py-2.5 text-xs font-extrabold text-[#0f2b46] hover:no-underline">
                          مميزات البرنامج ({p.features.length})
                        </AccordionTrigger>
                        <AccordionContent>
                          <ul className="space-y-2 pb-1">
                            {p.features.map((f, i) => (
                              <li key={i} className="flex items-start gap-2 text-xs leading-relaxed text-slate-600">
                                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                                {f}
                              </li>
                            ))}
                          </ul>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  )}

                  <div className="mt-auto pt-4">
                    <Button
                      onClick={() => startAdmission(p)}
                      className={`w-full font-extrabold ${
                        p.enrolled
                          ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                          : 'bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]'
                      }`}
                    >
                      {p.enrolled ? (
                        <>ادرس البرنامج <ChevronLeft className="mr-1 h-4 w-4" /></>
                      ) : (
                        <>
                          <ClipboardList className="ml-2 h-4 w-4" />
                          قدّم طلب الالتحاق بالبرنامج
                        </>
                      )}
                    </Button>
                    {!p.enrolled && (
                      <p className="mt-2 text-center text-[10px] font-bold leading-relaxed text-slate-400">
                        بيانات كاملة ← رفع الوثائق ← الإقرار ← رسوم تقديم 30$ ← دراسة الإدارة ← بعد القبول سداد الرسوم الدراسية
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
          {filtered.length === 0 && (
            <div className="col-span-full rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
              <Search className="mx-auto mb-3 h-10 w-10 text-slate-300" />
              <p className="text-sm font-bold text-slate-500">لا توجد برامج مطابقة لبحثك — جرّب كلمة أخرى أو اختر تصنيفاً مختلفاً</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
