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

export function assertQuestionBatchAcceptable(total: number, rejected: number) {
  if (total > 0 && rejected / total > 0.5) {
    const error = new Error(`Question evidence rejected ${rejected}/${total}`) as Error & { code?: string }
    error.code = 'VALIDATION_REJECTED'
    throw error
  }
}
