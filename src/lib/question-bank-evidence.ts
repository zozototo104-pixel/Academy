import { sourceTextAtOneBasedIndex, validateLiteralEvidence } from './evidence-validator'

export function knowledgeEvidenceText(item: { excerpt?: unknown }): string {
  return String(item.excerpt ?? '')
}

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

function questionQualityFlags(question: Record<string, unknown>): string[] {
  return Array.isArray(question.qualityFlags) && question.qualityFlags.length
    ? question.qualityFlags.map(String).filter(Boolean)
    : ['SOURCE_LINKED', 'NEEDS_HUMAN_REVIEW']
}

function questionReviewNotes(question: Record<string, unknown>, context: { provider?: string; model?: string }): string {
  return JSON.stringify({
    aiProvenance: { provider: context.provider || null, model: context.model || null },
    source: { textProvenance: question.textProvenance || null },
    verifier: {
      provider: question.verifierProvider || null,
      model: question.verifierModel || null,
      verifiedAt: question.verifiedAt || null,
      reason: question.verifierReason || null,
      pending: question.verificationPending || false,
      pendingReason: question.verificationReason || null,
    },
  })
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
  const {
    qualityFlags,
    verifierProvider,
    verifierModel,
    verifiedAt,
    verifierReason,
    verificationPending,
    verificationReason,
    ...persistableQuestion
  } = question
  void qualityFlags
  void verifierProvider
  void verifierModel
  void verifiedAt
  void verifierReason
  void verificationPending
  void verificationReason
  return {
    programId: context.programId,
    knowledgeItemId: context.knowledgeItemId,
    bookId: context.bookId || null,
    semester: context.semester || null,
    ...persistableQuestion,
    qualityFlags: JSON.stringify(questionQualityFlags(question)),
    reviewNotes: questionReviewNotes(question, context),
    status: 'PENDING_REVIEW',
    generatedBy: 'AI',
  }
}
