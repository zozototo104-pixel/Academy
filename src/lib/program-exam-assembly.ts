import type { QuestionBankItem } from '@prisma/client'
import { db } from '@/lib/db'
import { validateLiteralEvidence } from '@/lib/evidence-validator'
import { isDuplicateQuestionIdea } from '@/lib/question-bank-diversity'
import { ensureQuestionBankGenerationJob, runQuestionBankGenerationJobStep } from '@/lib/question-bank-job'
import { textAiCompleteJson } from '@/lib/text-ai'

export const PROGRAM_EXAM_TARGET = 80
export type ExamQuestionType = 'MCQ' | 'TF' | 'SHORT' | 'ESSAY'
const TYPES: ExamQuestionType[] = ['MCQ', 'TF', 'SHORT', 'ESSAY']
const SKILLS = new Set(['UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE'])
const DIFFICULTIES = new Set(['EASY', 'MEDIUM', 'ADVANCED'])

type ExamUnit = { id: string; title: string; semester: number; sourceBookId: string | null; chunkStartIndex: number | null; chunkEndIndex: number | null }
type Candidate = { item: QuestionBankItem; unitId: string; unitTitle: string; sourceBookTitle: string; sourceChapter: string; sourceLocator: string }
type UnitSource = { id: string; bookId: string | null; chunkText: string }
type UnitPool = { unit: ExamUnit; candidates: Candidate[]; sources: UnitSource[]; scopeReady: boolean; pendingReviewCount: number }

function array(value: string | null | undefined): string[] {
  try { const parsed: unknown = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.map(String) : [] } catch { return [] }
}
function normalized(value: string) {
  return value.toLowerCase().replace(/[إأآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[\u064b-\u065f\u0670]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}
function distribution(category?: string | null): Record<ExamQuestionType, number> {
  if (category === 'DOCTORATE') return { MCQ: 16, TF: 8, SHORT: 18, ESSAY: 22 }
  if (category === 'DIPLOMA') return { MCQ: 30, TF: 18, SHORT: 16, ESSAY: 6 }
  if (category === 'ACCREDITATION' || category === 'INTL_CERT') return { MCQ: 30, TF: 16, SHORT: 16, ESSAY: 5 }
  return { MCQ: 20, TF: 12, SHORT: 10, ESSAY: 8 }
}
function verificationAccepted(item: QuestionBankItem) {
  try {
    const notes: unknown = JSON.parse(item.reviewNotes || '{}')
    if (!notes || typeof notes !== 'object') return false
    const verifier = (notes as { verifier?: { provider?: string; model?: string; verifiedAt?: string; pending?: boolean } }).verifier
    return Boolean(verifier?.provider && verifier.model && verifier.verifiedAt && !verifier.pending)
  } catch { return false }
}
function qualified(item: QuestionBankItem, source: { excerpt: string | null; bookId: string | null; chunkText: string }) {
  if (!item.knowledgeItemId || !source.bookId || item.bookId !== source.bookId || item.generatedBy !== 'AI') return false
  if (item.status !== 'APPROVED' || !array(item.qualityFlags).includes('SOURCE_GROUNDED')) return false
  if (!verificationAccepted(item) || !item.sourceEvidence || !item.sourceLocator || !item.correctRationale) return false
  if (!SKILLS.has(item.cognitiveSkill || '') || !DIFFICULTIES.has(item.difficulty || '')) return false
  if (!TYPES.includes(item.type as ExamQuestionType) || !item.text?.trim()) return false
  if (!source.excerpt || !source.chunkText || !validateLiteralEvidence({ evidence: source.excerpt, sourceText: source.chunkText }).ok) return false
  if (!validateLiteralEvidence({ evidence: item.sourceEvidence, sourceText: source.chunkText }).ok) return false
  if (item.type === 'MCQ' || item.type === 'TF') {
    const options = array(item.options)
    if (item.correctAnswer == null || !/^\d+$/.test(item.correctAnswer)) return false
    const correct = Number(item.correctAnswer)
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length || (item.type === 'MCQ' && options.length < 3) || (item.type === 'TF' && options.length !== 2)) return false
    if (item.type === 'MCQ') {
      try { const reasons: unknown = JSON.parse(item.distractorRationales || '[]'); if (!Array.isArray(reasons) || !reasons.length) return false } catch { return false }
    }
  } else if (!item.modelAnswer?.trim()) return false
  return true
}

async function loadUnitPools(programId: string, units: ExamUnit[]): Promise<UnitPool[]> {
  return Promise.all(units.map(async (unit) => {
    if (!unit.sourceBookId || unit.chunkStartIndex == null || unit.chunkEndIndex == null) return { unit, candidates: [], sources: [], scopeReady: false, pendingReviewCount: 0 }
    const chunks = await db.bookChunk.findMany({ where: { bookId: unit.sourceBookId, index: { gte: unit.chunkStartIndex, lte: unit.chunkEndIndex } }, select: { id: true, text: true } })
    if (!chunks.length) return { unit, candidates: [], sources: [], scopeReady: false, pendingReviewCount: 0 }
    const chunkTextById = new Map(chunks.map((chunk) => [chunk.id, chunk.text]))
    const sources = await db.bookKnowledgeItem.findMany({
      where: { programId, kbVersion: 2, chunkId: { in: chunks.map((chunk) => chunk.id) }, category: { notIn: ['QUESTION_SEED', 'LEGACY'] } },
      select: { id: true, bookId: true, chunkId: true, excerpt: true, title: true, pageStart: true, pageEnd: true },
    })
    if (!sources.length) return { unit, candidates: [], sources: [], scopeReady: false, pendingReviewCount: 0 }
    const sourceMap = new Map(sources.map((source) => [source.id, source]))
    const titles = await db.book.findMany({ where: { id: { in: [...new Set(sources.map((s) => s.bookId).filter((id): id is string => Boolean(id)))] } }, select: { id: true, title: true } })
    const bookTitles = new Map(titles.map((book) => [book.id, book.title]))
    const pendingReviewCount = await db.questionBankItem.count({
      where: { programId, knowledgeItemId: { in: sources.map((source) => source.id) }, status: 'PENDING_REVIEW' },
    })
    const questions = await db.questionBankItem.findMany({
      where: { programId, knowledgeItemId: { in: sources.map((source) => source.id) }, status: 'APPROVED', qualityFlags: { contains: 'SOURCE_GROUNDED' } },
      orderBy: [{ usageCount: 'asc' }, { createdAt: 'desc' }],
      take: 600,
    })
    const candidates: Candidate[] = []
    for (const item of questions) {
      const source = sourceMap.get(item.knowledgeItemId || '')
      if (!source || !qualified(item, { ...source, chunkText: chunkTextById.get(source.chunkId || '') || '' })) continue
      candidates.push({
        item, unitId: unit.id, unitTitle: unit.title,
        sourceBookTitle: bookTitles.get(source.bookId || '') || item.sourceBookTitle || '',
        sourceChapter: unit.title,
        sourceLocator: [item.sourceLocator, source.pageStart ? `ص ${source.pageStart}${source.pageEnd && source.pageEnd !== source.pageStart ? `–${source.pageEnd}` : ''}` : ''].filter(Boolean).join(' — '),
      })
    }
    return { unit, candidates, sources: sources.map((source) => ({ id: source.id, bookId: source.bookId, chunkText: chunkTextById.get(source.chunkId || '') || '' })), scopeReady: true, pendingReviewCount }
  }))
}

function toQuestion(examId: string, order: number, candidate: Candidate) {
  const item = candidate.item
  // The bank already balanced MCQ options; reshuffling here would corrupt distractor explanations.
  return {
    examId, order, type: item.type, text: item.text, options: item.options,
    correctAnswer: item.correctAnswer, modelAnswer: item.modelAnswer,
    sourceEvidence: item.sourceEvidence, knowledgeItemId: item.knowledgeItemId,
    sourceBookTitle: candidate.sourceBookTitle, sourceChapter: candidate.sourceChapter,
    sourceLocator: candidate.sourceLocator, cognitiveSkill: item.cognitiveSkill,
    difficulty: item.difficulty, correctRationale: item.correctRationale,
    distractorRationales: item.distractorRationales,
    qualityFlags: JSON.stringify([...array(item.qualityFlags), `QUESTION_BANK_ITEM_ID:${item.id}`]),
    reviewNotes: item.reviewNotes, points: 2, status: 'PENDING_REVIEW',
  }
}

function bankIdFromFlags(value: string | null | undefined): string | null {
  return array(value).find((flag) => flag.startsWith('QUESTION_BANK_ITEM_ID:'))?.slice('QUESTION_BANK_ITEM_ID:'.length) || null
}

function isMissing(value: string | null | undefined) {
  return !String(value || '').trim()
}

function safeJsonArray(value: string | null | undefined): string[] {
  try { const parsed: unknown = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [] } catch { return [] }
}

function sourceLocatorFromKnowledge(item: { title?: string | null; pageStart?: number | null; pageEnd?: number | null } | null | undefined, fallback?: string | null) {
  const page = item?.pageStart == null ? '' : `صفحة ${item.pageStart}${item.pageEnd != null && item.pageEnd !== item.pageStart ? `–${item.pageEnd}` : ''}`
  return [fallback, page, item?.title ? `مقطع ${item.title}` : ''].filter(Boolean).join(' — ').slice(0, 240)
}

type AcademicBackfillRow = { id: string; difficulty?: string; cognitiveSkill?: string; correctRationale?: string; distractorRationales?: string[] }

type AcademicQuestionPatchTarget = { type: string; difficulty?: string | null; cognitiveSkill?: string | null; correctRationale?: string | null; distractorRationales?: string | null }

function parseAiBackfill(raw: string): AcademicBackfillRow[] {
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
      const distractorRationales = Array.isArray(item.distractorRationales) ? item.distractorRationales.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 6) : undefined
      return [{
        id,
        difficulty: DIFFICULTIES.has(difficulty) ? difficulty : undefined,
        cognitiveSkill: SKILLS.has(cognitiveSkill) ? cognitiveSkill : undefined,
        correctRationale: String(item.correctRationale || '').trim().slice(0, 1000) || undefined,
        distractorRationales,
      }]
    })
  } catch { return [] }
}

function academicBackfillData(question: AcademicQuestionPatchTarget, row: AcademicBackfillRow): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  if (isMissing(question.difficulty) && row.difficulty) data.difficulty = row.difficulty
  if (isMissing(question.cognitiveSkill) && row.cognitiveSkill) data.cognitiveSkill = row.cognitiveSkill
  if (isMissing(question.correctRationale) && row.correctRationale) data.correctRationale = row.correctRationale
  if ((question.type === 'MCQ' || question.type === 'TF') && isMissing(question.distractorRationales) && row.distractorRationales?.length) data.distractorRationales = JSON.stringify(row.distractorRationales).slice(0, 1800)
  return data
}

export function __testAcademicBackfillDataForTests(question: AcademicQuestionPatchTarget, row: AcademicBackfillRow) {
  return academicBackfillData(question, row)
}

export function __testProgramQuestionAcademicCopyForTests(input: { bookTitle: string; knowledgeTitle?: string | null; pageStart?: number | null; pageEnd?: number | null; bank: { sourceLocator?: string | null; sourceEvidence?: string | null; cognitiveSkill?: string | null; difficulty?: string | null; correctRationale?: string | null; distractorRationales?: string | null } }) {
  return {
    sourceBookTitle: input.bookTitle,
    sourceLocator: sourceLocatorFromKnowledge({ title: input.knowledgeTitle || null, pageStart: input.pageStart ?? null, pageEnd: input.pageEnd ?? null }, input.bank.sourceLocator || null),
    sourceEvidence: input.bank.sourceEvidence || null,
    cognitiveSkill: input.bank.cognitiveSkill || null,
    difficulty: input.bank.difficulty || null,
    correctRationale: input.bank.correctRationale || null,
    distractorRationales: input.bank.distractorRationales || null,
  }
}

async function syncProgramExamQuestionsFromBank(examId: string) {
  const questions = await db.programQuestion.findMany({ where: { examId, status: { not: 'REJECTED' } }, select: { id: true, qualityFlags: true, sourceBookTitle: true, sourceLocator: true, sourceEvidence: true, cognitiveSkill: true, difficulty: true, correctRationale: true, distractorRationales: true } })
  const bankIds = [...new Set(questions.map((q) => bankIdFromFlags(q.qualityFlags)).filter((id): id is string => Boolean(id)))]
  if (!bankIds.length) return 0
  const bankItems = await db.questionBankItem.findMany({ where: { id: { in: bankIds } } })
  const bankById = new Map(bankItems.map((item) => [item.id, item]))
  const knowledgeIds = [...new Set(bankItems.map((item) => item.knowledgeItemId).filter((id): id is string => Boolean(id)))]
  const knowledge = knowledgeIds.length ? await db.bookKnowledgeItem.findMany({ where: { id: { in: knowledgeIds } }, select: { id: true, bookId: true, title: true, pageStart: true, pageEnd: true } }) : []
  const knowledgeById = new Map(knowledge.map((item) => [item.id, item]))
  const books = await db.book.findMany({ where: { id: { in: [...new Set(knowledge.map((item) => item.bookId).filter((id): id is string => Boolean(id)))] } }, select: { id: true, title: true } })
  const bookTitles = new Map(books.map((book) => [book.id, book.title]))
  let filled = 0
  for (const question of questions) {
    const bankId = bankIdFromFlags(question.qualityFlags)
    const bank = bankId ? bankById.get(bankId) : null
    if (!bank) continue
    const knowledgeItem = bank.knowledgeItemId ? knowledgeById.get(bank.knowledgeItemId) : null
    const data: Record<string, unknown> = {}
    if (isMissing(question.sourceEvidence) && bank.sourceEvidence) data.sourceEvidence = bank.sourceEvidence
    if (isMissing(question.sourceBookTitle)) {
      const title = bank.sourceBookTitle || bookTitles.get(knowledgeItem?.bookId || '') || ''
      if (title) data.sourceBookTitle = title
    }
    if (isMissing(question.sourceLocator)) {
      const locator = sourceLocatorFromKnowledge(knowledgeItem, bank.sourceLocator)
      if (locator) data.sourceLocator = locator
    }
    if (isMissing(question.cognitiveSkill) && bank.cognitiveSkill) data.cognitiveSkill = bank.cognitiveSkill
    if (isMissing(question.difficulty) && bank.difficulty) data.difficulty = bank.difficulty
    if (isMissing(question.correctRationale) && bank.correctRationale) data.correctRationale = bank.correctRationale
    if (isMissing(question.distractorRationales) && bank.distractorRationales) data.distractorRationales = bank.distractorRationales
    if (Object.keys(data).length) {
      filled += Object.keys(data).length
      await db.programQuestion.update({ where: { id: question.id }, data })
    }
  }
  return filled
}

export async function backfillProgramExamAcademicFields(examId: string) {
  let filled = await syncProgramExamQuestionsFromBank(examId)
  const questions = await db.programQuestion.findMany({
    where: { examId, status: { not: 'REJECTED' } },
    select: { id: true, type: true, text: true, options: true, correctAnswer: true, sourceEvidence: true, cognitiveSkill: true, difficulty: true, correctRationale: true, distractorRationales: true },
    orderBy: { order: 'asc' },
  })
  const needs = questions.filter((q) =>
    isMissing(q.correctRationale) || isMissing(q.difficulty) || isMissing(q.cognitiveSkill) || ((q.type === 'MCQ' || q.type === 'TF') && !safeJsonArray(q.distractorRationales).length),
  )
  for (let i = 0; i < needs.length; i += 10) {
    const batch = needs.slice(i, i + 10).filter((q) => q.sourceEvidence)
    if (!batch.length) continue
    try {
      const payload = batch.map((q) => ({ id: q.id, type: q.type, question: q.text, options: safeJsonArray(q.options), correctAnswer: q.correctAnswer, evidence: q.sourceEvidence }))
      const raw = await textAiCompleteJson({
        taskLevel: 'ACADEMIC_CRITICAL',
        system: 'أنت مدقق أكاديمي. أعد JSON فقط. لا تغير نص السؤال أو الخيارات أو الإجابة الصحيحة. املأ فقط difficulty من EASY/MEDIUM/ADVANCED و cognitiveSkill من UNDERSTAND/APPLY/ANALYZE/EVALUATE و correctRationale من الدليل. للأسئلة الموضوعية أعط distractorRationales مختصرة لكل خيار خاطئ، وفي صح/خطأ سبباً واحداً لعكس الإجابة.',
        history: [{ role: 'user', text: JSON.stringify({ questions: payload }) }],
        maxOutputTokens: 3500,
      })
      const rows = new Map(parseAiBackfill(raw).map((row) => [row.id, row]))
      for (const question of batch) {
        const row = rows.get(question.id)
        if (!row) continue
        const data = academicBackfillData(question, row)
        if (Object.keys(data).length) {
          filled += Object.keys(data).length
          await db.programQuestion.update({ where: { id: question.id }, data })
        }
      }
    } catch (error) {
      console.warn('[program-exam] academic-backfill batch failed', { examId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const remaining = await db.programQuestion.count({
    where: { examId, status: { not: 'REJECTED' }, OR: [
      { correctRationale: null }, { correctRationale: '' }, { difficulty: null }, { difficulty: '' }, { cognitiveSkill: null }, { cognitiveSkill: '' },
      { AND: [{ type: { in: ['MCQ', 'TF'] } }, { OR: [{ distractorRationales: null }, { distractorRationales: '' }] }] },
    ] },
  })
  console.info('[program-exam] academic-backfill', { examId, filled, remaining })
  return { filled, remaining }
}

export async function advanceProgramExamFromVerifiedBank(examId: string, options: { manual?: boolean } = {}) {
  const exam = await db.programExam.findUnique({ where: { id: examId }, include: { program: { select: { category: true } }, _count: { select: { attempts: true } } } })
  if (!exam) throw new Error('EXAM_NOT_FOUND')
  if (exam.status === 'READY' || exam._count.attempts > 0) throw new Error('EXAM_IMMUTABLE')
  if (exam.status !== 'GENERATING') return { ok: true, examId, status: exam.status, done: exam.status === 'REVIEW', inserted: 0, questionCount: await db.programQuestion.count({ where: { examId, status: { not: 'REJECTED' } } }), requiredQuestions: PROGRAM_EXAM_TARGET, jobId: null as string | null }
  const units = await db.unit.findMany({
    where: { programId: exam.programId, ...(exam.semester === 3 ? {} : { semester: exam.semester }) },
    orderBy: [{ semester: 'asc' }, { order: 'asc' }],
    select: { id: true, title: true, semester: true, sourceBookId: true, chunkStartIndex: true, chunkEndIndex: true },
  })
  if (!units.length) throw new Error('EXAM_UNITS_REQUIRED')
  const pools = await loadUnitPools(exam.programId, units)
  const eligible = pools.flatMap((pool) => pool.candidates)
  const pendingReviewTotal = await db.questionBankItem.count({ where: { programId: exam.programId, status: 'PENDING_REVIEW' } })
  const pendingReviewNote = `في ${pendingReviewTotal} أسئلة بانتظار المراجعة.`
  const minTypes = distribution(exam.program.category)
  const knowledgeUnits = new Map<string, string>()
  for (const candidate of eligible) if (candidate.item.knowledgeItemId) knowledgeUnits.set(candidate.item.knowledgeItemId, candidate.unitId)
  const maxPerUnit = Math.ceil(PROGRAM_EXAM_TARGET / units.length)
  const result = await db.$transaction(async (tx) => {
    // Repeated admin clicks and cron ticks cannot pick the same bank item simultaneously.
    await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(472918, hashtext(${examId}))`
    const currentExam = await tx.programExam.findUnique({ where: { id: examId }, select: { status: true } })
    const existing = await tx.programQuestion.findMany({ where: { examId }, select: { text: true, type: true, status: true, order: true, points: true, knowledgeItemId: true, qualityFlags: true, sourceEvidence: true, sourceBookTitle: true, sourceLocator: true } })
    const active = existing.filter((question) => question.status !== 'REJECTED')
    if (currentExam?.status !== 'GENERATING') return { questionCount: active.length, inserted: 0, done: currentExam?.status === 'REVIEW', status: currentExam?.status || 'REVIEW', byType: {} as Record<string, number>, byUnit: {} as Record<string, number> }
    const byType: Record<string, number> = Object.fromEntries(TYPES.map((type) => [type, active.filter((q) => q.type === type).length]))
    const byUnit: Record<string, number> = Object.fromEntries(units.map((unit) => [unit.id, 0]))
    const seenBankIds = new Set(active.flatMap((q) => array(q.qualityFlags).filter((flag) => flag.startsWith('QUESTION_BANK_ITEM_ID:')).map((flag) => flag.slice('QUESTION_BANK_ITEM_ID:'.length))))
    const seenTexts = new Set(active.map((q) => normalized(q.text)))
    const seenIdeas = active.map((q) => ({ text: q.text, knowledgeItemId: q.knowledgeItemId }))
    for (const question of active) { const unitId = knowledgeUnits.get(question.knowledgeItemId || ''); if (unitId) byUnit[unitId]++ }
    const taken: Candidate[] = []
    while (active.length + taken.length < PROGRAM_EXAM_TARGET) {
      const remaining = PROGRAM_EXAM_TARGET - active.length - taken.length
      const next = eligible.filter(({ item, unitId }) => {
        if (seenBankIds.has(item.id) || (byUnit[unitId] || 0) >= maxPerUnit || seenTexts.has(normalized(item.text))) return false
        if (isDuplicateQuestionIdea(item.text, item.knowledgeItemId || '', seenIdeas)) return false
        const afterDeficits = TYPES.reduce((sum, type) => sum + Math.max(0, minTypes[type] - (byType[type] || 0) - (item.type === type ? 1 : 0)), 0)
        return afterDeficits <= remaining - 1
      }).sort((a, b) => {
        const aDeficit = Math.max(0, minTypes[a.item.type as ExamQuestionType] - (byType[a.item.type] || 0))
        const bDeficit = Math.max(0, minTypes[b.item.type as ExamQuestionType] - (byType[b.item.type] || 0))
        if (Boolean(aDeficit) !== Boolean(bDeficit)) return aDeficit ? -1 : 1
        const unitDiff = (byUnit[a.unitId] || 0) - (byUnit[b.unitId] || 0)
        if (unitDiff) return unitDiff
        if (aDeficit !== bDeficit) return bDeficit - aDeficit
        if (a.item.status !== b.item.status) return a.item.status === 'APPROVED' ? -1 : 1
        return a.item.usageCount - b.item.usageCount
      })[0]
      if (!next) break
      taken.push(next)
      seenBankIds.add(next.item.id)
      seenTexts.add(normalized(next.item.text))
      seenIdeas.push({ text: next.item.text, knowledgeItemId: next.item.knowledgeItemId })
      byType[next.item.type] = (byType[next.item.type] || 0) + 1
      byUnit[next.unitId] = (byUnit[next.unitId] || 0) + 1
    }
    if (taken.length) {
      const firstOrder = Math.max(0, ...existing.map((q) => q.order)) + 1
      await tx.programQuestion.createMany({ data: taken.map((candidate, index) => toQuestion(examId, firstOrder + index, candidate)) })
      await tx.questionBankItem.updateMany({ where: { id: { in: taken.map((candidate) => candidate.item.id) } }, data: { usageCount: { increment: 1 } } })
    }
    const questionCount = active.length + taken.length
    // Preserve older questions without falsely declaring them source-verified.
    // Verified-bank questions carry a durable bank-id marker; older records need a literal
    // excerpt from one of this exam's actual V2 book sources before completion is claimed.
    const legacyUnverified = active.filter((question) => {
      if (array(question.qualityFlags).some((flag) => flag.startsWith('QUESTION_BANK_ITEM_ID:'))) return false
      if (!question.sourceEvidence || !question.sourceLocator || !question.sourceBookTitle) return true
      return !pools.some((pool) => pool.sources.some((source) =>
        validateLiteralEvidence({ evidence: question.sourceEvidence, sourceText: source.chunkText }).ok,
      ))
    }).length
    const blockedByLegacy = questionCount >= PROGRAM_EXAM_TARGET && legacyUnverified > 0
    const complete = questionCount >= PROGRAM_EXAM_TARGET && legacyUnverified === 0 && TYPES.every((type) => (byType[type] || 0) >= minTypes[type])
    const status = complete ? 'REVIEW' : blockedByLegacy ? 'PAUSED' : 'GENERATING'
    const note = complete ? null : blockedByLegacy
      ? `تم حفظ ${questionCount} سؤالًا، لكن ${legacyUnverified} من الأسئلة القديمة لا يمكن مطابقة دليلها حرفيًا مع الكتب وبنك المعرفة V2. راجعها أو ارفض غير الموثق منها ثم استكمل، دون حذف تلقائي.`
      : `مستمر: ${questionCount}/${PROGRAM_EXAM_TARGET} سؤال معتمد؛ بانتظار أسئلة موثقة إضافية من بنك المعرفة V2. ${pendingReviewNote} ${pools.filter((p) => !p.scopeReady).map((p) => p.unit.title).slice(0, 3).join('، ')}`.slice(0, 1000)
    const points = active.reduce((total, q) => total + q.points, 0) + taken.length * 2
    await tx.programExam.update({ where: { id: examId }, data: { status, errorNote: note, totalPoints: points, durationMin: Math.max(120, Math.min(240, questionCount * 2)), booksUsed: 'بنك الأسئلة الموثق من نصوص الكتب وبنك المعرفة V2' } })
    return { questionCount, inserted: taken.length, done: complete, status, byType, byUnit }
  }, { maxWait: 15_000, timeout: 20_000 })

  await backfillProgramExamAcademicFields(examId)

  let jobId: string | null = null
  let errorNote: string | null = null
  if (!result.done && result.status === 'GENERATING') {
    const scoped = pools.filter((pool) => pool.scopeReady)
    if (!scoped.length) {
      errorNote = 'لا تتوفر وحدات ذات نطاق كتاب وبنك معرفة V2 صالح. أكمل استخراج الكتب وتحليل الوحدات أولاً.'
    } else {
      const selectedType = [...TYPES].sort((a, b) => {
        const aGap = Math.max(0, minTypes[a] - (result.byType[a] || 0))
        const bGap = Math.max(0, minTypes[b] - (result.byType[b] || 0))
        return bGap - aGap || (result.byType[a] || 0) - (result.byType[b] || 0)
      })[0]
      const ranked = [...scoped].sort((a, b) =>
        ((result.byUnit[a.unit.id] || 0) - (result.byUnit[b.unit.id] || 0)) ||
        (a.candidates.filter((c) => c.item.type === selectedType).length - b.candidates.filter((c) => c.item.type === selectedType).length),
      )
      const next = ranked.find((pool) => (result.byUnit[pool.unit.id] || 0) < maxPerUnit) || null
      if (next) {
        const eligibleTypeCount = next.candidates.filter((candidate) => candidate.item.type === selectedType).length
        const requested = Math.min(20, eligibleTypeCount + 4)
        const lastJob = await db.questionBankGenerationJob.findFirst({ where: { programId: exam.programId, unitId: next.unit.id }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, lastError: true } })
        if (lastJob?.status === 'FAILED' && !options.manual) errorNote = `توقف توليد بنك الأسئلة للوحدة «${next.unit.title}»: ${lastJob.lastError || 'فشل التحقق أو المزود'}. استخدم استكمال بعد معالجة السبب.`
        else {
          const job = await ensureQuestionBankGenerationJob({ programId: exam.programId, unitId: next.unit.id, requested, startNew: lastJob?.status === 'COMPLETED', manual: Boolean(options.manual) })
          jobId = job.id
          if (job.status === 'FAILED') errorNote = job.lastError || 'فشل توليد أسئلة الوحدة'
          else if (job.status !== 'COMPLETED') {
            const step = await runQuestionBankGenerationJobStep(job.id)
            if (step?.status === 'FAILED') errorNote = step.lastError || 'فشل توليد أسئلة الوحدة'
          }
        }
      } else errorNote = 'لم تُستوفَ التغطية المتوازنة لجميع الوحدات، ولا توجد وحدة مؤهلة لتوليد بقية الأسئلة.'
    }
    if (errorNote) {
      await db.programExam.update({ where: { id: examId, status: 'GENERATING' }, data: { status: 'PAUSED', errorNote: errorNote.slice(0, 1000) } })
    }
  }
  const unitBreakdown = units.map((unit) => ({
    unitId: unit.id,
    title: unit.title,
    semester: unit.semester,
    questionCount: result.byUnit[unit.id] || 0,
  }))
  return { ok: true, examId, status: errorNote ? 'PAUSED' : result.status, done: result.done, inserted: result.inserted, questionCount: result.questionCount, requiredQuestions: PROGRAM_EXAM_TARGET, byType: result.byType, unitBreakdown, missingUnits: pools.filter((p) => !p.scopeReady).map((p) => ({ unitId: p.unit.id, title: p.unit.title, reason: 'UNIT_V2_KNOWLEDGE_REQUIRED' })), jobId, errorNote }
}

export async function runNextGeneratingProgramExamStep() {
  const exam = await db.programExam.findFirst({ where: { status: 'GENERATING', generatedBy: 'AI' }, orderBy: { updatedAt: 'asc' }, select: { id: true } })
  if (!exam) return null
  return advanceProgramExamFromVerifiedBank(exam.id)
}
