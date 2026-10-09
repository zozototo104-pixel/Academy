import { z } from 'zod'
import { textAiCompleteJson } from '@/lib/text-ai'

const DEFAULT_RUBRIC = 'الدقة مقابل المصدر 50%، الشمول 30%، الوضوح والتنظيم 20%.'

const gradingSchema = z.object({
  criteria: z.array(z.object({
    name: z.string().min(2).max(120),
    weight: z.number().min(0).max(100),
    score0to10: z.number().min(0).max(10),
    comment: z.string().min(1).max(500),
  })).min(1).max(8),
  points: z.number().optional(),
  feedback: z.string().min(1).max(1200),
  confidence: z.enum(['HIGH', 'LOW']),
})

export type EssayCriterionGrade = z.infer<typeof gradingSchema>['criteria'][number]
export type EssayGradeResult = { criteria: EssayCriterionGrade[]; points: number; feedback: string; confidence: 'HIGH' | 'LOW'; rubric: string }

function extractJson(text: string) {
  const trimmed = String(text || '').trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1] : trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start >= 0 && end >= start) return candidate.slice(start, end + 1)
  return candidate
}

export function effectiveRubric(rubric?: string | null) {
  const value = String(rubric || '').replace(/\s+/g, ' ').trim()
  return value || DEFAULT_RUBRIC
}

export function clampPoints(value: number, maxPoints: number) {
  const max = Math.max(0, Number(maxPoints || 0))
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(max, value))
}

export function pointsFromCriteria(criteria: EssayCriterionGrade[], maxPoints: number) {
  const totalWeight = criteria.reduce((sum, item) => sum + Math.max(0, Number(item.weight || 0)), 0)
  if (totalWeight <= 0) return 0
  const weighted = criteria.reduce((sum, item) => sum + (Math.max(0, Math.min(100, item.weight)) / totalWeight) * Math.max(0, Math.min(10, item.score0to10)), 0)
  const clamped = clampPoints((weighted / 10) * Math.max(0, maxPoints), maxPoints)
  return Math.round(clamped * 100) / 100
}

export function parseEssayGradeJson(raw: string, maxPoints: number, rubric?: string | null): EssayGradeResult {
  const parsed = gradingSchema.parse(JSON.parse(extractJson(raw)))
  const points = pointsFromCriteria(parsed.criteria, maxPoints)
  return { criteria: parsed.criteria, points, feedback: parsed.feedback, confidence: parsed.confidence, rubric: effectiveRubric(rubric) }
}

export async function gradeEssayWithRubric(args: {
  question: string
  modelAnswer?: string | null
  rubric?: string | null
  sourceExcerpt?: string | null
  studentAnswer: string
  maxPoints: number
}): Promise<EssayGradeResult> {
  const rubric = effectiveRubric(args.rubric)
  const sourceExcerpt = String(args.sourceExcerpt || '').replace(/\s+/g, ' ').trim().slice(0, 3000)
  const modelAnswer = String(args.modelAnswer || '').replace(/\s+/g, ' ').trim().slice(0, 2500)
  const studentAnswer = String(args.studentAnswer || '').replace(/\s+/g, ' ').trim().slice(0, 5000)
  const question = String(args.question || '').replace(/\s+/g, ' ').trim().slice(0, 1200)
  const raw = await textAiCompleteJson({
    taskLevel: 'ACADEMIC_CRITICAL',
    routerPolicy: 'quality_first',
    temperature: 0.1,
    maxOutputTokens: 1800,
    system: 'أنت مصحح أكاديمي صارم. صحح فقط مقابل المصدر والإجابة النموذجية والروبرك. لا تكافئ أي معلومة خارج المصدر، ولا تضف معرفة عامة. أرجع JSON فقط.',
    history: [{ role: 'user', text: `السؤال:\n${question}\n\nالمصدر المعتمد:\n${sourceExcerpt || 'غير متوفر'}\n\nالإجابة النموذجية:\n${modelAnswer || 'غير متوفرة'}\n\nالروبرك:\n${rubric}\n\nإجابة الطالب:\n${studentAnswer}\n\nأرجع JSON بهذا الشكل فقط: {"criteria":[{"name":"...","weight":50,"score0to10":0,"comment":"..."}],"points":0,"feedback":"...","confidence":"HIGH" أو "LOW"}` }],
  })
  return parseEssayGradeJson(raw, args.maxPoints, rubric)
}
