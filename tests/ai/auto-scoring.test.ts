/// <reference types="bun-types" />
import { describe, expect, test } from 'bun:test'

// Step 5 — self-scoring engine (pure): scoreModelForTask /
// rankModelsForTask / stickyOrderUnderAuto / splitOcrBudget /
// buildAutoRankingPayload / isAutoRankingStale. No database, no fetch.
const autoMode = await import('../../src/lib/ai-auto-mode')

type Stats = Parameters<typeof autoMode.scoreModelForTask>[0]['stats']

function stats(partial: Partial<NonNullable<Stats>> = {}): NonNullable<Stats> {
  return {
    success: 0, fail: {}, avgMs: 0,
    jsonOk: 0, jsonTotal: 0, evidenceOk: 0, evidenceTotal: 0,
    ...partial,
  }
}

function base(overrides: Partial<Parameters<typeof autoMode.scoreModelForTask>[0]> = {}) {
  return {
    provider: 'GROQ', model: 'llama-3.3-70b-versatile', purpose: 'CHAT',
    capability: { vision: true, ocr: true, extraction: true, audit: true, contextLength: 131072, costTier: 'free' as const },
    ...overrides,
  }
}

describe('scoreModelForTask — real output quality beats raw success', () => {
  test('a 90%-success model failing validation scores below a 70%-success model passing it', () => {
    const flashy = autoMode.scoreModelForTask(base({
      model: 'flashy', stats: stats({ success: 90, fail: { other: 10 }, validateOk: 4, validateTotal: 10 }),
    }))
    const solid = autoMode.scoreModelForTask(base({
      model: 'solid', stats: stats({ success: 70, fail: { other: 30 }, validateOk: 19, validateTotal: 20 }),
    }))
    expect(solid.score).toBeGreaterThan(flashy.score)
    expect(solid.components.quality).toBeGreaterThan(flashy.components.quality)
  })

  test('HTTP 200 with garbage output is a failure: OCR-gate failures demote the VISION score', () => {
    const clean = autoMode.scoreModelForTask(base({
      purpose: 'VISION', model: 'clean',
      stats: stats({ success: 9, fail: { ocr_gate_failed: 1 }, validateOk: 9, validateTotal: 10, ocrGateOk: 9, ocrGateTotal: 10 }),
    }))
    const garbage = autoMode.scoreModelForTask(base({
      purpose: 'VISION', model: 'garbage',
      stats: stats({ success: 9, fail: { ocr_gate_failed: 9 }, validateOk: 9, validateTotal: 10, ocrGateOk: 1, ocrGateTotal: 10 }),
    }))
    expect(clean.score).toBeGreaterThan(garbage.score)
    expect(garbage.components.quality).toBeLessThan(clean.components.quality)
  })

  test('recent success outweighs all-time: a model that just recovered outranks a stale good one', () => {
    const recovering = autoMode.scoreModelForTask(base({
      model: 'recovering',
      stats: stats({ success: 50, fail: { other: 50 }, recentSuccess: 9, recentFail: 1 }),
    }))
    const stale = autoMode.scoreModelForTask(base({
      model: 'stale',
      stats: stats({ success: 90, fail: { other: 10 }, recentSuccess: 1, recentFail: 9 }),
    }))
    expect(recovering.components.recentSuccess).toBeGreaterThan(stale.components.recentSuccess)
    expect(recovering.score).toBeGreaterThan(stale.score)
  })
})

describe('scoreModelForTask — hard filters', () => {
  test('capability hard filter: vision+ocr both false excludes from VISION', () => {
    const excluded = autoMode.scoreModelForTask(base({
      purpose: 'VISION', capability: { vision: false, ocr: false, contextLength: 100000 },
    }))
    expect(excluded.excludedReason).toBe('CAPABILITY_MISSING:vision/ocr')
    expect(excluded.score).toBe(0)
    const kept = autoMode.scoreModelForTask(base({
      purpose: 'VISION', capability: { vision: true, ocr: false, contextLength: 100000 },
    }))
    expect(kept.excludedReason).toBeUndefined()
  })

  test('capability hard filter: audit false excludes from REVIEW, extraction false from ANALYSIS', () => {
    expect(autoMode.scoreModelForTask(base({ purpose: 'REVIEW', capability: { audit: false } })).excludedReason).toBe('CAPABILITY_MISSING:audit')
    expect(autoMode.scoreModelForTask(base({ purpose: 'ANALYSIS', capability: { extraction: false } })).excludedReason).toBe('CAPABILITY_MISSING:extraction')
  })

  test('unknown capability is not proof of absence: no catalog row still qualifies', () => {
    const scored = autoMode.scoreModelForTask(base({ purpose: 'VISION', capability: null }))
    expect(scored.excludedReason).toBeUndefined()
  })

  test('quota-cooled model never ranks top', () => {
    const cooled = autoMode.scoreModelForTask(base({
      model: 'cooled', stats: stats({ success: 100, validateOk: 10, validateTotal: 10 }),
      quotaState: { cooldownUntilMs: Date.now() + 600_000, rate429Count: 12 },
    }))
    expect(cooled.excludedReason).toBe('QUOTA_COOLDOWN')
    const ranked = autoMode.rankModelsForTask([
      base({ model: 'cooled', stats: stats({ success: 100, validateOk: 10, validateTotal: 10 }), quotaState: { cooldownUntilMs: Date.now() + 600_000 } }),
      base({ model: 'plain', stats: stats({ success: 10, validateOk: 5, validateTotal: 10 }) }),
    ])
    expect(ranked[0].model).toBe('plain')
    expect(ranked[ranked.length - 1].model).toBe('cooled')
  })

  test('no-balance model is excluded, not merely demoted', () => {
    const scored = autoMode.scoreModelForTask(base({ quotaState: { noBalance: true } }))
    expect(scored.excludedReason).toBe('NO_BALANCE')
  })
})

describe('scoreModelForTask — paid, context, per-purpose rank', () => {
  test('paid model never ranks when allowPaid is false; ranks when explicitly allowed', () => {
    const blocked = autoMode.scoreModelForTask(base({
      capability: { costTier: 'paid' as const }, costState: { allowPaid: false, costTier: 'paid' },
    }))
    expect(blocked.excludedReason).toBe('PAID_BLOCKED')
    const allowed = autoMode.scoreModelForTask(base({
      capability: { costTier: 'paid' as const }, costState: { allowPaid: true, costTier: 'paid', budgetOk: true },
    }))
    expect(allowed.excludedReason).toBeUndefined()
    const budgetGone = autoMode.scoreModelForTask(base({
      capability: { costTier: 'paid' as const }, costState: { allowPaid: true, costTier: 'paid', budgetOk: false },
    }))
    expect(budgetGone.excludedReason).toBe('PAID_BUDGET_EXHAUSTED')
  })

  test('context too small excludes', () => {
    const scored = autoMode.scoreModelForTask(base({
      capability: { contextLength: 8000 }, contextNeededTokens: 20000,
    }))
    expect(scored.excludedReason).toBe('CONTEXT_TOO_SMALL')
    const fits = autoMode.scoreModelForTask(base({
      capability: { contextLength: 200000 }, contextNeededTokens: 20000,
    }))
    expect(fits.excludedReason).toBeUndefined()
  })

  test('same model ranks differently for VISION vs REVIEW vs CHAT given purpose stats', () => {
    const s = stats({ success: 9, fail: { other: 1 }, validateOk: 19, validateTotal: 20, ocrGateOk: 1, ocrGateTotal: 10 })
    const vision = autoMode.scoreModelForTask(base({ purpose: 'VISION', stats: s }))
    const review = autoMode.scoreModelForTask(base({ purpose: 'REVIEW', stats: s }))
    const chat = autoMode.scoreModelForTask(base({ purpose: 'CHAT', stats: s }))
    expect(vision.score).toBeLessThan(review.score)
    expect(review.score).toBeGreaterThan(chat.score - 0.2)
    expect(new Set([vision.score, review.score, chat.score]).size).toBeGreaterThan(1)
  })

  test('verifier exclusion holds: generator provider/family never ranks for REVIEW', () => {
    const ranked = autoMode.rankModelsForTask([
      base({ provider: 'GROQ', model: 'gen', purpose: 'REVIEW', excludeProviders: ['GROQ'], stats: stats({ success: 100, validateOk: 10, validateTotal: 10 }) }),
      base({ provider: 'GEMINI', model: 'ver', purpose: 'REVIEW', excludeProviders: ['GROQ'], stats: stats({ success: 10 }) }),
    ])
    expect(ranked[0].provider).toBe('GEMINI')
    expect(ranked.find((m) => m.provider === 'GROQ')?.excludedReason).toBe('EXCLUDED_PROVIDER')
  })

  test('balance is always unknown — never invented', () => {
    expect(autoMode.scoreModelForTask(base({})).balance).toBe('unknown')
    expect(autoMode.buildAutoRankingPayload({ purpose: 'CHAT', ranked: [autoMode.scoreModelForTask(base({}))] }).balance).toBe('unknown')
  })
})

describe('sticky-as-hint under auto ON (plan risk 3, decided)', () => {
  const sticky = { provider: 'GROQ', model: 'llama-3.3-70b-versatile' }
  test('auto OFF: sticky goes first (today’s behaviour)', () => {
    expect(autoMode.stickyOrderUnderAuto({ autoMode: false, autoOverride: false, sticky })).toBe('sticky-first')
  })
  test('auto ON with ranking: sticky first only when it IS the top ranked candidate', () => {
    expect(autoMode.stickyOrderUnderAuto({
      autoMode: true, autoOverride: true,
      autoTop: { provider: 'GROQ', model: 'llama-3.3-70b-versatile' }, sticky,
    })).toBe('sticky-first')
    expect(autoMode.stickyOrderUnderAuto({
      autoMode: true, autoOverride: true,
      autoTop: { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }, sticky,
    })).toBe('ranked')
  })
  test('auto ON but ranking empty: sticky first (manual fallback)', () => {
    expect(autoMode.stickyOrderUnderAuto({ autoMode: true, autoOverride: false, sticky })).toBe('sticky-first')
  })
})

describe('ranking persistence + OCR budget', () => {
  test('persisted ranking keeps excluded entries with reasons; resolveAutoCandidates never re-admits them', () => {
    const ranked = autoMode.rankModelsForTask([
      base({ model: 'cooled', stats: stats({ success: 100 }), quotaState: { cooldownUntilMs: Date.now() + 600_000 } }),
      base({ model: 'plain', stats: stats({ success: 10 }) }),
    ])
    const payload = autoMode.buildAutoRankingPayload({ purpose: 'CHAT', ranked })
    const parsed = autoMode.parseAutoRanking(JSON.stringify(payload))
    expect(parsed.find((c) => c.model === 'cooled')?.excludedReason).toBe('QUOTA_COOLDOWN')
    const resolved = autoMode.resolveAutoCandidates({ autoMode: true, ranking: parsed })
    expect(resolved.autoCandidates.map((c) => c.model)).toEqual(['plain'])
    expect(resolved.excludedReasons.join(' ')).toContain('QUOTA_COOLDOWN')
  })

  test('stale ranking detection: older than the refresh interval is stale', () => {
    const fresh = autoMode.buildAutoRankingPayload({ purpose: 'CHAT', ranked: [], computedAtMs: Date.now() })
    const old = autoMode.buildAutoRankingPayload({ purpose: 'CHAT', ranked: [], computedAtMs: Date.now() - 61 * 60 * 1000 })
    expect(autoMode.isAutoRankingStale(fresh, 60)).toBe(false)
    expect(autoMode.isAutoRankingStale(old, 60)).toBe(true)
    expect(autoMode.isAutoRankingStale('not json', 60)).toBe(true)
  })

  test('OCR budget split leaves room for >= 2 attempts', () => {
    expect(autoMode.splitOcrBudget(120_000).perAttemptMs).toBe(60_000)
    expect(autoMode.splitOcrBudget(200_000).perAttemptMs).toBe(90_000)
    expect(autoMode.splitOcrBudget(120_000).perAttemptMs * 2).toBeLessThanOrEqual(120_000)
  })

  test('VISION latency preference: the fast model outranks an identical slow one for OCR', () => {
    const fast = autoMode.scoreModelForTask(base({ purpose: 'VISION', model: 'fast', stats: stats({ success: 10, avgMs: 1000 }) }))
    const slow = autoMode.scoreModelForTask(base({ purpose: 'VISION', model: 'slow', stats: stats({ success: 10, avgMs: 50000 }) }))
    expect(fast.score).toBeGreaterThan(slow.score)
    expect(fast.components.latency).toBeGreaterThan(slow.components.latency)
  })
})
