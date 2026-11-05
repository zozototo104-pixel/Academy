import { db } from './db'
import { resolveGradeWeights, type GradeWeights } from './final-grade'

// لقطة قواعد الالتحاق (المرحلة 3): الشروط الأكاديمية الفعّالة وقت التحاق
// الطالب تُحفَظ قيمةً ثابتة، ومحركا الدرجات يقرآنها أولًا — فتغيّر أوزان
// البرنامج أو قواعده بعد الالتحاق لا يمسّ نتيجة الطالب التاريخية.
// المجمّد: خريطة الأوزان المحسومة للالتحاق + عتبة النجاح (قيمة الثابت 50
// مسجّلة، والصرامة > حصرًا) + المتطلبات المعلنة المشتقة. التشغيلي (حدود
// المحاولات والمواعيد والتصعيد) لا يدخل اللقطة ويبقى حيًّا كما قرّر المالك.
type DbClient = any

// انعكاس حرفي لمنطق calculateFinalGrade: الخريطة المعتمدة تسري فقط على
// الالتحاقات الواقعة عند اعتمادها أو بعده؛ الأقدم يأخذ الافتراضي + تحذير.
export function effectiveGradeWeights(
  category: string,
  admissionRules: unknown,
  enrolledAt: Date | string | null | undefined,
): { weights: GradeWeights; source: 'academic_profile' | 'category_default'; warning?: string } {
  const policy = resolveGradeWeights(category, admissionRules)
  const profile = ((admissionRules || {}) as any).academicProfile
  const policyEffectiveAt = Date.parse(String(profile?.approvedFormulaAt || ''))
  const newCohort = enrolledAt && Number.isFinite(policyEffectiveAt) &&
    new Date(enrolledAt).getTime() >= policyEffectiveAt
  if (policy.source === 'academic_profile' && !newCohort) {
    return { ...resolveGradeWeights(category, null), warning: 'ASSESSMENT_FORMULA_FUTURE_COHORT_ONLY' }
  }
  return policy
}

// المتطلبات المعلنة مشتقة من نفس قاعدة بوابات الأهلية: للماجستير
// والدكتوراه مجموعة ثابتة، وللدبلوم الامتحان النهائي + الرسالة إن كان
// لها وزن في الخريطة المحسومة لهذا الالتحاق.
export function declaredRequirements(
  category: string,
  weights: GradeWeights,
  semestersCount: number | null | undefined,
): { semestersCount: number | null; requiredComponents: string[] } {
  if (category === 'MASTERS') return { semestersCount: semestersCount ?? null, requiredComponents: ['semester1_exam', 'semester2_exam', 'thesis', 'defense'] }
  if (category === 'DOCTORATE') return { semestersCount: semestersCount ?? null, requiredComponents: ['reading_exam', 'analysis_exam', 'thesis', 'defense'] }
  return {
    semestersCount: semestersCount ?? null,
    requiredComponents: ['final_exam', ...((weights.thesis || 0) > 0 ? ['thesis'] : [])],
  }
}

export type EnrollmentSnapshot = {
  id: string
  enrollmentId: string
  weights: GradeWeights
  weightSource: 'academic_profile' | 'category_default'
  weightWarning?: string
  passThreshold: number
  thresholdStrict: boolean
  requirements: { semestersCount: number | null; requiredComponents: string[] }
  basis: string
  capturedAt: Date | string
}

function parseSnapshot(row: any): EnrollmentSnapshot | null {
  if (!row) return null
  try {
    const weights = JSON.parse(String(row.weightsJson || '{}'))
    if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return null
    const requirements = JSON.parse(String(row.requirementsJson || '{}'))
    return {
      id: row.id,
      enrollmentId: row.enrollmentId,
      weights,
      weightSource: row.weightSource === 'academic_profile' ? 'academic_profile' : 'category_default',
      ...(row.weightWarning ? { weightWarning: String(row.weightWarning) } : {}),
      passThreshold: Number(row.passThreshold ?? 50),
      thresholdStrict: row.thresholdStrict !== false,
      requirements: {
        semestersCount: requirements?.semestersCount ?? null,
        requiredComponents: Array.isArray(requirements?.requiredComponents) ? requirements.requiredComponents : [],
      },
      basis: String(row.basis || 'ENROLLMENT'),
      capturedAt: row.capturedAt,
    }
  } catch {
    return null
  }
}

export async function readEnrollmentSnapshot(client: DbClient, enrollmentId: string): Promise<EnrollmentSnapshot | null> {
  const store = (client as any)?.enrollmentRulesSnapshot
  if (!store?.findUnique) return null
  const row = await store.findUnique({ where: { enrollmentId } }).catch(() => null)
  return parseSnapshot(row)
}

// إنشاء اللقطة لالتحاق قائم. ثابتة بعد الإنشاء: إن وُجدت تُعاد كما هي
// دون أي كتابة (لا تحديث صامت أبدًا). قيمة العتبة تُسجَّل من الثابت
// البرمجي 50 كما قرّر المالك — الثابت يبقى هو القانون، واللقطة توثّقه.
export async function captureEnrollmentSnapshot(
  client: DbClient,
  enrollment: { id: string; userId: string; programId: string; createdAt: Date | string },
  basis: 'ENROLLMENT' | 'BACKFILL',
): Promise<EnrollmentSnapshot | null> {
  const store = (client as any)?.enrollmentRulesSnapshot
  if (!store?.findUnique || !store?.create) return null
  const existing = await readEnrollmentSnapshot(client, enrollment.id)
  if (existing) return existing
  const program = await client.program.findUnique({
    where: { id: enrollment.programId },
    select: { category: true, admissionRules: true, semestersCount: true },
  })
  const category = program?.category || 'DIPLOMA'
  const effective = effectiveGradeWeights(category, program?.admissionRules, enrollment.createdAt)
  const requirements = declaredRequirements(category, effective.weights, program?.semestersCount)
  try {
    const row = await store.create({
      data: {
        enrollmentId: enrollment.id,
        userId: enrollment.userId,
        programId: enrollment.programId,
        weightsJson: JSON.stringify(effective.weights),
        weightSource: effective.source,
        weightWarning: effective.warning ?? null,
        passThreshold: 50,
        thresholdStrict: true,
        requirementsJson: JSON.stringify(requirements),
        basis,
      },
    })
    return parseSnapshot(row)
  } catch {
    // سباق إنشاء متزامن: الفائز كتب لقطته — تُقرأ وتُعاد، لا تُستبدل.
    return readEnrollmentSnapshot(client, enrollment.id)
  }
}

export async function ensureEnrollmentSnapshot(
  client: DbClient,
  enrollment: { id: string; userId: string; programId: string; createdAt: Date | string },
): Promise<EnrollmentSnapshot | null> {
  const existing = await readEnrollmentSnapshot(client, enrollment.id)
  if (existing) return existing
  return captureEnrollmentSnapshot(client, enrollment, 'BACKFILL')
}
