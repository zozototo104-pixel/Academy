'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

type Campaign = {
  definitionId: string
  title: string
  seats: number | null
  remaining: number | null
  full: boolean
  programId?: string
  admissionId?: string
  waitlistStatus?: string | null
}

type Availability = { enabled: boolean; campaigns: Campaign[] }

// Public notice shown while a prospective student picks a program in the
// registration form. Seat counts are a live snapshot, never a promise.
export function ScholarshipProgramNotice({ programId }: { programId: string }) {
  const [state, setState] = useState<{ programId: string; data: Availability } | null>(null)
  useEffect(() => {
    if (!programId) return
    let cancelled = false
    fetch('/api/payments/scholarship-availability?programId=' + encodeURIComponent(programId))
      .then((res) => res.json())
      .then((d) => { if (!cancelled) setState({ programId, data: d }) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [programId])
  const data = state && state.programId === programId ? state.data : null
  if (!data?.enabled || !data.campaigns.length) return null
  const campaign = data.campaigns[0]
  return (
    <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3 text-xs font-bold leading-relaxed text-[#0f2b46]">
      <p className="font-black text-emerald-700">منحة متاحة لهذا التخصص: {campaign.title}</p>
      {campaign.full ? (
        <p className="mt-1">مقاعد المنحة ممتلئة مؤقتًا حاليًا. بعد إتمام التسجيل يمكنك الانضمام إلى قائمة الانتظار من لوحة الطالب، وسيصلك تنبيه عند تحرّر مقعد.</p>
      ) : campaign.remaining != null ? (
        <p className="mt-1">المقاعد المتبقية الآن: {campaign.remaining} من {campaign.seats}. هذا العدد لحظي ولا يعني حجز مقعد؛ إصدار المنحة يتم بقرار الإدارة بعد التسجيل.</p>
      ) : (
        <p className="mt-1">إصدار هذه المنحة يتم بقرار الإدارة بعد إتمام التسجيل.</p>
      )}
    </div>
  )
}

// Student card in the payments tab: the campaign covering the student's own
// program, its live seats, and the waitlist join/leave actions when full.
export function ScholarshipCampaignsCard() {
  const { toast } = useToast()
  const [data, setData] = useState<Availability | null>(null)
  const [busy, setBusy] = useState('')

  const load = () => {
    api<Availability>('/api/payments/scholarship-availability')
      .then((d) => setData(d))
      .catch(() => setData(null))
  }
  useEffect(() => { load() }, [])

  const act = async (campaign: Campaign, action: 'JOIN' | 'LEAVE') => {
    setBusy(campaign.definitionId + action)
    try {
      await api('/api/payments/scholarship-availability', {
        method: 'POST',
        body: JSON.stringify({ action, definitionId: campaign.definitionId, admissionId: campaign.admissionId }),
      })
      toast({ title: action === 'JOIN' ? 'تم الانضمام لقائمة الانتظار' : 'تم إلغاء الانضمام' })
      load()
    } catch (e: any) {
      toast({ title: 'تعذر تنفيذ الطلب', description: e.message, variant: 'destructive' })
    } finally {
      setBusy('')
    }
  }

  if (!data?.enabled || !data.campaigns.length) return null
  return (
    <>
      {data.campaigns.map((campaign) => (
        <Card key={campaign.definitionId} className="border-emerald-200 bg-emerald-50/40">
          <CardContent className="space-y-2 p-4">
            <p className="text-sm font-black text-[#0f2b46]">منحة برنامجك: {campaign.title}</p>
            {campaign.waitlistStatus === 'FULFILLED' ? (
              <p className="text-xs font-bold leading-6 text-emerald-700">لديك منحة دراسية سارية على حسابك.</p>
            ) : campaign.full ? (
              <>
                <p className="text-xs font-bold leading-6 text-slate-600">
                  مقاعد هذه المنحة ممتلئة مؤقتًا. الانضمام لقائمة الانتظار لا يحجز مقعدًا، لكنه يضمن تنبيهك عند تحرّر مقعد — والأولوية عند الإصدار لمن يبادر أولًا.
                </p>
                {campaign.waitlistStatus === 'WAITING' || campaign.waitlistStatus === 'NOTIFIED' ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-black text-emerald-700">
                      {campaign.waitlistStatus === 'NOTIFIED' ? 'وصلك تنبيه عن مقعد متاح — بادر بالتواصل مع الإدارة.' : 'أنت مسجل في قائمة الانتظار لهذه المنحة.'}
                    </span>
                    <Button size="sm" variant="outline" disabled={busy === campaign.definitionId + 'LEAVE'} onClick={() => act(campaign, 'LEAVE')}>إلغاء الانضمام</Button>
                  </div>
                ) : (
                  <Button size="sm" disabled={busy === campaign.definitionId + 'JOIN'} onClick={() => act(campaign, 'JOIN')}>انضم لقائمة الانتظار</Button>
                )}
              </>
            ) : (
              <p className="text-xs font-bold leading-6 text-slate-600">
                {campaign.remaining != null
                  ? <>المقاعد المتبقية الآن: {campaign.remaining} من {campaign.seats}. العدد لحظي ولا يعني حجزًا؛ إصدار المنحة بقرار الإدارة.</>
                  : 'إصدار هذه المنحة يتم بقرار الإدارة.'}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </>
  )
}
