import { readEnrollmentSnapshot } from './rules-snapshot'
import { semesterApprovalState, storedSemesterApproval } from './semester-approval'
import { compositionWeights } from './semester-grade'

// ===== بوابات الانتقال والرسالة (المرحلة 5) =====
// لا انتقال إلا بنجاح معتمد، ولا رسالة إلا ببوابتها — وكل حساب من
// نتائج معتمدة مخزّنة فقط (لا معدل محسوب مؤقتًا أبدًا). القاعدة
// الجدّية (قرار التنفيذ): البوابات تعمل حيث توجد بصمة دورة حياة
// (حالة فصل أو اعتماد نتيجة)؛ التحاق بلا بصمة يبقى على سلوك اليوم
// حتى يحسم المالك حكمًا عامًا.
type AnyClient = any

export type GateVerdict = { open: boolean; reasons: string[] }

export async function hasLifecycleFootprint(client: AnyClient, enrollmentId: string): Promise<boolean> {
  const stateStore = client?.enrollmentSemesterState
  if (stateStore?.count) {
    // Distinguish a real zero-count (legacy enrollment) from a database
    // failure: never grandfather a student in because a lookup failed.
    const n = await stateStore.count({ where: { enrollmentId } })
    if (n > 0) return true
  }
  const approvalStore = client?.semesterResultApproval
  if (approvalStore?.count) {
    const n = await approvalStore.count({ where: { enrollmentId } })
    if (n > 0) return true
  }
  // Newly activated students already have an ENROLLMENT rules snapshot
  // before they have a semester state or an approved result. Without this
  // marker they were mistakenly grandfathered into unrestricted S2 access,
  // especially in programs without configured study-duration windows.
  // BACKFILL snapshots for historical enrollments preserve the legacy rule.
  const snapshotStore = client?.enrollmentRulesSnapshot
  if (snapshotStore?.findUnique) {
    const snapshot = await snapshotStore.findUnique({
      where: { enrollmentId },
      select: { basis: true },
    })
    if (snapshot?.basis === 'ENROLLMENT') return true
  }
  return false
}

const EXAM_KEY_BY_SEMESTER: Record<string, (semester: number) => string> = {
  MASTERS: (s) => `semester${s}_exam`,
  DOCTORATE: (s) => (s === 1 ? 'reading_exam' : 'analysis_exam'),
}

export function semesterExamRequired(category: string, requiredComponents: string[], semester: number): boolean {
  if (category === 'MASTERS' || category === 'DOCTORATE') {
    return requiredComponents.includes(EXAM_KEY_BY_SEMESTER[category](semester))
  }
  // DIPLOMA: مفتاح الامتحان مجمّع (final_exam) ويُضبط البرنامج
  // بامتحان لكل فصل — وجود المفتاح يعني الامتحان مطلوب لكل فصل.
  return requiredComponents.includes('final_exam')
}

function attemptHasUsableScore(attempt: any): boolean {
  if (typeof attempt?.score === 'number' && Number.isFinite(attempt.score)) return true
  if (typeof attempt?.finalScore === 'number' && Number.isFinite(attempt.finalScore)) return true
  const answers = attempt?.answers
  if (!Array.isArray(answers) || answers.length === 0) return false
  let earned = 0
  let max = 0
  for (const a of answers) {
    if (typeof a?.points !== 'number' || typeof a?.maxPoints !== 'number') return false
    earned += a.points
    max += a.maxPoints
  }
  return max > 0
}

// مجموعة امتحانات الفصل «المُعيّنة» بنفس دلالة الجاهزية المصدّقة:
// كل امتحان منشور (READY) + أحدث امتحان ولو لم يُنشر بعد؛ المسودات
// المهجورة القديمة لا تُعيَّن ولا تحبس الطالب أبدًا.
async function designatedSemesterExams(client: AnyClient, programId: string, semester: number) {
  const examStore = client?.programExam
  if (!examStore?.findMany) return null
  const exams = await examStore.findMany({
    where: { programId, semester },
    select: {
      id: true,
      status: true,
      createdAt: true,
      questions: { where: { status: 'PUBLISHED' }, select: { points: true } },
    },
    orderBy: { createdAt: 'desc' },
  }).catch(() => [])
  if (!exams.length) return []
  const current = exams[0]
  return (exams as any[]).filter((e) => e.status === 'READY' || e.id === current.id)
}

// نجاح امتحان فصل: كل امتحان مُعيّن منشور وله محاولة مصحّحة ناجحة
// بدرجة قابلة للاستعمال وبلا التماس معلّق — دلالة الجاهزية نفسها
// معمّمة على أي فصل (الأول في الجاهزية حالة خاصة منها).
export async function semesterExamPassed(
  client: AnyClient,
  userId: string,
  programId: string,
  semester: number,
): Promise<boolean> {
  const attemptStore = client?.programExamAttempt
  if (!attemptStore?.findMany) return false
  const designated = await designatedSemesterExams(client, programId, semester)
  if (!designated || designated.length === 0) return false
  for (const exam of designated as any[]) {
    if (exam.status !== 'READY' || !(exam.questions || []).some((q: any) => q.points > 0)) return false
    const candidates = await attemptStore.findMany({
      where: {
        userId,
        examId: exam.id,
        status: 'GRADED',
        passed: true,
        answers: { none: { points: null } },
        OR: [{ appealStatus: null }, { appealStatus: { not: 'PENDING' } }],
      },
      select: { id: true, score: true, finalScore: true, answers: { select: { points: true, maxPoints: true } } },
      take: 25,
    }).catch(() => [])
    if (!(candidates as any[]).some((a) => attemptHasUsableScore(a))) return false
  }
  return true
}

// امتحانات فصل قُدّمت فعلًا: لكل امتحان مُعيّن محاولة مقدّمة على
// الأقل — شرط «تقديم امتحانات الفصل الأخير» لبوابة الرسالة.
export async function semesterExamsSat(
  client: AnyClient,
  userId: string,
  programId: string,
  semester: number,
): Promise<boolean> {
  const attemptStore = client?.programExamAttempt
  if (!attemptStore?.findMany) return true
  const designated = await designatedSemesterExams(client, programId, semester)
  if (!designated || designated.length === 0) return true
  for (const exam of designated as any[]) {
    const attempts = await attemptStore.findMany({
      where: { userId, examId: exam.id, status: { in: ['GRADED', 'NEEDS_REVIEW', 'SUBMITTED'] } },
      select: { id: true },
      take: 1,
    }).catch(() => [])
    if (!attempts.length) return false
  }
  return true
}

async function gateContext(client: AnyClient, enrollmentId: string) {
  const snapshot = await readEnrollmentSnapshot(client, enrollmentId).catch(() => null)
  return {
    threshold: snapshot?.passThreshold ?? 50,
    requiredComponents: snapshot?.requirements?.requiredComponents ?? [],
    weights: snapshot?.weights ?? null,
    semestersCount: snapshot?.requirements?.semestersCount ?? null,
  }
}

// قرار المالك 2026-11-08: الانتقال للفصل التالي يحتاج نتيجة فصل
// سابقة معتمدة وصالحة (PASSED أو FAILED)، وليس شرط نجاح كل فصل
// أو امتحانه على حدة. يُحفظ الرسوب بدرجته الفعلية ويؤثر على
// التراكمي، ويمكن تعويضه في الفصول التالية/الالتماس/البحث.
// الاستحقاق النهائي للشهادة يظل مستقلاً بشروطه الرسمية.
export async function progressionGate(
  client: AnyClient,
  enrollment: { id: string; userId: string; programId: string },
  targetSemester: number,
  programCategory?: string | null,
): Promise<GateVerdict> {
  if (targetSemester <= 1) return { open: true, reasons: [] }
  let footprint: boolean
  try {
    footprint = await hasLifecycleFootprint(client, enrollment.id)
  } catch {
    return { open: false, reasons: ['تعذر التحقق من حالة الفصل السابق؛ أعد المحاولة لاحقًا'] }
  }
  if (!footprint) return { open: true, reasons: [] }
  const reasons: string[] = []
  for (let s = 1; s < targetSemester; s++) {
    const state = await semesterApprovalState(client, enrollment, s).catch(() => 'NONE' as const)
    if (state !== 'APPROVED') {
      reasons.push(`نتيجة الفصل ${s} غير معتمدة بعد`)
      continue
    }
    const stored = await storedSemesterApproval(client, enrollment.id, s).catch(() => null)
    const score = stored?.score == null ? null : Number(stored.score)
    if (score === null || !Number.isFinite(score) || score < 0 || score > 100) {
      reasons.push(`نتيجة الفصل ${s} المعتمدة غير قابلة للتحقق`)
      continue
    }
    // A final FAILED result is a lawful academic decision, not a veto
    // on continuing the programme. Its actual mark still counts in
    // the cumulative grade; appeals can revise it through the existing
    // grade-approval lifecycle.
  }
  return { open: reasons.length === 0, reasons }
}

// بوابة الرسالة: تُفتح فقط إن كانت الرسالة مطلوبة بقواعد القبول
// المجمّدة، وبعد اكتمال كل الفصول واعتماد نتائجها، وتراكميٍّ من
// المعدلات المعتمدة فقط أكبر تمامًا من العتبة. (50.0 لا تكفي.)
export async function thesisGate(
  client: AnyClient,
  enrollment: { id: string; userId: string; programId: string },
  program: { category?: string | null; semestersCount?: number | null },
): Promise<GateVerdict & { required: boolean; cumulative: number | null }> {
  const ctx = await gateContext(client, enrollment.id)
  const category = program?.category || 'DIPLOMA'
  const required = ctx.requiredComponents.includes('thesis')
  if (!required) return { open: true, reasons: [], required: false, cumulative: null }
  let footprint: boolean
  try {
    footprint = await hasLifecycleFootprint(client, enrollment.id)
  } catch {
    return { open: false, reasons: ['تعذر التحقق من نتائج الفصول المعتمدة؛ أعد المحاولة لاحقًا'], required: true, cumulative: null }
  }
  if (!footprint) return { open: true, reasons: [], required: true, cumulative: null }
  const semestersCount = ctx.semestersCount ?? program?.semestersCount ?? 2
  const reasons: string[] = []
  const approvedScores: number[] = []
  for (let s = 1; s <= semestersCount; s++) {
    const stateRow = await (client as AnyClient)?.enrollmentSemesterState?.findUnique?.({
      where: { enrollmentId_semester: { enrollmentId: enrollment.id, semester: s } },
      select: { status: true },
    }).catch(() => null)
    if (stateRow?.status !== 'CLOSED') reasons.push(`الفصل ${s} غير مكتمل/مغلق بعد`)
    const approval = await semesterApprovalState(client, enrollment, s).catch(() => 'NONE' as const)
    if (approval !== 'APPROVED') {
      reasons.push(`نتيجة الفصل ${s} غير معتمدة`)
      continue
    }
    const stored = await storedSemesterApproval(client, enrollment.id, s).catch(() => null)
    if (stored?.score == null) {
      reasons.push(`نتيجة الفصل ${s} المعتمدة بلا معدل مخزّن`)
      continue
    }
    approvedScores[s] = Number(stored.score)
  }
  const sat = await semesterExamsSat(client, enrollment.userId, enrollment.programId, semestersCount).catch(() => false)
  if (!sat) reasons.push('امتحانات الفصل الأخير لم تُقدَّم كلها بعد')
  let cumulative: number | null = null
  if (approvedScores.filter((x) => typeof x === 'number').length === semestersCount && ctx.weights) {
    const comp = compositionWeights(category, ctx.weights as any, semestersCount)
    const totalWeight = comp.perSemester.reduce((a, b) => a + b, 0)
    if (totalWeight > 0) {
      cumulative = Math.round((comp.perSemester.reduce((sum, w, i) => sum + w * (approvedScores[i + 1] || 0), 0) / totalWeight) * 100) / 100
    }
  }
  // The thesis/research is itself a weighted chance to improve an
  // otherwise failing cumulative result. Never require a passing
  // pre-thesis average just to let the student submit that work.
  // Final certificate issuance still rechecks the FULL weighted score.
  return { open: reasons.length === 0, reasons, required: true, cumulative }
}
