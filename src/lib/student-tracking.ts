import { db } from './db'
import { calculateFinalGrade, type FinalGradeResult } from './final-grade'
import { calculateSemesterAverages } from './semester-grade'
import { semesterApprovalState, storedSemesterApproval } from './semester-approval'
import { semesterExamPassed, semesterExamRequired } from './progression'
import { readEnrollmentSnapshot } from './rules-snapshot'

// ===== مصدر بيانات المتابعة المشترك (شاشة الإدارة + شاشة الطالب) =====
// قرار المالك 2026-11-07: متابعة الفصول تُفصل عن المعدل التراكمي للبرنامج.
// محرك الدرجات (final-grade) لا يُلمس: رقمه المجمّع يبقى «المحصّل من كامل
// البرنامج حتى الآن» بسياسته الحالية — بما فيه نتائج قديمة من فصول لاحقة.
// هذه الطبقة قراءة فقط، وتضيف فوق المحركين القائمين:
//  - متوسط اختبارات وحدات كل فصل على حدة (من محرك الفصول، مفلترًا بالفصل)؛
//  - المعدل الفصلي الشامل مع حالته: «معتمد» فقط إن وُجد قرار اعتماد مخزّن
//    ما زال مطابقًا (semesterApprovalState)، وإلا «مؤقت — غير معتمد» —
//    فلا يُعرض معدل مؤقت كنتيجة نجاح/رسوب رسمية أبدًا؛
//  - عدّادات منفصلة لكل فصل (مصحّحة من أصل الكل) بدل رقم مجمّع واحد؛
//  - نتائج فصل لاحق موجودة قبل الانتقال الرسمي إليه تُعلَّم «محفوظة»:
//    لا تدخل في تقدم الفصل الحالي، ولا تُحذف ولا تُصفَّر، وتظهر ضمن تقدم
//    فصلها تلقائيًا عند الاعتماد والانتقال.
// الانتقال الرسمي لفصل = كل فصل سابق معتمد بمعدل مخزّن يتجاوز العتبة
// (ونجاح امتحانه إن كان مطلوبًا بالمجمدة) — نفس شروط بوابة الانتقال في
// progression.ts، لكن بلا استثناء البصمة: العرض يصف الواقع الموثّق،
// والبوابات نفسها لا تتغير.

type DbClient = typeof db | any

export interface SemesterTracking {
  semester: number
  /** اختبارات وحدات الفصل القابلة للاحتساب (منشورة ولها أسئلة). */
  unitExamsTotal: number
  /** منها ما له نتيجة مصحّحة نهائية (ناجحة أو راسبة). */
  unitExamsGraded: number
  /** متوسط اختبارات وحدات هذا الفصل وحده (نسبة)؛ null إن لا نشاط قابلًا. */
  unitAverage: number | null
  unitExempt: boolean
  /** المعدل الفصلي الشامل المعروض: المخزّن المعتمد إن اعتُمد، وإلا المحسوب. */
  semesterAverage: number | null
  /** تجاوز العتبة بصرامة (>50)؛ null حين لا معدل. */
  semesterPassed: boolean | null
  /** APPROVED = قرار اعتماد مخزّن سارٍ؛ غيره يعرض «مؤقت — غير معتمد». */
  approval: 'APPROVED' | 'PROVISIONAL'
  approvedScore: number | null
  /** توجد نتائج مصحّحة في هذا الفصل ولم يحدث انتقال رسمي إليه بعد. */
  preserved: boolean
}

export interface StudentTracking {
  programme: {
    /** المحصّل من كامل البرنامج حتى الآن (محرك final-grade كما هو). */
    earnedScore: number
    /** الدرجة الرسمية النهائية؛ null حتى اكتمال كل المتطلبات. */
    score: number | null
    progressScore: number
    weightSource: string
  } | null
  semesters: SemesterTracking[]
}

function attemptHasResolvableScore(attempt: any): boolean {
  if (typeof attempt?.score === 'number' && Number.isFinite(attempt.score)) return true
  const answers = attempt?.answers
  if (!Array.isArray(answers) || answers.length === 0) return false
  let max = 0
  for (const a of answers) {
    if (typeof a?.points !== 'number' || typeof a?.maxPoints !== 'number') return false
    max += a.maxPoints
  }
  return max > 0
}

/** عدّادات اختبارات وحدات فصل واحد بنفس مجموعة unitQuizAverage القابلة
 * للاحتساب: اختبارات READY لوحدات الفصل ولها أسئلة؛ «مصحّح» = توجد
 * محاولة GRADED بدرجة قابلة للاستخراج (مخزّنة أو من النقاط). */
async function unitExamCounters(
  client: DbClient,
  userId: string,
  programId: string,
  semester: number,
): Promise<{ total: number; graded: number }> {
  const examStore = (client as any)?.exam
  if (!examStore?.findMany) return { total: 0, graded: 0 }
  const exams = await examStore.findMany({
    where: { status: 'READY', unit: { programId, semester } },
    select: { id: true, _count: { select: { questions: true } } },
  }).catch(() => [])
  const scorable = (exams as any[]).filter((e) => Number(e?._count?.questions || 0) > 0)
  let graded = 0
  for (const exam of scorable) {
    const attempts = await client.examAttempt.findMany({
      where: { userId, examId: exam.id, status: 'GRADED' },
      select: { score: true, answers: { select: { points: true, maxPoints: true } } },
    }).catch(() => [])
    if ((attempts as any[]).some((a) => attemptHasResolvableScore(a))) graded += 1
  }
  return { total: scorable.length, graded }
}

export async function getStudentSemesterTracking(
  client: DbClient,
  input: { userId: string; programId: string; admissionId?: string | null; finalGrade?: FinalGradeResult | null },
): Promise<StudentTracking> {
  const enrollment = (client as any)?.enrollment?.findUnique
    ? await client.enrollment.findUnique({
        where: { userId_programId: { userId: input.userId, programId: input.programId } },
        select: { id: true, userId: true, programId: true },
      }).catch(() => null)
    : null
  const program = await client.program.findUnique({
    where: { id: input.programId },
    select: { category: true },
  }).catch(() => null)
  const category = program?.category || 'DIPLOMA'

  const [averages, finalGrade] = await Promise.all([
    calculateSemesterAverages({ userId: input.userId, programId: input.programId, admissionId: input.admissionId ?? null, client }),
    input.finalGrade === undefined
      ? calculateFinalGrade({ userId: input.userId, programId: input.programId, admissionId: input.admissionId ?? null, client }).catch(() => null)
      : Promise.resolve(input.finalGrade),
  ])

  const snapshot = enrollment?.id
    ? await readEnrollmentSnapshot(client, enrollment.id).catch(() => null)
    : null
  const threshold = snapshot?.passThreshold ?? 50
  const requiredComponents: string[] = snapshot?.requirements?.requiredComponents ?? []

  // حالة اعتماد كل فصل + انتقال رسمي إليه (سلسلة الفصول السابقة كاملة).
  const approvalStates = new Map<number, 'APPROVED' | 'STALE' | 'NONE'>()
  const storedScores = new Map<number, number | null>()
  if (enrollment?.id) {
    for (const entry of averages.semesters) {
      const state = await semesterApprovalState(client, enrollment, entry.semester).catch(() => 'NONE' as const)
      approvalStates.set(entry.semester, state)
      const stored = await storedSemesterApproval(client, enrollment.id, entry.semester).catch(() => null)
      storedScores.set(entry.semester, stored?.score == null ? null : Number(stored.score))
    }
  }
  const progressedInto = async (target: number): Promise<boolean> => {
    if (target <= 1) return true
    if (!enrollment?.id) return false
    for (let s = 1; s < target; s++) {
      if (approvalStates.get(s) !== 'APPROVED') return false
      const score = storedScores.get(s)
      if (score == null || !(score > threshold)) return false
      if (semesterExamRequired(category, requiredComponents, s)) {
        const passed = await semesterExamPassed(client, input.userId, input.programId, s).catch(() => false)
        if (!passed) return false
      }
    }
    return true
  }

  const semesters: SemesterTracking[] = []
  for (const entry of averages.semesters) {
    const counters = await unitExamCounters(client, input.userId, input.programId, entry.semester)
    const quizzes = entry.components.find((c) => c.key === 'quizzes')
      || entry.components.find((c) => c.key.endsWith('_quizzes'))
    const state = approvalStates.get(entry.semester) ?? 'NONE'
    const approved = state === 'APPROVED'
    const approvedScore = approved ? storedScores.get(entry.semester) ?? null : null
    const progressed = await progressedInto(entry.semester)
    semesters.push({
      semester: entry.semester,
      unitExamsTotal: counters.total,
      unitExamsGraded: counters.graded,
      unitAverage: quizzes && !quizzes.exempt ? quizzes.score : null,
      unitExempt: quizzes?.exempt ?? false,
      semesterAverage: approved ? approvedScore : entry.average,
      semesterPassed: approved
        ? (approvedScore != null ? approvedScore > threshold : entry.passed)
        : entry.passed,
      approval: approved ? 'APPROVED' : 'PROVISIONAL',
      approvedScore,
      preserved: entry.semester >= 2 && counters.graded > 0 && !progressed,
    })
  }

  return {
    programme: finalGrade
      ? {
          earnedScore: finalGrade.earnedScore,
          score: finalGrade.score,
          progressScore: finalGrade.progressScore,
          weightSource: finalGrade.weightSource,
        }
      : null,
    semesters,
  }
}
