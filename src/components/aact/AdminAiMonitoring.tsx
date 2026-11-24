'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Loader2, RefreshCw } from 'lucide-react'

// Step 8 — monitoring dashboard for auto AI provider/model management.
// Arabic RTL. Reads ONLY from GET /api/admin/ai-monitoring (which makes
// no live provider calls); the toggle writes through the SAME
// PATCH /api/admin/system as the switch in AdminSystemTab, so a switch
// here is recorded in the AI_AUTO_MODE_TRANSITIONS log too — one source
// of truth (AI_AUTO_MODE_ENABLED), never a second toggle.

type CostTier = 'free' | 'paid' | 'unknown'
type ScoreComponents = {
  quality: number
  recentSuccess: number
  adherence: number
  latency: number
  quota: number
  cost: number
}
type MonitoringCandidate = {
  provider: string
  model: string
  score: number | null
  components: ScoreComponents | null
  excludedReason: string | null
  costTier: CostTier
  balance: 'unknown'
}
type MonitoringRanking = {
  purpose: string
  computedAt: string | null
  top: MonitoringCandidate | null
  candidates: MonitoringCandidate[]
}
type Transition = { at: string; from: 'auto' | 'manual'; to: 'auto' | 'manual' }
type FailoverRow = {
  id: string
  createdAt: string
  stage: string
  provider: string | null
  model: string | null
  success: boolean
  failureCategory: string | null
  fallbackUsed: boolean
  latencyMs: number | null
  bookId: string | null
  unitId: string | null
}
type MonitoringData = {
  mode: { auto: boolean; value: string }
  rankings: MonitoringRanking[]
  health: { provider: string; model: string; status: string; purposeScores?: Record<string, number> }[]
  routerState: { provider: string; type: string; model?: string | null; keyIndex?: number | null; until?: string | null; reason?: string | null }[]
  diagnostics: { activeProvider?: string | null; selectedProvider?: string; policy?: string; message?: string } | null
  lastRefresh: { lastProvider?: string; lastRunAt?: number; results?: Record<string, { discoveryOk: boolean; models: number; at: number; lastError?: string }> }
  lastCapabilityCheck: { at: string; providers: { provider: string; probedAt: string }[] } | null
  transitions: Transition[]
  failovers: FailoverRow[]
  voiceNote: string
}

const PURPOSE_LABELS: Record<string, string> = {
  CHAT: 'المحادثة',
  ANALYSIS: 'التحليل',
  GENERATION: 'التوليد',
  GRADING: 'التصحيح',
  VISION: 'الرؤية / OCR',
  LONG_CONTEXT: 'السياق الطويل',
  REVIEW: 'التدقيق',
}

function fmtDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  try {
    return new Intl.DateTimeFormat('ar', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return '—'
  }
}

function costBadge(candidate: MonitoringCandidate) {
  // UNKNOWN honesty: an undocumented provider is NEVER labelled free.
  // Unknown-cost models get a distinct amber badge; FREE is green and
  // PAID is rose, so the three can never be confused at a glance.
  if (candidate.costTier === 'free') return <Badge className="bg-emerald-100 text-emerald-700">مجاني</Badge>
  if (candidate.costTier === 'paid') return <Badge className="bg-rose-100 text-rose-700">مدفوع</Badge>
  return <Badge className="bg-amber-100 text-amber-800">التكلفة غير معروفة</Badge>
}

export function AdminAiMonitoring() {
  const { toast } = useToast()
  const [data, setData] = useState<MonitoringData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [toggling, setToggling] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const d = await api<MonitoringData>('/api/admin/ai-monitoring')
      setData(d)
    } catch (e: any) {
      setError(e?.message || 'تعذر تحميل لوحة المراقبة')
    } finally {
      setLoading(false)
    }
  }, [])

  // Mount load: state is set only in the async callbacks (never
  // synchronously in the effect body) — the same shape as
  // AdminAiStageProfiles, so the react-hooks/set-state-in-effect rule
  // stays quiet. `load` above is for the refresh button / toggle.
  useEffect(() => {
    let cancelled = false
    api<MonitoringData>('/api/admin/ai-monitoring')
      .then((d) => { if (!cancelled) setData(d) })
      .catch((e: any) => { if (!cancelled) setError(e?.message || 'تعذر تحميل لوحة المراقبة') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  // The dashboard toggle writes through the SAME PATCH as AdminSystemTab
  // (one source of truth: AI_AUTO_MODE_ENABLED), so the switch is
  // recorded in the transitions log by the server.
  const toggleAuto = async (next: boolean) => {
    setToggling(true)
    try {
      await api('/api/admin/system', {
        method: 'PATCH',
        body: JSON.stringify({ AI_AUTO_MODE_ENABLED: next ? '1' : '0' }),
      })
      toast({ title: next ? 'تم تفعيل الوضع التلقائي' : 'تم إيقاف الوضع التلقائي', description: 'سُجّل التبديل في سجل التبديلات أدناه.' })
      await load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e?.message || 'تعذر تغيير الوضع', variant: 'destructive' })
    } finally {
      setToggling(false)
    }
  }

  if (loading && !data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-10 text-sm font-bold text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" /> جارٍ تحميل لوحة مراقبة الذكاء…
        </CardContent>
      </Card>
    )
  }

  if (error && !data) {
    return (
      <Card>
        <CardContent className="space-y-3 py-6">
          <p className="text-sm font-bold text-rose-600">{error}</p>
          <Button type="button" variant="outline" size="sm" onClick={load}>إعادة المحاولة</Button>
        </CardContent>
      </Card>
    )
  }

  const lastRefreshAt = data?.lastRefresh?.lastRunAt ? fmtDate(data.lastRefresh.lastRunAt) : 'لم يحدث بعد'
  const lastRefreshProvider = data?.lastRefresh?.lastProvider || '—'
  // Null-safe lists: the guards below read these locals, so TypeScript can
  // narrow them — `data` itself stays `MonitoringData | null` until loaded.
  const health = data?.health ?? []
  const routerState = data?.routerState ?? []
  const transitions = data?.transitions ?? []
  const failovers = data?.failovers ?? []

  return (
    <div className="space-y-4" dir="rtl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-black text-slate-900">مراقبة الوضع التلقائي للمزودين والنماذج</h3>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            أي نموذج يخدم كل مهمة الآن، ولماذا اختير أو استُبعد، وحالة الصحة والحصة والتبريد — دون أي اتصال مباشر بالمزودين من هذه الصفحة.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> تحديث
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div>
            <p className="text-sm font-black text-slate-900">
              الوضع الحالي: {data?.mode.auto ? 'تلقائي — النظام يختار المزود والنموذج لكل مهمة' : 'يدوي — ترتيبك اليدوي هو المعمول به'}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
              نفس المفتاح الموجود في إعدادات النظام (AI_AUTO_MODE_ENABLED) — إطفاؤه يعيد ترتيبك اليدوي فوراً دون تغييره. الصوت/Live لا يخضع للاختيار التلقائي: {data?.voiceNote || 'الصوت بروتوكول أصلي — لا يُختار تلقائياً'}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-600">{data?.mode.auto ? 'تلقائي' : 'يدوي'}</span>
            <Switch checked={!!data?.mode.auto} disabled={toggling} onCheckedChange={toggleAuto} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-2 py-4 text-xs font-bold text-slate-700 sm:grid-cols-2">
          <p>آخر تحديث لقوائم النماذج: {lastRefreshAt}{data?.lastRefresh?.lastProvider ? ` — آخر مزود: ${lastRefreshProvider}` : ''}</p>
          <p>آخر فحص للقدرات: {data?.lastCapabilityCheck ? fmtDate(data.lastCapabilityCheck.at) : 'لم يُسجَّل بعد — لم يعمل فحص قدرات حتى الآن'}</p>
          <p>المزود النشط حسب التشخيص: {data?.diagnostics?.activeProvider || '—'} — السياسة: {data?.diagnostics?.policy || '—'}</p>
          <p>{data?.diagnostics?.message || ''}</p>
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {(data?.rankings || []).map((ranking) => (
          <Card key={ranking.purpose}>
            <CardContent className="space-y-2 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-black text-slate-900">{PURPOSE_LABELS[ranking.purpose] || ranking.purpose}</p>
                <span className="text-[10px] font-bold text-slate-400">{ranking.computedAt ? `حُسب في ${fmtDate(ranking.computedAt)}` : 'لم يُحسب بعد'}</span>
              </div>
              {ranking.top ? (
                <p className="text-xs font-bold text-emerald-700">
                  الأفضل الآن: {ranking.top.provider}:{ranking.top.model}
                  {typeof ranking.top.score === 'number' ? ` — النتيجة ${ranking.top.score}` : ''}
                </p>
              ) : (
                <p className="text-xs font-bold text-slate-500">لا يوجد نموذج مؤهل بعد لهذه المهمة — يعمل الراوتر بالترتيب اليدوي.</p>
              )}
              {ranking.candidates.length === 0 ? (
                <p className="text-[11px] text-slate-400">لا توجد قائمة ترتيب محفوظة لهذه المهمة بعد.</p>
              ) : (
                <ul className="space-y-1.5">
                  {ranking.candidates.slice(0, 6).map((candidate) => (
                    <li key={`${candidate.provider}:${candidate.model}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
                      <span className="text-[11px] font-bold text-slate-800" dir="ltr">{candidate.provider}:{candidate.model}</span>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {costBadge(candidate)}
                        {typeof candidate.score === 'number' && <Badge className="bg-slate-100 text-slate-600">{candidate.score}</Badge>}
                        {candidate.excludedReason
                          ? <Badge className="bg-rose-50 text-rose-700">مستبعد: {candidate.excludedReason}</Badge>
                          : <Badge className="bg-emerald-50 text-emerald-700">مؤهل</Badge>}
                      </span>
                      {candidate.components && (
                        <span className="w-full text-[10px] font-bold text-slate-500">
                          جودة {candidate.components.quality} · نجاح أخير {candidate.components.recentSuccess} · التزام {candidate.components.adherence} · زمن {candidate.components.latency} · حصة {candidate.components.quota} · تكلفة {candidate.components.cost}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[10px] leading-relaxed text-slate-400">الرصيد: غير معروف لكل النماذج — لا توجد واجهة رصيد لدى أي مزود، والحصة تُستدل من أخطاء 402/429 والتبريد فقط.</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardContent className="space-y-2 py-4">
          <p className="text-sm font-black text-slate-900">الصحة والتبريد</p>
          {health.length === 0 && routerState.length === 0 ? (
            <p className="text-xs font-bold text-slate-500">لا توجد بيانات صحة أو تبريد مسجلة بعد — ستظهر هنا بعد أول فحص صحة أو أول محاولة راوتر.</p>
          ) : (
            <>
              {routerState.length > 0 && (
                <ul className="space-y-1">
                  {routerState.slice(0, 10).map((item, index) => (
                    <li key={index} className="text-[11px] font-bold text-slate-700">
                      {item.provider} — {item.type}{item.model ? ` — ${item.model}` : ''}{item.until ? ` — حتى ${fmtDate(item.until)}` : ''}{item.reason ? ` — ${item.reason}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {health.length > 0 && (
                <ul className="space-y-1">
                  {health.slice(0, 10).map((row) => (
                    <li key={`${row.provider}:${row.model}`} className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold text-slate-700">
                      <span dir="ltr">{row.provider}:{row.model}</span>
                      <Badge className={row.status === 'شغّال' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-800'}>{row.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-2 py-4">
            <p className="text-sm font-black text-slate-900">سجل التبديلات (تلقائي ↔ يدوي)</p>
            {transitions.length === 0 ? (
              <p className="text-xs font-bold text-slate-500">لم يبدّل أحد الوضع بعد — أول تبديل سيظهر هنا.</p>
            ) : (
              <ul className="space-y-1">
                {transitions.map((entry, index) => (
                  <li key={index} className="text-[11px] font-bold text-slate-700">
                    {fmtDate(entry.at)} — من {entry.from === 'auto' ? 'تلقائي' : 'يدوي'} إلى {entry.to === 'auto' ? 'تلقائي' : 'يدوي'}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-2 py-4">
            <p className="text-sm font-black text-slate-900">سجل التحويل الاحتياطي (آخر 50)</p>
            {failovers.length === 0 ? (
              <p className="text-xs font-bold text-slate-500">لم يحدث تحويل احتياطي مسجل بعد — ستظهر هنا التشغيلات التي استخدمت نموذجاً بديلاً بعد فشل الأول.</p>
            ) : (
              <ul className="space-y-1">
                {failovers.slice(0, 10).map((row) => (
                  <li key={row.id} className="text-[11px] font-bold text-slate-700">
                    {fmtDate(row.createdAt)} — {row.stage} — {row.provider || '—'}:{row.model || '—'} — {row.success ? 'نجح بعد التحويل' : `فشل (${row.failureCategory || 'غير مصنف'})`}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
