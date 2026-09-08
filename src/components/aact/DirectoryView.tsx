'use client'

import { useEffect, useState } from 'react'
import { useAppStore, api } from '@/lib/store'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AcademyLogo } from '@/components/aact/Shell'
import {
  Users, Building2, Globe2, ShieldCheck, Search, BadgeCheck, CalendarDays, MapPin, Crown,
} from 'lucide-react'

interface AccreditedEntry {
  serial: string
  holderName: string
  program: string
  type: string
  country?: string | null
  issuedAt: string
  accreditationType?: string | null
  repName?: string | null
}

interface AgentEntry {
  id: string
  orgName: string
  repName: string
  country: string
  territory?: string | null
  exclusive: boolean
  contractNo?: string | null
  endDate?: string | null
  inDirectory: boolean
}

const ACC_TYPE_LABEL: Record<string, string> = {
  COMPANY: 'هيئة تدريبية',
  CONSULTANT: 'مستشار دولي',
  TRAINER: 'مدرب دولي',
  QUALITY: 'اعتماد جودة',
}

export function DirectoryView() {
  const { navigate } = useAppStore()
  const [loading, setLoading] = useState(true)
  const [accredited, setAccredited] = useState<AccreditedEntry[]>([])
  const [agents, setAgents] = useState<AgentEntry[]>([])
  const [q, setQ] = useState('')

  useEffect(() => {
    api<{ accredited: AccreditedEntry[]; agents: AgentEntry[] }>('/api/directory')
      .then((d) => {
        setAccredited(d.accredited)
        setAgents(d.agents)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const filter = <T extends { holderName?: string; orgName?: string; country?: string; program?: string; repName?: string }>(list: T[]) => {
    const term = q.trim()
    if (!term) return list
    return list.filter((x) =>
      [x.holderName, x.orgName, x.country, x.program, x.repName].filter(Boolean).join(' ').includes(term)
    )
  }

  const filteredAcc = filter(accredited)
  const filteredAgents = filter(agents)

  return (
    <div className="aact-fade-in mx-auto max-w-7xl px-4 py-12">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 w-fit rounded-2xl bg-[#0f2b46] p-4 text-[#e0b83a]">
          <Users className="h-9 w-9" />
        </div>
        <h1 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">الدليل العام للمعتمدين والوكلاء</h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-600">
          دليل عام رسمي لعرض والبحث عن المستشارين والمدربين والهيئات التدريبية المعتمدين من
          الأكاديمية، والوكلاء والممثلين الدوليين — مع رقم شهادة كل معتمد للتحقق الفوري من صحتها.
        </p>
      </div>

      {/* بحث */}
      <div className="relative mx-auto mb-8 max-w-xl">
        <Search className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="ابحث بالاسم أو الدولة أو نوع الاعتماد..."
          className="w-full rounded-full border border-[#0f2b46]/15 bg-white py-3 pl-4 pr-10 text-sm font-bold text-[#0f2b46] shadow-sm outline-none transition-colors focus:border-[#c9a227]"
        />
      </div>

      <Tabs defaultValue="accredited" dir="rtl" className="w-full">
        <TabsList className="mx-auto grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="accredited" className="text-xs font-bold sm:text-sm">
            المعتمدون ({filteredAcc.length})
          </TabsTrigger>
          <TabsTrigger value="agents" className="text-xs font-bold sm:text-sm">
            الوكلاء الدوليون ({filteredAgents.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="accredited">
          {loading ? (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
            </div>
          ) : filteredAcc.length === 0 ? (
            <Card className="mt-6 border-[#0f2b46]/10">
              <CardContent className="p-10 text-center text-sm text-slate-400">
                لا يوجد معتمدون منشورون بعد — تُدرج أسماء المعتمدين بعد دراسة الملف وسداد الرسوم وإصدار الشهادة
              </CardContent>
            </Card>
          ) : (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredAcc.map((c) => (
                <Card key={c.serial} className="aact-card border-[#0f2b46]/10 bg-white">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="rounded-xl bg-[#0f2b46] p-2.5 text-[#e0b83a]">
                        <BadgeCheck className="h-5 w-5" />
                      </div>
                      {c.accreditationType && (
                        <Badge variant="outline" className="border-[#c9a227]/50 text-[10px] font-bold text-[#a8841a]">
                          {ACC_TYPE_LABEL[c.accreditationType] || c.accreditationType}
                        </Badge>
                      )}
                    </div>
                    <h3 className="mt-3 text-sm font-black text-[#0f2b46]">{c.holderName}</h3>
                    <p className="mt-1 line-clamp-2 min-h-8 text-[11px] font-bold text-slate-500">{c.program}</p>
                    <div className="mt-3 space-y-1.5 text-[11px] text-slate-500">
                      {c.country && (
                        <p className="flex items-center gap-1.5"><MapPin className="h-3 w-3 text-[#c9a227]" /> {c.country}</p>
                      )}
                      <p className="flex items-center gap-1.5">
                        <CalendarDays className="h-3 w-3 text-[#c9a227]" />
                        اعتماد منذ {new Date(c.issuedAt).toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' })}
                      </p>
                    </div>
                    <button
                      onClick={() => navigate('verify')}
                      className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#f7edd0] py-2 text-[11px] font-black text-[#a8841a] transition-colors hover:bg-[#f0e2bd]"
                    >
                      <ShieldCheck className="h-3.5 w-3.5" /> تحقق من الشهادة
                      <span className="font-mono text-[9px]" dir="ltr">({c.serial})</span>
                    </button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="agents">
          {loading ? (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-44 rounded-2xl" />)}
            </div>
          ) : filteredAgents.length === 0 ? (
            <Card className="mt-6 border-[#0f2b46]/10">
              <CardContent className="p-10 text-center text-sm text-slate-400">
                لا يوجد وكلاء دوليون منشورون بعد — <button className="font-bold text-[#a8841a] hover:underline" onClick={() => navigate('agent')}>قدّم طلب وكالة</button>
              </CardContent>
            </Card>
          ) : (
            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredAgents.map((a) => (
                <Card key={a.id} className="aact-card border-[#0f2b46]/10 bg-white">
                  <CardContent className="p-5">
                    <div className="flex items-start justify-between">
                      <div className="rounded-xl bg-[#0f2b46] p-2.5 text-[#e0b83a]">
                        <Globe2 className="h-5 w-5" />
                      </div>
                      {a.exclusive && (
                        <Badge className="bg-[#b22234] text-[10px] text-white hover:bg-[#b22234]">
                          <Crown className="ml-1 h-3 w-3" /> تمثيل حصري
                        </Badge>
                      )}
                    </div>
                    <h3 className="mt-3 text-sm font-black text-[#0f2b46]">{a.orgName}</h3>
                    <p className="mt-1 text-[11px] font-bold text-slate-500">الممثل المعتمد: {a.repName}</p>
                    <div className="mt-3 space-y-1.5 text-[11px] text-slate-500">
                      <p className="flex items-center gap-1.5">
                        <MapPin className="h-3 w-3 text-[#c9a227]" /> نطاق التمثيل: {a.territory || a.country}
                      </p>
                      {a.endDate && (
                        <p className="flex items-center gap-1.5">
                          <CalendarDays className="h-3 w-3 text-[#c9a227]" />
                          العقد ساري حتى {new Date(a.endDate).toLocaleDateString('ar-EG')}
                        </p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* شريط دعوة */}
      <Card className="mt-10 border-[#c9a227]/40 bg-[#f7edd0]/50">
        <CardContent className="flex flex-col items-center gap-4 p-6 text-center sm:flex-row sm:text-right">
          <div className="rounded-2xl bg-[#0f2b46] p-3 text-[#e0b83a]">
            <Building2 className="h-7 w-7" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-black text-[#0f2b46]">هل تريد الظهور في الدليل؟</h3>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              قدّم طلب اعتماد كمستشار أو مدرب أو هيئة تدريبية — أو احصل على وكالة دولية حصرية،
              وبعد دراسة الملف وإصدار الشهادة سيظهر اسمك هنا تلقائياً.
            </p>
          </div>
          <Button onClick={() => navigate('agent')} className="shrink-0 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
            قدّم طلبك الآن
          </Button>
        </CardContent>
      </Card>

      <div className="mt-8 flex items-center justify-center gap-2 text-[11px] text-slate-400">
        <AcademyLogo size={22} />
        الدليل الرسمي للأكاديمية الأمريكية للاستشارات والتدريب — يُحدَّث تلقائياً مع كل اعتماد جديد
      </div>
    </div>
  )
}
