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
