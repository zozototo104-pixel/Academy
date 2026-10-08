import { geminiCompleteJson } from '@/lib/gemini'
import { normalizeArabic } from '@/lib/arabic-normalize'
import { textContainsEvidenceAfterNormalization } from '@/lib/text-provenance'

export const BOOK_KNOWLEDGE_CATEGORIES = ['CONCEPT', 'DEFINITION', 'THEORY', 'METHOD', 'CASE', 'PRINCIPLE', 'FACT'] as const
export type BookKnowledgeCandidate = { category: typeof BOOK_KNOWLEDGE_CATEGORIES[number]; title: string; summary: string; excerpt: string; importance: number }

const stopWords = new Set(['في', 'من', 'على', 'عن', 'الى', 'إلى', 'هذا', 'هذه', 'هو', 'هي', 'ان', 'أن', 'و', 'او', 'أو', 'مع', 'التي', 'الذي'])
export function conceptTokens(value: string): Set<string> {
  return new Set(String(normalizeArabic(value)).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((word) => word.length > 1 && !stopWords.has(word)))
}
export function isRepeatedBookConcept(candidate: Pick<BookKnowledgeCandidate, 'title' | 'summary'>, prior: readonly Pick<BookKnowledgeCandidate, 'title' | 'summary'>[]): boolean {
  const a = conceptTokens(`${candidate.title} ${candidate.summary}`)
  if (!a.size) return false
  return prior.some((item) => {
    const b = conceptTokens(`${item.title} ${item.summary}`)
    let intersection = 0
    for (const word of a) if (b.has(word)) intersection++
    return b.size > 0 && intersection / (a.size + b.size - intersection) >= 0.6
  })
}
export function validateBookKnowledgeCandidate(raw: unknown, chunkText: string): BookKnowledgeCandidate | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const category = String(item.category || '')
  const title = String(item.title || '').trim()
  const summary = String(item.summary || '').trim()
  const excerpt = String(item.excerpt || '').trim()
  const importance = Number(item.importance)
  if (!BOOK_KNOWLEDGE_CATEGORIES.includes(category as BookKnowledgeCandidate['category'])) return null
  if (!title || !summary || excerpt.length < 60 || excerpt.length > 600) return null
  if (/[؟?]\s*$/.test(excerpt) || /^(?:ما|ماذا|كيف|لماذا|هل|أين|متى)\s/.test(excerpt)) return null
  if (!textContainsEvidenceAfterNormalization(chunkText, excerpt)) return null
  if (!Number.isFinite(importance) || importance < 0 || importance > 100) return null
  return { category: category as BookKnowledgeCandidate['category'], title, summary, excerpt, importance: Math.round(importance) }
}

export async function analyzeBookChunk(input: { bookId: string; chunkText: string; deadlineMs: number; prior: readonly Pick<BookKnowledgeCandidate, 'title' | 'summary'>[] }): Promise<BookKnowledgeCandidate[]> {
  const result = await geminiCompleteJson({
    system: 'أنت محلل كتب أكاديمية. استخرج المعرفة من النص الحرفي فقط. أرجع JSON فقط.',
    history: [{ role: 'user', text: `استخرج من 3 إلى 12 عنصراً بحسب كثافة النص، لا تخترع معلومات، ولا تنشئ QUESTION_SEED. الأصناف المسموحة: CONCEPT, DEFINITION, THEORY, METHOD, CASE, PRINCIPLE, FACT. لكل عنصر: category,title,summary (صياغة أكاديمية عربية),excerpt (اقتباس حرفي من النص بين 60 و600 حرف),importance (0-100). أرجع {"items":[...]}. النص:\n${input.chunkText}` }],
    taskLevel: 'ACADEMIC_DRAFT',
    stickyScope: `BOOK_READ:${input.bookId}`,
    deadlineMs: input.deadlineMs,
    temperature: 0.2,
    validate: (raw) => {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed?.items)) throw new Error('INVALID_BOOK_KNOWLEDGE_ENVELOPE')
    },
  })
  const parsed = JSON.parse(result)
  const accepted: BookKnowledgeCandidate[] = []
  for (const raw of parsed.items || []) {
    const candidate = validateBookKnowledgeCandidate(raw, input.chunkText)
    if (!candidate || isRepeatedBookConcept(candidate, [...input.prior, ...accepted])) continue
    accepted.push(candidate)
    if (accepted.length === 12) break
  }
  return accepted
}
