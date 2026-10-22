import { db } from '@/lib/db'
import type { PipelineStageName } from '@/lib/ai-pipeline-log'

export const ADVISOR_READINESS_MIN_DAYS = 14
export const ADVISOR_READINESS_MIN_STAGE_RUNS = 200
export const ADVISOR_COST_COVERAGE_TARGET = 0.8
export const ADVISOR_MODEL_MIN_RUNS = 30

export const ADVISOR_STAGES: PipelineStageName[] = ['READING', 'ANALYSIS', 'GENERATION', 'REVIEW']

export type AdvisorModelReadinessInput = {
  provider: string
  model: string
  runs: number
  successRuns: number
  failureRuns: number
  fallbackRuns: number
  tokenRows: number
  costRows: number
  avgLatencyMs: number | null
  totalInputTokens: number | null
  totalOutputTokens: number | null
  totalCostCents: number | null
  avgCostCents: number | null
}

export type AdvisorModelReadiness = AdvisorModelReadinessInput & {
  successRate: number | null
  failureRate: number | null
  fallbackRate: number | null
  tokenCoverage: number
  costCoverage: number
  readyForModelAdvice: boolean
}

export type AdvisorStageReadinessInput = {
  stage: PipelineStageName
  totalRuns: number
  successRuns: number
  failureRuns: number
  fallbackRuns: number
  tokenRows: number
  costRows: number
  firstRunAt: Date | null
  lastRunAt: Date | null
  avgLatencyMs: number | null
  totalInputTokens: number | null
  totalOutputTokens: number | null
  totalCostCents: number | null
  modelStats?: AdvisorModelReadinessInput[]
}

export type AdvisorStageReadiness = Omit<AdvisorStageReadinessInput, 'modelStats'> & {
  windowDays: number
  successRate: number | null
  failureRate: number | null
  fallbackRate: number | null
  tokenCoverage: number
  costCoverage: number
  operationsGap: number
  daysGap: number
  costCoverageGap: number
  readyForAdvice: boolean
  gaps: string[]
  modelStats: AdvisorModelReadiness[]
}

export type AdvisorReadinessReport = {
  generatedAt: string
  gates: {
    minDays: number
    minStageRuns: number
    minModelRuns: number
    costCoverageTarget: number
  }
  stages: AdvisorStageReadiness[]
  readyStages: PipelineStageName[]
  blockedStages: PipelineStageName[]
  allStagesReady: boolean
  notes: string[]
}

function ratio(part: number, total: number): number | null {
  if (!total) return null
  return part / total
}

function coverage(part: number, total: number): number {
  if (!total) return 0
  return part / total
}

function windowDays(firstRunAt: Date | null, lastRunAt: Date | null): number {
  if (!firstRunAt || !lastRunAt) return 0
  const ms = Math.max(0, lastRunAt.getTime() - firstRunAt.getTime())
  return Math.round((ms / 86_400_000) * 10) / 10
}

function evaluateModelReadiness(input: AdvisorModelReadinessInput): AdvisorModelReadiness {
  const tokenCoverage = coverage(input.tokenRows, input.runs)
  const costCoverage = coverage(input.costRows, input.runs)
  return {
    ...input,
    successRate: ratio(input.successRuns, input.runs),
    failureRate: ratio(input.failureRuns, input.runs),
    fallbackRate: ratio(input.fallbackRuns, input.runs),
    tokenCoverage,
    costCoverage,
    readyForModelAdvice: input.runs >= ADVISOR_MODEL_MIN_RUNS,
  }
}

export function evaluateStageReadiness(input: AdvisorStageReadinessInput): AdvisorStageReadiness {
  const days = windowDays(input.firstRunAt, input.lastRunAt)
  const tokenCoverage = coverage(input.tokenRows, input.totalRuns)
  const costCoverage = coverage(input.costRows, input.totalRuns)
  const operationsGap = Math.max(0, ADVISOR_READINESS_MIN_STAGE_RUNS - input.totalRuns)
  const daysGap = Math.max(0, Math.ceil(ADVISOR_READINESS_MIN_DAYS - days))
  const costCoverageGap = Math.max(0, Math.round((ADVISOR_COST_COVERAGE_TARGET - costCoverage) * 100))
  const gaps: string[] = []
  if (operationsGap > 0) gaps.push(`ينقص ${operationsGap} تشغيل للوصول إلى ${ADVISOR_READINESS_MIN_STAGE_RUNS}`)
  if (daysGap > 0) gaps.push(`ينقص ${daysGap} يوم للوصول إلى نافذة ${ADVISOR_READINESS_MIN_DAYS} يوم`)
  if (costCoverageGap > 0) gaps.push(`تغطية الكلفة ناقصة ${costCoverageGap} نقطة مئوية عن حد ${Math.round(ADVISOR_COST_COVERAGE_TARGET * 100)}%`)
  return {
    ...input,
    windowDays: days,
    successRate: ratio(input.successRuns, input.totalRuns),
    failureRate: ratio(input.failureRuns, input.totalRuns),
    fallbackRate: ratio(input.fallbackRuns, input.totalRuns),
    tokenCoverage,
    costCoverage,
    operationsGap,
    daysGap,
    costCoverageGap,
    readyForAdvice: operationsGap === 0 && daysGap === 0,
    gaps,
    modelStats: (input.modelStats ?? []).map(evaluateModelReadiness),
  }
}

type ModelGroup = {
  provider: string | null
  model: string | null
  _count?: { _all?: number }
  _sum?: { inputTokens?: number | null; outputTokens?: number | null; costCents?: number | null }
  _avg?: { latencyMs?: number | null; costCents?: number | null }
}

function modelKey(provider: string | null, model: string | null): string | null {
  if (!provider || !model) return null
  return `${provider}\u0000${model}`
}

function mergeCount(target: Map<string, number>, groups: ModelGroup[]) {
  for (const group of groups) {
    const key = modelKey(group.provider, group.model)
    if (!key) continue
    target.set(key, group._count?._all ?? 0)
  }
}

async function readModelStats(stage: PipelineStageName): Promise<AdvisorModelReadinessInput[]> {
  const where = { stage, provider: { not: null }, model: { not: null } }
  const [allGroups, successGroups, failureGroups, fallbackGroups, tokenGroups, costGroups] = await Promise.all([
    db.aiPipelineOperationLog.groupBy({
      by: ['provider', 'model'],
      where,
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, costCents: true },
      _avg: { latencyMs: true, costCents: true },
    }),
    db.aiPipelineOperationLog.groupBy({ by: ['provider', 'model'], where: { ...where, success: true }, _count: { _all: true } }),
    db.aiPipelineOperationLog.groupBy({ by: ['provider', 'model'], where: { ...where, success: false }, _count: { _all: true } }),
    db.aiPipelineOperationLog.groupBy({ by: ['provider', 'model'], where: { ...where, fallbackUsed: true }, _count: { _all: true } }),
    db.aiPipelineOperationLog.groupBy({
      by: ['provider', 'model'],
      where: { ...where, OR: [{ inputTokens: { not: null } }, { outputTokens: { not: null } }] },
      _count: { _all: true },
    }),
    db.aiPipelineOperationLog.groupBy({ by: ['provider', 'model'], where: { ...where, costCents: { not: null } }, _count: { _all: true } }),
  ])

  const success = new Map<string, number>()
  const failure = new Map<string, number>()
  const fallback = new Map<string, number>()
  const tokenRows = new Map<string, number>()
  const costRows = new Map<string, number>()
  mergeCount(success, successGroups as ModelGroup[])
  mergeCount(failure, failureGroups as ModelGroup[])
  mergeCount(fallback, fallbackGroups as ModelGroup[])
  mergeCount(tokenRows, tokenGroups as ModelGroup[])
  mergeCount(costRows, costGroups as ModelGroup[])

  return (allGroups as ModelGroup[])
    .map((group) => {
      const key = modelKey(group.provider, group.model)
      if (!key || !group.provider || !group.model) return null
      return {
        provider: group.provider,
        model: group.model,
        runs: group._count?._all ?? 0,
        successRuns: success.get(key) ?? 0,
        failureRuns: failure.get(key) ?? 0,
        fallbackRuns: fallback.get(key) ?? 0,
        tokenRows: tokenRows.get(key) ?? 0,
        costRows: costRows.get(key) ?? 0,
        avgLatencyMs: group._avg?.latencyMs == null ? null : Math.round(group._avg.latencyMs),
        totalInputTokens: group._sum?.inputTokens ?? null,
        totalOutputTokens: group._sum?.outputTokens ?? null,
        totalCostCents: group._sum?.costCents ?? null,
        avgCostCents: group._avg?.costCents == null ? null : Math.round(group._avg.costCents * 100) / 100,
      }
    })
    .filter((item): item is AdvisorModelReadinessInput => !!item)
    .sort((a, b) => b.runs - a.runs || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
}

async function readStage(stage: PipelineStageName): Promise<AdvisorStageReadiness> {
  const where = { stage }
  const [totalRuns, successRuns, failureRuns, fallbackRuns, tokenRows, costRows, aggregate, modelStats] = await Promise.all([
    db.aiPipelineOperationLog.count({ where }),
    db.aiPipelineOperationLog.count({ where: { ...where, success: true } }),
    db.aiPipelineOperationLog.count({ where: { ...where, success: false } }),
    db.aiPipelineOperationLog.count({ where: { ...where, fallbackUsed: true } }),
    db.aiPipelineOperationLog.count({
      where: {
        ...where,
        OR: [{ inputTokens: { not: null } }, { outputTokens: { not: null } }],
      },
    }),
    db.aiPipelineOperationLog.count({ where: { ...where, costCents: { not: null } } }),
    db.aiPipelineOperationLog.aggregate({
      where,
      _min: { createdAt: true },
      _max: { createdAt: true },
      _avg: { latencyMs: true },
      _sum: { inputTokens: true, outputTokens: true, costCents: true },
    }),
    readModelStats(stage),
  ])
  return evaluateStageReadiness({
    stage,
    totalRuns,
    successRuns,
    failureRuns,
    fallbackRuns,
    tokenRows,
    costRows,
    firstRunAt: aggregate._min.createdAt ?? null,
    lastRunAt: aggregate._max.createdAt ?? null,
    avgLatencyMs: aggregate._avg.latencyMs == null ? null : Math.round(aggregate._avg.latencyMs),
    totalInputTokens: aggregate._sum.inputTokens ?? null,
    totalOutputTokens: aggregate._sum.outputTokens ?? null,
    totalCostCents: aggregate._sum.costCents ?? null,
    modelStats,
  })
}

export async function getAiAdvisorReadiness(): Promise<AdvisorReadinessReport> {
  const stages = await Promise.all(ADVISOR_STAGES.map(readStage))
  const readyStages = stages.filter((stage) => stage.readyForAdvice).map((stage) => stage.stage)
  const blockedStages = stages.filter((stage) => !stage.readyForAdvice).map((stage) => stage.stage)
  const lowCostCoverage = stages.filter((stage) => stage.costCoverage < ADVISOR_COST_COVERAGE_TARGET).map((stage) => stage.stage)
  return {
    generatedAt: new Date().toISOString(),
    gates: {
      minDays: ADVISOR_READINESS_MIN_DAYS,
      minStageRuns: ADVISOR_READINESS_MIN_STAGE_RUNS,
      minModelRuns: ADVISOR_MODEL_MIN_RUNS,
      costCoverageTarget: ADVISOR_COST_COVERAGE_TARGET,
    },
    stages,
    readyStages,
    blockedStages,
    allStagesReady: blockedStages.length === 0,
    notes: [
      'E0 قراءة فقط: لا ينشئ نصائح، ولا يطبّق أي تعديل، ولا يكتب في البروفايلات.',
      'E0 يجمع إحصاءات كل مزوّد/موديل من سجل D0 حتى تكون توصيات E1/E2 على مستوى الموديل لا على انطباع المرحلة العام.',
      blockedStages.length
        ? 'المراحل الناقصة تبقى خارج أي محرك توصيات لاحق حتى تكتمل عتبات التشغيل والمدة.'
        : 'كل المراحل اجتازت عتبة عدد التشغيلات ونافذة الأيام، لكن نصائح الكلفة تبقى مشروطة بتغطية الكلفة.',
      lowCostCoverage.length
        ? `بيانات الكلفة ناقصة للمراحل: ${lowCostCoverage.join(', ')}؛ لذلك أي توصية تكلفة لاحقة يجب أن تُحجب عنها.`
        : 'تغطية بيانات الكلفة كافية مبدئيًا لكل المراحل.',
    ],
  }
}
