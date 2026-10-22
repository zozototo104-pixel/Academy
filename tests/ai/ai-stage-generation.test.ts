import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

mock.module('@/lib/db', () => ({ db: { aiPipelineOperationLog: { create: async () => ({}) } } }))
mock.module('@/lib/text-ai', () => ({
  pipelineConfigSnapshot: async () => ({ policy: 'balanced', allowedModels: ['GEMINI:g'], verifierPreferred: [] }),
}))

import type { StageUsage } from '@/lib/ai-stage-runner'

const profiles = await import('@/lib/ai-stage-profiles')
const { prepareStageRun, runStageAttempt } = await import('@/lib/ai-stage-runner')
const { __setPipelineLogDepsForTests, withPipelineRun } = await import('@/lib/ai-pipeline-log')

// مخزن بروفايلات ذاكري حقيقي عبر خطاف الاختبار — المسار كله فعلي:
// حفظ → حسم → تجاوزات → منفّذ → مسجّل.
const memory = new Map<string, { profileId: string; version: number; snapshot: never }>()
profiles.__setStageProfileStoreForTests({
  async loadCurrent(stage) {
    const row = memory.get(stage)
    return row ? { profileId: row.profileId, version: row.version, snapshot: row.snapshot } : null
  },
  async saveVersion(stage, snapshot) {
    const prev = memory.get(stage)
    const version = (prev?.version ?? 0) + 1
    memory.set(stage, { profileId: prev?.profileId ?? `profile-${stage}`, version, snapshot: snapshot as never })
    return { profileId: memory.get(stage)!.profileId, version }
  },
  async loadVersions() { return [] },
})

async function saveGeneration(raw: Record<string, unknown>) {
  memory.clear()
  await profiles.saveStageProfile('GENERATION', raw, 'test-admin')
}

describe('D2.3 behavioral: the generation profile actually restricts the attempt', () => {
  test('a stage profile hands the attempt its exact model list, once', async () => {
    await saveGeneration({ models: [{ provider: 'GEMINI', model: 'gen-a' }], allowGlobalFallback: false })
    const plan = await prepareStageRun('GENERATION')
    expect(plan.isStage).toBe(true)
    expect(plan.profileStamp?.profileId).toContain('profile-GENERATION')
    const seen: unknown[] = []
    const usage: StageUsage = { fallbackUsed: false }
    const out = await runStageAttempt(plan, usage, async (routing) => { seen.push(routing); return 'ok' })
    expect(out).toBe('ok')
    expect(seen).toHaveLength(1)
    expect((seen[0] as { preferredModels: unknown }).preferredModels).toEqual([{ provider: 'GEMINI', model: 'gen-a' }])
    expect(usage.fallbackUsed).toBe(false)
  })

  test('no profile means a single unrestricted (global) attempt', async () => {
    memory.clear()
    const plan = await prepareStageRun('GENERATION')
    expect(plan.isStage).toBe(false)
    const seen: unknown[] = []
    await runStageAttempt(plan, { fallbackUsed: false }, async (routing) => { seen.push(routing); return 1 })
    expect(seen).toEqual([null])
  })

  test('with fallback forbidden, a stage failure is final and unmarked', async () => {
    await saveGeneration({ models: [{ provider: 'GEMINI', model: 'gen-a' }], allowGlobalFallback: false })
    const plan = await prepareStageRun('GENERATION')
    const usage: StageUsage = { fallbackUsed: false }
    let calls = 0
    await expect(runStageAttempt(plan, usage, async () => { calls++; throw new Error('STAGE_DOWN') })).rejects.toThrow('STAGE_DOWN')
    expect(calls).toBe(1)
    expect(usage.fallbackUsed).toBe(false)
  })
})

describe('D2.3 behavioral: the fallback is marked at decision time, even when it also fails', () => {
  test('stage fails → global attempt fails → the recorded failure row still shows the fallback', async () => {
    await saveGeneration({ models: [{ provider: 'GEMINI', model: 'gen-a' }], allowGlobalFallback: true })
    const plan = await prepareStageRun('GENERATION')
    const usage: StageUsage = { fallbackUsed: false }
    const rows: Record<string, unknown>[] = []
    __setPipelineLogDepsForTests({
      writer: async (row) => { rows.push(row as unknown as Record<string, unknown>) },
      snapshot: async () => ({ policy: 'balanced', allowedModels: [], verifierPreferred: [] }),
    })
    const markedBeforeRetry: boolean[] = []
    await expect(withPipelineRun(
      { stage: 'GENERATION', batchId: 'job-1', profileStamp: plan.profileStamp, fallbackUsed: !plan.isStage, liveState: usage, detail: plan.detail },
      () => runStageAttempt(plan, usage, async (routing) => {
        if (routing === null) markedBeforeRetry.push(usage.fallbackUsed)
        throw new Error(routing ? 'STAGE_DOWN' : 'GLOBAL_DOWN')
      }),
    )).rejects.toThrow('GLOBAL_DOWN')
    // الوسم كان مضبوطًا قبل بدء محاولة الرجوع نفسها
    expect(markedBeforeRetry).toEqual([true])
    expect(rows).toHaveLength(1)
    expect(rows[0].success).toBe(false)
    expect(rows[0].fallbackUsed).toBe(true)
    expect((rows[0].detail as Record<string, unknown>).fallbackReason).toBe('all-stage-models-failed')
    expect(rows[0].profileId).toContain('profile-GENERATION')
  })

  test('a stage failure followed by a global success returns the global result, marked', async () => {
    await saveGeneration({ models: [{ provider: 'GEMINI', model: 'gen-a' }], allowGlobalFallback: true })
    const plan = await prepareStageRun('GENERATION')
    const usage: StageUsage = { fallbackUsed: false }
    const out = await runStageAttempt(plan, usage, async (routing) => {
      if (routing) throw new Error('STAGE_DOWN')
      return 'global-result'
    })
    expect(out).toBe('global-result')
    expect(usage.fallbackUsed).toBe(true)
    expect(usage.fallbackReason).toBe('all-stage-models-failed')
  })
})

describe('D2.3 scope guards: both generation paths wired, review untouched', () => {
  test('question-bank generation resolves GENERATION and restricts; its review block stays unstamped', () => {
    const job = readFileSync('src/lib/question-bank-job.ts', 'utf8')
    expect(job).toContain("prepareStageRun('GENERATION')")
    expect(job).toContain('restrictToModels: routingModels')
    expect(job.split('profileStamp: genPlan.profileStamp')).toHaveLength(2) // generation ctx only — the REVIEW run below stays as D0 left it
    expect(job).toContain("stage: 'REVIEW'")
  })

  test('comprehensive-exam generation now enters the log under the same plan', () => {
    const booksAi = readFileSync('src/lib/books-ai.ts', 'utf8')
    expect(booksAi).toContain("prepareStageRun('GENERATION')")
    expect(booksAi).toContain("source: 'comprehensive-exam'")
    expect(booksAi).toContain('restrictToModels: routingModels')
  })

  test('the verifier itself does not resolve profiles (its wiring lands in D2.4 via the job)', () => {
    const verifier = readFileSync('src/lib/question-verifier.ts', 'utf8')
    expect(verifier).not.toContain('prepareStageRun')
    expect(verifier).not.toContain('resolveEffectiveStageProfile')
    expect(verifier).not.toContain('ai-stage-profiles')
  })
})
