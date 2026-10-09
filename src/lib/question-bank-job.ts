import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { BOOK_READ_RETRY_MS } from '@/lib/book-read-job-control'
import { textAiCompleteJsonWithMetadata, textAiDiagnostics } from '@/lib/text-ai'
import { parseGeneratedQuestionCandidates } from '@/lib/question-bank-generation'
import { buildQuestionBankRecord, validateQuestionBatchAgainstKnowledge } from '@/lib/question-bank-evidence'
import { verifyQuestionsWithCrossProvider } from '@/lib/question-verifier'
import { questionDuplicateKey } from '@/lib/ai-generation-progress'
import { isDuplicateQuestionIdea } from '@/lib/question-bank-diversity'
import { selectUnitExamQuestionsApprovedFirst, unitExamRequiredQuestions } from '@/lib/unit-exam-policy'

const TYPES = new Set(['MCQ', 'TF', 'SHORT', 'ESSAY'])
const DIFFICULTIES = new Set(['EASY', 'MEDIUM', 'ADVANCED'])
const JOB_FAILURE_PREFIX = 'QUESTION_BANK_JOB_FAILURES:'
const JOB_TRACE_PREFIX = 'QUESTION_BANK_JOB_TRACE:'
const JOB_CURSOR_PREFIX = 'QUESTION_BANK_JOB_CURSOR:'
export const QUESTION_BANK_STEP_MS = 50_000
const QUESTION_BANK_LOCK_GRACE_MS = 10_000

type QuestionBankSource = {
  id: string
  title: string
  category: string | null
  summary: string | null
  excerpt: string | null
  sourceNote: string | null
  bookId: string | null
  semester: number | null
  pageStart: number | null
  pageEnd: number | null
}

export type QuestionBankJobTrace = {
  generated: number
  saved: number
  verifierRejected: number
  rejected: number
  rejectionReasons: Array<{ reason: string; count: number }>
  aiTrace?: {
    generatorProvider?: string | null
    generatorModel?: string | null
    verifierProvider?: string | null
    verifierModel?: string | null
    sameProviderVerifierFallback?: boolean
  }
}

type JobFailureState = { lastError: string; count: number }
type ExistingQuestionBankJobState = { status: string; requested: number; retryAt?: Date | string | null }

type GeneratedQuestionCandidate = {
  type?: string
  text?: string
  question?: string
  options?: unknown
  correctAnswer?: unknown
  modelAnswer?: string | null
  answer?: string | null
  sourceEvidence?: string | null
  sourceBookTitle?: string | null
  sourceLocator?: string | null
  cognitiveSkill?: string | null
  difficulty?: string | null
  correctRationale?: string | null
  rationale?: string | null
  distractorRationales?: unknown
  qualityFlags?: unknown
}

export function assertGeneratedBatchHasAcceptedCandidates(parsed: { accepted: unknown[] }) {
  if (!parsed.accepted.length) throw new Error('QUESTION_BATCH_ALL_STRUCTURALLY_REJECTED')
}

export function planQuestionBankJobManualReactivation(job: ExistingQuestionBankJobState, requested: number, manual: boolean) {
  const normalizedRequested = Math.max(job.requested || 0, requested)
  const reactivatesPausedOrFailed = manual && ['PAUSED', 'FAILED'].includes(job.status)
  return {
    shouldUpdate: reactivatesPausedOrFailed || job.requested < requested,
    resetFailureCounter: reactivatesPausedOrFailed,
    status: reactivatesPausedOrFailed ? 'QUEUED' : job.status === 'PAUSED' ? 'QUEUED' : job.status,
    requested: normalizedRequested,
    retryAt: reactivatesPausedOrFailed ? null : job.retryAt ?? null,
  }
}

export function planQuestionBankSourceWindow(total: number, cursor: number, windowSize: number) {
  const safeTotal = Math.max(0, Math.floor(total))
  if (safeTotal === 0) return { start: 0, indexes: [] as number[], nextCursor: 0 }
  const safeWindow = Math.max(1, Math.min(Math.floor(windowSize), safeTotal))
  const start = ((Math.floor(cursor) % safeTotal) + safeTotal) % safeTotal
  const indexes = Array.from({ length: safeWindow }, (_, offset) => (start + offset) % safeTotal)
  return { start, indexes, nextCursor: (start + safeWindow) % safeTotal }
}

function cleanText(value: unknown, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function rawRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function prepareMcqOptionsForStorage(value: unknown, correctAnswer: unknown) {
  const arr = Array.isArray(value) ? value : []
  const options = arr.map((x) => cleanText(x, 260)).filter(Boolean).slice(0, 6)
  if (options.length < 3) return { options: [] as string[], correctAnswer: null as string | null, reason: 'MCQ_REQUIRES_AT_LEAST_3_OPTIONS' }
  const answerText = cleanText(correctAnswer, 260)
  const answerIndex = /^\d+$/.test(answerText) ? Number(answerText) : options.findIndex((option) => option === answerText)
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= options.length) return { options: [] as string[], correctAnswer: null as string | null, reason: 'MCQ_ANSWER_NOT_IN_OPTIONS' }
  if (options.length <= 4) return { options, correctAnswer: String(answerIndex), reason: null as string | null }
  const wrongIndexes = options.map((_, index) => index).filter((index) => index !== answerIndex).slice(0, 3)
  const selectedIndexes = [...wrongIndexes, answerIndex].sort((a, b) => a - b)
  const selectedOptions = selectedIndexes.map((index) => options[index])
  return { options: selectedOptions, correctAnswer: String(selectedIndexes.indexOf(answerIndex)), reason: null as string | null }
}

function safeOptions(value: unknown, type: string) {
  const arr = Array.isArray(value) ? value : []
  const options = arr.map((x) => cleanText(x, 260)).filter(Boolean).slice(0, 6)
  if (type === 'TF') return ['صح', 'خطأ']
  if (type === 'MCQ') return options.length >= 3 ? options.slice(0, 4) : []
  return []
}

function sanitizeQuestion(raw: GeneratedQuestionCandidate, fallback: Partial<QuestionBankSource> = {}) {
  const type = TYPES.has(String(raw.type || '').toUpperCase()) ? String(raw.type).toUpperCase() : 'MCQ'
  const rawDifficulty = String(raw.difficulty || '').toUpperCase()
  const difficulty = DIFFICULTIES.has(rawDifficulty) ? rawDifficulty : ''
  const sourceEvidence = cleanText(raw.sourceEvidence, 1800)
  const cognitiveSkill = cleanText(raw.cognitiveSkill, 40)
  const text = cleanText(raw.text || raw.question || fallback.title, 1200)
  const mcq = type === 'MCQ' ? prepareMcqOptionsForStorage(raw.options, raw.correctAnswer) : null
  const options = mcq ? mcq.options : safeOptions(raw.options, type)
  let correctAnswer = mcq ? mcq.correctAnswer : raw.correctAnswer != null ? String(raw.correctAnswer) : null
  if (correctAnswer != null && Number.isNaN(Number(correctAnswer))) correctAnswer = null
  if (type === 'TF' && correctAnswer != null && !['0', '1'].includes(correctAnswer)) correctAnswer = /^صح|true$/iu.test(correctAnswer) ? '0' : /^خطأ|false$/iu.test(correctAnswer) ? '1' : null
  return {
    type,
    text,
    options: options.length ? JSON.stringify(options) : null,
    correctAnswer: type === 'MCQ' || type === 'TF' ? correctAnswer : null,
    modelAnswer: type === 'SHORT' || type === 'ESSAY' ? cleanText(raw.modelAnswer || raw.answer || fallback.summary, 1800) : cleanText(raw.modelAnswer || '', 1200) || null,
    sourceEvidence: sourceEvidence || null,
    sourceBookTitle: cleanText(raw.sourceBookTitle || fallback.sourceNote, 220) || null,
    sourceLocator: cleanText(raw.sourceLocator || fallback.title, 220) || null,
    cognitiveSkill: cognitiveSkill || null,
    difficulty,
    correctRationale: cleanText(raw.correctRationale || raw.rationale, 1000) || null,
    distractorRationales: raw.distractorRationales ? JSON.stringify(raw.distractorRationales).slice(0, 1800) : null,
    qualityFlags: Array.isArray(raw.qualityFlags) ? raw.qualityFlags.map(String).filter(Boolean) : [],
  }
}

function evidenceText(item: { excerpt?: string | null; summary?: string | null }) {
  return cleanText(item.excerpt || item.summary, 2200)
}

function safeJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function failureKey(jobId: string) { return `${JOB_FAILURE_PREFIX}${jobId}` }
function traceKey(jobId: string) { return `${JOB_TRACE_PREFIX}${jobId}` }
function cursorKey(jobId: string) { return `${JOB_CURSOR_PREFIX}${jobId}` }

function reasonCounts(reasons: string[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>()
  for (const reason of reasons.map((item) => cleanText(item, 220)).filter(Boolean)) counts.set(reason, (counts.get(reason) || 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, count]) => ({ reason, count }))
}

async function saveJobTrace(jobId: string, trace: QuestionBankJobTrace) {
  await db.setting.upsert({ where: { key: traceKey(jobId) }, update: { value: JSON.stringify(trace) }, create: { key: traceKey(jobId), value: JSON.stringify(trace) } }).catch(() => null)
}

export async function readQuestionBankJobTrace(jobId: string): Promise<QuestionBankJobTrace | null> {
  const row = await db.setting.findUnique({ where: { key: traceKey(jobId) } }).catch(() => null)
  if (!row?.value) return null
  const parsed = safeJsonRecord(row.value)
  const rawReasons = Array.isArray(parsed.rejectionReasons) ? parsed.rejectionReasons : []
  return {
    generated: Number(parsed.generated || 0),
    saved: Number(parsed.saved || 0),
    verifierRejected: Number(parsed.verifierRejected || 0),
    rejected: Number(parsed.rejected || 0),
    rejectionReasons: rawReasons.map((item) => {
      const entry = rawRecord(item)
      return { reason: cleanText(entry.reason, 220) || 'UNKNOWN', count: Number(entry.count || 0) }
    }).filter((item) => item.count > 0).slice(0, 3),
    aiTrace: parsed.aiTrace && typeof parsed.aiTrace === 'object' ? parsed.aiTrace as QuestionBankJobTrace['aiTrace'] : undefined,
  }
}

async function readJobCursor(jobId: string) {
  const row = await db.setting.findUnique({ where: { key: cursorKey(jobId) } }).catch(() => null)
  return Math.max(0, Number(row?.value || 0) || 0)
}

async function saveJobCursor(jobId: string, cursor: number) {
  await db.setting.upsert({ where: { key: cursorKey(jobId) }, update: { value: String(Math.max(0, cursor)) }, create: { key: cursorKey(jobId), value: String(Math.max(0, cursor)) } }).catch(() => null)
}

async function resetJobFailureState(jobId: string) {
  await db.setting.deleteMany({ where: { key: { in: [failureKey(jobId)] } } }).catch(() => null)
}

async function recordJobFailure(jobId: string, message: string): Promise<JobFailureState> {
  const previous = await db.setting.findUnique({ where: { key: failureKey(jobId) } }).catch(() => null)
  const parsed = safeJsonRecord(previous?.value)
  const lastError = cleanText(parsed.lastError, 1000)
  const count = lastError && lastError === message ? Number(parsed.count || 0) + 1 : 1
  const state = { lastError: message, count }
  await db.setting.upsert({ where: { key: failureKey(jobId) }, update: { value: JSON.stringify(state) }, create: { key: failureKey(jobId), value: JSON.stringify(state) } }).catch(() => null)
  return state
}

async function normalizeProviderError(message: string) {
  if (!/AI_ACADEMIC_PROVIDER_UNAVAILABLE|TEXT_AI_ROUTER|NO_PROVIDER|NOT_CONFIGURED|OPENAI_API_KEYS|OPENAI_API_KEY/i.test(message)) return message
  const diagnostics = await textAiDiagnostics().catch(() => null)
  if (!diagnostics?.openaiConfigured && /OPENAI|NO_PROVIDER|NOT_CONFIGURED/i.test(message)) return `${message} — OPENAI_API_KEYS غير موجود في هذه البيئة`
  return message
}

async function claimQuestionBankJob(id: string, stepDeadlineAt: number, now = new Date()) {
  const lockUntil = new Date(stepDeadlineAt + QUESTION_BANK_LOCK_GRACE_MS)
  const updated = await db.questionBankGenerationJob.updateMany({
    where: {
      id,
      status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      AND: [{ OR: [{ status: { not: 'PAUSED' } }, { retryAt: null }, { retryAt: { lte: now } }] }],
    },
    data: { status: 'RUNNING', startedAt: now, lockedUntil: lockUntil },
  })
  return updated.count === 1
}

async function scopedKnowledge(job: { programId: string; unitId: string | null }) {
  if (job.unitId) {
    const unit = await db.unit.findFirst({ where: { id: job.unitId, programId: job.programId }, select: { id: true, title: true, sourceBookId: true, chunkStartIndex: true, chunkEndIndex: true, semester: true } })
    if (!unit?.sourceBookId || unit.chunkStartIndex == null || unit.chunkEndIndex == null) throw new Error('UNIT_OUTLINE_SCOPE_REQUIRED')
    const chunks = await db.bookChunk.findMany({ where: { bookId: unit.sourceBookId, index: { gte: unit.chunkStartIndex, lte: unit.chunkEndIndex } }, orderBy: { index: 'asc' }, select: { id: true } })
    const chunkIds = chunks.map((chunk) => chunk.id)
    const knowledge = await db.bookKnowledgeItem.findMany({ where: { programId: job.programId, kbVersion: 2, chunkId: { in: chunkIds }, category: { notIn: ['QUESTION_SEED', 'LEGACY'] } }, orderBy: [{ importance: 'desc' }, { pageStart: 'asc' }], take: 120 })
    return { unit, knowledge, title: unit.title, scopeLabel: `الوحدة: ${unit.title}` }
  }
  const knowledge = await db.bookKnowledgeItem.findMany({ where: { programId: job.programId, kbVersion: 2, category: { notIn: ['QUESTION_SEED', 'LEGACY'] } }, orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }], take: 400 })
  return { unit: null, knowledge, title: 'بنك أسئلة البرنامج', scopeLabel: 'البرنامج كاملاً' }
}

function knowledgeToSource(item: { id: string; title: string; category: string; summary: string | null; excerpt: string | null; sourceNote: string | null; bookId: string | null; semester: number | null; pageStart: number | null; pageEnd: number | null }): QuestionBankSource {
  return { id: item.id, title: item.title, category: item.category, summary: item.summary, excerpt: item.excerpt, sourceNote: item.sourceNote, bookId: item.bookId, semester: item.semester, pageStart: item.pageStart, pageEnd: item.pageEnd }
}

export function hasSourceGroundedFlag(question: { qualityFlags?: string[] }) {
  return Array.isArray(question.qualityFlags) && question.qualityFlags.includes('SOURCE_GROUNDED')
}

export function nextQuestionBankRetryAt(now = Date.now(), retryMs = BOOK_READ_RETRY_MS) {
  return new Date(now + Math.min(retryMs, 60 * 60_000))
}

export function questionBankJobHasActiveLock(job: { status: string; lockedUntil?: Date | string | null }, now = Date.now()) {
  return job.status === 'RUNNING' && Boolean(job.lockedUntil) && new Date(job.lockedUntil as Date | string).getTime() > now
}

export function questionBankJobCanRunStep(job: { status: string; lockedUntil?: Date | string | null; retryAt?: Date | string | null; saved: number; requested: number; unitId?: string | null }, now = Date.now()) {
  const required = job.unitId ? unitExamRequiredQuestions(job.requested) : job.requested
  if (job.saved >= required) return false
  if (['COMPLETED', 'FAILED'].includes(job.status)) return false
  if (questionBankJobHasActiveLock(job, now)) return false
  if (job.status === 'PAUSED' && job.retryAt && new Date(job.retryAt).getTime() > now) return false
  return ['QUEUED', 'RUNNING', 'PAUSED'].includes(job.status)
}

async function generateBatch(job: { id: string; programId: string; unitId: string | null; requested: number; saved: number; batchSize: number }, deadlineMs?: number) {
  const program = await db.program.findUnique({ where: { id: job.programId }, select: { id: true, titleAr: true, category: true, description: true } })
  if (!program) throw new Error('PROGRAM_NOT_FOUND')
  const scope = await scopedKnowledge(job)
  const knowledge = scope.knowledge.map(knowledgeToSource).filter((item) => evidenceText(item).length >= 40)
  if (!knowledge.length) throw new Error(job.unitId ? 'UNIT_V2_KNOWLEDGE_REQUIRED' : 'PROGRAM_V2_KNOWLEDGE_REQUIRED')

  const cursor = await readJobCursor(job.id)
  const window = planQuestionBankSourceWindow(knowledge.length, cursor, Math.min(8, knowledge.length))
  const selected = window.indexes.map((index) => knowledge[index]).filter(Boolean)
  await saveJobCursor(job.id, window.nextCursor)
  if (!selected.length) throw new Error('QUESTION_BANK_JOB_NO_SOURCE_WINDOW')

  const existing = await db.questionBankItem.findMany({
    where: { programId: job.programId, knowledgeItemId: { in: knowledge.map((item) => item.id) } },
    select: { text: true, knowledgeItemId: true, bookId: true, sourceLocator: true },
  })
  const seen = new Set(existing.map((q) => questionDuplicateKey(q.text, q.knowledgeItemId || q.bookId || q.sourceLocator || 'UNKNOWN')))
  const ideaHistory = existing.map((q) => ({ text: q.text, knowledgeItemId: q.knowledgeItemId }))
  const existingBySource = new Map<string, string[]>()
  for (const question of existing) {
    if (!question.knowledgeItemId) continue
    const list = existingBySource.get(question.knowledgeItemId) || []
    if (list.length < 5) list.push(cleanText(question.text, 220))
    existingBySource.set(question.knowledgeItemId, list)
  }

  const evidenceSources = selected.map((item) => ({ text: evidenceText(item) }))
  const knowledgeText = selected.map((item, index) => {
    const existingQuestions = existingBySource.get(item.id) || []
    return `${index + 1}. [${item.category}] ${item.title}\nالصفحات: ${item.pageStart ?? '؟'}–${item.pageEnd ?? item.pageStart ?? '؟'}\nنص المصدر: ${evidenceText(item).slice(0, 1800)}\nأسئلة موجودة لنفس المصدر لا تكررها: ${existingQuestions.length ? existingQuestions.map((q) => `«${q}»`).join('؛ ') : 'لا يوجد'}`
  }).join('\n\n')
  const requiredForJob = job.unitId ? unitExamRequiredQuestions(job.requested) : job.requested
  const count = Math.min(4, job.batchSize || 4, Math.max(0, requiredForJob - job.saved))
  if (count <= 0) return 0
  const diversityInstruction = selected.length <= 3
    ? '\nعدد المصادر قليل؛ اختر جانباً مختلفاً من النص ونوع سؤال مختلفاً عن الأسئلة الموجودة قدر الإمكان، ولا تكرر زاوية السؤال أو نفس المهارة المعرفية.'
    : ''

  const raw = await textAiCompleteJsonWithMetadata({
    system: 'أنت مصمم أسئلة جامعية موثقة بالمصدر. أرجع JSON فقط.',
    history: [{ role: 'user', text: `أنشئ ${count} سؤالاً موثقاً لبنك الأسئلة.\nالبرنامج: ${program.titleAr}\nالنطاق: ${scope.scopeLabel}\n\nمصادر المعرفة المسموحة فقط:\n${knowledgeText}\n\nأرجع {"questions":[...]} ويجب أن يحتوي كل سؤال على: type=MCQ|TF|SHORT|ESSAY, text, options, correctAnswer, modelAnswer, sourceEvidence اقتباس حرفي من نص المصدر, sourceIndex رقم المصدر, difficulty, cognitiveSkill, correctRationale.\nاستخدم هالقيم بالإنجليزي بالضبط: cognitiveSkill واحدة من REMEMBER|UNDERSTAND|APPLY|ANALYZE|EVALUATE|CREATE، وdifficulty واحدة من EASY|MEDIUM|ADVANCED.\nاجعل الدفعة متنوعة، واحرص على سؤال قصير أو صح/خطأ عند الإمكان. لا تكرر أي سؤال موجود أعلاه، ولا تستخدم أي مصدر خارج القائمة.${diversityInstruction}` }],
    taskLevel: 'ACADEMIC_CRITICAL',
    routerPolicy: 'balanced',
    temperature: 0.2,
    maxOutputTokens: 5200,
    stickyScope: `QUESTION_BANK_JOB:${job.programId}:${job.unitId || 'PROGRAM'}`,
    deadlineMs: Math.min(deadlineMs || Date.now() + QUESTION_BANK_STEP_MS, Date.now() + QUESTION_BANK_STEP_MS),
    validate: (text) => { assertGeneratedBatchHasAcceptedCandidates(parseGeneratedQuestionCandidates(text)) },
  })
  if (raw.provider === 'OPENAI') console.warn('paid fallback used: OPENAI question bank generation')
  const parsed = parseGeneratedQuestionCandidates(raw.text)
  assertGeneratedBatchHasAcceptedCandidates(parsed)
  const validation = validateQuestionBatchAgainstKnowledge(parsed.accepted, evidenceSources, { provider: raw.provider, model: raw.model })
  const verified = await verifyQuestionsWithCrossProvider({ questions: validation.accepted, sources: evidenceSources, generatorProvider: raw.provider, generatorModel: raw.model, timeBudgetMs: 18_000 })
  const traceReasons: string[] = [...(parsed.rejectedReasons || []), ...validation.rejected.map((item) => item.reason)]
  const verifierRejected = verified.filter((item) => !hasSourceGroundedFlag(item))
  for (const item of verifierRejected) traceReasons.push(cleanText(item.verificationReason || item.verifierReason || 'VERIFIER_REJECTED', 220))
  const groundedQuestions = verified.filter(hasSourceGroundedFlag)

  const rows: Prisma.QuestionBankItemCreateManyInput[] = []
  for (const item of groundedQuestions) {
    const sourceIndex = Number(item.sourceIndex)
    if (!Number.isInteger(sourceIndex) || sourceIndex < 1 || sourceIndex > selected.length) { traceReasons.push('BAD_SOURCE_INDEX'); continue }
    const source = selected[sourceIndex - 1]
    const q = sanitizeQuestion(item, { title: source.title, summary: source.summary, excerpt: source.excerpt, sourceNote: source.sourceNote })
    if (!q.text || q.text.length < 12) { traceReasons.push('EMPTY_QUESTION_TEXT'); continue }
    if (!q.sourceEvidence) { traceReasons.push('SOURCE_EVIDENCE_REQUIRED'); continue }
    if (!q.cognitiveSkill) { traceReasons.push('COGNITIVE_SKILL_REQUIRED'); continue }
    if (!q.difficulty) { traceReasons.push('DIFFICULTY_REQUIRED'); continue }
    if (q.type === 'MCQ' && (!q.options || q.correctAnswer == null)) { traceReasons.push(prepareMcqOptionsForStorage(item.options, item.correctAnswer).reason || 'MCQ_ANSWER_NOT_IN_OPTIONS'); continue }
    const key = questionDuplicateKey(q.text, source.id)
    if (seen.has(key) || isDuplicateQuestionIdea(q.text, source.id, ideaHistory)) { traceReasons.push('DUPLICATE_QUESTION'); continue }
    seen.add(key)
    ideaHistory.push({ text: q.text, knowledgeItemId: source.id })
    rows.push({
      ...buildQuestionBankRecord({ ...q, qualityFlags: item.qualityFlags || [], verifierProvider: item.verifierProvider, verifierModel: item.verifierModel, verifiedAt: item.verifiedAt, verifierReason: item.verifierReason, verificationPending: item.verificationPending, verificationReason: item.verificationReason, textProvenance: item.textProvenance }, { programId: job.programId, knowledgeItemId: source.id, bookId: source.bookId || null, semester: source.semester || scope.unit?.semester || null, provider: raw.provider, model: raw.model }),
      unitId: job.unitId || null,
    } as Prisma.QuestionBankItemCreateManyInput)
    if (rows.length >= count) break
  }
  await saveJobTrace(job.id, {
    generated: parsed.accepted.length + parsed.rejected,
    saved: rows.length,
    verifierRejected: verifierRejected.length,
    rejected: traceReasons.length,
    rejectionReasons: reasonCounts(traceReasons),
    aiTrace: {
      generatorProvider: raw.provider,
      generatorModel: raw.model,
      verifierProvider: cleanText(verified.find((item) => item.verifierProvider)?.verifierProvider, 80) || null,
      verifierModel: cleanText(verified.find((item) => item.verifierModel)?.verifierModel, 160) || null,
      sameProviderVerifierFallback: raw.provider === 'OPENAI' && verified.some((item) => item.verifierProvider === 'OPENAI'),
    },
  })
  if (!rows.length) throw new Error('QUESTION_BANK_JOB_EMPTY_BATCH')
  await db.questionBankItem.createMany({ data: rows })
  return rows.length
}

export async function ensureQuestionBankGenerationJob(params: { programId: string; unitId?: string | null; requested?: number; startNew?: boolean; manual?: boolean }) {
  const requested = params.unitId ? unitExamRequiredQuestions(params.requested) : Math.max(1, Math.min(60, Number(params.requested || 12)))
  if (!params.startNew || params.manual) {
    const statuses = params.manual ? ['QUEUED', 'RUNNING', 'PAUSED', 'FAILED'] : ['QUEUED', 'RUNNING', 'PAUSED']
    const existing = await db.questionBankGenerationJob.findFirst({ where: { programId: params.programId, unitId: params.unitId || null, status: { in: statuses } }, orderBy: { createdAt: 'desc' } })
    if (existing) {
      const shouldReactivate = Boolean(params.manual) && ['PAUSED', 'FAILED'].includes(existing.status)
      if (params.unitId) {
        if (shouldReactivate) await resetJobFailureState(existing.id)
        if (shouldReactivate || existing.requested !== requested) {
          return db.questionBankGenerationJob.update({
            where: { id: existing.id },
            data: {
              requested,
              status: shouldReactivate ? 'QUEUED' : existing.status === 'PAUSED' ? 'QUEUED' : existing.status,
              retryAt: shouldReactivate ? null : existing.retryAt,
              lockedUntil: null,
              finishedAt: shouldReactivate ? null : existing.finishedAt,
            },
          })
        }
        return existing
      }
      const plan = planQuestionBankJobManualReactivation(existing, requested, Boolean(params.manual))
      if (plan.resetFailureCounter) await resetJobFailureState(existing.id)
      if (plan.shouldUpdate) {
        return db.questionBankGenerationJob.update({ where: { id: existing.id }, data: { requested: plan.requested, status: plan.status, retryAt: plan.retryAt, lockedUntil: null, finishedAt: plan.resetFailureCounter ? null : existing.finishedAt } })
      }
      return existing
    }
  }
  return db.questionBankGenerationJob.create({ data: { programId: params.programId, unitId: params.unitId || null, requested, batchSize: 4, sourceScope: params.unitId ? 'UNIT' : 'PROGRAM' } })
}

export async function runQuestionBankGenerationJobStep(jobId: string, deadlineMs?: number) {
  const now = new Date()
  const stepDeadlineAt = Math.min(deadlineMs || Date.now() + QUESTION_BANK_STEP_MS, Date.now() + QUESTION_BANK_STEP_MS)
  const claimed = await claimQuestionBankJob(jobId, stepDeadlineAt, now)
  if (!claimed) return db.questionBankGenerationJob.findUnique({ where: { id: jobId } })
  let job = await db.questionBankGenerationJob.findUnique({ where: { id: jobId } })
  if (!job) return null
  try {
    const inserted = await generateBatch(job, stepDeadlineAt - 2_000)
    await resetJobFailureState(jobId)
    let readyToBuild = false
    if (job.unitId) {
      const candidates = await db.questionBankItem.findMany({
        where: { programId: job.programId, unitId: job.unitId, qualityFlags: { contains: 'SOURCE_GROUNDED' }, status: { in: ['APPROVED', 'PENDING_REVIEW'] } },
        select: { id: true, status: true, qualityFlags: true },
        orderBy: [{ status: 'asc' }, { usageCount: 'asc' }, { createdAt: 'desc' }],
      })
      const requiredQuestions = unitExamRequiredQuestions(job.requested)
      readyToBuild = selectUnitExamQuestionsApprovedFirst(candidates, requiredQuestions).readyToBuild
    } else {
      readyToBuild = job.saved + inserted >= job.requested
    }
    await db.questionBankGenerationJob.updateMany({
      where: { id: jobId, status: { not: 'COMPLETED' } },
      data: { saved: { increment: inserted }, status: readyToBuild ? 'COMPLETED' : 'QUEUED', lockedUntil: null, retryAt: null, lastError: null, finishedAt: readyToBuild ? new Date() : null },
    })
    return db.questionBankGenerationJob.findUnique({ where: { id: jobId } })
  } catch (error: unknown) {
    const message = cleanText(await normalizeProviderError(error instanceof Error ? error.message : String(error)), 1000)
    const failure = await recordJobFailure(jobId, message)
    await saveJobTrace(jobId, { generated: 0, saved: 0, verifierRejected: 0, rejected: 1, rejectionReasons: reasonCounts([message]) })
    const paused = /AI_ACADEMIC_PROVIDER_UNAVAILABLE|TEXT_AI_ROUTER|DEADLINE|TIMEOUT|NO_PROVIDER|NOT_CONFIGURED|OPENAI_API_KEYS/i.test(message)
    const repeatedLimitReached = failure.count >= 3
    await db.questionBankGenerationJob.updateMany({
      where: { id: jobId, status: { not: 'COMPLETED' } },
      data: repeatedLimitReached
        ? { status: 'FAILED', retryAt: null, lockedUntil: null, lastError: `فشلت وظيفة بنك الأسئلة بعد 3 محاولات متتالية بنفس الخطأ: ${message}`.slice(0, 1000), finishedAt: new Date() }
        : paused
          ? { status: 'PAUSED', retryAt: nextQuestionBankRetryAt(), lockedUntil: null, lastError: message }
          : { status: 'FAILED', retryAt: null, lockedUntil: null, lastError: message, finishedAt: new Date() },
    })
    return db.questionBankGenerationJob.findUnique({ where: { id: jobId } })
  }
}

export async function runQuestionBankGenerationJobStepsUntil(jobId: string, options: { budgetMs?: number; maxSteps?: number } = {}) {
  const endAt = Date.now() + Math.max(5_000, Math.min(options.budgetMs || 260_000, 260_000))
  const maxSteps = Math.max(1, Math.min(options.maxSteps || 20, 20))
  let steps = 0
  let current = await db.questionBankGenerationJob.findUnique({ where: { id: jobId } })
  while (current && steps < maxSteps && Date.now() < endAt - 8_000 && questionBankJobCanRunStep(current)) {
    current = await runQuestionBankGenerationJobStep(jobId, Math.min(endAt - 5_000, Date.now() + QUESTION_BANK_STEP_MS))
    steps++
    if (!current || current.saved >= current.requested || ['COMPLETED', 'FAILED'].includes(current.status)) break
    if (questionBankJobHasActiveLock(current)) break
    if (current.status === 'PAUSED' && current.retryAt && new Date(current.retryAt).getTime() > Date.now()) break
  }
  return current
}

export async function runNextQuestionBankGenerationJobStep(programId?: string) {
  const now = new Date()
  const job = await db.questionBankGenerationJob.findFirst({
    where: {
      ...(programId ? { programId } : {}),
      OR: [
        { status: 'QUEUED' },
        { status: 'RUNNING', lockedUntil: { lt: now } },
        { status: 'PAUSED', retryAt: null },
        { status: 'PAUSED', retryAt: { lte: now } },
      ],
    },
    orderBy: [{ createdAt: 'asc' }],
  })
  return job ? runQuestionBankGenerationJobStep(job.id) : null
}
