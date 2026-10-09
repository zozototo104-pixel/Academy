import { z } from 'zod'

const commonQuestionFields = {
  text: z.string().min(12).max(1200),
  sourceEvidence: z.string().min(8).max(1800),
  sourceBookTitle: z.string().max(220).optional(),
  sourceLocator: z.string().max(220).optional(),
  cognitiveSkill: z.string().max(40).optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'ADVANCED']),
  sourceIndex: z.number().int().positive(),
  correctRationale: z.string().min(4).max(1000).optional(),
  distractorRationales: z.array(z.string().max(500)).max(6).default([]),
}
const optionSchema = z.string().min(1).max(260)
const generatedQuestionSchema = z.discriminatedUnion('type', [
  z.object({ ...commonQuestionFields, type: z.literal('MCQ'), options: z.array(optionSchema).length(4), correctAnswer: z.string().min(1).max(260), modelAnswer: z.string().max(1800).optional() }),
  z.object({ ...commonQuestionFields, type: z.literal('TF'), options: z.array(optionSchema).length(2), correctAnswer: z.enum(['صح', 'خطأ', '0', '1']), modelAnswer: z.string().max(1800).optional() }),
  z.object({ ...commonQuestionFields, type: z.literal('SHORT'), options: z.array(optionSchema).default([]), correctAnswer: z.string().max(260).optional(), modelAnswer: z.string().min(40).max(1800), rubric: z.unknown().optional() }),
  z.object({ ...commonQuestionFields, type: z.literal('ESSAY'), options: z.array(optionSchema).default([]), correctAnswer: z.string().max(260).optional(), modelAnswer: z.string().min(40).max(1800), rubric: z.unknown().optional() }),
]).superRefine((q, ctx) => {
  if (q.type !== 'MCQ') return
  if (new Set(q.options).size !== 4) ctx.addIssue({ code: 'custom', path: ['options'], message: 'MCQ options must be distinct' })
  if (!q.options.includes(q.correctAnswer) && !/^[0-3]$/.test(q.correctAnswer)) ctx.addIssue({ code: 'custom', path: ['correctAnswer'], message: 'MCQ answer must match an option or its index' })
})

function normalizeDifficulty(value: unknown): 'EASY' | 'MEDIUM' | 'ADVANCED' | unknown {
  const raw = String(value || '').trim()
  const normalized = raw
    .toLowerCase()
    .replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[-_\s]+/g, ' ')
  if (['easy', 'simple', 'basic', 'low', 'سهل', 'سهله', 'بسيط', 'بسيطه', 'اساسي', 'اساسيه', 'منخفض'].includes(normalized)) return 'EASY'
  if (['medium', 'moderate', 'normal', 'intermediate', 'متوسط', 'متوسطه', 'عادي', 'عاديه', 'معتدل', 'معتدله'].includes(normalized)) return 'MEDIUM'
  if (['advanced', 'hard', 'difficult', 'high', 'complex', 'متقدم', 'متقدمه', 'صعب', 'صعبه', 'عالي', 'عاليه', 'مركب', 'مركبه'].includes(normalized)) return 'ADVANCED'
  if (/easy|basic|simple/.test(normalized)) return 'EASY'
  if (/medium|moderate|intermediate/.test(normalized)) return 'MEDIUM'
  if (/advanced|hard|difficult|complex/.test(normalized)) return 'ADVANCED'
  return value
}

function normalizeCandidate(candidate: unknown): unknown {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
  const q: Record<string, unknown> = { ...(candidate as Record<string, unknown>) }
  const type = String(q.type || '').trim().toLowerCase()
  const aliases: Record<string, string> = { essay: 'ESSAY', 'مقالي': 'ESSAY', short_answer: 'SHORT', 'قصير': 'SHORT', true_false: 'TF', 'صح وخطأ': 'TF', 'صح/خطأ': 'TF', multiple_choice: 'MCQ', 'اختيار من متعدد': 'MCQ' }
  q.type = aliases[type] || type.toUpperCase()
  if (q.difficulty != null) q.difficulty = normalizeDifficulty(q.difficulty)
  for (const [key, value] of Object.entries(q)) {
    if (typeof value === 'string') q[key] = value.trim()
  }
  for (const key of ['options', 'distractorRationales']) {
    if (q[key] == null) q[key] = key === 'options' && q.type === 'TF' ? ['صح', 'خطأ'] : []
    else if (Array.isArray(q[key])) q[key] = q[key].map((v: unknown) => typeof v === 'string' ? v.trim() : v)
  }
  if (typeof q.correctAnswer === 'number') q.correctAnswer = String(q.correctAnswer)
  return q
}

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

function structuralReasonCode(issues: readonly z.ZodIssue[]): string {
  const field = (issues[0]?.path || []).map(String).join('.')
  if (field === 'sourceEvidence') return 'SOURCE_EVIDENCE_REQUIRED'
  if (field === 'difficulty') return 'DIFFICULTY_REQUIRED'
  if (field === 'cognitiveSkill') return 'COGNITIVE_SKILL_REQUIRED'
  if (field === 'options') return 'MCQ_REQUIRES_AT_LEAST_3_OPTIONS'
  return `STRUCTURAL_${(field || 'QUESTION').toUpperCase()}`
}

export function parseGeneratedQuestionCandidates(raw: string): { accepted: any[]; rejected: number; rejectedReasons: string[] } {
  const parsed = parseQuestionBatchEnvelope(raw)
  const accepted: any[] = []
  const rejectedReasons: string[] = []
  for (let index = 0; index < parsed.questions.length; index++) {
    const candidate = parsed.questions[index]
    const result = generatedQuestionSchema.safeParse(normalizeCandidate(candidate))
    if (result.success) accepted.push(result.data)
    else {
      rejectedReasons.push(structuralReasonCode(result.error.issues))
      console.warn(`question bank generated question rejected structurally: ${readableIssueSummary(candidate, index, result.error.issues)}`)
    }
  }
  return { accepted, rejected: rejectedReasons.length, rejectedReasons }
}
