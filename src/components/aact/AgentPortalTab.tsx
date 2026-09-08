'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useAppStore } from '@/lib/store'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { CertificateDialog, CertificateData } from '@/components/aact/CertificateDialog'
import {
  ScrollText, Percent, Banknote, CalendarClock, Loader2, MapPin, ShieldAlert,
  Award, AlarmClock, Handshake, Gavel, Upload, Ban,
} from 'lucide-react'

interface Share {
  id: string
  type: string
  description: string
  amount: number
  status: string
  dueDate?: string | null
  paidAt?: string | null
  createdAt: string
}

interface PortalData {
  contract: {
    contractNo?: string | null
    orgName: string
    repName: string
    territory?: string | null
    exclusive: boolean
    commissionRate?: number | null
    committeeFee?: number | null
    startDate?: string | null
    endDate?: string | null
    kind: string
    accreditationType?: string | null
    country: string
  }
  shares: Share[]
  certificates: CertificateData[]
  totals: { due: number; paid: number; dueCount: number }
  nextDueDate?: string | null
}

export function AgentPortalTab() {
  const { user, navigate } = useAppStore()
  const { toast } = useToast()
  const [portal, setPortal] = useState<PortalData | null>(null)
  const [loading, setLoading] = useState(true)
  const [cert, setCert] = useState<CertificateData | null>(null)
  const [certOpen, setCertOpen] = useState(false)

  useEffect(() => {
    api<{ portal: PortalData | null }>('/api/agent-portal')
      .then((d) => setPortal(d.portal))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [user?.id])

  if (!user) {
    return (
      <Card className="mt-6 border-[#c9a227]/40 bg-[#f7edd0]/40">
        <CardContent className="p-8 text-center">
          <Handshake className="mx-auto mb-3 h-10 w-10 text-[#a8841a]" />
          <h3 className="text-base font-black text-[#0f2b46]">بوابة الوكيل والمعتمدين</h3>
          <p className="mx-auto mt-2 max-w-md text-xs leading-relaxed text-slate-600">
            سجّل الدخول بنفس البريد الذي قدّمت به طلب الوكالة أو الاعتماد لعرض عقدك ونطاق
            التمثيل والعمولات والمستحقات المالية وشهادتك الرقمية.
          </p>
          <Button onClick={() => navigate('auth')} className="mt-4 bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
            تسجيل الدخول
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (loading) {
    return <div className="flex h-40 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
  }

  if (!portal) {
    return (
      <Card className="mt-6 border-[#0f2b46]/10">
        <CardContent className="p-8 text-center text-sm text-slate-500">
          لا توجد وكالة أو اعتماد معتمد مرتبط بحسابك ({user.email}) بعد.
          <br />
          تُفتح البوابة تلقائياً بعد اعتماد طلبك من إدارة الأكاديمية.
        </CardContent>
      </Card>
    )
  }

  const { contract, shares, certificates, totals, nextDueDate } = portal
  const endSoon = contract.endDate
    ? (new Date(contract.endDate).getTime() - Date.now()) / 86400000 < 60
    : false

  return (
    <div className="mt-6 space-y-5">
      {/* تنبيه المستحقات (14 يوماً) */}
      {totals.due > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <AlarmClock className="h-6 w-6 shrink-0 text-amber-600" />
          <div className="flex-1 text-xs font-bold text-amber-800">
            لديك مستحقات معلقة بمبلغ <span className="font-black">{totals.due}$</span>
            {nextDueDate ? ` — موعد التحويل للأكاديمية: ${new Date(nextDueDate).toLocaleDateString('ar-EG')} (خلال 14 يوماً من تاريخ طلب إصدار الشهادات وفق العقد)` : ''}
          </div>
        </div>
      )}

      {/* بطاقة العقد */}
      <Card className="border-[#0f2b46]/15 shadow-md">
        <CardContent className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="rounded-2xl bg-[#0f2b46] p-3 text-[#e0b83a]">
                <ScrollText className="h-6 w-6" />
              </span>
              <div>
                <h3 className="text-base font-black text-[#0f2b46]">اتفاقية التمثيل والتفويض الدولي</h3>
                {contract.contractNo && (
                  <p className="font-mono text-xs font-bold text-[#a8841a]" dir="ltr">{contract.contractNo}</p>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {contract.kind === 'AGENCY' && (
                <Badge className="bg-[#b22234] text-white hover:bg-[#b22234]">
                  {contract.exclusive ? 'تمثيل حصري' : 'تمثيل غير حصري'}
                </Badge>
              )}
              <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">عقد ساري</Badge>
            </div>
          </div>

          <div className="mt-5 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl bg-[#f7edd0]/50 p-3.5">
              <p className="flex items-center gap-1.5 font-bold text-slate-400"><MapPin className="h-3.5 w-3.5" /> النطاق الجغرافي</p>
              <p className="mt-1 font-black text-[#0f2b46]">{contract.territory || contract.country}</p>
            </div>
            <div className="rounded-xl bg-[#f7edd0]/50 p-3.5">
              <p className="flex items-center gap-1.5 font-bold text-slate-400"><Percent className="h-3.5 w-3.5" /> عمولة البرامج</p>
              <p className="mt-1 font-black text-[#0f2b46]">{contract.commissionRate ?? 25}% من إيرادات البرامج التدريبية</p>
            </div>
            <div className="rounded-xl bg-[#f7edd0]/50 p-3.5">
              <p className="flex items-center gap-1.5 font-bold text-slate-400"><Gavel className="h-3.5 w-3.5" /> مستحقات اللجان</p>
              <p className="mt-1 font-black text-[#0f2b46]">{contract.committeeFee ?? 100}$ لكل بحث تخرج تشارك في لجنته</p>
            </div>
            <div className="rounded-xl bg-[#f7edd0]/50 p-3.5">
              <p className="flex items-center gap-1.5 font-bold text-slate-400"><CalendarClock className="h-3.5 w-3.5" /> مدة العقد</p>
              <p className="mt-1 font-black text-[#0f2b46]">
                {contract.startDate ? new Date(contract.startDate).toLocaleDateString('ar-EG') : '—'}
                {' ← '}
                {contract.endDate ? new Date(contract.endDate).toLocaleDateString('ar-EG') : '—'}
              </p>
            </div>
          </div>

          {/* تنبيهات التجديد وعدم النسخ */}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {endSoon && (
              <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-[11px] font-bold leading-relaxed text-amber-700">
                <CalendarClock className="ml-1 inline h-4 w-4" />
                عقدك يقترب من الانتهاء — التجديد تلقائي ما لم يُبلغ أحد الطرفين الآخر بعدم التجديد خلال (30-60 يوماً) قبل الانتهاء.
              </div>
            )}
            <div className="rounded-xl border border-red-200 bg-red-50/50 p-3 text-[11px] font-bold leading-relaxed text-red-700 sm:col-start-2">
              <Ban className="ml-1 inline h-4 w-4" />
              يُمنع تعديل أو تكرار أو إعادة إنتاج أي مواد تدريبية أو شهادات دون موافقة كتابية من الأكاديمية.
            </div>
          </div>
        </CardContent>
      </Card>

      {/* الملخص المالي */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-amber-200">
          <CardContent className="p-4 text-center">
            <Banknote className="mx-auto mb-1.5 h-5 w-5 text-amber-600" />
            <p className="text-lg font-black text-[#0f2b46]">{totals.due}$</p>
            <p className="text-[10px] font-bold text-slate-500">مستحقات معلقة</p>
          </CardContent>
        </Card>
        <Card className="border-emerald-200">
          <CardContent className="p-4 text-center">
            <Banknote className="mx-auto mb-1.5 h-5 w-5 text-emerald-600" />
            <p className="text-lg font-black text-[#0f2b46]">{totals.paid}$</p>
            <p className="text-[10px] font-bold text-slate-500">مستحقات محوّلة</p>
          </CardContent>
        </Card>
        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-4 text-center">
            <Award className="mx-auto mb-1.5 h-5 w-5 text-[#a8841a]" />
            <p className="text-lg font-black text-[#0f2b46]">{certificates.length}</p>
            <p className="text-[10px] font-bold text-slate-500">شهادات معتمدة</p>
          </CardContent>
        </Card>
      </div>

      {/* سجل المستحقات */}
      <Card className="border-[#0f2b46]/10">
        <CardContent className="p-0">
          <h3 className="border-b border-slate-100 p-4 text-sm font-black text-[#0f2b46]">سجل العمولات والمستحقات</h3>
          <div className="aact-scroll max-h-72 overflow-y-auto">
            {shares.length === 0 ? (
              <p className="p-8 text-center text-xs text-slate-400">
                لا توجد مستحقات مسجلة بعد — تُسجل العمولة (25%) عن البرامج المنفذة في نطاقك و100$ عن كل لجنة مناقشة تشارك بها
              </p>
            ) : (
              shares.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-50 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className={`text-[10px] font-bold ${s.type === 'COMMITTEE_FEE' ? 'border-blue-200 text-blue-600' : 'border-[#c9a227]/50 text-[#a8841a]'}`}>
                        {s.type === 'COMMITTEE_FEE' ? 'لجنة مناقشة' : `عمولة ${contract.commissionRate ?? 25}%`}
                      </Badge>
                      <span className="text-xs font-bold text-[#0f2b46]">{s.description}</span>
                    </div>
                    {s.dueDate && (
                      <p className="mt-1 text-[10px] text-slate-400">
                        موعد التحويل: {new Date(s.dueDate).toLocaleDateString('ar-EG')}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-black text-[#0f2b46]">{s.amount}$</span>
                    {s.status === 'PAID' ? (
                      <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">محوّل</Badge>
                    ) : (
                      <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">معلق</Badge>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>

      {/* الشهادات */}
      {certificates.length > 0 && (
        <Card className="border-[#c9a227]/40 bg-[#f7edd0]/40">
          <CardContent className="p-5">
            <h3 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
              <Award className="h-5 w-5 text-[#a8841a]" /> شهاداتك الرقمية
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              {certificates.map((c) => (
                <div key={c.serial} className="rounded-xl bg-white p-4">
                  <p className="text-xs font-black text-[#0f2b46]">{c.program}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-slate-400" dir="ltr">{c.serial}</p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 w-full border-[#c9a227] font-bold text-[#a8841a]"
                    onClick={() => { setCert(c); setCertOpen(true) }}
                  >
                    عرض وطباعة
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* رفع بيانات المتدربين */}
      <Card className="border-[#0f2b46]/10">
        <CardContent className="flex flex-wrap items-center gap-4 p-5">
          <span className="rounded-xl bg-[#0f2b46] p-2.5 text-[#e0b83a]"><Upload className="h-5 w-5" /></span>
          <div className="flex-1">
            <h3 className="text-sm font-black text-[#0f2b46]">رفع بيانات المتدربين وكشوف الحضور</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              تُرفع وفق النماذج الرسمية المعتمدة من الأكاديمية عبر واتساب أو البريد الرسمي —
              ثم تُسجل العمولات هنا تلقائياً بعد اعتماد الإدارة.
            </p>
          </div>
          <Button variant="outline" className="border-[#0f2b46]/20 font-bold text-[#0f2b46]" onClick={() => navigate('contact')}>
            طلب النماذج الرسمية
          </Button>
        </CardContent>
      </Card>

      <CertificateDialog certificate={cert} open={certOpen} onClose={() => setCertOpen(false)} />
    </div>
  )
}
