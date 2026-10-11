type DefenseScoreInput = { criterion: string; score0to10: number | null }

export function scoreDefenseBreakdown(
  scores: DefenseScoreInput[],
  opts: { requireAllCriteria?: boolean } = {},
) {
  const weights: Record<string, number> = { methodology: 25, results: 25, contribution: 20, literature: 15, presentation: 15 }
  const normalizeScore = (score: number | null) => {
    if (score == null) return null
    const numeric = Number(score)
    return Number.isFinite(numeric) ? Math.max(0, Math.min(10, numeric)) : null
  }
  const keyed = scores
    .filter((item) => Object.prototype.hasOwnProperty.call(weights, item.criterion))
    .map((item) => ({ criterion: item.criterion, score0to10: normalizeScore(item.score0to10), weight: weights[item.criterion] }))
  const missingCriteria = keyed.filter((item) => item.score0to10 == null).map((item) => item.criterion)
  if (opts.requireAllCriteria && missingCriteria.length) {
    return {
      score: null,
      needsReview: true,
      reviewReason: 'DEFENSE_FULL_SESSION_HAS_UNGRADED_CRITERIA',
      missingCriteria,
      breakdown: keyed,
    }
  }
  const normalized = keyed.filter((item): item is { criterion: string; score0to10: number; weight: number } => item.score0to10 != null)
  const totalWeight = normalized.reduce((sum, item) => sum + item.weight, 0)
  if (!totalWeight) return { score: null, needsReview: Boolean(opts.requireAllCriteria), missingCriteria, breakdown: opts.requireAllCriteria ? keyed : normalized }
  const weighted = normalized.reduce((sum, item) => sum + item.score0to10 * item.weight, 0)
  return {
    score: Math.round((weighted / totalWeight) * 10),
    needsReview: false,
    missingCriteria,
    breakdown: opts.requireAllCriteria ? keyed : normalized,
  }
}
