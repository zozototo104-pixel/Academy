import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'

export interface FinalGradeComponent {
  key: string
  label: string
  weight: number
  score: number | null
  weighted: number
  ready: boolean
  exempt?: boolean
}

export interface FinalGradeResult {
  score: number | null
  components: FinalGradeComponent[]
  missing: string[]
}

type DbClient = typeof db | Prisma.TransactionClient

type ComponentScore = number | null | 'EXEMPT' | { score: number; complete: boolean }

type GradeWeights = Record<string, number>
const DEFAULT_WEIGHTS: Record<string, GradeWeights> = {
  DIPLOMA: { quizzes: 20, assignments: 20, final_exam: 60 },
  MASTERS: { semester1_quizzes: 10, semester1_exam: 15, semester2_quizzes: 10, semester2_exam: 15, thesis: 30, defense: 20 },
  DOCTORATE: { reading_quizzes: 8, reading_exam: 12, analysis_quizzes: 8, analysis_exam: 12, thesis: 40, defense: 20 },
}
const FORMULA_KEYS: Record<string, Record<string, string>> = {
  DIPLOMA: {
    'اختبارات قصيرة ومتابعة': 'quizzes',
    'واجبات أو أنشطة تطبيقية': 'assignments',
    'الاختبار النهائي': 'final_exam',
    'بحث تخرج': 'thesis',
  },
  MASTERS: {
    'اختبارات الفصل الأول القصيرة': 'semester1_quizzes',
    'امتحان الفصل الأول': 'semester1_exam',
    'اختبارات الفصل الثاني القصيرة': 'semester2_quizzes',
    'امتحان الفصل الثاني': 'semester2_exam',
    'بحث التخرج المهني': 'thesis',
    'المناقشة النهائية': 'defense',
  },
  DOCTORATE: {
    'اختبارات/تقارير القراءات المتقدمة': 'reading_quizzes',
    'اختبار مرحلة القراءات المتقدمة': 'reading_exam',
    'اختبارات/حالات التطبيق والتحليل': 'analysis_quizzes',
    'اختبار مرحلة التطبيق والتحليل': 'analysis_exam',
    'الأطروحة المهنية': 'thesis',
    'المناقشة النهائية': 'defense',
  },
}
/** A programme's published academic formula is authoritative only if complete and valid. */
export function resolveGradeWeights(category: string, admissionRules: unknown): {
  weights: GradeWeights
  source: 'academic_profile' | 'category_default'
  warning?: string
} {
  const defaults = DEFAULT_WEIGHTS[category] || DEFAULT_WEIGHTS.DIPLOMA
  const fallback = (warning?: string) => ({ weights: { ...defaults }, source: 'category_default' as const, ...(warning ? { warning } : {}) })
  if (!admissionRules || typeof admissionRules !== 'object' || Array.isArray(admissionRules)) return fallback()
  const formula = (admissionRules as Record<string, any>).academicProfile?.finalEvaluationFormula
  if (!Array.isArray(formula) || formula.length === 0) return fallback()
  const labels = FORMULA_KEYS[category]
  if (!labels) return fallback('ASSESSMENT_FORMULA_UNSUPPORTED_CATEGORY')
  const weights: GradeWeights = {}
  for (const row of formula) {
    const label = String(row?.label || '').replace(/\s+/g, ' ').trim()
    const key = labels[label]
    const weight = Number(row?.weight)
    if (!key || !Number.isFinite(weight) || weight <= 0 || weight > 100 || key in weights) return fallback('ASSESSMENT_FORMULA_INVALID')
    weights[key] = weight
  }
  if (Object.keys(defaults).some((key) => !(key in weights)) ||
      Math.abs(Object.values(weights).reduce((sum, n) => sum + n, 0) - 100) > 0.000001) {
    return fallback('ASSESSMENT_FORMULA_INVALID')
  }
  return { weights, source: 'academic_profile' }
}

type ScoredAnswer = { points: number | null; maxPoints: number | null }

function clampPercent(n: number) {
  return Math.max(0, Math.min(100, n))
}

function avg(values: Array<number | null | undefined>) {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function best(values: Array<number | null | undefined>) {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!nums.length) return null
  return Math.max(...nums)
}

function component(key: string, label: string, weight: number, score: ComponentScore): FinalGradeComponent {
  if (score === 'EXEMPT') {
    return { key, label, weight, score: null, weighted: 0, ready: true, exempt: true }
  }
  const ready = typeof score === 'number' && Number.isFinite(score)
  const rawScore = ready ? clampPercent(score) : null
  return {
    key,
    label,
    weight,
    // Raw percentage: certification decisions compare this unrounded value.
    score: rawScore,
    weighted: rawScore == null ? 0 : (rawScore * weight) / 100,
    ready,
  }
}

function percentFromAnswers(answers: ScoredAnswer[]) {
  const max = answers.reduce((sum, answer) => sum + Math.max(0, Number(answer.maxPoints || 0)), 0)
  if (max <= 0) return null
  const points = answers.reduce((sum, answer) => sum + Math.max(0, Number(answer.points || 0)), 0)
  return clampPercent((points / max) * 100)
}

function addMissing(missing: string[], label: string) {
  if (!missing.includes(label)) missing.push(label)
}

async function unitQuizAverage(client: DbClient, userId: string, programId: string, missing: string[], semester?: number) {
  const exams = await client.exam.findMany({
    where: { status: 'READY', unit: { programId, ...(semester ? { semester } : {}) } },
    select: { id: true, title: true, passScore: true, unit: { select: { title: true } }, _count: { select: { questions: true } } },
    orderBy: { unit: { order: 'asc' } },
  })
  if (!exams.length) {
    addMissing(missing, semester ? `اختبارات وحدات الفصل ${semester}` : 'اختبارات الوحدات المطلوبة')
    return null
  }
  const scorableExams = exams.filter((exam) => Number((exam as any)._count?.questions || 0) > 0)
  // Legacy READY unit exams with no published questions are ignored for certification eligibility:
  // they cannot be attempted, so they must not block graduation forever or inflate the final score.
  if (!scorableExams.length) return 'EXEMPT' as const

  const bestScores: number[] = []
  for (const exam of scorableExams) {
    const attempts = await client.examAttempt.findMany({
      where: { userId, examId: exam.id, status: 'GRADED', passed: true },
      select: { score: true, answers: { select: { points: true, maxPoints: true } } },
    })
    const bestAttemptScore = best(attempts.map((attempt) => percentFromAnswers(attempt.answers) ?? attempt.score))
    if (bestAttemptScore == null) addMissing(missing, `اختبار وحدة: ${exam.unit.title || exam.title}`)
    else bestScores.push(bestAttemptScore)
  }
  return bestScores.length === scorableExams.length ? avg(bestScores) : null
}

async function programExamAverage(client: DbClient, userId: string, programId: string, missing: string[], semester?: number) {
  const exams = await client.programExam.findMany({
    where: { programId, status: 'READY', ...(semester ? { semester } : {}) },
    select: { id: true, title: true, semester: true, passScore: true },
    orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
  })
  if (!exams.length) {
    addMissing(missing, semester ? `امتحان برنامج الفصل ${semester}` : 'امتحانات البرنامج المطلوبة')
    return null
  }

  const bestScores: number[] = []
  for (const exam of exams) {
    const attempts = await client.programExamAttempt.findMany({
      where: { userId, examId: exam.id, status: 'GRADED', passed: true, OR: [{ appealStatus: null }, { appealStatus: { not: 'PENDING' } }] },
      select: { score: true, finalScore: true, appealStatus: true },
    })
    const bestAttemptScore = best(attempts.map((attempt) => {
      if (attempt.appealStatus === 'REVIEWED' && typeof attempt.finalScore === 'number') return attempt.finalScore
      // العلامة المخزنة هي الرسمية للشهادة: سقف أعمال السنة انطبق عليها لحظة
      // التسليم (النسبة الخام محفوظة في rawScoreBeforeCourseworkCap للشفافية
      // فقط). إعادة الحساب من الإجابات الخام هنا كانت تتجاوز السقف بصمت.
      return attempt.finalScore ?? attempt.score
    }))
    if (bestAttemptScore == null) addMissing(missing, `امتحان البرنامج: ${exam.title}`)
    else bestScores.push(bestAttemptScore)
  }
  return bestScores.length === exams.length ? avg(bestScores) : null
}

async function assignmentAverage(client: DbClient, userId: string, programId: string, missing: string[], requiredForGrade: boolean) {
  const assignments = await client.programAssignment.findMany({
    where: { programId, status: 'PUBLISHED' },
    select: { id: true, title: true, points: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!assignments.length) {
    if (requiredForGrade) addMissing(missing, 'الواجبات المنشورة المصححة')
    return null
  }

  const scores: number[] = []
  for (const assignment of assignments) {
    const submission = await client.assignmentSubmission.findUnique({
      where: { assignmentId_userId: { assignmentId: assignment.id, userId } },
      select: { status: true, score: true },
    })
    if (!submission || submission.status !== 'GRADED' || typeof submission.score !== 'number') {
      addMissing(missing, `واجب منشور غير مصحح: ${assignment.title}`)
      continue
    }
    const points = Number(assignment.points || 0)
    scores.push(points > 0 ? clampPercent((submission.score / points) * 100) : clampPercent(submission.score))
  }
  return scores.length === assignments.length ? avg(scores) : null
}

async function thesisScores(client: DbClient, userId: string, admissionId?: string | null) {
  const thesis = await client.thesisSubmission.findFirst({
    where: admissionId ? { admissionId } : { userId },
    orderBy: { updatedAt: 'desc' },
    select: { status: true, resultScore: true, aiScore: true, passed: true, defenseStatus: true },
  })
  const approved = thesis?.status === 'RESULT_APPROVED' && thesis.passed === true && typeof thesis.resultScore === 'number'
  if (!approved) return { research: null as number | null, defense: null as number | null }
  const defense = clampPercent(thesis!.resultScore as number)
  const research = typeof thesis!.aiScore === 'number' ? clampPercent(thesis!.aiScore) : defense
  return { research, defense }
}

export async function calculateFinalGrade(input: {
  userId: string
  programId: string
  admissionId?: string | null
  client?: DbClient
}): Promise<FinalGradeResult> {
  const client = input.client || db
  const program = await client.program.findUnique({ where: { id: input.programId }, select: { category: true } })
  const category = program?.category || 'DIPLOMA'
  const missing: string[] = []

  // These global checks intentionally run for every credential path: certification requires all
  // published/ready required work, not only the weighted components displayed on the transcript.
  await unitQuizAverage(client, input.userId, input.programId, missing)
  await programExamAverage(client, input.userId, input.programId, missing)
  const assignmentsForGlobalRequirement = await assignmentAverage(client, input.userId, input.programId, missing, false)

  const thesis = await thesisScores(client, input.userId, input.admissionId)
  let components: FinalGradeComponent[]
  if (category === 'DOCTORATE') {
    components = [
      component('reading_quizzes', 'اختبارات/تقارير القراءات المتقدمة', 8, await unitQuizAverage(client, input.userId, input.programId, missing, 1)),
      component('reading_exam', 'اختبار مرحلة القراءات المتقدمة', 12, await programExamAverage(client, input.userId, input.programId, missing, 1)),
      component('analysis_quizzes', 'اختبارات/حالات التطبيق والتحليل', 8, await unitQuizAverage(client, input.userId, input.programId, missing, 2)),
      component('analysis_exam', 'اختبار مرحلة التطبيق والتحليل', 12, await programExamAverage(client, input.userId, input.programId, missing, 2)),
      component('thesis', 'الأطروحة المهنية', 40, thesis.research),
      component('defense', 'المناقشة النهائية', 20, thesis.defense),
    ]
  } else if (category === 'MASTERS') {
    components = [
      component('semester1_quizzes', 'اختبارات الفصل الأول القصيرة', 10, await unitQuizAverage(client, input.userId, input.programId, missing, 1)),
      component('semester1_exam', 'امتحان الفصل الأول', 15, await programExamAverage(client, input.userId, input.programId, missing, 1)),
      component('semester2_quizzes', 'اختبارات الفصل الثاني القصيرة', 10, await unitQuizAverage(client, input.userId, input.programId, missing, 2)),
      component('semester2_exam', 'امتحان الفصل الثاني', 15, await programExamAverage(client, input.userId, input.programId, missing, 2)),
      component('thesis', 'بحث التخرج المهني', 30, thesis.research),
      component('defense', 'المناقشة النهائية', 20, thesis.defense),
    ]
  } else {
    components = [
      component('quizzes', 'اختبارات قصيرة ومتابعة', 20, await unitQuizAverage(client, input.userId, input.programId, missing)),
      component('assignments', 'واجبات أو أنشطة تطبيقية', 20, assignmentsForGlobalRequirement ?? await assignmentAverage(client, input.userId, input.programId, missing, true)),
      component('final_exam', 'الاختبار النهائي', 60, await programExamAverage(client, input.userId, input.programId, missing)),
    ]
  }

  for (const c of components) {
    if (!c.ready && !c.exempt) addMissing(missing, c.label)
  }

  if (missing.length) return { score: null, components, missing }
  const activeComponents = components.filter((c) => !c.exempt && typeof c.score === 'number')
  const activeWeight = activeComponents.reduce((sum, c) => sum + c.weight, 0)
  if (activeWeight <= 0) return { score: null, components, missing }
  for (const c of components) {
    c.weighted = c.exempt || typeof c.score !== 'number' ? 0 : (c.score * c.weight) / activeWeight
  }
  return { score: activeComponents.reduce((sum, c) => sum + c.weighted, 0), components, missing }
}
