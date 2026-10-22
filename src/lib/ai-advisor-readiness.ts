import { db } from '@/lib/db'
import type { PipelineStageName } from '@/lib/ai-pipeline-log'

export const ADVISOR_READINESS_MIN_DAYS = 14
export const ADVISOR_READINESS_MIN_STAGE_RUNS = 200
export const ADVISOR_COST_COVERAGE_TARGET = 0.8

export const ADVISOR_STAGES: PipelineStageName[] = ['READING', 'ANALYSIS', 'GENERATION', 'REVIEW']

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
}

export type AdvisorStageReadiness = AdvisorStageReadinessInput & {
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
}

export type AdvisorReadinessReport = {
  generatedAt: string
  gates: {
    minDays: number
    minStageRuns: number
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

function windowDays(firstRunAt: Date | null, lastRunAt: Date | null): number {
  if (!firstRunAt || !lastRunAt) return 0
  const ms = Math.max(0, lastRunAt.getTime() - firstRunAt.getTime())
  return Math.round((ms / 86_400_000) * 10) / 10
}

export function evaluateStageReadiness(input: AdvisorStageReadinessInput): AdvisorStageReadiness {
  const days = windowDays(input.firstRunAt, input.lastRunAt)
  const tokenCoverage = input.totalRuns ? input.tokenRows / input.totalRuns : 0
  const costCoverage = input.totalRuns ? input.costRows / input.totalRuns : 0
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
  }
}

async function readStage(stage: PipelineStageName): Promise<AdvisorStageReadiness> {
  const where = { stage }
  const [totalRuns, successRuns, failureRuns, fallbackRuns, tokenRows, costRows, aggregate] = await Promise.all([
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
      costCoverageTarget: ADVISOR_COST_COVERAGE_TARGET,
    },
    stages,
    readyStages,
    blockedStages,
    allStagesReady: blockedStages.length === 0,
    notes: [
      'E0 قراءة فقط: لا ينشئ نصائح، ولا يطبّق أي تعديل، ولا يكتب في البروفايلات.',
      blockedStages.length
        ? 'المراحل الناقصة تبقى خارج أي محرك توصيات لاحق حتى تكتمل عتبات التشغيل والمدة.'
        : 'كل المراحل اجتازت عتبة عدد التشغيلات ونافذة الأيام، لكن نصائح الكلفة تبقى مشروطة بتغطية الكلفة.',
      lowCostCoverage.length
        ? `بيانات الكلفة ناقصة للمراحل: ${lowCostCoverage.join(', ')}؛ لذلك أي توصية تكلفة لاحقة يجب أن تُحجب عنها.`
        : 'تغطية بيانات الكلفة كافية مبدئيًا لكل المراحل.',
    ],
  }
}
