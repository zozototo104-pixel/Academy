export const AI_AUTO_SETTING = 'AI_AUTO_MANAGEMENT_ENABLED'
export const AI_AUTO_MAX_AGE_MS = 6 * 60 * 60 * 1000

export type AutoObservation = {
  success: number
  fail: Record<string, number>
  avgMs: number
  jsonOk: number
  jsonTotal: number
  evidenceOk: number
  evidenceTotal: number
}

export function automaticManagementEnabled(value: unknown): boolean {
  return value === true || value === 'true' || value === '1'
}

export function automaticModelScore(stats: AutoObservation | null): number {
  if (!stats) return 50
  const failures = Object.values(stats.fail).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0)
  const samples = stats.success + failures
  const reliability = (stats.success + 2) / (samples + 4)
  const json = stats.jsonTotal ? stats.jsonOk / stats.jsonTotal : reliability
  const evidence = stats.evidenceTotal ? stats.evidenceOk / stats.evidenceTotal : reliability
  const latency = stats.avgMs > 0 ? Math.min(1, 5000 / stats.avgMs) : 0.5
  return Math.round((reliability * 0.55 + json * 0.2 + evidence * 0.15 + latency * 0.1) * 1000) / 10
}

export function automaticSelectionReason(stats: AutoObservation | null): string {
  if (!stats) return 'مرشح للاستكشاف؛ لا توجد قياسات فعلية لهذه المهمة بعد'
  const failures = Object.values(stats.fail).reduce((sum, count) => sum + Math.max(0, Number(count) || 0), 0)
  return `${stats.success} نجاح و${failures} فشل؛ متوسط الزمن ${Math.round(stats.avgMs)} مللي ثانية؛ جودة JSON ${stats.jsonOk}/${stats.jsonTotal}؛ الأدلة ${stats.evidenceOk}/${stats.evidenceTotal}`
}
