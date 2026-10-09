export function scoreDefenseBreakdown(scores: Array<{ criterion: string; score0to10: number | null }>) {
  const weights: Record<string, number> = { methodology: 25, results: 25, contribution: 20, literature: 15, presentation: 15 }
  const normalized = scores
    .map((item) => ({ criterion: item.criterion, score0to10: item.score0to10 == null ? null : Number(item.score0to10) }))
    .filter((item): item is { criterion: string; score0to10: number } => Object.prototype.hasOwnProperty.call(weights, item.criterion) && item.score0to10 != null && Number.isFinite(item.score0to10))
  const totalWeight = normalized.reduce((sum, item) => sum + weights[item.criterion], 0)
  if (!totalWeight) return { score: null, breakdown: [] }
  const weighted = normalized.reduce((sum, item) => sum + Math.max(0, Math.min(10, item.score0to10)) * weights[item.criterion], 0)
  return { score: Math.round((weighted / totalWeight) * 10), breakdown: normalized.map((item) => ({ ...item, weight: weights[item.criterion] })) }
}
