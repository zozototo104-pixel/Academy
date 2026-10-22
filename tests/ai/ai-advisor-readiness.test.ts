import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  ADVISOR_COST_COVERAGE_TARGET,
  ADVISOR_READINESS_MIN_DAYS,
  ADVISOR_READINESS_MIN_STAGE_RUNS,
  evaluateStageReadiness,
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

function reportWith(stage: ReturnType<typeof evaluateStageReadiness>): AdvisorReadinessReport {
  return {
    generatedAt: '2026-10-22T00:00:00.000Z',
    gates: {
      minDays: ADVISOR_READINESS_MIN_DAYS,
      minStageRuns: ADVISOR_READINESS_MIN_STAGE_RUNS,
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

  test('marks stage ready when operations and days meet the gate while separately reporting cost coverage', () => {
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
    })
    expect(stage.readyForAdvice).toBe(true)
    expect(stage.successRate).toBe(0.8)
    expect(stage.failureRate).toBe(0.2)
    expect(stage.fallbackRate).toBe(0.06)
    expect(stage.costCoverageGap).toBeGreaterThan(0)
  })

  test('E0 is read-only and does not create advisor records or actions', () => {
    expect(source).toContain('E0 قراءة فقط')
    expect(source).toContain('getAiAdvisorReadiness')
    expect(source).not.toContain('.create(')
    expect(source).not.toContain('saveStageProfile(')
    expect(apiRoute).toContain('getAiAdvisorReadiness()')
    expect(adminComponent).toContain('E0 — تقرير جاهزية المستشار')
    expect(adminComponent).toContain('لا يكتب')
    expect(adminComponent).not.toContain('طبّق النصيحة')
    expect(adminComponent).not.toContain('تطبيق النصيحة')
  })
})

describe('E1 advisor advice', () => {
  test('does not create advice candidates for stages that have not passed E0 readiness', () => {
    const now = new Date('2026-10-22T00:00:00Z')
    const stage = evaluateStageReadiness({
      ...base,
      totalRuns: ADVISOR_READINESS_MIN_STAGE_RUNS - 1,
      firstRunAt: new Date(now.getTime() - ADVISOR_READINESS_MIN_DAYS * 86_400_000),
      lastRunAt: now,
    })

    expect(buildAdvisorAdviceCandidates(reportWith(stage))).toEqual([])
  })

  test('creates deterministic review-only advice from ready D0 metrics and gates cost advice on coverage', () => {
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
    })

    const advice = buildAdvisorAdviceCandidates(reportWith(stage))
    expect(advice.map((item) => item.category)).toEqual(['RELIABILITY', 'FALLBACK', 'COST_TELEMETRY'])
    expect(advice.every((item) => item.proposedSnapshot === null)).toBe(true)
    expect(advice.every((item) => item.activeDedupKey.includes(item.stage))).toBe(true)
    expect(advice[0].signature).toBe(buildAdvisorAdviceCandidates(reportWith(stage))[0].signature)
  })

  test('E1 persists recommendations only and never applies them to stage profiles', () => {
    expect(schema).toContain('model AiAdvisorAdvice')
    expect(schema).toContain('activeDedupKey')
    expect(adviceSource).toContain('E1 — توصيات مراجعة فقط')
    expect(adviceSource).toContain('buildAdvisorAdviceCandidates')
    expect(adviceSource).toContain('db.aiAdvisorAdvice.create')
    expect(adviceSource).toContain('dismissAdvisorAdvice')
    expect(adviceSource).not.toContain('saveStageProfile(')
    expect(advisorRoute).toContain('generateAdvisorAdvice(')
    expect(advisorRoute).toContain('dismissAdvisorAdvice(')
    expect(advisorRoute).not.toContain('saveStageProfile(')
    expect(adminComponent).toContain('E1 — توصيات المستشار')
    expect(adminComponent).toContain('توليد توصيات E1')
    expect(adminComponent).toContain('إغلاق التوصية')
    expect(adminComponent).not.toContain('applyAdvice')
    expect(adminComponent).not.toContain('طبّق النصيحة')
    expect(adminComponent).not.toContain('تطبيق النصيحة')
  })
})
