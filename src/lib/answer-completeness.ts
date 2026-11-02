// Grading completeness: an attempt may only be finalized (approved by an
// admin or re-scored by a supervisor) when EVERY answer carries points.
// Answers are persisted with points = null first and filled in during
// grading; an interrupted grading run therefore leaves some answers
// ungraded. Treating a null as zero at approval time would silently fail
// a student on questions they may have answered correctly, so finalizing
// paths must refuse while any answer is still ungraded — for every
// question type, not only essay/short ones.

export interface UngradedAnswerRef {
  id: string
  type: string
}

export function findUngradedAnswers(
  rows: Array<{ id: string; points: number | null; question?: { type?: string | null } | null }>,
): UngradedAnswerRef[] {
  return rows
    .filter((row) => row.points == null)
    .map((row) => ({ id: row.id, type: row.question?.type || 'UNKNOWN' }))
}

// Coverage is the other half of completeness: an answer can only be
// graded if its ROW exists. Approval recomputes the score over the
// exam's required questions, so a required question with no answer row
// at all would silently score zero. Required = every question of a unit
// exam; for a program exam, every PUBLISHED question (the denominator
// approval uses).
export function findMissingAnswerQuestionIds(
  requiredQuestionIds: string[],
  answers: Array<{ questionId: string }>,
): string[] {
  const answered = new Set(answers.map((a) => a.questionId))
  return requiredQuestionIds.filter((id) => !answered.has(id))
}

// A set of question IDs is not enough to establish integrity: two rows for
// the same question could be counted twice in the numerator. Reject these
// attempts at approval rather than silently choosing one answer/grade.
export function findDuplicateAnswerQuestionIds(
  answers: Array<{ questionId: string }>,
): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const answer of answers) {
    if (seen.has(answer.questionId)) duplicates.add(answer.questionId)
    seen.add(answer.questionId)
  }
  return [...duplicates]
}

// Historical answers for questions no longer eligible (e.g. a REJECTED
// program question) must never increase the numerator of a grade whose
// denominator includes PUBLISHED questions only.
export function sumRequiredAnswerPoints(
  requiredQuestionIds: string[],
  answers: Array<{ questionId: string; points: number | null }>,
): number {
  const eligibleIds = new Set(requiredQuestionIds)
  return answers.reduce((total, answer) =>
    eligibleIds.has(answer.questionId) ? total + Number(answer.points ?? 0) : total, 0)
}

// Deterministic grading for objective questions (MCQ / TF), mirroring
// the submit-time logic exactly: the stored selectedOption index is
// compared with the question's approved correctAnswer index. Returns
// null when the answer key itself is incomplete — the admin must fix
// the key rather than have the question graded by guesswork.
export function parseObjectiveOptions(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

export function parseObjectiveIndex(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : null
}

export function gradeObjectiveAnswer(input: {
  optionsRaw: string | null | undefined
  correctAnswerRaw: string | null | undefined
  selectedOption: number | null | undefined
  maxPoints: number
}): { points: number; isCorrect: boolean; correctAnswerText: string } | null {
  const options = parseObjectiveOptions(input.optionsRaw)
  const correctIndex = parseObjectiveIndex(input.correctAnswerRaw)
  if (correctIndex === null || !options[correctIndex]) return null
  const isCorrect = input.selectedOption !== null && input.selectedOption !== undefined && input.selectedOption === correctIndex
  return {
    points: isCorrect ? input.maxPoints : 0,
    isCorrect,
    correctAnswerText: options[correctIndex],
  }
}
