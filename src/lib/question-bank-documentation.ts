import type { QuestionBankItem } from '@prisma/client'
import { db } from '@/lib/db'
import { sourceLocatorFromKnowledge } from '@/lib/program-exam-assembly'
import { textAiCompleteJson } from '@/lib/text-ai'

const SKILLS = new Set(['UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE'])
const DIFFICULTIES = new Set(['EASY', 'MEDIUM', 'ADVANCED'])

function isMissing(value: string | null | undefined) {
  const text = String(value || '').trim()
  return !text || text === '[]'
}

function safeJsonArray(value: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function parseAiRows(raw: string): Array<{ id: string; difficulty?: string; cognitiveSkill?: string; correctRationale?: string; distractorRationales?: string[] }> {
  try {
    const parsed: unknown = JSON.parse(raw)
    const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { items?: unknown[] })?.items) ? (parsed as { items: unknown[] }).items : []
    return rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return []
      const item = row as Record<string, unknown>
      const id = String(item.id || '').trim()
      if (!id) return []
      const difficulty = String(item.difficulty || '').toUpperCase()
      const cognitiveSkill = String(item.cognitiveSkill || '').toUpperCase()
      return [{
        id,
        difficulty: DIFFICULTIES.has(difficulty) ? difficulty : undefined,
        cognitiveSkill: SKILLS.has(cognitiveSkill) ? cognitiveSkill : undefined,
        correctRationale: String(item.correctRationale || '').trim().slice(0, 1000) || undefined,
        distractorRationales: Array.isArray(item.distractorRationales) ? item.distractorRationales.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 6) : undefined,
      }]
    })
  } catch {
    return []
  }
}

function needsAiDocumentation(item: Pick<QuestionBankItem, 'type' | 'cognitiveSkill' | 'difficulty' | 'correctRationale' | 'distractorRationales'>) {
  return isMissing(item.cognitiveSkill) || !SKILLS.has(String(item.cognitiveSkill || '')) ||
    isMissing(item.difficulty) || !DIFFICULTIES.has(String(item.difficulty || '')) ||
    isMissing(item.correctRationale) ||
    ((item.type === 'MCQ' || item.type === 'TF') && safeJsonArray(item.distractorRationales).length === 0)
}

function documentationPatch(item: QuestionBankItem, row: ReturnType<typeof parseAiRows>[number]) {
  const data: Record<string, any> = {}
  if ((isMissing(item.difficulty) || !DIFFICULTIES.has(String(item.difficulty || ''))) && row.difficulty) data.difficulty = row.difficulty
  if ((isMissing(item.cognitiveSkill) || !SKILLS.has(String(item.cognitiveSkill || ''))) && row.cognitiveSkill) data.cognitiveSkill = row.cognitiveSkill
  if (isMissing(item.correctRationale) && row.correctRationale) data.correctRationale = row.correctRationale
  if ((item.type === 'MCQ' || item.type === 'TF') && safeJsonArray(item.distractorRationales).length === 0 && row.distractorRationales?.length) data.distractorRationales = JSON.stringify(row.distractorRationales).slice(0, 1800)
  return data
}

export async function countQuestionBankDocumentationRemaining(programId: string) {
  const items = await db.questionBankItem.findMany({
    where: { programId, status: { not: 'REJECTED' } },
    select: { type: true, sourceEvidence: true, sourceBookTitle: true, sourceLocator: true, cognitiveSkill: true, difficulty: true, correctRationale: true, distractorRationales: true },
  })
  return items.filter((item) =>
    isMissing(item.sourceEvidence) || isMissing(item.sourceBookTitle) || isMissing(item.sourceLocator) || needsAiDocumentation(item as any),
  ).length
}

export async function syncQuestionBankDocumentationFromKnowledge(programId: string) {
  const items = await db.questionBankItem.findMany({
    where: { programId, status: { not: 'REJECTED' } },
    select: { id: true, knowledgeItemId: true, sourceBookTitle: true, sourceLocator: true, sourceEvidence: true },
  })
  const knowledgeIds = [...new Set(items.map((item) => item.knowledgeItemId).filter((id): id is string => Boolean(id)))]
  if (!knowledgeIds.length) return 0
  const knowledge = await db.bookKnowledgeItem.findMany({ where: { id: { in: knowledgeIds } }, select: { id: true, bookId: true, title: true, excerpt: true, pageStart: true, pageEnd: true } })
  const knowledgeById = new Map(knowledge.map((item) => [item.id, item]))
  const books = await db.book.findMany({ where: { id: { in: [...new Set(knowledge.map((item) => item.bookId).filter((id): id is string => Boolean(id)))] } }, select: { id: true, title: true } })
  const bookTitles = new Map(books.map((book) => [book.id, book.title]))
  let filled = 0
  for (const item of items) {
    const knowledgeItem = item.knowledgeItemId ? knowledgeById.get(item.knowledgeItemId) : null
    if (!knowledgeItem) continue
    const data: Record<string, any> = {}
    if (isMissing(item.sourceBookTitle)) {
      const title = bookTitles.get(knowledgeItem.bookId || '') || ''
      if (title) data.sourceBookTitle = title
    }
    if (isMissing(item.sourceLocator)) {
      const locator = sourceLocatorFromKnowledge(knowledgeItem, null)
      if (locator) data.sourceLocator = locator
    }
    if (isMissing(item.sourceEvidence) && knowledgeItem.excerpt) data.sourceEvidence = knowledgeItem.excerpt
    if (Object.keys(data).length) {
      filled += Object.keys(data).length
      await db.questionBankItem.update({ where: { id: item.id }, data })
    }
  }
  return filled
}

export async function backfillQuestionBankAcademicFields(programId: string, timeBudgetMs = 45_000) {
  const lockKey = `QUESTION_BANK_DOC_LOCK:${programId}`
  const activeLock = await db.setting.findUnique({ where: { key: lockKey }, select: { value: true } })
  const activeUntil = Date.parse(activeLock?.value || '')
  if (Number.isFinite(activeUntil) && activeUntil > Date.now()) {
    const remaining = await countQuestionBankDocumentationRemaining(programId)
    return { filled: 0, remaining, locked: true, done: remaining === 0 }
  }
  const lockUntil = new Date(Date.now() + 4 * 60_000).toISOString()
  await db.setting.upsert({ where: { key: lockKey }, create: { key: lockKey, value: lockUntil }, update: { value: lockUntil } })
  const startedAt = Date.now()
  let filled = 0
  try {
    filled += await syncQuestionBankDocumentationFromKnowledge(programId)
    const skippedAiIds = new Set<string>()
    while (Date.now() - startedAt < timeBudgetMs) {
      const batch = await db.questionBankItem.findMany({
        where: { programId, status: { not: 'REJECTED' }, id: { notIn: [...skippedAiIds] } },
        orderBy: { createdAt: 'asc' },
        take: 200,
      })
      const needs = batch.filter((item) => needsAiDocumentation(item) && !isMissing(item.sourceEvidence)).slice(0, 10)
      if (!needs.length) break
      try {
        const raw = await textAiCompleteJson({
          taskLevel: 'ACADEMIC_CRITICAL',
          system: 'أنت مدقق أكاديمي. أعد JSON فقط. لا تغير نص السؤال أو الخيارات أو الإجابة الصحيحة أو حالة السؤال أو أعلام الجودة. املأ فقط difficulty من EASY/MEDIUM/ADVANCED و cognitiveSkill من UNDERSTAND/APPLY/ANALYZE/EVALUATE و correctRationale من الدليل. للأسئلة الموضوعية أعط distractorRationales مختصرة لكل خيار خاطئ، وفي صح/خطأ سبباً واحداً لعكس الإجابة.',
          history: [{ role: 'user', text: JSON.stringify({ questions: needs.map((q) => ({ id: q.id, type: q.type, question: q.text, options: safeJsonArray(q.options), correctAnswer: q.correctAnswer, evidence: q.sourceEvidence })) }) }],
          maxOutputTokens: 3500,
        })
        const rows = new Map(parseAiRows(raw).map((row) => [row.id, row]))
        for (const item of needs) {
          try {
            const row = rows.get(item.id)
            if (!row) {
              console.warn('[question-bank-doc] skipped item without AI row', { programId, id: item.id })
              continue
            }
            const data = documentationPatch(item, row)
            if (!Object.keys(data).length) continue
            filled += Object.keys(data).length
            await db.questionBankItem.update({ where: { id: item.id }, data })
          } catch (error) {
            console.warn('[question-bank-doc] item backfill failed', { programId, id: item.id, error: error instanceof Error ? error.message : String(error) })
          }
        }
      } catch (error) {
        for (const item of needs) {
          skippedAiIds.add(item.id)
          console.warn('[question-bank-doc] item backfill failed', { programId, id: item.id, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    const remaining = await countQuestionBankDocumentationRemaining(programId)
    return { filled, remaining, locked: false, done: remaining === 0 }
  } finally {
    await db.setting.deleteMany({ where: { key: lockKey, value: lockUntil } }).catch(() => {})
  }
}

export function __testDocumentedBankQuestionForPublicationForTests(input: { bookTitle: string; knowledgeTitle?: string | null; pageStart?: number | null; pageEnd?: number | null; excerpt: string }) {
  return {
    status: 'PENDING_REVIEW',
    type: 'TF',
    text: 'سؤال موثق من بنك الأسئلة',
    sourceBookTitle: input.bookTitle,
    sourceLocator: sourceLocatorFromKnowledge({ title: input.knowledgeTitle || null, pageStart: input.pageStart ?? null, pageEnd: input.pageEnd ?? null }, null),
    sourceEvidence: input.excerpt,
    cognitiveSkill: 'UNDERSTAND',
    difficulty: 'EASY',
    correctRationale: 'الدليل يثبت الإجابة الصحيحة.',
    distractorRationales: '["سبب عكس الإجابة"]',
    qualityFlags: '[]',
    knowledgeItemId: 'ki-1',
  }
}
