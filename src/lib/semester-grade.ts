import { db } from '@/lib/db'
import {
  unitQuizAverage,
  programExamAverage,
  assignmentAverage,
  thesisScores,
  type ComponentScore,
} from '@/lib/final-grade'
import {
  effectiveGradeWeights,
  ensureEnrollmentSnapshot,
  type EnrollmentSnapshot,
} from '@/lib/rules-snapshot'

/**
 * Phase 3 of the academic-lifecycle plan: per-semester averages as DECISION
 * values, derived from the SAME approved weight map the final-grade engine
 * trusts (Program.admissionRules academicProfile, signature-checked), never
 * from the programme name or from a parallel formula.
 *
 * Three averages stay distinct, per the owner's terminology:
 *   - a semester average: the semester's own components renormalized to 100
 *     within the semester;
 *   - the final programme average: recomposed as
 *     S1avg×W1 + S2avg×W2 + thesis×Wr (+ defense×Wd) with weights summing to
 *     100 taken from the same approved map;
 *   - passing a semester = its average STRICTLY greater than 50 (50.0
 *     fails) — the threshold is the code constant recorded by the Phase-3
 *     snapshot, and the strict comparison holds at every gate.
 *
 * For categories whose map keys are already per-semester (MASTERS,
 * DOCTORATE) the recomposition is algebraically identical to the flat
 * engine's earned score. For DIPLOMA (pooled keys) each semester is judged
 * on the programme's declared activity mix (its components carry the full
 * map weights inside the semester) and the two semesters split the
 * non-thesis weight equally; on the standard configured shape (units and
 * one exam per semester) the recomposition reproduces the flat engine's
 * number, which the semester-grade suite pins against the golden fixtures.
 *
 * This module is ADDITIVE: calculateFinalGrade is untouched, and nothing
 * here feeds a live decision yet — the Phase-4 lifecycle consumes these
 * values when it activates semester approval.
 */

export const SEMESTER_PASS_THRESHOLD = 50

export interface SemesterComponentValue {
  key: string
  label: string
  /** The weight this component carries in the approved map. */
  weight: number
  score: number | null
  complete: boolean
  exempt: boolean
}

export interface SemesterAverage {
  semester: number
  /** Out of 100, renormalized within the semester; null when the semester
   * has no scorable component at all. */
  average: number | null
  /** average STRICTLY greater than the threshold; null when average is. */
  passed: boolean | null
  /** Every component of the semester is complete (nothing missing). */
  complete: boolean
  components: SemesterComponentValue[]
  missing: string[]
}

export interface SemesterAveragesResult {
  semesters: SemesterAverage[]
  thesis: { research: number | null; defense: number | null }
  /** The recomposed programme final (out of 100) or null while any part
   * it needs is missing. */
  composedFinal: number | null
  weightSource: 'academic_profile' | 'category_default'
  weightWarning?: string
}

type DbClient = typeof db | any

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function normalize(value: ComponentScore): { score: number | null; complete: boolean; exempt: boolean } {
  if (value === 'EXEMPT') return { score: null, complete: true, exempt: true }
  if (typeof value === 'number') return { score: value, complete: true, exempt: false }
  if (value && typeof value === 'object') return { score: value.score, complete: value.complete, exempt: false }
  return { score: null, complete: false, exempt: false }
}

interface ComponentSpec {
  key: string
  label: string
  load: (client: DbClient, userId: string, programId: string, missing: string[]) => Promise<ComponentScore>
}

function componentSpecs(category: string, semester: number): ComponentSpec[] {
  if (category === 'MASTERS') {
    return semester === 1
      ? [
          { key: 'semester1_quizzes', label: 'اختبارات الفصل الأول القصيرة', load: (c, u, p, m) => unitQuizAverage(c, u, p, m, 1) },
          { key: 'semester1_exam', label: 'امتحان الفصل الأول', load: (c, u, p, m) => programExamAverage(c, u, p, m, 1) },
        ]
      : [
          { key: 'semester2_quizzes', label: 'اختبارات الفصل الثاني القصيرة', load: (c, u, p, m) => unitQuizAverage(c, u, p, m, 2) },
          { key: 'semester2_exam', label: 'امتحان الفصل الثاني', load: (c, u, p, m) => programExamAverage(c, u, p, m, 2) },
        ]
  }
  if (category === 'DOCTORATE') {
    return semester === 1
      ? [
          { key: 'reading_quizzes', label: 'اختبارات/تقارير القراءات المتقدمة', load: (c, u, p, m) => unitQuizAverage(c, u, p, m, 1) },
          { key: 'reading_exam', label: 'اختبار مرحلة القراءات المتقدمة', load: (c, u, p, m) => programExamAverage(c, u, p, m, 1) },
        ]
      : [
          { key: 'analysis_quizzes', label: 'اختبارات/حالات التطبيق والتحليل', load: (c, u, p, m) => unitQuizAverage(c, u, p, m, 2) },
          { key: 'analysis_exam', label: 'اختبار مرحلة التطبيق والتحليل', load: (c, u, p, m) => programExamAverage(c, u, p, m, 2) },
        ]
  }
  // DIPLOMA (and any other category): pooled keys, attributed per semester
  // through the semester-aware helper variants.
  return [
    { key: 'quizzes', label: 'اختبارات قصيرة ومتابعة', load: (c, u, p, m) => unitQuizAverage(c, u, p, m, semester) },
    { key: 'assignments', label: 'واجبات أو أنشطة تطبيقية', load: (c, u, p, m) => assignmentAverage(c, u, p, m, true, semester) },
    { key: 'final_exam', label: 'امتحان الفصل', load: (c, u, p, m) => programExamAverage(c, u, p, m, semester) },
  ]
}

/** The between-semester weights (and thesis/defense) for the recomposition,
 * taken from the same approved map. */
function compositionWeights(
  category: string,
  weights: Record<string, number>,
  semestersCount: number,
): { perSemester: number[]; thesis: number; defense: number } {
  const thesis = weights.thesis || 0
  const defense = weights.defense || 0
  if (category === 'MASTERS') {
    return {
      perSemester: [
        (weights.semester1_quizzes || 0) + (weights.semester1_exam || 0),
        (weights.semester2_quizzes || 0) + (weights.semester2_exam || 0),
      ],
      thesis,
      defense,
    }
  }
  if (category === 'DOCTORATE') {
    return {
      perSemester: [
        (weights.reading_quizzes || 0) + (weights.reading_exam || 0),
        (weights.analysis_quizzes || 0) + (weights.analysis_exam || 0),
      ],
      thesis,
      defense,
    }
  }
  if (semestersCount <= 1) return { perSemester: [100 - thesis - defense], thesis, defense }
  const each = (100 - thesis - defense) / semestersCount
  return { perSemester: Array.from({ length: semestersCount }, () => each), thesis, defense }
}

export async function calculateSemesterAverages(input: {
  userId: string
  programId: string
  admissionId?: string | null
  client?: DbClient
}): Promise<SemesterAveragesResult> {
  const client = input.client || db
  const program = await client.program.findUnique({
    where: { id: input.programId },
    select: { category: true, admissionRules: true, semestersCount: true },
  })
  const category = program?.category || 'DIPLOMA'
  const enrollment = (client as any).enrollment?.findUnique
    ? await client.enrollment.findUnique({
        where: { userId_programId: { userId: input.userId, programId: input.programId } },
        select: { id: true, createdAt: true, status: true, finalScore: true },
      })
    : null

  // Frozen rules first (owner's Phase-3 condition): when the enrollment
  // has a rules snapshot, ITS weights and threshold govern — never the
  // programme's current settings. Without one, the snapshot is captured
  // from the live resolution (backfill) and used from this call on; the
  // live resolution itself stays in lockstep with calculateFinalGrade via
  // the shared effectiveGradeWeights helper.
  let configured = effectiveGradeWeights(category, program?.admissionRules, enrollment?.createdAt)
  let snapshot: EnrollmentSnapshot | null = null
  if (enrollment?.id) {
    snapshot = await ensureEnrollmentSnapshot(client, {
      id: enrollment.id,
      userId: input.userId,
      programId: input.programId,
      createdAt: enrollment.createdAt,
    }).catch(() => null)
    if (snapshot) {
      configured = {
        weights: snapshot.weights,
        source: snapshot.weightSource,
        ...(snapshot.weightWarning ? { warning: snapshot.weightWarning } : {}),
      }
    }
  }
  const passThreshold = snapshot?.passThreshold ?? SEMESTER_PASS_THRESHOLD
  const weights = configured.weights
  const weightOf = (key: string) => weights[key] || 0

  const rawCount = Number((program as any)?.semestersCount)
  const semestersCount = Number.isInteger(rawCount) && rawCount >= 1 && rawCount <= 4 ? rawCount : 2

  const semesters: SemesterAverage[] = []
  for (let semester = 1; semester <= semestersCount; semester++) {
    const missing: string[] = []
    const components: SemesterComponentValue[] = []
    for (const spec of componentSpecs(category, semester)) {
      const value = normalize(await spec.load(client, input.userId, input.programId, missing))
      components.push({
        key: spec.key,
        label: spec.label,
        weight: weightOf(spec.key),
        score: value.score,
        complete: value.complete,
        exempt: value.exempt,
      })
    }
    const scorable = components.filter((c) => !c.exempt && c.score !== null && c.weight > 0)
    const weightSum = scorable.reduce((sum, c) => sum + c.weight, 0)
    const average =
      weightSum > 0
        ? round2(scorable.reduce((sum, c) => sum + (c.score as number) * c.weight, 0) / weightSum)
        : null
    semesters.push({
      semester,
      average,
      passed: average === null ? null : average > passThreshold,
      complete: components.every((c) => c.complete) && missing.length === 0,
      components,
      missing,
    })
  }

  const thesis = await thesisScores(client, input.userId, input.admissionId)

  const comp = compositionWeights(category, weights, semestersCount)
  let composedFinal: number | null = null
  const averagesReady = semesters.every((s) => s.average !== null)
  const thesisReady = comp.thesis <= 0 || thesis.research !== null
  const defenseReady = comp.defense <= 0 || thesis.defense !== null
  if (averagesReady && thesisReady && defenseReady) {
    let total = 0
    semesters.forEach((s, i) => {
      total += (s.average as number) * (comp.perSemester[i] || 0)
    })
    if (comp.thesis > 0) total += (thesis.research as number) * comp.thesis
    if (comp.defense > 0) total += (thesis.defense as number) * comp.defense
    composedFinal = round2(total / 100)
  }

  return {
    semesters,
    thesis,
    composedFinal,
    weightSource: configured.source,
    ...(configured.warning ? { weightWarning: configured.warning } : {}),
  }
}
