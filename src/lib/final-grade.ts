import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { gradingFormulaSignature } from '@/lib/program-tracks'

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
  progressScore: number
  components: FinalGradeComponent[]
  missing: string[]
  weightSource: 'academic_profile' | 'category_default'
  weightWarning?: string
}

type DbClient = typeof db | Prisma.TransactionClient

type ComponentScore = number | null | 'EXEMPT' | { score: number; complete: boolean }

// Both Answer and ProgramAnswer expose the same selected scoring fields in Prisma.
// Keep this small structural type shared by percentFromAnswers and exam score recovery.
type ScoredAnswer = {
  points: number | null
  maxPoints: number | null
}

type GradeWeights = Record<string, number>
const DEFAULT_WEIGHTS: Record<string, GradeWeights> = {
  DIPLOMA: { quizzes: 20, assignments: 20, final_exam: 60 },
  MASTERS: { semester1_quizzes: 10, semester1_exam: 15, semester2_quizzes: 10, semester2_exam: 15, thesis: 30, defense: 20 },
  DOCTORATE: { reading_quizzes: 8, reading_exam: 12, analysis_quizzes: 8, analysis_exam: 12, thesis: 40, defense: 20 },
}
const ALLOWED_COMPONENT_KEYS: Record<string, string[]> = {
  DIPLOMA: ['quizzes', 'assignments', 'final_exam', 'thesis'],
  MASTERS: ['semester1_quizzes', 'semester1_exam', 'semester2_quizzes', 'semester2_exam', 'thesis', 'defense'],
  DOCTORATE: ['reading_quizzes', 'reading_exam', 'analysis_quizzes', 'analysis_exam', 'thesis', 'defense'],
}

/** Text labels are never used to select a grade component.
 * Existing free-text admission formulas remain informational until explicitly mapped and approved.
 */
export function resolveGradeWeights(category: string, admissionRules: unknown): {
  weights: GradeWeights
  source: 'academic_profile' | 'category_default'
  warning?: string
} {
  const defaults = DEFAULT_WEIGHTS[category] || DEFAULT_WEIGHTS.DIPLOMA
  const fallback = (warning?: string) => ({
    weights: { ...defaults }, source: 'category_default' as const, ...(warning ? { warning } : {}),
  })
  if (!admissionRules || typeof admissionRules !== 'object' || Array.isArray(admissionRules)) return fallback()
  const profile = (admissionRules as Record<string, any>).academicProfile
  const formula = profile?.finalEvaluationFormula
  if (!Array.isArray(formula) || formula.length === 0) return fallback()
  const allowed = ALLOWED_COMPONENT_KEYS[category]
  if (!allowed) return fallback('ASSESSMENT_FORMULA_UNSUPPORTED_CATEGORY')
  const weights: GradeWeights = {}
  for (const row of formula) {
    const key = String(row?.key || '')
    const value = Number(row?.weight)
    if (!allowed.includes(key) || key in weights || !Number.isFinite(value) || value <= 0 || value > 100) {
      return fallback('ASSESSMENT_FORMULA_MAPPING_REQUIRED')
    }
    weights[key] = value
  }
  if (Object.keys(defaults).some((key) => !(key in weights)) ||
      Math.abs(Object.values(weights).reduce((sum, n) => sum + n, 0) - 100) > 0.000001) {
    return fallback('ASSESSMENT_FORMULA_INVALID')
  }
  const approved = profile?.approvedFormulaSignature
  const approvedAt = Date.parse(String(profile?.approvedFormulaAt || ''))
  if (typeof approved !== 'string' || approved !== gradingFormulaSignature(formula) || !Number.isFinite(approvedAt)) {
    return fallback('ASSESSMENT_FORMULA_AWAITING_APPROVAL')
  }
  return { weights, source: 'academic_profile' }
}

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

function component(key: string, label: string, weight: number, value: ComponentScore): FinalGradeComponent {
  if (value === 'EXEMPT') return { key, label, weight, score: null, weighted: 0, ready: true, exempt: true }
  const complete = typeof value === 'number' || (value !== null && typeof value === 'object' && value.complete)
  const numberScore = typeof value === 'number' ? value : value && typeof value === 'object' ? value.score : null
  const score = typeof numberScore === 'number' && Number.isFinite(numberScore) ? clampPercent(numberScore) : null
  return { key, label, weight, score, weighted: score == null ? 0 : score * weight / 100, ready: complete }
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

async function unitQuizAverage(client: DbClient, userId: string, programId: string, missing: string[], semester?: number): Promise<ComponentScore> {
  const exams = await client.exam.findMany({
    where: { status: 'READY', unit: { programId, ...(semester ? { semester } : {}) } },
    select: { id: true, title: true, passScore: true, unit: { select: { title: true } }, _count: { select: { questions: true } } },
    orderBy: { unit: { order: 'asc' } },
  })
  if (!exams.length) {
    addMissing(missing, semester ? `اختبارات وحدات الفصل ${semester}` : 'اختبارات الوحدات المطلوبة')
    return null
  }
  const scorable = exams.filter((e) => Number(e._count?.questions || 0) > 0)
  if (!scorable.length) return 'EXEMPT'
  const earned: number[] = []
  let complete = true
  for (const exam of scorable) {
    const attempts = await client.examAttempt.findMany({
      where: { userId, examId: exam.id, status: 'GRADED' },
      select: { score: true, passed: true, answers: { select: { points: true, maxPoints: true } } },
    })
    const scores = attempts.map((a) => percentFromAnswers(a.answers) ?? a.score)
    earned.push(best(scores) ?? 0)
    if (!attempts.some((a, i) => a.passed === true && scores[i] !== null)) {
      addMissing(missing, `اختبار وحدة: ${exam.unit.title || exam.title}`)
      complete = false
    }
  }
  // All required quizzes occupy their original slots; missing quizzes count as zero, not a smaller denominator.
  const percent = avg(earned) ?? 0
  return complete ? percent : { score: percent, complete: false }
}

function rawProgramAttemptScore(attempt: {
  score: number | null
  finalScore?: number | null
  appealStatus?: string | null
  feedback?: string | null
  answers?: ScoredAnswer[]
}): number | null {
  // A manually resolved appeal is a separate, explicit final exam decision.
  if (attempt.appealStatus === 'REVIEWED' && typeof attempt.finalScore === 'number') return clampPercent(attempt.finalScore)
  let storedRaw: unknown = null
  try {
    storedRaw = JSON.parse(attempt.feedback || '{}')?.rawScoreBeforeCourseworkCap
  } catch {
    // Historical free-form feedback; prefer original answer points when available.
  }
  if (storedRaw !== null && storedRaw !== undefined && storedRaw !== '' && Number.isFinite(Number(storedRaw))) {
    return clampPercent(Number(storedRaw))
  }
  return (attempt.answers?.length ? percentFromAnswers(attempt.answers) : null) ?? attempt.finalScore ?? attempt.score
}

async function programExamAverage(client: DbClient, userId: string, programId: string, missing: string[], semester?: number): Promise<ComponentScore> {
  const exams = await client.programExam.findMany({
    where: { programId, status: 'READY', ...(semester ? { semester } : {}) },
    select: { id: true, title: true, semester: true, passScore: true },
    orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
  })
  if (!exams.length) {
    addMissing(missing, semester ? `امتحان برنامج الفصل ${semester}` : 'امتحانات البرنامج المطلوبة')
    return null
  }
  const earned: number[] = []
  let complete = true
  for (const exam of exams) {
    const attempts = await client.programExamAttempt.findMany({
      where: { userId, examId: exam.id, status: 'GRADED', OR: [{ appealStatus: null }, { appealStatus: { not: 'PENDING' } }] },
      select: { score: true, finalScore: true, feedback: true, appealStatus: true, answers: { select: { points: true, maxPoints: true } } },
    })
    const scores = attempts.map(rawProgramAttemptScore)
    earned.push(best(scores) ?? 0)
    if (!scores.some((value) => value !== null && value >= exam.passScore)) {
      addMissing(missing, `امتحان البرنامج: ${exam.title}`)
      complete = false
    }
  }
  const percent = avg(earned) ?? 0
  return complete ? percent : { score: percent, complete: false }
}

async function assignmentAverage(client: DbClient, userId: string, programId: string, missing: string[], requiredForGrade: boolean): Promise<ComponentScore> {
  const assignments = await client.programAssignment.findMany({
    where: { programId, status: 'PUBLISHED' },
    select: { id: true, title: true, points: true, weight: true },
    orderBy: { createdAt: 'asc' },
  })
  if (!assignments.length) {
    if (requiredForGrade) addMissing(missing, 'الواجبات المنشورة المصححة')
    return null
  }
  const declaredWeights = assignments.map((a) => Math.max(0, Number(a.weight || 0)))
  const shares = declaredWeights.some((v) => v > 0) ? declaredWeights : assignments.map(() => 1)
  const totalShares = shares.reduce((sum, v) => sum + v, 0)
  let percent = 0
  let complete = true
  for (let i = 0; i < assignments.length; i++) {
    const assignment = assignments[i]
    const submission = await client.assignmentSubmission.findUnique({
      where: { assignmentId_userId: { assignmentId: assignment.id, userId } },
      select: { status: true, score: true },
    })
    const graded = submission?.status === 'GRADED' && typeof submission.score === 'number'
    const score = graded
      ? clampPercent(assignment.points > 0 ? (submission!.score! / assignment.points) * 100 : submission!.score!)
      : 0
    percent += score * (shares[i] / totalShares)
    if (!graded || score < 60) {
      addMissing(missing, `واجب منشور غير مكتمل أو غير مجتاز: ${assignment.title}`)
      complete = false
    }
  }
  return complete ? percent : { score: percent, complete: false }
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
  const program = await client.program.findUnique({
    where: { id: input.programId },
    select: { category: true, admissionRules: true },
  })
  const category = program?.category || 'DIPLOMA'
  const enrollment = (client as any).enrollment?.findUnique
    ? await client.enrollment.findUnique({
        where: { userId_programId: { userId: input.userId, programId: input.programId } },
        select: { createdAt: true, status: true, finalScore: true },
      })
    : null
  const policy = resolveGradeWeights(category, program?.admissionRules)
  const profile = ((program?.admissionRules || {}) as any).academicProfile
  const policyEffectiveAt = Date.parse(String(profile?.approvedFormulaAt || ''))
  const newCohort = enrollment?.createdAt && Number.isFinite(policyEffectiveAt) &&
    new Date(enrollment.createdAt).getTime() >= policyEffectiveAt
  const configured = policy.source === 'academic_profile' && !newCohort
    ? { ...resolveGradeWeights(category, null), warning: 'ASSESSMENT_FORMULA_FUTURE_COHORT_ONLY' }
    : policy
  const weight = (key: string) => configured.weights[key] || 0
  const missing: string[] = []

  // The global academic gate remains strict even while the student's earned total is visible.
  await unitQuizAverage(client, input.userId, input.programId, missing)
  await programExamAverage(client, input.userId, input.programId, missing)
  const assignmentScores = await assignmentAverage(client, input.userId, input.programId, missing, false)
  const thesis = await thesisScores(client, input.userId, input.admissionId)

  let components: FinalGradeComponent[]
  if (category === 'DOCTORATE') {
    components = [
      component('reading_quizzes', 'اختبارات/تقارير القراءات المتقدمة', weight('reading_quizzes'), await unitQuizAverage(client, input.userId, input.programId, missing, 1)),
      component('reading_exam', 'اختبار مرحلة القراءات المتقدمة', weight('reading_exam'), await programExamAverage(client, input.userId, input.programId, missing, 1)),
      component('analysis_quizzes', 'اختبارات/حالات التطبيق والتحليل', weight('analysis_quizzes'), await unitQuizAverage(client, input.userId, input.programId, missing, 2)),
      component('analysis_exam', 'اختبار مرحلة التطبيق والتحليل', weight('analysis_exam'), await programExamAverage(client, input.userId, input.programId, missing, 2)),
      component('thesis', 'الأطروحة المهنية', weight('thesis'), thesis.research),
      component('defense', 'المناقشة النهائية', weight('defense'), thesis.defense),
    ]
  } else if (category === 'MASTERS') {
    components = [
      component('semester1_quizzes', 'اختبارات الفصل الأول القصيرة', weight('semester1_quizzes'), await unitQuizAverage(client, input.userId, input.programId, missing, 1)),
      component('semester1_exam', 'امتحان الفصل الأول', weight('semester1_exam'), await programExamAverage(client, input.userId, input.programId, missing, 1)),
      component('semester2_quizzes', 'اختبارات الفصل الثاني القصيرة', weight('semester2_quizzes'), await unitQuizAverage(client, input.userId, input.programId, missing, 2)),
      component('semester2_exam', 'امتحان الفصل الثاني', weight('semester2_exam'), await programExamAverage(client, input.userId, input.programId, missing, 2)),
      component('thesis', 'بحث التخرج المهني', weight('thesis'), thesis.research),
      component('defense', 'المناقشة النهائية', weight('defense'), thesis.defense),
    ]
  } else {
    components = [
      component('quizzes', 'اختبارات قصيرة ومتابعة', weight('quizzes'), await unitQuizAverage(client, input.userId, input.programId, missing)),
      component('assignments', 'واجبات أو أنشطة تطبيقية', weight('assignments'), assignmentScores ?? await assignmentAverage(client, input.userId, input.programId, missing, true)),
      component('final_exam', 'الاختبار النهائي', weight('final_exam'), await programExamAverage(client, input.userId, input.programId, missing)),
      ...(weight('thesis') > 0 ? [component('thesis', 'بحث تخرج', weight('thesis'), thesis.research)] : []),
    ]
  }

  for (const item of components) {
    if (!item.ready && !item.exempt) addMissing(missing, item.label)
  }
  const active = components.filter((item) => !item.exempt)
  const activeWeight = active.reduce((sum, item) => sum + item.weight, 0)
  if (activeWeight <= 0) {
    return {
      score: null, progressScore: 0, components, missing,
      weightSource: configured.source, weightWarning: configured.warning,
    }
  }
  // The denominator stays the FULL programme weight; unfinished work earns zero.
  // Redistribution occurs only for explicitly exempt components.
  for (const item of components) {
    item.weighted = item.exempt || item.score == null ? 0 : item.score * item.weight / activeWeight
  }
  const earned = components.reduce((sum, item) => sum + item.weighted, 0)
  const historicalScore = enrollment?.status === 'COMPLETED' && typeof enrollment.finalScore === 'number'
    ? enrollment.finalScore : null
  return {
    score: missing.length ? null : historicalScore ?? earned,
    progressScore: Math.round(earned * 100) / 100,
    components,
    missing,
    weightSource: configured.source,
    weightWarning: configured.warning,
  }
}
