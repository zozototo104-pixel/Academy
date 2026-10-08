export type UnitExamBankCandidate = {
  id: string
  status: string
  qualityFlags?: string | null
}

export type UnitExamSelection = {
  selectedIds: string[]
  approvedCount: number
  pendingReviewCount: number
  rejectedCount: number
  currentEligibleCount: number
  readyToBuild: boolean
  publishable: boolean
}

export const UNIT_EXAM_REVIEW_LABEL = 'يحتاج مراجعة'

export function unitExamQualityFlags(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return value.split(/[,|\s]+/).map((item) => item.trim()).filter(Boolean)
  }
}

export function isSourceGroundedQuestion(candidate: UnitExamBankCandidate) {
  return unitExamQualityFlags(candidate.qualityFlags).includes('SOURCE_GROUNDED')
}

export function isApprovedQuestion(candidate: UnitExamBankCandidate) {
  return candidate.status === 'APPROVED' && isSourceGroundedQuestion(candidate)
}

export function isPendingReviewQuestion(candidate: UnitExamBankCandidate) {
  return candidate.status === 'PENDING_REVIEW' && isSourceGroundedQuestion(candidate)
}

export function selectUnitExamQuestionsApprovedFirst(candidates: UnitExamBankCandidate[], required: number): UnitExamSelection {
  const target = Math.max(1, Math.floor(required))
  const rejectedCount = candidates.filter((candidate) => candidate.status === 'REJECTED').length
  const approved = candidates.filter(isApprovedQuestion)
  const pending = candidates.filter(isPendingReviewQuestion)
  const selected = [...approved, ...pending].slice(0, target)
  const pendingReviewCount = selected.filter(isPendingReviewQuestion).length
  const approvedCount = selected.filter(isApprovedQuestion).length
  return {
    selectedIds: selected.map((candidate) => candidate.id),
    approvedCount,
    pendingReviewCount,
    rejectedCount,
    currentEligibleCount: approved.length + pending.length,
    readyToBuild: selected.length >= target,
    publishable: pendingReviewCount === 0 && selected.length >= target,
  }
}

export function countUnitExamQuestionsNeedingReview(questions: Array<{ text: string }>) {
  return questions.filter((question) => question.text.includes(UNIT_EXAM_REVIEW_LABEL)).length
}

export function canPublishUnitExamFromQuestions(questions: Array<{ text: string }>) {
  return countUnitExamQuestionsNeedingReview(questions) === 0
}

export function unitExamQuestionTextWithReviewLabel(text: string, needsReview: boolean) {
  const cleaned = String(text || '').trim()
  if (!needsReview) return cleaned
  return cleaned.includes(UNIT_EXAM_REVIEW_LABEL) ? cleaned : `【${UNIT_EXAM_REVIEW_LABEL}】 ${cleaned}`
}
