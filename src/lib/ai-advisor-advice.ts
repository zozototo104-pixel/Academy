import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import {
  ADVISOR_COST_COVERAGE_TARGET,
  ADVISOR_MODEL_MIN_RUNS,
  ADVISOR_STAGES,
  getAiAdvisorReadiness,
  type AdvisorModelReadiness,
  type AdvisorReadinessReport,
  type AdvisorStageReadiness,
} from '@/lib/ai-advisor-readiness'
import type { PipelineStageName } from '@/lib/ai-pipeline-log'
import {
  getCurrentStageProfile,
  validateStageProfileSnapshot,
  type StageProfileModelRef,
  type StageProfileSnapshot,
} from '@/lib/ai-stage-profiles'

// E1/E2/E3/E4 — توصيات مراجعة فقط:
// - تُشتق من سجلات D0/تقرير E0 ولا تستدعي أي نموذج لغوي.
// - توصيات الاعتماد تكون على مستوى الموديل، لا على فشل المرحلة العام.
// - أي مسودة قابلة للتحميل لا تغيّر إلا قوائم الموديلات/مفضّلات المدقق.
// - لا يوجد تطبيق مباشر؛ الحفظ يمر عبر نموذج D4 العادي مع فحص نسخة الهدف.

export const ADVISOR_ADVICE_MIN_FAILURE_RATE = 0.18
export const ADVISOR_ADVICE_MIN_FALLBACK_RATE = 0.12
export const ADVISOR_ADVICE_MAX_PER_RUN = 12
export const ADVISOR_ADVICE_EXPIRES_DAYS = 14
export const ADVISOR_ADVICE_DISMISS_COOLDOWN_DAYS = 7
export const ADVISOR_COST_SAVING_MIN_RATIO = 0.2
export const ADVISOR_COST_SUCCESS_PARITY_TOLERANCE = 0.03

export type AdvisorAdviceSeverity = 'INFO' | 'WARNING' | 'CRITICAL'
export type AdvisorAdviceStatus = 'OPEN' | 'DISMISSED' | 'APPLIED' | 'SUPERSEDED'
export type AdvisorAdviceCategory = 'MODEL_RELIABILITY' | 'MODEL_FALLBACK' | 'COST_OPTIMIZATION' | 'COST_TELEMETRY'

export type AdvisorAdviceCandidate = {
  stage: PipelineStageName
  category: AdvisorAdviceCategory
  severity: AdvisorAdviceSeverity
  title: string
  rationale: string
  evidence: Record<string, unknown>
  proposedSnapshot: StageProfileSnapshot | null
  targetProfileVersion: number | null
}

export type AdvisorAdviceCandidateWithSignature = AdvisorAdviceCandidate & {
  signature: string
  evidenceSignature: string
  activeDedupKey: string
}

export type AdvisorAdviceRecord = AdvisorAdviceCandidateWithSignature & {
  id: string
  status: AdvisorAdviceStatus | string
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  dismissedAt: string | null
  dismissedBy: string | null
  appliedAt: string | null
  appliedBy: string | null
  appliedProfileVersion: number | null
}

export class AdvisorAdviceApplicationError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'AdvisorAdviceApplicationError'
    this.status = status
  }
}

function rate(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function pct(value: number): number {
  return Math.round(value * 1000) / 10
}

function daysFrom(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 86_400_000)
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

function modelEvidence(stage: AdvisorStageReadiness, model: AdvisorModelReadiness, extra: Record<string, unknown> = {}) {
  return {
    ...evidenceFor(stage),
    targetProvider: model.provider,
    targetModel: model.model,
    modelRuns: model.runs,
    modelSuccessRuns: model.successRuns,
    modelFailureRuns: model.failureRuns,
    modelFallbackRuns: model.fallbackRuns,
    modelSuccessRatePct: pct(rate(model.successRate)),
    modelFailureRatePct: pct(rate(model.failureRate)),
    modelFallbackRatePct: pct(rate(model.fallbackRate)),
    modelTokenCoveragePct: pct(model.tokenCoverage),
    modelCostCoveragePct: pct(model.costCoverage),
    modelAvgLatencyMs: model.avgLatencyMs,
    modelAvgCostCents: model.avgCostCents,
    modelTotalCostCents: model.totalCostCents,
    ...extra,
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40)
}

function evidenceString(evidence: Record<string, unknown>, key: string): string | null {
  const value = evidence[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function identityFor(candidate: AdvisorAdviceCandidate) {
  return {
    stage: candidate.stage,
    category: candidate.category,
    targetProvider: evidenceString(candidate.evidence, 'targetProvider'),
    targetModel: evidenceString(candidate.evidence, 'targetModel'),
    replacementProvider: evidenceString(candidate.evidence, 'replacementProvider'),
    replacementModel: evidenceString(candidate.evidence, 'replacementModel'),
  }
}

function signAdvice(candidate: AdvisorAdviceCandidate): AdvisorAdviceCandidateWithSignature {
  const signature = stableHash(identityFor(candidate))
  const evidenceSignature = stableHash(candidate.evidence)
  return {
    ...candidate,
    signature,
    evidenceSignature,
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

function modelRefFromEvidence(evidence: Record<string, unknown>, prefix = 'target'): StageProfileModelRef | null {
  const provider = evidenceString(evidence, `${prefix}Provider`)
  const model = evidenceString(evidence, `${prefix}Model`)
  return provider && model ? { provider, model } : null
}

function sameModel(a: StageProfileModelRef, b: StageProfileModelRef): boolean {
  return a.provider === b.provider && a.model === b.model
}

function demoteOrRemoveModel(
  refs: StageProfileModelRef[],
  target: StageProfileModelRef,
  mode: 'demote' | 'remove',
): { refs: StageProfileModelRef[]; changed: boolean } {
  const index = refs.findIndex((item) => sameModel(item, target))
  if (index < 0) return { refs, changed: false }
  if (mode === 'remove') {
    if (refs.length <= 1) return { refs, changed: false }
    return { refs: refs.filter((_, itemIndex) => itemIndex !== index), changed: true }
  }
  if (index === refs.length - 1 || refs.length <= 1) return { refs, changed: false }
  const next = refs.filter((_, itemIndex) => itemIndex !== index)
  next.push(refs[index])
  return { refs: next, changed: true }
}

function preferReplacementBeforeTarget(
  refs: StageProfileModelRef[],
  target: StageProfileModelRef,
  replacement: StageProfileModelRef,
): { refs: StageProfileModelRef[]; changed: boolean } {
  const targetIndex = refs.findIndex((item) => sameModel(item, target))
  const replacementIndex = refs.findIndex((item) => sameModel(item, replacement))
  if (targetIndex < 0 || replacementIndex < 0 || replacementIndex < targetIndex) return { refs, changed: false }
  const replacementRef = refs[replacementIndex]
  const withoutReplacement = refs.filter((_, index) => index !== replacementIndex)
  const nextTargetIndex = withoutReplacement.findIndex((item) => sameModel(item, target))
  const next = [...withoutReplacement]
  next.splice(nextTargetIndex, 0, replacementRef)
  return { refs: next, changed: true }
}

function adjustModelListOnly(candidate: Pick<AdvisorAdviceCandidateWithSignature, 'stage' | 'category' | 'severity' | 'evidence'>, draft: StageProfileSnapshot): boolean {
  const target = modelRefFromEvidence(candidate.evidence, 'target')
  if (!target) return false
  const lists: Array<{ get(): StageProfileModelRef[]; set(value: StageProfileModelRef[]): void }> = [
    { get: () => draft.models, set: (value) => { draft.models = value } },
  ]
  if (candidate.stage === 'REVIEW' && draft.verifier) {
    lists.push({ get: () => draft.verifier?.preferred ?? [], set: (value) => { if (draft.verifier) draft.verifier.preferred = value } })
  }

  for (const list of lists) {
    const refs = list.get()
    let result: { refs: StageProfileModelRef[]; changed: boolean }
    if (candidate.category === 'COST_OPTIMIZATION') {
      const replacement = modelRefFromEvidence(candidate.evidence, 'replacement')
      if (!replacement) continue
      result = preferReplacementBeforeTarget(refs, target, replacement)
    } else {
      result = demoteOrRemoveModel(refs, target, candidate.severity === 'CRITICAL' ? 'remove' : 'demote')
    }
    if (result.changed) {
      list.set(result.refs)
      return true
    }
  }
  return false
}

// E2/E4 — مسودة Snapshot للمراجعة فقط: تحفظ داخل التوصية ولا تطبّق نفسها.
// القاعدة الملزمة بعد E4: لا تغيّر المسودة إلا قوائم الموديلات/مفضّلات المدقق.
// لا تغيّر enabled، ولا allowGlobalFallback، ولا policy/provider.
export function buildAdvisorProposedSnapshot(
  candidate: Pick<AdvisorAdviceCandidateWithSignature, 'stage' | 'category' | 'severity' | 'evidence'>,
  currentSnapshot: StageProfileSnapshot | null,
): StageProfileSnapshot | null {
  if (!currentSnapshot || !currentSnapshot.enabled) return null
  if (candidate.category === 'COST_TELEMETRY') return null

  const draft = cloneSnapshot(currentSnapshot)
  const changed = adjustModelListOnly(candidate, draft)
  if (!changed) return null

  const validated = validateStageProfileSnapshot(candidate.stage, draft)
  return snapshotKey(validated) === snapshotKey(currentSnapshot) ? null : validated
}

async function attachAdvisorProposalDrafts(
  candidates: AdvisorAdviceCandidateWithSignature[],
): Promise<AdvisorAdviceCandidateWithSignature[]> {
  const currentByStage = new Map<PipelineStageName, Awaited<ReturnType<typeof getCurrentStageProfile>>>()
  for (const candidate of candidates) {
    if (!currentByStage.has(candidate.stage)) {
      currentByStage.set(candidate.stage, await getCurrentStageProfile(candidate.stage))
    }
  }
  return candidates.map((candidate) => {
    const current = currentByStage.get(candidate.stage) ?? null
    const proposedSnapshot = buildAdvisorProposedSnapshot(candidate, current?.snapshot ?? null)
    return {
      ...candidate,
      proposedSnapshot,
      targetProfileVersion: proposedSnapshot ? current?.version ?? null : null,
    }
  })
}

function readyModels(stage: AdvisorStageReadiness): AdvisorModelReadiness[] {
  return stage.modelStats.filter((model) => model.readyForModelAdvice && model.runs >= ADVISOR_MODEL_MIN_RUNS)
}

function addModelCostCandidates(stage: AdvisorStageReadiness, candidates: AdvisorAdviceCandidate[]) {
  if (stage.costCoverage < ADVISOR_COST_COVERAGE_TARGET) return
  const models = readyModels(stage).filter((model) => model.avgCostCents != null && model.successRate != null)
  for (const expensive of models) {
    const expensiveCost = expensive.avgCostCents ?? 0
    const expensiveSuccess = rate(expensive.successRate)
    const replacement = models
      .filter((candidate) => candidate.provider !== expensive.provider || candidate.model !== expensive.model)
      .filter((candidate) => (candidate.avgCostCents ?? Number.POSITIVE_INFINITY) < expensiveCost * (1 - ADVISOR_COST_SAVING_MIN_RATIO))
      .filter((candidate) => rate(candidate.successRate) + ADVISOR_COST_SUCCESS_PARITY_TOLERANCE >= expensiveSuccess)
      .sort((a, b) => (a.avgCostCents ?? 0) - (b.avgCostCents ?? 0))[0]
    if (!replacement) continue
    const savingPct = expensiveCost ? pct(1 - ((replacement.avgCostCents ?? expensiveCost) / expensiveCost)) : 0
    candidates.push({
      stage: stage.stage,
      category: 'COST_OPTIMIZATION',
      severity: 'INFO',
      title: `راجع ترتيب كلفة ${expensive.provider}/${expensive.model} في مرحلة ${stage.stage}`,
      rationale: `الموديل ${replacement.provider}/${replacement.model} يملك نجاحًا قريبًا وكلفة وسطية أقل بنحو ${savingPct}% ضمن بيانات D0 الجاهزة.`,
      evidence: modelEvidence(stage, expensive, {
        replacementProvider: replacement.provider,
        replacementModel: replacement.model,
        replacementRuns: replacement.runs,
        replacementSuccessRatePct: pct(rate(replacement.successRate)),
        replacementAvgCostCents: replacement.avgCostCents,
        savingPct,
      }),
      proposedSnapshot: null,
      targetProfileVersion: null,
    })
  }
}

export function buildAdvisorAdviceCandidates(report: AdvisorReadinessReport): AdvisorAdviceCandidateWithSignature[] {
  const candidates: AdvisorAdviceCandidate[] = []
  const stages = new Map(report.stages.map((stage) => [stage.stage, stage]))

  for (const stageName of ADVISOR_STAGES) {
    const stage = stages.get(stageName)
    if (!stage || !stage.readyForAdvice) continue

    for (const model of readyModels(stage)) {
      const failureRate = rate(model.failureRate)
      const fallbackRate = rate(model.fallbackRate)

      if (failureRate >= ADVISOR_ADVICE_MIN_FAILURE_RATE) {
        candidates.push({
          stage: stage.stage,
          category: 'MODEL_RELIABILITY',
          severity: severityForFailure(failureRate),
          title: `راجع موثوقية ${model.provider}/${model.model} في مرحلة ${stage.stage}`,
          rationale: `نسبة فشل هذا الموديل ${pct(failureRate)}% بعد ${model.runs} تشغيل، وهي أعلى من حد المراجعة ${pct(ADVISOR_ADVICE_MIN_FAILURE_RATE)}%.`,
          evidence: modelEvidence(stage, model),
          proposedSnapshot: null,
          targetProfileVersion: null,
        })
      }

      if (fallbackRate >= ADVISOR_ADVICE_MIN_FALLBACK_RATE) {
        candidates.push({
          stage: stage.stage,
          category: 'MODEL_FALLBACK',
          severity: severityForFallback(fallbackRate),
          title: `راجع اعتماد ${model.provider}/${model.model} على الرجوع للعام`,
          rationale: `نسبة الرجوع للعام لهذا الموديل ${pct(fallbackRate)}%، ما يعني أنه لا يستقر كفاية داخل بروفايل المرحلة.`,
          evidence: modelEvidence(stage, model),
          proposedSnapshot: null,
          targetProfileVersion: null,
        })
      }
    }

    addModelCostCandidates(stage, candidates)

    if (stage.costCoverage < ADVISOR_COST_COVERAGE_TARGET) {
      candidates.push({
        stage: stage.stage,
        category: 'COST_TELEMETRY',
        severity: 'INFO',
        title: `لا تصدر توصية تكلفة لمرحلة ${stage.stage} بعد`,
        rationale: `تغطية بيانات الكلفة ${pct(stage.costCoverage)}% فقط، لذلك تُحجب توصيات خفض التكلفة إلى أن تصل التغطية إلى ${pct(ADVISOR_COST_COVERAGE_TARGET)}%.`,
        evidence: evidenceFor(stage),
        proposedSnapshot: null,
        targetProfileVersion: null,
      })
    }
  }

  const severityRank: Record<AdvisorAdviceSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2 }
  return candidates
    .map(signAdvice)
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || ADVISOR_STAGES.indexOf(a.stage) - ADVISOR_STAGES.indexOf(b.stage))
    .slice(0, ADVISOR_ADVICE_MAX_PER_RUN)
}

function dateString(value: unknown): string | null {
  if (!value) return null
  return value instanceof Date ? value.toISOString() : String(value)
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
    targetProfileVersion: row.targetProfileVersion ?? null,
    signature: row.signature,
    evidenceSignature: row.evidenceSignature ?? '',
    activeDedupKey: row.activeDedupKey ?? '',
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    expiresAt: dateString(row.expiresAt),
    dismissedAt: dateString(row.dismissedAt),
    dismissedBy: row.dismissedBy ?? null,
    appliedAt: dateString(row.appliedAt),
    appliedBy: row.appliedBy ?? null,
    appliedProfileVersion: row.appliedProfileVersion ?? null,
  }
}

export async function expireOpenAdvisorAdvice(now = new Date()) {
  await db.aiAdvisorAdvice.updateMany({
    where: { status: 'OPEN', OR: [{ expiresAt: { lt: now } }, { expiresAt: null }] },
    data: { status: 'SUPERSEDED', activeDedupKey: null, dismissedAt: now },
  })
}

export async function listAdvisorAdvice(status: AdvisorAdviceStatus | 'ALL' = 'OPEN'): Promise<AdvisorAdviceRecord[]> {
  await expireOpenAdvisorAdvice()
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

async function supersedeExpiredDuplicate(activeDedupKey: string, now: Date): Promise<boolean> {
  const row = await db.aiAdvisorAdvice.findFirst({ where: { activeDedupKey } })
  if (!row) return false
  if (row.status === 'OPEN' && (!row.expiresAt || row.expiresAt < now)) {
    await db.aiAdvisorAdvice.update({
      where: { id: row.id },
      data: { status: 'SUPERSEDED', activeDedupKey: null, dismissedAt: now },
    })
    return false
  }
  return true
}

async function hasRecentClosedAdvice(signature: string, now: Date): Promise<boolean> {
  const cooldownStart = new Date(now.getTime() - ADVISOR_ADVICE_DISMISS_COOLDOWN_DAYS * 86_400_000)
  const row = await db.aiAdvisorAdvice.findFirst({
    where: {
      signature,
      OR: [
        { status: 'DISMISSED', dismissedAt: { gte: cooldownStart } },
        { status: 'APPLIED', appliedAt: { gte: cooldownStart } },
      ],
    },
    select: { id: true },
  })
  return !!row
}

export async function generateAdvisorAdvice(actorId?: string | null): Promise<{ created: number; skipped: number; advice: AdvisorAdviceRecord[] }> {
  const now = new Date()
  await expireOpenAdvisorAdvice(now)
  const report = await getAiAdvisorReadiness()
  const candidates = await attachAdvisorProposalDrafts(buildAdvisorAdviceCandidates(report))
  let created = 0
  let skipped = 0

  for (const candidate of candidates) {
    if (await supersedeExpiredDuplicate(candidate.activeDedupKey, now)) {
      skipped += 1
      continue
    }
    if (await hasRecentClosedAdvice(candidate.signature, now)) {
      skipped += 1
      continue
    }
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
          targetProfileVersion: candidate.targetProfileVersion,
          signature: candidate.signature,
          evidenceSignature: candidate.evidenceSignature,
          activeDedupKey: candidate.activeDedupKey,
          expiresAt: daysFrom(now, ADVISOR_ADVICE_EXPIRES_DAYS),
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

export async function validateAdvisorAdviceApplication(
  id: string,
  stage: PipelineStageName,
  snapshot: StageProfileSnapshot,
  currentProfileVersion: number,
): Promise<void> {
  const row = await db.aiAdvisorAdvice.findUnique({ where: { id } })
  if (!row) throw new AdvisorAdviceApplicationError('التوصية غير موجودة', 404)
  if (row.status !== 'OPEN') throw new AdvisorAdviceApplicationError('التوصية لم تعد مفتوحة', 409)
  if (row.stage !== stage) throw new AdvisorAdviceApplicationError('التوصية لا تخص هذه المرحلة', 400)
  if (!row.proposedSnapshot) throw new AdvisorAdviceApplicationError('التوصية لا تحمل مسودة قابلة للحفظ', 400)
  if (row.targetProfileVersion == null || row.targetProfileVersion !== currentProfileVersion) {
    throw new AdvisorAdviceApplicationError('المسودة مبنية على نسخة قديمة من البروفايل. أعد توليد التوصية قبل الحفظ.', 409)
  }
  if (snapshotKey(row.proposedSnapshot as unknown as StageProfileSnapshot) !== snapshotKey(snapshot)) {
    throw new AdvisorAdviceApplicationError('المسودة المحفوظة لا تطابق النموذج الحالي. أعد تحميل المسودة من التوصية.', 409)
  }
}

export async function markAdvisorAdviceApplied(
  id: string,
  actorId: string | null | undefined,
  appliedProfileVersion: number,
): Promise<AdvisorAdviceRecord> {
  const row = await db.aiAdvisorAdvice.update({
    where: { id },
    data: {
      status: 'APPLIED',
      activeDedupKey: null,
      appliedAt: new Date(),
      appliedBy: actorId ?? null,
      appliedProfileVersion,
    },
  })
  return toRecord(row)
}
