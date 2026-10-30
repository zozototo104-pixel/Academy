import { db } from '@/lib/db'
import type { PipelineStageName } from '@/lib/ai-pipeline-log'

// D1 — تخزين بروفايلات المراحل مع ترقيم نسخ لا يُكتب فوقه.
// قواعد ملزمة من تصميم المرحلة:
// - أي حفظ = نسخة جديدة كاملة (snapshot)؛ النسخ القديمة لا تُعدَّل أبدًا.
// - البروفايل الفعّال لمرحلة يُحسم هكذا: لا يوجد بروفايل → العام؛
//   موجود لكن معطّل → العام؛ موجود ومفعّل لكن قائمته فارغة → العام.
//   (لمرحلة التدقيق: القائمة = models أو مفضّلات المدقق.)
// - هذا الملف تخزين وحسم فقط: لا يستورده أي مسار اختيار موديلات بعد،
//   فلا يمكنه تغيير أي سلوك تشغيل — التوصيل يأتي في D2 مرحلةً مرحلة.

export interface StageProfileModelRef {
  provider: string
  model: string
}

export interface StageProfileSnapshot {
  enabled: boolean
  provider: string | null
  policy: string | null
  models: StageProfileModelRef[]
  allowGlobalFallback: boolean
  verifier: { preferred: StageProfileModelRef[]; strict: boolean } | null
}

export class StageProfileValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StageProfileValidationError'
  }
}

function modelRefs(value: unknown, field: string): StageProfileModelRef[] {
  if (value == null) return []
  if (!Array.isArray(value)) throw new StageProfileValidationError(`${field}: يجب أن تكون قائمة`)
  return value.map((item, index) => {
    const provider = typeof (item as { provider?: unknown })?.provider === 'string' ? (item as { provider: string }).provider.trim() : ''
    const model = typeof (item as { model?: unknown })?.model === 'string' ? (item as { model: string }).model.trim() : ''
    if (!provider || !model) throw new StageProfileValidationError(`${field}[${index}]: provider و model مطلوبان`)
    return { provider, model }
  })
}

function nullableString(value: unknown, field: string): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new StageProfileValidationError(`${field}: يجب أن يكون نصًا أو فارغًا`)
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

// تنقية وفحص أي Snapshot قبل حفظه. نقي وقابل للاختبار دون قاعدة بيانات.
export function validateStageProfileSnapshot(stage: PipelineStageName, raw: unknown): StageProfileSnapshot {
  if (!raw || typeof raw !== 'object') throw new StageProfileValidationError('snapshot: كائن مطلوب')
  const input = raw as Record<string, unknown>
  let verifier: StageProfileSnapshot['verifier'] = null
  if (input.verifier != null) {
    if (stage !== 'REVIEW') {
      throw new StageProfileValidationError('verifier: إعدادات المدقق خاصة بمرحلة التدقيق فقط')
    }
    const v = input.verifier as Record<string, unknown>
    verifier = { preferred: modelRefs(v.preferred, 'verifier.preferred'), strict: v.strict === true }
  }
  return {
    enabled: input.enabled !== false,
    provider: nullableString(input.provider, 'provider'),
    policy: nullableString(input.policy, 'policy'),
    models: modelRefs(input.models, 'models'),
    allowGlobalFallback: input.allowGlobalFallback !== false,
    verifier,
  }
}

// طول قائمة الموديلات الفعلية لمرحلة: للتدقيق قد تأتي من مفضّلات المدقق.
export function stageProfileModelCount(snapshot: StageProfileSnapshot): number {
  if (snapshot.models.length) return snapshot.models.length
  return snapshot.verifier?.preferred.length ?? 0
}

export type EffectiveStageProfile =
  | { kind: 'stage'; profileId: string; version: number; snapshot: StageProfileSnapshot }
  | { kind: 'global'; reason: 'missing' | 'disabled' | 'empty-models' }

// حسم البروفايل الفعّال لمرحلة: بروفايل المرحلة أو الرجوع للعام مع السبب.
export function resolveEffectiveFromSnapshot(
  current: { profileId: string; version: number; snapshot: StageProfileSnapshot } | null,
): EffectiveStageProfile {
  if (!current) return { kind: 'global', reason: 'missing' }
  if (!current.snapshot.enabled) return { kind: 'global', reason: 'disabled' }
  if (stageProfileModelCount(current.snapshot) === 0) return { kind: 'global', reason: 'empty-models' }
  return { kind: 'stage', profileId: current.profileId, version: current.version, snapshot: current.snapshot }
}

// قيم التوجيه المعروفة لدى الراوتر — أي قيمة خارجها تجعل البروفايل
// غير صالح للتوصيل (يُعامل كأنه غير موجود ويرجع التشغيل للعام).
export const KNOWN_ROUTER_POLICIES = ['primary_first', 'balanced', 'quality_first', 'cost_saver', 'fallback_only'] as const
export const KNOWN_AI_PROVIDERS = [
  'GEMINI', 'OPENAI', 'ANTHROPIC', 'ZAI', 'GROQ', 'OPENROUTER', 'DEEPINFRA',
  'TOGETHER', 'UNOROUTER', 'RELAYROUTER', 'TOPTOOLS', 'OPENAI_COMPAT', 'ALBORIHI',
  'MISTRAL', 'CLOUDFLARE', 'APINEX', 'OXION',
] as const

export type StageRoutingOverrides =
  | { kind: 'global'; reason: 'missing' | 'disabled' | 'empty-models' }
  | { kind: 'invalid'; reason: string }
  | {
      kind: 'stage'
      profileId: string
      version: number
      preferredModels: StageProfileModelRef[]
      preferredProviders: string[]
      policy: string | null
      allowGlobalFallback: boolean
      snapshot: StageProfileSnapshot
    }

// يحوّل حسم البروفايل الفعّال إلى تجاوزات توجيه جاهلة للنداء، مع تحقق
// صارم: سياسة مجهولة أو مزوّد مجهول في أي موضع = بروفايل غير صالح.
export function buildStageRoutingOverrides(resolution: EffectiveStageProfile): StageRoutingOverrides {
  if (resolution.kind === 'global') return { kind: 'global', reason: resolution.reason }
  const { snapshot } = resolution
  if (snapshot.policy != null && !(KNOWN_ROUTER_POLICIES as readonly string[]).includes(snapshot.policy)) {
    return { kind: 'invalid', reason: `unknown policy: ${snapshot.policy}` }
  }
  if (snapshot.provider != null && !(KNOWN_AI_PROVIDERS as readonly string[]).includes(snapshot.provider)) {
    return { kind: 'invalid', reason: `unknown provider: ${snapshot.provider}` }
  }
  for (const ref of snapshot.models) {
    if (!(KNOWN_AI_PROVIDERS as readonly string[]).includes(ref.provider)) {
      return { kind: 'invalid', reason: `unknown provider in models: ${ref.provider}` }
    }
  }
  if (snapshot.verifier) {
    for (const ref of snapshot.verifier.preferred) {
      if (!(KNOWN_AI_PROVIDERS as readonly string[]).includes(ref.provider)) {
        return { kind: 'invalid', reason: `unknown provider in verifier: ${ref.provider}` }
      }
    }
  }
  return {
    kind: 'stage',
    profileId: resolution.profileId,
    version: resolution.version,
    preferredModels: snapshot.models.map((m) => ({ ...m })),
    preferredProviders: snapshot.provider ? [snapshot.provider] : [],
    policy: snapshot.policy,
    allowGlobalFallback: snapshot.allowGlobalFallback,
    snapshot,
  }
}

interface StageProfileStore {
  loadCurrent(stage: PipelineStageName): Promise<{ profileId: string; version: number; snapshot: StageProfileSnapshot } | null>
  saveVersion(stage: PipelineStageName, snapshot: StageProfileSnapshot, createdBy: string | null): Promise<{ profileId: string; version: number }>
  loadVersions(stage: PipelineStageName): Promise<Array<{ version: number; snapshot: StageProfileSnapshot; createdBy: string | null; createdAt: Date }>>
}

const prismaStore: StageProfileStore = {
  async loadCurrent(stage) {
    const profile = await db.aiStageProfile.findUnique({ where: { stage: stage as never } })
    if (!profile || profile.currentVersion < 1) return null
    const row = await db.aiStageProfileVersion.findUnique({
      where: { profileId_version: { profileId: profile.id, version: profile.currentVersion } },
    })
    if (!row) return null
    return { profileId: profile.id, version: profile.currentVersion, snapshot: row.snapshot as unknown as StageProfileSnapshot }
  },
  async saveVersion(stage, snapshot, createdBy) {
    return db.$transaction(async (tx) => {
      const profile = await tx.aiStageProfile.upsert({
        where: { stage: stage as never },
        update: {},
        create: { stage: stage as never, currentVersion: 0 },
      })
      const version = profile.currentVersion + 1
      await tx.aiStageProfileVersion.create({ data: { profileId: profile.id, version, snapshot: snapshot as never, createdBy } })
      await tx.aiStageProfile.update({ where: { id: profile.id }, data: { currentVersion: version } })
      return { profileId: profile.id, version }
    })
  },
  async loadVersions(stage) {
    const profile = await db.aiStageProfile.findUnique({ where: { stage: stage as never } })
    if (!profile) return []
    const rows = await db.aiStageProfileVersion.findMany({ where: { profileId: profile.id }, orderBy: { version: 'desc' } })
    return rows.map((row) => ({
      version: row.version,
      snapshot: row.snapshot as unknown as StageProfileSnapshot,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    }))
  },
}

let store: StageProfileStore = prismaStore

export function __setStageProfileStoreForTests(next: StageProfileStore | null) {
  store = next ?? prismaStore
}

export async function getCurrentStageProfile(stage: PipelineStageName) {
  return store.loadCurrent(stage)
}

export async function resolveEffectiveStageProfile(stage: PipelineStageName): Promise<EffectiveStageProfile> {
  return resolveEffectiveFromSnapshot(await store.loadCurrent(stage))
}

// حفظ بروفايل مرحلة = إنشاء نسخة جديدة وإزاحة المؤشر إليها. لا يُلمس أي
// صف نسخة قديم. يرمي StageProfileValidationError عند بيانات غير صالحة.
export async function saveStageProfile(
  stage: PipelineStageName,
  rawSnapshot: unknown,
  createdBy?: string | null,
): Promise<{ profileId: string; version: number; snapshot: StageProfileSnapshot }> {
  const snapshot = validateStageProfileSnapshot(stage, rawSnapshot)
  const saved = await store.saveVersion(stage, snapshot, createdBy ?? null)
  return { ...saved, snapshot }
}

export async function listStageProfileVersions(stage: PipelineStageName) {
  return store.loadVersions(stage)
}
