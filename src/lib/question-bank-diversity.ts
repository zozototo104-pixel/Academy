import { normalizeArabic } from './arabic-normalize'

const STOP_WORDS = new Set(['من', 'في', 'على', 'عن', 'الى', 'إلى', 'ما', 'ماذا', 'كيف', 'هل', 'هو', 'هي', 'هذا', 'هذه', 'ذلك', 'تلك', 'التي', 'الذي', 'و', 'او', 'أو', 'مع', 'بين', 'أن', 'ان', 'لم', 'لا', 'ثم', 'اذكر', 'اشرح', 'وضح', 'بين', 'حدد', 'السؤال'])

export function questionIdeaTokens(text: unknown): Set<string> {
  return new Set(String(normalizeArabic(text)).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((word) => word.length > 1 && !STOP_WORDS.has(word)))
}

export function isDuplicateQuestionIdea(text: unknown, sourceId: string, existing: readonly { text: string; knowledgeItemId?: string | null }[], threshold = 0.6): boolean {
  const tokens = questionIdeaTokens(text)
  if (!tokens.size) return false
  return existing.some((item) => {
    if (item.knowledgeItemId !== sourceId) return false
    const other = questionIdeaTokens(item.text)
    if (!other.size) return false
    let intersection = 0
    for (const token of tokens) if (other.has(token)) intersection++
    return intersection / (tokens.size + other.size - intersection) >= threshold
  })
}

export function selectQuestionKnowledgeSources<T extends { id: string }>(items: readonly T[], usage: ReadonlyMap<string, number>, limit = 8): T[] {
  const sorted = [...items].sort((a, b) => (usage.get(a.id) || 0) - (usage.get(b.id) || 0))
  const underCap = sorted.filter((item) => (usage.get(item.id) || 0) < 2)
  return (underCap.length ? underCap : sorted).slice(0, limit)
}
