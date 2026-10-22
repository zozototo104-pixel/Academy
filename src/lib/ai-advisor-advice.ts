import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import {
  ADVISOR_COST_COVERAGE_TARGET,
  ADVISOR_STAGES,
  getAiAdvisorReadiness,
  type AdvisorReadinessReport,
  type AdvisorStageReadiness,
} from '@/lib/ai-advisor-readiness'
import type { PipelineStageName } from '@/lib/ai-pipeline-log'
import {
  getCurrentStageProfile,
  validateStageProfileSnapshot,
  type StageProfileSnapshot,
} from '@/lib/ai-stage-profiles'

// E1 — توصيات مراجعة فقط:
// - تُشتق من سجلات D0/تقرير E0 ولا تستدعي أي نموذج لغوي.
// - تُحفظ كتوصيات قابلة للمراجعة والإغلاق فقط.
// - لا تطبق أي Snapshot ولا تكتب في AiStageProfile/AiStageProfileVersion.

export const ADVISOR_ADVICE_MIN_FAILURE_RATE = 0.18
export const ADVISOR_ADVICE_MIN_FALLBACK_RATE = 0.12
export const ADVISOR_ADVICE_MAX_PER_RUN = 12

export type AdvisorAdviceSeverity = 'INFO' | 'WARNING' | 'CRITICAL'
export type AdvisorAdviceStatus = 'OPEN' | 'DISMISSED'
export type AdvisorAdviceCategory = 'RELIABILITY' | 'FALLBACK' | 'COST_TELEMETRY'

export type AdvisorAdviceCandidate = {
  stage: PipelineStageName
  category: AdvisorAdviceCategory
  severity: AdvisorAdviceSeverity
  title: string
  rationale: string
  evidence: Record<string, unknown>
  proposedSnapshot: StageProfileSnapshot | null
}

export type AdvisorAdviceCandidateWithSignature = AdvisorAdviceCandidate & {
  signature: string
  activeDedupKey: string
}

export type AdvisorAdviceRecord = AdvisorAdviceCandidateWithSignature & {
  id: string
  status: AdvisorAdviceStatus | string
  createdAt: string
  updatedAt: string
  dismissedAt: string | null
  dismissedBy: string | null
}

function rate(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function pct(value: number): number {
  return Math.round(value * 1000) / 10
}

function evidenceFor(stage: AdvisorStageReadiness) {
  return {
    totalRuns: stage.totalRuns,
    successRuns: stage.successRuns,
    failureRuns: stage.failureRuns,
    fallbackRuns: stage.fallbackRuns,
    windowDays: stage.windowDays,
    successRatePct: pct(rate(stage.successRate)),
    failureRatePct: pct(rate(stage.failureRate)),
    fallbackRatePct: pct(rate(stage.fallbackRate)),
    tokenCoveragePct: pct(stage.tokenCoverage),
    costCoveragePct: pct(stage.costCoverage),
    avgLatencyMs: stage.avgLatencyMs,
    totalInputTokens: stage.totalInputTokens,
    totalOutputTokens: stage.totalOutputTokens,
    totalCostCents: stage.totalCostCents,
  }
}

function signAdvice(candidate: AdvisorAdviceCandidate): AdvisorAdviceCandidateWithSignature {
  const stable = JSON.stringify({
    stage: candidate.stage,
    category: candidate.category,
    severity: candidate.severity,
    title: candidate.title,
    rationale: candidate.rationale,
    evidence: candidate.evidence,
  })
  const signature = createHash('sha256').update(stable).digest('hex').slice(0, 40)
  return {
    ...candidate,
    signature,
    activeDedupKey: `${candidate.stage}:${candidate.category}:${signature}`,
  }
}

function severityForFailure(failureRate: number): AdvisorAdviceSeverity {
  if (failureRate >= 0.35) return 'CRITICAL'
  return 'WARNING'
}

function severityForFallback(fallbackRate: number): AdvisorAdviceSeverity {
  if (fallbackRate >= 0.25) return 'CRITICAL'
  return 'WARNING'
}

function cloneSnapshot(snapshot: StageProfileSnapshot): StageProfileSnapshot {
  return {
    enabled: snapshot.enabled,
    provider: snapshot.provider,
    policy: snapshot.policy,
    models: snapshot.models.map((model) => ({ ...model })),
    allowGlobalFallback: snapshot.allowGlobalFallback,
    verifier: snapshot.verifier
      ? { preferred: snapshot.verifier.preferred.map((model) => ({ ...model })), strict: snapshot.verifier.strict }
      : null,
  }
}

function snapshotKey(snapshot: StageProfileSnapshot): string {
  return JSON.stringify({
    enabled: snapshot.enabled,
    provider: snapshot.provider ?? null,
    policy: snapshot.policy ?? null,
    models: snapshot.models.map((model) => `${model.provider}:${model.model}`),
    allowGlobalFallback: snapshot.allowGlobalFallback,
    verifier: snapshot.verifier
      ? {
          preferred: snapshot.verifier.preferred.map((model) => `${model.provider}:${model.model}`),
          strict: snapshot.verifier.strict,
        }
      : null,
  })
}

// E2 — مسودة Snapshot للمراجعة فقط: تحفظ داخل التوصية ولا تطبّق نفسها.
// القاعدة المحافظة: الأعطال العالية لا تخترع موديلات ولا تغيّر مزوّدًا؛ إما
// تضمن الرجوع للعام أو تقترح تعطيل بروفايل المرحلة مؤقتًا لصالح المسار العام.
export function buildAdvisorProposedSnapshot(
  candidate: Pick<AdvisorAdviceCandidateWithSignature, 'stage' | 'category' | 'severity'>,
  currentSnapshot: StageProfileSnapshot | null,
): StageProfileSnapshot | null {
  if (!currentSnapshot || !currentSnapshot.enabled) return null
  if (candidate.category === 'COST_TELEMETRY') return null

  const draft = cloneSnapshot(currentSnapshot)
  draft.allowGlobalFallback = true

  if (candidate.category === 'FALLBACK' || candidate.severity === 'CRITICAL') {
    draft.enabled = false
  }

  const validated = validateStageProfileSnapshot(candidate.stage, draft)
  return snapshotKey(validated) === snapshotKey(currentSnapshot) ? null : validated
}

async function attachAdvisorProposalDrafts(
  candidates: AdvisorAdviceCandidateWithSignature[],
): Promise<AdvisorAdviceCandidateWithSignature[]> {
  const currentByStage = new Map<PipelineStageName, StageProfileSnapshot | null>()
  for (const candidate of candidates) {
    if (!currentByStage.has(candidate.stage)) {
      const current = await getCurrentStageProfile(candidate.stage)
      currentByStage.set(candidate.stage, current?.snapshot ?? null)
    }
  }
  return candidates.map((candidate) => ({
    ...candidate,
    proposedSnapshot: buildAdvisorProposedSnapshot(candidate, currentByStage.get(candidate.stage) ?? null),
  }))
}

export function buildAdvisorAdviceCandidates(report: AdvisorReadinessReport): AdvisorAdviceCandidateWithSignature[] {
  const candidates: AdvisorAdviceCandidate[] = []
  const stages = new Map(report.stages.map((stage) => [stage.stage, stage]))

  for (const stageName of ADVISOR_STAGES) {
    const stage = stages.get(stageName)
    if (!stage || !stage.readyForAdvice) continue

    const failureRate = rate(stage.failureRate)
    const fallbackRate = rate(stage.fallbackRate)

    if (failureRate >= ADVISOR_ADVICE_MIN_FAILURE_RATE) {
      candidates.push({
        stage: stage.stage,
        category: 'RELIABILITY',
        severity: severityForFailure(failureRate),
        title: `راجع موثوقية مرحلة ${stage.stage}`,
        rationale: `نسبة الفشل ${pct(failureRate)}% بعد ${stage.totalRuns} تشغيل، وهي أعلى من حد المراجعة ${pct(ADVISOR_ADVICE_MIN_FAILURE_RATE)}%.`,
        evidence: evidenceFor(stage),
        proposedSnapshot: null,
      })
    }

    if (fallbackRate >= ADVISOR_ADVICE_MIN_FALLBACK_RATE) {
      candidates.push({
        stage: stage.stage,
        category: 'FALLBACK',
        severity: severityForFallback(fallbackRate),
        title: `راجع اعتماد مرحلة ${stage.stage} على الرجوع للعام`,
        rationale: `نسبة الرجوع للعام ${pct(fallbackRate)}%، ما يعني أن بروفايل المرحلة لا يستقر كفاية أو أن قائمته تفشل كثيرًا.`,
        evidence: evidenceFor(stage),
        proposedSnapshot: null,
      })
    }

    if (stage.costCoverage < ADVISOR_COST_COVERAGE_TARGET) {
      candidates.push({
        stage: stage.stage,
        category: 'COST_TELEMETRY',
        severity: 'INFO',
        title: `لا تصدر توصية تكلفة لمرحلة ${stage.stage} بعد`,
        rationale: `تغطية بيانات الكلفة ${pct(stage.costCoverage)}% فقط، لذلك تُحجب توصيات خفض التكلفة إلى أن تصل التغطية إلى ${pct(ADVISOR_COST_COVERAGE_TARGET)}%.`,
        evidence: evidenceFor(stage),
        proposedSnapshot: null,
      })
    }
  }

  const severityRank: Record<AdvisorAdviceSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 }
  return candidates
    .map(signAdvice)
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || ADVISOR_STAGES.indexOf(a.stage) - ADVISOR_STAGES.indexOf(b.stage))
    .slice(0, ADVISOR_ADVICE_MAX_PER_RUN)
}

function toRecord(row: any): AdvisorAdviceRecord {
  return {
    id: row.id,
    stage: row.stage,
    category: row.category,
    severity: row.severity,
    status: row.status,
    title: row.title,
    rationale: row.rationale,
    evidence: row.evidence ?? {},
    proposedSnapshot: row.proposedSnapshot ?? null,
    signature: row.signature,
    activeDedupKey: row.activeDedupKey ?? '',
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    dismissedAt: row.dismissedAt ? (row.dismissedAt instanceof Date ? row.dismissedAt.toISOString() : String(row.dismissedAt)) : null,
    dismissedBy: row.dismissedBy ?? null,
  }
}

export async function listAdvisorAdvice(status: AdvisorAdviceStatus | 'ALL' = 'OPEN'): Promise<AdvisorAdviceRecord[]> {
  const rows = await db.aiAdvisorAdvice.findMany({
    where: status === 'ALL' ? {} : { status },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 50,
  })
  return rows.map(toRecord)
}

function isUniqueConflict(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002'
}

export async function generateAdvisorAdvice(actorId?: string | null): Promise<{ created: number; skipped: number; advice: AdvisorAdviceRecord[] }> {
  const report = await getAiAdvisorReadiness()
  const candidates = await attachAdvisorProposalDrafts(buildAdvisorAdviceCandidates(report))
  let created = 0
  let skipped = 0

  for (const candidate of candidates) {
    try {
      await db.aiAdvisorAdvice.create({
        data: {
          stage: candidate.stage as never,
          category: candidate.category,
          severity: candidate.severity,
          status: 'OPEN',
          title: candidate.title,
          rationale: candidate.rationale,
          evidence: candidate.evidence as never,
          ...(candidate.proposedSnapshot ? { proposedSnapshot: candidate.proposedSnapshot as never } : {}),
          signature: candidate.signature,
          activeDedupKey: candidate.activeDedupKey,
          createdBy: actorId ?? null,
        },
      })
      created += 1
    } catch (error) {
      if (isUniqueConflict(error)) {
        skipped += 1
        continue
      }
      throw error
    }
  }

  return { created, skipped, advice: await listAdvisorAdvice('OPEN') }
}

export async function dismissAdvisorAdvice(id: string, actorId?: string | null): Promise<AdvisorAdviceRecord> {
  const row = await db.aiAdvisorAdvice.update({
    where: { id },
    data: {
      status: 'DISMISSED',
      activeDedupKey: null,
      dismissedAt: new Date(),
      dismissedBy: actorId ?? null,
    },
  })
  return toRecord(row)
}
