import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  ADVISOR_COST_COVERAGE_TARGET,
  ADVISOR_MODEL_MIN_RUNS,
  ADVISOR_READINESS_MIN_DAYS,
  ADVISOR_READINESS_MIN_STAGE_RUNS,
  evaluateStageReadiness,
  type AdvisorModelReadinessInput,
  type AdvisorReadinessReport,
} from '@/lib/ai-advisor-readiness'
import { buildAdvisorAdviceCandidates, buildAdvisorProposedSnapshot } from '@/lib/ai-advisor-advice'

const source = readFileSync('src/lib/ai-advisor-readiness.ts', 'utf8')
const adviceSource = readFileSync('src/lib/ai-advisor-advice.ts', 'utf8')
const apiRoute = readFileSync('src/app/api/admin/ai-stage-profiles/route.ts', 'utf8')
const advisorRoute = readFileSync('src/app/api/admin/ai-advisor/route.ts', 'utf8')
const schema = readFileSync('prisma/schema.prisma', 'utf8')
const adminComponent = readFileSync('src/components/aact/AdminAiStageProfiles.tsx', 'utf8')

const base = {
  stage: 'GENERATION' as const,
  successRuns: 0,
  failureRuns: 0,
  fallbackRuns: 0,
  tokenRows: 0,
  costRows: 0,
  avgLatencyMs: null,
  totalInputTokens: null,
  totalOutputTokens: null,
  totalCostCents: null,
}

function model(overrides: Partial<AdvisorModelReadinessInput> = {}): AdvisorModelReadinessInput {
  return {
    provider: 'GEMINI',
    model: 'gemini-2.5-pro',
    runs: ADVISOR_MODEL_MIN_RUNS,
    successRuns: 20,
    failureRuns: 10,
    fallbackRuns: 5,
    tokenRows: ADVISOR_MODEL_MIN_RUNS,
    costRows: ADVISOR_MODEL_MIN_RUNS,
    avgLatencyMs: 900,
    totalInputTokens: 3000,
    totalOutputTokens: 1200,
    totalCostCents: 50,
    avgCostCents: 1.5,
    ...overrides,
  }
}

function reportWith(stage: ReturnType<typeof evaluateStageReadiness>): AdvisorReadinessReport {
  return {
    generatedAt: '2026-10-22T00:00:00.000Z',
    gates: {
      minDays: ADVISOR_READINESS_MIN_DAYS,
      minStageRuns: ADVISOR_READINESS_MIN_STAGE_RUNS,
      minModelRuns: ADVISOR_MODEL_MIN_RUNS,
      costCoverageTarget: ADVISOR_COST_COVERAGE_TARGET,
    },
    stages: [stage],
    readyStages: stage.readyForAdvice ? [stage.stage] : [],
    blockedStages: stage.readyForAdvice ? [] : [stage.stage],
    allStagesReady: stage.readyForAdvice,
    notes: [],
  }
}

describe('E0 advisor readiness', () => {
  test('blocks advice readiness until the stage has enough operations and days', () => {
    const now = new Date('2026-10-22T00:00:00Z')
    const stage = evaluateStageReadiness({
      ...base,
      totalRuns: ADVISOR_READINESS_MIN_STAGE_RUNS - 1,
      firstRunAt: new Date(now.getTime() - (ADVISOR_READINESS_MIN_DAYS - 1) * 86_400_000),
      lastRunAt: now,
    })
    expect(stage.readyForAdvice).toBe(false)
    expect(stage.operationsGap).toBe(1)
    expect(stage.daysGap).toBe(1)
    expect(stage.gaps.join(' ')).toContain('ينقص')
  })

  test('marks stage ready while separately evaluating model readiness and cost coverage', () => {
    const now = new Date('2026-10-22T00:00:00Z')
    const stage = evaluateStageReadiness({
      ...base,
      totalRuns: ADVISOR_READINESS_MIN_STAGE_RUNS,
      successRuns: 160,
      failureRuns: 40,
      fallbackRuns: 12,
      tokenRows: ADVISOR_READINESS_MIN_STAGE_RUNS,
      costRows: Math.floor(ADVISOR_READINESS_MIN_STAGE_RUNS * ADVISOR_COST_COVERAGE_TARGET) - 1,
      firstRunAt: new Date(now.getTime() - ADVISOR_READINESS_MIN_DAYS * 86_400_000),
      lastRunAt: now,
      modelStats: [model({ runs: ADVISOR_MODEL_MIN_RUNS - 1 })],
    })
    expect(stage.readyForAdvice).toBe(true)
    expect(stage.successRate).toBe(0.8)
    expect(stage.failureRate).toBe(0.2)
    expect(stage.fallbackRate).toBe(0.06)
    expect(stage.costCoverageGap).toBeGreaterThan(0)
    expect(stage.modelStats[0].readyForModelAdvice).toBe(false)
  })

  test('E0 is read-only and exposes per-model stats without creating advisor actions', () => {
    expect(source).toContain('E0 قراءة فقط')
    expect(source).toContain('modelStats')
    expect(source).toContain('ADVISOR_MODEL_MIN_RUNS')
    expect(source).toContain('getAiAdvisorReadiness')
    expect(source).not.toContain('.create(')
    expect(source).not.toContain('saveStageProfile(')
    expect(apiRoute).toContain('getAiAdvisorReadiness()')
    expect(adminComponent).toContain('E0 — تقرير جاهزية المستشار')
    expect(adminComponent).toContain('إحصاء الموديلات')
    expect(adminComponent).toContain('لا يكتب')
    expect(adminComponent).not.toContain('طبّق النصيحة')
    expect(adminComponent).not.toContain('تطبيق النصيحة')
  })
})

describe('E1/E4 advisor advice', () => {
  test('does not create advice candidates for stages that have not passed E0 readiness', () => {
    const now = new Date('2026-10-22T00:00:00Z')
    const stage = evaluateStageReadiness({
      ...base,
      totalRuns: ADVISOR_READINESS_MIN_STAGE_RUNS - 1,
      firstRunAt: new Date(now.getTime() - ADVISOR_READINESS_MIN_DAYS * 86_400_000),
      lastRunAt: now,
      modelStats: [model({ runs: ADVISOR_MODEL_MIN_RUNS, failureRuns: 20, successRuns: 10 })],
    })

    expect(buildAdvisorAdviceCandidates(reportWith(stage))).toEqual([])
  })

  test('creates deterministic model-level advice and gates cost advice on coverage', () => {
    const now = new Date('2026-10-22T00:00:00Z')
    const stage = evaluateStageReadiness({
      ...base,
      totalRuns: ADVISOR_READINESS_MIN_STAGE_RUNS,
      successRuns: 130,
      failureRuns: 70,
      fallbackRuns: 30,
      tokenRows: ADVISOR_READINESS_MIN_STAGE_RUNS,
      costRows: Math.floor(ADVISOR_READINESS_MIN_STAGE_RUNS * ADVISOR_COST_COVERAGE_TARGET) - 1,
      firstRunAt: new Date(now.getTime() - ADVISOR_READINESS_MIN_DAYS * 86_400_000),
      lastRunAt: now,
      modelStats: [model({ runs: 100, successRuns: 55, failureRuns: 45, fallbackRuns: 20 })],
    })

    const advice = buildAdvisorAdviceCandidates(reportWith(stage))
    expect(advice.map((item) => item.category)).toEqual(['MODEL_RELIABILITY', 'MODEL_FALLBACK', 'COST_TELEMETRY'])
    expect(advice[0].evidence.targetProvider).toBe('GEMINI')
    expect(advice[0].evidence.targetModel).toBe('gemini-2.5-pro')
    expect(advice.every((item) => item.proposedSnapshot === null)).toBe(true)
    expect(advice.every((item) => item.activeDedupKey.includes(item.stage))).toBe(true)
    expect(advice[0].signature).toBe(buildAdvisorAdviceCandidates(reportWith(stage))[0].signature)
  })

  test('creates cost optimization advice only from model-level cost and success parity', () => {
    const now = new Date('2026-10-22T00:00:00Z')
    const stage = evaluateStageReadiness({
      ...base,
      totalRuns: ADVISOR_READINESS_MIN_STAGE_RUNS,
      successRuns: 180,
      failureRuns: 20,
      fallbackRuns: 5,
      tokenRows: ADVISOR_READINESS_MIN_STAGE_RUNS,
      costRows: ADVISOR_READINESS_MIN_STAGE_RUNS,
      firstRunAt: new Date(now.getTime() - ADVISOR_READINESS_MIN_DAYS * 86_400_000),
      lastRunAt: now,
      modelStats: [
        model({ provider: 'OPENAI', model: 'gpt-expensive', runs: 100, successRuns: 90, failureRuns: 10, fallbackRuns: 0, avgCostCents: 10 }),
        model({ provider: 'GEMINI', model: 'gemini-cheaper', runs: 100, successRuns: 88, failureRuns: 12, fallbackRuns: 0, avgCostCents: 6 }),
      ],
    })

    const advice = buildAdvisorAdviceCandidates(reportWith(stage))
    expect(advice.map((item) => item.category)).toEqual(['COST_OPTIMIZATION'])
    expect(advice[0].evidence.targetModel).toBe('gpt-expensive')
    expect(advice[0].evidence.replacementModel).toBe('gemini-cheaper')
  })

  test('E1 persists recommendations only and never applies them from the advisor route', () => {
    expect(schema).toContain('model AiAdvisorAdvice')
    expect(schema).toContain('targetProfileVersion')
    expect(schema).toContain('appliedProfileVersion')
    expect(schema).toContain('expiresAt')
    expect(adviceSource).toContain('E1/E2/E3/E4')
    expect(adviceSource).toContain('buildAdvisorAdviceCandidates')
    expect(adviceSource).toContain('db.aiAdvisorAdvice.create')
    expect(adviceSource).toContain('dismissAdvisorAdvice')
    expect(adviceSource).not.toContain('saveStageProfile(')
    expect(advisorRoute).toContain('generateAdvisorAdvice(')
    expect(advisorRoute).toContain('dismissAdvisorAdvice(')
    expect(advisorRoute).not.toContain('saveStageProfile(')
    expect(adminComponent).toContain('E1/E2/E3/E4 — توصيات المستشار')
    expect(adminComponent).toContain('توليد توصيات E1')
    expect(adminComponent).toContain('إغلاق التوصية')
    expect(adminComponent).not.toContain('applyAdvice')
    expect(adminComponent).not.toContain('طبّق النصيحة')
    expect(adminComponent).not.toContain('تطبيق النصيحة')
  })
})

describe('E2/E4 advisor proposal drafts', () => {
  const currentSnapshot = {
    enabled: true,
    provider: 'GEMINI',
    policy: 'quality_first',
    models: [
      { provider: 'GEMINI', model: 'gemini-bad' },
      { provider: 'OPENAI', model: 'gpt-good' },
    ],
    allowGlobalFallback: false,
    verifier: null,
  }

  test('builds validated drafts that change only model lists and never flip fallback/enabled flags', () => {
    const warningDraft = buildAdvisorProposedSnapshot(
      {
        stage: 'GENERATION',
        category: 'MODEL_RELIABILITY',
        severity: 'WARNING',
        evidence: { targetProvider: 'GEMINI', targetModel: 'gemini-bad' },
      },
      currentSnapshot,
    )
    expect(warningDraft).toEqual({
      ...currentSnapshot,
      models: [
        { provider: 'OPENAI', model: 'gpt-good' },
        { provider: 'GEMINI', model: 'gemini-bad' },
      ],
    })
    expect(warningDraft?.enabled).toBe(currentSnapshot.enabled)
    expect(warningDraft?.allowGlobalFallback).toBe(currentSnapshot.allowGlobalFallback)

    const criticalDraft = buildAdvisorProposedSnapshot(
      {
        stage: 'GENERATION',
        category: 'MODEL_RELIABILITY',
        severity: 'CRITICAL',
        evidence: { targetProvider: 'GEMINI', targetModel: 'gemini-bad' },
      },
      currentSnapshot,
    )
    expect(criticalDraft).toEqual({ ...currentSnapshot, models: [{ provider: 'OPENAI', model: 'gpt-good' }] })

    const singleModelDraft = buildAdvisorProposedSnapshot(
      {
        stage: 'GENERATION',
        category: 'MODEL_RELIABILITY',
        severity: 'CRITICAL',
        evidence: { targetProvider: 'GEMINI', targetModel: 'gemini-bad' },
      },
      { ...currentSnapshot, models: [{ provider: 'GEMINI', model: 'gemini-bad' }] },
    )
    expect(singleModelDraft).toBeNull()
  })

  test('cost optimization drafts only reorder existing listed models', () => {
    const costDraft = buildAdvisorProposedSnapshot(
      {
        stage: 'GENERATION',
        category: 'COST_OPTIMIZATION',
        severity: 'INFO',
        evidence: {
          targetProvider: 'GEMINI',
          targetModel: 'gemini-bad',
          replacementProvider: 'OPENAI',
          replacementModel: 'gpt-good',
        },
      },
      currentSnapshot,
    )
    expect(costDraft?.models).toEqual([
      { provider: 'OPENAI', model: 'gpt-good' },
      { provider: 'GEMINI', model: 'gemini-bad' },
    ])

    const absentReplacement = buildAdvisorProposedSnapshot(
      {
        stage: 'GENERATION',
        category: 'COST_OPTIMIZATION',
        severity: 'INFO',
        evidence: {
          targetProvider: 'GEMINI',
          targetModel: 'gemini-bad',
          replacementProvider: 'ANTHROPIC',
          replacementModel: 'claude-not-listed',
        },
      },
      currentSnapshot,
    )
    expect(absentReplacement).toBeNull()
  })

  test('E2 drafts are persisted inside advice only and have no direct apply path', () => {
    expect(adviceSource).toContain('مسودة Snapshot')
    expect(adviceSource).toContain('getCurrentStageProfile')
    expect(adviceSource).toContain('validateStageProfileSnapshot')
    expect(adviceSource).toContain('proposedSnapshot')
    expect(adviceSource).toContain('targetProfileVersion')
    expect(adviceSource).not.toContain('saveStageProfile(')
    expect(advisorRoute).not.toContain('saveStageProfile(')
    expect(adminComponent).toContain('مسودة E2/E4 محفوظة للمراجعة فقط')
    expect(adminComponent).not.toContain('applyAdvice')
    expect(adminComponent).not.toContain('طبّق النصيحة')
    expect(adminComponent).not.toContain('تطبيق النصيحة')
  })
})

describe('E3/E4 advisor draft review bridge', () => {
  test('loads an E2 draft into the existing stage form with target-version checks and closes the loop only through normal save', () => {
    expect(adminComponent).toContain('loadAdvisorDraftIntoForm')
    expect(adminComponent).toContain('snapshotToForm(advice.proposedSnapshot)')
    expect(adminComponent).toContain('targetProfileVersion')
    expect(adminComponent).toContain('أعد توليد التوصية')
    expect(adminComponent).toContain('مسودة مستشار محمّلة')
    expect(adminComponent).toContain('تحميل المسودة للمراجعة اليدوية')
    expect(adminComponent).toContain('حفظ نسخة جديدة')
    expect(adminComponent).toContain('تم اعتماد مسودة المستشار')
    expect(apiRoute).toContain('validateAdvisorAdviceApplication')
    expect(apiRoute).toContain('markAdvisorAdviceApplied')
    expect(apiRoute).toContain('saveStageProfile(')
    expect(advisorRoute).not.toContain('proposedSnapshot')
    expect(advisorRoute).not.toContain('saveStageProfile(')
    expect(adminComponent).not.toContain('applyAdvice')
    expect(adminComponent).not.toContain('approveAdvice')
  })
})
