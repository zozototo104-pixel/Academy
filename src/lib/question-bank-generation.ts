import { z } from 'zod'

const generatedQuestionSchema = z.object({
  type: z.enum(['MCQ', 'TF', 'SHORT', 'ESSAY']),
  text: z.string().min(12).max(1200),
  options: z.array(z.string().min(1).max(260)).max(6).default([]),
  correctAnswer: z.string().min(1).max(20),
  modelAnswer: z.string().max(1800).optional(),
  sourceEvidence: z.string().min(8).max(1800),
  sourceBookTitle: z.string().max(220).optional(),
  sourceLocator: z.string().max(220).optional(),
  cognitiveSkill: z.string().max(40).optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'ADVANCED']),
  sourceIndex: z.number().int().positive(),
  correctRationale: z.string().min(4).max(1000),
  distractorRationales: z.array(z.string().max(500)).max(6).optional(),
}).superRefine((question, ctx) => {
  if (question.type === 'MCQ') {
    if (question.options.length < 3) ctx.addIssue({ code: 'custom', message: 'MCQ requires at least three options' })
    const answer = Number(question.correctAnswer)
    if (!Number.isInteger(answer) || answer < 0 || answer >= question.options.length) ctx.addIssue({ code: 'custom', message: 'MCQ correctAnswer must point to an option' })
  }
  if (question.type === 'TF' && !['0', '1'].includes(question.correctAnswer)) ctx.addIssue({ code: 'custom', message: 'TF correctAnswer must be 0 or 1' })
})

const looseGeneratedQuestionsSchema = z.object({ questions: z.array(z.unknown()).min(1).max(30) })

function parseJsonValue(raw: string): unknown {
  const text = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try {
    return JSON.parse(text)
  } catch (error) {
    console.warn('Failed to parse question bank AI JSON directly; trying fenced extraction.', error)
  }
  const objectStart = text.indexOf('{')
  const objectEnd = text.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) return JSON.parse(text.slice(objectStart, objectEnd + 1))
  const arrayStart = text.indexOf('[')
  const arrayEnd = text.lastIndexOf(']')
  if (arrayStart >= 0 && arrayEnd > arrayStart) return JSON.parse(text.slice(arrayStart, arrayEnd + 1))
  throw new Error('INVALID_JSON')
}

export function parseQuestionBatchEnvelope(raw: string): { questions: unknown[] } {
  const parsed = parseJsonValue(raw)
  if (Array.isArray(parsed)) return { questions: parsed }
  return looseGeneratedQuestionsSchema.parse(parsed)
}

function candidateText(candidate: unknown): string {
  if (candidate && typeof candidate === 'object' && 'text' in candidate) return String((candidate as { text?: unknown }).text || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return String(candidate || '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

function readableIssueSummary(candidate: unknown, index: number, issues: readonly z.ZodIssue[]): string {
  const issue = issues[0]
  const field = (issue?.path || []).map(String).join('.') || 'question'
  const code = issue?.code || 'invalid'
  const reason = issue?.message || 'غير صالح'
  const type = candidate && typeof candidate === 'object' && 'type' in candidate ? String((candidate as { type?: unknown }).type || 'UNKNOWN') : 'UNKNOWN'
  return `index=${index} type=${type} field=${field} code=${code} reason="${reason}" question="${candidateText(candidate)}"`
}

export function parseGeneratedQuestionCandidates(raw: string): { accepted: any[]; rejected: number } {
  const parsed = parseQuestionBatchEnvelope(raw)
  const accepted: any[] = []
  let rejected = 0
  for (let index = 0; index < parsed.questions.length; index++) {
    const candidate = parsed.questions[index]
    const result = generatedQuestionSchema.safeParse(candidate)
    if (result.success) accepted.push(result.data)
    else {
      rejected += 1
      console.warn(`question bank generated question rejected structurally: ${readableIssueSummary(candidate, index, result.error.issues)}`)
    }
  }
  return { accepted, rejected }
}
