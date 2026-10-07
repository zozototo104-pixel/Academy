import { sourceTextAtOneBasedIndex, validateLiteralEvidence } from './evidence-validator'

export type QuestionEvidenceRejectionReason = 'TOO_SHORT' | 'NOT_FOUND' | 'EMPTY' | 'BAD_INDEX'

export type QuestionEvidenceRejection = {
  index: number
  sourceIndex: number | string
  reason: QuestionEvidenceRejectionReason
  provider?: string
  model?: string
}

export function validateQuestionAgainstKnowledge<T extends { sourceIndex: number | string; sourceEvidence: string }>(
  question: T,
  knowledge: readonly { text: string }[]
): { ok: true; question: T } | { ok: false; reason: QuestionEvidenceRejectionReason } {
  const sourceText = sourceTextAtOneBasedIndex(knowledge, question.sourceIndex, (item) => item.text)
  if (sourceText === null) return { ok: false, reason: 'BAD_INDEX' }

  const result = validateLiteralEvidence({ evidence: question.sourceEvidence, sourceText })
  return result.ok ? { ok: true, question } : { ok: false, reason: result.reason }
}

export function validateQuestionBatchAgainstKnowledge<T extends { sourceIndex: number | string; sourceEvidence: string }>(
  questions: readonly T[],
  knowledge: readonly { text: string }[],
  context?: { provider?: string; model?: string }
): { accepted: T[]; rejected: QuestionEvidenceRejection[] } {
  const accepted: T[] = []
  const rejected: QuestionEvidenceRejection[] = []

  questions.forEach((question, index) => {
    const result = validateQuestionAgainstKnowledge(question, knowledge)
    if (result.ok) accepted.push(question)
    else rejected.push({ index, sourceIndex: question.sourceIndex, reason: result.reason, ...context })
  })

  return { accepted, rejected }
}

export function assertQuestionBatchAcceptable(total: number, rejected: number, accepted = total - rejected) {
  if (total === 0 || accepted === 0) {
    const error = new Error('Question evidence rejected: EMPTY_BATCH') as Error & { code?: string; reason?: string }
    error.code = 'VALIDATION_REJECTED'
    error.reason = 'EMPTY_BATCH'
    throw error
  }
  if (rejected / total > 0.5) {
    const error = new Error(`Question evidence rejected ${rejected}/${total}`) as Error & { code?: string; reason?: string }
    error.code = 'VALIDATION_REJECTED'
    error.reason = 'TOO_MANY_REJECTIONS'
    throw error
  }
}

export function buildQuestionBankRecord<T extends Record<string, unknown>>(
  question: T,
  context: {
    programId: string
    knowledgeItemId: string
    bookId?: string | null
    semester?: number | null
    provider?: string
    model?: string
  }
) {
  return {
    programId: context.programId,
    knowledgeItemId: context.knowledgeItemId,
    bookId: context.bookId || null,
    semester: context.semester || null,
    ...question,
    qualityFlags: JSON.stringify(['SOURCE_LINKED', 'NEEDS_HUMAN_REVIEW']),
    reviewNotes: JSON.stringify({ aiProvenance: { provider: context.provider || null, model: context.model || null } }),
    status: 'PENDING_REVIEW',
    generatedBy: 'AI',
  }
}
