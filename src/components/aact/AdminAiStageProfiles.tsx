'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Loader2, RefreshCw, RotateCcw, Save } from 'lucide-react'

type Stage = 'READING' | 'ANALYSIS' | 'GENERATION' | 'REVIEW'
type ModelRef = { provider: string; model: string }
type Snapshot = {
  enabled: boolean
  provider: string | null
  policy: string | null
  models: ModelRef[]
  allowGlobalFallback: boolean
  verifier: { preferred: ModelRef[]; strict: boolean } | null
}
type StageData = {
  stage: Stage
  current: { profileId: string; version: number; snapshot: Snapshot } | null
  versions: { version: number; snapshot: Snapshot; createdBy: string | null; createdAt: string }[]
  stats: { runs: number; successes: number; failures: number; fallbacks: number }
  recentLogs: {
    id: string
    createdAt: string
    profileId: string | null
    profileVersion: string | null
    provider: string | null
    model: string | null
    policy: string | null
    success: boolean
    failureCategory: string | null
    fallbackUsed: boolean
    latencyMs: number | null
    outputCount: number | null
    bookId: string | null
    unitId: string | null
  }[]
}
type AdvisorStageReadiness = {
  stage: Stage
  totalRuns: number
  successRuns: number
  failureRuns: number
  fallbackRuns: number
  windowDays: number
  tokenCoverage: number
  costCoverage: number
  operationsGap: number
  daysGap: number
  costCoverageGap: number
  readyForAdvice: boolean
  gaps: string[]
}
type AdvisorReadiness = {
  generatedAt: string
  gates: { minDays: number; minStageRuns: number; costCoverageTarget: number }
  stages: AdvisorStageReadiness[]
  readyStages: Stage[]
  blockedStages: Stage[]
  allStagesReady: boolean
  notes: string[]
}
type AdvisorAdvice = {
  id: string
  stage: Stage
  category: string
  severity: string
  status: string
  title: string
  rationale: string
  evidence: Record<string, unknown>
  proposedSnapshot: Snapshot | null
  createdAt: string
}
type ResponseData = { stages: StageData[]; providers: string[]; policies: string[]; advisorReadiness?: AdvisorReadiness; advisorAdvice?: AdvisorAdvice[] }
type FormState = {
  enabled: boolean
  provider: string
  policy: string
  modelsText: string
  allowGlobalFallback: boolean
  verifierText: string
  verifierStrict: boolean
}

const STAGE_LABELS: Record<Stage, string> = {
  READING: 'القراءة',
  ANALYSIS: 'التحليل',
  GENERATION: 'التوليد',
  REVIEW: 'التدقيق',
}

const STAGE_DESCRIPTIONS: Record<Stage, string> = {
  READING: 'قراءة الكتاب واستخراج النص/المحتوى.',
  ANALYSIS: 'تحليل المحتوى وتحويله إلى مفاهيم ووحدات قابلة للاستخدام.',
  GENERATION: 'توليد الأسئلة من المعرفة المستخرجة.',
  REVIEW: 'تدقيق الأسئلة قبل المراجعة البشرية النهائية.',
}

const emptySnapshot: Snapshot = {
  enabled: false,
  provider: null,
  policy: null,
  models: [],
  allowGlobalFallback: true,
  verifier: null,
}

function refsToText(refs: ModelRef[]): string {
  return refs.map((ref) => `${ref.provider}:${ref.model}`).join('\n')
}

function textToRefs(text: string): ModelRef[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const colon = line.indexOf(':')
      if (colon <= 0 || colon === line.length - 1) {
        throw new Error(`السطر ${index + 1}: اكتب الموديل بصيغة PROVIDER:model`)
      }
      return { provider: line.slice(0, colon).trim(), model: line.slice(colon + 1).trim() }
    })
}

function snapshotToForm(snapshot: Snapshot | null): FormState {
  const source = snapshot ?? emptySnapshot
  return {
    enabled: source.enabled,
    provider: source.provider ?? '',
    policy: source.policy ?? '',
    modelsText: refsToText(source.models),
    allowGlobalFallback: source.allowGlobalFallback,
    verifierText: refsToText(source.verifier?.preferred ?? []),
    verifierStrict: source.verifier?.strict ?? false,
  }
}

function formToSnapshot(stage: Stage, form: FormState): Snapshot {
  const verifierPreferred = stage === 'REVIEW' ? textToRefs(form.verifierText) : []
  return {
    enabled: form.enabled,
    provider: form.provider || null,
    policy: form.policy || null,
    models: textToRefs(form.modelsText),
    allowGlobalFallback: form.allowGlobalFallback,
    verifier: stage === 'REVIEW' ? { preferred: verifierPreferred, strict: form.verifierStrict } : null,
  }
}

function fmtDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  try {
    return new Intl.DateTimeFormat('ar', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value))
  } catch {
    return String(value)
  }
}

function shortModel(provider?: string | null, model?: string | null): string {
  if (!provider && !model) return '—'
  return `${provider ?? '—'} / ${model ?? '—'}`
}

function currentVersionLabel(stage: StageData): string {
  if (!stage.current) return 'لا يوجد بروفايل محفوظ'
  return `نسخة ${stage.current.version}`
}

function successRate(stats: StageData['stats']): string {
  if (!stats.runs) return '—'
  return `${Math.round((stats.successes / stats.runs) * 100)}%`
}

function fallbackRate(stats: StageData['stats']): string {
  if (!stats.runs) return '—'
  return `${Math.round((stats.fallbacks / stats.runs) * 100)}%`
}

function formatPct(value: number | null | undefined): string {
  if (value == null) return '—'
  return `${Math.round(value * 100)}%`
}

function readinessBadge(stage: AdvisorStageReadiness) {
  if (stage.readyForAdvice) return { label: 'جاهزة للمرحلة التالية', className: 'bg-green-100 text-green-800' }
  return { label: 'بيانات غير كافية', className: 'bg-amber-100 text-amber-800' }
}

function adviceSeverityBadge(severity: string) {
  if (severity === 'CRITICAL') return { label: 'حرجة', className: 'bg-red-100 text-red-800' }
  if (severity === 'WARNING') return { label: 'تحذير', className: 'bg-amber-100 text-amber-800' }
  return { label: 'معلومة', className: 'bg-blue-100 text-blue-800' }
}

function formsFromResponse(res: ResponseData): Record<Stage, FormState> {
  return Object.fromEntries(
    res.stages.map((stage) => [stage.stage, snapshotToForm(stage.current?.snapshot ?? null)]),
  ) as Record<Stage, FormState>
}

function snapshotKey(snapshot: Snapshot): string {
  return JSON.stringify({
    enabled: snapshot.enabled,
    provider: snapshot.provider ?? null,
    policy: snapshot.policy ?? null,
    models: snapshot.models.map((m) => `${m.provider}:${m.model}`),
    allowGlobalFallback: snapshot.allowGlobalFallback,
    verifier: snapshot.verifier
      ? {
          preferred: snapshot.verifier.preferred.map((m) => `${m.provider}:${m.model}`),
          strict: snapshot.verifier.strict,
        }
      : null,
  })
}

function describeSnapshotDiff(before: Snapshot, after: Snapshot, stage: Stage): string[] {
  const changes: string[] = []
  if (before.enabled !== after.enabled) changes.push(`التفعيل: ${before.enabled ? 'مفعّل' : 'يرجع للعام'} ← ${after.enabled ? 'مفعّل' : 'يرجع للعام'}`)
  if ((before.provider ?? '') !== (after.provider ?? '')) changes.push(`المزوّد: ${before.provider || 'بدون'} ← ${after.provider || 'بدون'}`)
  if ((before.policy ?? '') !== (after.policy ?? '')) changes.push(`السياسة: ${before.policy || 'افتراضي'} ← ${after.policy || 'افتراضي'}`)
  if (refsToText(before.models) !== refsToText(after.models)) changes.push(`موديلات المرحلة: ${before.models.length} ← ${after.models.length}`)
  if (before.allowGlobalFallback !== after.allowGlobalFallback) changes.push(`الرجوع للعام: ${before.allowGlobalFallback ? 'مسموح' : 'ممنوع'} ← ${after.allowGlobalFallback ? 'مسموح' : 'ممنوع'}`)
  if (stage === 'REVIEW') {
    if (refsToText(before.verifier?.preferred ?? []) !== refsToText(after.verifier?.preferred ?? [])) {
      changes.push(`قائمة المدقق: ${before.verifier?.preferred.length ?? 0} ← ${after.verifier?.preferred.length ?? 0}`)
    }
    if ((before.verifier?.strict ?? false) !== (after.verifier?.strict ?? false)) {
      changes.push(`وضع التدقيق الصارم: ${before.verifier?.strict ? 'مفعّل' : 'معطّل'} ← ${after.verifier?.strict ? 'مفعّل' : 'معطّل'}`)
    }
  }
  return changes
}

export function AdminAiStageProfiles() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [savingStage, setSavingStage] = useState<Stage | null>(null)
  const [generatingAdvisorAdvice, setGeneratingAdvisorAdvice] = useState(false)
  const [dismissingAdvisorAdviceId, setDismissingAdvisorAdviceId] = useState<string | null>(null)
  const [data, setData] = useState<ResponseData | null>(null)
  const [forms, setForms] = useState<Record<Stage, FormState> | null>(null)

  const applyResponse = useCallback((res: ResponseData) => {
    setData(res)
    setForms(formsFromResponse(res))
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<ResponseData>('/api/admin/ai-stage-profiles')
      applyResponse(res)
    } catch (error: any) {
      toast({ title: 'تعذر تحميل بروفايلات الذكاء', description: error?.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [applyResponse, toast])

  useEffect(() => {
    let cancelled = false
    api<ResponseData>('/api/admin/ai-stage-profiles')
      .then((res) => {
        if (!cancelled) applyResponse(res)
      })
      .catch((error: any) => {
        if (!cancelled) {
          toast({ title: 'تعذر تحميل بروفايلات الذكاء', description: error?.message, variant: 'destructive' })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyResponse, toast])

  const stageByName = useMemo(() => new Map((data?.stages ?? []).map((stage) => [stage.stage, stage])), [data])

  const updateForm = (stage: Stage, patch: Partial<FormState>) => {
    setForms((current) => (current ? { ...current, [stage]: { ...current[stage], ...patch } } : current))
  }

  const resetDraft = (stage: Stage) => {
    const current = stageByName.get(stage)?.current?.snapshot ?? null
    setForms((state) => (state ? { ...state, [stage]: snapshotToForm(current) } : state))
  }

  const save = async (stage: Stage) => {
    if (!forms) return
    setSavingStage(stage)
    try {
      const snapshot = formToSnapshot(stage, forms[stage])
      const currentSnapshot = stageByName.get(stage)?.current?.snapshot ?? emptySnapshot
      if (snapshotKey(snapshot) === snapshotKey(currentSnapshot)) {
        toast({ title: 'لا يوجد تغيير للحفظ', description: 'عدّل البروفايل أولًا حتى يتم إنشاء نسخة جديدة.' })
        return
      }
      const res = await api<{ stage: StageData }>('/api/admin/ai-stage-profiles', {
        method: 'POST',
        body: JSON.stringify({ stage, snapshot }),
      })
      setData((current) => {
        if (!current) return current
        return { ...current, stages: current.stages.map((s) => (s.stage === stage ? res.stage : s)) }
      })
      setForms((current) => (current ? { ...current, [stage]: snapshotToForm(res.stage.current?.snapshot ?? snapshot) } : current))
      toast({ title: `تم حفظ بروفايل ${STAGE_LABELS[stage]}` })
    } catch (error: any) {
      toast({ title: 'تعذر الحفظ', description: error?.message || 'راجع البيانات وحاول مجددًا', variant: 'destructive' })
    } finally {
      setSavingStage(null)
    }
  }

  const requestAdvisorAdvice = async () => {
    setGeneratingAdvisorAdvice(true)
    try {
      const res = await api<{ created: number; skipped: number; advice: AdvisorAdvice[] }>('/api/admin/ai-advisor', { method: 'POST' })
      setData((current) => (current ? { ...current, advisorAdvice: res.advice } : current))
      toast({ title: 'تم توليد توصيات E1', description: `جديد: ${res.created} · مكرر مفتوح: ${res.skipped}` })
    } catch (error: any) {
      toast({ title: 'تعذر توليد توصيات المستشار', description: error?.message, variant: 'destructive' })
    } finally {
      setGeneratingAdvisorAdvice(false)
    }
  }

  const dismissAdvisorAdvice = async (id: string) => {
    setDismissingAdvisorAdviceId(id)
    try {
      await api<{ advice: AdvisorAdvice }>('/api/admin/ai-advisor', {
        method: 'PATCH',
        body: JSON.stringify({ id }),
      })
      setData((current) => (current ? { ...current, advisorAdvice: (current.advisorAdvice ?? []).filter((item) => item.id !== id) } : current))
      toast({ title: 'تم إغلاق توصية المستشار' })
    } catch (error: any) {
      toast({ title: 'تعذر إغلاق التوصية', description: error?.message, variant: 'destructive' })
    } finally {
      setDismissingAdvisorAdviceId(null)
    }
  }

  if (loading && !data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-14 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" /> جارٍ تحميل بروفايلات الذكاء...
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-800">بروفايلات مراحل الذكاء</h2>
          <p className="mt-1 max-w-3xl text-xs leading-6 text-slate-500">
            تتحكم بالقراءة والتحليل والتوليد والتدقيق، وتعرض آخر تشغيلات سجل D0. قسم E0 قراءة جاهزية فقط، وقسم E1
            يحفظ توصيات مراجعة قابلة للإغلاق. قسم E2 يحفظ مسودة Snapshot داخل التوصية فقط دون أن يغيّر البروفايلات.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className="ml-1 h-4 w-4" /> تحديث
        </Button>
      </div>

      {data?.advisorReadiness && (
        <Card className="border-blue-100 bg-blue-50/60">
          <CardContent className="space-y-4 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-black text-blue-950">E0 — تقرير جاهزية المستشار</h3>
                <p className="mt-1 text-xs leading-6 text-blue-900/75">
                  هذا التقرير يقرأ سجلات D0 فقط ولا يكتب أي توصية. العتبة: {data.advisorReadiness.gates.minStageRuns} تشغيل و{data.advisorReadiness.gates.minDays} يوم لكل مرحلة.
                </p>
              </div>
              <Badge className={data.advisorReadiness.allStagesReady ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}>
                {data.advisorReadiness.allStagesReady ? 'كل المراحل جاهزة' : 'يوجد نقص بيانات'}
              </Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              {data.advisorReadiness.stages.map((stage) => {
                const badge = readinessBadge(stage)
                return (
                  <div key={stage.stage} className="rounded-xl border border-blue-100 bg-white p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-black text-slate-800">{STAGE_LABELS[stage.stage]}</span>
                      <Badge className={badge.className}>{badge.label}</Badge>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-600">
                      <span>التشغيلات: <b>{stage.totalRuns}</b></span>
                      <span>الأيام: <b>{stage.windowDays}</b></span>
                      <span>النجاح: <b>{formatPct(stage.totalRuns ? stage.successRuns / stage.totalRuns : null)}</b></span>
                      <span>الرجوع: <b>{formatPct(stage.totalRuns ? stage.fallbackRuns / stage.totalRuns : null)}</b></span>
                      <span>التوكنز: <b>{formatPct(stage.tokenCoverage)}</b></span>
                      <span>الكلفة: <b>{formatPct(stage.costCoverage)}</b></span>
                    </div>
                    {!!stage.gaps.length && (
                      <ul className="mt-3 list-disc space-y-1 pr-5 text-[11px] leading-5 text-amber-700">
                        {stage.gaps.map((gap) => <li key={gap}>{gap}</li>)}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
            <div className="rounded-xl bg-white/80 p-3 text-xs leading-6 text-slate-600">
              {data.advisorReadiness.notes.map((note) => <p key={note}>• {note}</p>)}
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-indigo-100 bg-indigo-50/50">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-black text-indigo-950">E1/E2 — توصيات المستشار</h3>
              <p className="mt-1 text-xs leading-6 text-indigo-900/75">
                توليد توصيات مبنية على سجلات D0 الجاهزة فقط. E2 يضيف مسودة تغيير محفوظة للمراجعة فقط داخل التوصية، ولا يكتب في البروفايلات.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void requestAdvisorAdvice()} disabled={generatingAdvisorAdvice}>
              {generatingAdvisorAdvice ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-1 h-4 w-4" />}
              توليد توصيات E1/E2
            </Button>
          </div>

          {(data?.advisorAdvice ?? []).length ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {(data?.advisorAdvice ?? []).map((advice) => {
                const badge = adviceSeverityBadge(advice.severity)
                return (
                  <div key={advice.id} className="rounded-xl border border-indigo-100 bg-white p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge className="bg-slate-100 text-slate-700">{STAGE_LABELS[advice.stage]}</Badge>
                          <Badge className={badge.className}>{badge.label}</Badge>
                          <Badge className="bg-indigo-50 text-indigo-700">{advice.category}</Badge>
                        </div>
                        <h4 className="mt-2 text-sm font-black text-slate-800">{advice.title}</h4>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={dismissingAdvisorAdviceId === advice.id}
                        onClick={() => void dismissAdvisorAdvice(advice.id)}
                      >
                        {dismissingAdvisorAdviceId === advice.id && <Loader2 className="ml-1 h-4 w-4 animate-spin" />}
                        إغلاق التوصية
                      </Button>
                    </div>
                    <p className="mt-2 text-xs leading-6 text-slate-600">{advice.rationale}</p>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-slate-500 sm:grid-cols-4">
                      <span>التشغيلات: <b>{String(advice.evidence?.['totalRuns'] ?? '—')}</b></span>
                      <span>الفشل: <b>{String(advice.evidence?.['failureRatePct'] ?? '—')}%</b></span>
                      <span>الرجوع: <b>{String(advice.evidence?.['fallbackRatePct'] ?? '—')}%</b></span>
                      <span>الكلفة: <b>{String(advice.evidence?.['costCoveragePct'] ?? '—')}%</b></span>
                    </div>
                    {advice.proposedSnapshot && (
                      <div className="mt-3 rounded-lg border border-indigo-100 bg-indigo-50 p-3 text-[11px] leading-5 text-indigo-900">
                        <p className="font-black">مسودة تغيير E2 محفوظة للمراجعة فقط</p>
                        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                          <span>التفعيل: <b>{advice.proposedSnapshot.enabled ? 'مفعّل' : 'يرجع للعام'}</b></span>
                          <span>السياسة: <b>{advice.proposedSnapshot.policy ?? 'افتراضي'}</b></span>
                          <span>الرجوع للعام: <b>{advice.proposedSnapshot.allowGlobalFallback ? 'مسموح' : 'ممنوع'}</b></span>
                          <span>الموديلات: <b>{advice.proposedSnapshot.models.length + (advice.proposedSnapshot.verifier?.preferred.length ?? 0)}</b></span>
                        </div>
                      </div>
                    )}
                    <p className="mt-2 text-[11px] text-slate-400">أُنشئت: {fmtDate(advice.createdAt)}</p>
                  </div>
                )
              })}
            </div>
          ) : (
            <p className="rounded-xl bg-white/80 p-4 text-center text-sm text-slate-500">
              لا توجد توصيات مفتوحة. يمكن توليد توصيات E1 بعد اكتمال عتبات E0 للمراحل.
            </p>
          )}
        </CardContent>
      </Card>

      {(['READING', 'ANALYSIS', 'GENERATION', 'REVIEW'] as Stage[]).map((stageName) => {
        const stage = stageByName.get(stageName)
        const form = forms?.[stageName] ?? snapshotToForm(stage?.current?.snapshot ?? null)
        const currentSnapshot = stage?.current?.snapshot ?? emptySnapshot
        let draftSnapshot: Snapshot | null = null
        let draftError = ''
        try {
          draftSnapshot = formToSnapshot(stageName, form)
        } catch (error: any) {
          draftError = error?.message || 'صيغة الموديلات غير صالحة'
        }
        const diff = draftSnapshot ? describeSnapshotDiff(currentSnapshot, draftSnapshot, stageName) : []
        const hasChanges = diff.length > 0
        const disabled = savingStage === stageName || !!draftError || !hasChanges
        return (
          <Card key={stageName} className="overflow-hidden border-slate-200">
            <CardContent className="space-y-4 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-black text-slate-800">{STAGE_LABELS[stageName]}</h3>
                    <Badge className={form.enabled ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'}>
                      {form.enabled ? 'مفعّل' : 'يرجع للعام'}
                    </Badge>
                    <Badge className="bg-blue-50 text-blue-700">{stage ? currentVersionLabel(stage) : '—'}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">{STAGE_DESCRIPTIONS[stageName]}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" disabled={savingStage === stageName || !hasChanges} onClick={() => resetDraft(stageName)}>
                    <RotateCcw className="ml-1 h-4 w-4" /> استرجاع الحالي
                  </Button>
                  <Button size="sm" disabled={disabled} onClick={() => void save(stageName)}>
                    {savingStage === stageName ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Save className="ml-1 h-4 w-4" />}
                    حفظ نسخة جديدة
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-4">
                <div className="rounded-lg bg-slate-50 p-3 text-center">
                  <div className="text-[11px] font-bold text-slate-500">تشغيلات</div>
                  <div className="mt-1 text-xl font-black text-slate-800">{stage?.stats.runs ?? 0}</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3 text-center">
                  <div className="text-[11px] font-bold text-slate-500">نجاح</div>
                  <div className="mt-1 text-xl font-black text-green-700">{stage ? successRate(stage.stats) : '—'}</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3 text-center">
                  <div className="text-[11px] font-bold text-slate-500">رجوع للعام</div>
                  <div className="mt-1 text-xl font-black text-amber-700">{stage ? fallbackRate(stage.stats) : '—'}</div>
                </div>
                <div className="rounded-lg bg-slate-50 p-3 text-center">
                  <div className="text-[11px] font-bold text-slate-500">فشل</div>
                  <div className="mt-1 text-xl font-black text-red-700">{stage?.stats.failures ?? 0}</div>
                </div>
              </div>

              {(draftError || hasChanges) && (
                <div className={draftError ? 'rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700' : 'rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800'}>
                  {draftError ? (
                    <p className="font-bold">{draftError}</p>
                  ) : (
                    <>
                      <p className="font-black">معاينة التغييرات قبل إنشاء نسخة جديدة:</p>
                      <ul className="mt-2 list-disc space-y-1 pr-5 text-xs leading-6">
                        {diff.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </>
                  )}
                </div>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-3 rounded-xl border border-slate-100 p-3">
                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                      <input
                        type="checkbox"
                        checked={form.enabled}
                        onChange={(event) => updateForm(stageName, { enabled: event.target.checked })}
                      />
                      تفعيل بروفايل هذه المرحلة
                    </label>
                    <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                      <input
                        type="checkbox"
                        checked={form.allowGlobalFallback}
                        onChange={(event) => updateForm(stageName, { allowGlobalFallback: event.target.checked })}
                      />
                      السماح بالرجوع للعام عند فشل القائمة
                    </label>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-xs font-bold text-slate-500">المزوّد المفضل</label>
                      <select
                        className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                        value={form.provider}
                        onChange={(event) => updateForm(stageName, { provider: event.target.value })}
                      >
                        <option value="">بدون مزوّد مفضل</option>
                        {(data?.providers ?? []).map((provider) => (
                          <option key={provider} value={provider}>{provider}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-bold text-slate-500">السياسة</label>
                      <select
                        className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
                        value={form.policy}
                        onChange={(event) => updateForm(stageName, { policy: event.target.value })}
                      >
                        <option value="">افتراضي المرحلة</option>
                        {(data?.policies ?? []).map((policy) => (
                          <option key={policy} value={policy}>{policy}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-bold text-slate-500">قائمة الموديلات المسموحة</label>
                    <Textarea
                      dir="ltr"
                      className="min-h-28 font-mono text-xs"
                      value={form.modelsText}
                      placeholder={'GEMINI:gemini-2.5-pro\nOPENROUTER:some-model'}
                      onChange={(event) => updateForm(stageName, { modelsText: event.target.value })}
                    />
                    <p className="mt-1 text-[11px] text-slate-500">
                      اكتب كل موديل بسطر بصيغة PROVIDER:model. القائمة هنا حصر فعلي، وليست اقتراحًا فقط.
                    </p>
                  </div>

                  {stageName === 'REVIEW' && (
                    <div className="rounded-lg border border-blue-100 bg-blue-50 p-3">
                      <label className="mb-1 block text-xs font-bold text-blue-800">قائمة المدقق الخاصة</label>
                      <Textarea
                        dir="ltr"
                        className="min-h-24 font-mono text-xs"
                        value={form.verifierText}
                        placeholder={'GEMINI:gemini-2.5-pro\nOPENAI:gpt-5.1'}
                        onChange={(event) => updateForm(stageName, { verifierText: event.target.value })}
                      />
                      <label className="mt-2 flex items-center gap-2 text-xs font-bold text-blue-800">
                        <input
                          type="checkbox"
                          checked={form.verifierStrict}
                          onChange={(event) => updateForm(stageName, { verifierStrict: event.target.checked })}
                        />
                        وضع تدقيق صارم
                      </label>
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-slate-100 p-3">
                  <h4 className="mb-2 text-sm font-black text-slate-700">آخر تشغيلات هذه المرحلة</h4>
                  {stage?.recentLogs.length ? (
                    <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
                      {stage.recentLogs.map((log) => (
                        <div key={log.id} className="rounded-lg border border-slate-100 bg-white p-2 text-xs">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-bold text-slate-700">{fmtDate(log.createdAt)}</span>
                            <Badge className={log.success ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'}>
                              {log.success ? 'نجح' : 'فشل'}
                            </Badge>
                          </div>
                          <div className="mt-1 text-slate-500">{shortModel(log.provider, log.model)}</div>
                          <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-400">
                            <span>profile: {log.profileVersion ?? 'global'}</span>
                            <span>fallback: {log.fallbackUsed ? 'نعم' : 'لا'}</span>
                            {log.latencyMs != null && <span>{log.latencyMs}ms</span>}
                            {log.outputCount != null && <span>مخرجات: {log.outputCount}</span>}
                            {log.failureCategory && <span>سبب: {log.failureCategory}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="rounded-lg bg-slate-50 p-4 text-center text-sm text-slate-500">لا توجد تشغيلات مسجلة بعد لهذه المرحلة.</p>
                  )}
                </div>
              </div>

              {!!stage?.versions.length && (
                <div className="rounded-xl bg-slate-50 p-3">
                  <h4 className="mb-2 text-sm font-black text-slate-700">آخر النسخ المحفوظة</h4>
                  <div className="flex flex-wrap gap-2">
                    {stage.versions.map((version) => (
                      <Badge key={version.version} className="bg-white text-slate-700">
                        نسخة {version.version} — {fmtDate(version.createdAt)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
