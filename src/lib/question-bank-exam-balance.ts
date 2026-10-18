import { validateCognitiveDistribution } from '@/lib/exam-cognitive-policy'

export type BankExamBalanceCandidate = {
  id?: string | null
  text?: string | null
  type?: string | null
  difficulty?: string | null
  cognitiveSkill?: string | null
}

export type BankExamBalanceWarning = {
  lowPercent: number
  highPercent: number
  details: string[]
}

function normalizeQuestionText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ة]/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizePlan(value: any, total: number, fallback: Record<string, number>) {
  const source = value && typeof value === 'object' ? value : fallback
  const raw = Object.entries(source).map(([key, v]) => ({ key: key.toUpperCase(), count: Math.max(0, Math.floor(Number(v || 0))) }))
  const sum = raw.reduce((s, x) => s + x.count, 0)
  if (sum <= 0) return Object.entries(fallback).map(([key, count]) => ({ key, count }))
  const scaled = raw.map((x) => ({ key: x.key, count: Math.floor((x.count / sum) * total) }))
  let diff = total - scaled.reduce((s, x) => s + x.count, 0)
  for (const item of scaled) {
    if (diff <= 0) break
    item.count++
    diff--
  }
  return scaled
}

function planOrdered<T extends BankExamBalanceCandidate>(rows: T[], difficultyPlan?: any, typePlan?: any) {
  const selected: T[] = []
  const seen = new Set<string>()
  const add = (q: T) => {
    const key = normalizeQuestionText(q.text || q.id).slice(0, 180)
    if (!key || seen.has(key)) return false
    seen.add(key)
    selected.push(q)
    return true
  }
  const typeTargets = typePlan ? normalizePlan(typePlan, rows.length, { MCQ: 50, TF: 20, SHORT: 20, ESSAY: 10 }) : []
  for (const t of typeTargets) {
    const candidates = rows.filter((q) => String(q.type || '').toUpperCase() === t.key)
    for (const q of candidates.slice(0, t.count)) add(q)
  }
  const diffTargets = normalizePlan(difficultyPlan, rows.length, { MEDIUM: 50, EASY: 25, ADVANCED: 25 })
  for (const t of diffTargets) {
    const candidates = rows.filter((q) => String(q.difficulty || 'MEDIUM').toUpperCase() === t.key)
    for (const q of candidates.slice(0, t.count)) add(q)
  }
  for (const q of rows) add(q)
  return selected
}

function normalizedSkill(value: unknown) {
  const raw = String(value || '').trim().toUpperCase()
  if (['ANALYZE', 'ANALYSIS', 'تحليل'].includes(raw)) return 'ANALYZE'
  if (['EVALUATE', 'EVALUATION', 'تقييم'].includes(raw)) return 'EVALUATE'
  if (['APPLY', 'APPLICATION', 'تطبيق'].includes(raw)) return 'APPLY'
  if (['REMEMBER', 'RECALL', 'KNOWLEDGE', 'MEMORIZE', 'حفظ'].includes(raw)) return 'REMEMBER'
  return 'UNDERSTAND'
}

export function balanceQuestionBankExamSelection<T extends BankExamBalanceCandidate>(
  rows: T[],
  count: number,
  opts: { lowMaxPercent?: number; highMinPercent?: number; difficultyPlan?: any; typePlan?: any } = {},
): { selected: T[]; cognitiveWarning: BankExamBalanceWarning | null } {
  const targetCount = Math.max(0, Math.floor(Number(count || 0)))
  const ordered = planOrdered(rows || [], opts.difficultyPlan, opts.typePlan)
  const selected: T[] = []
  const selectedKeys = new Set<string>()
  const keyOf = (q: T) => normalizeQuestionText(q.text || q.id).slice(0, 180)
  const add = (q: T, lowLimit?: number) => {
    if (selected.length >= targetCount) return false
    const key = keyOf(q)
    if (!key || selectedKeys.has(key)) return false
    if (typeof lowLimit === 'number' && selected.filter((x) => ['REMEMBER', 'UNDERSTAND'].includes(normalizedSkill(x.cognitiveSkill))).length >= lowLimit) return false
    selectedKeys.add(key)
    selected.push(q)
    return true
  }
  const high = ordered.filter((q) => ['ANALYZE', 'EVALUATE'].includes(normalizedSkill(q.cognitiveSkill)))
  const mid = ordered.filter((q) => normalizedSkill(q.cognitiveSkill) === 'APPLY')
  const low = ordered.filter((q) => ['REMEMBER', 'UNDERSTAND'].includes(normalizedSkill(q.cognitiveSkill)))
  const highTarget = Math.ceil(targetCount * (Number.isFinite(opts.highMinPercent) ? Number(opts.highMinPercent) : 20) / 100)
  const lowLimit = Math.floor(targetCount * (Number.isFinite(opts.lowMaxPercent) ? Number(opts.lowMaxPercent) : 50) / 100)

  for (const q of high) {
    if (selected.filter((x) => ['ANALYZE', 'EVALUATE'].includes(normalizedSkill(x.cognitiveSkill))).length >= highTarget) break
    add(q)
  }
  for (const q of mid) add(q)
  for (const q of low) add(q, lowLimit)
  for (const q of high) add(q)
  for (const q of mid) add(q)
  for (const q of low) add(q)

  const final = selected.slice(0, targetCount)
  const validation = validateCognitiveDistribution(final, 'PROGRAM', { lowMaxPercent: opts.lowMaxPercent, programHighMinPercent: opts.highMinPercent })
  return {
    selected: final,
    cognitiveWarning: validation.ok ? null : { lowPercent: validation.lowPercent, highPercent: validation.highPercent, details: validation.details },
  }
}
