import { geminiCompleteJson } from '@/lib/gemini'
import { db } from '@/lib/db'
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

export type AnalyzeStepStore = {
  getJob: (id: string) => Promise<{ id: string; bookId: string; programId: string; phase: string; status: string } | null>
  nextChunk: (bookId: string) => Promise<{ id: string; bookId: string; programId: string; index: number; text: string; pageStart: number; pageEnd: number; textProvenance: string; attempts: number } | null>
  priorItems: (bookId: string) => Promise<Pick<BookKnowledgeCandidate, 'title' | 'summary'>[]>
  saveAnalyzed: (chunk: { id: string; bookId: string; programId: string; pageStart: number; pageEnd: number; textProvenance: string }, items: BookKnowledgeCandidate[], jobId: string) => Promise<void>
  saveFailure: (chunkId: string, jobId: string, error: string, exhausted: boolean) => Promise<void>
  complete: (bookId: string, jobId: string) => Promise<void>
}

export async function analyzeStepWithStore(
  jobId: string,
  deadlineMs: number,
  store: AnalyzeStepStore,
  analyze: typeof analyzeBookChunk = analyzeBookChunk,
): Promise<{ analyzed: number; failed: number; completed: boolean; paused: boolean }> {
  const job = await store.getJob(jobId)
  if (!job) throw new Error('BOOK_READ_JOB_NOT_FOUND')
  if (job.phase !== 'ANALYZE') return { analyzed: 0, failed: 0, completed: job.phase === 'DONE', paused: false }
  let analyzed = 0, failed = 0
  const attempted = new Set<string>()
  while (Date.now() < deadlineMs - 1500) {
    const chunk = await store.nextChunk(job.bookId)
    if (!chunk) {
      await store.complete(job.bookId, jobId)
      return { analyzed, failed, completed: true, paused: false }
    }
    if (attempted.has(chunk.id)) return { analyzed, failed, completed: false, paused: false }
    attempted.add(chunk.id)
    try {
      const prior = await store.priorItems(job.bookId)
      const candidates = await analyze({ bookId: job.bookId, chunkText: chunk.text, deadlineMs, prior })
      // Revalidate at the persistence boundary, including injected analyzers in tests.
      const items = candidates.map((item) => validateBookKnowledgeCandidate(item, chunk.text))
        .filter((item): item is BookKnowledgeCandidate => item !== null)
        .filter((item, index, all) => !isRepeatedBookConcept(item, [...prior, ...all.slice(0, index)]))
      await store.saveAnalyzed(chunk, items, jobId)
      analyzed++
    } catch (error: any) {
      const message = String(error?.message || error)
      if (message.includes('AI_ACADEMIC_PROVIDER_UNAVAILABLE')) throw error
      const exhausted = chunk.attempts + 1 >= 3
      await store.saveFailure(chunk.id, jobId, message.slice(0, 2000), exhausted)
      if (exhausted) failed++
    }
  }
  return { analyzed, failed, completed: false, paused: false }
}

/** Requires the read-step lock to have been claimed before invocation. */
export async function runAnalyzeStep(jobId: string, deadlineMs: number) {
  const store: AnalyzeStepStore = {
    getJob: (id) => db.bookReadJob.findUnique({ where: { id }, select: { id: true, bookId: true, programId: true, phase: true, status: true } }),
    nextChunk: (bookId) => db.bookChunk.findFirst({ where: { bookId, status: 'EXTRACTED' }, orderBy: { index: 'asc' }, select: { id: true, bookId: true, programId: true, index: true, text: true, pageStart: true, pageEnd: true, textProvenance: true, attempts: true } }),
    priorItems: (bookId) => db.bookKnowledgeItem.findMany({ where: { bookId, kbVersion: 2 }, select: { title: true, summary: true } }),
    saveAnalyzed: async (chunk, items, id) => {
      await db.$transaction(async (tx) => {
        // A retry after a partial failure must never duplicate knowledge rows.
        const current = await tx.bookChunk.findUnique({ where: { id: chunk.id }, select: { status: true } })
        if (current?.status !== 'EXTRACTED') return
        await tx.bookKnowledgeItem.deleteMany({ where: { chunkId: chunk.id, kbVersion: 2 } })
        for (const item of items) {
          await tx.bookKnowledgeItem.create({ data: {
            bookId: chunk.bookId, programId: chunk.programId, chunkId: chunk.id,
            pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, textProvenance: chunk.textProvenance,
            kbVersion: 2, category: item.category, title: item.title, summary: item.summary,
            excerpt: item.excerpt, importance: item.importance,
          } })
        }
        await tx.bookChunk.update({ where: { id: chunk.id }, data: { status: 'ANALYZED', lastError: null } })
        await tx.bookReadJob.update({ where: { id }, data: { chunksAnalyzed: { increment: 1 } } })
      })
    },
    saveFailure: async (chunkId, id, error, exhausted) => {
      await db.$transaction(async (tx) => {
        await tx.bookChunk.update({ where: { id: chunkId }, data: { attempts: { increment: 1 }, lastError: error, ...(exhausted ? { status: 'FAILED' } : {}) } })
        if (exhausted) await tx.bookReadJob.update({ where: { id }, data: { chunksFailed: { increment: 1 } } })
      })
    },
    complete: async (bookId, id) => {
      await db.$transaction(async (tx) => {
        const remaining = await tx.bookChunk.count({ where: { bookId, status: { in: ['EXTRACTED', 'PENDING'] } } })
        if (remaining) return
        // Preserve historical rows and their category; mark them via sourceNote.
        const old = await tx.bookKnowledgeItem.findMany({ where: { bookId, kbVersion: 1 }, select: { id: true, sourceNote: true } })
        for (const item of old) {
          if (item.sourceNote?.includes('[LEGACY]')) continue
          await tx.bookKnowledgeItem.update({ where: { id: item.id }, data: { sourceNote: `[LEGACY] ${item.sourceNote || ''}`.trim() } })
        }
        await tx.bookReadJob.update({ where: { id }, data: { phase: 'DONE', status: 'COMPLETED', finishedAt: new Date(), lockedUntil: null, retryAt: null } })
      })
    },
  }
  return analyzeStepWithStore(jobId, deadlineMs, store)
}
