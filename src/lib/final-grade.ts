import { db } from '@/lib/db'

export interface FinalGradeComponent {
  key: string
  label: string
  weight: number
  score: number | null
  weighted: number
  ready: boolean
}

export interface FinalGradeResult {
  score: number | null
  components: FinalGradeComponent[]
  missing: string[]
}

function round1(n: number) {
  return Math.round(n * 10) / 10
}

function avg(values: Array<number | null | undefined>) {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function component(key: string, label: string, weight: number, score: number | null): FinalGradeComponent {
  const ready = typeof score === 'number' && Number.isFinite(score)
  return {
    key,
    label,
    weight,
    score: ready ? round1(Math.max(0, Math.min(100, score))) : null,
    weighted: ready ? round1((Math.max(0, Math.min(100, score!)) * weight) / 100) : 0,
    ready,
  }
}

async function unitQuizAverage(userId: string, programId: string, semester?: number) {
  const rows = await db.examAttempt.findMany({
    where: {
      userId,
      score: { not: null },
      exam: { unit: { programId, ...(semester ? { semester } : {}) } },
    },
    select: { examId: true, score: true },
    orderBy: { score: 'desc' },
  })
  const best = new Map<string, number>()
  for (const row of rows) {
    if (!best.has(row.examId) && typeof row.score === 'number') best.set(row.examId, row.score)
  }
  return avg([...best.values()])
}

async function semesterExamScore(userId: string, programId: string, semester?: number) {
  const rows = await db.programExamAttempt.findMany({
    where: {
      userId,
      score: { not: null },
      exam: { programId, status: 'READY', ...(semester ? { semester } : {}) },
    },
    select: { score: true, finalScore: true, examId: true },
    orderBy: [{ finalScore: 'desc' }, { score: 'desc' }],
  })
  const best = new Map<string, number>()
  for (const row of rows) {
    const score = typeof row.finalScore === 'number' ? row.finalScore : row.score
    if (!best.has(row.examId) && typeof score === 'number') best.set(row.examId, score)
  }
  return avg([...best.values()])
}

async function assignmentAverage(userId: string, programId: string) {
  const rows = await db.assignmentSubmission.findMany({
    where: { userId, score: { not: null }, status: 'GRADED', assignment: { programId, status: 'PUBLISHED' } },
    select: { score: true, assignment: { select: { points: true } } },
  })
  return avg(rows.map((row) => {
    if (typeof row.score !== 'number') return null
    const points = Number(row.assignment.points || 0)
    return points > 0 ? (row.score / points) * 100 : row.score
  }))
}

async function thesisScores(userId: string, admissionId?: string | null) {
  const thesis = await db.thesisSubmission.findFirst({
    where: admissionId ? { admissionId } : { userId, resultScore: { not: null } },
    orderBy: { updatedAt: 'desc' },
    select: { resultScore: true, aiScore: true, passed: true },
  })
  if (!thesis) return { research: null as number | null, defense: null as number | null }
  const defense = typeof thesis.resultScore === 'number' ? thesis.resultScore : null
  const research = typeof thesis.aiScore === 'number' ? thesis.aiScore : defense
  return { research, defense }
}

export async function calculateFinalGrade(input: { userId: string; programId: string; admissionId?: string | null }): Promise<FinalGradeResult> {
  const program = await db.program.findUnique({ where: { id: input.programId }, select: { category: true } })
  const category = program?.category || 'DIPLOMA'
  const thesis = await thesisScores(input.userId, input.admissionId)

  let components: FinalGradeComponent[]
  if (category === 'DOCTORATE') {
    components = [
      component('reading_quizzes', 'اختبارات/تقارير القراءات المتقدمة', 8, await unitQuizAverage(input.userId, input.programId, 1)),
      component('reading_exam', 'اختبار مرحلة القراءات المتقدمة', 12, await semesterExamScore(input.userId, input.programId, 1)),
      component('analysis_quizzes', 'اختبارات/حالات التطبيق والتحليل', 8, await unitQuizAverage(input.userId, input.programId, 2)),
      component('analysis_exam', 'اختبار مرحلة التطبيق والتحليل', 12, await semesterExamScore(input.userId, input.programId, 2)),
      component('thesis', 'الأطروحة المهنية', 40, thesis.research),
      component('defense', 'المناقشة النهائية', 20, thesis.defense),
    ]
  } else if (category === 'MASTERS') {
    components = [
      component('semester1_quizzes', 'اختبارات الفصل الأول القصيرة', 10, await unitQuizAverage(input.userId, input.programId, 1)),
      component('semester1_exam', 'امتحان الفصل الأول', 15, await semesterExamScore(input.userId, input.programId, 1)),
      component('semester2_quizzes', 'اختبارات الفصل الثاني القصيرة', 10, await unitQuizAverage(input.userId, input.programId, 2)),
      component('semester2_exam', 'امتحان الفصل الثاني', 15, await semesterExamScore(input.userId, input.programId, 2)),
      component('thesis', 'بحث التخرج المهني', 30, thesis.research),
      component('defense', 'المناقشة النهائية', 20, thesis.defense),
    ]
  } else {
    components = [
      component('quizzes', 'اختبارات قصيرة ومتابعة', 20, await unitQuizAverage(input.userId, input.programId)),
      component('assignments', 'واجبات أو أنشطة تطبيقية', 20, await assignmentAverage(input.userId, input.programId)),
      component('final_exam', 'الاختبار النهائي', 60, await semesterExamScore(input.userId, input.programId)),
    ]
  }

  const missing = components.filter((c) => !c.ready).map((c) => c.label)
  if (missing.length) return { score: null, components, missing }
  return { score: round1(components.reduce((sum, c) => sum + c.weighted, 0)), components, missing }
}
