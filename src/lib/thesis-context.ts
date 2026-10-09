import { db } from '@/lib/db'

function normalizeArabic(value: string) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[إأآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
}

function words(value: string) {
  return normalizeArabic(value).split(/[^\u0621-\u064A\w]+/u).filter((word) => word.length >= 2)
}

export async function getThesisDigest(thesisId: string) {
  const thesis = await db.thesisSubmission.findUnique({ where: { id: thesisId }, select: { digest: true } })
  return thesis?.digest || null
}

export async function findRelevantThesisChunks(thesisId: string, query: string, limit = 3) {
  const queryWords = words(query)
  const chunks = await db.thesisChunk.findMany({
    where: { thesisId, status: { in: ['EXTRACTED', 'ANALYZED'] } },
    orderBy: { index: 'asc' },
    select: { id: true, index: true, pageStart: true, pageEnd: true, text: true, summary: true },
  })
  if (!queryWords.length) return chunks.slice(0, limit)
  return chunks
    .map((chunk) => {
      const haystack = normalizeArabic(`${chunk.summary || ''} ${chunk.text}`)
      const score = queryWords.reduce((sum, word) => sum + (haystack.includes(word) ? 1 : 0), 0)
      return { chunk, score }
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.index - b.chunk.index)
    .slice(0, Math.max(1, limit))
    .map((item) => item.chunk)
}

export function summarizeDigestForPrompt(digest: unknown, max = 6000) {
  return JSON.stringify(digest || {}, null, 2).slice(0, max)
}

export function scoreDefenseBreakdown(scores: Array<{ criterion: string; score0to10: number | null }>) {
  const weights: Record<string, number> = { methodology: 25, results: 25, contribution: 20, literature: 15, presentation: 15 }
  const normalized = scores
    .map((item) => ({ criterion: item.criterion, score0to10: Number(item.score0to10) }))
    .filter((item) => Object.prototype.hasOwnProperty.call(weights, item.criterion) && Number.isFinite(item.score0to10))
  const totalWeight = normalized.reduce((sum, item) => sum + weights[item.criterion], 0)
  if (!totalWeight) return { score: null, breakdown: [] }
  const weighted = normalized.reduce((sum, item) => sum + Math.max(0, Math.min(10, item.score0to10)) * weights[item.criterion], 0)
  return { score: Math.round((weighted / totalWeight) * 10), breakdown: normalized.map((item) => ({ ...item, weight: weights[item.criterion] })) }
}
