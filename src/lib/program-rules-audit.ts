export function pickChangedFields(before: Record<string, any>, after: Record<string, any>) {
  const changes: Record<string, { old: any; next: any }> = {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const oldValue = before[key]
    const nextValue = after[key]
    if (JSON.stringify(oldValue ?? null) !== JSON.stringify(nextValue ?? null)) {
      changes[key] = { old: oldValue ?? null, next: nextValue ?? null }
    }
  }
  return changes
}

export function compactChangeSummary(changes: Record<string, { old: any; next: any }>, max = 1800) {
  const keys = Object.keys(changes)
  if (!keys.length) return 'لا توجد تغييرات فعلية'
  const summary = keys.map((key) => `${key}: ${JSON.stringify(changes[key].old)} → ${JSON.stringify(changes[key].next)}`).join('؛ ')
  return summary.length > max ? `${summary.slice(0, max)}…` : summary
}
