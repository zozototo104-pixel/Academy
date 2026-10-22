import { buildStageRoutingOverrides, resolveEffectiveStageProfile, type StageRoutingOverrides } from '@/lib/ai-stage-profiles'
import type { PipelineProfileStamp, PipelineStageName } from '@/lib/ai-pipeline-log'

// D2.3: منفّذ المرحلة المشترك — يحسم بروفايل المرحلة مرة واحدة، ثم
// ينفّذ المحاولة تحت قيد صارم: بروفايل مرحلة → النداء يتلقى التوجيه
// (قائمة مسموحة فعلية)؛ فشل الكل → رجوع واحد للعام (النداء بدون
// توجيه) فقط إذا سمح البروفايل، مع وسم قرار الرجوع في حالة الاستخدام
// لحظة اتخاذه (نمط D2.1c) حتى يظهر في سجل الفشل أيضًا.
// القراءة والتحليل سبق توصيلهما محليًا بنفس الدلالات (D2.1/D2.2)؛
// هذا المنفّذ هو المسار الموحّد من التوليد فصاعدًا.

export interface StageRouting {
  preferredModels: { provider: string; model: string }[]
  preferredProviders: string[]
  policy: string | null
  allowGlobalFallback: boolean
}

export interface StageRunPlan {
  routing: StageRouting | null
  profileStamp?: PipelineProfileStamp
  isStage: boolean
  detail: Record<string, unknown>
}

export interface StageUsage {
  fallbackUsed: boolean
  fallbackReason?: string
}

export async function prepareStageRun(stage: PipelineStageName): Promise<StageRunPlan> {
  let overrides: StageRoutingOverrides | { kind: 'resolution-error' }
  try {
    overrides = buildStageRoutingOverrides(await resolveEffectiveStageProfile(stage))
  } catch {
    overrides = { kind: 'resolution-error' }
  }
  const detail: Record<string, unknown> = { profileKind: overrides.kind }
  if (overrides.kind === 'global') detail.fallbackReason = overrides.reason
  if (overrides.kind === 'invalid') { detail.profileInvalid = true; detail.invalidReason = overrides.reason }
  if (overrides.kind !== 'stage') return { routing: null, isStage: false, detail }
  // D2.4: لمرحلة التدقيق، قائمة المدقق داخل البروفايل هي المصدر الأول
  // للموديلات؛ إن غابت تُستخدم قائمة الموديلات العادية للمرحلة.
  let effectiveModels = overrides.preferredModels
  if (stage === 'REVIEW') {
    const verifierModels = overrides.snapshot.verifier?.preferred ?? []
    if (verifierModels.length) {
      effectiveModels = verifierModels.map((m) => ({ ...m }))
      detail.modelSource = 'verifier'
    } else {
      detail.modelSource = 'models'
    }
  }
  return {
    routing: {
      preferredModels: effectiveModels,
      preferredProviders: overrides.preferredProviders,
      policy: overrides.policy,
      allowGlobalFallback: overrides.allowGlobalFallback,
    },
    profileStamp: {
      profileId: overrides.profileId,
      profileVersion: String(overrides.version),
      policy: overrides.policy,
      allowedModels: effectiveModels.map((m) => `${m.provider}:${m.model}`),
    },
    isStage: true,
    detail,
  }
}

export async function runStageAttempt<T>(
  plan: StageRunPlan,
  usage: StageUsage,
  attempt: (routing: StageRouting | null) => Promise<T>,
): Promise<T> {
  if (!plan.routing) return attempt(null)
  try {
    return await attempt(plan.routing)
  } catch (error) {
    if (!plan.routing.allowGlobalFallback) throw error
    usage.fallbackUsed = true
    usage.fallbackReason = 'all-stage-models-failed'
    return attempt(null)
  }
}
