import { db } from '@/lib/db'
import { shouldRevealCorrectAnswers } from '@/lib/exam-attempt-policy'

// Supervisor-assessment attempt policy (owner decision 2026-10-30): the
// platform exam policy applied to supervisor assessments — at most 3
// attempts (setting SUPERVISOR_ASSESSMENT_MAX_ATTEMPTS, hard cap 20), a
// passed student does not resubmit, correct answers stay hidden in grading
// feedback until the student passes or exhausts the attempts, and the
// assessment duration (durationMin) is enforced from the server clock via
// an attempt window opened when the student presses «بدء التقييم».

export const DEFAULT_ASSESSMENT_MAX_ATTEMPTS = 3
const MAX_REASONABLE_ATTEMPTS = 20
export const ASSESSMENT_DURATION_GRACE_MS = 60_000
export const ASSESSMENT_MAX_WINDOW_RESTARTS = 1

function parseMaxAttempts(value: unknown) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_ASSESSMENT_MAX_ATTEMPTS
  return Math.min(parsed, MAX_REASONABLE_ATTEMPTS)
}

export async function getAssessmentMaxAttempts(client: any = db): Promise<number> {
  try {
    const row = await client.setting.findFirst({
      where: { key: 'SUPERVISOR_ASSESSMENT_MAX_ATTEMPTS' },
      select: { value: true },
    })
    if (row) return parseMaxAttempts(row.value)
  } catch {
    // fall through to env/default
  }
  return parseMaxAttempts(process.env.AACT_SUPERVISOR_ASSESSMENT_MAX_ATTEMPTS)
}

export type AssessmentAttemptPolicy = {
  maxAttempts: number
  completedAttempts: number
  passed: boolean
  reveal: boolean
  attemptsLeft: number
  canAttempt: boolean
}

export function buildAssessmentPolicy(input: {
  maxAttempts: number
  completedAttempts: number
  passed: boolean
}): AssessmentAttemptPolicy {
  const { maxAttempts, completedAttempts, passed } = input
  return {
    maxAttempts,
    completedAttempts,
    passed,
    reveal: shouldRevealCorrectAnswers({ passed, completedAttempts, maxAttempts }),
    attemptsLeft: Math.max(0, maxAttempts - completedAttempts),
    canAttempt: !passed && completedAttempts < maxAttempts,
  }
}

export async function loadAssessmentPolicy(
  assessmentId: string,
  studentId: string,
  client: any = db,
): Promise<AssessmentAttemptPolicy> {
  const maxAttempts = await getAssessmentMaxAttempts(client)
  let rows: { passed: boolean | null }[] = []
  try {
    if (client.supervisorAssessmentAttempt?.findMany) {
      rows = await client.supervisorAssessmentAttempt.findMany({
        where: { assessmentId, studentId },
        select: { passed: true },
      })
    }
  } catch {
    rows = []
  }
  return buildAssessmentPolicy({
    maxAttempts,
    completedAttempts: rows.length,
    passed: rows.some((r) => r.passed === true),
  })
}

// Removes explicit correct-answer giveaways from grading feedback text that
// a student may see while answers must stay hidden (the deterministic
// «الإجابة الصحيحة: …» segment and any «الإجابة النموذجية: …» restatement).
// Staff views never pass through here.
export function hideCorrectAnswersInFeedback(text: string | null | undefined): string | null {
  if (text == null) return text ?? null
  let out = String(text)
  out = out.replace(/الإجابة الصحيحة\s*[:：]\s*[^.。\n]*/g, 'الإجابة الصحيحة محجوبة حتى تنهي محاولاتك')
  out = out.replace(/الإجابة النموذجية\s*[:：]\s*[^.。\n]*/g, 'الإجابة النموذجية محجوبة حتى تنهي محاولاتك')
  return out
}

export function assessmentWindowEndsAt(startedAt: Date | string, durationMin: number): Date {
  return new Date(new Date(startedAt).getTime() + Math.max(0, durationMin) * 60_000)
}

export function isAssessmentWindowExpired(startedAt: Date | string, durationMin: number, now = new Date()): boolean {
  if (!durationMin || durationMin <= 0) return false
  return now.getTime() > assessmentWindowEndsAt(startedAt, durationMin).getTime() + ASSESSMENT_DURATION_GRACE_MS
}
