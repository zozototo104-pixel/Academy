import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export type ExamAttemptKind = 'UNIT' | 'PROGRAM'

export const DEFAULT_EXAM_MAX_ATTEMPTS = 3

const MAX_REASONABLE_ATTEMPTS = 20

function parseMaxAttempts(value: unknown) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_EXAM_MAX_ATTEMPTS
  return Math.min(parsed, MAX_REASONABLE_ATTEMPTS)
}

export async function getExamMaxAttempts(kind: ExamAttemptKind, client: typeof db | Prisma.TransactionClient = db) {
  const keys = kind === 'PROGRAM'
    ? ['PROGRAM_EXAM_MAX_ATTEMPTS', 'EXAM_MAX_ATTEMPTS']
    : ['UNIT_EXAM_MAX_ATTEMPTS', 'EXAM_MAX_ATTEMPTS']

  const settings = await client.setting.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  })
  const byKey = new Map(settings.map((setting) => [setting.key, setting.value] as const))
  for (const key of keys) {
    if (byKey.has(key)) return parseMaxAttempts(byKey.get(key))
  }

  const envValue = kind === 'PROGRAM'
    ? process.env.AACT_PROGRAM_EXAM_MAX_ATTEMPTS || process.env.AACT_EXAM_MAX_ATTEMPTS
    : process.env.AACT_UNIT_EXAM_MAX_ATTEMPTS || process.env.AACT_EXAM_MAX_ATTEMPTS

  return parseMaxAttempts(envValue)
}

export function shouldRevealCorrectAnswers(input: { passed: boolean; completedAttempts: number; maxAttempts: number }) {
  return input.passed || input.completedAttempts >= input.maxAttempts
}
