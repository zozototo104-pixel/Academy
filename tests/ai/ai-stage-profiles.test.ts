import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// عزل عن قاعدة البيانات: تُستورد الوحدة بعد تثبيت البدائل.
let customProviderRegistry = '[]'
mock.module('@/lib/db', () => ({
  db: { setting: { findUnique: async () => ({ value: customProviderRegistry }) } },
}))
mock.module('@/lib/text-ai', () => ({
  pipelineConfigSnapshot: async () => ({ policy: 'balanced', allowedModels: [], verifierPreferred: [] }),
  CUSTOM_AI_PROVIDERS_SETTING: 'AI_CUSTOM_PROVIDERS',
  parseCustomTextAiProviders: (value: string) => JSON.parse(value || '[]'),
}))

const {
  __setStageProfileStoreForTests,
  availableStageAiProviders,
  buildStageRoutingOverrides,
  validateStageProviderChoices,
  StageProfileValidationError,
  getCurrentStageProfile,
  listStageProfileVersions,
  resolveEffectiveStageProfile,
  saveStageProfile,
  validateStageProfileSnapshot,
} = await import('@/lib/ai-stage-profiles')

type Snapshot = ReturnType<typeof validateStageProfileSnapshot>

// مخزن ذاكرة يطابق دلالات مخزن Prisma: حفظ = نسخة جديدة + إزاحة المؤشر.
function memoryStore() {
  const profiles = new Map<string, { profileId: string; currentVersion: number; versions: Array<{ version: number; snapshot: Snapshot; createdBy: string | null; createdAt: Date }> }>()
  let seq = 0
  return {
    async loadCurrent(stage: string) {
      const p = profiles.get(stage)
      if (!p || p.currentVersion < 1) return null
      const row = p.versions.find((v) => v.version === p.currentVersion)
      return row ? { profileId: p.profileId, version: p.currentVersion, snapshot: row.snapshot } : null
    },
    async saveVersion(stage: string, snapshot: Snapshot, createdBy: string | null) {
      let p = profiles.get(stage)
      if (!p) { p = { profileId: `profile-${++seq}`, currentVersion: 0, versions: [] }; profiles.set(stage, p) }
      const version = p.currentVersion + 1
      p.versions.push({ version, snapshot, createdBy, createdAt: new Date() })
      p.currentVersion = version
      return { profileId: p.profileId, version }
    },
    async loadVersions(stage: string) {
      const p = profiles.get(stage)
      return p ? [...p.versions].sort((a, b) => b.version - a.version) : []
    },
  }
}

const GEN_V1 = { enabled: true, provider: 'GEMINI', policy: 'balanced', models: [{ provider: 'GEMINI', model: 'gemini-3.8-flash' }], allowGlobalFallback: true, verifier: null }

describe('D1 stage profiles: validation', () => {
  test('a valid snapshot normalizes with defaults', () => {
    const snap = validateStageProfileSnapshot('GENERATION', { models: [{ provider: 'GEMINI', model: 'm1' }] })
    expect(snap.enabled).toBe(true)
    expect(snap.allowGlobalFallback).toBe(true)
    expect(snap.provider).toBeNull()
    expect(snap.models).toEqual([{ provider: 'GEMINI', model: 'm1' }])
    expect(snap.verifier).toBeNull()
  })

  test('verifier settings are rejected outside the REVIEW stage', () => {
    expect(() => validateStageProfileSnapshot('GENERATION', { models: [], verifier: { preferred: [], strict: true } })).toThrow(StageProfileValidationError)
    const ok = validateStageProfileSnapshot('REVIEW', { models: [], verifier: { preferred: [{ provider: 'OPENAI', model: 'gpt-x' }], strict: true } })
    expect(ok.verifier?.preferred).toHaveLength(1)
    expect(ok.verifier?.strict).toBe(true)
  })

  test('model refs without provider or model are rejected', () => {
    expect(() => validateStageProfileSnapshot('READING', { models: [{ provider: '', model: 'm' }] })).toThrow(StageProfileValidationError)
    expect(() => validateStageProfileSnapshot('READING', { models: [{ provider: 'GEMINI' }] })).toThrow(StageProfileValidationError)
  })
})

describe('D1 stage profiles: versioned storage', () => {
  test('every save creates a new version and never rewrites history', async () => {
    __setStageProfileStoreForTests(memoryStore() as never)
    const first = await saveStageProfile('GENERATION', GEN_V1, 'admin-1')
    expect(first.version).toBe(1)
    const second = await saveStageProfile('GENERATION', { ...GEN_V1, models: [{ provider: 'OPENAI', model: 'gpt-x' }] }, 'admin-2')
    expect(second.version).toBe(2)
    const current = await getCurrentStageProfile('GENERATION')
    expect(current?.version).toBe(2)
    expect(current?.snapshot.models[0].model).toBe('gpt-x')
    const history = await listStageProfileVersions('GENERATION')
    expect(history.map((h) => h.version)).toEqual([2, 1])
    expect(history[1].snapshot.models[0].model).toBe('gemini-3.8-flash')
    expect(history[1].createdBy).toBe('admin-1')
    expect(history[0].createdBy).toBe('admin-2')
  })

  test('stages are independent namespaces', async () => {
    __setStageProfileStoreForTests(memoryStore() as never)
    await saveStageProfile('READING', GEN_V1)
    expect(await getCurrentStageProfile('ANALYSIS')).toBeNull()
    expect((await getCurrentStageProfile('READING'))?.version).toBe(1)
  })
})

describe('D1 stage profiles: effective resolution falls back to global', () => {
  test('missing profile → global (missing)', async () => {
    __setStageProfileStoreForTests(memoryStore() as never)
    expect(await resolveEffectiveStageProfile('ANALYSIS')).toEqual({ kind: 'global', reason: 'missing' })
  })

  test('disabled profile → global (disabled)', async () => {
    __setStageProfileStoreForTests(memoryStore() as never)
    await saveStageProfile('ANALYSIS', { ...GEN_V1, enabled: false })
    expect(await resolveEffectiveStageProfile('ANALYSIS')).toEqual({ kind: 'global', reason: 'disabled' })
  })

  test('enabled but empty model list → global (empty-models)', async () => {
    __setStageProfileStoreForTests(memoryStore() as never)
    await saveStageProfile('ANALYSIS', { ...GEN_V1, models: [] })
    expect(await resolveEffectiveStageProfile('ANALYSIS')).toEqual({ kind: 'global', reason: 'empty-models' })
  })

  test('enabled with models → the stage profile and its version', async () => {
    __setStageProfileStoreForTests(memoryStore() as never)
    await saveStageProfile('ANALYSIS', GEN_V1)
    const resolved = await resolveEffectiveStageProfile('ANALYSIS')
    expect(resolved.kind).toBe('stage')
    if (resolved.kind === 'stage') {
      expect(resolved.version).toBe(1)
      expect(resolved.snapshot.models).toHaveLength(1)
    }
  })

  test('REVIEW resolves from verifier preferences when models are empty', async () => {
    __setStageProfileStoreForTests(memoryStore() as never)
    await saveStageProfile('REVIEW', { enabled: true, models: [], verifier: { preferred: [{ provider: 'OPENAI', model: 'gpt-x' }], strict: true } })
    const resolved = await resolveEffectiveStageProfile('REVIEW')
    expect(resolved.kind).toBe('stage')
  })
})

describe('custom providers in optional stage profiles', () => {
  test('an enabled registered gateway is selectable independently for reading, analysis, generation and review', async () => {
    const id = 'CUSTOM_PROVIDER123'
    customProviderRegistry = JSON.stringify([{ id, name: 'Admin gateway', enabled: true, baseUrl: 'https://gateway.example.ai/v1', selectedModel: 'text-model:free' }])
    try {
      const choices = await availableStageAiProviders()
      expect(choices).toContain(id)
      expect(choices).toContain('GEMINI')
      for (const stage of ['READING', 'ANALYSIS', 'GENERATION', 'REVIEW'] as const) {
        __setStageProfileStoreForTests(memoryStore() as never)
        const snapshot = validateStageProfileSnapshot(stage, {
          enabled: true,
          provider: id,
          models: [{ provider: id, model: 'text-model:free' }],
          ...(stage === 'REVIEW' ? { verifier: { preferred: [{ provider: id, model: 'verifier-model:free' }], strict: true } } : {}),
        })
        expect(() => validateStageProviderChoices(snapshot, choices)).not.toThrow()
        await saveStageProfile(stage, snapshot)
        const routed = buildStageRoutingOverrides(await resolveEffectiveStageProfile(stage))
        expect(routed.kind).toBe('stage')
        if (routed.kind === 'stage') {
          expect(routed.preferredProviders).toEqual([id])
          expect(routed.preferredModels).toEqual([{ provider: id, model: 'text-model:free' }])
          expect(routed.snapshot.verifier?.preferred[0]?.provider ?? id).toBe(id)
        }
      }
    } finally {
      customProviderRegistry = '[]'
    }
  })

  test('disabled stage stays on global router; disabling or deleting a gateway prevents selection', async () => {
    const id = 'CUSTOM_PROVIDER123'
    customProviderRegistry = JSON.stringify([{ id, name: 'Admin gateway', enabled: true, baseUrl: 'https://gateway.example.ai/v1' }])
    try {
      __setStageProfileStoreForTests(memoryStore() as never)
      const selected = { ...GEN_V1, provider: id, models: [{ provider: id, model: 'm1' }] }
      await saveStageProfile('READING', { ...selected, enabled: false })
      expect(buildStageRoutingOverrides(await resolveEffectiveStageProfile('READING'))).toEqual({ kind: 'global', reason: 'disabled' })
      await saveStageProfile('READING', { ...selected, enabled: true })
      expect(buildStageRoutingOverrides(await resolveEffectiveStageProfile('READING')).kind).toBe('stage')
      customProviderRegistry = JSON.stringify([{ id, name: 'Admin gateway', enabled: false, baseUrl: 'https://gateway.example.ai/v1' }])
      expect(await availableStageAiProviders()).not.toContain(id)
      expect(() => validateStageProviderChoices(validateStageProfileSnapshot('READING', selected), ['GEMINI'])).toThrow(StageProfileValidationError)
      expect(buildStageRoutingOverrides(await resolveEffectiveStageProfile('READING')).kind).toBe('invalid')
      customProviderRegistry = '[]'
      expect(buildStageRoutingOverrides(await resolveEffectiveStageProfile('READING')).kind).toBe('invalid')
      // Built-in providers retain their existing routing behavior.
      await saveStageProfile('READING', GEN_V1)
      expect(buildStageRoutingOverrides(await resolveEffectiveStageProfile('READING')).kind).toBe('stage')
    } finally {
      customProviderRegistry = '[]'
    }
  })
})

describe('custom provider opt-in: existing global/stage settings stay unchanged', () => {
  const customId = 'CUSTOM_STAGEABC'
  const selectedModel = 'document-reader:free'
  const registered = [{ id: customId, name: 'My gateway', baseUrl: 'https://gateway.example.net/v1', enabled: true, selectedModel }]

  test('admin stage choices include enabled custom providers alongside all built-ins, not disabled ones', async () => {
    customProviderRegistry = JSON.stringify([...registered, { ...registered[0], id: 'CUSTOM_OFFLINE', enabled: false }])
    try {
      const providers: string[] = await availableStageAiProviders()
      expect(providers).toContain('GEMINI')
      expect(providers).toContain('OPENAI')
      expect(providers).toContain(customId)
      expect(providers).not.toContain('CUSTOM_OFFLINE')
      expect(providers.filter((id) => id === customId)).toHaveLength(1)
    } finally {
      customProviderRegistry = '[]'
    }
  })

  test('a custom model is accepted only in stages explicitly configured and enabled by the admin', async () => {
    __setStageProfileStoreForTests(memoryStore() as never)
    customProviderRegistry = JSON.stringify(registered)
    const snapshot = {
      enabled: true, provider: customId, policy: 'primary_first', models: [{ provider: customId, model: selectedModel }],
      allowGlobalFallback: false, verifier: null,
    }
    try {
      // Adding a provider alone does not enable any stage profile.
      expect(await resolveEffectiveStageProfile('READING')).toEqual({ kind: 'global', reason: 'missing' })
      validateStageProviderChoices(validateStageProfileSnapshot('READING', snapshot), await availableStageAiProviders())
      for (const stage of ['READING', 'ANALYSIS', 'GENERATION', 'REVIEW'] as const) {
        await saveStageProfile(stage, snapshot)
        const resolved = await resolveEffectiveStageProfile(stage)
        expect(resolved.kind).toBe('stage')
        const routing = buildStageRoutingOverrides(resolved)
        expect(routing.kind).toBe('stage')
        if (routing.kind === 'stage') {
          expect(routing.preferredProviders).toEqual([customId])
          expect(routing.preferredModels).toEqual([{ provider: customId, model: selectedModel }])
          expect(routing.allowGlobalFallback).toBe(false)
        }
      }
      // Turning off one stage restores global routing without touching the others.
      await saveStageProfile('READING', { ...snapshot, enabled: false })
      expect(await resolveEffectiveStageProfile('READING')).toEqual({ kind: 'global', reason: 'disabled' })
      expect(buildStageRoutingOverrides(await resolveEffectiveStageProfile('ANALYSIS')).kind).toBe('stage')
    } finally {
      customProviderRegistry = '[]'
    }
  })

  test('disabled/deleted provider cannot be selected or routed, without changing a saved profile version', async () => {
    __setStageProfileStoreForTests(memoryStore() as never)
    const snapshot = {
      enabled: true, provider: customId, policy: null, models: [{ provider: customId, model: selectedModel }],
      allowGlobalFallback: false, verifier: null,
    }
    customProviderRegistry = JSON.stringify(registered)
    try {
      const saved = await saveStageProfile('ANALYSIS', snapshot)
      expect(buildStageRoutingOverrides(await resolveEffectiveStageProfile('ANALYSIS')).kind).toBe('stage')
      customProviderRegistry = JSON.stringify([{ ...registered[0], enabled: false }])
      expect(() => validateStageProviderChoices(validateStageProfileSnapshot('ANALYSIS', snapshot), [ 'GEMINI', 'OPENAI' ])).toThrow(StageProfileValidationError)
      expect(buildStageRoutingOverrides(await resolveEffectiveStageProfile('ANALYSIS')).kind).toBe('invalid')
      customProviderRegistry = '[]'
      expect(buildStageRoutingOverrides(await resolveEffectiveStageProfile('ANALYSIS')).kind).toBe('invalid')
      const current = await getCurrentStageProfile('ANALYSIS')
      expect(current?.version).toBe(saved.version)
      expect(current?.snapshot).toEqual(snapshot)
    } finally {
      customProviderRegistry = '[]'
    }
  })
})

describe('D1 acceptance guard: storage cannot change model selection yet', () => {
  test('no routing or pipeline file imports the profile store', () => {
    // D2.1/D2.2 update: book-reader.ts (reading) and
    // book-chunk-analyzer.ts (analysis) are the sanctioned importers so
    // far. Every other selection path must stay clean until its own
    // D2 step wires it.
    for (const file of ['src/lib/text-ai.ts', 'src/lib/gemini.ts', 'src/lib/ai.ts', 'src/lib/question-verifier.ts', 'src/lib/books-ai.ts', 'src/lib/question-bank-job.ts', 'src/lib/ai-pipeline-log.ts']) {
      expect(readFileSync(file, 'utf8')).not.toContain('ai-stage-profiles')
    }
  })

  test('schema and migration carry the versioned profile tables', () => {
    const schema = readFileSync('prisma/schema.prisma', 'utf8')
    expect(schema).toContain('model AiStageProfile')
    expect(schema).toContain('model AiStageProfileVersion')
    expect(schema).toContain('@@unique([profileId, version])')
    const migration = readFileSync('prisma/migrations/20261022170000_ai_stage_profiles/migration.sql', 'utf8')
    expect(migration).toContain('CREATE TABLE "AiStageProfile"')
    expect(migration).toContain('CREATE TABLE "AiStageProfileVersion"')
    expect(migration).not.toContain('ALTER TABLE "AiPipelineOperationLog"')
  })
})
