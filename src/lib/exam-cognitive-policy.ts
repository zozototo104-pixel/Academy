export type CognitiveScope = 'UNIT' | 'PROGRAM'

export type CognitiveQuestion = {
  cognitiveSkill?: string | null
  status?: string | null
}

export type CognitiveDistributionResult = {
  ok: boolean
  total: number
  lowPercent: number
  highPercent: number
  details: string[]
}

function normalizeSkill(value: unknown) {
  const raw = String(value || '').trim().toUpperCase()
  if (['REMEMBER', 'RECALL', 'KNOWLEDGE', 'MEMORIZE', 'حفظ'].includes(raw)) return 'REMEMBER'
  if (['UNDERSTAND', 'COMPREHEND', 'COMPREHENSION', 'فهم'].includes(raw)) return 'UNDERSTAND'
  if (['APPLY', 'APPLICATION', 'تطبيق'].includes(raw)) return 'APPLY'
  if (['ANALYZE', 'ANALYSIS', 'تحليل'].includes(raw)) return 'ANALYZE'
  if (['EVALUATE', 'EVALUATION', 'تقييم'].includes(raw)) return 'EVALUATE'
  return raw || 'UNDERSTAND'
}

export function validateCognitiveDistribution(
  questions: CognitiveQuestion[],
  scope: CognitiveScope,
  opts: { lowMaxPercent?: number; programHighMinPercent?: number } = {}
): CognitiveDistributionResult {
  const candidates = (questions || []).filter((q) => q.status !== 'REJECTED')
  const total = candidates.length
  if (total <= 0) return { ok: false, total: 0, lowPercent: 0, highPercent: 0, details: ['لا توجد أسئلة قابلة للنشر لفحص توزيع المهارات المعرفية.'] }

  const lowMax = Number.isFinite(opts.lowMaxPercent) ? Number(opts.lowMaxPercent) : 50
  const highMin = Number.isFinite(opts.programHighMinPercent) ? Number(opts.programHighMinPercent) : 20
  const low = candidates.filter((q) => ['REMEMBER', 'UNDERSTAND'].includes(normalizeSkill(q.cognitiveSkill))).length
  const high = candidates.filter((q) => ['ANALYZE', 'EVALUATE'].includes(normalizeSkill(q.cognitiveSkill))).length
  const lowPercent = Math.round((low / total) * 1000) / 10
  const highPercent = Math.round((high / total) * 1000) / 10
  const details: string[] = []

  if (lowPercent > lowMax) details.push(`نسبة أسئلة الحفظ/الفهم ${lowPercent}% وتتجاوز الحد الأعلى ${lowMax}%. خفّض أسئلة التذكر والفهم وأضف أسئلة تطبيق/تحليل.`)
  if (scope === 'PROGRAM' && highPercent < highMin) details.push(`نسبة أسئلة التحليل/التقييم ${highPercent}% وهي أقل من الحد الأدنى ${highMin}%. أضف أسئلة تحليل وتقييم قبل نشر الامتحان الشامل.`)

  return { ok: details.length === 0, total, lowPercent, highPercent, details }
}

export function cognitivePolicyArabicMessage(result: CognitiveDistributionResult) {
  if (result.ok) return 'توزيع المهارات المعرفية مناسب للنشر.'
  return `توزيع المستويات المعرفية غير مناسب للنشر: ${result.details.join(' ')}`
}
