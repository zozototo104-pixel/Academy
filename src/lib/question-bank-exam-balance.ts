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

function normalizedSkill(value: unknown) {
  const raw = String(value || '').trim().toUpperCase()
  if (['ANALYZE', 'ANALYSIS', 'تحليل'].includes(raw)) return 'ANALYZE'
  if (['EVALUATE', 'EVALUATION', 'تقييم'].includes(raw)) return 'EVALUATE'
  if (['APPLY', 'APPLICATION', 'تطبيق'].includes(raw)) return 'APPLY'
  if (['REMEMBER', 'RECALL', 'KNOWLEDGE', 'MEMORIZE', 'حفظ'].includes(raw)) return 'REMEMBER'
  return 'UNDERSTAND'
}

function isHighSkill(value: unknown) {
  return ['ANALYZE', 'EVALUATE'].includes(normalizedSkill(value))
}

function isMidSkill(value: unknown) {
  return normalizedSkill(value) === 'APPLY'
}

function isLowSkill(value: unknown) {
  return ['REMEMBER', 'UNDERSTAND'].includes(normalizedSkill(value))
}

function byDifficultyPlan<T extends BankExamBalanceCandidate>(rows: T[], difficultyPlan?: any) {
  const selected: T[] = []
  const seen = new Set<string>()
  const add = (q: T) => {
    const key = normalizeQuestionText(q.text || q.id).slice(0, 180)
    if (!key || seen.has(key)) return
    seen.add(key)
    selected.push(q)
  }
  const diffTargets = normalizePlan(difficultyPlan, rows.length, { MEDIUM: 50, EASY: 25, ADVANCED: 25 })
  for (const t of diffTargets) for (const q of rows.filter((item) => String(item.difficulty || 'MEDIUM').toUpperCase() === t.key).slice(0, t.count)) add(q)
  for (const q of rows) add(q)
  return selected
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
  for (const t of typeTargets) for (const q of rows.filter((item) => String(item.type || '').toUpperCase() === t.key).slice(0, t.count)) add(q)
  const diffTargets = normalizePlan(difficultyPlan, rows.length, { MEDIUM: 50, EASY: 25, ADVANCED: 25 })
  for (const t of diffTargets) for (const q of rows.filter((item) => String(item.difficulty || 'MEDIUM').toUpperCase() === t.key).slice(0, t.count)) add(q)
  for (const q of rows) add(q)
  return selected
}

function bySkillPriority<T extends BankExamBalanceCandidate>(rows: T[], difficultyPlan?: any) {
  return [
    ...byDifficultyPlan(rows.filter((q) => isHighSkill(q.cognitiveSkill)), difficultyPlan),
    ...byDifficultyPlan(rows.filter((q) => isMidSkill(q.cognitiveSkill)), difficultyPlan),
    ...byDifficultyPlan(rows.filter((q) => isLowSkill(q.cognitiveSkill)), difficultyPlan),
  ]
}

export function balanceQuestionBankExamSelection<T extends BankExamBalanceCandidate>(
  rows: T[],
  count: number,
  opts: { lowMaxPercent?: number; highMinPercent?: number; difficultyPlan?: any; typePlan?: any } = {},
): { selected: T[]; cognitiveWarning: BankExamBalanceWarning | null } {
  const targetCount = Math.max(0, Math.floor(Number(count || 0)))
  const selected: T[] = []
  const selectedKeys = new Set<string>()
  const keyOf = (q: T) => normalizeQuestionText(q.text || q.id).slice(0, 180)
  const highPercent = typeof opts.highMinPercent === 'number' && Number.isFinite(opts.highMinPercent) ? opts.highMinPercent : 20
  const lowPercent = typeof opts.lowMaxPercent === 'number' && Number.isFinite(opts.lowMaxPercent) ? opts.lowMaxPercent : 50
  const highTarget = Math.ceil(targetCount * highPercent / 100)
  const lowLimit = Math.floor(targetCount * lowPercent / 100)
  const lowCount = () => selected.filter((x) => isLowSkill(x.cognitiveSkill)).length
  const highCount = () => selected.filter((x) => isHighSkill(x.cognitiveSkill)).length
  const add = (q: T, enforceLowLimit = false) => {
    if (selected.length >= targetCount) return false
    const key = keyOf(q)
    if (!key || selectedKeys.has(key)) return false
    if (enforceLowLimit && isLowSkill(q.cognitiveSkill) && lowCount() >= lowLimit) return false
    selectedKeys.add(key)
    selected.push(q)
    return true
  }
  const addFrom = (candidates: T[], target?: number) => {
    for (const q of candidates) {
      if (typeof target === 'number' && selected.length >= target) break
      add(q, true)
    }
  }

  if (opts.typePlan) {
    let desiredTotal = 0
    const typeTargets = normalizePlan(opts.typePlan, targetCount, { MCQ: 50, TF: 20, SHORT: 20, ESSAY: 10 })
    for (const t of typeTargets) {
      desiredTotal += t.count
      addFrom(bySkillPriority((rows || []).filter((q) => String(q.type || '').toUpperCase() === t.key), opts.difficultyPlan), Math.min(targetCount, desiredTotal))
    }
    addFrom(bySkillPriority(rows || [], opts.difficultyPlan))
    if (selected.length < targetCount) for (const q of bySkillPriority(rows || [], opts.difficultyPlan)) add(q)
    for (const t of typeTargets.map((x) => x.key)) {
      while (highCount() < highTarget) {
        const lowIndex = selected.findIndex((q) => String(q.type || '').toUpperCase() === t && isLowSkill(q.cognitiveSkill))
        if (lowIndex < 0) break
        const replacement = bySkillPriority((rows || []).filter((q) => String(q.type || '').toUpperCase() === t), opts.difficultyPlan).find((q) => isHighSkill(q.cognitiveSkill) && !selectedKeys.has(keyOf(q)))
        if (!replacement) break
        selectedKeys.delete(keyOf(selected[lowIndex]))
        selected[lowIndex] = replacement
        selectedKeys.add(keyOf(replacement))
      }
    }
  } else {
    const ordered = planOrdered(rows || [], opts.difficultyPlan, opts.typePlan)
    const high = ordered.filter((q) => isHighSkill(q.cognitiveSkill))
    const mid = ordered.filter((q) => isMidSkill(q.cognitiveSkill))
    const low = ordered.filter((q) => isLowSkill(q.cognitiveSkill))
    for (const q of high) {
      if (highCount() >= highTarget) break
      add(q)
    }
    for (const q of mid) add(q)
    for (const q of low) add(q, true)
    for (const q of high) add(q)
    for (const q of mid) add(q)
    for (const q of low) add(q)
  }

  const final = selected.slice(0, targetCount)
  const validation = validateCognitiveDistribution(final, 'PROGRAM', { lowMaxPercent: opts.lowMaxPercent, programHighMinPercent: opts.highMinPercent })
  return {
    selected: final,
    cognitiveWarning: validation.ok ? null : { lowPercent: validation.lowPercent, highPercent: validation.highPercent, details: validation.details },
  }
}
