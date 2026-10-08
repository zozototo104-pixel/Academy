import { db } from '@/lib/db'
import { BOOK_READ_LOCK_MS, BOOK_READ_RETRY_MS } from '@/lib/book-read-job-control'
import { textAiCompleteJsonWithMetadata } from '@/lib/text-ai'
import { parseGeneratedQuestionCandidates } from '@/lib/question-bank-generation'
import { assertQuestionBatchAcceptable, buildQuestionBankRecord, validateQuestionBatchAgainstKnowledge } from '@/lib/question-bank-evidence'
import { verifyQuestionsWithCrossProvider } from '@/lib/question-verifier'
import { questionDuplicateKey } from '@/lib/ai-generation-progress'
import { isDuplicateQuestionIdea } from '@/lib/question-bank-diversity'

const TYPES = new Set(['MCQ', 'TF', 'SHORT', 'ESSAY'])
const DIFFICULTIES = new Set(['EASY', 'MEDIUM', 'ADVANCED'])

function cleanText(value: unknown, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function safeOptions(value: unknown, type: string) {
  const arr = Array.isArray(value) ? value : []
  const options = arr.map((x) => cleanText(x, 260)).filter(Boolean).slice(0, 6)
  if (type === 'TF') return ['صح', 'خطأ']
  if (type === 'MCQ') return options.length >= 3 ? options.slice(0, 4) : ['خيار أول', 'خيار ثانٍ', 'خيار ثالث', 'خيار رابع']
  return []
}

function sanitizeQuestion(raw: any, fallback: any = {}) {
  const type = TYPES.has(String(raw?.type || '').toUpperCase()) ? String(raw.type).toUpperCase() : 'MCQ'
  const difficulty = DIFFICULTIES.has(String(raw?.difficulty || '').toUpperCase()) ? String(raw.difficulty).toUpperCase() : 'MEDIUM'
  const text = cleanText(raw?.text || raw?.question || fallback.title, 1200)
  const options = safeOptions(raw?.options, type)
  let correctAnswer = raw?.correctAnswer != null ? String(raw.correctAnswer) : null
  if (type === 'MCQ' && correctAnswer != null && Number.isNaN(Number(correctAnswer))) {
    const idx = options.findIndex((option) => cleanText(option, 260) === cleanText(correctAnswer, 260))
    correctAnswer = idx >= 0 ? String(idx) : null
  }
  if (correctAnswer != null && Number.isNaN(Number(correctAnswer))) correctAnswer = null
  if (type === 'MCQ' && correctAnswer != null) correctAnswer = String(Math.max(0, Math.min(options.length - 1, Number(correctAnswer))))
  if (type === 'TF' && correctAnswer != null && !['0', '1'].includes(correctAnswer)) correctAnswer = /^صح|true$/iu.test(correctAnswer) ? '0' : /^خطأ|false$/iu.test(correctAnswer) ? '1' : null
  return {
    type,
    text,
    options: options.length ? JSON.stringify(options) : null,
    correctAnswer: type === 'MCQ' || type === 'TF' ? correctAnswer : null,
    modelAnswer: type === 'SHORT' || type === 'ESSAY' ? cleanText(raw?.modelAnswer || raw?.answer || fallback.summary, 1800) : cleanText(raw?.modelAnswer || '', 1200) || null,
    sourceEvidence: cleanText(raw?.sourceEvidence || fallback.excerpt || fallback.summary, 1800) || null,
    sourceBookTitle: cleanText(raw?.sourceBookTitle || fallback.sourceBookTitle, 220) || null,
    sourceLocator: cleanText(raw?.sourceLocator || fallback.title, 220) || null,
    cognitiveSkill: cleanText(raw?.cognitiveSkill || 'UNDERSTAND', 40) || 'UNDERSTAND',
    difficulty,
    correctRationale: cleanText(raw?.correctRationale || raw?.rationale, 1000) || null,
    distractorRationales: raw?.distractorRationales ? JSON.stringify(raw.distractorRationales).slice(0, 1800) : null,
    qualityFlags: raw?.qualityFlags || JSON.stringify(['SOURCE_LINKED', 'SOURCE_GROUNDED', 'NEEDS_HUMAN_REVIEW']),
    sourceIndex: raw?.sourceIndex,
  }
}

function evidenceText(item: { excerpt?: string | null; summary?: string | null }) {
  return cleanText(item.excerpt || item.summary, 2200)
}

async function claimQuestionBankJob(id: string, now = new Date()) {
  const updated = await db.questionBankGenerationJob.updateMany({
    where: {
      id,
      status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      AND: [{ OR: [{ status: { not: 'PAUSED' } }, { retryAt: null }, { retryAt: { lte: now } }] }],
    },
    data: { status: 'RUNNING', startedAt: now, lockedUntil: new Date(now.getTime() + BOOK_READ_LOCK_MS) },
  })
  return updated.count === 1
}

async function scopedKnowledge(job: { programId: string; unitId: string | null }) {
  if (job.unitId) {
    const unit = await db.unit.findFirst({ where: { id: job.unitId, programId: job.programId }, select: { id: true, title: true, sourceBookId: true, chunkStartIndex: true, chunkEndIndex: true, semester: true } })
    if (!unit?.sourceBookId || unit.chunkStartIndex == null || unit.chunkEndIndex == null) throw new Error('UNIT_OUTLINE_SCOPE_REQUIRED')
    const chunks = await db.bookChunk.findMany({ where: { bookId: unit.sourceBookId, index: { gte: unit.chunkStartIndex, lte: unit.chunkEndIndex } }, orderBy: { index: 'asc' }, select: { id: true, index: true, pageStart: true, pageEnd: true } })
    const chunkIds = chunks.map((chunk) => chunk.id)
    const knowledge = await db.bookKnowledgeItem.findMany({ where: { programId: job.programId, kbVersion: 2, chunkId: { in: chunkIds }, category: { notIn: ['QUESTION_SEED', 'LEGACY'] } }, orderBy: [{ importance: 'desc' }, { pageStart: 'asc' }], take: 120 })
    return { unit, knowledge, title: unit.title, scopeLabel: `الوحدة: ${unit.title}` }
  }
  const knowledge = await db.bookKnowledgeItem.findMany({ where: { programId: job.programId, kbVersion: 2, category: { notIn: ['QUESTION_SEED', 'LEGACY'] } }, orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }], take: 400 })
  return { unit: null, knowledge, title: 'بنك أسئلة البرنامج', scopeLabel: 'البرنامج كاملاً' }
}

async function generateBatch(job: { id: string; programId: string; unitId: string | null; requested: number; saved: number; batchSize: number }) {
  const program = await db.program.findUnique({ where: { id: job.programId }, select: { id: true, titleAr: true, category: true, description: true } })
  if (!program) throw new Error('PROGRAM_NOT_FOUND')
  const scope = await scopedKnowledge(job)
  const knowledge = scope.knowledge.filter((item) => evidenceText(item).length >= 40)
  if (!knowledge.length) throw new Error(job.unitId ? 'UNIT_V2_KNOWLEDGE_REQUIRED' : 'PROGRAM_V2_KNOWLEDGE_REQUIRED')
  const existing = await db.questionBankItem.findMany({ where: { programId: job.programId, ...(job.unitId ? { knowledgeItemId: { in: knowledge.map((item) => item.id) } } : {}) }, select: { text: true, knowledgeItemId: true, bookId: true, sourceLocator: true } })
  const seen = new Set(existing.map((q) => questionDuplicateKey(q.text, q.knowledgeItemId || q.bookId || q.sourceLocator || 'UNKNOWN')))
  const ideaHistory = existing.map((q) => ({ text: q.text, knowledgeItemId: q.knowledgeItemId }))
  const selected = knowledge.slice(job.saved % Math.max(1, knowledge.length)).concat(knowledge.slice(0, job.saved % Math.max(1, knowledge.length))).slice(0, Math.min(8, knowledge.length))
  const evidenceSources = selected.map((item) => ({ text: evidenceText(item) }))
  const knowledgeText = selected.map((item, index) => `${index + 1}. [${item.category}] ${item.title}\nالصفحات: ${item.pageStart ?? '؟'}–${item.pageEnd ?? item.pageStart ?? '؟'}\nنص المصدر: ${evidenceText(item).slice(0, 1800)}`).join('\n\n')
  const count = Math.min(4, job.batchSize || 4, Math.max(0, job.requested - job.saved))
  if (count <= 0) return 0
  const raw = await textAiCompleteJsonWithMetadata({
    system: 'أنت مصمم أسئلة جامعية موثقة بالمصدر. أرجع JSON فقط.',
    history: [{ role: 'user', text: `أنشئ ${count} سؤالاً موثقاً لبنك الأسئلة.\nالبرنامج: ${program.titleAr}\nالنطاق: ${scope.scopeLabel}\n\nمصادر المعرفة المسموحة فقط:\n${knowledgeText}\n\nأرجع {"questions":[...]} ويجب أن يحتوي كل سؤال على: type=MCQ|TF|SHORT|ESSAY, text, options, correctAnswer, modelAnswer, sourceEvidence اقتباس حرفي من نص المصدر, sourceIndex رقم المصدر, difficulty, cognitiveSkill, correctRationale.\nاجعل الدفعة متنوعة، واحرص على سؤال قصير أو صح/خطأ عند الإمكان. لا تستخدم أي مصدر خارج القائمة.` }],
    taskLevel: 'ACADEMIC_CRITICAL',
    routerPolicy: 'balanced',
    temperature: 0.2,
    maxOutputTokens: 5200,
    stickyScope: `QUESTION_BANK_JOB:${job.programId}:${job.unitId || 'PROGRAM'}`,
    deadlineMs: Date.now() + 220_000,
    validate: (text, context) => {
      const parsed = parseGeneratedQuestionCandidates(text)
      const validation = validateQuestionBatchAgainstKnowledge(parsed.accepted, evidenceSources, context)
      assertQuestionBatchAcceptable(parsed.accepted.length + parsed.rejected, validation.rejected.length + parsed.rejected.length, validation.accepted.length)
    },
  })
  if (raw.provider === 'OPENAI') console.warn('paid fallback used: OPENAI question bank generation')
  const parsed = parseGeneratedQuestionCandidates(raw.text)
  const validation = validateQuestionBatchAgainstKnowledge(parsed.accepted, evidenceSources, { provider: raw.provider, model: raw.model })
  const verified = await verifyQuestionsWithCrossProvider({ questions: validation.accepted, sources: evidenceSources, generatorProvider: raw.provider, generatorModel: raw.model })
  const rows: any[] = []
  for (const item of verified) {
    const sourceIndex = Number(item.sourceIndex)
    if (!Number.isInteger(sourceIndex) || sourceIndex < 1 || sourceIndex > selected.length) continue
    const source = selected[sourceIndex - 1]
    const q = sanitizeQuestion(item, { title: source.title, summary: source.summary, excerpt: source.excerpt, sourceBookTitle: source.sourceNote })
    if (!q.text || q.text.length < 12) continue
    const key = questionDuplicateKey(q.text, source.id)
    if (seen.has(key) || isDuplicateQuestionIdea(q.text, source.id, ideaHistory)) continue
    seen.add(key)
    ideaHistory.push({ text: q.text, knowledgeItemId: source.id })
    rows.push({
      ...buildQuestionBankRecord({ ...q, qualityFlags: ['SOURCE_LINKED', 'SOURCE_GROUNDED', ...(item.verificationPending ? ['NEEDS_REVIEW'] : [])], verifierProvider: item.verifierProvider, verifierModel: item.verifierModel, verifiedAt: item.verifiedAt, verifierReason: item.verifierReason, verificationPending: item.verificationPending, verificationReason: item.verificationReason, textProvenance: item.textProvenance }, { programId: job.programId, knowledgeItemId: source.id, bookId: source.bookId || null, semester: source.semester || scope.unit?.semester || null, provider: raw.provider, model: raw.model }),
      unitId: job.unitId || null,
    })
    if (rows.length >= count) break
  }
  if (!rows.length) throw new Error('QUESTION_BANK_JOB_EMPTY_BATCH')
  await db.questionBankItem.createMany({ data: rows })
  return rows.length
}

export async function ensureQuestionBankGenerationJob(params: { programId: string; unitId?: string | null; requested?: number; startNew?: boolean }) {
  const requested = Math.max(1, Math.min(60, Number(params.requested || 12)))
  if (!params.startNew) {
    const existing = await db.questionBankGenerationJob.findFirst({ where: { programId: params.programId, unitId: params.unitId || null, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
    if (existing) return existing
  }
  return db.questionBankGenerationJob.create({ data: { programId: params.programId, unitId: params.unitId || null, requested, batchSize: 4, sourceScope: params.unitId ? 'UNIT' : 'PROGRAM' } })
}

export async function runQuestionBankGenerationJobStep(jobId: string) {
  const now = new Date()
  const claimed = await claimQuestionBankJob(jobId, now)
  if (!claimed) return db.questionBankGenerationJob.findUnique({ where: { id: jobId } })
  let job = await db.questionBankGenerationJob.findUnique({ where: { id: jobId } })
  if (!job) return null
  try {
    const inserted = await generateBatch(job)
    job = await db.questionBankGenerationJob.update({ where: { id: jobId }, data: { saved: { increment: inserted }, status: job.saved + inserted >= job.requested ? 'COMPLETED' : 'QUEUED', lockedUntil: null, lastError: null, finishedAt: job.saved + inserted >= job.requested ? new Date() : null } })
    return job
  } catch (error: any) {
    const message = String(error?.message || error)
    const paused = /AI_ACADEMIC_PROVIDER_UNAVAILABLE|TEXT_AI_ROUTER|DEADLINE|TIMEOUT|NO_PROVIDER|NOT_CONFIGURED/i.test(message)
    return db.questionBankGenerationJob.update({ where: { id: jobId }, data: paused ? { status: 'PAUSED', retryAt: new Date(Date.now() + BOOK_READ_RETRY_MS), lockedUntil: null, lastError: message.slice(0, 1000) } : { status: 'FAILED', lockedUntil: null, lastError: message.slice(0, 1000), finishedAt: new Date() } })
  }
}

export async function runNextQuestionBankGenerationJobStep(programId?: string) {
  const now = new Date()
  const job = await db.questionBankGenerationJob.findFirst({
    where: { ...(programId ? { programId } : {}), status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] }, OR: [{ retryAt: null }, { retryAt: { lte: now } }] },
    orderBy: [{ createdAt: 'asc' }],
  })
  return job ? runQuestionBankGenerationJobStep(job.id) : null
}
