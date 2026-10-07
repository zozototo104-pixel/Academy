import { z } from 'zod'
import { normalizeArabic } from './arabic-normalize'
import type { ExamSourceChunk } from './exam-source-chunks'
import { validateQuestionBatchAgainstKnowledge } from './question-bank-evidence'

export type CognitiveSkill = 'UNDERSTAND' | 'APPLY' | 'ANALYZE' | 'EVALUATE'
export type QuestionDifficulty = 'EASY' | 'MEDIUM' | 'ADVANCED'
export type ExamGenerationProviderContext = { provider?: string; model?: string }
export type ComprehensiveExamValidationStage = 'ZOD' | 'EVIDENCE'

export type ComprehensiveExamRejection = {
  index: number
  stage: ComprehensiveExamValidationStage
  reason: string
  zodPath?: string
}

export type ComprehensiveExamValidationError = Error & {
  code?: string
  reason?: string
  rejected?: ComprehensiveExamRejection[]
}

export type ComprehensiveExamInsufficientSourceDetails = {
  availableChunks: number
  requestedQuestions: number
  acceptedQuestions: number
}

export type ComprehensiveExamInsufficientSourceError = Error & ComprehensiveExamInsufficientSourceDetails & {
  code: 'INSUFFICIENT_SOURCE'
}

export function formatComprehensiveExamInsufficientSourceMessage(details: ComprehensiveExamInsufficientSourceDetails): string {
  return `مصادر الكتاب غير كافية لتوليد ${details.requestedQuestions} سؤالًا موثّقًا (المتاح: ${details.availableChunks} مقطعًا، المقبول: ${details.acceptedQuestions})`
}

export function throwComprehensiveExamInsufficientSource(details: ComprehensiveExamInsufficientSourceDetails): never {
  const error = new Error(formatComprehensiveExamInsufficientSourceMessage(details)) as ComprehensiveExamInsufficientSourceError
  error.code = 'INSUFFICIENT_SOURCE'
  error.availableChunks = details.availableChunks
  error.requestedQuestions = details.requestedQuestions
  error.acceptedQuestions = details.acceptedQuestions
  throw error
}

export function assertComprehensiveExamSourceSufficient(details: ComprehensiveExamInsufficientSourceDetails): void {
  if (details.availableChunks < details.requestedQuestions || details.acceptedQuestions < details.requestedQuestions) {
    throwComprehensiveExamInsufficientSource(details)
  }
}

export interface GeneratedComprehensiveExamQuestion {
  type: 'MCQ' | 'TF' | 'SHORT' | 'ESSAY'
  text: string
  options?: string[]
  correct?: string
  modelAnswer?: string
  points?: number
  bookEvidence?: string
  sourceEvidence?: string
  sourceIndex?: number | string
  sourceBookId?: string
  sourceBookTitle?: string
  sourceChapter?: string
  sourceLocator?: string
  sourceProvider?: string
  sourceModel?: string
  cognitiveSkill?: CognitiveSkill
  difficulty?: QuestionDifficulty
  correctRationale?: string
  qualityFlags?: string[]
}

const sourceIndexSchema = z.union([z.number().int().positive(), z.string().regex(/^\d+$/u)])

function compact(value: unknown, max = 1000): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function norm(value: unknown): string {
  return normalizeArabic(value)
}

function normalizeEnumValue(value: unknown): string {
  return String(value ?? '').trim().replace(/[\s-]+/g, '_').toUpperCase()
}

function normalizeType(value: unknown): unknown {
  const type = normalizeEnumValue(value)
  if (type === 'TRUE_FALSE' || type === 'TRUEFALSE' || type === 'BOOL' || type === 'BOOLEAN') return 'TF'
  return type || value
}

function normalizeDifficulty(value: unknown): unknown {
  const difficulty = normalizeEnumValue(value)
  if (difficulty === 'ADVANCED' || difficulty === 'HARD') return 'ADVANCED'
  if (difficulty === 'MEDIUM' || difficulty === 'MODERATE') return 'MEDIUM'
  if (difficulty === 'EASY' || difficulty === 'BASIC') return 'EASY'
  return difficulty || value
}

function normalizeSkill(value: unknown): unknown {
  const skill = normalizeEnumValue(value)
  if (skill === 'UNDERSTANDING') return 'UNDERSTAND'
  if (skill === 'APPLICATION') return 'APPLY'
  if (skill === 'ANALYSIS') return 'ANALYZE'
  if (skill === 'EVALUATION') return 'EVALUATE'
  return skill || value
}

function sanitizeQuestionText(value: unknown, max = 2000): string {
  return compact(value, max)
    .replace(/\b(?:CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY)\b\s*(?:\|[^\n]+)?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function uniqueStrings(values: unknown[], limit = 16, max = 260): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const text = compact(value, max)
    const key = norm(text)
    if (!text || !key || seen.has(key)) continue
    seen.add(key)
    out.push(text)
    if (out.length >= limit) break
  }
  return out
}

function hasForbiddenExamMetadata(value: unknown): boolean {
  const raw = String(value || '')
  const n = norm(raw)
  return (
    /\[\s*(?:CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY)\s*(?:\|[^\]]*)?\]/i.test(raw) ||
    /\b(?:CONCEPT|THEORY|METHOD|CASE|DEFINITION|QUESTION_SEED|SUMMARY)\b\s*\|/i.test(raw) ||
    n.includes('رابط الكتاب') ||
    n.includes('مصدره') ||
    n.includes('عنوان الكتاب') ||
    n.includes('بنك المعرفه الاكاديمي') ||
    n.includes('contentquality') ||
    n.includes('source note') ||
    n.includes('sourcenote') ||
    n.includes('google com search') ||
    n.includes('books google')
  )
}

function correctionIndexFromAnswer(options: string[], correctAnswer: unknown): string | null {
  if (typeof correctAnswer === 'number' && Number.isInteger(correctAnswer) && correctAnswer >= 0 && correctAnswer < options.length) {
    return String(correctAnswer)
  }
  const answer = compact(correctAnswer, 260)
  if (!answer) return null
  const index = options.findIndex((option) => norm(option) === norm(answer))
  return index >= 0 ? String(index) : null
}

function selectedChunkAt(chunks: readonly ExamSourceChunk[], sourceIndex: number | string): ExamSourceChunk | null {
  const index = typeof sourceIndex === 'string' ? Number(sourceIndex.trim()) : sourceIndex
  if (!Number.isInteger(index) || index < 1 || index > chunks.length) return null
  return chunks[index - 1] || null
}

function normalizeRawQuestion(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const item = raw as Record<string, unknown>
  return {
    ...item,
    type: normalizeType(item.type),
    difficulty: normalizeDifficulty(item.difficulty),
    cognitiveSkill: item.cognitiveSkill == null ? item.cognitiveSkill : normalizeSkill(item.cognitiveSkill),
    rationale: item.rationale ?? item.correctRationale,
    correctAnswer: item.correctAnswer ?? item.correct,
  }
}

const generatedExamQuestionSchema = z.object({
  type: z.enum(['MCQ', 'CASE_MCQ', 'TF', 'SHORT', 'ESSAY']),
  text: z.string().min(8),
  options: z.array(z.string()).optional(),
  correctAnswer: z.union([z.string(), z.number()]).optional(),
  correct: z.union([z.string(), z.number()]).optional(),
  sourceIndex: sourceIndexSchema,
  sourceEvidence: z.string().min(40),
  difficulty: z.enum(['EASY', 'MEDIUM', 'ADVANCED']),
  cognitiveSkill: z.enum(['UNDERSTAND', 'APPLY', 'ANALYZE', 'EVALUATE']).optional(),
  rationale: z.string().min(12),
  correctRationale: z.string().optional(),
  modelAnswer: z.string().optional(),
  sourceChapter: z.string().optional(),
  sourceLocator: z.string().optional(),
  points: z.union([z.number(), z.string()]).optional(),
}).passthrough().superRefine((item, ctx) => {
  const type = item.type === 'CASE_MCQ' ? 'MCQ' : item.type
  if (type === 'MCQ') {
    const options = item.options || []
    if (options.length !== 4 || new Set(options.map((option) => norm(option))).size !== 4) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'MCQ_REQUIRES_FOUR_DISTINCT_OPTIONS' })
    }
    if (correctionIndexFromAnswer(options, item.correctAnswer) == null) {
      ctx.addIssue({ code: 'custom', path: ['correctAnswer'], message: 'MCQ_CORRECT_ANSWER_MUST_MATCH_OPTION' })
    }
  } else if (type === 'TF') {
    if (correctionIndexFromAnswer(['صح', 'خطأ'], item.correctAnswer) == null) {
      ctx.addIssue({ code: 'custom', path: ['correctAnswer'], message: 'TF_CORRECT_ANSWER_MUST_BE_TRUE_OR_FALSE' })
    }
  }
})

type GeneratedExamQuestionInput = z.infer<typeof generatedExamQuestionSchema>

type ParseResult =
  | { ok: true; question: GeneratedComprehensiveExamQuestion }
  | { ok: false; rejection: ComprehensiveExamRejection }

function firstZodRejection(index: number, error: z.ZodError): ComprehensiveExamRejection {
  const issue = error.issues[0]
  return {
    index,
    stage: 'ZOD',
    reason: issue?.code ?? 'INVALID_QUESTION_SHAPE',
    zodPath: (issue?.path ?? []).map(String).join('.') || undefined,
  }
}

function zodRejection(index: number, reason: string, zodPath?: string): ComprehensiveExamRejection {
  return { index, stage: 'ZOD', reason, zodPath }
}

function evidenceRejection(index: number, reason: string): ComprehensiveExamRejection {
  return { index, stage: 'EVIDENCE', reason }
}

function validationRejected(reason: string, rejected: ComprehensiveExamRejection[] = []): never {
  const error = new Error(`Question evidence rejected: ${reason}`) as ComprehensiveExamValidationError
  error.code = 'VALIDATION_REJECTED'
  error.reason = reason
  error.rejected = rejected
  throw error
}

function parseModelQuestionForSelectedChunks(
  raw: unknown,
  rawIndex: number,
  selectedChunks: readonly ExamSourceChunk[],
  context: ExamGenerationProviderContext = {}
): ParseResult {
  const parsed = generatedExamQuestionSchema.safeParse(normalizeRawQuestion(raw))
  if (!parsed.success) return { ok: false, rejection: firstZodRejection(rawIndex, parsed.error) }

  const item: GeneratedExamQuestionInput = parsed.data
  const chunk = selectedChunkAt(selectedChunks, item.sourceIndex)
  if (!chunk) return { ok: false, rejection: evidenceRejection(rawIndex, 'BAD_INDEX') }

  const rawType = item.type === 'CASE_MCQ' ? 'MCQ' : item.type
  const text = sanitizeQuestionText(item.text, 2000)
  const sourceEvidence = compact(item.sourceEvidence, 900)
  const rationale = sanitizeQuestionText(item.rationale || item.correctRationale || '', 900)
  const modelAnswerBase = sanitizeQuestionText(item.modelAnswer || '', 3000)
  if (!text) return { ok: false, rejection: zodRejection(rawIndex, 'EMPTY_TEXT', 'text') }
  if (!sourceEvidence) return { ok: false, rejection: zodRejection(rawIndex, 'EMPTY_SOURCE_EVIDENCE', 'sourceEvidence') }
  if (hasForbiddenExamMetadata(`${text} ${sourceEvidence} ${modelAnswerBase}`)) {
    return { ok: false, rejection: zodRejection(rawIndex, 'FORBIDDEN_METADATA') }
  }

  const common = {
    text,
    modelAnswer: modelAnswerBase.includes('مرجع التصحيح')
      ? modelAnswerBase
      : `مرجع التصحيح: ${sourceEvidence}${modelAnswerBase ? ` — ${modelAnswerBase}` : rationale ? ` — ${rationale}` : ''}`,
    bookEvidence: sourceEvidence,
    sourceEvidence,
    sourceIndex: item.sourceIndex,
    sourceBookId: chunk.bookId,
    sourceBookTitle: chunk.bookTitle,
    sourceLocator: sanitizeQuestionText(item.sourceLocator || '', 320) || `المصدر [${item.sourceIndex}] من كتاب «${chunk.bookTitle}»`,
    sourceChapter: sanitizeQuestionText(item.sourceChapter || '', 160) || undefined,
    sourceProvider: context.provider,
    sourceModel: context.model,
    cognitiveSkill: item.cognitiveSkill,
    difficulty: item.difficulty,
    correctRationale: rationale,
    qualityFlags: ['SOURCE_LINKED', 'NEEDS_HUMAN_REVIEW'],
  }

  let question: GeneratedComprehensiveExamQuestion | null = null
  if (rawType === 'MCQ') {
    const options = (item.options || []).map((option) => sanitizeQuestionText(option, 260)).filter(Boolean).slice(0, 4)
    const correct = correctionIndexFromAnswer(options, item.correctAnswer)
    if (options.length !== 4 || new Set(options.map((option) => norm(option))).size !== 4) {
      return { ok: false, rejection: zodRejection(rawIndex, 'MCQ_REQUIRES_FOUR_DISTINCT_OPTIONS', 'options') }
    }
    if (correct == null) return { ok: false, rejection: zodRejection(rawIndex, 'MCQ_CORRECT_ANSWER_MUST_MATCH_OPTION', 'correctAnswer') }
    question = { ...common, type: 'MCQ', options, correct, points: 2 }
  } else if (rawType === 'TF') {
    const correct = correctionIndexFromAnswer(['صح', 'خطأ'], item.correctAnswer)
    if (correct == null) return { ok: false, rejection: zodRejection(rawIndex, 'TF_CORRECT_ANSWER_MUST_BE_TRUE_OR_FALSE', 'correctAnswer') }
    question = { ...common, type: 'TF', options: ['صح', 'خطأ'], correct, points: 2 }
  } else if (rawType === 'SHORT' || rawType === 'ESSAY') {
    question = { ...common, type: rawType, points: Number(item.points) || (rawType === 'ESSAY' ? 10 : 5) }
  }

  if (!question) return { ok: false, rejection: zodRejection(rawIndex, 'UNSUPPORTED_QUESTION_TYPE', 'type') }
  question.qualityFlags = uniqueStrings([
    'SOURCE_LINKED',
    'NEEDS_HUMAN_REVIEW',
    question.sourceBookTitle ? 'HAS_SOURCE_BOOK' : '',
    question.sourceLocator ? 'HAS_SOURCE_LOCATOR' : '',
    question.difficulty ? `DIFFICULTY_${question.difficulty}` : '',
  ], 16, 90)
  return { ok: true, question }
}

function extractJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim()
  try {
    const direct = JSON.parse(trimmed)
    if (Array.isArray(direct)) return direct
  } catch {
    // Fall through to extracting the first JSON array from provider text.
  }
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) {
    const parsed = JSON.parse(trimmed.slice(start, end + 1))
    if (Array.isArray(parsed)) return parsed
  }
  throw new Error('INVALID_JSON')
}

export function validateGeneratedExamQuestionsAgainstSelectedChunks(
  raw: string | unknown[],
  selectedChunks: readonly ExamSourceChunk[],
  specKind = 'MIX_CORE',
  context: ExamGenerationProviderContext = {}
): GeneratedComprehensiveExamQuestion[] {
  void specKind
  if (!selectedChunks.length) validationRejected('NO_SELECTED_SOURCE_CHUNKS')
  let rawItems: unknown[]
  try {
    rawItems = Array.isArray(raw) ? raw : extractJsonArray(String(raw || ''))
  } catch {
    validationRejected('INVALID_JSON')
  }

  const parsedEntries: { rawIndex: number; question: GeneratedComprehensiveExamQuestion }[] = []
  const rejected: ComprehensiveExamRejection[] = []
  rawItems.forEach((item, index) => {
    const result = parseModelQuestionForSelectedChunks(item, index, selectedChunks, context)
    if (result.ok) parsedEntries.push({ rawIndex: index, question: result.question })
    else rejected.push(result.rejection)
  })

  const validationItems = parsedEntries.map(({ question }) => ({
    question,
    sourceIndex: question.sourceIndex ?? '',
    sourceEvidence: question.sourceEvidence || question.bookEvidence || '',
  }))
  const validated = validateQuestionBatchAgainstKnowledge(validationItems, selectedChunks, context)
  for (const item of validated.rejected) {
    rejected.push({
      index: parsedEntries[item.index]?.rawIndex ?? item.index,
      stage: 'EVIDENCE',
      reason: item.reason,
    })
  }

  if (rawItems.length === 0 || validated.accepted.length === 0) {
    validationRejected('EMPTY_BATCH', rejected)
  }
  if (rejected.length / rawItems.length > 0.5) {
    validationRejected('TOO_MANY_REJECTIONS', rejected)
  }

  return validated.accepted.map((item) => item.question)
}
